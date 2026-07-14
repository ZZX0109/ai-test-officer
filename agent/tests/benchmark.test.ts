import assert from "node:assert/strict";
import { evaluateBenchmark, evaluateExperiment, type BenchmarkCase, type BenchmarkRunRecord, type HumanBenchmarkLabel } from "../src/benchmark.js";

function fixtures() {
  const cases: BenchmarkCase[] = Array.from({ length: 18 }, (_, index) => ({
    id: `bm-${index + 1}`,
    title: `Benchmark ${index + 1}`,
    requirementId: `REQ-${index + 1}`,
    requirement: "A real requirement",
    projectProfile: "fixture",
    status: "awaiting_agent_runs"
  }));
  const labels: HumanBenchmarkLabel[] = cases.map((item) => ({
    benchmarkId: item.id,
    verdict: "pass",
    requiredEvidenceTypes: ["screenshot", "dom"],
    expectedEvidenceRefs: ["ev-1"],
    expectedSuspectFiles: []
  }));
  return { cases, labels };
}

export function testBenchmarkEvaluation() {
  const { cases, labels } = fixtures();
  const pending = evaluateBenchmark(cases, labels, []);
  assert.equal(pending.totalCases, 18);
  assert.equal(pending.awaitingAgentRuns, 18);
  assert.equal(pending.metrics.executionSuccessRate, null);
  assert.equal(pending.lanes.llm.macroF1, null);

  const record: BenchmarkRunRecord = {
    benchmarkId: "bm-1",
    runId: "run-1",
    status: "completed",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:02.000Z",
    requirementCovered: true,
    executionSucceeded: true,
    retryCount: 1,
    initialVerdict: "needs_review",
    deterministic: { verdict: "pass", evidenceRefs: ["ev-1"], status: "passed" },
    llm: { verdict: "pass", evidenceRefs: ["ev-1"], status: "passed", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 } },
    evidence: [{ id: "ev-1", type: "screenshot" }, { id: "ev-2", type: "dom" }],
    attribution: { evidenceRefs: [], suspectFiles: [] }
    ,executionOrigin: "agent-run",
    gateEligible: true,
    agentVersion: "0.2.0",
    configHash: "config-v1",
    targetVersion: "target-v1",
    artifactsV2: [{ id: "artifact-1", type: "screenshot", origin: "runtime-captured", sha256: "a".repeat(64), integrityStatus: "verified" }]
  };
  const completed = evaluateBenchmark(cases, labels, [record]);
  assert.equal(completed.awaitingAgentRuns, 17);
  assert.equal(completed.completedRuns, 1);
  assert.equal(completed.metrics.executionSuccessRate, 1);
  assert.equal(completed.metrics.evidenceCompleteness, 1);
  assert.equal(completed.metrics.averageRunTimeMs, 2000);
  assert.equal(completed.lanes.llm.promptTokens, 10);
  assert.equal(completed.lanes.llm.estimatedCostUsd, 0.001);
  assert.equal(evaluateBenchmark(cases.slice(0, 17), labels.slice(0, 17), []).totalCases, 17);
  assert.equal(evaluateBenchmark(cases, labels, [{ ...record, benchmarkId: "bm-2", executionOrigin: "static-report" }]).completedRuns, 0);

  const experimentRecords: BenchmarkRunRecord[] = [
    { ...record, experimentId: "exp-1", split: "blind", lane: "rules-deterministic", benchmarkId: "bm-1", repetition: 1 },
    ...[1, 2, 3].map((repetition) => ({ ...record, experimentId: "exp-1", split: "blind" as const, lane: "full-llm" as const, modelProfileId: "model-a", benchmarkId: "bm-1", repetition }))
  ];
  const experiment = evaluateExperiment({ experimentId: "exp-1", split: "blind", cases: cases.slice(0, 1), labels: labels.slice(0, 1), records: experimentRecords, plannedRuns: 4, thresholds: { blindFalseReleaseMax: 0, artifactIntegrityMin: 1, evidenceReferenceMin: 1, macroF1GainMin: 0.08, taskSuccessGainMin: 0.1, humanReviewRelativeReductionMin: 0.2, consistencyMin: 0.85, modelFailureMax: 0.05 } });
  assert.equal(experiment.status, "completed");
  assert.equal(experiment.lanes["full-llm:model-a"].meanConsistency, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].artifactIntegrityRate, 1);
  assert.equal(experiment.acceptance.proven, false);
  assert.ok(experiment.acceptance.reasons.includes("no_measured_llm_gain"));
}
