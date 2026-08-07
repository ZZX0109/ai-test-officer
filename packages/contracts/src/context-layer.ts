/**
 * Agent Context Layer 合约定义
 *
 * LLM 可访问的数据中间层，禁止 LLM 直接访问数据库。
 * 提供受控只读接口，含数据脱敏、权限过滤、上下文摘要。
 */

import { z } from "zod";

// ─── Context Layer 基础类型 ───────────────────────────────────────

export const contextAccessPolicySchema = z.object({
  schemaVersion: z.literal("1.0"),
  policyId: z.string().min(1),
  subject: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1).optional(),
  allowedNamespaces: z.array(z.enum([
    "project_context",
    "run_status",
    "evidence",
    "failure_history",
    "repair_history"
  ])),
  maxContextTokens: z.number().int().positive().default(8_000),
  redactSecrets: z.boolean().default(true),
  redactPII: z.boolean().default(true),
  allowRawPaths: z.boolean().default(false),
  expiresAt: z.string().datetime(),
  issuedAt: z.string().datetime()
});
export type ContextAccessPolicy = z.infer<typeof contextAccessPolicySchema>;

// ─── 1. get_project_context ──────────────────────────────────────

export const projectContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  project: z.object({
    id: z.string(),
    name: z.string(),
    techStack: z.array(z.string()),
    packageManager: z.string(),
    framework: z.string().optional(),
    runtime: z.string().optional()
  }),
  routing: z.object({
    frontendRoutes: z.array(z.object({
      path: z.string(),
      title: z.string().optional(),
      authRequired: z.boolean().default(false)
    })),
    apiEndpoints: z.array(z.object({
      method: z.string(),
      path: z.string(),
      operationId: z.string().optional()
    }))
  }),
  testPaths: z.array(z.object({
    id: z.string(),
    title: z.string(),
    entryUrl: z.string().optional(),
    steps: z.array(z.string()),
    risk: z.enum(["high", "medium", "low"])
  })),
  login: z.object({
    method: z.enum(["none", "form", "storage_state", "env"]),
    requiresCredentials: z.boolean(),
    credentialHints: z.array(z.string()).optional()
  }),
  dependencies: z.object({
    knownIssues: z.array(z.object({
      package: z.string(),
      version: z.string().optional(),
      issue: z.string(),
      resolution: z.string().optional(),
      lastSeen: z.string().optional()
    })),
    commonProblems: z.array(z.object({
      category: z.string(),
      description: z.string(),
      solution: z.string()
    }))
  }),
  summary: z.string().max(2_000),
  generatedAt: z.string().datetime()
});
export type ProjectContext = z.infer<typeof projectContextSchema>;

// ─── 2. get_run_status ───────────────────────────────────────────

export const runStatusContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string(),
  state: z.string(),
  finalStatus: z.enum(["pass", "fail", "blocked", "needs-human-review"]).optional(),
  progress: z.number().min(0).max(1),
  currentNode: z.string().optional(),
  completedNodes: z.array(z.string()),
  elapsedMs: z.number().int().nonnegative(),
  budget: z.object({
    tokensUsed: z.number().int().nonnegative(),
    tokensBudget: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    wallClockBudgetMs: z.number().int().nonnegative(),
    llmCallsUsed: z.number().int().nonnegative(),
    llmCallsBudget: z.number().int().nonnegative()
  }),
  activeInterrupts: z.array(z.object({
    interruptId: z.string(),
    capability: z.string(),
    reason: z.string(),
    requiresConfirmation: z.boolean()
  })),
  recentErrors: z.array(z.object({
    code: z.string(),
    message: z.string().max(500),
    node: z.string().optional(),
    at: z.string().datetime()
  })).max(5),
  summary: z.string().max(1_000),
  generatedAt: z.string().datetime()
});
export type RunStatusContext = z.infer<typeof runStatusContextSchema>;

// ─── 3. get_evidence ─────────────────────────────────────────────

export const evidenceContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string(),
  artifacts: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    origin: z.string(),
    sizeBytes: z.number(),
    capturedAt: z.string(),
    summary: z.string().max(500),
    integritySha256: z.string().optional()
  })).max(20),
  assertions: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    evidenceRefs: z.array(z.string())
  })).max(30),
  machineGate: z.object({
    status: z.string(),
    reasons: z.array(z.string()),
    evidenceComplete: z.boolean()
  }).optional(),
  coverageSummary: z.object({
    executed: z.number(),
    excluded: z.number(),
    blocked: z.number(),
    pending: z.number()
  }).optional(),
  summary: z.string().max(2_000),
  generatedAt: z.string().datetime()
});
export type EvidenceContext = z.infer<typeof evidenceContextSchema>;

// ─── 4. get_failure_history ──────────────────────────────────────

export const failureHistoryContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string(),
  failures: z.array(z.object({
    failureId: z.string(),
    runId: z.string(),
    scenarioId: z.string().optional(),
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
    title: z.string().max(300),
    description: z.string().max(1_000),
    occurredAt: z.string().datetime(),
    resolvedAt: z.string().datetime().optional(),
    resolutionStatus: z.enum(["open", "in_repair", "resolved", "wont_fix", "duplicate"]),
    resolutionSummary: z.string().max(500).optional(),
    rootCauseCategory: z.string().optional(),
    affectedPaths: z.array(z.string()).max(10)
  })).max(50),
  statistics: z.object({
    total: z.number(),
    resolved: z.number(),
    open: z.number(),
    mostFrequentType: z.string().optional(),
    avgResolutionTimeMs: z.number().optional()
  }),
  summary: z.string().max(1_000),
  generatedAt: z.string().datetime()
});
export type FailureHistoryContext = z.infer<typeof failureHistoryContextSchema>;

// ─── 5. get_repair_history ───────────────────────────────────────

export const repairHistoryContextSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string(),
  repairs: z.array(z.object({
    repairSessionId: z.string(),
    runId: z.string(),
    failureId: z.string().optional(),
    repairType: z.enum([
      "selector_fix",
      "wait_strategy",
      "data_setup",
      "auth_fix",
      "config_change",
      "code_patch",
      "other"
    ]),
    description: z.string().max(800),
    filesChanged: z.array(z.string()).max(20),
    validationResult: z.enum(["passed", "failed", "partial", "pending"]),
    applied: z.boolean(),
    createdAt: z.string().datetime(),
    validatedAt: z.string().datetime().optional()
  })).max(30),
  statistics: z.object({
    total: z.number(),
    applied: z.number(),
    successRate: z.number().min(0).max(1),
    mostFrequentRepairType: z.string().optional()
  }),
  summary: z.string().max(1_000),
  generatedAt: z.string().datetime()
});
export type RepairHistoryContext = z.infer<typeof repairHistoryContextSchema>;

// ─── Context Layer 统一输出 ───────────────────────────────────────

export const contextLayerOutputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  policy: contextAccessPolicySchema,
  requestedNamespaces: z.array(z.string()),
  results: z.object({
    project_context: projectContextSchema.optional(),
    run_status: runStatusContextSchema.optional(),
    evidence: evidenceContextSchema.optional(),
    failure_history: failureHistoryContextSchema.optional(),
    repair_history: repairHistoryContextSchema.optional()
  }),
  redactions: z.array(z.object({
    field: z.string(),
    reason: z.string()
  })).max(20),
  tokenEstimate: z.number().int().nonnegative(),
  generatedAt: z.string().datetime()
});
export type ContextLayerOutput = z.infer<typeof contextLayerOutputSchema>;
