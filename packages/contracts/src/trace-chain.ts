/**
 * Trace Chain 合约
 *
 * User Request → Agent Decision → Tool Call → Execution → Evidence → Final Judgment
 * 完整的 trace 链路，含 trace_id、span_id、actor、timestamp、input_hash、output_hash
 */

import { z } from "zod";

// ─── Trace 核心类型 ──────────────────────────────────────────────

export const traceIdSchema = z.string().regex(/^trace_[a-f0-9]{32}$/);
export type TraceId = z.infer<typeof traceIdSchema>;

export const spanIdSchema = z.string().regex(/^span_[a-f0-9]{32}$/);
export type SpanId = z.infer<typeof spanIdSchema>;

export const traceActorSchema = z.enum([
  "user",
  "planner",
  "discovery",
  "compiler",
  "executor",
  "browser",
  "api-executor",
  "collector",
  "gate",
  "judge",
  "repair",
  "human_reviewer",
  "system"
]);
export type TraceActor = z.infer<typeof traceActorSchema>;

export const traceSpanKindSchema = z.enum([
  "request",
  "decision",
  "tool_call",
  "execution",
  "evidence_collection",
  "judgment",
  "human_interaction",
  "internal"
]);
export type TraceSpanKind = z.infer<typeof traceSpanKindSchema>;

export const traceSpanStatusSchema = z.enum([
  "ok",
  "error",
  "timeout",
  "cancelled",
  "blocked"
]);
export type TraceSpanStatus = z.infer<typeof traceSpanStatusSchema>;

// ─── Span 定义 ───────────────────────────────────────────────────

export const traceSpanSchema = z.object({
  schemaVersion: z.literal("1.0"),
  traceId: traceIdSchema,
  spanId: spanIdSchema,
  parentSpanId: spanIdSchema.optional(),
  kind: traceSpanKindSchema,
  name: z.string().min(1).max(200),
  actor: traceActorSchema,
  status: traceSpanStatusSchema,
  startTimestamp: z.string().datetime(),
  endTimestamp: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),

  // 输入输出哈希（用于溯源和去重）
  inputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),

  // 关联标识
  runId: z.string().min(1),
  projectId: z.string().optional(),
  scenarioId: z.string().optional(),
  attemptId: z.string().optional(),
  stepId: z.string().optional(),

  // 决策元数据
  decision: z.object({
    decisionType: z.string().optional(),
    reasoning: z.string().max(2_000).optional(),
    alternatives: z.array(z.string()).max(5).optional(),
    confidence: z.number().min(0).max(1).optional()
  }).optional(),

  // 工具调用元数据
  toolCall: z.object({
    toolName: z.string().optional(),
    toolVersion: z.string().optional(),
    inputSummary: z.string().max(500).optional(),
    outputSummary: z.string().max(500).optional(),
    retryCount: z.number().int().nonnegative().optional()
  }).optional(),

  // 证据元数据
  evidence: z.object({
    artifactIds: z.array(z.string()).max(50).optional(),
    evidenceType: z.string().optional(),
    integritySha256: z.string().optional()
  }).optional(),

  // 错误信息
  error: z.object({
    code: z.string(),
    message: z.string().max(1_000),
    stack: z.string().max(5_000).optional(),
    recoverable: z.boolean().optional()
  }).optional(),

  // 属性标签
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),

  createdAt: z.string().datetime()
});
export type TraceSpan = z.infer<typeof traceSpanSchema>;

// ─── Trace 完整链路 ──────────────────────────────────────────────

export const traceChainSchema = z.object({
  schemaVersion: z.literal("1.0"),
  traceId: traceIdSchema,
  runId: z.string().min(1),
  projectId: z.string().optional(),

  // 根请求
  rootRequest: z.object({
    actor: z.literal("user"),
    requirement: z.string().max(5_000).optional(),
    diff: z.string().max(5_000).optional(),
    inputs: z.array(z.string()).max(10),
    timestamp: z.string().datetime()
  }),

  // 所有 span
  spans: z.array(traceSpanSchema).max(500),

  // 统计
  statistics: z.object({
    totalSpans: z.number().int().nonnegative(),
    okSpans: z.number().int().nonnegative(),
    errorSpans: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    actorBreakdown: z.record(z.string(), z.number())
  }),

  // 关键路径
  criticalPath: z.array(z.object({
    spanId: spanIdSchema,
    name: z.string(),
    durationMs: z.number(),
    status: traceSpanStatusSchema
  })).max(20),

  generatedAt: z.string().datetime()
});
export type TraceChain = z.infer<typeof traceChainSchema>;

// ─── 查询接口 ────────────────────────────────────────────────────

export const traceQuerySchema = z.object({
  runId: z.string().optional(),
  projectId: z.string().optional(),
  actor: traceActorSchema.optional(),
  kind: traceSpanKindSchema.optional(),
  status: traceSpanStatusSchema.optional(),
  startAfter: z.string().datetime().optional(),
  startBefore: z.string().datetime().optional(),
  minDurationMs: z.number().int().nonnegative().optional(),
  hasError: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50)
});
export type TraceQuery = z.infer<typeof traceQuerySchema>;
