/**
 * Experience Feedback Loop 合约
 *
 * Failure → 原因分析 → 修复方案 → 验证结果 → 写入 Experience Memory → 下一次测试调用
 */

import { z } from "zod";
import { experienceMemoryEntrySchema } from "./agent-memory.js";

// ─── 反馈循环阶段 ────────────────────────────────────────────────

export const feedbackStageSchema = z.enum([
  "failure_detected",
  "root_cause_analyzing",
  "root_cause_analyzed",
  "repair_proposed",
  "repair_validating",
  "repair_validated",
  "memory_written",
  "feedback_closed"
]);
export type FeedbackStage = z.infer<typeof feedbackStageSchema>;

// ─── 失败检测 ────────────────────────────────────────────────────

export const failureDetectionSchema = z.object({
  detectionId: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().optional(),
  stepId: z.string().optional(),
  failureType: experienceMemoryEntrySchema.shape.failureType,
  title: z.string().max(300),
  description: z.string().max(2_000),
  severity: z.enum(["critical", "major", "minor", "info"]),
  detectedAt: z.string().datetime(),
  artifactRefs: z.array(z.string()).max(20),
  traceId: z.string().optional()
});
export type FailureDetection = z.infer<typeof failureDetectionSchema>;

// ─── 原因分析 ────────────────────────────────────────────────────

export const rootCauseAnalysisSchema = z.object({
  analysisId: z.string().min(1),
  detectionId: z.string().min(1),
  analyzer: z.enum(["llm", "pattern_match", "experience_match", "human", "hybrid"]),
  rootCauseCategory: z.string().min(1),
  rootCauseDescription: z.string().max(3_000),
  contributingFactors: z.array(z.object({
    factor: z.string(),
    weight: z.number().min(0).max(1),
    evidence: z.string().max(1_000).optional()
  })).max(10),
  confidence: z.number().min(0).max(1),
  alternativeHypotheses: z.array(z.object({
    hypothesis: z.string().max(500),
    confidence: z.number().min(0).max(1)
  })).max(5),
  analyzedAt: z.string().datetime(),
  llmCallId: z.string().optional()
});
export type RootCauseAnalysis = z.infer<typeof rootCauseAnalysisSchema>;

// ─── 修复方案 ────────────────────────────────────────────────────

export const repairProposalSchema = z.object({
  proposalId: z.string().min(1),
  analysisId: z.string().min(1),
  strategy: experienceMemoryEntrySchema.shape.repairStrategy,
  description: z.string().max(3_000),
  filesToChange: z.array(z.object({
    filePath: z.string(),
    changeType: z.enum(["modify", "create", "delete"]),
    description: z.string().max(500)
  })).max(20),
  estimatedSuccessRate: z.number().min(0).max(1),
  riskAssessment: z.object({
    breakingChangeRisk: z.number().min(0).max(1),
    sideEffectRisk: z.number().min(0).max(1),
    reversible: z.boolean()
  }),
  repairSessionId: z.string().optional(),
  proposedAt: z.string().datetime(),
  llmCallId: z.string().optional(),
  similarExperiences: z.array(z.object({
    entryId: z.string(),
    successRate: z.number(),
    matchReason: z.string()
  })).max(5).default([])
});
export type RepairProposal = z.infer<typeof repairProposalSchema>;

// ─── 验证结果 ────────────────────────────────────────────────────

export const repairValidationSchema = z.object({
  validationId: z.string().min(1),
  proposalId: z.string().min(1),
  validationRunId: z.string(),
  result: z.enum(["passed", "failed", "partial"]),
  beforeState: z.object({
    failureRate: z.number().min(0).max(1),
    assertionPassRate: z.number().min(0).max(1)
  }).optional(),
  afterState: z.object({
    failureRate: z.number().min(0).max(1),
    assertionPassRate: z.number().min(0).max(1)
  }),
  delta: z.object({
    improvement: z.number(),
    regressionCount: z.number().int().nonnegative()
  }),
  evidence: z.array(z.object({
    assertionId: z.string(),
    passed: z.boolean(),
    before: z.boolean().optional(),
    comment: z.string().max(500).optional()
  })).max(100),
  validatedAt: z.string().datetime()
});
export type RepairValidation = z.infer<typeof repairValidationSchema>;

// ─── 反馈闭环 ────────────────────────────────────────────────────

export const feedbackLoopSessionSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  stage: feedbackStageSchema,
  detection: failureDetectionSchema.optional(),
  analysis: rootCauseAnalysisSchema.optional(),
  proposal: repairProposalSchema.optional(),
  validation: repairValidationSchema.optional(),
  memoryEntryId: z.string().optional(),
  closed: z.boolean().default(false),
  closedAt: z.string().datetime().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type FeedbackLoopSession = z.infer<typeof feedbackLoopSessionSchema>;

// ─── 历史检索 ────────────────────────────────────────────────────

export const feedbackHistoryQuerySchema = z.object({
  projectId: z.string().optional(),
  failureType: z.array(z.string()).optional(),
  rootCauseCategory: z.array(z.string()).optional(),
  repairStrategy: z.array(z.string()).optional(),
  validationResult: z.array(z.enum(["passed", "failed", "partial"])).optional(),
  severity: z.array(z.string()).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(50)
});
export type FeedbackHistoryQuery = z.infer<typeof feedbackHistoryQuerySchema>;
