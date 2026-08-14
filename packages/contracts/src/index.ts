import { z } from "zod";
import { recoveryActionResultSchema, recoveryDecisionSchema } from "./recovery.js";
import {
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema
} from "./browser-agent.js";

export const gateStatusSchema = z.enum(["pass", "fail", "blocked", "needs-human-review"]);
export type GateStatus = z.infer<typeof gateStatusSchema>;

export function normalizeLegacyGateStatus(value: string): GateStatus {
  if (["pass", "continue", "passed"].includes(value)) return "pass";
  if (["fail", "failed", "stop_and_fix"].includes(value)) return "fail";
  if (["blocked", "environment_blocked"].includes(value)) return "blocked";
  return "needs-human-review";
}

export const artifactOriginSchema = z.enum([
  "runtime-captured",
  "fixture",
  "simulated",
  "user-uploaded",
  "agent-generated",
  "legacy-unverified"
]);
export type ArtifactOrigin = z.infer<typeof artifactOriginSchema>;

export const artifactKindV2Schema = z.enum([
  "screenshot",
  "dom",
  "network",
  "console",
  "trace",
  "video",
  "download",
  "operation-log",
  "report",
  "attachment",
  "source-patch",
  "changed-files-archive",
  "repair-validation-log"
]);

export const artifactIntegrityV2Schema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  capturedAt: z.string().datetime(),
  collector: z.object({ name: z.string().min(1), version: z.string().min(1) })
});

export const evidenceLocatorSchema = z.object({
  pageUrl: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  selector: z.string().optional(),
  testId: z.string().optional(),
  role: z.string().optional(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative()
  }).optional(),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestId: z.string().optional(),
  method: z.string().optional(),
  statusCode: z.number().int().optional(),
  operationId: z.string().optional(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  sourceLocation: z.string().optional(),
  executable: z.string().optional(),
  argsSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  commandConfigSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exitCode: z.number().int().optional(),
  dataSnapshotId: z.string().optional(),
  assertionSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  timeRange: z.object({ from: z.string().datetime(), to: z.string().datetime() }).optional()
}).default({});
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;

export const artifactV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1),
  attempt: z.number().int().positive(),
  kind: artifactKindV2Schema,
  origin: artifactOriginSchema,
  storageUri: z.string().min(1),
  replicaUris: z.array(z.string().min(1)).default([]),
  sequence: z.number().int().nonnegative(),
  monotonicOffsetMs: z.number().nonnegative(),
  integrity: artifactIntegrityV2Schema,
  locator: evidenceLocatorSchema.optional(),
  fixtureManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).superRefine((artifact, context) => {
  if (artifact.origin === "fixture" && !artifact.fixtureManifestSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixtureManifestSha256"], message: "Fixture artifacts require a manifest digest." });
  }
});
export type ArtifactV2 = z.infer<typeof artifactV2Schema>;

export const evidenceV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1),
  attempt: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  artifactIds: z.array(z.string().min(1)),
  summary: z.string().min(1),
  locator: evidenceLocatorSchema.optional(),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});
export type EvidenceV2 = z.infer<typeof evidenceV2Schema>;

export const runStateSchema = z.enum([
  "draft",
  "planning",
  "awaiting-plan-approval",
  "awaiting-permission",
  "queued",
  "preparing",
  "running",
  "paused",
  "collecting",
  "judging",
  "awaiting-human-review",
  "completed",
  "failed",
  "blocked",
  "cancelled"
]);
export type RunState = z.infer<typeof runStateSchema>;

export const runEventTypeSchema = z.enum([
  "run_created",
  "plan_generated",
  "plan_approved",
  "permission_granted",
  "run_queued",
  "run_preparing",
  "run_started",
  // Explicitly returns a judging run to the queue for a new evidence-backed
  // attempt. This is not a state-only UI retry: the worker receives a fresh
  // delivery and the original attempt remains immutable in the run bundle.
  "run_retrying",
  "run_paused",
  "run_resumed",
  "evidence_collecting",
  "run_judging",
  "human_review_requested",
  "decision_overridden",
  "repair_decision_recorded",
  "run_completed",
  "run_failed",
  "run_blocked",
  "run_cancelled"
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  type: runEventTypeSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  actor: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.unknown()).default({})
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const commandSpecSchema = z.object({
  executable: z.string().regex(/^[a-zA-Z0-9._/+:-]+$/),
  args: z.array(z.string().max(4096)).max(128).default([]),
  timeoutMs: z.number().int().positive().max(1_200_000).optional()
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const resourceBudgetSchema = z.object({
  runTimeoutMs: z.number().int().positive().default(1_200_000),
  prepareTimeoutMs: z.number().int().positive().default(300_000),
  scenarioTimeoutMs: z.number().int().positive().default(300_000),
  stepTimeoutMs: z.number().int().positive().default(45_000),
  maxSteps: z.number().int().positive().default(50),
  maxAttempts: z.number().int().min(1).max(2).default(2),
  maxScreenshots: z.number().int().nonnegative().default(100),
  maxVideoBytes: z.number().int().nonnegative().default(500 * 1024 * 1024),
  maxLogBytes: z.number().int().nonnegative().default(50 * 1024 * 1024),
  maxArtifactBytes: z.number().int().nonnegative().default(1024 * 1024 * 1024),
  maxConcurrency: z.number().int().positive().default(2)
});
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
export const defaultResourceBudget: ResourceBudget = resourceBudgetSchema.parse({});

export const projectManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  workspaceRoot: z.string().min(1),
  commands: z.object({
    install: commandSpecSchema.optional(),
    start: commandSpecSchema.optional(),
    targetedTest: commandSpecSchema.optional(),
    relatedTest: commandSpecSchema.optional(),
    test: commandSpecSchema.optional(),
    cleanup: commandSpecSchema.optional()
  }),
  commandAllowlist: z.array(z.string().regex(/^[a-zA-Z0-9._/+:-]+$/)).min(1),
  ports: z.array(z.object({ name: z.string().min(1), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), purpose: z.enum(["frontend", "backend", "health", "auxiliary"]) })).default([]),
  healthCheck: z.object({ path: z.string().startsWith("/"), timeoutMs: z.number().int().positive().default(20_000) }).optional(),
  environmentAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  network: z.object({ mode: z.enum(["deny", "allow-target", "allowlist"]).default("allow-target"), allowedHosts: z.array(z.string()).default([]) }).default({}),
  fixtures: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), destructive: z.boolean().default(false) })).default([]),
  apiOperations: z.array(z.object({
    operationId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    pathTemplate: z.string().startsWith("/"),
    baseUrlRef: z.enum(["frontend", "backend"]).default("backend"),
    allowedStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).default([200]),
    fixtureRef: z.string().min(1).optional(),
    destructive: z.boolean().default(false)
  })).default([]),
  dataSources: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    kind: z.enum(["postgres", "sqlite", "http-snapshot"]),
    connectionEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    readOnly: z.boolean().default(true),
    queryTemplates: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
      statement: z.string().min(1),
      parameterNames: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)).default([]),
      expectation: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("non-empty") }),
        z.object({ kind: z.literal("empty") }),
        z.object({ kind: z.literal("row-count"), value: z.number().int().nonnegative() }),
        z.object({ kind: z.literal("scalar-equals"), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
      ])
    })).default([])
  })).default([]),
  backgroundTasks: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    statusOperationId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    statusField: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]*$/).default("status"),
    terminalStates: z.array(z.string().min(1)).min(1),
    successStates: z.array(z.string().min(1)).min(1),
    pollIntervalMs: z.number().int().min(100).max(30_000).default(1_000),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000)
  })).default([]),
  capabilities: z.object({ browser: z.boolean().default(true), desktop: z.boolean().default(false), allowedBundleIds: z.array(z.string()).default([]) }).default({}),
  execution: z.object({ mode: z.enum(["oci", "trusted-local"]).default("oci"), image: z.string().min(1).optional(), engine: z.enum(["docker", "podman"]).default("docker") }).default({}),
  budget: resourceBudgetSchema.default({})
}).superRefine((manifest, context) => {
  if (manifest.execution.mode === "oci" && !manifest.execution.image) context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "image"], message: "OCI execution requires an immutable image." });
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

const transitions: Record<RunState, Partial<Record<RunEventType, RunState>>> = {
  draft: { run_cancelled: "cancelled" },
  planning: { plan_generated: "awaiting-plan-approval", human_review_requested: "awaiting-human-review", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  "awaiting-plan-approval": {
    plan_approved: "awaiting-permission",
    run_failed: "failed",
    run_blocked: "blocked",
    run_cancelled: "cancelled"
  },
  "awaiting-permission": { permission_granted: "queued", run_cancelled: "cancelled", run_blocked: "blocked" },
  // Queueing is a durable checkpoint. Pausing here prevents a worker race and
  // lets a user approve a resume after a service restart without pretending a
  // browser attempt is still alive.
  queued: { run_preparing: "preparing", run_paused: "paused", run_cancelled: "cancelled", run_blocked: "blocked" },
  preparing: { run_started: "running", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  running: { run_paused: "paused", evidence_collecting: "collecting", run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  paused: { run_resumed: "running", run_cancelled: "cancelled", run_blocked: "blocked" },
  collecting: { run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  judging: { run_retrying: "queued", human_review_requested: "awaiting-human-review", run_completed: "completed", run_failed: "failed", run_blocked: "blocked" },
  "awaiting-human-review": { decision_overridden: "awaiting-human-review", run_completed: "completed", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  completed: { decision_overridden: "completed" },
  failed: { decision_overridden: "failed" },
  blocked: { decision_overridden: "blocked" },
  cancelled: {}
};

export function transitionRunState(current: RunState, event: RunEventType): RunState {
  if (event === "run_created" && current === "draft") return "planning";
  const next = transitions[current][event];
  if (!next) throw new Error(`Invalid run transition: ${current} + ${event}`);
  return next;
}

export const apiErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().optional(),
  details: z.record(z.unknown()).optional(),
  requestId: z.string().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const machineGateSchema = z.object({
  status: gateStatusSchema,
  reasons: z.array(z.string()).default([]),
  reasonDetails: z.array(z.object({
    code: z.string().min(1),
    summary: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1)
  })).default([]),
  assertionFailures: z.array(z.string()).default([]),
  evidenceComplete: z.boolean(),
  // Minted only by the Proof Bundle Service (agent/src/proof/). Business code must
  // never set these; a missing proofBundleId marks a legacy/unverified record.
  proofBundleId: z.string().optional(),
  proofValidationVersion: z.string().optional()
});
export const judgeRecommendationSchema = z.object({
  status: z.enum(["pass", "fail", "needs-human-review"]),
  summary: z.string(),
  evidenceRefs: z.array(z.string()).default([])
});
export const humanDecisionSchema = z.object({
  status: z.enum(["approved", "blocked", "accepted-risk"]),
  actor: z.string().min(1),
  reason: z.string().min(1),
  decidedAt: z.string().datetime()
});
export type MachineGate = z.infer<typeof machineGateSchema>;
export type JudgeRecommendation = z.infer<typeof judgeRecommendationSchema>;
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

/** UI/API-safe outcome facts. Completion, coverage, correctness and release are
 * deliberately independent so a fully executed product failure remains
 * auditable without being presented as a successful release. */
export const runOutcomeSummaryV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  schedulingCompleted: z.boolean(),
  executionStarted: z.boolean(),
  executionSucceeded: z.boolean(),
  requirementCovered: z.boolean(),
  requirementPassed: z.boolean(),
  artifactIntegrityVerified: z.boolean(),
  evidenceGrounded: z.boolean(),
  gateEligible: z.boolean(),
  machineGate: machineGateSchema.optional(),
  judgeRecommendation: judgeRecommendationSchema.optional(),
  humanDecision: humanDecisionSchema.optional(),
  finalStatus: gateStatusSchema.optional(),
  // Credibility validation issues produced by the Proof Bundle Service. Empty for
  // a fully verified bundle; non-empty means a formal pass must not be asserted.
  proofValidationIssues: z.array(z.string()).optional()
}).superRefine((value, context) => {
  if (value.requirementPassed && !value.requirementCovered) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requirementPassed"], message: "A requirement cannot pass before it is covered." });
  }
  if (value.gateEligible && (!value.executionSucceeded || !value.requirementCovered || !value.artifactIntegrityVerified || !value.evidenceGrounded)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["gateEligible"], message: "Gate eligibility requires completed execution, coverage and grounded artifacts." });
  }
  if (value.finalStatus === "pass" && (!value.gateEligible || !value.requirementPassed || value.machineGate?.status !== "pass")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["finalStatus"], message: "Pass requires an eligible passing machine result." });
  }
});
export type RunOutcomeSummaryV2 = z.infer<typeof runOutcomeSummaryV2Schema>;

export const plannerModeSchema = z.enum(["deterministic", "llm", "adaptive"]);
export const judgeModeSchema = z.enum(["deterministic", "llm-assisted", "adaptive"]);
export type PlannerMode = z.infer<typeof plannerModeSchema>;
export type JudgeMode = z.infer<typeof judgeModeSchema>;

export const llmBudgetSchema = z.object({
  maxPlannerCalls: z.number().int().min(1).max(2).default(2),
  maxBrowserActionCalls: z.number().int().min(1).max(60).default(12),
  maxJudgeCalls: z.number().int().min(1).max(1).default(1),
  maxTriageCalls: z.number().int().min(0).max(1).default(1),
  maxRepairCallsPerRound: z.number().int().min(0).max(2).default(2),
  maxRepairRounds: z.number().int().min(0).max(2).default(2),
  maxSemanticRepairAttempts: z.number().int().min(0).max(1).default(1),
  maxTotalTokens: z.number().int().positive().max(100_000).default(12_000),
  plannerMaxOutputTokens: z.number().int().positive().max(8_000).default(2_500),
  judgeMaxOutputTokens: z.number().int().positive().max(8_000).default(2_000),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  totalTimeoutMs: z.number().int().min(1_000).max(300_000).default(120_000),
  maxEstimatedCostUsd: z.number().positive().optional()
}).refine((value) => value.requestTimeoutMs <= value.totalTimeoutMs, { message: "requestTimeoutMs must not exceed totalTimeoutMs" });
export type LlmBudget = z.infer<typeof llmBudgetSchema>;

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

export function resolveFinalStatus(input: {
  machineGate: MachineGate;
  judgeRecommendation?: JudgeRecommendation;
  humanDecision?: HumanDecision;
}): GateStatus {
  if (input.machineGate.status === "fail") return "fail";
  if (input.machineGate.status === "blocked") return "blocked";
  if (input.machineGate.status === "needs-human-review") return "needs-human-review";
  if (input.humanDecision?.status === "blocked") return "fail";
  // Judge is selective advisory logic, not a mandatory approval hop. A fully
  // grounded passing Machine Gate completes deterministically when no Judge
  // was routed. Only an actual conflicting/uncertain Judge recommendation
  // creates a human-review state.
  if (!input.judgeRecommendation) return "pass";
  if (input.judgeRecommendation.status === "needs-human-review") {
    return input.humanDecision?.status === "approved" || input.humanDecision?.status === "accepted-risk" ? "pass" : "needs-human-review";
  }
  if (input.judgeRecommendation.status === "fail") return "needs-human-review";
  return "pass";
}

export const actionDslSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), path: z.string().startsWith("/") }),
  z.object({ action: z.literal("click"), selectorRef: z.string().min(1) }),
  z.object({ action: z.literal("fill"), selectorRef: z.string().min(1), valueRef: z.string().min(1) }),
  z.object({ action: z.literal("select"), selectorRef: z.string().min(1), valueRef: z.string().min(1) }),
  z.object({ action: z.literal("upload"), selectorRef: z.string().min(1), fixtureRef: z.string().min(1) }),
  z.object({ action: z.literal("assert"), oracleId: z.string().min(1) }),
  z.object({ action: z.literal("wait"), durationMs: z.number().int().min(0).max(45_000) }),
  z.object({
    action: z.literal("api-request"),
    operationId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    oracleId: z.string().min(1),
    fixtureRef: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal("data-assert"),
    dataSourceId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    queryTemplateId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    oracleId: z.string().min(1),
    parameterFixtureRef: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal("wait-job"),
    backgroundTaskId: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
    oracleId: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional()
  }),
  z.object({
    action: z.literal("command-check"),
    commandId: z.enum(["test", "health"]),
    oracleId: z.string().min(1)
  })
]);
export type ActionDsl = z.infer<typeof actionDslSchema>;

export const compiledPlanSchema = z.object({
  scenarioId: z.string().min(1),
  steps: z.array(z.object({
    id: z.string().min(1),
    pathId: z.string().min(1).optional(),
    action: actionDslSchema
  })).min(1).max(50),
  requiredOracleIds: z.array(z.string().min(1)).min(1),
  requiredEvidenceKinds: z.array(artifactKindV2Schema).min(1)
});
export type CompiledPlan = z.infer<typeof compiledPlanSchema>;

export const agentPermissionProfileSchema = z.object({
  observe: z.boolean().default(true),
  browserControl: z.boolean().default(true),
  sourceRead: z.boolean().default(true),
  sandboxWrite: z.boolean().default(false),
  sandboxCommand: z.boolean().default(false),
  networkInstall: z.boolean().default(false),
  hostApply: z.boolean().default(false),
  artifactExport: z.boolean().default(false),
  systemControl: z.boolean().default(false),
  /** Compatibility-only aliases. New code must use the granular fields. */
  workspaceControl: z.boolean().default(false),
  ideTerminalControl: z.boolean().default(false)
});
export type AgentPermissionProfile = z.infer<typeof agentPermissionProfileSchema>;

export const agentGraphNodeSchema = z.enum([
  "intake",
  "discover",
  "diagnose-runtime",
  "choose-recovery",
  "recover",
  "verify-recovery",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities",
  "observe-browser",
  "decide-browser-action",
  "authorize-browser-action",
  "execute-browser-action",
  "verify-browser-action",
  "decide-next-step",
  "execute",
  "collect-and-gate",
  "triage-failure",
  "selective-judge",
  "repair",
  "retry-path",
  "continue-paths",
  "finalize"
]);
export type AgentGraphNode = z.infer<typeof agentGraphNodeSchema>;

export const agentInterruptKindSchema = z.enum([
  "plan-approval",
  "browser-permission",
  "credential",
  "network-install",
  "dangerous-operation",
  "repair-apply",
  "repair-decision",
  "execution-result"
]);
export const agentInterruptSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: agentInterruptKindSchema,
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  title: z.string().min(1),
  detail: z.string().min(1),
  requestedCapabilities: z.array(z.string().min(1)).default([]),
  payload: z.record(z.unknown()).default({}),
  // Rich carrier for the unified human-in-the-loop `repair-decision` interrupt.
  // Carries the problem, the diagnosis already performed by the system, the
  // suggested handling, and the concrete operations the user may choose.
  owner: z.enum(["agent", "user", "environment", "developer"]).optional(),
  context: z.record(z.unknown()).optional(),
  options: z.array(z.object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional()
  })).optional(),
  diagnoses: z.array(z.string()).optional(),
  evidenceRefs: z.array(z.string().min(1)).optional(),
  attemptId: z.string().min(1).optional(),
  scenarioId: z.string().min(1).optional(),
  decision: z.string().optional(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional()
});
export type AgentInterrupt = z.infer<typeof agentInterruptSchema>;

/** The answer a user submits when resuming a `repair-decision` interrupt. */
export const repairDecisionAnswerSchema = z.object({
  decision: z.enum([
    "repair",
    "create-session",
    "provide-credentials",
    "recover-sandbox",
    "reopen-discovery",
    "dismiss"
  ]),
  message: z.string().max(4_000).optional(),
  repairPlanId: z.string().min(1).optional()
});
export type RepairDecisionAnswer = z.infer<typeof repairDecisionAnswerSchema>;

export const agentGraphProjectionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  mode: z.enum(["shadow", "active"]),
  status: z.enum(["idle", "running", "interrupted", "completed", "failed", "cancelled"]),
  currentNode: agentGraphNodeSchema.optional(),
  completedNodes: z.array(agentGraphNodeSchema).default([]),
  progress: z.number().min(0).max(1),
  pendingInterrupt: agentInterruptSchema.optional(),
  interruptOwner: z.enum(["agent", "user", "environment", "developer"]).optional(),
  interruptContext: z.record(z.unknown()).optional(),
  lastError: z.object({ code: z.string().min(1), message: z.string().min(1), node: agentGraphNodeSchema.optional() }).optional(),
  tokenUsage: z.number().int().nonnegative().default(0),
  repairSessionId: z.string().min(1).optional(),
  recoveryDecision: recoveryDecisionSchema.optional(),
  recoveryResult: recoveryActionResultSchema.optional(),
  recoveryAttempts: z.record(z.number().int().nonnegative()).optional(),
  currentCoverageItemId: z.string().min(1).optional(),
  currentAttemptId: z.string().min(1).optional(),
  observation: z.record(z.unknown()).optional(),
  browserSession: browserSessionSchema.optional(),
  browserObservation: browserObservationSchema.optional(),
  browserDecision: browserActionDecisionSchema.optional(),
  browserActionResult: browserActionResultSchema.optional(),
  browserAgentRequired: z.boolean().default(false),
  browserLoopComplete: z.boolean().default(false),
  continuationPasses: z.number().int().nonnegative().default(0),
  remainingPathCount: z.number().int().nonnegative().default(0),
  updatedAt: z.string().datetime()
});
export type AgentGraphProjection = z.infer<typeof agentGraphProjectionSchema>;

export const repairRiskSchema = z.enum(["low", "medium", "high", "forbidden"]);
export const repairFileChangeSchema = z.object({
  path: z.string().min(1),
  status: z.enum(["added", "modified", "deleted"]),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  patchedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  risk: repairRiskSchema,
  riskReasons: z.array(z.string()).default([]),
  editable: z.boolean().default(true),
  version: z.number().int().nonnegative().default(0)
});
export type RepairFileChange = z.infer<typeof repairFileChangeSchema>;

export const repairValidationSchema = z.object({
  id: z.string().min(1),
  repairSessionId: z.string().min(1),
  status: z.enum(["queued", "running", "passed", "failed", "blocked"]),
  childRunId: z.string().min(1).optional(),
  commands: z.array(commandSpecSchema).default([]),
  targetedPassed: z.boolean().optional(),
  regressionPassed: z.boolean().optional(),
  artifactIds: z.array(z.string().min(1)).default([]),
  summary: z.string().default(""),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional()
});
export type RepairValidation = z.infer<typeof repairValidationSchema>;

export const repairSessionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(["draft", "analyzing", "editing", "validating", "ready-for-review", "exported", "applied", "failed", "blocked", "cancelled"]),
  baseSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceRoot: z.string().min(1),
  summary: z.string().default(""),
  failureClass: z.enum(["product-bug", "test-script", "environment", "evidence", "unknown"]).default("unknown"),
  files: z.array(repairFileChangeSchema).max(20).default([]),
  validation: repairValidationSchema.optional(),
  iteration: z.number().int().min(0).max(2).default(0),
  maxFiles: z.number().int().positive().max(20).default(20),
  maxChangedLines: z.number().int().positive().max(2000).default(2000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type RepairSession = z.infer<typeof repairSessionSchema>;

/** A safe, source-only entry exposed in the sandbox code workspace tree. */
export const repairWorkspaceFileSchema = z.object({
  path: z.string().min(1),
  changed: z.boolean().default(false),
  risk: z.enum(["low", "medium", "high", "forbidden"]),
  riskReasons: z.array(z.string()).default([]),
  editable: z.boolean()
});
export type RepairWorkspaceFile = z.infer<typeof repairWorkspaceFileSchema>;

export const coverageItemSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  flowId: z.string().min(1),
  module: z.string().min(1),
  surface: z.enum(["page", "api", "data", "background-task"]),
  route: z.string().optional(),
  operationId: z.string().optional(),
  dataEntity: z.string().optional(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  preconditions: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  testDataRefs: z.array(z.string()).default([]),
  actionPathIds: z.array(z.string()).default([]),
  oracleIds: z.array(z.string()).default([]),
  requiredEvidenceKinds: z.array(artifactKindV2Schema).default([]),
  /**
   * A manifest-derived, fully bound plan. This is deliberately stored on the
   * coverage item rather than reconstructed from LLM text by the worker.
   * Every URL, data source, query and background task has already been checked
   * against ProjectManifest before a path child run is created.
   */
  structuredPlan: compiledPlanSchema.optional(),
  disposition: z.enum(["executed", "excluded", "blocked", "pending"]),
  dispositionReason: z.string().optional(),
  scenarioId: z.string().optional(),
  attemptId: z.string().optional(),
  childRunId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type CoverageItem = z.infer<typeof coverageItemSchema>;

export const runKindSchema = z.enum(["parent", "path", "validation"]);
export type RunKind = z.infer<typeof runKindSchema>;

export const conclusionClaimTypeSchema = z.enum([
  "assertion",
  "machine-gate",
  "judge-finding",
  "failure-classification",
  "final-status",
  "human-override"
]);
export const proofStatusSchema = z.enum(["verified", "missing", "invalid", "legacy-unverified"]);
export const conclusionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  conclusionId: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  attemptId: z.string().min(1),
  claimType: conclusionClaimTypeSchema,
  status: z.string().min(1),
  source: z.enum(["deterministic", "llm-advisory", "human"]),
  assertionIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  proofStatus: proofStatusSchema,
  createdAt: z.string().datetime(),
  policyVersion: z.string().min(1),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  supersedesConclusionId: z.string().min(1).optional()
});
export type Conclusion = z.infer<typeof conclusionSchema>;

export const proofNodeTypeSchema = z.enum(["conclusion", "assertion", "oracle", "evidence", "artifact", "attempt", "step"]);
export const proofNodeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  attemptId: z.string().min(1),
  nodeType: proofNodeTypeSchema,
  payload: z.record(z.unknown()).default({}),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
});
export type ProofNode = z.infer<typeof proofNodeSchema>;

export const proofEdgeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  attemptId: z.string().min(1),
  fromType: proofNodeTypeSchema,
  fromId: z.string().min(1),
  toType: proofNodeTypeSchema,
  toId: z.string().min(1),
  relation: z.enum([
    "supported-by-assertion",
    "evaluates-oracle",
    "supported-by-evidence",
    "materialized-by-artifact",
    "captured-in-attempt",
    "produced-by-step",
    "supersedes"
  ]),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime()
});
export type ProofEdge = z.infer<typeof proofEdgeSchema>;

export const runEvidenceManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  artifactHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  evidenceHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  conclusionHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  proofNodeHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  proofEdgeHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
  knowledgeContextHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  knowledgeDecisionHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  knowledgeConflictHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  knowledgeToolExecutionHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  agentMessageHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceSetRoot: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  signature: z.object({
    algorithm: z.enum(["hmac-sha256", "ed25519"]),
    keyId: z.string().min(1),
    value: z.string().min(1)
  }).optional(),
  integrityStatus: z.enum(["verified", "unsigned", "integrity-invalid"])
});
export type RunEvidenceManifest = z.infer<typeof runEvidenceManifestSchema>;

export const llmBudgetLedgerSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  budget: llmBudgetSchema,
  reserved: z.object({
    plannerCalls: z.number().int().nonnegative(),
    browserActionCalls: z.number().int().nonnegative().default(0),
    judgeCalls: z.number().int().nonnegative(),
    triageCalls: z.number().int().nonnegative(),
    repairCalls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().nullable()
  }),
  consumed: z.object({
    plannerCalls: z.number().int().nonnegative(),
    browserActionCalls: z.number().int().nonnegative().default(0),
    judgeCalls: z.number().int().nonnegative(),
    triageCalls: z.number().int().nonnegative(),
    repairCalls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().nullable()
  }),
  scopes: z.record(z.object({
    reserved: z.object({
      plannerCalls: z.number().int().nonnegative(),
      browserActionCalls: z.number().int().nonnegative().default(0),
      judgeCalls: z.number().int().nonnegative(),
      triageCalls: z.number().int().nonnegative(),
      repairCalls: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      wallClockMs: z.number().int().nonnegative(),
      estimatedCostUsd: z.number().nonnegative().nullable()
    }),
    consumed: z.object({
      plannerCalls: z.number().int().nonnegative(),
      browserActionCalls: z.number().int().nonnegative().default(0),
      judgeCalls: z.number().int().nonnegative(),
      triageCalls: z.number().int().nonnegative(),
      repairCalls: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      wallClockMs: z.number().int().nonnegative(),
      estimatedCostUsd: z.number().nonnegative().nullable()
    })
  })).default({}),
  updatedAt: z.string().datetime()
});
export type LlmBudgetLedger = z.infer<typeof llmBudgetLedgerSchema>;

export const repairExportSchema = z.object({
  id: z.string().min(1),
  repairSessionId: z.string().min(1),
  format: z.enum(["patch", "zip"]),
  artifactId: z.string().min(1),
  downloadUrl: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});
export type RepairExport = z.infer<typeof repairExportSchema>;

// An opaque identifier understood only by the benchmark fixture/worker boundary.
// Its value deliberately carries no failure class, expected verdict, or evidence hint.
export const fixtureVariantIdSchema = z.string().regex(/^fxv_[a-f0-9]{16}$/);
export type FixtureVariantId = z.infer<typeof fixtureVariantIdSchema>;

export const createRunRequestSchema = z.object({
  runId: z.string().min(1).optional(),
  runKind: runKindSchema.default("parent"),
  parentRunId: z.string().min(1).optional(),
  coverageItemId: z.string().min(1).optional(),
  organizationId: z.string().min(1).default("local"),
  projectId: z.string().min(1).optional(),
  actor: z.string().min(1).default("api-user"),
  idempotencyKey: z.string().min(1),
  input: z.object({
    appUrl: z.string().url().optional(),
    /** Logical benchmark project used for scenario/impact matching. It may
     * differ from projectId when a logical project maps to an execution
     * fixture (for example todo_lite -> local_demo_app). */
    logicalProjectId: z.string().min(1).optional(),
    scenarioId: z.string().optional(),
    coverageScenarioIds: z.array(z.string().min(1)).max(500).default([]),
    coverageMode: z.enum(["targeted", "full"]).default("targeted"),
    /** Grouped, label-free coverage inventory produced by static discovery.
     * These are business-path candidates, not Scenario Registry IDs. */
    coverageInventory: z.array(z.object({
      id: z.string().min(1),
      title: z.string().min(1).max(500),
      /** Static planning disposition. Only executable/auto-bindable entries
       * may enter the browser action loop; the other entries stay visible in
       * the coverage ledger as explicit blocked work. */
      status: z.enum(["executable", "auto-bindable", "needs-input", "coverage-gap"]).default("auto-bindable"),
      kind: z.enum(["page", "component", "api", "scenario", "data", "background-task"]),
      target: z.string().min(1).max(1_000),
      sourceNodeIds: z.array(z.string().min(1)).max(2_000).default([]),
      sourceCount: z.number().int().positive().default(1),
      surfaces: z.array(z.enum(["page", "api", "data", "background-task"])).max(4).default([]),
      requiredEvidenceKinds: z.array(artifactKindV2Schema).max(20).default([]),
      preconditions: z.array(z.string().min(1).max(500)).max(30).default([])
    }).strict()).max(5_000).default([]),
    /** Force an uploaded project through the observation/action/oracle loop
     * instead of binding a stale registry scenario in the Workbench. */
    dynamicBrowser: z.boolean().default(false),
    /** The operator already confirmed the Workbench plan and the low-risk
     * capabilities carried by permissionProfile. */
    confirmedExecution: z.boolean().default(false),
    /** Benchmark runs execute exactly one selected scenario so lane results remain comparable. */
    executionProfile: z.enum(["interactive", "benchmark"]).default("interactive"),
    requirement: z.string().optional(),
    diff: z.string().optional(),
    plannerMode: plannerModeSchema.default("deterministic"),
    judgeMode: judgeModeSchema.default("deterministic"),
    modelProfileId: z.string().min(1).optional(),
    experimentId: z.string().min(1).optional(),
    repetition: z.number().int().min(1).max(10).optional(),
    promptVersion: z.string().min(1).default("plan-v1"),
    targetVersion: z.string().min(1).optional(),
    cachePolicy: z.enum(["auto", "bypass"]).default("auto"),
    llmBudget: llmBudgetSchema.default({}),
    fixtureVariantId: fixtureVariantIdSchema.optional(),
    permissionProfile: agentPermissionProfileSchema.default({}),
    executionMode: z.enum(["oci", "trusted-local"]).default("oci"),
    capabilities: z.array(z.enum(["browser", "desktop"])).default(["browser"])
  })
}).superRefine((value, context) => {
  if (!value.projectId && !value.input.appUrl) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide projectId or appUrl" });
  if ((value.input.plannerMode !== "deterministic" || value.input.judgeMode !== "deterministic") && !value.input.modelProfileId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input", "modelProfileId"], message: "LLM modes require modelProfileId." });
  }
  if (value.input.experimentId && !value.input.repetition) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input", "repetition"], message: "Experiment runs require repetition." });
  }
  if (value.input.experimentId && value.input.cachePolicy !== "bypass") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input", "cachePolicy"], message: "Benchmark experiments must bypass plan cache." });
  }
  if (value.runKind !== "parent" && !value.parentRunId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parentRunId"], message: "Path and validation runs require parentRunId." });
  }
  if (value.runKind === "path" && !value.coverageItemId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["coverageItemId"], message: "Path runs require coverageItemId." });
  }
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const runStreamEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.enum([
    "state",
    "step",
    "log",
    "artifact",
    "heartbeat",
    "agent.node.started",
    "agent.node.completed",
    "agent.node.failed",
    "agent.interrupt",
    "agent.interrupt.created",
    "agent.interrupt.waiting",
    "agent.interrupt.resumed",
    "agent.interrupt.rejected",
    "agent.interrupt.expired",
    "agent.observation.created",
    "agent.recovery.started",
    "agent.recovery.completed",
    "agent.recovery.blocked",
    "agent.tool.started",
    "agent.tool.completed",
    "path.retrying",
    "parent.continuing",
    "llm.call.started",
    "llm.call.retried",
    "llm.call.completed",
    "llm.call.failed",
    "proof.created",
    "proof.verified",
    "proof.invalid",
    "conclusion.created",
    "artifact.committed",
    "repair.created",
    "repair.changed",
    "repair.exported",
    "validation.started",
    "validation.completed"
  ]),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  payload: z.record(z.unknown())
});

export function artifactGateEligibility(artifact: ArtifactV2) {
  if (["simulated", "legacy-unverified", "user-uploaded"].includes(artifact.origin)) {
    return { eligible: false, reason: `origin_${artifact.origin}` } as const;
  }
  if (artifact.origin === "fixture" && !artifact.fixtureManifestSha256) {
    return { eligible: false, reason: "fixture_manifest_missing" } as const;
  }
  return { eligible: true, reason: "verified" } as const;
}

export function validateEvidenceArtifactLinks(evidence: EvidenceV2, artifacts: ArtifactV2[]) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const errors: string[] = [];
  for (const artifactId of evidence.artifactIds) {
    const artifact = byId.get(artifactId);
    if (!artifact) {
      errors.push(`${artifactId}:missing`);
      continue;
    }
    if (artifact.runId !== evidence.runId) errors.push(`${artifactId}:run_mismatch`);
    if (artifact.scenarioId !== evidence.scenarioId) errors.push(`${artifactId}:scenario_mismatch`);
    if (artifact.attemptId !== evidence.attemptId || artifact.attempt !== evidence.attempt) errors.push(`${artifactId}:attempt_mismatch`);
    if (evidence.stepId && artifact.stepId && artifact.stepId !== evidence.stepId) errors.push(`${artifactId}:step_mismatch`);
  }
  return { valid: errors.length === 0, errors };
}

// ─── Architecture Transformation: New Modules ─────────────────────

// Agent Context Layer
export {
  contextAccessPolicySchema,
  contextLayerOutputSchema,
  evidenceContextSchema,
  failureHistoryContextSchema,
  projectContextSchema,
  repairHistoryContextSchema,
  runStatusContextSchema
} from "./context-layer.js";
export type {
  ContextAccessPolicy,
  ContextLayerOutput,
  EvidenceContext,
  FailureHistoryContext,
  ProjectContext,
  RepairHistoryContext,
  RunStatusContext
} from "./context-layer.js";

// Agent Memory
export {
  experienceMemoryEntrySchema,
  experienceMemoryQuerySchema,
  memoryStatisticsSchema,
  projectMemoryEntrySchema,
  projectMemoryQuerySchema
} from "./agent-memory.js";
export type {
  ExperienceMemoryEntry,
  ExperienceMemoryQuery,
  MemoryStatistics,
  ProjectMemoryEntry,
  ProjectMemoryQuery
} from "./agent-memory.js";

// Schema Versioning
export {
  apiContractVersionSchema,
  dbMigrationVersionSchema,
  toolVersionSchema,
  versionCompatibilitySchema
} from "./schema-versioning.js";
export type {
  ApiContractVersion,
  DbMigrationVersion,
  ToolVersion,
  VersionCompatibility
} from "./schema-versioning.js";

// Write Safety Layer
export {
  approvalWorkflowSchema,
  policyCheckResultSchema,
  riskLevelSchema,
  writeActionSchema,
  writeExecutionResultSchema,
  writeOperationLogSchema
} from "./write-safety.js";
export type {
  ApprovalNode,
  ApprovalWorkflow,
  PolicyCheckResult,
  RiskLevel,
  WriteAction,
  WriteExecutionResult,
  WriteOperationLog
} from "./write-safety.js";

// Monitoring
export {
  agentQualityMetricsSchema,
  operationsDashboardSchema,
  systemQualityMetricsSchema,
  testQualityMetricsSchema
} from "./monitoring.js";
export type {
  AgentQualityMetrics,
  OperationsDashboard,
  SystemQualityMetrics,
  TestQualityMetrics
} from "./monitoring.js";

// Trace Chain
export {
  traceChainSchema,
  traceQuerySchema,
  traceSpanSchema
} from "./trace-chain.js";
export type {
  TraceActor,
  TraceChain,
  TraceId,
  TraceQuery,
  TraceSpan,
  TraceSpanKind,
  TraceSpanStatus,
  SpanId
} from "./trace-chain.js";

// LLM Input Optimization
export {
  observedEvidenceSchema,
  optimizedLlmInputSchema,
  retrievedKnowledgeSchema,
  unknownInformationSchema,
  verifiedFactSchema
} from "./llm-input.js";
export type {
  InformationCategory,
  ObservedEvidence,
  OptimizedLlmInput,
  RetrievedKnowledge,
  UnknownInformation,
  VerifiedFact
} from "./llm-input.js";

// Experience Feedback Loop
export {
  failureDetectionSchema,
  feedbackLoopSessionSchema,
  feedbackStageSchema,
  repairProposalSchema,
  repairValidationSchema as feedbackRepairValidationSchema,
  rootCauseAnalysisSchema
} from "./feedback-loop.js";
export type {
  FailureDetection,
  FeedbackLoopSession,
  FeedbackStage,
  RepairProposal,
  RepairValidation as FeedbackRepairValidation,
  RootCauseAnalysis
} from "./feedback-loop.js";

export {
  agentObservationSchema,
  recoveryActionResultSchema,
  recoveryActionSchema,
  recoveryActionStatusSchema,
  recoveryDecisionSchema
} from "./recovery.js";
export type {
  AgentObservation,
  RecoveryAction,
  RecoveryActionResult,
  RecoveryActionStatus,
  RecoveryDecision
} from "./recovery.js";

export {
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserAgentActionSchema,
  browserControlOwnerSchema,
  browserControlSchema,
  browserObservationSchema,
  browserSessionSchema,
  dynamicOracleSchema
} from "./browser-agent.js";
export type {
  BrowserActionDecision,
  BrowserActionResult,
  BrowserAgentAction,
  BrowserControl,
  BrowserControlOwner,
  BrowserObservation,
  BrowserSession,
  DynamicOracle
} from "./browser-agent.js";
