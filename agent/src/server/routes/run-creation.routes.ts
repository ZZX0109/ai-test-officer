import { Router, type Request } from "express";
import { createRunRequestSchema } from "@ai-test-officer/contracts";
import {
  agentOrchestrationMode,
  getAgentGraphProjection,
  startAgentGraphInBackground
} from "../../agentGraphService.js";
import { planRunFromDurableInput } from "../../runPlanningService.js";
import { enqueueRun } from "../../runOrchestrator.js";
import type { RunEventStore } from "../../runEventStore.js";

type AccessRequest = Request;

const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);

/**
 * A confirmed run still needs the Graph to materialize its coverage map before
 * the Worker starts. Queuing immediately after `startAgentGraphInBackground`
 * creates a race where a parent run sees no child CoverageItems and gets stuck
 * in collecting. Wait for the durable execution-result checkpoint instead of
 * using a timing guess; the same versioned Run then remains the Worker source
 * of truth.
 */
function queueConfirmedRunAfterGraphReady(
  runId: string,
  enqueue: (runId: string, version: number) => Promise<void>,
  readRun: RunEventStore["get"]
) {
  const deadline = Date.now() + 20 * 60_000;
  const poll = async () => {
    try {
      const current = await readRun(runId);
      if (!current || terminalRunStates.has(current.state)) return;
      const graph = await getAgentGraphProjection(runId);
      if (graph?.pendingInterrupt?.kind === "execution-result") {
        await enqueue(runId, current.version);
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(() => void poll(), 25).unref();
      }
    } catch {
      if (Date.now() < deadline) setTimeout(() => void poll(), 100).unref();
    }
  };
  void poll();
}

export interface RunCreationRouterDependencies {
  runEventStore: RunEventStore;
  assertOrganizationAccess: (request: AccessRequest, organizationId: unknown) => void;
  assertProjectAccess: (request: AccessRequest, projectId: unknown, scope: "run_tests") => Promise<void> | void;
}

/**
 * Create is deliberately separate from run-control mutations. It owns only
 * request validation, authorization and the durable hand-off to Planning;
 * Graph nodes remain the owners of plan/execution state transitions.
 */
export function runCreationRouter(input: RunCreationRouterDependencies) {
  const router = Router();
  router.post("/v1/runs", async (req, res, next) => {
    try {
      const body = createRunRequestSchema.parse(req.body);
      input.assertOrganizationAccess(req, body.organizationId);
      await input.assertProjectAccess(req, body.projectId, "run_tests");
      const created = await input.runEventStore.create({
        runId: body.runId,
        actor: body.actor,
        idempotencyKey: body.idempotencyKey,
        payload: {
          ...body.input,
          projectId: body.projectId,
          organizationId: body.organizationId,
          runKind: body.runKind,
          parentRunId: body.parentRunId,
          coverageItemId: body.coverageItemId
        }
      });

      let run = created;
      if (agentOrchestrationMode(body.projectId) === "active") {
        if (body.input.confirmedExecution) {
          run = await planRunFromDurableInput(run.id);
          if (run.state === "awaiting-plan-approval") {
            run = await input.runEventStore.append({
              runId: run.id,
              type: "plan_approved",
              expectedVersion: run.version,
              actor: body.actor,
              idempotencyKey: `${body.idempotencyKey}:confirmed-plan`,
              payload: { source: "confirmed-execution" }
            });
          }
          if (run.state === "awaiting-permission") {
            run = await input.runEventStore.append({
              runId: run.id,
              type: "permission_granted",
              expectedVersion: run.version,
              actor: body.actor,
              idempotencyKey: `${body.idempotencyKey}:confirmed-permissions`,
              payload: { permissionProfile: body.input.permissionProfile, source: "confirmed-execution" }
            });
          }
        }
      } else {
        run = await planRunFromDurableInput(run.id);
      }
      startAgentGraphInBackground(run);
      // A confirmed run has already crossed both human gates above. Queue its
      // execution only after the Graph has reached its durable execution
      // checkpoint. Starting both asynchronously is otherwise a race: a parent
      // Worker can inspect an empty coverage map before Graph has materialized
      // its child paths and strand the Run in collecting.
      if (body.input.confirmedExecution && run.state === "queued") {
        queueConfirmedRunAfterGraphReady(run.id, enqueueRun, input.runEventStore.get.bind(input.runEventStore));
      }
      res.status(201).json({ run });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
