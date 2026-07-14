import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { VisualRunResult } from "./types.js";

let pool: Pool | undefined;
function database() { return process.env.DATABASE_URL ? pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) : undefined; }

export async function persistExecutionResult(controlRunId: string, result: VisualRunResult) {
  const db = database();
  if (!db) return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const attempt of result.attempts ?? []) {
      await client.query("INSERT INTO attempts_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [attempt.id, controlRunId, attempt]);
    }
    for (const artifact of result.artifactsV2 ?? []) {
      await client.query("INSERT INTO artifacts_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [artifact.id, controlRunId, artifact]);
    }
    for (const evidence of result.evidence) {
      await client.query("INSERT INTO evidence_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [evidence.id, controlRunId, evidence]);
    }
    await client.query("INSERT INTO judge_results_v1 (id,run_id,payload) VALUES ($1,$2,$3)", [`judge_${randomUUID()}`, controlRunId, result.judgeReport]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
