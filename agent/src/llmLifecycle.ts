import { EventEmitter } from "node:events";
import { emitTrajectory } from "./trajectoryEmitter.js";

export type LlmLifecycleEventName =
  | "llm.call.started"
  | "llm.call.retried"
  | "llm.call.completed"
  | "llm.call.failed";

export interface LlmLifecycleEvent {
  name: LlmLifecycleEventName;
  runId: string;
  callId: string;
  at: string;
  payload: Record<string, unknown>;
}

const bus = new EventEmitter();
const allBus = new EventEmitter();
bus.setMaxListeners(256);
allBus.setMaxListeners(512);

export function publishLlmLifecycle(event: LlmLifecycleEvent) {
  bus.emit(event.runId, event);
  allBus.emit("event", event);
  const call = event.payload.call && typeof event.payload.call === "object"
    ? event.payload.call as Record<string, unknown>
    : undefined;
  const status = event.name.endsWith("started") || event.name.endsWith("retried")
    ? "running" as const
    : event.name.endsWith("completed") ? "success" as const : "error" as const;
  const rawUsage = call?.usage && typeof call.usage === "object" ? call.usage as Record<string, unknown> : undefined;
  const usage = rawUsage
    ? {
      inputTokens: typeof rawUsage.promptTokens === "number" ? rawUsage.promptTokens : undefined,
      outputTokens: typeof rawUsage.completionTokens === "number" ? rawUsage.completionTokens : undefined,
      reasoningTokens: typeof rawUsage.reasoningTokens === "number" ? rawUsage.reasoningTokens : undefined,
      cacheReadTokens: typeof rawUsage.cachedPromptTokens === "number" ? rawUsage.cachedPromptTokens : undefined
    }
    : undefined;
  const timing = call ? {
    ...(typeof call.startedAt === "string" ? { startedAt: call.startedAt } : {}),
    ...(typeof call.firstTokenAt === "string" ? { firstTokenAt: call.firstTokenAt } : {}),
    ...(typeof call.completedAt === "string" ? { completedAt: call.completedAt } : {})
  } : undefined;
  void emitTrajectory({
    runId: event.runId,
    type: event.name,
    actor: "llm-provider",
    status,
    ...(usage && Object.values(usage).some((value) => value !== undefined) ? { usage } : {}),
    ...(timing && Object.keys(timing).length ? { timing } : {}),
    idempotencyKey: `llm:${event.callId}:${event.name}:${event.at}`,
    payload: { callId: event.callId, at: event.at, ...event.payload }
  });
}

export function subscribeAllLlmLifecycle(listener: (event: LlmLifecycleEvent) => void) {
  allBus.on("event", listener);
  return () => allBus.off("event", listener);
}

export function subscribeLlmLifecycle(
  runId: string,
  listener: (event: LlmLifecycleEvent) => void
) {
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}
