/**
 * Agent 运维监控表合约
 *
 * Agent 质量指标、测试质量指标、系统质量指标
 */

import { z } from "zod";

// ─── Agent 质量指标 ──────────────────────────────────────────────

export const agentQualityMetricsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  metricId: z.string().min(1),
  period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),
  projectId: z.string().optional(),

  // Planner 指标
  planner: z.object({
    totalRuns: z.number().int().nonnegative(),
    plannerFailureRate: z.number().min(0).max(1),
    plannerTimeoutRate: z.number().min(0).max(1),
    adaptiveFallbackRate: z.number().min(0).max(1),
    planCacheHitRate: z.number().min(0).max(1),
    averagePlanGenerationMs: z.number().int().nonnegative()
  }),

  // Judge 指标
  judge: z.object({
    totalJudgments: z.number().int().nonnegative(),
    judgeDisagreementRate: z.number().min(0).max(1),
    humanOverrideRate: z.number().min(0).max(1),
    falseAcceptRate: z.number().min(0).max(1),
    falseRejectRate: z.number().min(0).max(1),
    averageJudgmentMs: z.number().int().nonnegative()
  }),

  // LLM 调用指标
  llm: z.object({
    totalCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    retryRate: z.number().min(0).max(1),
    timeoutRate: z.number().min(0).max(1),
    knowledgeBoundedRate: z.number().min(0).max(1)
  }),

  generatedAt: z.string().datetime()
});
export type AgentQualityMetrics = z.infer<typeof agentQualityMetricsSchema>;

// ─── 测试质量指标 ────────────────────────────────────────────────

export const testQualityMetricsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  metricId: z.string().min(1),
  period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),
  projectId: z.string().optional(),

  // 准确率指标
  accuracy: z.object({
    totalTests: z.number().int().nonnegative(),
    falsePositiveRate: z.number().min(0).max(1),
    falseNegativeRate: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    f1Score: z.number().min(0).max(1)
  }),

  // 成功率指标
  success: z.object({
    testSuccessRate: z.number().min(0).max(1),
    flakyTestRate: z.number().min(0).max(1),
    environmentFailureRate: z.number().min(0).max(1),
    averageTestDurationMs: z.number().int().nonnegative(),
    firstAttemptPassRate: z.number().min(0).max(1)
  }),

  // 覆盖率指标
  coverage: z.object({
    pathCoverage: z.number().min(0).max(1),
    riskCoverage: z.number().min(0).max(1),
    assertionCoverage: z.number().min(0).max(1),
    evidenceCoverage: z.number().min(0).max(1)
  }),

  generatedAt: z.string().datetime()
});
export type TestQualityMetrics = z.infer<typeof testQualityMetricsSchema>;

// ─── 系统质量指标 ────────────────────────────────────────────────

export const systemQualityMetricsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  metricId: z.string().min(1),
  period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),

  // 浏览器/Playwright 指标
  browser: z.object({
    browserFailureRate: z.number().min(0).max(1),
    browserCrashRate: z.number().min(0).max(1),
    navigationTimeoutRate: z.number().min(0).max(1),
    selectorTimeoutRate: z.number().min(0).max(1),
    averagePageLoadMs: z.number().int().nonnegative(),
    averageActionMs: z.number().int().nonnegative()
  }),

  // 超时指标
  timeout: z.object({
    overallTimeoutRate: z.number().min(0).max(1),
    sandboxPrepareTimeoutRate: z.number().min(0).max(1),
    scenarioTimeoutRate: z.number().min(0).max(1),
    stepTimeoutRate: z.number().min(0).max(1),
    healthCheckTimeoutRate: z.number().min(0).max(1)
  }),

  // 沙盒指标
  sandbox: z.object({
    sandboxFailureRate: z.number().min(0).max(1),
    sandboxStartFailureRate: z.number().min(0).max(1),
    ociImagePullFailureRate: z.number().min(0).max(1),
    resourceExhaustionRate: z.number().min(0).max(1),
    averageSandboxStartMs: z.number().int().nonnegative()
  }),

  // 存储指标
  storage: z.object({
    totalArtifactBytes: z.number().int().nonnegative(),
    totalEvidenceEntries: z.number().int().nonnegative(),
    averageArtifactSizeBytes: z.number().int().nonnegative(),
    retentionPolicyHealth: z.number().min(0).max(1)
  }),

  generatedAt: z.string().datetime()
});
export type SystemQualityMetrics = z.infer<typeof systemQualityMetricsSchema>;

// ─── 综合运维仪表盘 ──────────────────────────────────────────────

export const operationsDashboardSchema = z.object({
  schemaVersion: z.literal("1.0"),
  dashboardId: z.string().min(1),
  period: z.object({
    start: z.string().datetime(),
    end: z.string().datetime()
  }),
  agentQuality: agentQualityMetricsSchema,
  testQuality: testQualityMetricsSchema,
  systemQuality: systemQualityMetricsSchema,
  alerts: z.array(z.object({
    alertId: z.string(),
    severity: z.enum(["critical", "warning", "info"]),
    metric: z.string(),
    threshold: z.number(),
    currentValue: z.number(),
    message: z.string(),
    triggeredAt: z.string().datetime()
  })).default([]),
  generatedAt: z.string().datetime()
});
export type OperationsDashboard = z.infer<typeof operationsDashboardSchema>;
