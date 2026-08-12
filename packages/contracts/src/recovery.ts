import { z } from "zod";

export const recoveryActionSchema = z.enum([
  "retry-runtime",
  "retry-discovery",
  "retry-path",
  "repair-harness",
  "repair-environment",
  "repair-product",
  "request-credentials",
  "request-user-confirmation",
  "blocked"
]);
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const recoveryDecisionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  coverageItemId: z.string().min(1).optional(),
  attemptId: z.string().min(1).optional(),
  action: recoveryActionSchema,
  reason: z.string().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceRefs: z.array(z.string().min(1)).max(20).default([]),
  preconditions: z.array(z.string().min(1)).max(20).default([]),
  expectedState: z.string().min(1).max(500),
  userQuestion: z.string().max(1_000).optional(),
  createdAt: z.string().datetime(),
  policyVersion: z.string().min(1)
});
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;

export const recoveryActionStatusSchema = z.enum(["accepted", "running", "completed", "failed", "blocked", "needs-confirmation"]);
export type RecoveryActionStatus = z.infer<typeof recoveryActionStatusSchema>;

export const recoveryActionResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  actionId: z.string().min(1),
  runId: z.string().min(1),
  action: recoveryActionSchema,
  status: recoveryActionStatusSchema,
  evidenceRefs: z.array(z.string().min(1)).default([]),
  nextState: z.string().min(1),
  errorCode: z.string().min(1).optional(),
  userMessage: z.string().min(1).optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional()
});
export type RecoveryActionResult = z.infer<typeof recoveryActionResultSchema>;

export const agentObservationSchema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1).optional(),
  stage: z.enum(["runtime", "navigation", "dom", "action", "assertion", "recovery"]),
  status: z.enum(["ready", "degraded", "failed"]),
  requestedUrl: z.string().url().optional(),
  finalUrl: z.string().url().optional(),
  httpStatus: z.number().int().optional(),
  title: z.string().optional(),
  readyState: z.enum(["loading", "interactive", "complete", "unknown"]).optional(),
  accessibilityTree: z.string().max(12_000).optional(),
  controls: z.array(z.object({
    role: z.string().optional(),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    disabled: z.boolean().optional(),
    selector: z.string().optional()
  }).strict()).max(200).optional(),
  consoleErrors: z.array(z.string().max(1_000)).max(50).optional(),
  pageErrors: z.array(z.string().max(1_000)).max(50).optional(),
  failedRequests: z.array(z.object({
    method: z.string().optional(),
    url: z.string().optional(),
    status: z.number().int().optional(),
    failure: z.string().optional()
  }).strict()).max(100).optional(),
  screenshotArtifactId: z.string().min(1).optional(),
  lifecycle: z.array(z.object({
    event: z.string().min(1),
    at: z.string().datetime(),
    detail: z.string().optional()
  }).strict()).max(100).optional(),
  summary: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  retryable: z.boolean().default(false),
  userActionRequired: z.boolean().default(false),
  createdAt: z.string().datetime()
});
export type AgentObservation = z.infer<typeof agentObservationSchema>;
