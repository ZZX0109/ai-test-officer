import { Router, type Request } from "express";
import { z } from "zod";
import type { RunEventType } from "@ai-test-officer/contracts";
import {
  appendHumanOverrideConclusion
} from "../../proofGraph.js";
import {
  isIdempotentReplay,
  type RunEventStore
} from "../../runEventStore.js";
import {
  agentOrchestrationMode,
  resumeAgentGraph,
  resumeAgentGraphInBackground,
  startAgentGraphForRun
} from "../../agentGraphService.js";
import { pauseAfterCommittedRunEvent } from "../../faultInjection.js";
import { closeBrowserAgentSession } from "../../browser-agent/sessionManager.js";
import { enqueueRun, interruptRun } from "../../runOrchestrator.js";
import type { ProjectScope } from "../../types.js";

type AccessRequest = Request;

export interface RunControlRouterDependencies {
  runEventStore: RunEventStore;
  assertOrganizationAccess: (request: AccessRequest, organizationId: unknown) => void;
  assertProjectAccess: (request: AccessRequest, projectId: unknown, scope: ProjectScope) => Promise<void> | void;
}

const runControlSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  actor: z.string().trim().min(1),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.unknown()).optional()
});

const controlEvents: Record<string, RunEventType> = {
  "plan-approval": "plan_approved",
  permissions: "permission_granted",
  pause: "run_paused",
  resume: "run_resumed",
  cancel: "run_cancelled",
  "decision-override": "decision_overridden"
};

/**
 * Run-control endpoints are intentionally kept outside server.ts. They only
 * translate HTTP commands into durable events; the event store and Graph
 * services remain the owners of state transitions and resume semantics.
 */
export function runControlRouter(input: RunControlRouterDependencies) {
  const router = Router();

  for (const [action, eventType] of Object.entries(controlEvents)) {
    // eslint-disable-next-line complexity -- control commands deliberately enumerate durable state and resume gates.
    router.post(`/v1/runs/:id/${action}`, async (req, res, next) => {
      try {
        const body = runControlSchema.parse(req.body);
        let existing = await input.runEventStore.get(req.params.id);
        if (!existing) return void res.status(404).json({ error: "run_not_found" });
        input.assertOrganizationAccess(req, existing.input.organizationId);
        await input.assertProjectAccess(req, existing.input.projectId, "run_tests");
        const graphMode = agentOrchestrationMode(
          typeof existing.input.projectId === "string" ? existing.input.projectId : undefined
        );

        if (eventType === "plan_approved" && graphMode === "active" && existing.state === "planning") {
          await startAgentGraphForRun(existing);
          existing = await input.runEventStore.get(req.params.id);
          if (!existing) return void res.status(404).json({ error: "run_not_found" });
          if (existing.state !== "awaiting-plan-approval") {
            res.status(409).json({
              error: "plan_not_ready",
              message: "Agent Graph has not produced a reviewable test plan yet.",
              runState: existing.state
            });
            return;
          }
        }
        if (eventType === "plan_approved" && existing.state !== "awaiting-plan-approval") {
          res.status(409).json({
            error: "plan_not_ready",
            message: "A test plan must be generated before it can be approved.",
            runState: existing.state
          });
          return;
        }
        if (eventType === "decision_overridden") {
          z.object({
            status: z.enum(["approved", "blocked", "accepted-risk"]),
            reason: z.string().trim().min(1),
            originalDecision: z.string().optional(),
            newLabel: z.string().optional()
          }).parse(body.payload);
        }

        const operationalControl = graphMode === "active"
          && (eventType === "run_paused" || eventType === "run_resumed" || eventType === "run_cancelled");
        let run: Awaited<ReturnType<RunEventStore["get"]>>;
        for (let attempt = 0; attempt < (operationalControl ? 4 : 1); attempt += 1) {
          try {
            run = await input.runEventStore.append({
              runId: req.params.id,
              type: eventType,
              ...body,
              expectedVersion: (eventType === "plan_approved" && graphMode === "active") || operationalControl
                ? existing.version
                : body.expectedVersion,
              payload: body.payload ?? {}
            });
            break;
          } catch (error) {
            if (!operationalControl || !(error instanceof Error) || !error.message.startsWith("run_version_conflict:") || attempt === 3) throw error;
            const latest = await input.runEventStore.get(req.params.id);
            if (!latest) return void res.status(404).json({ error: "run_not_found" });
            if (eventType === "run_cancelled" && ["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(latest.state)) {
              return void res.json({ run: latest });
            }
            existing = latest;
          }
        }
        if (!run) throw new Error("run_control_retry_exhausted");
        const replayed = isIdempotentReplay(run);
        if (!replayed) await pauseAfterCommittedRunEvent({ run, eventType });
        if (!replayed && eventType === "run_cancelled") {
          await closeBrowserAgentSession(run.id).catch(() => undefined);
        }
        if (!replayed && eventType === "decision_overridden" && run.resultRunId) {
          await appendHumanOverrideConclusion({
            resultRunId: run.resultRunId,
            actor: body.actor,
            reason: String(body.payload?.reason ?? ""),
            status: String(body.payload?.status ?? "approved")
          });
        }
        if (!replayed && eventType === "plan_approved" && graphMode === "active") {
          await resumeAgentGraph(run.id, { approved: true, actor: body.actor });
        }
        if (!replayed && eventType === "permission_granted" && graphMode === "active"
          && run.planProvenance?.source !== "dynamic-browser-agent") {
          await resumeAgentGraphInBackground(run.id, { approved: true, actor: body.actor });
        }
        if (!replayed && (eventType === "permission_granted" || eventType === "run_resumed")) {
          await enqueueRun(run.id, run.version);
        }
        if (!replayed && (eventType === "run_paused" || eventType === "run_cancelled")) interruptRun(run.id);
        res.json({ run });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("run_version_conflict:")) {
          res.status(409).json({ error: "run_version_conflict", actualVersion: Number(error.message.split(":")[1]) });
          return;
        }
        next(error);
      }
    });
  }

  router.post("/v1/runs/:id/benchmark-timeout", async (req, res, next) => {
    try {
      const body = z.object({ timeoutMs: z.number().int().positive(), actor: z.string().trim().min(1).default("benchmark-runner") }).parse(req.body);
      const current = await input.runEventStore.get(req.params.id);
      if (!current) return void res.status(404).json({ error: "run_not_found" });
      input.assertOrganizationAccess(req, current.input.organizationId);
      await input.assertProjectAccess(req, current.input.projectId, "run_tests");
      if (["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(current.state)) {
        return void res.json({ run: current, replayed: true });
      }
      interruptRun(current.id);
      const run = await input.runEventStore.append({
        runId: current.id,
        type: "run_blocked",
        expectedVersion: current.version,
        actor: body.actor,
        idempotencyKey: `benchmark-timeout:${current.id}:${current.version}`,
        payload: { finalStatus: "blocked", error: "execution_timeout", timeoutMs: body.timeoutMs }
      });
      res.json({ run });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("run_version_conflict:")) {
        return void res.status(409).json({ error: "run_version_conflict", actualVersion: Number(error.message.split(":")[1]) });
      }
      next(error);
    }
  });

  return router;
}
