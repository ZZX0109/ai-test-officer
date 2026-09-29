import { z } from "zod";
import { recoveryActionResultSchema, recoveryDecisionSchema } from "./recovery.js";
import {
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema
} from "./browser-agent.js";
import { artifactKindV2Schema, artifactV2Schema, evidenceV2Schema, type ArtifactV2, type EvidenceV2 } from "./artifacts.js";
import { commandSpecSchema } from "./execution-config.js";
import { agentPermissionProfileSchema, compiledPlanSchema } from "./planning-graph.js";
export * from "./trajectory.js";
export * from "./planning-graph.js";
export * from "./execution-config.js";
export * from "./artifacts.js";
export * from "./llm-governance.js";
export { repairValidationSchema } from "./planning-graph.js";
export type { RepairValidation } from "./planning-graph.js";

export const gateStatusSchema = z.enum(["pass", "fail", "blocked", "needs-human-review"]);
export type GateStatus = z.infer<typeof gateStatusSchema>;

export const readinessStatusSchema = z.enum(["ready", "repairable", "blocked"]);
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>;

export const readinessSeveritySchema = z.enum(["info", "warning", "error"]);
export type ReadinessSeverity = z.infer<typeof readinessSeveritySchema>;

export const readinessCheckSchema = z.object({
  id: z.string().min(1),
  status: readinessStatusSchema,
  severity: readinessSeveritySchema,
  message: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  remediation: z.string().min(1).optional(),
  requiredBy: z.array(z.string().min(1)).default([]),
  updatedAt: z.string().datetime()
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const readinessReportSchema = z.object({
  projectId: z.string().min(1),
  status: readinessStatusSchema,
  checks: z.array(readinessCheckSchema),
  generatedAt: z.string().datetime(),
  bootstrapId: z.string().min(1).optional()
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;

export const reviewCaseSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["environment", "credentials", "network", "runtime", "coverage", "proof", "repair", "permission", "unknown"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  title: z.string().min(1),
  explanation: z.string().min(1),
  whatWasTried: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  requiredDecision: z.string().min(1),
  nextAction: z.string().min(1),
  cta: z.string().min(1),
  canRetry: z.boolean().default(false),
  canResume: z.boolean().default(false),
  createdAt: z.string().datetime()
});
export type ReviewCase = z.infer<typeof reviewCaseSchema>;

export function normalizeLegacyGateStatus(value: string): GateStatus {
  if (["pass", "continue", "passed"].includes(value)) return "pass";
  if (["fail", "failed", "stop_and_fix"].includes(value)) return "fail";
  if (["blocked", "environment_blocked"].includes(value)) return "blocked";
  return "needs-human-review";
}


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
  "parent_aggregate_completed",
  "parent_aggregate_blocked",
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


const transitions: Record<RunState, Partial<Record<RunEventType, RunState>>> = {
  draft: { run_cancelled: "cancelled" },
  planning: {
    plan_generated: "awaiting-plan-approval",
    human_review_requested: "awaiting-human-review",
    parent_aggregate_completed: "completed",
    parent_aggregate_blocked: "blocked",
    run_failed: "failed",
    run_blocked: "blocked",
    run_cancelled: "cancelled"
  },
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
  preparing: { run_started: "running", run_retrying: "queued", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  // A dead Worker can leave a Lease behind after it has announced
  // `run_started`. Lease recovery appends run_retrying, clears the generation
  // fence and creates a fresh versioned Outbox delivery; it never fabricates a
  // terminal result from an interrupted action.
  running: { run_paused: "paused", run_retrying: "queued", evidence_collecting: "collecting", run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  paused: { run_resumed: "running", run_cancelled: "cancelled", run_blocked: "blocked" },
  collecting: { run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  judging: { run_retrying: "queued", human_review_requested: "awaiting-human-review", parent_aggregate_completed: "completed", parent_aggregate_blocked: "blocked", run_completed: "completed", run_failed: "failed", run_blocked: "blocked" },
  "awaiting-human-review": { decision_overridden: "awaiting-human-review", parent_aggregate_completed: "completed", parent_aggregate_blocked: "blocked", run_completed: "completed", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
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

/**
 * Describes whether the test workflow finished processing its declared paths.
 * This is deliberately independent from GateStatus: a run may finish all
 * possible work while still producing a fail, blocked, or review verdict.
 */
export const executionStatusSchema = z.enum([
  "running",
  "waiting-user",
  "completed",
  "completed-with-gaps",
  "cancelled",
  "infrastructure-failed"
]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

/** The only result a Worker may return to LangGraph. It describes one
 * execution attempt and deliberately contains no Run-level verdict. */
export const pathExecutionResultSchema = z.object({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  executionGeneration: z.number().int().nonnegative(),
  status: z.enum(["executed", "failed", "blocked"]),
  resultRunId: z.string().min(1).optional(),
  executionSucceeded: z.boolean(),
  error: z.string().optional()
}).strict();
export type PathExecutionResult = z.infer<typeof pathExecutionResultSchema>;

/** UI/API-safe outcome facts. Completion, coverage, correctness and release are
 * deliberately independent so a fully executed product failure remains
 * auditable without being presented as a successful release. */
export const runOutcomeSummaryV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  // Additive during the v2 rollout: old persisted bundles remain readable,
  // while all newly finalized Graph runs write this field explicitly.
  executionStatus: executionStatusSchema.optional(),
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
  /** Behaviour matrix is separate from path coverage. */
  behaviorDimensions: z.array(z.enum(["happy-path", "negative", "boundary", "permission", "state-transition", "data-consistency", "idempotency", "recovery"])).default(["happy-path"]),
  /** Dimensions actually exercised by the persisted run; never inferred from
   * the requested matrix after the fact. */
  coveredBehaviorDimensions: z.array(z.enum(["happy-path", "negative", "boundary", "permission", "state-transition", "data-consistency", "idempotency", "recovery"])).default([]),
  /** Runtime Binding Compiler output. `pending` means observation/manifest
   * binding is still required; it is never equivalent to a verified binding. */
  binding: z.object({
    compilerVersion: z.string().min(1),
    status: z.enum(["pending", "bound", "needs-input", "unsupported", "blocked-by-capability", "coverage-gap"]),
    entryRoute: z.string().optional(),
    operationId: z.string().optional(),
    actionPathIds: z.array(z.string()).default([]),
    oracleIds: z.array(z.string()).default([]),
    requiredCapabilities: z.array(z.string()).default([]),
    reason: z.string().optional(),
    boundAt: z.string().datetime().optional()
  }).optional(),
  /** Per-path resource envelope copied into the child run at dispatch time. */
  budget: z.object({
    maxBrowserActionCalls: z.number().int().min(1).max(60),
    maxTotalTokens: z.number().int().positive().max(100_000),
    totalTimeoutMs: z.number().int().min(1_000).max(300_000),
    maxAttempts: z.number().int().min(1).max(2)
  }).optional(),
  /**
   * A manifest-derived, fully bound plan. This is deliberately stored on the
   * coverage item rather than reconstructed from LLM text by the worker.
   * Every URL, data source, query and background task has already been checked
   * against ProjectManifest before a path child run is created.
   */
  structuredPlan: compiledPlanSchema.optional(),
  disposition: z.enum(["pending", "binding", "executing", "executed", "failed", "blocked", "excluded"]),
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
    /** A model-driven Run is not allowed to silently degrade into a rule-only
     * result. It must retain a successful browser-action model call as part of
     * its evidence-backed completion contract. */
    requireModelExecution: z.boolean().default(false),
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
  if (artifact.objectStoreState === "missing" || artifact.objectStoreState === "uncommitted") {
    return { eligible: false, reason: `object_store_${artifact.objectStoreState}` } as const;
  }
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

// Domain modules keep their own schema definitions; this barrel preserves
// the package-level API without making the core contract file a second index.
export * from "./contract-modules.js";
