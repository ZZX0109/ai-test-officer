import { EventEmitter } from "node:events";
import type { AppendTrajectoryEvent, TrajectoryEvent } from "@ai-test-officer/contracts";
import { trajectoryEventStore, type TrajectoryEventStore } from "./trajectoryEventStore.js";

export type TrajectoryListener = (event: TrajectoryEvent) => void;

export class TrajectoryEmitter {
  private readonly events = new EventEmitter();
  private readonly emitted = new Set<string>();
  private readonly runRoots = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: TrajectoryEventStore) {
    this.events.setMaxListeners(512);
  }

  async emit(input: AppendTrajectoryEvent) {
    // LLM chunks are produced synchronously but persisted asynchronously. A
    // per-Run queue preserves source order even when the backing store uses a
    // connection pool (Postgres) and several writes are in flight together.
    const previous = this.queues.get(input.runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.emitOne(input));
    this.queues.set(input.runId, next);
    return next.finally(() => {
      if (this.queues.get(input.runId) === next) this.queues.delete(input.runId);
    });
  }

  private async emitOne(input: AppendTrajectoryEvent) {
    const payload = input.payload ?? {};
    const parentRunId = input.parentRunId ?? (typeof payload.parentRunId === "string" ? payload.parentRunId : undefined);
    const rootRunId = input.rootRunId
      ?? (typeof payload.rootRunId === "string" ? payload.rootRunId : undefined)
      ?? (parentRunId ? this.runRoots.get(parentRunId) ?? parentRunId : this.runRoots.get(input.runId) ?? input.runId);
    this.runRoots.set(input.runId, rootRunId);
    const normalized: AppendTrajectoryEvent = {
      ...input,
      parentRunId,
      rootRunId,
      turnId: input.turnId ?? (typeof payload.turnId === "string" ? payload.turnId : undefined),
      stepId: input.stepId ?? (typeof payload.stepId === "string" ? payload.stepId : undefined),
      attemptId: input.attemptId ?? (typeof payload.attemptId === "string" ? payload.attemptId : undefined),
      traceId: input.traceId ?? (typeof payload.traceId === "string" ? payload.traceId : undefined),
      spanId: input.spanId ?? (typeof payload.spanId === "string" ? payload.spanId : undefined),
      parentSpanId: input.parentSpanId ?? (typeof payload.parentSpanId === "string" ? payload.parentSpanId : undefined)
    };
    const event = await this.store.append(normalized);
    const key = `${event.runId}:${event.idempotencyKey}`;
    if (!this.emitted.has(key)) {
      this.emitted.add(key);
      this.events.emit(input.runId, event);
    }
    return event;
  }

  subscribe(runId: string, listener: TrajectoryListener) {
    this.events.on(runId, listener);
    return () => this.events.off(runId, listener);
  }

  read(runId: string, options?: Parameters<TrajectoryEventStore["read"]>[1]) {
    return this.store.read(runId, options);
  }

  latestSeq(runId: string) {
    return this.store.latestSeq(runId);
  }

  readTree(rootRunId: string, options?: Parameters<TrajectoryEventStore["readTree"]>[1]) {
    return this.store.readTree(rootRunId, options);
  }

  latestRootSeq(rootRunId: string) {
    return this.store.latestRootSeq(rootRunId);
  }
}

export const trajectoryEmitter = new TrajectoryEmitter(trajectoryEventStore);

/** Best-effort lifecycle emission: telemetry must never break the test run. */
export function emitTrajectory(input: AppendTrajectoryEvent) {
  return trajectoryEmitter.emit(input).catch(() => undefined);
}
