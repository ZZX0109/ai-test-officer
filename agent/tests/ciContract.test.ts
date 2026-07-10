import assert from "node:assert/strict";
import {
  buildCiAnnotationMarkdown,
  buildCiErrorGateReport,
  buildCiGateReport,
  buildCiJUnitReport,
  buildCiPrAnnotations,
  buildCiUploadManifest,
  computeCiGateDecision,
  computeCiExitCode
} from "../src/ciContract.js";
import type { CommitCheckResult } from "../src/types.js";

function check(overrides: Partial<CommitCheckResult>): CommitCheckResult {
  return {
    id: "ci_test",
    createdAt: new Date().toISOString(),
    context: { requirement: "", diff: "", bugTicket: "", sourceContexts: [], sources: [] },
    analysis: {
      id: "analysis",
      createdAt: new Date().toISOString(),
      sources: [],
      changedAreas: [],
      risks: [],
      scenarioCandidates: [],
      recommendedTrigger: "commit"
    },
    plan: { sessionName: "test", risks: [], levels: [] },
    planSource: "test",
    ...overrides
  };
}

function run(releaseJudge: "pass" | "needs_review" | "fail", runtimeStatus?: "failed") {
  return {
    id: "run",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    verdict: releaseJudge === "pass" ? "continue" as const : "hold_for_review" as const,
    summary: "test",
    steps: [],
    network: [],
    console: [],
    assertions: [],
    evidence: [],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue" as const, reason: "test" },
    reflectionNote: "test",
    conflictPacket: { status: "not_triggered" as const, reason: "test", evidenceRefs: [] },
    failureAttributions: [],
    runtimeStatus: runtimeStatus ? { projectId: "p", status: runtimeStatus } : undefined,
    judgeReport: {
      source: "deterministic_judge" as const,
      executionMode: "deterministic" as const,
      llmStatus: "not_configured" as const,
      policyVersion: "test",
      createdAt: new Date().toISOString(),
      planJudge: { layer: "plan" as const, title: "plan", verdict: "pass" as const, summary: "pass", findings: [] },
      evidenceJudge: { layer: "evidence" as const, title: "evidence", verdict: "pass" as const, summary: "pass", findings: [] },
      releaseJudge: { layer: "release" as const, title: "release", verdict: releaseJudge, summary: releaseJudge, findings: [] }
    },
    reportFile: "/artifacts/runs/run/report.json",
    runBundleFile: "/artifacts/runs/run/run_bundle.json"
  };
}

function flakyRun() {
  return {
    ...run("needs_review"),
    aggregatedVerdict: { runCount: 3, failedAssertionCount: 1, flaky: true, verdict: "needs_review" as const, reason: "flaky" }
  };
}

export function testCiContract() {
  assert.equal(computeCiExitCode(check({ run: run("pass") })), 0);
  assert.equal(computeCiExitCode(check({ run: run("fail") })), 1);
  assert.equal(computeCiExitCode(check({ skippedReason: "no harness" })), 2);
  assert.equal(computeCiExitCode(check({ run: run("needs_review") })), 2);
  assert.equal(computeCiExitCode(check({ run: run("needs_review") }), { strictGate: true }), 1);
  assert.equal(computeCiExitCode(check({ run: run("pass", "failed") })), 3);
  assert.equal(computeCiExitCode(check({ selectedScenarioId: "legacy_login", run: run("fail") }), {
    quarantinedScenarios: ["legacy_login"]
  }), 2);
  assert.equal(computeCiExitCode(check({ selectedScenarioId: "legacy_login", run: run("fail") }), {
    quarantinedScenarios: ["other_scenario"]
  }), 1);
  assert.equal(computeCiExitCode(check({ run: flakyRun() })), 2);
  assert.equal(computeCiExitCode(check({ run: flakyRun() }), { flakyMode: "fail" }), 1);
  const quarantineDecision = computeCiGateDecision(check({ selectedScenarioId: "legacy_login", run: run("fail") }), {
    quarantinedScenarios: ["legacy_login"]
  });
  assert.equal(quarantineDecision.quarantined, true);
  assert.deepEqual(quarantineDecision.policyReasons, ["quarantined_scenario:legacy_login"]);
  const runtimeGate = buildCiErrorGateReport({
    id: "error_runtime",
    strictGate: true,
    exitCode: 3,
    errorMessage: "runtime_unavailable:health_timeout"
  });
  assert.equal(runtimeGate.exitMeaning, "runtime_unavailable");
  assert.equal(runtimeGate.verdict, "error");
  assert.equal(runtimeGate.strictGate, true);
  assert.equal(buildCiPrAnnotations(runtimeGate)[0].annotation_level, "failure");
  assert.match(buildCiAnnotationMarkdown(runtimeGate), /runtime_unavailable:health_timeout/);
  const quarantinedGate = buildCiGateReport(check({ selectedScenarioId: "legacy_login", run: run("fail") }), {
    quarantinedScenarios: ["legacy_login"]
  });
  assert.equal(quarantinedGate.exitCode, 2);
  assert.equal(quarantinedGate.quarantined, true);
  assert.match(buildCiAnnotationMarkdown(quarantinedGate), /quarantined_scenario:legacy_login/);
  assert.match(buildCiJUnitReport(buildCiGateReport(check({ run: run("pass") }), false)), /failures="0" errors="0" skipped="0"/);
  assert.match(buildCiJUnitReport(buildCiGateReport(check({ run: run("needs_review") }), false)), /skipped="1"/);
  assert.match(buildCiJUnitReport(quarantinedGate), /quarantined_scenario:legacy_login/);
  assert.match(buildCiJUnitReport(runtimeGate), /<error message="runtime_unavailable">runtime_unavailable:health_timeout<\/error>/);
  assert.deepEqual(
    buildCiUploadManifest(["reports/run-bundle.zip", "reports/run-bundle.zip"]).files,
    [
      "reports/gate.json",
      "reports/junit.xml",
      "reports/pr-annotation.md",
      "reports/pr-annotations.json",
      "reports/artifact-upload-manifest.json",
      "reports/run-bundle.zip"
    ]
  );
}
