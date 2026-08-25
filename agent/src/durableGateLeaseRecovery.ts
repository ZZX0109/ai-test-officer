import { resolveFinalStatus, type GateStatus, type RunEventType } from "@ai-test-officer/contracts";
import { getDatabasePool } from "./databaseRuntime.js";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { removeExpiredExecutionLease } from "./executionLease.js";

export interface DurableGateLeaseRecoveryDecision {
  eventType: Extract<RunEventType, "run_completed" | "run_failed" | "run_blocked" | "human_review_requested">;
  payload: Record<string, unknown>;
}

/**
 * A Lease can expire after `run_judging` committed but before LangGraph has
 * checkpointed the node return and appended the terminal Run event. Replaying
 * execution here would be unsafe: the Gate already represents real external
 * work. Instead, make the pending deterministic conclusion durable exactly
 * once from the Event Store projection.
 */
export function durableGateLeaseRecoveryDecision(
  run: RunProjection,
  recoveryReason = "worker_lease_expired_after_gate_commit"
): DurableGateLeaseRecoveryDecision {
  const machineGate = run.machineGate;
  if (!machineGate) {
    return {
      eventType: "run_blocked",
      payload: {
        finalStatus: "blocked",
        error: "lease_expired_after_gate_checkpoint_without_machine_gate",
        recoveryReason
      }
    };
  }
  const finalStatus: GateStatus = resolveFinalStatus({
    machineGate,
    judgeRecommendation: run.judgeRecommendation
  });
  const eventType = finalStatus === "pass"
    ? "run_completed"
    : finalStatus === "fail"
      ? "run_failed"
      : finalStatus === "blocked"
        ? "run_blocked"
        : "human_review_requested";
  return {
    eventType,
    payload: {
      ...(run.resultRunId ? { resultRunId: run.resultRunId } : {}),
      machineGate,
      ...(run.judgeRecommendation ? { judgeRecommendation: run.judgeRecommendation } : {}),
      ...(run.outcomeSummary ? { outcomeSummary: run.outcomeSummary } : {}),
      ...(run.executionStatus ? { executionStatus: run.executionStatus } : {}),
      finalStatus,
      recoveryReason
    }
  };
}

/**
 * Graph continuation intentionally runs outside the short-lived Worker Job
 * lease after it has accepted an execution result. If that process dies after
 * `run_judging`, there is no expired lease row to discover. Scan the durable
 * Run projection instead, but only after a configurable grace period so a
 * normal selective Judge call is never pre-empted.
 */
export async function listStalledJudgingRunIds(input: { minimumAgeMs: number; limit?: number }) {
  if (!process.env.DATABASE_URL) return [] as string[];
  const pool = getDatabasePool();
  if (!pool) return [] as string[];
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM run_projections
     WHERE state = 'judging' AND updated_at < now() - ($1 * interval '1 millisecond')
     ORDER BY updated_at ASC LIMIT $2`,
    [Math.max(1_000, input.minimumAgeMs), Math.max(1, Math.min(input.limit ?? 25, 100))]
  );
  return result.rows.map((row) => row.run_id);
}

/** Finalize a stale Gate checkpoint without invoking a Worker or LangGraph. */
export async function recoverStalledJudgingRun(runId: string, recoveryReason: string) {
  const current = await runEventStore.get(runId);
  if (!current || current.state !== "judging") return undefined;
  const recovery = durableGateLeaseRecoveryDecision(current, recoveryReason);
  const terminal = await appendSystemRunEvent(runId, recovery.eventType, recovery.payload);
  // A direct Worker can still own an expired row; make cleanup conditional so
  // this recovery never removes a lease that another process has renewed.
  await removeExpiredExecutionLease(runId);
  return terminal;
}
