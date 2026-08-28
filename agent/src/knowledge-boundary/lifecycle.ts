import { EventEmitter } from "node:events";
import { emitTrajectory } from "../trajectoryEmitter.js";

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
  const complete = { ...event, createdAt: new Date().toISOString() } satisfies KnowledgeLifecycleEvent;
  emitter.emit("event", complete);
  if (complete.runId && !complete.type.startsWith("knowledge.tool.")) {
    const type = "run.state.changed" as const;
    void emitTrajectory({ runId: complete.runId, type, actor: "knowledge-broker", idempotencyKey: `knowledge:${complete.type}:${complete.createdAt}:${JSON.stringify(complete.payload)}`, payload: complete.payload });
  }
}

export function subscribeKnowledgeLifecycle(listener: (event: KnowledgeLifecycleEvent) => void) {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
