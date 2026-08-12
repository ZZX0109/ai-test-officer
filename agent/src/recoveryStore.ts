import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { recoveryActionResultSchema, recoveryDecisionSchema, agentObservationSchema, type AgentObservation, type RecoveryActionResult, type RecoveryDecision } from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const file = path.join(rootDir, "reports", "agent-recovery", "records.json");
let pool: Pool | undefined;
type RecoveryRecord = { decisions: RecoveryDecision[]; actions: RecoveryActionResult[]; observations: AgentObservation[] };

async function local(): Promise<RecoveryRecord> {
  try { return JSON.parse(await readFile(file, "utf8")) as RecoveryRecord; }
  catch { return { decisions: [], actions: [], observations: [] }; }
}

async function persistLocal(record: RecoveryRecord) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record, null, 2));
}

function database() {
  if (!process.env.DATABASE_URL) return undefined;
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  return pool;
}

export async function persistRecoveryDecision(input: RecoveryDecision) {
  const decision = recoveryDecisionSchema.parse(input);
  const db = database();
  if (db) {
    try {
      await db.query(`INSERT INTO agent_route_decisions_v1 (id,run_id,coverage_item_id,attempt_id,action,decision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [decision.id, decision.runId, decision.coverageItemId ?? null, decision.attemptId ?? null, decision.action, decision]);
      return decision;
    } catch { /* migrations are additive; local fallback keeps development usable */ }
  }
  const record = await local();
  if (!record.decisions.some((item) => item.id === decision.id)) record.decisions.push(decision);
  await persistLocal(record);
  return decision;
}

export async function persistRecoveryAction(input: RecoveryActionResult, decisionId: string) {
  const result = recoveryActionResultSchema.parse(input);
  const db = database();
  if (db) {
    try {
      await db.query(`INSERT INTO agent_recovery_actions_v1 (id,run_id,decision_id,action,status,evidence_refs,result,started_at,completed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`, [result.actionId, result.runId, decisionId, result.action, result.status, JSON.stringify(result.evidenceRefs), result, result.startedAt, result.completedAt ?? null]);
      return result;
    } catch { /* see persistRecoveryDecision */ }
  }
  const record = await local();
  if (!record.actions.some((item) => item.actionId === result.actionId)) record.actions.push(result);
  await persistLocal(record);
  return result;
}

export async function persistAgentObservation(input: AgentObservation) {
  const observation = agentObservationSchema.parse(input);
  const db = database();
  if (db) {
    try {
      await db.query(`INSERT INTO agent_observations_v1 (id,run_id,attempt_id,stage,status,observation) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`, [observation.id, observation.runId, observation.attemptId ?? null, observation.stage, observation.status, observation]);
      return observation;
    } catch { /* see persistRecoveryDecision */ }
  }
  const record = await local();
  if (!record.observations.some((item) => item.id === observation.id)) record.observations.push(observation);
  await persistLocal(record);
  return observation;
}

export async function recoveryId() { return `recovery_${randomUUID()}`; }

export async function listRecoveryRecords(runId: string) {
  const db = database();
  if (db) {
    try {
      const [decisions, actions, observations] = await Promise.all([
        db.query("SELECT decision FROM agent_route_decisions_v1 WHERE run_id=$1 ORDER BY created_at", [runId]),
        db.query("SELECT result FROM agent_recovery_actions_v1 WHERE run_id=$1 ORDER BY started_at", [runId]),
        db.query("SELECT observation FROM agent_observations_v1 WHERE run_id=$1 ORDER BY created_at", [runId])
      ]);
      return { decisions: decisions.rows.map((row) => recoveryDecisionSchema.parse(row.decision)), actions: actions.rows.map((row) => recoveryActionResultSchema.parse(row.result)), observations: observations.rows.map((row) => agentObservationSchema.parse(row.observation)) };
    } catch { /* local fallback */ }
  }
  const record = await local();
  return { decisions: record.decisions.filter((item) => item.runId === runId), actions: record.actions.filter((item) => item.runId === runId), observations: record.observations.filter((item) => item.runId === runId) };
}
