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
import { appendEvidence, readEvidence, readRunBundle, setReportsDir } from "../src/evidenceStore.js";
import {
  acquireBrowserControl,
  closeBrowserAgentSession,
  dynamicBrowserScenarioId,
  ensureBrowserAgentSession,
  executeUserBrowserInput,
  finalizeBrowserAgentTrace,
  observeManagedBrowserSession,
  releaseBrowserControl
} from "../src/browser-agent/sessionManager.js";
import { executeBrowserAgentAction } from "../src/browser-agent/actionBroker.js";
import { readBrowserArtifacts } from "../src/browser-agent/store.js";
import { finalizeProofBundle } from "../src/proof/proofBundleService.js";
import { artifactKindToIntegrityKind } from "../src/artifactIntegrity.js";
import { persistDynamicBrowserResult } from "../src/browser-agent/resultBundle.js";

export async function testBrowserAgentLoop() {
  const reports = await mkdtemp(path.join(tmpdir(), "ato-browser-agent-"));
  setReportsDir(reports);
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><body><a href="#help">Help</a><input data-testid="test-account" type="text" aria-label="Test account"><button data-testid="advance" onclick="document.querySelector('#state').textContent='done'">Advance</button><div id="state">waiting</div></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const runId = `browser-agent-test-${Date.now()}`;
  try {
    await ensureBrowserAgentSession({ runId, attemptId: "attempt-1", url, routes: [{ id: "root", path: url }] });
    const observation = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    assert(observation.screenshotArtifactId, "initial observation should commit a screenshot artifact before any LLM action");
    assert.equal(observation.evidenceRefs.length, 2, "initial observation should expose screenshot and DOM evidence to the decision layer");
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
    // The Workbench user and the browser Agent must operate the exact same
    // Playwright page. Exercise the public control lease and coordinate input
    // path instead of opening a second iframe/context: focus the observed
    // input, type as the user, return control, then let the Agent re-observe
    // the resulting state.
    const userObservation = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    const userAccount = userObservation.controls.find((control) => control.testId === "test-account");
    assert(userAccount?.boundingBox, "user takeover requires the same observed control geometry shown by Workbench");
    await acquireBrowserControl(runId, "user", { force: true });
    await executeUserBrowserInput({
      runId,
      kind: "click",
      x: userAccount.boundingBox.x + userAccount.boundingBox.width / 2,
      y: userAccount.boundingBox.y + userAccount.boundingBox.height / 2
    });
    await executeUserBrowserInput({ runId, kind: "press", key: "Space" });
    await releaseBrowserControl(runId, "user");
    const returnedToAgent = await observeManagedBrowserSession({ runId, coverageItemId: "coverage-1" });
    assert.equal(
      returnedToAgent.controls.find((control) => control.testId === "test-account")?.valueState,
      "nonempty",
      "user input must remain visible after the same session is returned to the Agent"
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
    await closeBrowserAgentSession(runId).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setReportsDir(undefined);
  }
}
