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
    for (const item of result.coverageItems ?? []) {
      await client.query(
        "INSERT INTO coverage_items_v1 (id,run_id,flow_id,disposition,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET disposition=EXCLUDED.disposition,payload=EXCLUDED.payload",
        [item.id, controlRunId, item.flowId, item.disposition, item]
      );
    }
    for (const conclusion of result.conclusions ?? []) {
      await client.query(
        "INSERT INTO conclusions_v1 (id,run_id,scenario_id,attempt_id,claim_type,proof_status,canonical_sha256,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
        [conclusion.conclusionId, controlRunId, conclusion.scenarioId, conclusion.attemptId, conclusion.claimType, conclusion.proofStatus, conclusion.canonicalSha256, conclusion]
      );
    }
    for (const node of result.proofNodes ?? []) {
      await client.query(
        `INSERT INTO proof_nodes_v1
         (id,run_id,scenario_id,attempt_id,node_type,canonical_sha256,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id,run_id,scenario_id,attempt_id) DO NOTHING`,
        [node.id, controlRunId, node.scenarioId, node.attemptId, node.nodeType, node.canonicalSha256, node]
      );
      if (node.nodeType === "assertion" || node.nodeType === "oracle") {
        const table = node.nodeType === "assertion" ? "assertions_v1" : "oracles_v1";
        await client.query(
          `INSERT INTO ${table}
           (id,run_id,scenario_id,attempt_id,canonical_sha256,payload)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id,run_id,scenario_id,attempt_id) DO NOTHING`,
          [node.id, controlRunId, node.scenarioId, node.attemptId, node.canonicalSha256, node.payload]
        );
      }
    }
    for (const edge of result.proofEdges ?? []) {
      await client.query(
        "INSERT INTO proof_edges_v1 (id,run_id,scenario_id,attempt_id,from_type,from_id,to_type,to_id,canonical_sha256,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING",
        [edge.id, controlRunId, edge.scenarioId, edge.attemptId, edge.fromType, edge.fromId, edge.toType, edge.toId, edge.canonicalSha256, edge]
      );
    }
    if (result.evidenceManifest) {
      await client.query(
        "INSERT INTO run_evidence_manifests_v1 (run_id,evidence_set_root,integrity_status,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (run_id) DO UPDATE SET evidence_set_root=EXCLUDED.evidence_set_root,integrity_status=EXCLUDED.integrity_status,payload=EXCLUDED.payload",
        [controlRunId, result.evidenceManifest.evidenceSetRoot, result.evidenceManifest.integrityStatus, result.evidenceManifest]
      );
    }
    await client.query("INSERT INTO judge_results_v1 (id,run_id,payload) VALUES ($1,$2,$3)", [`judge_${randomUUID()}`, controlRunId, result.judgeReport]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
