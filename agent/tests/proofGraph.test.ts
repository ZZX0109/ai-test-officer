import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  appendHumanOverrideConclusion,
  buildProofGraph,
  canonicalSha256,
  createEvidenceManifest,
  verifyEvidenceManifest
} from "../src/proofGraph.js";
import { writeRunBundle } from "../src/evidenceStore.js";
import type { RunBundle, VisualRunResult } from "../src/types.js";

function fixtureResult(): VisualRunResult {
  const evidenceId = "evidence-1";
  const artifactId = "artifact-1";
  return {
    id: "run-proof",
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    verdict: "continue",
    summary: "verified",
    steps: [{ stepId: "step-1", title: "assert", status: "passed", action: "assert", details: "ok" }],
    network: [],
    console: [],
    assertions: [{
      name: "page visible",
      passed: true,
      expected: "visible",
      actual: "visible",
      fact: {
        kind: "element.visible",
        target: "main",
        operator: "exists",
        expected: "visible",
        actual: "visible",
        severity: "high",
        evidenceRefs: [evidenceId]
      }
    }],
    evidence: [{
      id: evidenceId,
      runId: "run-proof",
      scenarioId: "scenario-1",
      attemptId: "attempt-1",
      attempt: 1,
      type: "assertion",
      title: "page visible",
      timestamp: "2026-07-28T00:00:00.500Z",
      artifactIds: [artifactId],
      stepId: "step-1",
      payload: {}
    }],
    attempts: [{
      id: "attempt-1",
      runId: "run-proof",
      scenarioId: "scenario-1",
      attempt: 1,
      startedAt: "2026-07-28T00:00:00.000Z",
      finishedAt: "2026-07-28T00:00:01.000Z",
      status: "passed",
      artifactIds: [artifactId]
    }],
    artifactsV2: [{
      schemaVersion: "2.0",
      id: artifactId,
      runId: "run-proof",
      scenarioId: "scenario-1",
      attemptId: "attempt-1",
      attempt: 1,
      stepId: "step-1",
      kind: "screenshot",
      origin: "runtime-captured",
      storageUri: "/artifacts/runs/run-proof/step.png",
      replicaUris: [],
      sequence: 1,
      monotonicOffsetMs: 10,
      integrity: {
        sha256: "a".repeat(64),
        sizeBytes: 10,
        mediaType: "image/png",
        capturedAt: "2026-07-28T00:00:00.500Z",
        collector: { name: "test", version: "1" }
      }
    }],
    loopEvents: [],
    oracles: [{
      id: "oracle-1",
      pathId: "path-1",
      assertionName: "page visible",
      expectedFrom: "requirement",
      preconditions: [],
      action: "open",
      postconditions: ["visible"],
      requiresHumanConfirmation: false,
      evidenceRefs: [evidenceId]
    }],
    riskCoverageMatrix: [{
      riskId: "risk-1",
      riskTitle: "page",
      covered: true,
      passed: true,
      pathIds: ["path-1"],
      evidenceRefs: [evidenceId],
      notes: "covered"
    }],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
    reflectionNote: "",
    conflictPacket: { status: "not_triggered", reason: "none", evidenceRefs: [] },
    failureAttributions: [],
    gateStatus: "pass",
    machineGate: { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [], evidenceComplete: true },
    judgeRecommendation: { status: "pass", summary: "ok", evidenceRefs: [evidenceId] },
    finalStatus: "pass",
    judgeReport: {
      source: "deterministic_judge",
      executionMode: "deterministic",
      llmStatus: "not_configured",
      policyVersion: "proof-test-v1",
      createdAt: "2026-07-28T00:00:01.000Z",
      planJudge: { layer: "plan", title: "plan", verdict: "pass", summary: "ok", findings: [] },
      evidenceJudge: { layer: "evidence", title: "evidence", verdict: "pass", summary: "ok", findings: [] },
      releaseJudge: { layer: "release", title: "release", verdict: "pass", summary: "ok", findings: [] }
    },
    reportFile: "/artifacts/runs/run-proof/report.json",
    runBundleFile: "/artifacts/runs/run-proof/run_bundle.json"
  };
}

export async function testProofGraph() {
  const result = fixtureResult();
  const graph = buildProofGraph(result);
  assert.deepEqual(graph.errors, []);
  assert.equal(graph.conclusions.some((item) => item.claimType === "final-status" && item.proofStatus === "verified"), true);
  assert.equal(graph.proofEdges.some((item) => item.fromType === "evidence" && item.toType === "artifact"), true);

  const collectorStep = fixtureResult();
  collectorStep.artifactsV2![0].stepId = "after-step-1";
  collectorStep.evidence[0].stepId = "after-step-1";
  const collectorGraph = buildProofGraph(collectorStep);
  assert.deepEqual(collectorGraph.errors, []);
  assert.equal(
    collectorGraph.proofNodes.some((item) =>
      item.nodeType === "step"
      && item.id === "after-step-1"
      && item.payload.provenance === "evidence-collector"
    ),
    true
  );

  const crossAttempt = fixtureResult();
  crossAttempt.artifactsV2![0].attemptId = "attempt-2";
  assert.equal(buildProofGraph(crossAttempt).errors.some((error) => error.includes("association_mismatch")), true);

  const bundle = {
    runId: result.id,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    input: { permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } },
    result,
    evidence: result.evidence,
    artifactsV2: result.artifactsV2,
    attempts: result.attempts,
    loopEvents: [],
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix,
    conflictPacket: result.conflictPacket,
    judgeReport: result.judgeReport,
    conclusions: graph.conclusions,
    proofNodes: graph.proofNodes,
    proofEdges: graph.proofEdges,
    coverageItems: graph.coverageItems
  } as RunBundle;
  const manifest = createEvidenceManifest(bundle);
  assert.equal(verifyEvidenceManifest(bundle, manifest).valid, true);
  const changed = structuredClone(bundle);
  changed.result.summary = canonicalSha256("tampered");
  assert.equal(verifyEvidenceManifest(changed, manifest).valid, false);

  await writeRunBundle(bundle);
  const override = await appendHumanOverrideConclusion({
    resultRunId: bundle.runId,
    actor: "reviewer@example.test",
    reason: "Accepted after reviewing the same immutable runtime proof.",
    status: "accepted-risk"
  });
  assert.equal(override.conclusion.claimType, "human-override");
  assert.equal(override.conclusion.supersedesConclusionId, graph.conclusions.find((item) => item.claimType === "final-status")?.conclusionId);
  assert.equal(override.conclusion.evidenceRefs.length > 0, true);
  const repositoryRoot = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
  await rm(path.join(repositoryRoot, "reports", "runs", bundle.runId), { recursive: true, force: true });
}
