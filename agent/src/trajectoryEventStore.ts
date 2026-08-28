import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { Pool } from "pg";
import {
  appendTrajectoryEventSchema,
  trajectoryEventSchema,
  type AppendTrajectoryEvent,
  type TrajectoryEvent
} from "@ai-test-officer/contracts";
import { getDatabasePool } from "./databaseRuntime.js";
import { redactValue } from "./redaction.js";

export interface TrajectoryReadOptions {
  afterSeq?: number;
  beforeSeq?: number;
  afterRootSeq?: number;
  beforeRootSeq?: number;
  limit?: number;
}

export interface TrajectoryEventStore {
  append(input: AppendTrajectoryEvent): Promise<TrajectoryEvent>;
  read(runId: string, options?: TrajectoryReadOptions): Promise<TrajectoryEvent[]>;
  readTree(rootRunId: string, options?: TrajectoryReadOptions): Promise<TrajectoryEvent[]>;
  latestSeq(runId: string): Promise<number>;
  latestRootSeq(rootRunId: string): Promise<number>;
}

function normalizeLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return 200;
  return Math.min(1_000, Math.max(1, Math.floor(value!)));
}

function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > 8_000 ? `${value.slice(0, 8_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return value;
}

function makeEvent(input: AppendTrajectoryEvent, seq: number, rootSeq: number, rootRunId: string, parentRunId?: string): TrajectoryEvent {
  const parsed = appendTrajectoryEventSchema.parse(input);
  return trajectoryEventSchema.parse({
    ...parsed,
    id: `trajectory_${randomUUID()}`,
    seq,
    runSeq: seq,
    rootSeq,
    rootRunId,
    ...(parentRunId ? { parentRunId } : {}),
    at: parsed.at ?? new Date().toISOString(),
    payload: compactValue(redactValue(parsed.payload)),
    evidenceRefs: parsed.evidenceRefs ?? []
  });
}

export class MemoryTrajectoryEventStore implements TrajectoryEventStore {
  private readonly streams = new Map<string, TrajectoryEvent[]>();
  private readonly rootSequences = new Map<string, number>();
  private readonly runRoots = new Map<string, string>();

  async append(input: AppendTrajectoryEvent) {
    const stream = this.streams.get(input.runId) ?? [];
    const existing = stream.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const parentRunId = input.parentRunId ?? (typeof input.payload?.parentRunId === "string" ? input.payload.parentRunId : undefined);
    const rootRunId = input.rootRunId ?? (typeof input.payload?.rootRunId === "string" ? input.payload.rootRunId : undefined) ?? (parentRunId ? this.runRoots.get(parentRunId) ?? parentRunId : this.runRoots.get(input.runId) ?? input.runId);
    this.runRoots.set(input.runId, rootRunId);
    const rootSeq = (this.rootSequences.get(rootRunId) ?? 0) + 1;
    this.rootSequences.set(rootRunId, rootSeq);
    const event = makeEvent(input, stream.length + 1, rootSeq, rootRunId, parentRunId);
    stream.push(event);
    this.streams.set(input.runId, stream);
    return event;
  }

  async read(runId: string, options: TrajectoryReadOptions = {}) {
    const after = Number.isFinite(options.afterSeq) ? options.afterSeq! : 0;
    const before = Number.isFinite(options.beforeSeq) ? options.beforeSeq! : Number.MAX_SAFE_INTEGER;
    return (this.streams.get(runId) ?? [])
      .filter((event) => event.seq > after && event.seq < before)
      .slice(0, normalizeLimit(options.limit));
  }

  async latestSeq(runId: string) {
    return (this.streams.get(runId) ?? []).at(-1)?.seq ?? 0;
  }

  async readTree(rootRunId: string, options: TrajectoryReadOptions = {}) {
    const after = Number.isFinite(options.afterRootSeq) ? options.afterRootSeq! : 0;
    const before = Number.isFinite(options.beforeRootSeq) ? options.beforeRootSeq! : Number.MAX_SAFE_INTEGER;
    return [...this.streams.values()].flat().filter((event) => event.rootRunId === rootRunId && (event.rootSeq ?? 0) > after && (event.rootSeq ?? 0) < before).sort((a, b) => (a.rootSeq ?? a.seq) - (b.rootSeq ?? b.seq)).slice(0, normalizeLimit(options.limit));
  }

  async latestRootSeq(rootRunId: string) {
    return this.rootSequences.get(rootRunId) ?? 0;
  }
}

export class SqliteTrajectoryEventStore implements TrajectoryEventStore {
  private readonly database: DatabaseSync;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trajectory_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        run_seq INTEGER NOT NULL,
        root_run_id TEXT NOT NULL,
        root_seq BIGINT NOT NULL,
        parent_run_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        attempt_id TEXT,
        trace_id TEXT,
        parent_event_id TEXT,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        UNIQUE(run_id, seq),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS trajectory_root_sequences (
        root_run_id TEXT PRIMARY KEY,
        root_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trajectory_events_run_seq ON trajectory_events(run_id, seq);
      CREATE TRIGGER IF NOT EXISTS trajectory_events_no_update
        BEFORE UPDATE ON trajectory_events BEGIN SELECT RAISE(ABORT, 'trajectory_events_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS trajectory_events_no_delete
        BEFORE DELETE ON trajectory_events BEGIN SELECT RAISE(ABORT, 'trajectory_events_append_only'); END;
    `);
    // Additive upgrades for local workspaces created before the richer event
    // envelope was introduced. Existing rows remain immutable and simply use
    // NULL/default values for fields they could not have recorded.
    for (const column of [
      "turn_id TEXT", "step_id TEXT", "span_id TEXT", "parent_span_id TEXT",
      "status TEXT", "usage_json TEXT", "timing_json TEXT", "visibility TEXT",
      "parent_run_id TEXT", "root_run_id TEXT", "root_seq INTEGER", "run_seq INTEGER"
    ]) {
      try { this.database.exec(`ALTER TABLE trajectory_events ADD COLUMN ${column}`); } catch { /* already present */ }
    }
  }

  private enqueue<T>(runId: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(runId, next);
    return next.finally(() => { if (this.queues.get(runId) === next) this.queues.delete(runId); });
  }

  async append(input: AppendTrajectoryEvent) {
    return this.enqueue(input.runId, () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const duplicate = this.database.prepare("SELECT payload_json FROM trajectory_events WHERE run_id=? AND idempotency_key=?").get(input.runId, input.idempotencyKey) as { payload_json?: string } | undefined;
        if (duplicate?.payload_json) { this.database.exec("COMMIT"); return trajectoryEventSchema.parse(JSON.parse(duplicate.payload_json)); }
        const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trajectory_events WHERE run_id=?").get(input.runId) as { seq: number };
        const parentRunId = input.parentRunId ?? (typeof input.payload?.parentRunId === "string" ? input.payload.parentRunId : undefined);
        // Rehydrate the run→root mapping from the append-only stream after a
        // process restart. LLM/tool events normally carry only runId; the
        // durable run.created event is the source of the inherited root.
        const existingRoot = this.database.prepare("SELECT root_run_id FROM trajectory_events WHERE run_id=? AND root_run_id IS NOT NULL ORDER BY seq LIMIT 1").get(input.runId) as { root_run_id?: string } | undefined;
        const rootRunId = input.rootRunId ?? (typeof input.payload?.rootRunId === "string" ? input.payload.rootRunId : undefined) ?? existingRoot?.root_run_id ?? (parentRunId ? (this.database.prepare("SELECT root_run_id FROM trajectory_events WHERE run_id=? AND root_run_id IS NOT NULL ORDER BY root_seq LIMIT 1").get(parentRunId) as { root_run_id?: string } | undefined)?.root_run_id ?? parentRunId : input.runId);
        const rootRow = this.database.prepare("SELECT root_seq FROM trajectory_root_sequences WHERE root_run_id=?").get(rootRunId) as { root_seq?: number } | undefined;
        const legacyRoot = this.database.prepare("SELECT MAX(COALESCE(root_seq,seq)) AS root_seq FROM trajectory_events WHERE root_run_id=? OR (root_run_id IS NULL AND run_id=?)").get(rootRunId, rootRunId) as { root_seq?: number } | undefined;
        const rootSeq = Math.max(Number(rootRow?.root_seq ?? 0), Number(legacyRoot?.root_seq ?? 0)) + 1;
        if (rootRow) this.database.prepare("UPDATE trajectory_root_sequences SET root_seq=? WHERE root_run_id=?").run(rootSeq, rootRunId);
        else this.database.prepare("INSERT INTO trajectory_root_sequences(root_run_id,root_seq) VALUES (?,?)").run(rootRunId, rootSeq);
        const event = makeEvent(input, Number(row.seq) + 1, rootSeq, rootRunId, parentRunId);
        this.database.prepare(`INSERT INTO trajectory_events
        (id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage_json,timing_json,visibility,idempotency_key,payload_json,evidence_refs_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.id, event.runId, event.seq, event.runSeq ?? event.seq, event.rootRunId ?? rootRunId, event.rootSeq ?? rootSeq, event.parentRunId ?? null, event.type, event.at, event.actor,
        event.turnId ?? null, event.stepId ?? null, event.attemptId ?? null, event.traceId ?? null, event.parentEventId ?? null,
        event.spanId ?? null, event.parentSpanId ?? null, event.status ?? null,
        event.usage ? JSON.stringify(event.usage) : null, event.timing ? JSON.stringify(event.timing) : null,
        event.visibility, event.idempotencyKey, JSON.stringify(event.payload), JSON.stringify(event.evidenceRefs)
        );
        this.database.exec("COMMIT");
        return event;
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    });
  }

  async read(runId: string, options: TrajectoryReadOptions = {}) {
    const limit = normalizeLimit(options.limit);
    const after = Number.isFinite(options.afterSeq) ? options.afterSeq! : 0;
    const before = Number.isFinite(options.beforeSeq) ? options.beforeSeq! : Number.MAX_SAFE_INTEGER;
    const rows = this.database.prepare(`SELECT id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage_json,timing_json,visibility,idempotency_key,payload_json,evidence_refs_json
      FROM trajectory_events WHERE run_id=? AND seq>? AND seq<? ORDER BY seq ASC LIMIT ?`).all(runId, after, before, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => trajectoryEventSchema.parse({
      schemaVersion: "1.0", id: row.id, runId: row.run_id, seq: row.seq, runSeq: row.run_seq ?? row.seq, rootRunId: row.root_run_id ?? row.run_id, rootSeq: row.root_seq ?? row.seq, parentRunId: row.parent_run_id ?? undefined, type: row.type, at: row.at, actor: row.actor,
      turnId: row.turn_id ?? undefined, stepId: row.step_id ?? undefined,
      attemptId: row.attempt_id ?? undefined, traceId: row.trace_id ?? undefined,
      parentEventId: row.parent_event_id ?? undefined, spanId: row.span_id ?? undefined, parentSpanId: row.parent_span_id ?? undefined,
      status: row.status ?? undefined, usage: row.usage_json ? JSON.parse(String(row.usage_json)) : undefined,
      timing: row.timing_json ? JSON.parse(String(row.timing_json)) : undefined, visibility: row.visibility ?? "user", idempotencyKey: row.idempotency_key,
      payload: JSON.parse(String(row.payload_json)), evidenceRefs: JSON.parse(String(row.evidence_refs_json))
    }));
  }

  async latestSeq(runId: string) {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM trajectory_events WHERE run_id=?").get(runId) as { seq: number };
    return Number(row.seq);
  }

  async readTree(rootRunId: string, options: TrajectoryReadOptions = {}) {
    const limit = normalizeLimit(options.limit);
    const after = Number.isFinite(options.afterRootSeq) ? options.afterRootSeq! : 0;
    const before = Number.isFinite(options.beforeRootSeq) ? options.beforeRootSeq! : Number.MAX_SAFE_INTEGER;
    const rows = this.database.prepare(`SELECT id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage_json,timing_json,visibility,idempotency_key,payload_json,evidence_refs_json FROM trajectory_events WHERE (root_run_id=? OR (root_run_id IS NULL AND run_id=?)) AND COALESCE(root_seq,seq)>? AND COALESCE(root_seq,seq)<? ORDER BY COALESCE(root_seq,seq) ASC LIMIT ?`).all(rootRunId, rootRunId, after, before, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => trajectoryEventSchema.parse({ schemaVersion: "1.0", id: row.id, runId: row.run_id, seq: row.seq, runSeq: row.run_seq ?? row.seq, rootRunId: row.root_run_id ?? rootRunId, rootSeq: row.root_seq ?? row.seq, parentRunId: row.parent_run_id ?? undefined, type: row.type, at: row.at, actor: row.actor, turnId: row.turn_id ?? undefined, stepId: row.step_id ?? undefined, attemptId: row.attempt_id ?? undefined, traceId: row.trace_id ?? undefined, parentEventId: row.parent_event_id ?? undefined, spanId: row.span_id ?? undefined, parentSpanId: row.parent_span_id ?? undefined, status: row.status ?? undefined, usage: row.usage_json ? JSON.parse(String(row.usage_json)) : undefined, timing: row.timing_json ? JSON.parse(String(row.timing_json)) : undefined, visibility: row.visibility ?? "user", idempotencyKey: row.idempotency_key, payload: JSON.parse(String(row.payload_json)), evidenceRefs: JSON.parse(String(row.evidence_refs_json)) }));
  }

  async latestRootSeq(rootRunId: string) {
    const row = this.database.prepare("SELECT COALESCE((SELECT root_seq FROM trajectory_root_sequences WHERE root_run_id=?),(SELECT MAX(COALESCE(root_seq,seq)) FROM trajectory_events WHERE root_run_id=?),0) AS root_seq").get(rootRunId, rootRunId) as { root_seq?: number } | undefined;
    return Number(row?.root_seq ?? 0);
  }
}

export class PostgresTrajectoryEventStore implements TrajectoryEventStore {
  private readonly pool: Pool;
  private initialized?: Promise<void>;

  constructor(connectionString: string) {
    const pool = getDatabasePool(connectionString);
    if (!pool) throw new Error("DATABASE_URL is required for PostgreSQL trajectory events");
    this.pool = pool;
  }

  private init() {
    return this.initialized ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS trajectory_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        run_seq INTEGER NOT NULL,
        root_run_id TEXT NOT NULL,
        root_seq BIGINT NOT NULL,
        parent_run_id TEXT,
        type TEXT NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        actor TEXT NOT NULL,
        turn_id TEXT,
        step_id TEXT,
        attempt_id TEXT,
        trace_id TEXT,
        parent_event_id TEXT,
        span_id TEXT,
        parent_span_id TEXT,
        status TEXT,
        usage JSONB,
        timing JSONB,
        visibility TEXT NOT NULL DEFAULT 'user',
        idempotency_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
        UNIQUE(run_id, seq),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS trajectory_root_sequences (
        root_run_id TEXT PRIMARY KEY,
        root_seq BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trajectory_events_run_seq ON trajectory_events(run_id, seq);
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS turn_id TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS step_id TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS span_id TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS parent_span_id TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS status TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS usage JSONB;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS timing JSONB;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS run_seq INTEGER;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS root_run_id TEXT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS root_seq BIGINT;
      ALTER TABLE trajectory_events ADD COLUMN IF NOT EXISTS parent_run_id TEXT;
      DROP TRIGGER IF EXISTS trajectory_events_no_update ON trajectory_events;
      DROP TRIGGER IF EXISTS trajectory_events_no_delete ON trajectory_events;
      UPDATE trajectory_events SET run_seq=seq WHERE run_seq IS NULL;
      UPDATE trajectory_events SET root_run_id=run_id WHERE root_run_id IS NULL;
      UPDATE trajectory_events SET root_seq=seq WHERE root_seq IS NULL;
      INSERT INTO trajectory_root_sequences(root_run_id, root_seq)
        SELECT root_run_id, MAX(root_seq) FROM trajectory_events GROUP BY root_run_id
        ON CONFLICT (root_run_id) DO UPDATE SET root_seq = GREATEST(trajectory_root_sequences.root_seq, EXCLUDED.root_seq);
      ALTER TABLE trajectory_events ALTER COLUMN run_seq SET NOT NULL;
      ALTER TABLE trajectory_events ALTER COLUMN root_run_id SET NOT NULL;
      ALTER TABLE trajectory_events ALTER COLUMN root_seq SET NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_trajectory_events_root_seq ON trajectory_events(root_run_id, root_seq);
      CREATE OR REPLACE FUNCTION trajectory_events_append_only() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'trajectory_events_append_only'; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS trajectory_events_no_update ON trajectory_events;
      CREATE TRIGGER trajectory_events_no_update BEFORE UPDATE ON trajectory_events FOR EACH ROW EXECUTE FUNCTION trajectory_events_append_only();
      DROP TRIGGER IF EXISTS trajectory_events_no_delete ON trajectory_events;
      CREATE TRIGGER trajectory_events_no_delete BEFORE DELETE ON trajectory_events FOR EACH ROW EXECUTE FUNCTION trajectory_events_append_only();
    `).then(() => undefined);
  }

  async append(input: AppendTrajectoryEvent) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize sequence allocation per run without introducing a mutable
      // counter row. The event table remains append-only and concurrent
      // emitters cannot both claim the same sequence number.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.runId]);
      const duplicate = await client.query("SELECT id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage,timing,visibility,idempotency_key,payload,evidence_refs FROM trajectory_events WHERE run_id=$1 AND idempotency_key=$2", [input.runId, input.idempotencyKey]);
      if (duplicate.rowCount) {
        await client.query("ROLLBACK");
        const row = duplicate.rows[0];
        return trajectoryEventSchema.parse({ ...row, schemaVersion: "1.0", rootSeq: Number(row.root_seq), runSeq: Number(row.run_seq), at: row.at instanceof Date ? row.at.toISOString() : row.at });
      }
      const latest = await client.query("SELECT seq FROM trajectory_events WHERE run_id=$1 ORDER BY seq DESC LIMIT 1 FOR UPDATE", [input.runId]);
      const parentRunId = input.parentRunId ?? (typeof input.payload?.parentRunId === "string" ? input.payload.parentRunId : undefined);
      let rootRunId = input.rootRunId ?? (typeof input.payload?.rootRunId === "string" ? input.payload.rootRunId : undefined);
      if (!rootRunId) {
        const existing = await client.query("SELECT root_run_id FROM trajectory_events WHERE run_id=$1 ORDER BY root_seq ASC LIMIT 1", [input.runId]);
        rootRunId = existing.rows[0]?.root_run_id ? String(existing.rows[0].root_run_id) : undefined;
      }
      if (!rootRunId && parentRunId) {
        const parent = await client.query("SELECT root_run_id FROM trajectory_events WHERE run_id=$1 ORDER BY root_seq ASC LIMIT 1", [parentRunId]);
        rootRunId = String(parent.rows[0]?.root_run_id ?? parentRunId);
      }
      rootRunId ??= input.runId;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [rootRunId]);
      const root = await client.query("SELECT root_seq FROM trajectory_root_sequences WHERE root_run_id=$1 FOR UPDATE", [rootRunId]);
      const rootSeq = Number(root.rows[0]?.root_seq ?? 0) + 1;
      if (root.rowCount) await client.query("UPDATE trajectory_root_sequences SET root_seq=$2 WHERE root_run_id=$1", [rootRunId, rootSeq]);
      else await client.query("INSERT INTO trajectory_root_sequences(root_run_id,root_seq) VALUES ($1,$2)", [rootRunId, rootSeq]);
      const event = makeEvent(input, Number(latest.rows[0]?.seq ?? 0) + 1, rootSeq, rootRunId, parentRunId);
      await client.query(`INSERT INTO trajectory_events
        (id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage,timing,visibility,idempotency_key,payload,evidence_refs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`, [event.id, event.runId, event.seq, event.runSeq ?? event.seq, event.rootRunId ?? rootRunId, event.rootSeq ?? rootSeq, event.parentRunId ?? null, event.type, event.at, event.actor, event.turnId ?? null, event.stepId ?? null, event.attemptId ?? null, event.traceId ?? null, event.parentEventId ?? null, event.spanId ?? null, event.parentSpanId ?? null, event.status ?? null, event.usage ?? null, event.timing ?? null, event.visibility, event.idempotencyKey, event.payload, event.evidenceRefs]);
      await client.query("COMMIT");
      return event;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async read(runId: string, options: TrajectoryReadOptions = {}) {
    await this.init();
    const limit = normalizeLimit(options.limit);
    const after = Number.isFinite(options.afterSeq) ? options.afterSeq! : 0;
    const before = Number.isFinite(options.beforeSeq) ? options.beforeSeq! : Number.MAX_SAFE_INTEGER;
    const result = await this.pool.query("SELECT id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage,timing,visibility,idempotency_key,payload,evidence_refs FROM trajectory_events WHERE run_id=$1 AND seq>$2 AND seq<$3 ORDER BY seq ASC LIMIT $4", [runId, after, before, limit]);
    return result.rows.map((row) => trajectoryEventSchema.parse({ schemaVersion: "1.0", ...row, rootSeq: Number(row.root_seq), runSeq: Number(row.run_seq), at: row.at instanceof Date ? row.at.toISOString() : row.at }));
  }

  async latestSeq(runId: string) {
    await this.init();
    const result = await this.pool.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM trajectory_events WHERE run_id=$1", [runId]);
    return Number(result.rows[0]?.seq ?? 0);
  }

  async readTree(rootRunId: string, options: TrajectoryReadOptions = {}) {
    await this.init();
    const limit = normalizeLimit(options.limit);
    const after = Number.isFinite(options.afterRootSeq) ? options.afterRootSeq! : 0;
    const before = Number.isFinite(options.beforeRootSeq) ? options.beforeRootSeq! : Number.MAX_SAFE_INTEGER;
    const result = await this.pool.query("SELECT id,run_id,seq,run_seq,root_run_id,root_seq,parent_run_id,type,at,actor,turn_id,step_id,attempt_id,trace_id,parent_event_id,span_id,parent_span_id,status,usage,timing,visibility,idempotency_key,payload,evidence_refs FROM trajectory_events WHERE root_run_id=$1 AND root_seq>$2 AND root_seq<$3 ORDER BY root_seq ASC LIMIT $4", [rootRunId, after, before, limit]);
    return result.rows.map((row) => trajectoryEventSchema.parse({ schemaVersion: "1.0", ...row, rootSeq: Number(row.root_seq), runSeq: Number(row.run_seq), at: row.at instanceof Date ? row.at.toISOString() : row.at }));
  }

  async latestRootSeq(rootRunId: string) {
    await this.init();
    const result = await this.pool.query("SELECT root_seq FROM trajectory_root_sequences WHERE root_run_id=$1", [rootRunId]);
    return Number(result.rows[0]?.root_seq ?? 0);
  }
}

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
export const trajectoryEventStore: TrajectoryEventStore = process.env.DATABASE_URL
  ? new PostgresTrajectoryEventStore(process.env.DATABASE_URL)
  : new SqliteTrajectoryEventStore(path.join(rootDir, "reports", "trajectory.sqlite"));
