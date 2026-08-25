import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getDatabasePool } from "./databaseRuntime.js";

const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`;
const ttlMs = Number(process.env.EXECUTION_LEASE_TTL_MS ?? 30_000);

export interface ExecutionLease { runId: string; attemptId: string; workerId: string; heartbeat: () => Promise<boolean>; release: () => Promise<void> }

/**
 * Return only expired ownership records. The Run Event Store remains the
 * source of truth for whether a Run is still recoverable; callers must never
 * infer a retry merely from a Lease row.
 */
export async function listExpiredExecutionLeaseRunIds(limit = 25) {
  if (!process.env.DATABASE_URL) return [] as string[];
  const pool = getDatabasePool();
  if (!pool) return [] as string[];
  const result = await pool.query<{ run_id: string }>(
    "SELECT run_id FROM execution_leases WHERE lease_until < now() ORDER BY lease_until ASC LIMIT $1",
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map((row) => row.run_id);
}

/** Remove only ownership that is still expired; never steal a renewed lease. */
export async function removeExpiredExecutionLease(runId: string) {
  if (!process.env.DATABASE_URL) return false;
  const pool = getDatabasePool();
  if (!pool) return false;
  const result = await pool.query(
    "DELETE FROM execution_leases WHERE run_id=$1 AND lease_until < now()",
    [runId]
  );
  return result.rowCount === 1;
}

export async function acquireExecutionLease(runId: string): Promise<ExecutionLease | undefined> {
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for execution leases");
    return { runId, attemptId: `${runId}:dev:${randomUUID()}`, workerId, heartbeat: async () => true, release: async () => undefined };
  }
  const pool = getDatabasePool();
  if (!pool) throw new Error("DATABASE_URL is required for execution leases");
  const attemptId = `${runId}:attempt:${randomUUID()}`;
  const result = await pool.query(`
    INSERT INTO execution_leases (run_id, worker_id, attempt_id, lease_until, heartbeat_at)
    VALUES ($1,$2,$3,now() + ($4 * interval '1 millisecond'),now())
    ON CONFLICT (run_id) DO UPDATE SET worker_id=excluded.worker_id, attempt_id=excluded.attempt_id, lease_until=excluded.lease_until, heartbeat_at=excluded.heartbeat_at
    WHERE execution_leases.lease_until < now()
    RETURNING run_id
  `, [runId, workerId, attemptId, ttlMs]);
  if (!result.rowCount) return undefined;
  return {
    runId, attemptId, workerId,
    heartbeat: async () => (await pool.query("UPDATE execution_leases SET lease_until=now() + ($4 * interval '1 millisecond'), heartbeat_at=now() WHERE run_id=$1 AND worker_id=$2 AND attempt_id=$3 RETURNING run_id", [runId, workerId, attemptId, ttlMs])).rowCount === 1,
    release: async () => { await pool.query("DELETE FROM execution_leases WHERE run_id=$1 AND worker_id=$2 AND attempt_id=$3", [runId, workerId, attemptId]); }
  };
}
