import { z } from "zod";

export const browserControlOwnerSchema = z.enum(["agent", "user", "waiting-user"]);
export type BrowserControlOwner = z.infer<typeof browserControlOwnerSchema>;

export const browserControlSchema = z.object({
  controlId: z.string().min(1),
  observationId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  pageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["link", "button", "input", "textarea", "select", "checkbox", "radio", "other"]),
  role: z.string().max(80).optional(),
  accessibleName: z.string().max(240).optional(),
  label: z.string().max(240).optional(),
  testId: z.string().max(240).optional(),
  inputType: z.string().max(80).optional(),
  /** Never persist an input's contents.  This boolean state lets an Oracle
   * verify a fill action, including password fields, without exposing text. */
  valueState: z.enum(["empty", "nonempty"]).optional(),
  framePath: z.array(z.string().max(500)).max(8).default([]),
  shadowPath: z.array(z.string().max(500)).max(8).default([]),
  locatorCandidates: z.array(z.object({
    strategy: z.enum(["test-id", "role-name", "label", "text", "css-safe"]),
    value: z.string().min(1).max(500),
    unique: z.boolean()
  }).strict()).min(1).max(6),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive()
  }).strict().optional(),
  visible: z.boolean(),
  disabled: z.boolean(),
  obscured: z.boolean().default(false)
}).strict();
export type BrowserControl = z.infer<typeof browserControlSchema>;

export const browserObservationSchema = z.object({
  schemaVersion: z.literal("1.0"),
  observationId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  coverageItemId: z.string().min(1).optional(),
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  title: z.string().max(500),
  readyState: z.enum(["loading", "interactive", "complete", "unknown"]),
  pageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bodyTextSample: z.string().max(4_000),
  accessibilityTree: z.string().max(12_000).optional(),
  controls: z.array(browserControlSchema).max(200),
  consoleErrors: z.array(z.string().max(1_000)).max(50),
  pageErrors: z.array(z.string().max(1_000)).max(50),
  failedRequests: z.array(z.object({
    method: z.string().max(20),
    url: z.string().url(),
    status: z.number().int().optional(),
    failure: z.string().max(500).optional()
  }).strict()).max(100),
  screenshotArtifactId: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime()
}).strict();
export type BrowserObservation = z.infer<typeof browserObservationSchema>;

const browserActionBaseSchema = z.object({
  actionId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  coverageItemId: z.string().min(1),
  sourceObservationId: z.string().min(1),
  sourcePageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.string().min(1).max(500),
  expectedChange: z.string().min(1).max(500),
  oracleIds: z.array(z.string().min(1)).max(6).default([]),
  risk: z.enum(["low", "medium", "high", "forbidden"]),
  timeoutMs: z.number().int().min(250).max(45_000).default(10_000)
});

export const browserAgentActionSchema = z.discriminatedUnion("action", [
  browserActionBaseSchema.extend({ action: z.literal("click-control"), controlId: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("fill-control"), controlId: z.string().min(1), valueRef: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("select-control"), controlId: z.string().min(1), valueRef: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("check-control"), controlId: z.string().min(1), checked: z.boolean() }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("press-key"), controlId: z.string().min(1).optional(), key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("scroll-to-control"), controlId: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("wait-for-control"), controlId: z.string().min(1), state: z.enum(["visible", "hidden", "enabled", "disabled"]) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("navigate-route"), routeId: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("submit-form"), controlId: z.string().min(1) }).strict(),
  browserActionBaseSchema.extend({ action: z.literal("evaluate-oracle"), oracleIds: z.array(z.string().min(1)).min(1).max(6) }).strict()
]);
export type BrowserAgentAction = z.infer<typeof browserAgentActionSchema>;

export const dynamicOracleSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("element-state"), controlId: z.string().min(1), expected: z.enum(["visible", "hidden", "enabled", "disabled"]), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("text"), controlId: z.string().min(1).optional(), operator: z.enum(["equals", "contains", "not-contains"]), expected: z.string().min(1), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("url"), operator: z.enum(["equals", "contains", "not-contains"]), expected: z.string().min(1), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("count-change"), controlId: z.string().min(1).optional(), expected: z.enum(["increased", "decreased", "unchanged"]), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("network"), operationId: z.string().min(1), expectedStatus: z.number().int().min(100).max(599).optional(), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("dom-change"), expected: z.enum(["changed", "unchanged"]), description: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), type: z.literal("input-state"), controlId: z.string().min(1), expected: z.enum(["empty", "nonempty"]), description: z.string().min(1) }).strict()
]);
export type DynamicOracle = z.infer<typeof dynamicOracleSchema>;

export const browserActionDecisionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  decisionId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  observationId: z.string().min(1),
  status: z.enum(["act", "complete", "blocked", "needs-confirmation"]),
  reasonCode: z.enum(["transient-observation", "transient-model", "budget-exhausted", "policy-blocked", "user-input-required"]).optional(),
  summary: z.string().min(1).max(800),
  actions: z.array(browserAgentActionSchema).max(3),
  oracles: z.array(dynamicOracleSchema).max(6),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  userQuestion: z.string().max(500).optional(),
  createdAt: z.string().datetime()
}).strict().superRefine((value, context) => {
  if ((value.status === "act" || value.status === "needs-confirmation") && value.actions.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browser_action_decision_requires_action" });
  }
  if ((value.status === "complete" || value.status === "blocked") && value.actions.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "browser_action_decision_unexpected_actions" });
  }
});
export type BrowserActionDecision = z.infer<typeof browserActionDecisionSchema>;

export const browserActionResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  resultId: z.string().min(1),
  actionId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  coverageItemId: z.string().min(1),
  status: z.enum(["completed", "failed", "blocked", "needs-confirmation"]),
  errorCode: z.string().min(1).optional(),
  summary: z.string().min(1).max(1_000),
  beforeObservationId: z.string().min(1),
  afterObservationId: z.string().min(1).optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  oracleResults: z.array(z.object({ oracleId: z.string().min(1), passed: z.boolean(), actual: z.string().max(1_000), evidenceRefs: z.array(z.string().min(1)) }).strict()).default([]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
}).strict();
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;

export const browserSessionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  status: z.enum(["starting", "ready", "waiting-user", "recovering", "closed", "failed"]),
  owner: browserControlOwnerSchema,
  currentUrl: z.string().url().optional(),
  lastObservationId: z.string().min(1).optional(),
  actionCount: z.number().int().nonnegative(),
  decisionCount: z.number().int().nonnegative(),
  rebindCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  leaseExpiresAt: z.string().datetime().optional()
}).strict();
export type BrowserSession = z.infer<typeof browserSessionSchema>;
