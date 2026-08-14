import assert from "node:assert/strict";
import {
  artifactGateEligibility,
  artifactV2Schema,
  defaultResourceBudget,
  normalizeLegacyGateStatus,
  projectManifestSchema,
  transitionRunState,
  validateEvidenceArtifactLinks,
  resolveFinalStatus
  ,createRunRequestSchema
  ,fixtureVariantIdSchema
  ,planProvenanceSchema
  ,actionDslSchema
  ,llmCallSchema
  ,knowledgeClaimSchema
  ,llmKnowledgeContextSchema
  ,knowledgeBoundaryOutputSchema
  ,normalizeKnowledgeBoundaryOutput
  ,runOutcomeSummaryV2Schema
  ,agentMessageSchema
  ,browserActionDecisionSchema
  ,browserAgentActionSchema
} from "../src/index.js";

const artifact = artifactV2Schema.parse({
  schemaVersion: "2.0",
  id: "artifact-1",
  runId: "run-1",
  scenarioId: "scenario-1",
  stepId: "step-1",
  attemptId: "attempt-1",
  attempt: 1,
  kind: "screenshot",
  origin: "runtime-captured",
  storageUri: "s3://bucket/run-1/step-1.png",
  sequence: 1,
  monotonicOffsetMs: 12,
  integrity: {
    sha256: "a".repeat(64),
    sizeBytes: 10,
    mediaType: "image/png",
    capturedAt: "2026-07-14T00:00:00.000Z",
    collector: { name: "playwright", version: "1.0.0" }
  }
});
assert.equal(artifactGateEligibility(artifact).eligible, true);
assert.equal(artifactGateEligibility({ ...artifact, origin: "simulated" }).eligible, false);
assert.equal(artifactGateEligibility({ ...artifact, origin: "user-uploaded" }).eligible, false);
assert.deepEqual(validateEvidenceArtifactLinks({
  schemaVersion: "2.0",
  id: "evidence-1",
  runId: "other-run",
  scenarioId: artifact.scenarioId,
  attemptId: artifact.attemptId,
  attempt: artifact.attempt,
  capturedAt: "2026-07-14T00:00:00.000Z",
  artifactIds: [artifact.id],
  summary: "invalid immutable link"
}, [artifact]), { valid: false, errors: [`${artifact.id}:run_mismatch`] });
assert.equal(normalizeLegacyGateStatus("hold_for_review"), "needs-human-review");
assert.equal(transitionRunState("awaiting-plan-approval", "plan_approved"), "awaiting-permission");
assert.equal(transitionRunState("awaiting-plan-approval", "run_blocked"), "blocked");
assert.equal(transitionRunState("awaiting-plan-approval", "run_failed"), "failed");
assert.equal(transitionRunState("planning", "plan_generated"), "awaiting-plan-approval");
assert.equal(transitionRunState("judging", "run_retrying"), "queued");
assert.equal(resolveFinalStatus({
  machineGate: { status: "pass", reasons: [], assertionFailures: [], evidenceComplete: true }
}), "pass");
assert.equal(resolveFinalStatus({
  machineGate: { status: "pass", reasons: [], assertionFailures: [], evidenceComplete: true },
  judgeRecommendation: { status: "needs-human-review", summary: "uncertain", evidenceRefs: [] }
}), "needs-human-review");
assert.equal(resolveFinalStatus({
  machineGate: { status: "fail", reasons: ["assertion"], assertionFailures: ["amount"], evidenceComplete: true },
  judgeRecommendation: { status: "pass", summary: "wrong", evidenceRefs: [] },
  humanDecision: { status: "approved", actor: "reviewer", reason: "override", decidedAt: "2026-07-14T00:00:00.000Z" }
}), "fail");
assert.equal(defaultResourceBudget.maxAttempts, 2);
const browserDecisionWithReason = browserActionDecisionSchema.parse({
  schemaVersion: "1.0",
  decisionId: "decision-transient",
  runId: "run-1",
  attemptId: "attempt-1",
  observationId: "observation-1",
  status: "blocked",
  reasonCode: "transient-observation",
  summary: "The page is still settling.",
  actions: [],
  oracles: [],
  evidenceRefs: [],
  createdAt: "2026-07-14T00:00:00.000Z"
});
assert.equal(browserDecisionWithReason.reasonCode, "transient-observation");
assert.equal(browserAgentActionSchema.safeParse({
  actionId: "action-observe",
  action: "observe-page",
  runId: "run-1",
  attemptId: "attempt-1",
  coverageItemId: "coverage-1",
  sourceObservationId: "observation-1",
  sourcePageFingerprint: "a".repeat(64),
  purpose: "legacy no-op",
  expectedChange: "none",
  oracleIds: [],
  risk: "low",
  timeoutMs: 1000
}).success, false);
const assistantMessage = agentMessageSchema.parse({
  id: "message-1",
  runId: "run-1",
  role: "assistant",
  content: "需要测试账号后才能继续。",
  createdAt: "2026-07-29T00:00:00.000Z",
  reasoningSummary: {
    phase: "waiting-user",
    observations: ["登录接口返回 401"],
    assessment: "缺少测试账号，不是产品断言失败。",
    nextStep: "绑定加密凭据后恢复当前运行。",
    userAction: "请配置测试账号。",
    confidence: "high"
  }
});
assert.equal(assistantMessage.reasoningSummary?.phase, "waiting-user");
assert.throws(() => agentMessageSchema.parse({
  ...assistantMessage,
  reasoningSummary: { ...assistantMessage.reasoningSummary, assessment: "" }
}));
assert.throws(() => projectManifestSchema.parse({ schemaVersion: "1.0", projectId: "demo", workspaceRoot: ".", commandAllowlist: ["npm"], commands: { start: { executable: "npm && rm", args: [] } } }));
assert.throws(() => createRunRequestSchema.parse({ idempotencyKey: "llm-without-model", projectId: "demo", input: { plannerMode: "llm" } }));
assert.throws(() => createRunRequestSchema.parse({ idempotencyKey: "cached-benchmark", projectId: "demo", input: { experimentId: "exp", repetition: 1, cachePolicy: "auto" } }));
const budgetedRun = createRunRequestSchema.parse({ idempotencyKey: "budgeted", projectId: "demo", input: {} });
assert.equal(budgetedRun.input.llmBudget.maxPlannerCalls, 2);
assert.equal(budgetedRun.input.llmBudget.maxBrowserActionCalls, 12);
assert.equal(budgetedRun.input.llmBudget.maxJudgeCalls, 1);
assert.equal(budgetedRun.input.llmBudget.maxTriageCalls, 1);
assert.equal(budgetedRun.input.llmBudget.maxRepairCallsPerRound, 2);
assert.equal(budgetedRun.input.llmBudget.maxSemanticRepairAttempts, 1);
assert.equal(budgetedRun.input.llmBudget.totalTimeoutMs, 120_000);
assert.equal(budgetedRun.input.llmBudget.maxTotalTokens, 12_000);
assert.equal(budgetedRun.input.llmBudget.requestTimeoutMs, 30_000);
const dynamicBrowserRun = createRunRequestSchema.parse({
  idempotencyKey: "dynamic-browser",
  projectId: "external-project",
  input: {
    dynamicBrowser: true,
    coverageMode: "full",
    coverageInventory: [{
      id: "flow-auth",
      title: "登录业务路径",
      status: "executable",
      kind: "page",
      target: "pages/auth",
      sourceNodeIds: ["node-login", "node-session"],
      sourceCount: 2
    }]
  }
});
assert.equal(dynamicBrowserRun.input.dynamicBrowser, true);
assert.equal(dynamicBrowserRun.input.coverageInventory[0]?.sourceCount, 2);
assert.equal(dynamicBrowserRun.input.coverageInventory[0]?.status, "executable");
assert.throws(() => createRunRequestSchema.parse({ idempotencyKey: "bad-budget", projectId: "demo", input: { llmBudget: { maxPlannerCalls: 3 } } }));
assert.equal(fixtureVariantIdSchema.parse("fxv_0123456789abcdef"), "fxv_0123456789abcdef");
assert.throws(() => fixtureVariantIdSchema.parse("wrong-status"));
assert.throws(() => createRunRequestSchema.parse({ idempotencyKey: "semantic-fixture-selector", projectId: "demo", input: { fixtureVariantId: "permission-bypass" } }));
assert.throws(() => planProvenanceSchema.parse({ source: "llm", promptVersion: "v1", model: "model", llmCallId: "call", compilationStatus: "validated", fallbackReason: "silent fallback" }));
assert.deepEqual(planProvenanceSchema.parse({ source: "llm", promptVersion: "v1", compilationStatus: "rejected", fallbackReason: "provider_http_401" }), {
  source: "llm", promptVersion: "v1", compilationStatus: "rejected", fallbackReason: "provider_http_401"
});
assert.throws(() => planProvenanceSchema.parse({ source: "llm", promptVersion: "v1", compilationStatus: "rejected" }));
assert.deepEqual(actionDslSchema.parse({ action: "select", selectorRef: "selectLabel", valueRef: "selectValue" }), {
  action: "select", selectorRef: "selectLabel", valueRef: "selectValue"
});
assert.throws(() => actionDslSchema.parse({ action: "select", selectorRef: "selectLabel" }));
assert.deepEqual(actionDslSchema.parse({ action: "api-request", operationId: "listOrders", oracleId: "orders-200" }), {
  action: "api-request", operationId: "listOrders", oracleId: "orders-200"
});
assert.throws(() => actionDslSchema.parse({ action: "api-request", operationId: "https://attacker.invalid", oracleId: "unsafe" }));
const structuredManifest = projectManifestSchema.parse({
  schemaVersion: "1.0",
  projectId: "structured",
  workspaceRoot: ".",
  commands: {},
  commandAllowlist: ["node"],
  apiOperations: [{ operationId: "listOrders", method: "GET", pathTemplate: "/api/orders", allowedStatusCodes: [200] }],
  dataSources: [{
    id: "db",
    kind: "sqlite",
    connectionEnv: "TEST_DB",
    readOnly: true,
    queryTemplates: [{ id: "orders", statement: "SELECT id FROM orders", expectation: { kind: "non-empty" } }]
  }],
  backgroundTasks: [{
    id: "report",
    statusOperationId: "listOrders",
    terminalStates: ["completed"],
    successStates: ["completed"]
  }],
  execution: { mode: "oci", image: "node:22-bookworm-slim" }
});
assert.equal(structuredManifest.backgroundTasks[0]?.statusField, "status");
const failedProductSummary = runOutcomeSummaryV2Schema.parse({
  schemaVersion: "2.0", schedulingCompleted: true, executionStarted: true, executionSucceeded: true,
  requirementCovered: true, requirementPassed: false, artifactIntegrityVerified: true, evidenceGrounded: true,
  gateEligible: true, machineGate: { status: "fail", reasons: ["assertion"], assertionFailures: ["permission"], evidenceComplete: true }, finalStatus: "fail"
});
assert.equal(failedProductSummary.requirementCovered, true);
assert.equal(failedProductSummary.requirementPassed, false);
assert.throws(() => runOutcomeSummaryV2Schema.parse({ ...failedProductSummary, requirementCovered: false, requirementPassed: true }));
assert.throws(() => runOutcomeSummaryV2Schema.parse({ ...failedProductSummary, requirementPassed: false, finalStatus: "pass" }));
assert.equal(llmCallSchema.parse({
  id: "llm-1", purpose: "judging", provider: "openai-compatible", model: "codex", startedAt: "2026-07-19T00:00:00.000Z",
  durationMs: 12, status: "failed", usage: {}, errorCode: "provider_responses_incomplete",
  transportAttempts: [1, 2, 3].map((attempt) => ({ attempt, mode: attempt === 3 ? "non-stream" : "stream", status: "failed", startedAt: "2026-07-19T00:00:00.000Z", durationMs: 4, errorCode: "provider_responses_incomplete", bytesReceived: 32, eventTypes: ["response.output_text.delta"] }))
}).transportAttempts?.length, 3);
assert.throws(() => knowledgeClaimSchema.parse({
  id: "runtime-without-source",
  statement: "The page is available.",
  status: "observed",
  domain: "runtime",
  sourceRefs: [],
  confidence: 1
}));
assert.equal(knowledgeClaimSchema.parse({
  id: "runtime-with-source",
  statement: "The page returned HTTP 200.",
  status: "observed",
  domain: "runtime",
  sourceRefs: ["evidence-1"],
  confidence: 1
}).status, "observed");
assert.throws(() => llmKnowledgeContextSchema.parse({
  schemaVersion: "1.0",
  purpose: "assistant",
  claims: [
    { id: "duplicate", statement: "one", status: "retrieved", domain: "project-static", sourceRefs: ["file:a"], confidence: 1 },
    { id: "duplicate", statement: "two", status: "retrieved", domain: "project-static", sourceRefs: ["file:b"], confidence: 1 }
  ],
  allowedCapabilities: [],
  allowedTools: [],
  unknowns: [],
  untrustedInputKinds: [],
  generatedAt: "2026-07-28T00:00:00.000Z"
}));
assert.equal(knowledgeBoundaryOutputSchema.parse({
  schemaVersion: "2.0",
  factsUsed: ["runtime-with-source"],
  inferences: [],
  assumptions: [],
  unknowns: [],
  toolRequests: [],
  blockingQuestions: [],
  proposedActions: []
}).factsUsed[0], "runtime-with-source");
assert.equal(normalizeKnowledgeBoundaryOutput({
  factsUsed: ["runtime-with-source"],
  inferences: [],
  assumptions: [],
  unknowns: [],
  requestedTools: ["read-run-evidence"],
  blockingQuestions: []
}).toolRequests[0]?.tool, "read-run-evidence");
console.log("contracts tests passed");
