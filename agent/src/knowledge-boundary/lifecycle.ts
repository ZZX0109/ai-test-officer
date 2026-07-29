import { EventEmitter } from "node:events";

export interface KnowledgeLifecycleEvent {
  runId?: string;
  type:
    | "knowledge.context.created"
    | "knowledge.claim.verified"
    | "knowledge.claim.expired"
    | "knowledge.claim.rejected"
    | "knowledge.conflict.created"
    | "knowledge.conflict.resolved"
    | "knowledge.tool.started"
    | "knowledge.tool.completed"
    | "knowledge.tool.failed"
    | "knowledge.action.authorized"
    | "knowledge.action.denied";
  createdAt: string;
  payload: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function publishKnowledgeLifecycle(event: Omit<KnowledgeLifecycleEvent, "createdAt">) {
  emitter.emit("event", { ...event, createdAt: new Date().toISOString() } satisfies KnowledgeLifecycleEvent);
}

export function subscribeKnowledgeLifecycle(listener: (event: KnowledgeLifecycleEvent) => void) {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
