import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { runEventSchema, transitionRunState, type CompiledPlan, type GateStatus, type HumanDecision, type JudgeRecommendation, type LlmCall, type MachineGate, type PlanProvenance, type RunEvent, type RunEventType, type RunState } from "@ai-test-officer/contracts";
import type { GrayPlan, ImpactAnalysis } from "./types.js";

export interface RunProjection {
  id: string;
  state: RunState;
  version: number;
  createdAt: string;
  updatedAt: string;
  input: Record<string, unknown>;
  gateStatus?: GateStatus;
  machineGate?: MachineGate;
  judgeRecommendation?: JudgeRecommendation;
  humanDecision?: HumanDecision;
  resultRunId?: string;
  plan?: GrayPlan;
  compiledPlan?: CompiledPlan;
  planProvenance?: PlanProvenance;
  plannerCall?: LlmCall;
  plannerCalls?: LlmCall[];
  selectedScenarioId?: string;
  impactAnalysis?: ImpactAnalysis;
  plannerRouting?: { route: "deterministic" | "llm"; reason: string; signals: string[] };
  override?: { originalDecision: string; newLabel: string; reason: string; actor: string; createdAt: string };
}

export interface AppendRunEventInput {
  runId: string;
  type: RunEventType;
  expectedVersion: number;
  actor: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
}

export interface RunEventStore {
  create(input: { runId?: string; actor: string; idempotencyKey: string; payload?: Record<string, unknown> }): Promise<RunProjection>;
  append(input: AppendRunEventInput): Promise<RunProjection>;
  get(runId: string): Promise<RunProjection | undefined>;
  events(runId: string): Promise<RunEvent[]>;
}

function applyEvent(current: RunProjection, event: RunEvent): RunProjection {
  const state = transitionRunState(current.state, event.type);
  const projection: RunProjection = { ...current, state, version: event.version, updatedAt: event.createdAt };
  if (event.payload.machineGate) projection.machineGate = event.payload.machineGate as MachineGate;
  if (event.payload.judgeRecommendation) projection.judgeRecommendation = event.payload.judgeRecommendation as JudgeRecommendation;
  if (event.payload.resultRunId) projection.resultRunId = String(event.payload.resultRunId);
  // Planning can terminate before plan_generated. Preserve rejection provenance
  // and its provider call on review/terminal events for audit and benchmarks.
  if (event.payload.provenance) projection.planProvenance = event.payload.provenance as PlanProvenance;
  if (event.payload.llmCall) projection.plannerCall = event.payload.llmCall as LlmCall;
  if (event.payload.llmCalls) projection.plannerCalls = event.payload.llmCalls as LlmCall[];
  if (event.payload.impactAnalysis) projection.impactAnalysis = event.payload.impactAnalysis as ImpactAnalysis;
  if (event.payload.plannerRouting) projection.plannerRouting = event.payload.plannerRouting as RunProjection["plannerRouting"];
  if (event.type === "plan_generated") {
    if (event.payload.plan) projection.plan = event.payload.plan as GrayPlan;
    if (event.payload.compiledPlan) projection.compiledPlan = event.payload.compiledPlan as CompiledPlan;
    if (event.payload.scenarioId) projection.selectedScenarioId = String(event.payload.scenarioId);
  }
  if (event.type === "run_completed") projection.gateStatus = (event.payload.finalStatus as GateStatus | undefined) ?? "pass";
  if (event.type === "run_failed") projection.gateStatus = "fail";
  if (event.type === "run_blocked") projection.gateStatus = "blocked";
  if (event.type === "human_review_requested") projection.gateStatus = "needs-human-review";
  if (event.type === "decision_overridden") {
    projection.humanDecision = {
      status: String(event.payload.status ?? "approved") as HumanDecision["status"],
      actor: event.actor,
      reason: String(event.payload.reason ?? ""),
      decidedAt: event.createdAt
    };
    projection.override = {
      originalDecision: String(event.payload.originalDecision ?? projection.gateStatus ?? "unknown"),
      newLabel: String(event.payload.newLabel ?? "unknown"),
      reason: String(event.payload.reason ?? ""),
      actor: event.actor,
      createdAt: event.createdAt
    };
    if (projection.machineGate?.status === "pass") {
      projection.gateStatus = projection.humanDecision.status === "blocked" ? "fail" : "pass";
    }
  }
  return projection;
}

/**
 * Rebuild a run's materialized view exclusively from its append-only log.
 * `projection_json` is deliberately not an input: it is a disposable cache and
 * may have been written by an older reducer which did not know newer fields.
 */
export function replayRunEvents(events: readonly RunEvent[]): RunProjection | undefined {
  if (events.length === 0) return undefined;
  const [first] = events;
  if (first.type !== "run_created" || first.version !== 1) {
    throw new Error(`run_event_log_invalid:${first.runId}:missing_run_created`);
  }

  let projection: RunProjection = {
    id: first.runId,
    state: "draft",
    version: 0,
    createdAt: first.createdAt,
    updatedAt: first.createdAt,
    input: { ...first.payload }
  };
  for (const event of events) {
    if (event.runId !== first.runId) throw new Error(`run_event_log_invalid:${first.runId}:mixed_run_ids`);
    if (event.version !== projection.version + 1) {
      throw new Error(`run_event_log_invalid:${first.runId}:expected_version_${projection.version + 1}`);
    }
    projection = applyEvent(projection, event);
  }
  return projection;
}

function makeEvent(input: { runId: string; type: RunEventType; version: number; actor: string; idempotencyKey: string; payload?: Record<string, unknown> }) {
  return runEventSchema.parse({
    schemaVersion: "1.0",
    id: `event_${randomUUID()}`,
    runId: input.runId,
    type: input.type,
    version: input.version,
    createdAt: new Date().toISOString(),
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload ?? {}
  });
}

export class SqliteRunEventStore implements RunEventStore {
  private readonly database: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS run_projections (
        run_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, projection_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_control_events (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
        UNIQUE(run_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_run_control_events_run ON run_control_events(run_id, version);
    `);
  }

  async create(input: { runId?: string; actor: string; idempotencyKey: string; payload?: Record<string, unknown> }) {
    const existing = input.runId ? await this.get(input.runId) : undefined;
    if (existing) return existing;
    const duplicate = this.database.prepare("SELECT run_id FROM run_control_events WHERE idempotency_key = ?").get(input.idempotencyKey) as { run_id?: string } | undefined;
    if (duplicate?.run_id) return (await this.get(duplicate.run_id))!;
    const runId = input.runId ?? `run_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const initial: RunProjection = { id: runId, state: "draft", version: 0, createdAt, updatedAt: createdAt, input: input.payload ?? {} };
    const event = makeEvent({ runId, type: "run_created", version: 1, actor: input.actor, idempotencyKey: input.idempotencyKey, payload: input.payload });
    const projection = applyEvent(initial, event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertEvent(event);
      this.upsertProjection(projection);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return projection;
  }

  async append(input: AppendRunEventInput) {
    const duplicate = this.database.prepare("SELECT run_id FROM run_control_events WHERE idempotency_key = ?").get(input.idempotencyKey) as { run_id?: string } | undefined;
    if (duplicate?.run_id) return (await this.get(duplicate.run_id))!;
    const current = await this.get(input.runId);
    if (!current) throw new Error("run_not_found");
    if (current.version !== input.expectedVersion) throw new Error(`run_version_conflict:${current.version}`);
    const event = makeEvent({ ...input, version: current.version + 1 });
    const projection = applyEvent(current, event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.insertEvent(event);
      this.upsertProjection(projection);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return projection;
  }

  private insertEvent(event: RunEvent) {
    this.database.prepare(`INSERT INTO run_control_events (event_id, run_id, event_type, version, created_at, actor, idempotency_key, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.runId, event.type, event.version, event.createdAt, event.actor, event.idempotencyKey, JSON.stringify(event));
  }

  private upsertProjection(projection: RunProjection) {
    this.database.prepare(`INSERT INTO run_projections (run_id, state, version, created_at, updated_at, projection_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state, version=excluded.version, updated_at=excluded.updated_at, projection_json=excluded.projection_json`)
      .run(projection.id, projection.state, projection.version, projection.createdAt, projection.updatedAt, JSON.stringify(projection));
  }

  async get(runId: string) {
    return replayRunEvents(await this.events(runId));
  }

  async events(runId: string) {
    const rows = this.database.prepare("SELECT event_json FROM run_control_events WHERE run_id = ? ORDER BY version").all(runId) as Array<{ event_json: string }>;
    return rows.map((row) => runEventSchema.parse(JSON.parse(row.event_json)));
  }
}

export class PostgresRunEventStore implements RunEventStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 10 }); }
  private init() {
    return this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS run_projections (
        run_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, projection_json JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_control_events (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
        version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, actor TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, event_json JSONB NOT NULL,
        UNIQUE(run_id, version)
      );
    `).then(() => undefined);
  }
  async create(input: { runId?: string; actor: string; idempotencyKey: string; payload?: Record<string, unknown> }) {
    await this.init();
    const existing = input.runId ? await this.get(input.runId) : undefined;
    if (existing) return existing;
    const duplicate = await this.pool.query("SELECT run_id FROM run_control_events WHERE idempotency_key=$1", [input.idempotencyKey]);
    if (duplicate.rowCount) return (await this.get(String(duplicate.rows[0].run_id)))!;
    const runId = input.runId ?? `run_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const event = makeEvent({ runId, type: "run_created", version: 1, actor: input.actor, idempotencyKey: input.idempotencyKey, payload: input.payload });
    const projection = applyEvent({ id: runId, state: "draft", version: 0, createdAt, updatedAt: createdAt, input: input.payload ?? {} }, event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO run_control_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [event.id, runId, event.type, 1, event.createdAt, event.actor, event.idempotencyKey, event]);
      await client.query("INSERT INTO run_projections VALUES ($1,$2,$3,$4,$5,$6)", [runId, projection.state, projection.version, projection.createdAt, projection.updatedAt, projection]);
      await client.query("INSERT INTO runs_v1 (id, organization_id, project_id, state, version, input, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING", [runId, String(projection.input.organizationId ?? "local"), projection.input.projectId ?? null, projection.state, projection.version, projection.input, projection.createdAt, projection.updatedAt]);
      await client.query("INSERT INTO run_events_v1 (id, run_id, payload, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [event.id, runId, event, event.createdAt]);
      await client.query("COMMIT");
      return projection;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async append(input: AppendRunEventInput) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query("SELECT run_id FROM run_control_events WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (duplicate.rowCount) { await client.query("ROLLBACK"); return (await this.get(String(duplicate.rows[0].run_id)))!; }
      const row = await client.query("SELECT run_id FROM run_projections WHERE run_id=$1 FOR UPDATE", [input.runId]);
      if (!row.rowCount) throw new Error("run_not_found");
      const eventRows = await client.query("SELECT event_json FROM run_control_events WHERE run_id=$1 ORDER BY version", [input.runId]);
      const current = replayRunEvents(eventRows.rows.map((eventRow) => runEventSchema.parse(eventRow.event_json)));
      if (!current) throw new Error("run_not_found");
      if (current.version !== input.expectedVersion) throw new Error(`run_version_conflict:${current.version}`);
      const event = makeEvent({ ...input, version: current.version + 1 });
      const projection = applyEvent(current, event);
      await client.query("INSERT INTO run_control_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [event.id, event.runId, event.type, event.version, event.createdAt, event.actor, event.idempotencyKey, event]);
      await client.query("UPDATE run_projections SET state=$2, version=$3, updated_at=$4, projection_json=$5 WHERE run_id=$1", [input.runId, projection.state, projection.version, projection.updatedAt, projection]);
      await client.query("UPDATE runs_v1 SET state=$2, version=$3, final_status=$4, updated_at=$5 WHERE id=$1", [input.runId, projection.state, projection.version, projection.gateStatus ?? null, projection.updatedAt]);
      await client.query("INSERT INTO run_events_v1 (id, run_id, payload, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [event.id, event.runId, event, event.createdAt]);
      await client.query("COMMIT");
      return projection;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async get(runId: string) { await this.init(); return replayRunEvents(await this.events(runId)); }
  async events(runId: string) { await this.init(); const result = await this.pool.query("SELECT event_json FROM run_control_events WHERE run_id=$1 ORDER BY version", [runId]); return result.rows.map((row) => runEventSchema.parse(row.event_json)); }
}

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
export const runEventStore: RunEventStore = process.env.DATABASE_URL
  ? new PostgresRunEventStore(process.env.DATABASE_URL)
  : process.env.NODE_ENV === "production"
    ? (() => { throw new Error("DATABASE_URL is required in production"); })()
    : new SqliteRunEventStore(path.join(rootDir, "reports", "run-state.sqlite"));

export async function appendSystemRunEvent(runId: string, type: RunEventType, payload: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await runEventStore.get(runId);
    if (!current) throw new Error("run_not_found");
    try {
      return await runEventStore.append({
        runId,
        type,
        expectedVersion: current.version,
        actor: "execution-worker",
        idempotencyKey: `${runId}:${type}:${current.version + 1}`,
        payload
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("run_version_conflict:")) throw error;
    }
  }
  throw new Error("run_event_contention");
}
