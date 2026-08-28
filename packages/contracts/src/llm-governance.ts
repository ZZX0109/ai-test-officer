import { z } from "zod";

export const llmTransportAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(3),
  mode: z.enum(["stream", "non-stream"]),
  status: z.enum(["passed", "failed"]),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  requestId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  bytesReceived: z.number().int().nonnegative().default(0),
  eventTypes: z.array(z.string().min(1)).max(64).default([])
});
export type LlmTransportAttempt = z.infer<typeof llmTransportAttemptSchema>;

export const llmSemanticRepairAttemptSchema = z.object({
  attempt: z.number().int().min(1).max(1),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  status: z.enum(["passed", "failed"]),
  validationErrors: z.array(z.string().min(1)).max(50).default([])
});
export type LlmSemanticRepairAttempt = z.infer<typeof llmSemanticRepairAttemptSchema>;

/** Provider-neutral native function/tool calls returned by an LLM. */
export const llmToolCallSchema = z.object({
  callId: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string().max(100_000),
  index: z.number().int().nonnegative().optional()
}).strict();
export type LlmToolCall = z.infer<typeof llmToolCallSchema>;

export const llmCallSchema = z.object({
  schemaVersion: z.literal("2.0").default("2.0"),
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  experimentId: z.string().min(1).optional(),
  purpose: z.enum(["planning", "browser-action", "judging", "triage", "repairing", "assistant"]),
  budgetScopeId: z.string().min(1).max(300).optional(),
  provider: z.enum(["openai-compatible", "openai", "anthropic", "openrouter", "custom"]),
  model: z.string().min(1),
  requestedModel: z.string().min(1).optional(),
  returnedModel: z.string().min(1).optional(),
  modelProfileId: z.string().min(1).optional(),
  langChainAdapterVersion: z.string().min(1).optional(),
  providerAdapterVersion: z.string().min(1).optional(),
  promptTemplateId: z.string().min(1).optional(),
  promptVersion: z.string().min(1).optional(),
  promptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  inputSummarySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Truncated (~2 KB) previews of the request prompt, the model response, and
  // any provider-returned reasoning/thinking text. The full messages are not
  // persisted (they can carry large knowledge-boundary source excerpts), but
  // these previews let a human audit "what the model was asked / answered /
  // reasoned" directly in the trajectory — the same visibility DSH's agent
  // turn view provides, scoped to keep the run store bounded.
  inputPreview: z.string().max(2048).optional(),
  outputPreview: z.string().max(2048).optional(),
  reasoningPreview: z.string().max(2048).optional(),
  actionDslVersion: z.string().min(1).optional(),
  outputSchemaVersion: z.string().min(1).optional(),
  graphVersion: z.string().min(1).optional(),
  scenarioRegistrySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  projectDigest: z.string().min(1).optional(),
  routeReason: z.string().min(1).optional(),
  ruleCapable: z.boolean().optional(),
  ruleBypassReason: z.string().min(1).optional(),
  cachePolicy: z.enum(["use", "bypass"]).default("use"),
  cacheHit: z.boolean().default(false),
  sourceCallId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  queuedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime(),
  firstTokenAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative(),
  timing: z.object({
    queueMs: z.number().int().nonnegative().optional(),
    firstTokenMs: z.number().int().nonnegative().optional(),
    generationMs: z.number().int().nonnegative().optional(),
    parseMs: z.number().int().nonnegative().optional(),
    totalMs: z.number().int().nonnegative()
  }).optional(),
  status: z.enum(["passed", "failed", "blocked"]),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    cachedPromptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().nullable().optional(),
    currency: z.string().min(1).default("USD"),
    priceCatalogVersion: z.string().min(1).optional()
  }).default({}),
  errorCode: z.string().min(1).optional(),
  failureClass: z.enum(["transport", "authentication", "authorization", "model-access", "budget", "semantic", "provider", "unknown"]).optional(),
  transportMode: z.enum(["stream", "non-stream", "non-stream-fallback"]).optional(),
  fallbackReason: z.string().min(1).optional(),
  fallbackImpact: z.enum(["none", "plan-source-changed", "recommendation-unavailable", "human-review-required", "path-blocked"]).default("none"),
  finalStatusImpact: z.enum(["none", "advisory-only", "forced-review", "blocked"]).default("none"),
  transportAttempts: z.array(llmTransportAttemptSchema).min(1).max(3).optional(),
  semanticRepairAttempts: z.array(llmSemanticRepairAttemptSchema).max(1).default([]),
  toolCalls: z.array(llmToolCallSchema).max(50).default([]),
  redactedInputSummary: z.string().max(2_000).optional(),
  structuredOutput: z.record(z.unknown()).optional(),
  encryptedOutputRef: z.string().min(1).optional(),
  knowledgeContextId: z.string().min(1).optional(),
  knowledgeDecisionId: z.string().min(1).optional(),
  knowledgeToolExecutionIds: z.array(z.string().min(1)).max(20).default([]),
  boundaryPolicyVersion: z.string().min(1).optional(),
  knowledgeValidationStatus: z.enum(["not-applicable", "pending", "verified", "rejected", "expired"]).default("not-applicable")
});
export type LlmCall = z.infer<typeof llmCallSchema>;
export const llmInvocationSchema = llmCallSchema;
export type LlmInvocation = LlmCall;

export const knowledgeClaimStatusSchema = z.enum([
  "observed",
  "user-provided",
  "retrieved",
  "inferred",
  "assumed",
  "unknown"
]);
export type KnowledgeClaimStatus = z.infer<typeof knowledgeClaimStatusSchema>;

export const knowledgeDomainSchema = z.enum([
  "general",
  "project-static",
  "runtime",
  "user-intent",
  "credential-metadata",
  "external-documentation"
]);
export type KnowledgeDomain = z.infer<typeof knowledgeDomainSchema>;

export const knowledgeClaimSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).max(300).optional(),
  supersedesClaimId: z.string().min(1).optional(),
  statement: z.string().min(1).max(2_000),
  status: knowledgeClaimStatusSchema,
  domain: knowledgeDomainSchema,
  sourceRefs: z.array(z.string().min(1)).max(50).default([]),
  confidence: z.number().min(0).max(1),
  observedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  sensitive: z.boolean().default(false),
  scope: z.object({
    organizationId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    scenarioId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    stepId: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    projectDigest: z.string().min(1).optional(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    lockfileHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    registryHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    filePath: z.string().min(1).optional(),
    fileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).default({})
}).superRefine((claim, ctx) => {
  if (["observed", "user-provided", "retrieved", "inferred"].includes(claim.status) && claim.sourceRefs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceRefs"],
      message: `${claim.status} knowledge requires at least one source reference`
    });
  }
  if (claim.expiresAt && claim.observedAt && Date.parse(claim.expiresAt) <= Date.parse(claim.observedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expiresAt"],
      message: "expiresAt must be later than observedAt"
    });
  }
});
export type KnowledgeClaim = z.infer<typeof knowledgeClaimSchema>;

export const knowledgeUnknownSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1).max(1_000),
  reason: z.string().min(1).max(1_000),
  blocking: z.boolean(),
  resolvableBy: z.enum(["tool", "user", "none"]),
  requestedTool: z.string().min(1).optional()
}).superRefine((item, ctx) => {
  if (item.resolvableBy === "tool" && !item.requestedTool) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestedTool"],
      message: "tool-resolvable unknown requires requestedTool"
    });
  }
  if (item.resolvableBy !== "tool" && item.requestedTool) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requestedTool"],
      message: "requestedTool is only valid for tool-resolvable unknowns"
    });
  }
});
export type KnowledgeUnknown = z.infer<typeof knowledgeUnknownSchema>;

export const llmKnowledgeContextSchema = z.object({
  schemaVersion: z.enum(["1.0", "2.0"]).default("2.0"),
  id: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  purpose: z.enum(["planning", "browser-action", "judging", "triage", "repairing", "assistant"]),
  projectSnapshot: z.object({
    projectId: z.string().min(1),
    commitSha: z.string().min(1).optional(),
    projectDigest: z.string().min(1).optional(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    registrySha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).optional(),
  claims: z.array(knowledgeClaimSchema).max(200).default([]),
  allowedCapabilities: z.array(z.string().min(1)).max(100).default([]),
  allowedTools: z.array(z.string().min(1)).max(100).default([]),
  unknowns: z.array(knowledgeUnknownSchema).max(100).default([]),
  untrustedInputKinds: z.array(z.enum([
    "requirement",
    "diff",
    "source",
    "dom",
    "console",
    "network",
    "external-document",
    "prior-model-output"
  ])).default([]),
  generatedAt: z.string().datetime()
}).superRefine((context, ctx) => {
  const claimIds = new Set<string>();
  for (const [index, claim] of context.claims.entries()) {
    if (claimIds.has(claim.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims", index, "id"],
        message: `duplicate knowledge claim id: ${claim.id}`
      });
    }
    claimIds.add(claim.id);
  }
  const unknownIds = new Set<string>();
  for (const [index, item] of context.unknowns.entries()) {
    if (unknownIds.has(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unknowns", index, "id"],
        message: `duplicate knowledge unknown id: ${item.id}`
      });
    }
    unknownIds.add(item.id);
  }
});
export type LlmKnowledgeContext = z.infer<typeof llmKnowledgeContextSchema>;

export const knowledgeToolRequestSchema = z.object({
  tool: z.string().min(1),
  input: z.record(z.unknown()).default({}),
  reason: z.string().min(1).max(1_000),
  sourceClaimIds: z.array(z.string().min(1)).max(20).default([])
}).strict();
export type KnowledgeToolRequest = z.infer<typeof knowledgeToolRequestSchema>;

export const knowledgeProposedActionSchema = z.object({
  capability: z.string().min(1),
  reason: z.string().min(1).max(1_000),
  sourceClaimIds: z.array(z.string().min(1)).max(20).default([]),
  requiresConfirmation: z.boolean().default(false)
}).strict();
export type KnowledgeProposedAction = z.infer<typeof knowledgeProposedActionSchema>;

export const knowledgeBoundaryOutputV1Schema = z.object({
  factsUsed: z.array(z.string().min(1)).max(50).default([]),
  inferences: z.array(z.object({
    statement: z.string().min(1).max(1_000),
    sourceClaimIds: z.array(z.string().min(1)).min(1).max(20)
  }).strict()).max(20).default([]),
  assumptions: z.array(z.object({
    statement: z.string().min(1).max(1_000),
    risk: z.enum(["low", "medium", "high"])
  }).strict()).max(20).default([]),
  unknowns: z.array(z.string().min(1)).max(50).default([]),
  requestedTools: z.array(z.string().min(1)).max(20).default([]),
  blockingQuestions: z.array(z.string().min(1).max(1_000)).max(10).default([])
}).strict();
export type KnowledgeBoundaryOutputV1 = z.infer<typeof knowledgeBoundaryOutputV1Schema>;

export const knowledgeBoundaryOutputSchema = z.object({
  schemaVersion: z.literal("2.0").default("2.0"),
  factsUsed: z.array(z.string().min(1)).max(50).default([]),
  inferences: z.array(z.object({
    statement: z.string().min(1).max(1_000),
    sourceClaimIds: z.array(z.string().min(1)).min(1).max(20)
  }).strict()).max(20).default([]),
  assumptions: z.array(z.object({
    statement: z.string().min(1).max(1_000),
    risk: z.enum(["low", "medium", "high"])
  }).strict()).max(20).default([]),
  unknowns: z.array(z.string().min(1)).max(50).default([]),
  toolRequests: z.array(knowledgeToolRequestSchema).max(20).default([]),
  blockingQuestions: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  proposedActions: z.array(knowledgeProposedActionSchema).max(20).default([])
}).strict();
export type KnowledgeBoundaryOutput = z.infer<typeof knowledgeBoundaryOutputSchema>;

export function normalizeKnowledgeBoundaryOutput(value: unknown): KnowledgeBoundaryOutput {
  const current = knowledgeBoundaryOutputSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = knowledgeBoundaryOutputV1Schema.parse(value);
  return knowledgeBoundaryOutputSchema.parse({
    schemaVersion: "2.0",
    factsUsed: legacy.factsUsed,
    inferences: legacy.inferences,
    assumptions: legacy.assumptions,
    unknowns: legacy.unknowns,
    toolRequests: legacy.requestedTools.map((tool) => ({
      tool,
      input: {},
      reason: "Migrated from knowledge boundary v1.",
      sourceClaimIds: legacy.factsUsed
    })),
    blockingQuestions: legacy.blockingQuestions,
    proposedActions: []
  });
}

export const knowledgeDecisionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  invocationId: z.string().min(1).optional(),
  output: knowledgeBoundaryOutputSchema,
  validationStatus: z.enum(["pending", "verified", "rejected", "expired"]),
  validationErrors: z.array(z.string().min(1)).max(100).default([]),
  toolExecutionIds: z.array(z.string().min(1)).max(20).default([]),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  policyVersion: z.string().min(1),
  createdAt: z.string().datetime()
});
export type KnowledgeDecision = z.infer<typeof knowledgeDecisionSchema>;

export const knowledgeConflictSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  domain: z.enum(["actual-state", "expected-behavior"]),
  claimIds: z.array(z.string().min(1)).min(2).max(20),
  status: z.enum(["open", "resolved", "superseded"]),
  resolution: z.object({
    winningClaimId: z.string().min(1),
    reason: z.string().min(1),
    resolvedBy: z.enum(["policy", "tool", "user"]),
    resolvedAt: z.string().datetime()
  }).optional(),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
});
export type KnowledgeConflict = z.infer<typeof knowledgeConflictSchema>;

export const knowledgeToolExecutionSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  contextId: z.string().min(1),
  request: knowledgeToolRequestSchema,
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["started", "completed", "failed", "denied"]),
  outputClaimIds: z.array(z.string().min(1)).max(100).default([]),
  outputClaims: z.array(knowledgeClaimSchema).max(100).default([]),
  outputSummary: z.string().max(4_000).optional(),
  outputData: z.unknown().optional(),
  errorCode: z.string().min(1).optional(),
  permissionEventId: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
});
export type KnowledgeToolExecution = z.infer<typeof knowledgeToolExecutionSchema>;

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().max(8_000),
  reasoningSummary: z.object({
    phase: z.enum(["observing", "diagnosing", "planning", "waiting-user", "acting", "completed"]),
    observations: z.array(z.string().min(1).max(500)).max(6).default([]),
    assessment: z.string().min(1).max(1_200),
    nextStep: z.string().min(1).max(800),
    userAction: z.string().min(1).max(800),
    confidence: z.enum(["high", "medium", "low"])
  }).optional(),
  knowledgeContextId: z.string().min(1).optional(),
  knowledgeDecisionId: z.string().min(1).optional(),
  llmCallId: z.string().min(1).optional(),
  suggestedAction: z.string().min(1).optional(),
  requiresConfirmation: z.boolean().optional(),
  // The repair plan is only useful if it is *bindable*: the panel needs the
  // plan/attempt/scenario it refers to, its lifecycle status, the evidence it
  // was derived from, and the single action the user may press.
  repairPlan: z.object({
    owner: z.string(),
    problem: z.string().optional(),
    type: z.string().optional(),
    executable: z.boolean().optional(),
    steps: z.array(z.string()),
    validation: z.string(),
    message: z.string().optional(),
    planId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    scenarioId: z.string().min(1).optional(),
    status: z.enum(["pending", "applied", "resolved", "dismissed"]).optional(),
    evidenceRefs: z.array(z.string().min(1)).optional(),
    policyVersion: z.string().min(1).optional(),
    action: z.string().min(1).optional()
  }).optional(),
  createdAt: z.string().datetime()
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const modelPriceCatalogSchema = z.object({
  schemaVersion: z.literal("1.0"),
  version: z.string().min(1),
  currency: z.string().min(1).default("USD"),
  effectiveAt: z.string().datetime(),
  entries: z.array(z.object({
    provider: z.string().min(1),
    modelPattern: z.string().min(1),
    inputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative()
  }))
});
export type ModelPriceCatalog = z.infer<typeof modelPriceCatalogSchema>;

export const planProvenanceSchema = z.object({
  source: z.enum(["deterministic", "llm", "cached-llm", "adaptive-rule-fallback", "dynamic-browser-agent"]),
  promptVersion: z.string().min(1),
  modelProfileId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  llmCallId: z.string().min(1).optional(),
  compilationStatus: z.enum(["validated", "rejected"]),
  fallbackReason: z.string().min(1).optional(),
  cacheKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  originLlmCallId: z.string().min(1).optional()
}).superRefine((value, context) => {
  if (value.source === "llm" && value.compilationStatus === "validated" && (!value.model || !value.llmCallId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "LLM plan provenance requires model and llmCallId." });
  }
  if (value.source === "cached-llm" && value.compilationStatus === "validated" && (!value.model || !value.cacheKey || !value.originLlmCallId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Cached LLM provenance requires model, cacheKey, and originLlmCallId." });
  }
  if (value.compilationStatus === "validated" && value.fallbackReason && value.source !== "adaptive-rule-fallback") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fallbackReason"], message: "LLM plans cannot silently fall back." });
  }
  if (value.source === "adaptive-rule-fallback" && (value.compilationStatus !== "validated" || !value.fallbackReason)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Adaptive rule fallback must be validated and retain its LLM failure reason." });
  }
  if (value.compilationStatus === "rejected" && !value.fallbackReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fallbackReason"], message: "Rejected plans require a failure reason." });
  }
});
export type PlanProvenance = z.infer<typeof planProvenanceSchema>;
