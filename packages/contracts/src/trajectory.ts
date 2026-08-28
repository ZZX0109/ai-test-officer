import { z } from "zod";

/**
 * The durable, append-only event vocabulary used by the Workbench trajectory.
 * The payload is intentionally extensible, while the envelope remains stable
 * enough for storage, replay, pagination and audit tooling.
 */
export const trajectoryEventTypeSchema = z.enum([
  "run.created",
  "run.linked",
  "run.started",
  "run.state.changed",
  "run.completed",
  "run.failed",
  "run.blocked",
  "turn.started",
  "turn.completed",
  "step.started",
  "step.completed",
  "step.failed",
  "user.message",
  "request.header",
  "assistant.chunk",
  "assistant.message",
  "compaction.started",
  "compaction.summary",
  "compaction.completed",
  "planning.started",
  "planning.updated",
  "planning.completed",
  "llm.call.started",
  "llm.call.retried",
  "llm.call.completed",
  "llm.call.failed",
  "llm.request",
  "llm.chunk",
  "llm.response",
  "llm.retry",
  "retrieval.query",
  "retrieval.result",
  "rerank.result",
  "tool.call",
  "tool.result",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "browser.session.started",
  "browser.observation.created",
  "browser.action.proposed",
  "browser.action.authorized",
  "browser.action.started",
  "browser.action.completed",
  "browser.action.failed",
  "assertion.evaluated",
  "evidence.created",
  "artifact.committed",
  "artifact.created",
  "state.patch",
  "router.decision",
  "gate.result",
  "judge.result",
  "approval.requested",
  "approval.resolved",
  "proof.linked",
  "proof.verified",
  "proof.invalid",
  "repair.started",
  "repair.completed",
  "repair.failed",
  "recovery.started",
  "recovery.completed",
  "recovery.failed",
  "human.review.requested"
]);
export type TrajectoryEventType = z.infer<typeof trajectoryEventTypeSchema>;

export const trajectoryStatusSchema = z.enum(["running", "success", "error", "blocked"]);
export type TrajectoryStatus = z.infer<typeof trajectoryStatusSchema>;

export const trajectoryUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  reasoningTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional()
}).strict();
export type TrajectoryUsage = z.infer<typeof trajectoryUsageSchema>;

export const trajectoryTimingSchema = z.object({
  startedAt: z.string().datetime().optional(),
  firstTokenAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional()
}).strict();
export type TrajectoryTiming = z.infer<typeof trajectoryTimingSchema>;

export const trajectoryEventSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  rootRunId: z.string().min(1).optional(),
  seq: z.number().int().positive(),
  runSeq: z.number().int().positive().optional(),
  rootSeq: z.number().int().positive().optional(),
  type: trajectoryEventTypeSchema,
  at: z.string().datetime(),
  actor: z.string().min(1),
  turnId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  parentEventId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  status: trajectoryStatusSchema.optional(),
  usage: trajectoryUsageSchema.optional(),
  timing: trajectoryTimingSchema.optional(),
  visibility: z.enum(["user", "developer", "admin"]).default("user"),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  evidenceRefs: z.array(z.string().min(1)).default([])
});
export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

export const appendTrajectoryEventSchema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  rootRunId: z.string().min(1).optional(),
  rootSeq: z.number().int().positive().optional(),
  type: trajectoryEventTypeSchema,
  actor: z.string().min(1),
  turnId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  parentEventId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  status: trajectoryStatusSchema.optional(),
  usage: trajectoryUsageSchema.optional(),
  timing: trajectoryTimingSchema.optional(),
  visibility: z.enum(["user", "developer", "admin"]).default("user"),
  idempotencyKey: z.string().min(1),
  at: z.string().datetime().optional(),
  payload: z.record(z.unknown()).default({}),
  evidenceRefs: z.array(z.string().min(1)).default([])
});
export type AppendTrajectoryEvent = z.input<typeof appendTrajectoryEventSchema>;

export const trajectoryToolNodeSchema = z.object({
  callId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["started", "completed", "failed", "interrupted"]),
  parentCallId: z.string().min(1).optional(),
  depth: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  eventSeqs: z.array(z.number().int().positive()).default([])
});
export type TrajectoryToolNode = z.infer<typeof trajectoryToolNodeSchema>;

export const trajectorySummarySchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  llmCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  browserActions: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative().optional()
});
export type TrajectorySummary = z.infer<typeof trajectorySummarySchema>;

const trajectoryRequestSchema = z.object({
  eventSeq: z.number().int().positive(),
  callId: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.unknown()).optional()
}).passthrough();

const trajectoryPartialSchema = z.object({
  text: z.string().default(""),
  reasoning: z.string().default(""),
  lastSeq: z.number().int().nonnegative()
}).strict();

export const trajectoryViewModelSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  rootRunId: z.string().min(1).optional(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  events: z.array(trajectoryEventSchema),
  tools: z.array(trajectoryToolNodeSchema),
  eventLocations: z.record(z.object({ turnId: z.string().optional(), stepId: z.string().optional(), attemptId: z.string().optional() }).strict()).default({}),
  requests: z.array(trajectoryRequestSchema).default([]),
  callSchemas: z.array(z.object({ eventSeq: z.number().int().positive(), callId: z.string().optional(), toolName: z.string().optional(), schema: z.unknown() }).passthrough()).default([]),
  partial: trajectoryPartialSchema.optional(),
  runningCalls: z.array(trajectoryToolNodeSchema).default([]),
  warnings: z.array(z.string().min(1)).default([]),
  summary: trajectorySummarySchema,
  replayable: z.boolean()
});
export type TrajectoryViewModel = z.infer<typeof trajectoryViewModelSchema>;
