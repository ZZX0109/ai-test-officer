/**
 * Agent Memory 合约
 *
 * Project Memory：项目技术栈、路由结构、测试路径、登录方式、常见依赖问题
 * Experience Memory：历史失败类型、原因分析、修复方案、成功率、embedding 检索索引
 */

import { z } from "zod";

// ─── Project Memory ──────────────────────────────────────────────

export const projectMemoryEntrySchema = z.object({
  schemaVersion: z.literal("1.0"),
  entryId: z.string().min(1),
  projectId: z.string().min(1),
  category: z.enum([
    "tech_stack",
    "routing",
    "test_path",
    "login_method",
    "dependency_issue",
    "startup_config",
    "framework_pattern"
  ]),
  key: z.string().min(1),
  value: z.record(z.unknown()),
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().optional(),
  verified: z.boolean().default(false),
  verifiedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ProjectMemoryEntry = z.infer<typeof projectMemoryEntrySchema>;

export const projectMemoryQuerySchema = z.object({
  projectId: z.string().min(1),
  category: projectMemoryEntrySchema.shape.category.optional(),
  keys: z.array(z.string()).optional(),
  includeUnverified: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50)
});
export type ProjectMemoryQuery = z.infer<typeof projectMemoryQuerySchema>;

// ─── Experience Memory ───────────────────────────────────────────

export const experienceMemoryEntrySchema = z.object({
  schemaVersion: z.literal("1.0"),
  entryId: z.string().min(1),
  failureType: z.enum([
    "selector_not_found",
    "timeout",
    "assertion_failed",
    "network_error",
    "page_crash",
    "auth_failure",
    "data_mismatch",
    "environment_issue",
    "flaky_test",
    "other"
  ]),
  projectId: z.string().min(1),
  scenarioId: z.string().optional(),
  runId: z.string().min(1),

  // 原因分析
  rootCauseCategory: z.string().min(1),
  rootCauseDescription: z.string().max(2_000),
  contributingFactors: z.array(z.string()).max(10),

  // 修复方案
  repairStrategy: z.enum([
    "selector_fix",
    "wait_strategy",
    "data_setup",
    "auth_fix",
    "config_change",
    "code_patch",
    "skip_and_report",
    "other"
  ]),
  repairDescription: z.string().max(2_000),
  repairSessionId: z.string().optional(),

  // 验证结果
  validationResult: z.enum(["passed", "failed", "partial", "pending"]),
  validationRunId: z.string().optional(),
  validatedAt: z.string().datetime().optional(),

  // 成功率统计
  successCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  lastTestedAt: z.string().datetime().optional(),

  // Embedding 检索
  embeddingVector: z.array(z.number()).optional(),
  embeddingModel: z.string().optional(),
  embeddingText: z.string().max(2_000).optional(),

  // 元数据
  tags: z.array(z.string()).max(20).default([]),
  severity: z.enum(["critical", "major", "minor", "info"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ExperienceMemoryEntry = z.infer<typeof experienceMemoryEntrySchema>;

export const experienceMemoryQuerySchema = z.object({
  projectId: z.string().optional(),
  failureType: z.array(experienceMemoryEntrySchema.shape.failureType).optional(),
  rootCauseCategory: z.array(z.string()).optional(),
  repairStrategy: z.array(experienceMemoryEntrySchema.shape.repairStrategy).optional(),
  validationResult: z.array(experienceMemoryEntrySchema.shape.validationResult).optional(),
  tags: z.array(z.string()).optional(),
  severity: z.array(experienceMemoryEntrySchema.shape.severity).optional(),

  // Embedding 语义检索
  semanticQuery: z.string().max(500).optional(),
  semanticLimit: z.number().int().min(1).max(20).default(10),
  semanticThreshold: z.number().min(0).max(1).default(0.6),

  includeUnvalidated: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0)
});
export type ExperienceMemoryQuery = z.infer<typeof experienceMemoryQuerySchema>;

// ─── 成功率统计 ──────────────────────────────────────────────────

export const memoryStatisticsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().min(1),
  totalEntries: z.number().int().nonnegative(),
  byFailureType: z.record(z.string(), z.number()),
  byRepairStrategy: z.record(z.string(), z.number()),
  overallSuccessRate: z.number().min(0).max(1),
  strategySuccessRates: z.record(z.string(), z.number()),
  mostEffectiveStrategies: z.array(z.object({
    strategy: z.string(),
    successRate: z.number(),
    sampleSize: z.number()
  })).max(10),
  generatedAt: z.string().datetime()
});
export type MemoryStatistics = z.infer<typeof memoryStatisticsSchema>;
