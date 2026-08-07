/** Contract-first in-process tracer. It is intentionally storage agnostic. */
import type {
  TraceActor,
  TraceChain,
  TraceId,
  TraceQuery,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
  SpanId
} from "@ai-test-officer/contracts";
import { createHash, randomUUID } from "node:crypto";

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
  constructor(store?: TraceStore) { this.store = store ?? createStore(); }

  startChain(runId: string, projectId?: string, requirement?: string, diff?: string): TraceId {
    const traceId = generateTraceId();
    const now = new Date().toISOString();
    const chain: TraceChain = {
      schemaVersion: "1.0", traceId, runId, projectId,
      rootRequest: { actor: "user", requirement, diff, inputs: [], timestamp: now },
      spans: [],
      statistics: { totalSpans: 0, okSpans: 0, errorSpans: 0, totalDurationMs: 0, maxDepth: 0, actorBreakdown: {} },
      criticalPath: [], generatedAt: now
    };
    this.store.chains.set(traceId, chain);
    this.active.set(runId, traceId);
    return traceId;
  }

  startTrace(runId: string, projectId?: string, requirement?: string, diff?: string): TraceId {
    return this.startChain(runId, projectId, requirement, diff);
  }
  endChain(runId: string): TraceChain | undefined {
    const traceId = this.active.get(runId);
    if (!traceId) return undefined;
    this.active.delete(runId);
    return this.store.chains.get(traceId);
  }

  startSpan(runId: string, kind: TraceSpanKind, name: string, actor: TraceActor, input?: unknown, parentSpanId?: SpanId): SpanId {
    const traceId = this.active.get(runId) ?? this.startChain(runId);
    const now = new Date().toISOString();
    const spanId = generateSpanId();
    const span: TraceSpan = {
      schemaVersion: "1.0", traceId, spanId, parentSpanId,
      kind: kindFor(kind), name, actor: actorFor(actor), status: "ok",
      startTimestamp: now, inputHash: hashInput(input), runId, createdAt: now
    };
    this.store.spans.set(spanId, span);
    this.rebuild(traceId);
    return spanId;
  }

  endSpan(spanId: SpanId, output?: unknown, status: TraceSpanStatus = "ok", error?: string): TraceSpan | undefined {
    const span = this.store.spans.get(spanId);
    if (!span) return undefined;
    const now = new Date().toISOString();
    span.outputHash = hashInput(output ?? null);
    span.status = status;
    span.endTimestamp = now;
    span.durationMs = Math.max(0, Date.parse(now) - Date.parse(span.startTimestamp));
    if (error) span.error = { code: status, message: error, recoverable: status !== "error" };
    this.store.spans.set(spanId, span);
    this.rebuild(span.traceId);
    return span;
  }

  traceUserRequest(runId: string, request: unknown): SpanId { return this.startSpan(runId, "request", "User Request", "user", request); }
  traceAgentDecision(runId: string, nodeName: string, input: unknown, parentSpanId?: SpanId): SpanId { return this.startSpan(runId, "decision", nodeName, "planner", input, parentSpanId); }
  traceToolCall(runId: string, toolName: string, params: unknown, parentSpanId?: SpanId): SpanId { return this.startSpan(runId, "tool_call", toolName, "system", params, parentSpanId); }
  traceExecution(runId: string, stepName: string, input: unknown, parentSpanId?: SpanId): SpanId { return this.startSpan(runId, "execution", stepName, "executor", input, parentSpanId); }
  traceEvidence(runId: string, evidenceType: string, input: unknown, parentSpanId?: SpanId): SpanId { return this.startSpan(runId, "evidence_collection", evidenceType, "collector", input, parentSpanId); }
  traceJudgment(runId: string, judgmentType: string, input: unknown, parentSpanId?: SpanId): SpanId { return this.startSpan(runId, "judgment", judgmentType, "judge", input, parentSpanId); }

  getChain(traceId: TraceId): TraceChain | undefined { return this.store.chains.get(traceId); }
  getChainByRunId(runId: string): TraceChain | undefined { const id = this.active.get(runId); return id ? this.store.chains.get(id) : [...this.store.chains.values()].find((c) => c.runId === runId); }
  getSpan(spanId: SpanId): TraceSpan | undefined { return this.store.spans.get(spanId); }
  getSpansByChain(traceId: TraceId): TraceSpan[] { return this.store.chains.get(traceId)?.spans ?? []; }

  query(query: TraceQuery): TraceChain[] {
    let chains = [...this.store.chains.values()];
    if (query.runId) chains = chains.filter((c) => c.runId === query.runId);
    if (query.projectId) chains = chains.filter((c) => c.projectId === query.projectId);
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

  exportChain(traceId: TraceId): { chain: TraceChain; spans: TraceSpan[] } | undefined {
    const chain = this.store.chains.get(traceId); return chain ? { chain, spans: chain.spans } : undefined;
  }

  private rebuild(traceId: TraceId): void {
    const chain = this.store.chains.get(traceId); if (!chain) return;
    const spans = [...this.store.spans.values()].filter((span) => span.traceId === traceId);
    const byActor: Record<string, number> = {};
    for (const span of spans) byActor[span.actor] = (byActor[span.actor] ?? 0) + 1;
    const depth = (span: TraceSpan): number => {
      let d = 0; let parent = span.parentSpanId;
      while (parent) { d += 1; parent = this.store.spans.get(parent)?.parentSpanId; }
      return d;
    };
    const critical = spans.filter((span) => span.durationMs !== undefined).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 20);
    chain.spans = spans;
    chain.statistics = {
      totalSpans: spans.length,
      okSpans: spans.filter((span) => span.status === "ok").length,
      errorSpans: spans.filter((span) => span.status !== "ok").length,
      totalDurationMs: spans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0),
      maxDepth: spans.reduce((max, span) => Math.max(max, depth(span)), 0),
      actorBreakdown: byActor
    };
    chain.criticalPath = critical.map((span) => ({ spanId: span.spanId, name: span.name, durationMs: span.durationMs ?? 0, status: span.status }));
    this.store.chains.set(traceId, chain);
  }
}

let instance: Tracer | undefined;
export function getTracer(): Tracer { instance ??= new Tracer(); return instance; }
