import assert from "node:assert/strict";
import { diagnoseBenchmarkRun, evaluateBenchmark, evaluateExperiment, hasCompleteBenchmarkTrace, normalizeHistoricalBenchmarkRecord, recomputeHistoricalBenchmarkRecords, validateExperimentRunMatrix, type BenchmarkCase, type BenchmarkRunRecord, type HumanBenchmarkLabel } from "../src/benchmark.js";

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
    expectedScenarioId: "scenario-1",
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
    requirementPassed: true,
    outcomeSchemaVersion: "2.0",
    executionStarted: true,
    executionSucceeded: true,
    retryCount: 1,
    selectedScenarioId: "scenario-1",
    requestedScenarioId: "scenario-1",
    projectedScenarioId: "scenario-1",
    executedScenarioId: "scenario-1",
    finalStatus: "pass",
    initialVerdict: "needs_review",
    deterministic: { verdict: "pass", evidenceRefs: ["ev-1"], status: "passed" },
    llm: { verdict: "pass", evidenceRefs: ["ev-1"], status: "passed", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001 } },
    evidence: [{ id: "ev-1", type: "screenshot" }, { id: "ev-2", type: "dom" }],
    attribution: { evidenceRefs: [], suspectFiles: [] }
    ,executionOrigin: "agent-run",
    gateEligible: true,
    artifactIntegrityVerified: true,
    evidenceGrounded: true,
    agentVersion: "0.2.0",
    configHash: "config-v1",
    targetVersion: "target-v1",
    attempts: [{ id: "attempt-1", runId: "execution-run-1", scenarioId: "scenario-1", attempt: 1, status: "passed" }],
    llmCalls: [{ id: "llm-1", runId: "run-1", purpose: "judging", provider: "openai", model: "model-1", status: "passed" }],
    artifactsV2: [{ id: "artifact-1", type: "screenshot", origin: "runtime-captured", sha256: "a".repeat(64), integrityStatus: "verified", runId: "execution-run-1", scenarioId: "scenario-1", stepId: "step-1", attemptId: "attempt-1", attempt: 1, capturedAt: "2026-07-14T00:00:01.000Z", sizeBytes: 42, mediaType: "image/png" }]
  };
  assert.equal(hasCompleteBenchmarkTrace(record), true);
  assert.equal(hasCompleteBenchmarkTrace({ ...record, attempts: undefined }), false);
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
  const commandOnly = {
    ...record,
    lane: "test-command" as const,
    executionOrigin: "command-baseline" as const,
    requirementCovered: false,
    gateEligible: false,
    artifactIntegrityVerified: false,
    finalStatus: "needs-human-review" as const,
    deterministic: { verdict: "needs_review" as const, evidenceRefs: ["ev-1"], status: "passed" as const }
  };
  assert.equal(evaluateBenchmark(cases, labels, [commandOnly]).completedRuns, 0, "command-only baselines must not enter the formal completed denominator");
  const migratedCommand = normalizeHistoricalBenchmarkRecord({ ...commandOnly, finalStatus: "pass" as const, status: "completed" });
  assert.equal(migratedCommand.record.status, "invalid");
  assert.equal(migratedCommand.record.finalStatus, "needs-human-review");
  assert.ok(migratedCommand.exclusion?.reasons.includes("command_baseline_not_formal_evidence"));
  const missingTrace = normalizeHistoricalBenchmarkRecord({ ...record, artifactsV2: undefined, finalStatus: undefined });
  assert.equal(missingTrace.record.status, "invalid");
  assert.ok(missingTrace.exclusion?.reasons.includes("final_status_missing"));
  assert.ok(missingTrace.exclusion?.reasons.includes("artifact_v2_trace_incomplete"));
  const wrongScenario = normalizeHistoricalBenchmarkRecord(record, { ...labels[0], expectedScenarioId: "other-scenario" });
  assert.equal(wrongScenario.record.status, "invalid");
  assert.ok(wrongScenario.exclusion?.reasons.includes("scenario_selection_mismatch"));
  const migrated = recomputeHistoricalBenchmarkRecords([record, { ...commandOnly, finalStatus: "pass" as const }]);
  assert.equal(migrated.records.filter((item) => item.status === "completed").length, 1);
  assert.equal(migrated.exclusions.length, 1);

  const experimentRecords: BenchmarkRunRecord[] = [
    { ...record, experimentId: "exp-1", split: "blind", lane: "rules-deterministic", benchmarkId: "bm-1", repetition: 1 },
    ...[1, 2, 3].map((repetition) => ({ ...record, experimentId: "exp-1", split: "blind" as const, lane: "full-llm" as const, modelProfileId: "model-a", benchmarkId: "bm-1", repetition }))
  ];
  const experiment = evaluateExperiment({ experimentId: "exp-1", split: "blind", cases: cases.slice(0, 1), labels: labels.slice(0, 1), records: experimentRecords, plannedRuns: 4, thresholds: { blindFalseReleaseMax: 0, artifactIntegrityMin: 1, evidenceReferenceMin: 1, macroF1GainMin: 0.08, taskSuccessGainMin: 0.1, humanReviewRelativeReductionMin: 0.2, consistencyMin: 0.85, modelFailureMax: 0.05 } });
  const fullMetrics = experiment.lanes["full-llm:model-a"];
  assert.ok(fullMetrics.macroF1GainCiLow! <= fullMetrics.macroF1Gain! && fullMetrics.macroF1Gain! <= fullMetrics.macroF1GainCiHigh!, "paired point estimate must use the same case-level estimand as its interval");
  assert.equal(experiment.status, "completed");
  assert.equal(experiment.lanes["full-llm:model-a"].meanConsistency, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].scenarioSelectionAccuracy, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].schedulingCompletionRate, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].executionSuccessRate, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].gateEligibleRate, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].finalDecisionAccuracy, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].recommendationAccuracy, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].finalStatusAccuracy, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].averageTotalTokensPerRun, 15);
  assert.equal(experiment.lanes["full-llm:model-a"].artifactIntegrityRate, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].runTraceabilityRate, 1);
  assert.equal(experiment.lanes["full-llm:model-a"].firstPassPlanRate, null, "judge-only fixture has no planner call");
  assert.equal(experiment.acceptance.proven, false);
  assert.ok(experiment.acceptance.reasons.includes("no_measured_llm_gain"));

  const matrix = validateExperimentRunMatrix({ records: experimentRecords, caseIds: ["bm-1"], modelIds: ["model-a"], repetitions: 1 });
  assert.equal(matrix.complete, false);
  assert.ok(matrix.missing.some((key) => key.includes("llm-plan-deterministic-judge")));
  const completeMatrix = validateExperimentRunMatrix({
    records: [
      { ...record, lane: "rules-deterministic", benchmarkId: "bm-1", repetition: 1 },
      { ...record, lane: "test-command", benchmarkId: "bm-1", repetition: 1 },
      { ...record, lane: "llm-plan-deterministic-judge", modelProfileId: "model-a", benchmarkId: "bm-1", repetition: 1 },
      { ...record, lane: "rules-plan-llm-judge", modelProfileId: "model-a", benchmarkId: "bm-1", repetition: 1 },
      { ...record, lane: "full-llm", modelProfileId: "model-a", benchmarkId: "bm-1", repetition: 1 }
    ],
    caseIds: ["bm-1"], modelIds: ["model-a"], repetitions: 1
  });
  assert.equal(completeMatrix.complete, true);

  const providerFailure = diagnoseBenchmarkRun({ ...record, selectedScenarioId: undefined, finalStatus: "blocked", executionSucceeded: false, requirementCovered: false, gateEligible: false, artifactIntegrityVerified: false, planExecutable: false, attempts: [], artifactsV2: [], planProvenance: { source: "llm", compilationStatus: "rejected", fallbackReason: "fetch_failed" }, llm: { verdict: "needs_review", evidenceRefs: [], status: "failed" } }, { ...labels[0], expectedScenarioId: "scenario-1" });
  assert.equal(providerFailure.primaryCause, "planner_provider_failure");
  assert.equal(providerFailure.browserStarted, false);
  assert.equal(providerFailure.effects.includes("browser_execution_error"), false, "planner failures must not be mislabeled as browser failures");
}
