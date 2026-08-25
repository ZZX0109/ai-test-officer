import { Router, type Request } from "express";
import { createRunRequestSchema } from "@ai-test-officer/contracts";
import {
  agentOrchestrationMode,
  startAgentGraphInBackground
} from "../../agentGraphService.js";
import { planRunFromDurableInput } from "../../runPlanningService.js";
import type { RunEventStore } from "../../runEventStore.js";

type AccessRequest = Request;

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
      res.status(201).json({ run });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
