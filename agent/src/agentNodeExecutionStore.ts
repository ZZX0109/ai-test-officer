import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AgentGraphNode } from "@ai-test-officer/contracts";

const memory = new Map<string, Record<string, unknown>>();
let pool: Pool | undefined;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["updatedAt", "currentNode", "progress", "status"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inputHash(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export async function executeAgentNodeIdempotently(
  runId: string,
  node: AgentGraphNode,
  attempt: number,
  input: unknown,
  operation: () => Promise<Record<string, unknown>>
) {
  const hash = inputHash(input);
  const key = `${runId}:${node}:${attempt}:${hash}`;
  if (!process.env.DATABASE_URL) {
    const cached = memory.get(key);
    if (cached) return cached;
    const output = await operation();
    memory.set(key, output);
    return output;
  }
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let id = `node_${randomUUID()}`;
  const inserted = await pool.query(
    "INSERT INTO agent_node_executions_v1 (id,run_id,node,attempt,input_hash,status,started_at) VALUES ($1,$2,$3,$4,$5,'running',now()) ON CONFLICT (run_id,node,attempt,input_hash) DO NOTHING RETURNING id",
    [id, runId, node, attempt, hash]
  );
  if (!inserted.rowCount) {
    const existing = await pool.query(
      "SELECT id,status,output,started_at FROM agent_node_executions_v1 WHERE run_id=$1 AND node=$2 AND attempt=$3 AND input_hash=$4",
      [runId, node, attempt, hash]
    );
    if (existing.rows[0]?.status === "completed") return existing.rows[0].output as Record<string, unknown>;
    const staleAfterMs = Math.max(30_000, Number(process.env.AGENT_NODE_STALE_AFTER_MS ?? 120_000));
    const reclaimed = await pool.query<{ id: string }>(
      `UPDATE agent_node_executions_v1
       SET status='running',output='{}'::jsonb,started_at=now(),completed_at=NULL
       WHERE run_id=$1 AND node=$2 AND attempt=$3 AND input_hash=$4
         AND (status='failed' OR started_at < now() - ($5::int * interval '1 millisecond'))
       RETURNING id`,
      [runId, node, attempt, hash, staleAfterMs]
    );
    if (!reclaimed.rowCount) throw new Error(`agent_node_execution_in_progress:${node}`);
    id = reclaimed.rows[0]!.id;
  }
  try {
    const output = await operation();
    await pool.query(
      "UPDATE agent_node_executions_v1 SET status='completed',output=$2,completed_at=now() WHERE id=$1",
      [id, output]
    );
    return output;
  } catch (error) {
    await pool.query(
      "UPDATE agent_node_executions_v1 SET status='failed',output=$2,completed_at=now() WHERE id=$1",
      [id, { error: error instanceof Error ? error.message : "agent_node_failed" }]
    );
    throw error;
  }
}
