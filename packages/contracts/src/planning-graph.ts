import { z } from "zod";
import { recoveryActionResultSchema, recoveryDecisionSchema } from "./recovery.js";
import {
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema
} from "./browser-agent.js";
import { artifactKindV2Schema } from "./artifacts.js";
import { commandSpecSchema } from "./execution-config.js";

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

export const repairDeliverableSchema = z.object({
  patchSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  impactSummary: z.string().max(2_000).default(""),
  targetedValidation: z.enum(["not-run", "passed", "failed", "blocked"]).default("not-run"),
  regressionValidation: z.enum(["not-run", "passed", "failed", "blocked"]).default("not-run"),
  validationArtifactIds: z.array(z.string().min(1)).default([]),
  mergeEligibility: z.enum(["not-eligible", "eligible", "applied"]).default("not-eligible"),
  generatedAt: z.string().datetime().optional()
});
export type RepairDeliverable = z.infer<typeof repairDeliverableSchema>;

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
  /** Auditable hand-off package: patch, impact, validations and merge gate. */
  deliverable: repairDeliverableSchema.optional(),
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
