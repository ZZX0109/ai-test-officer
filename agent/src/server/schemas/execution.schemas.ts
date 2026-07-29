import { z } from "zod";

const confidenceSchema = z.enum(["high", "medium", "low"]);
const evidenceKindSchema = z.enum(["screenshot", "dom", "network", "console", "trace", "video"]);

export const grayPlanSchema = z.object({
  sessionName: z.string(),
  risks: z.array(z.object({
    id: z.string(),
    level: confidenceSchema,
    title: z.string(),
    evidence: z.string(),
    pathIds: z.array(z.string()).optional(),
    coverageDisposition: z.enum(["required", "harness_gap"]).optional()
  })),
  levels: z.array(z.object({
    id: z.enum(["smoke", "core_path", "edge_case", "regression"]),
    title: z.string(),
    description: z.string(),
    paths: z.array(z.object({
      id: z.string(),
      title: z.string(),
      riskReason: z.string(),
      expectedFrom: z.enum(["requirement", "diff", "existing_test", "llm_inferred"]),
      steps: z.array(z.string()),
      retry: z.number().int().nonnegative()
    }))
  }))
});

export const sourceReadEnvelopeSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "git_diff",
    "github_pr",
    "github_pr_diff",
    "github_issue",
    "jira_issue",
    "requirement_doc",
    "tapd_bug",
    "openapi",
    "local_file",
    "manual"
  ]),
  title: z.string(),
  uri: z.string().optional(),
  status: z.enum(["connected", "simulated", "missing"]),
  summary: z.string(),
  failureReason: z.string().optional(),
  permissionState: z.enum(["granted", "not_required", "missing", "denied", "unknown"]),
  isSimulated: z.boolean(),
  evidenceUse: z.enum(["primary_requirement", "change_context", "bug_context", "api_contract", "supplemental", "not_used"]).optional(),
  displayStatus: z.enum(["ready", "needs_auth", "missing", "simulated", "failed"]).optional(),
  plainLanguageSummary: z.string().optional(),
  contentHash: z.string().optional(),
  readAt: z.string(),
  trustLevel: confidenceSchema,
  readMeta: z.object({
    attempts: z.number().int().nonnegative().optional(),
    cacheStatus: z.enum(["hit", "miss", "stale", "bypass"]).optional(),
    httpStatus: z.number().int().optional(),
    finalUrl: z.string().optional(),
    rateLimit: z.object({
      limit: z.number().optional(),
      remaining: z.number().optional(),
      resetAt: z.string().optional(),
      retryAfterMs: z.number().optional()
    }).optional(),
    pagination: z.object({
      pagesRead: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      itemCount: z.number().int().nonnegative().optional()
    }).optional(),
    documentVersion: z.string().optional(),
    openApi: z.object({
      title: z.string().optional(),
      version: z.string().optional(),
      operationCount: z.number().int().nonnegative(),
      operations: z.array(z.object({
        method: z.string(),
        path: z.string(),
        operationId: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional()
      }))
    }).optional()
  }).optional()
});

const impactItemSchema = z.object({
  id: z.string(),
  kind: z.enum(["page", "api", "component", "scenario", "unknown"]),
  target: z.string(),
  reason: z.string(),
  sourceContextIds: z.array(z.string()),
  confidence: confidenceSchema
});

const codeGraphSchema = z.object({
  version: z.literal("1.0"),
  createdAt: z.string(),
  repositoryRoot: z.string(),
  nodes: z.array(z.object({
    id: z.string(),
    kind: z.enum(["file", "symbol", "api-route", "frontend-call", "page", "scenario", "historical-bug"]),
    label: z.string(),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    confidence: confidenceSchema,
    symbolType: z.enum(["function", "class", "interface"]).optional()
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    kind: z.enum(["exports", "serves", "calls", "renders", "covered-by", "regressed-by"]),
    reason: z.string()
  })),
  explanations: z.array(z.string()),
  cacheHits: z.number().int().nonnegative()
});

export const impactAnalysisSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  affectedPages: z.array(impactItemSchema),
  affectedApis: z.array(impactItemSchema),
  affectedComponents: z.array(impactItemSchema),
  recommendedScenarios: z.array(z.object({
    scenarioId: z.string(),
    reason: z.string(),
    confidence: confidenceSchema,
    sourceContextIds: z.array(z.string()),
    priority: z.enum(["critical", "high", "medium", "low"]).optional(),
    score: z.number().optional(),
    riskDrivers: z.array(z.string()).optional()
  })),
  uncoveredRisks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    reason: z.string(),
    requiredCapabilities: z.array(z.string()),
    sourceContextIds: z.array(z.string())
  })),
  codeGraph: codeGraphSchema.optional()
});

const capabilityKindSchema = z.enum([
  "domain_specific",
  "table",
  "complex_form",
  "file_upload",
  "approval_flow",
  "openapi_contract",
  "role_permission_matrix"
]);

const failureClassSchema = z.enum([
  "product_bug",
  "test_script_issue",
  "environment_issue",
  "insufficient_evidence",
  "unknown"
]);

export const executableTestPlanSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  source: z.enum(["scenario_registry", "llm_validated", "fallback", "plan_compiler_v2"]),
  status: z.enum(["valid", "invalid", "needs_harness"]),
  plan: grayPlanSchema,
  steps: z.array(z.object({
    id: z.string(),
    scenarioId: z.string(),
    compileSource: z.enum(["registry", "generic_template", "harness_gap"]),
    humanReviewRequired: z.boolean(),
    draftScenarioRef: z.string().optional(),
    draftReviewStatus: z.enum(["draft", "approved", "rejected"]).optional(),
    selectorProbeStatus: z.enum(["not_run", "passed", "failed"]).optional(),
    capabilityKind: capabilityKindSchema.optional(),
    title: z.string(),
    preconditions: z.array(z.string()),
    browserActions: z.array(z.string()),
    selectorStrategy: z.object({
      priority: z.array(z.enum(["role", "text", "testId", "css"])),
      role: z.string().optional(),
      text: z.string().optional(),
      testId: z.string().optional(),
      css: z.string().optional()
    }),
    assertions: z.array(z.string()),
    evidenceRequirements: z.array(evidenceKindSchema),
    failurePolicy: z.object({
      allowedFailureClasses: z.array(failureClassSchema),
      stopOnFailure: z.boolean()
    }),
    retryPolicy: z.object({
      maxRetries: z.number().int().nonnegative(),
      timeoutMs: z.number().int().positive()
    })
  })),
  rejectedSteps: z.array(z.object({
    title: z.string(),
    reason: z.string(),
    compileSource: z.literal("harness_gap").optional(),
    humanReviewRequired: z.boolean().optional(),
    draftScenarioRef: z.string().optional(),
    draftReviewStatus: z.enum(["draft", "approved", "rejected"]).optional(),
    selectorProbeStatus: z.enum(["not_run", "passed", "failed"]).optional(),
    capabilityKind: capabilityKindSchema.optional()
  }))
});
