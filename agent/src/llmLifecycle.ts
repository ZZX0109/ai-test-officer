import { EventEmitter } from "node:events";

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
bus.setMaxListeners(256);

export function publishLlmLifecycle(event: LlmLifecycleEvent) {
  bus.emit(event.runId, event);
}

export function subscribeLlmLifecycle(
  runId: string,
  listener: (event: LlmLifecycleEvent) => void
) {
  bus.on(runId, listener);
  return () => bus.off(runId, listener);
}
