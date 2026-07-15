import { z } from "zod";

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
  "attachment"
]);

export const artifactIntegrityV2Schema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  capturedAt: z.string().datetime(),
  collector: z.object({ name: z.string().min(1), version: z.string().min(1) })
});

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
  summary: z.string().min(1)
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
  "run_paused",
  "run_resumed",
  "evidence_collecting",
  "run_judging",
  "human_review_requested",
  "decision_overridden",
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
    test: commandSpecSchema.optional(),
    cleanup: commandSpecSchema.optional()
  }),
  commandAllowlist: z.array(z.string().regex(/^[a-zA-Z0-9._/+:-]+$/)).min(1),
  ports: z.array(z.object({ name: z.string().min(1), env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), purpose: z.enum(["frontend", "backend", "health", "auxiliary"]) })).default([]),
  healthCheck: z.object({ path: z.string().startsWith("/"), timeoutMs: z.number().int().positive().default(20_000) }).optional(),
  environmentAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
  network: z.object({ mode: z.enum(["deny", "allow-target", "allowlist"]).default("allow-target"), allowedHosts: z.array(z.string()).default([]) }).default({}),
  fixtures: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), destructive: z.boolean().default(false) })).default([]),
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
  "awaiting-plan-approval": { plan_approved: "awaiting-permission", run_cancelled: "cancelled" },
  "awaiting-permission": { permission_granted: "queued", run_cancelled: "cancelled", run_blocked: "blocked" },
  // Queueing is a durable checkpoint. Pausing here prevents a worker race and
  // lets a user approve a resume after a service restart without pretending a
  // browser attempt is still alive.
  queued: { run_preparing: "preparing", run_paused: "paused", run_cancelled: "cancelled", run_blocked: "blocked" },
  preparing: { run_started: "running", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  running: { run_paused: "paused", evidence_collecting: "collecting", run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  paused: { run_resumed: "running", run_cancelled: "cancelled", run_blocked: "blocked" },
  collecting: { run_judging: "judging", run_failed: "failed", run_blocked: "blocked", run_cancelled: "cancelled" },
  judging: { human_review_requested: "awaiting-human-review", run_completed: "completed", run_failed: "failed", run_blocked: "blocked" },
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
  assertionFailures: z.array(z.string()).default([]),
  evidenceComplete: z.boolean()
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

export const plannerModeSchema = z.enum(["deterministic", "llm", "adaptive"]);
export const judgeModeSchema = z.enum(["deterministic", "llm-assisted", "adaptive"]);
export type PlannerMode = z.infer<typeof plannerModeSchema>;
export type JudgeMode = z.infer<typeof judgeModeSchema>;

export const llmBudgetSchema = z.object({
  maxPlannerCalls: z.number().int().min(1).max(2).default(2),
  maxJudgeCalls: z.number().int().min(1).max(2).default(2),
  maxTotalTokens: z.number().int().positive().max(100_000).default(12_000),
  plannerMaxOutputTokens: z.number().int().positive().max(8_000).default(2_500),
  judgeMaxOutputTokens: z.number().int().positive().max(8_000).default(2_000),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  totalTimeoutMs: z.number().int().min(1_000).max(300_000).default(90_000),
  maxEstimatedCostUsd: z.number().positive().optional()
}).refine((value) => value.requestTimeoutMs <= value.totalTimeoutMs, { message: "requestTimeoutMs must not exceed totalTimeoutMs" });
export type LlmBudget = z.infer<typeof llmBudgetSchema>;

export const llmCallSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).optional(),
  experimentId: z.string().min(1).optional(),
  purpose: z.enum(["planning", "judging"]),
  provider: z.enum(["openai-compatible", "openai", "anthropic", "openrouter", "custom"]),
  model: z.string().min(1),
  requestId: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  status: z.enum(["passed", "failed", "blocked"]),
  usage: z.object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional()
  }).default({}),
  errorCode: z.string().min(1).optional()
});
export type LlmCall = z.infer<typeof llmCallSchema>;

export const planProvenanceSchema = z.object({
  source: z.enum(["deterministic", "llm", "cached-llm", "adaptive-rule-fallback"]),
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
  if (!input.judgeRecommendation || input.judgeRecommendation.status === "needs-human-review") {
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
  z.object({ action: z.literal("wait"), durationMs: z.number().int().min(0).max(45_000) })
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

// An opaque identifier understood only by the benchmark fixture/worker boundary.
// Its value deliberately carries no failure class, expected verdict, or evidence hint.
export const fixtureVariantIdSchema = z.string().regex(/^fxv_[a-f0-9]{16}$/);
export type FixtureVariantId = z.infer<typeof fixtureVariantIdSchema>;

export const createRunRequestSchema = z.object({
  runId: z.string().min(1).optional(),
  organizationId: z.string().min(1).default("local"),
  projectId: z.string().min(1).optional(),
  actor: z.string().min(1).default("api-user"),
  idempotencyKey: z.string().min(1),
  input: z.object({
    appUrl: z.string().url().optional(),
    scenarioId: z.string().optional(),
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
    permissionProfile: z.object({
      observe: z.boolean().default(true),
      browserControl: z.boolean().default(true),
      workspaceControl: z.boolean().default(false),
      ideTerminalControl: z.boolean().default(false),
      systemControl: z.boolean().default(false)
    }).default({}),
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
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const runStreamEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.enum(["state", "step", "log", "artifact", "heartbeat"]),
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
