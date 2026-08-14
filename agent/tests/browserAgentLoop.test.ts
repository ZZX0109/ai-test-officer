import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  browserActionDecisionSchema,
  coverageItemSchema,
  runOutcomeSummaryV2Schema
} from "@ai-test-officer/contracts";
import { browserActionCompletesBusinessPath, browserPathResultsAreGrounded, coverageItemRepresentsAuthentication } from "../src/agentGraphService.js";
import { appendEvidence, readEvidence, readRunBundle, setReportsDir } from "../src/evidenceStore.js";
import {
  acquireBrowserControl,
  acquireBrowserControlWhenAvailable,
  closeBrowserAgentSession,
  dynamicBrowserScenarioId,
  ensureBrowserAgentSession,
  executeUserBrowserInput,
  finalizeBrowserAgentTrace,
  observeManagedBrowserSession,
  releaseBrowserControl,
  subscribeBrowserLiveFrames
} from "../src/browser-agent/sessionManager.js";
import { browserActionPolicy, executeBrowserAgentAction } from "../src/browser-agent/actionBroker.js";
import { compactBrowserObservationForDecision, parseBrowserDecisionProviderOutput } from "../src/browser-agent/llmDecision.js";
import { readBrowserArtifacts } from "../src/browser-agent/store.js";
import { finalizeProofBundle } from "../src/proof/proofBundleService.js";
import { artifactKindToIntegrityKind } from "../src/artifactIntegrity.js";
import { persistDynamicBrowserResult } from "../src/browser-agent/resultBundle.js";

export async function testBrowserAgentLoop() {
  assert.equal(coverageItemRepresentsAuthentication({ flowId: "auth:sign-in", module: "用户登录" }), true);
  assert.equal(coverageItemRepresentsAuthentication({ flowId: "order:create", module: "创建订单" }), false);
  assert.equal(coverageItemRepresentsAuthentication({ flowId: "andflow-open-backstage", module: "登录后打开 Backstage" }), false,
    "authentication as a prerequisite must not complete the downstream business path");
  assert.equal(browserPathResultsAreGrounded([
    { status: "failed", errorCode: "browser_control_binding_stale", oracleResults: [] },
    { status: "completed", oracleResults: [{ passed: true }] }
  ]), true);
  assert.equal(browserPathResultsAreGrounded([
    { status: "completed", oracleResults: [{ passed: false }] }
  ]), false);
  assert.equal(browserActionCompletesBusinessPath({
    status: "completed", oracleResults: [{ oracleId: "oracle_business_dom_change", passed: true }]
  }), true, "a verified non-login action completes one dynamic business path");
  assert.equal(browserActionCompletesBusinessPath({
    status: "completed", oracleResults: [{ oracleId: "oracle_login_submit_changes_page", passed: true }]
  }), false, "login proof is a prerequisite and must not complete an unrelated business path");
  const reports = await mkdtemp(path.join(tmpdir(), "ato-browser-agent-"));
  setReportsDir(reports);
  assert.equal(browserActionPolicy({
    actionId: "policy-route", action: "navigate-route", runId: "policy-run", attemptId: "policy-attempt",
    coverageItemId: "policy-coverage", sourceObservationId: "policy-observation", sourcePageFingerprint: "a".repeat(64),
    routeId: "registered-route", purpose: "open a registered application route", expectedChange: "route changes",
    oracleIds: [], risk: "high", timeoutMs: 5_000
  }).allowed, true, "registered routes should rely on the deterministic origin allowlist instead of model risk wording");
  assert.equal(browserActionPolicy({
    actionId: "policy-credential", action: "fill-control", runId: "policy-run", attemptId: "policy-attempt",
    coverageItemId: "policy-coverage", sourceObservationId: "policy-observation", sourcePageFingerprint: "a".repeat(64),
    controlId: "credential-control", valueRef: "credential.username", purpose: "fill a saved account",
    expectedChange: "field becomes nonempty", oracleIds: [], risk: "medium", timeoutMs: 5_000
  }).confirmation, true, "credentials without a project-scoped authorization must remain gated");
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/slow") {
      response.end(`<!doctype html><html><body><div id="root"></div><script>setTimeout(() => { document.querySelector('#root').innerHTML='<button data-testid="late-control">Ready</button>' }, 800)</script></body></html>`);
      return;
    }
    response.end(`<!doctype html><html><body><a href="#help">Help</a><div id="login"><input data-testid="test-account" type="text" aria-label="Test account"><button data-testid="delayed-login" onclick="setTimeout(() => { document.querySelector('#login').remove(); document.querySelector('#state').textContent='signed-in' }, 800)">Login</button></div><button data-testid="advance" onclick="document.querySelector('#state').textContent='done'">Advance</button><div id="state">waiting</div></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const runId = `browser-agent-test-${Date.now()}`;
  const slowRunId = `${runId}-slow`;
  try {
    await ensureBrowserAgentSession({ runId: slowRunId, attemptId: "attempt-slow", url: `${url}slow`, routes: [{ id: "root", path: `${url}slow` }] });
    const slowObservation = await observeManagedBrowserSession({ runId: slowRunId, coverageItemId: "coverage-slow" });
    assert(
      slowObservation.controls.some((control) => control.testId === "late-control"),
      "initial session readiness must wait for an asynchronously mounted SPA control before the first Agent decision"
    );
    await closeBrowserAgentSession(slowRunId);
    await ensureBrowserAgentSession({ runId, attemptId: "attempt-1", url, routes: [{ id: "root", path: url }] });
    let unsubscribeLive: (() => Promise<void>) | undefined;
    const liveFrame = await Promise.race([
      new Promise<Buffer>((resolve, reject) => {
        void subscribeBrowserLiveFrames(runId, (frame) => resolve(frame)).then((unsubscribe) => {
          unsubscribeLive = unsubscribe;
        }).catch(reject);
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("browser_live_stream_timeout")), 5_000))
    ]);
    assert(liveFrame.length > 1_000, "shared Workbench canvas must receive the same Playwright compositor frames");
    await unsubscribeLive?.();
    const observation = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    assert(observation.screenshotArtifactId, "initial observation should commit a screenshot artifact before any LLM action");
    assert.equal(observation.evidenceRefs.length, 2, "initial observation should expose screenshot and DOM evidence to the decision layer");
    const compactObservation = compactBrowserObservationForDecision({
      ...observation,
      bodyTextSample: "body ".repeat(2_000),
      accessibilityTree: "tree ".repeat(3_000),
      controls: Array.from({ length: 140 }, (_, index) => ({
        ...observation.controls[index % observation.controls.length]!,
        controlId: `compact-control-${index}`,
        accessibleName: `control ${index} ${"name ".repeat(100)}`
      }))
    });
    assert((compactObservation.bodyTextSample?.length ?? 0) <= 2_000);
    assert((compactObservation.accessibilityTree?.length ?? 0) <= 4_000);
    assert.equal(compactObservation.controls.length, 80, "LLM page decisions must receive a bounded, action-oriented control list");
    const providerDecision = {
      status: "act",
      summary: "click the observed control",
      actions: [{
        action: "click-control",
        controlId: "control_typo",
        valueRef: null,
        checked: null,
        key: null,
        state: null,
        routeId: null,
        purpose: "exercise semantic repair",
        expectedChange: "the page changes",
        oracleIds: ["oracle-dom"],
        risk: "low",
        timeoutMs: 5_000
      }],
      oracles: [{
        id: "oracle-dom",
        type: "dom-change",
        description: "the DOM changes",
        controlId: null,
        operator: null,
        expected: "changed",
        operationId: null,
        expectedStatus: null
      }],
      evidenceRefs: observation.evidenceRefs,
      userQuestion: null,
      knowledge: {
        schemaVersion: "2.0",
        factsUsed: [], inferences: [], assumptions: [], unknowns: [],
        toolRequests: [], blockingQuestions: [], proposedActions: []
      }
    };
    assert.throws(
      () => parseBrowserDecisionProviderOutput(JSON.stringify(providerDecision), observation),
      /browser_llm_unknown_control/,
      "unknown runtime bindings must fail inside the semantic-repair boundary"
    );
    assert.equal(
      observation.controls.find((control) => control.accessibleName === "Help")?.kind,
      "link",
      "anchor elements must be normalised to the public link control kind"
    );
    const button = observation.controls.find((control) => control.testId === "advance");
    assert(button, "observer should expose a stable test-id control");
    const result = await executeBrowserAgentAction({
      action: {
        actionId: "action-1",
        action: "click-control",
        runId,
        attemptId: "attempt-1",
        coverageItemId: "coverage-1",
        sourceObservationId: observation.observationId,
        sourcePageFingerprint: observation.pageFingerprint,
        controlId: button.controlId,
        purpose: "advance the deterministic page state",
        expectedChange: "the state text becomes done",
        oracleIds: ["oracle-1"],
        risk: "low",
        timeoutMs: 5_000
      },
      oracles: [{ id: "oracle-1", type: "text", operator: "contains", expected: "done", description: "page reports completion" }],
      resolveValue: async () => { throw new Error("unexpected_value_resolution"); }
    });
    assert.equal(result.status, "completed");
    assert.equal(result.oracleResults[0]?.passed, true);
    assert(result.evidenceRefs.length >= 5, "action should retain before/after and oracle evidence");
    const afterClick = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    const account = afterClick.controls.find((control) => control.testId === "test-account");
    assert(account, "observer should expose a fillable test input");
    const fillResult = await executeBrowserAgentAction({
      action: {
        actionId: "action-2",
        action: "fill-control",
        runId,
        attemptId: "attempt-1",
        coverageItemId: "coverage-1",
        sourceObservationId: afterClick.observationId,
        sourcePageFingerprint: afterClick.pageFingerprint,
        controlId: account.controlId,
        valueRef: "testData.account",
        purpose: "fill a non-sensitive test field",
        expectedChange: "the input transitions to a nonempty state",
        oracleIds: ["oracle-input-filled"],
        risk: "low",
        timeoutMs: 5_000
      },
      oracles: [{ id: "oracle-input-filled", type: "input-state", controlId: account.controlId, expected: "nonempty", description: "input contents remain private while its filled state is verified" }],
      resolveValue: async () => "safe-test-value"
    });
    assert.equal(fillResult.status, "completed");
    assert.equal(fillResult.oracleResults[0]?.passed, true, "input-state oracle should verify a fill without persisting its contents");
    const beforeDelayedLogin = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    const delayedLogin = beforeDelayedLogin.controls.find((control) => control.testId === "delayed-login");
    const loginAccount = beforeDelayedLogin.controls.find((control) => control.testId === "test-account");
    assert(delayedLogin && loginAccount, "delayed SPA login fixture should expose its form controls");
    const delayedLoginResult = await executeBrowserAgentAction({
      action: {
        actionId: "action-delayed-login",
        action: "click-control",
        runId,
        attemptId: "attempt-1",
        coverageItemId: "coverage-1",
        sourceObservationId: beforeDelayedLogin.observationId,
        sourcePageFingerprint: beforeDelayedLogin.pageFingerprint,
        controlId: delayedLogin.controlId,
        purpose: "submit a SPA form whose success renders asynchronously",
        expectedChange: "the login field disappears after the async response",
        oracleIds: ["oracle-login-hidden"],
        risk: "low",
        timeoutMs: 5_000
      },
      oracles: [{ id: "oracle-login-hidden", type: "element-state", controlId: loginAccount.controlId, expected: "hidden", description: "the login field disappears only after the async transition" }],
      resolveValue: async () => { throw new Error("unexpected_value_resolution"); }
    });
    assert.equal(delayedLoginResult.status, "completed");
    assert.equal(delayedLoginResult.oracleResults[0]?.passed, true, "the after observation must wait for the promised SPA state change instead of sampling a stale login DOM");
    // The Workbench user and the browser Agent must operate the exact same
    // Playwright page. Exercise the public control lease and coordinate input
    // path instead of opening a second iframe/context: focus the observed
    // input, type as the user, return control, then let the Agent re-observe
    // the resulting state.
    const userObservation = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    const advanceControl = userObservation.controls.find((control) => control.testId === "advance");
    assert(advanceControl?.boundingBox, "user takeover requires the same observed control geometry shown by Workbench");
    await acquireBrowserControl(runId, "user", { force: true });
    let agentResumed = false;
    const pendingAgentControl = acquireBrowserControlWhenAvailable(runId, "agent", { timeoutMs: 2_000, pollMs: 20 })
      .then(() => { agentResumed = true; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(agentResumed, false, "an explicit user takeover must pause the Agent instead of failing or stealing the lease");
    await executeUserBrowserInput({
      runId,
      kind: "click",
      x: advanceControl.boundingBox.x + advanceControl.boundingBox.width / 2,
      y: advanceControl.boundingBox.y + advanceControl.boundingBox.height / 2
    });
    await releaseBrowserControl(runId, "user");
    await pendingAgentControl;
    assert.equal(agentResumed, true, "returning control must resume the pending Agent operation in the same session");
    const returnedToAgent = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    assert.equal(
      returnedToAgent.bodyTextSample.includes("done"),
      true,
      "user interaction must remain visible after the same session is returned to the Agent"
    );
    const traceArtifact = await finalizeBrowserAgentTrace(runId);
    assert(traceArtifact);
    await appendEvidence(runId, {
      type: "trace",
      title: "Dynamic browser attempt trace",
      scenarioId: dynamicBrowserScenarioId(runId),
      attemptId: "attempt-1",
      attempt: 1,
      artifactIds: [traceArtifact.id],
      file: traceArtifact.storageUri,
      payload: { browserAgent: true }
    });
    const artifacts = await readBrowserArtifacts(runId);
    assert(new Set(artifacts.map((artifact) => artifact.kind)).has("screenshot"));
    assert(new Set(artifacts.map((artifact) => artifact.kind)).has("dom"));
    assert(new Set(artifacts.map((artifact) => artifact.kind)).has("operation-log"));
    assert(new Set(artifacts.map((artifact) => artifact.kind)).has("trace"));
    assert(artifacts.every((artifact) => artifact.attemptId === "attempt-1"));
    const evidence = await readEvidence(runId);
    const evidenceByArtifact = new Map(evidence.flatMap((item) => (item.artifactIds ?? []).map((artifactId) => [artifactId, item.id] as const)));
    const artifactIntegrity = {
      id: `${runId}_integrity`,
      runId,
      generatedAt: new Date().toISOString(),
      artifactRoot: "/artifacts" as const,
      summary: { total: artifacts.length, present: artifacts.length, missing: 0, unreadable: 0, pathEscapes: 0, selfReferences: 0, hashMismatches: 0, hashed: artifacts.length },
      items: artifacts.map((artifact) => ({
        id: artifact.id,
        artifactUri: artifact.storageUri,
        kind: artifactKindToIntegrityKind(artifact.kind),
        evidenceId: evidenceByArtifact.get(artifact.id),
        status: "present" as const,
        origin: artifact.origin,
        sizeBytes: artifact.integrity.sizeBytes,
        sha256: artifact.integrity.sha256
      }))
    };
    const finalized = finalizeProofBundle({
      draft: { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [] },
      runId,
      scenarioId: dynamicBrowserScenarioId(runId),
      attemptId: "attempt-1",
      evidence,
      artifactsV2: artifacts,
      artifactIntegrity,
      requiredArtifactKinds: ["screenshot", "dom", "operation-log", "trace"],
      machineGate: { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [] },
      gateEligibleFacts: { executionSucceeded: true, requirementCovered: true }
    });
    assert.equal(finalized.machineGate.status, "pass");
    const outcomeSummary = runOutcomeSummaryV2Schema.parse({
      schemaVersion: "2.0",
      schedulingCompleted: true,
      executionStarted: true,
      executionSucceeded: true,
      requirementCovered: true,
      requirementPassed: true,
      artifactIntegrityVerified: finalized.verdict.artifactIntegrityVerified,
      evidenceGrounded: finalized.verdict.evidenceGrounded,
      gateEligible: finalized.gateEligible,
      machineGate: finalized.machineGate,
      finalStatus: finalized.machineGate.status
    });
    const decision = browserActionDecisionSchema.parse({
      schemaVersion: "1.0",
      decisionId: "decision-1",
      runId,
      attemptId: "attempt-1",
      observationId: observation.observationId,
      status: "act",
      summary: "Advance the state.",
      actions: [{
        actionId: "action-1",
        action: "click-control",
        runId,
        attemptId: "attempt-1",
        coverageItemId: "coverage-1",
        sourceObservationId: observation.observationId,
        sourcePageFingerprint: observation.pageFingerprint,
        controlId: button.controlId,
        purpose: "advance the deterministic page state",
        expectedChange: "the state text becomes done",
        oracleIds: ["oracle-1"],
        risk: "low",
        timeoutMs: 5_000
      }],
      oracles: [{ id: "oracle-1", type: "text", operator: "contains", expected: "done", description: "page reports completion" }],
      evidenceRefs: observation.evidenceRefs,
      createdAt: new Date().toISOString()
    });
    const coverage = coverageItemSchema.parse({
      schemaVersion: "1.0",
      id: "coverage-1",
      runId,
      flowId: "flow-1",
      module: "Advance flow",
      surface: "page",
      risk: "high",
      actionPathIds: ["action-1"],
      oracleIds: ["oracle-1"],
      requiredEvidenceKinds: ["screenshot", "dom", "operation-log", "trace"],
      disposition: "executed",
      dispositionReason: "Dynamic browser action and oracle completed",
      scenarioId: dynamicBrowserScenarioId(runId),
      attemptId: "attempt-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await persistDynamicBrowserResult({
      runId,
      requirement: "Advance the page state",
      appUrl: url,
      rawRunInput: {},
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      scenarioId: dynamicBrowserScenarioId(runId),
      attemptId: "attempt-1",
      coverage: [coverage],
      decisions: [decision],
      actionResults: [result],
      evidence,
      artifacts,
      artifactIntegrity,
      machineGate: finalized.machineGate,
      outcomeSummary,
      proof: finalized
    });
    const bundle = await readRunBundle(runId);
    assert.equal(bundle.result.finalStatus, "pass");
    assert((bundle.conclusions ?? []).some((conclusion) => conclusion.claimType === "final-status"));
    assert(bundle.evidenceManifest?.evidenceSetRoot, "dynamic run bundle should have a signed/hashable evidence manifest");
  } finally {
    await closeBrowserAgentSession(slowRunId).catch(() => undefined);
    await closeBrowserAgentSession(runId).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setReportsDir(undefined);
  }
}
