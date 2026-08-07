import { Router, type Request } from "express";
import type { RunEventType } from "@ai-test-officer/contracts";
import type { ProjectScope } from "../../types.js";
import { resolveRunRepairPlan, toRepairPlanPayload, updateRepairPlanStatus, type RepairPlanStatus } from "../../repairPlan.js";
import { appendSystemRunEvent, runEventStore } from "../../runEventStore.js";

type AuthorizeProject = (
  request: Request,
  projectId: unknown,
  scope: ProjectScope
) => Promise<void>;

/** Lifecycle transitions a client may request on a persisted repair plan. */
const ALLOWED_PLAN_STATUS: readonly string[] = ["applied", "resolved", "dismissed"];

interface RepairPlanPatch {
  status?: RepairPlanStatus;
  transition: string;
  note?: string;
}

/**
 * Parse + validate a repair-plan PATCH body.
 *
 * Returns `null` when an explicit status is present but is not a legal
 * transition, so the route answers 400 without inlining the allow-list.
 */
function parseRepairPlanPatch(raw: unknown): RepairPlanPatch | null {
  const body = (raw ?? {}) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status : undefined;
  if (status && !ALLOWED_PLAN_STATUS.includes(status)) return null;
  return {
    status: status as RepairPlanStatus | undefined,
    transition: typeof body.event === "string" ? body.event : "status_update",
    note: typeof body.note === "string" ? body.note : undefined
  };
}

/** Shared projection so PATCH and GET can never disagree on a plan's shape. */
function repairPlanResponse(
  plan: Awaited<ReturnType<typeof resolveRunRepairPlan>>,
  status: string
) {
  return { ...toRepairPlanPayload(plan), status, persisted: plan?.persisted ?? false };
}

/**
 * Repair-plan routes. Exposes the structured, owner-aware repair plan for a run
 * so the workbench UI can show concrete steps + validation instead of a raw
 * failure explanation.
 *
 * Mounted by server.ts via `app.use(repairRouter(assertProjectAccess))`.
 */
export function repairRouter(authorizeProject: AuthorizeProject) {
  const router = Router();

  router.get("/v1/runs/:id/repair-plan", async (req, res, next) => {
    try {
      const run = await runEventStore.get(req.params.id);
      if (!run) {
        res.status(404).json({ error: "run_not_found", repairPlan: null });
        return;
      }
      // A repair plan names the failing target and the operator action needed to
      // clear it, so it is read under the same project scope as the artifacts.
      await authorizeProject(req, run.input.projectId, "read_artifacts");
      const plan = await resolveRunRepairPlan(run.resultRunId ?? req.params.id);
      if (!plan) {
        res.status(404).json({ error: "no_repair_plan", repairPlan: null });
        return;
      }
      // Same projection the chat message carries, so a deep-linked panel and an
      // in-chat panel can never show a different owner/action for one failure.
      res.json({
        ...toRepairPlanPayload(plan),
        runId: plan.runId,
        idempotencyKey: plan.idempotencyKey,
        persisted: plan.persisted ?? false
      });
    } catch (error) {
      next(error);
    }
  });

  // Persist a repair-plan lifecycle transition (status change + audit event) so
  // an executed/resolved plan survives a workbench refresh instead of reverting
  // to "待处理". `status` is optional: a caller may record only a transition
  // event (e.g. an action failed) without moving the row.
  router.patch("/v1/runs/:id/repair-plan/:planId", async (req, res, next) => {
    try {
      const run = await runEventStore.get(req.params.id);
      if (!run) {
        res.status(404).json({ error: "run_not_found" });
        return;
      }
      await authorizeProject(req, run.input.projectId, "read_artifacts");
      const patch = parseRepairPlanPatch(req.body);
      if (!patch) {
        res.status(400).json({ error: "invalid_status", allowed: ALLOWED_PLAN_STATUS });
        return;
      }
      const updated = await updateRepairPlanStatus(req.params.id, req.params.planId, patch.status);
      if (!updated && patch.status) {
        res.status(404).json({ error: "repair_plan_not_found" });
        return;
      }
      // No dedicated "repair plan status changed" event exists; map to the
      // closest allowed lifecycle event so the audit trail stays queryable.
      const eventType: RunEventType = patch.status === "dismissed" ? "decision_overridden" : "plan_approved";
      await appendSystemRunEvent(req.params.id, eventType, {
        planId: req.params.planId,
        status: patch.status ?? "pending",
        transition: patch.transition,
        note: patch.note
      });
      const plan = await resolveRunRepairPlan(req.params.id);
      res.json(repairPlanResponse(plan, updated?.status ?? "pending"));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
