import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Pool } from "pg";

const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`;
const ttlMs = Number(process.env.EXECUTION_LEASE_TTL_MS ?? 30_000);

export interface ExecutionLease { runId: string; attemptId: string; workerId: string; heartbeat: () => Promise<boolean>; release: () => Promise<void> }

export async function acquireExecutionLease(runId: string): Promise<ExecutionLease | undefined> {
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for execution leases");
    return { runId, attemptId: `${runId}:dev:${randomUUID()}`, workerId, heartbeat: async () => true, release: async () => undefined };
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const attemptId = `${runId}:attempt:${randomUUID()}`;
  const result = await pool.query(`
    INSERT INTO execution_leases (run_id, worker_id, attempt_id, lease_until, heartbeat_at)
    VALUES ($1,$2,$3,now() + ($4 * interval '1 millisecond'),now())
    ON CONFLICT (run_id) DO UPDATE SET worker_id=excluded.worker_id, attempt_id=excluded.attempt_id, lease_until=excluded.lease_until, heartbeat_at=excluded.heartbeat_at
    WHERE execution_leases.lease_until < now()
    RETURNING run_id
  `, [runId, workerId, attemptId, ttlMs]);
  if (!result.rowCount) { await pool.end(); return undefined; }
  return {
    runId, attemptId, workerId,
    heartbeat: async () => (await pool.query("UPDATE execution_leases SET lease_until=now() + ($4 * interval '1 millisecond'), heartbeat_at=now() WHERE run_id=$1 AND worker_id=$2 AND attempt_id=$3 RETURNING run_id", [runId, workerId, attemptId, ttlMs])).rowCount === 1,
    release: async () => { await pool.query("DELETE FROM execution_leases WHERE run_id=$1 AND worker_id=$2 AND attempt_id=$3", [runId, workerId, attemptId]); await pool.end(); }
  };
}
