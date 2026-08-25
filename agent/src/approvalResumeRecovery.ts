import { getDatabasePool } from "./databaseRuntime.js";
import { readAgentGraphProjection } from "./agentGraphProjectionStore.js";
import { resumeAgentGraph } from "./agentGraphService.js";
import { runEventStore } from "./runEventStore.js";

const recoveryActor = "approval-resume-recovery";

/**
 * Find parent Runs for which the human decision is durable but the Graph
 * process died before consuming its `plan-approval` interrupt. Both
 * projections must be stale: a fresh HTTP approval must never be raced by a
 * background scanner.
 */
export async function listStalledApprovedPlanRunIds(input: { minimumAgeMs: number; limit?: number }) {
  if (!process.env.DATABASE_URL) return [] as string[];
  const pool = getDatabasePool();
  if (!pool) return [] as string[];
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_projection.run_id
     FROM run_projections AS run_projection
     JOIN agent_graph_projections_v1 AS graph ON graph.run_id = run_projection.run_id
     WHERE run_projection.state = 'awaiting-permission'
       AND run_projection.updated_at < now() - ($1 * interval '1 millisecond')
       AND graph.updated_at < now() - ($1 * interval '1 millisecond')
       AND graph.projection ->> 'status' = 'interrupted'
       AND graph.projection #>> '{pendingInterrupt,kind}' = 'plan-approval'
     ORDER BY run_projection.updated_at ASC
     LIMIT $2`,
    [Math.max(1_000, input.minimumAgeMs), Math.max(1, Math.min(input.limit ?? 25, 100))]
  );
  return result.rows.map((row) => row.run_id);
}

/**
 * Atomically lease a persisted checkpoint by touching its Graph projection.
 * If a recovering process is killed after this write, the next scan can claim
 * it after the same grace period. This prevents two API/Worker replicas from
 * calling LangGraph with the same interrupt concurrently.
 */
async function claimStalledApprovedPlanRun(runId: string, minimumAgeMs: number) {
  const pool = getDatabasePool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE agent_graph_projections_v1 AS graph
     SET updated_at = now()
     FROM run_projections AS run_projection
     WHERE graph.run_id = $1
       AND run_projection.run_id = graph.run_id
       AND run_projection.state = 'awaiting-permission'
       AND run_projection.updated_at < now() - ($2 * interval '1 millisecond')
       AND graph.updated_at < now() - ($2 * interval '1 millisecond')
       AND graph.projection ->> 'status' = 'interrupted'
       AND graph.projection #>> '{pendingInterrupt,kind}' = 'plan-approval'
     RETURNING graph.run_id`,
    [runId, Math.max(1_000, minimumAgeMs)]
  );
  return result.rowCount === 1;
}

/**
 * Consume the already-approved Graph interrupt without manufacturing another
 * user-decision Event. The next Graph boundary remains browser-permission, so
 * a capability grant is still explicitly required from the user.
 */
export async function recoverStalledApprovedPlanRun(runId: string, minimumAgeMs: number) {
  if (!(await claimStalledApprovedPlanRun(runId, minimumAgeMs))) return false;
  const [run, graph, events] = await Promise.all([
    runEventStore.get(runId),
    readAgentGraphProjection(runId),
    runEventStore.events(runId)
  ]);
  if (run?.state !== "awaiting-permission"
    || graph?.status !== "interrupted"
    || graph.pendingInterrupt?.kind !== "plan-approval"
    || !events.some((event) => event.type === "plan_approved")) return false;
  await resumeAgentGraph(runId, {
    approved: true,
    actor: recoveryActor,
    recoveryReason: "stalled_plan_approval_checkpoint"
  });
  return true;
}
