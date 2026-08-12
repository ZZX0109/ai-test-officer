/** Durable, contract-first tracer. PostgreSQL is the production fact source. */
import {
  traceChainSchema,
  traceSpanSchema,
  type TraceActor,
  type TraceChain,
  type TraceId,
  type TraceQuery,
  type TraceSpan,
  type TraceSpanKind,
  type TraceSpanStatus,
  type SpanId
} from "@ai-test-officer/contracts";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

const id32 = (): string => `${randomUUID()}${randomUUID()}`.replaceAll("-", "").slice(0, 32);
export const generateTraceId = (): TraceId => `trace_${id32()}` as TraceId;
export const generateSpanId = (): SpanId => `span_${id32()}` as SpanId;
export function hashInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
}

interface TraceStore { chains: Map<TraceId, TraceChain>; spans: Map<SpanId, TraceSpan>; }
const createStore = (): TraceStore => ({ chains: new Map(), spans: new Map() });

const kindFor = (kind: string): TraceSpanKind => {
  const allowed: TraceSpanKind[] = ["request", "decision", "tool_call", "execution", "evidence_collection", "judgment", "human_interaction", "internal"];
  return allowed.includes(kind as TraceSpanKind) ? kind as TraceSpanKind : "internal";
};
const actorFor = (actor: string): TraceActor => {
  const allowed: TraceActor[] = ["user", "planner", "discovery", "compiler", "executor", "browser", "api-executor", "collector", "gate", "judge", "repair", "human_reviewer", "system"];
  return allowed.includes(actor as TraceActor) ? actor as TraceActor : "system";
};

export class Tracer {
  private readonly store: TraceStore;
  private readonly active = new Map<string, TraceId>();
  private readonly pool?: Pool;

  constructor(store?: TraceStore, connectionString = process.env.DATABASE_URL) {
    this.store = store ?? createStore();
    this.pool = !store && connectionString ? new Pool({ connectionString, max: 2 }) : undefined;
  }

  async startChain(runId: string, projectId?: string, requirement?: string, diff?: string): Promise<TraceId> {
    const traceId = generateTraceId();
    const now = new Date().toISOString();
    const chain = traceChainSchema.parse({
      schemaVersion: "1.0", traceId, runId, projectId,
      rootRequest: { actor: "user", requirement, diff, inputs: [], timestamp: now },
      spans: [],
      statistics: { totalSpans: 0, okSpans: 0, errorSpans: 0, totalDurationMs: 0, maxDepth: 0, actorBreakdown: {} },
      criticalPath: [], generatedAt: now
    });
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE trace_chains_v1 SET active=false,updated_at=$2 WHERE run_id=$1 AND active=true", [runId, now]);
        await client.query(
          "INSERT INTO trace_chains_v1 (trace_id,run_id,project_id,active,payload,updated_at) VALUES ($1,$2,$3,true,$4,$5)",
          [traceId, runId, projectId ?? null, chain, now]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    } else {
      this.store.chains.set(traceId, chain);
    }
    this.active.set(runId, traceId);
    return traceId;
  }

  async startTrace(runId: string, projectId?: string, requirement?: string, diff?: string): Promise<TraceId> {
    return this.startChain(runId, projectId, requirement, diff);
  }

  async endChain(runId: string): Promise<TraceChain | undefined> {
    const traceId = await this.activeTraceId(runId);
    if (!traceId) return undefined;
    this.active.delete(runId);
    if (this.pool) await this.pool.query("UPDATE trace_chains_v1 SET active=false,updated_at=now() WHERE trace_id=$1", [traceId]);
    return this.getChain(traceId);
  }

  async startSpan(runId: string, kind: TraceSpanKind, name: string, actor: TraceActor, input?: unknown, parentSpanId?: SpanId): Promise<SpanId> {
    const traceId = await this.activeTraceId(runId) ?? await this.startChain(runId);
    const now = new Date().toISOString();
    const spanId = generateSpanId();
    const span = traceSpanSchema.parse({
      schemaVersion: "1.0", traceId, spanId, parentSpanId,
      kind: kindFor(kind), name, actor: actorFor(actor), status: "ok",
      startTimestamp: now, inputHash: hashInput(input), runId, createdAt: now
    });
    if (this.pool) {
      await this.pool.query(
        "INSERT INTO trace_spans_v1 (span_id,trace_id,run_id,payload,started_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [spanId, traceId, runId, span, now]
      );
    } else this.store.spans.set(spanId, span);
    await this.rebuild(traceId);
    return spanId;
  }

  async endSpan(spanId: SpanId, output?: unknown, status: TraceSpanStatus = "ok", error?: string): Promise<TraceSpan | undefined> {
    const span = await this.getSpan(spanId);
    if (!span) return undefined;
    const now = new Date().toISOString();
    const updated = traceSpanSchema.parse({
      ...span,
      outputHash: hashInput(output ?? null),
      status,
      endTimestamp: now,
      durationMs: Math.max(0, Date.parse(now) - Date.parse(span.startTimestamp)),
      ...(error ? { error: { code: status, message: error, recoverable: status !== "error" } } : {})
    });
    if (this.pool) await this.pool.query("UPDATE trace_spans_v1 SET payload=$2,updated_at=$3 WHERE span_id=$1", [spanId, updated, now]);
    else this.store.spans.set(spanId, updated);
    await this.rebuild(updated.traceId);
    return updated;
  }

  traceUserRequest(runId: string, request: unknown): Promise<SpanId> { return this.startSpan(runId, "request", "User Request", "user", request); }
  traceAgentDecision(runId: string, nodeName: string, input: unknown, parentSpanId?: SpanId): Promise<SpanId> { return this.startSpan(runId, "decision", nodeName, "planner", input, parentSpanId); }
  traceToolCall(runId: string, toolName: string, params: unknown, parentSpanId?: SpanId): Promise<SpanId> { return this.startSpan(runId, "tool_call", toolName, "system", params, parentSpanId); }
  traceExecution(runId: string, stepName: string, input: unknown, parentSpanId?: SpanId): Promise<SpanId> { return this.startSpan(runId, "execution", stepName, "executor", input, parentSpanId); }
  traceEvidence(runId: string, evidenceType: string, input: unknown, parentSpanId?: SpanId): Promise<SpanId> { return this.startSpan(runId, "evidence_collection", evidenceType, "collector", input, parentSpanId); }
  traceJudgment(runId: string, judgmentType: string, input: unknown, parentSpanId?: SpanId): Promise<SpanId> { return this.startSpan(runId, "judgment", judgmentType, "judge", input, parentSpanId); }

  async getChain(traceId: TraceId): Promise<TraceChain | undefined> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM trace_chains_v1 WHERE trace_id=$1", [traceId]);
      return result.rows[0] ? traceChainSchema.parse(result.rows[0].payload) : undefined;
    }
    return this.store.chains.get(traceId);
  }

  async getChainByRunId(runId: string): Promise<TraceChain | undefined> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM trace_chains_v1 WHERE run_id=$1 ORDER BY active DESC,updated_at DESC LIMIT 1", [runId]);
      return result.rows[0] ? traceChainSchema.parse(result.rows[0].payload) : undefined;
    }
    const id = this.active.get(runId);
    return id ? this.store.chains.get(id) : [...this.store.chains.values()].find((chain) => chain.runId === runId);
  }

  async getSpan(spanId: SpanId): Promise<TraceSpan | undefined> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM trace_spans_v1 WHERE span_id=$1", [spanId]);
      return result.rows[0] ? traceSpanSchema.parse(result.rows[0].payload) : undefined;
    }
    return this.store.spans.get(spanId);
  }

  async getSpansByChain(traceId: TraceId): Promise<TraceSpan[]> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM trace_spans_v1 WHERE trace_id=$1 ORDER BY started_at", [traceId]);
      return result.rows.map((row) => traceSpanSchema.parse(row.payload));
    }
    return [...this.store.spans.values()].filter((span) => span.traceId === traceId);
  }

  async query(query: TraceQuery): Promise<TraceChain[]> {
    let chains: TraceChain[];
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>(
        "SELECT payload FROM trace_chains_v1 WHERE ($1::text IS NULL OR run_id=$1) AND ($2::text IS NULL OR project_id=$2) ORDER BY updated_at DESC",
        [query.runId ?? null, query.projectId ?? null]
      );
      chains = result.rows.map((row) => traceChainSchema.parse(row.payload));
    } else chains = [...this.store.chains.values()];
    if (query.runId) chains = chains.filter((chain) => chain.runId === query.runId);
    if (query.projectId) chains = chains.filter((chain) => chain.projectId === query.projectId);
    if (query.actor || query.kind || query.status || query.minDurationMs !== undefined || query.hasError || query.startAfter || query.startBefore) {
      chains = chains.filter((chain) => chain.spans.some((span) =>
        (!query.actor || span.actor === query.actor) && (!query.kind || span.kind === query.kind) &&
        (!query.status || span.status === query.status) && (query.minDurationMs === undefined || (span.durationMs ?? 0) >= query.minDurationMs) &&
        (query.hasError === undefined || query.hasError === Boolean(span.error)) &&
        (!query.startAfter || span.startTimestamp >= query.startAfter) && (!query.startBefore || span.startTimestamp <= query.startBefore)
      ));
    }
    return chains.slice(0, query.limit);
  }

  async exportChain(traceId: TraceId): Promise<{ chain: TraceChain; spans: TraceSpan[] } | undefined> {
    const chain = await this.getChain(traceId);
    return chain ? { chain, spans: await this.getSpansByChain(traceId) } : undefined;
  }

  async close(): Promise<void> { await this.pool?.end(); }

  private async activeTraceId(runId: string): Promise<TraceId | undefined> {
    const cached = this.active.get(runId);
    if (cached) return cached;
    if (!this.pool) return undefined;
    const result = await this.pool.query<{ trace_id: TraceId }>("SELECT trace_id FROM trace_chains_v1 WHERE run_id=$1 AND active=true ORDER BY updated_at DESC LIMIT 1", [runId]);
    const traceId = result.rows[0]?.trace_id;
    if (traceId) this.active.set(runId, traceId);
    return traceId;
  }

  private async rebuild(traceId: TraceId): Promise<void> {
    const chain = await this.getChain(traceId);
    if (!chain) return;
    const spans = await this.getSpansByChain(traceId);
    const byActor: Record<string, number> = {};
    for (const span of spans) byActor[span.actor] = (byActor[span.actor] ?? 0) + 1;
    const byId = new Map(spans.map((span) => [span.spanId, span]));
    const depth = (span: TraceSpan): number => {
      let value = 0; let parent = span.parentSpanId;
      while (parent) { value += 1; parent = byId.get(parent)?.parentSpanId; }
      return value;
    };
    const critical = spans.filter((span) => span.durationMs !== undefined).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 20);
    const updated = traceChainSchema.parse({
      ...chain,
      spans,
      statistics: {
        totalSpans: spans.length,
        okSpans: spans.filter((span) => span.status === "ok").length,
        errorSpans: spans.filter((span) => span.status !== "ok").length,
        totalDurationMs: spans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0),
        maxDepth: spans.reduce((max, span) => Math.max(max, depth(span)), 0),
        actorBreakdown: byActor
      },
      criticalPath: critical.map((span) => ({ spanId: span.spanId, name: span.name, durationMs: span.durationMs ?? 0, status: span.status }))
    });
    if (this.pool) await this.pool.query("UPDATE trace_chains_v1 SET payload=$2,updated_at=now() WHERE trace_id=$1", [traceId, updated]);
    else this.store.chains.set(traceId, updated);
  }
}

let instance: Tracer | undefined;
export function getTracer(): Tracer { instance ??= new Tracer(); return instance; }
