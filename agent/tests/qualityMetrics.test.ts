import assert from "node:assert/strict";
import { coverageItemSchema } from "@ai-test-officer/contracts";
import { calculateTestQualityMetrics } from "../src/qualityMetrics.js";

function coverage(overrides: Record<string, unknown> = {}) {
  return coverageItemSchema.parse({
    schemaVersion: "1.0",
    id: "path-1",
    runId: "run-1",
    flowId: "flow-1",
    module: "orders",
    surface: "page",
    risk: "high",
    oracleIds: ["oracle-1"],
    requiredEvidenceKinds: ["screenshot", "dom"],
    behaviorDimensions: ["happy-path", "negative"],
    coveredBehaviorDimensions: ["happy-path"],
    disposition: "executed",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides
  });
}

function baseInput() {
  return {
    metricId: "metric-1",
    start: "2026-09-30T00:00:00.000Z",
    end: "2026-09-30T01:00:00.000Z",
    functions: [],
    coverage: [] as ReturnType<typeof coverage>[],
    results: [] as Array<{
      coverageItemId?: string;
      status: string;
      oracleResults?: Array<{ oracleId?: string; passed: boolean }>;
      evidenceRefs?: string[];
      evidenceKinds?: string[];
      testOutcome?: "passed" | "failed";
      durationMs?: number;
      attempt?: number;
      isFlaky?: boolean;
      isEnvironmentFailure?: boolean;
    }>
  };
}

export function testQualityMetrics() {
  const empty = calculateTestQualityMetrics(baseInput());
  assert.equal(empty.accuracy.totalTests, 0);
  assert.equal(empty.accuracy.precision, undefined, "unlabelled data must not produce precision");
  assert.equal(empty.accuracy.falsePositiveRate, undefined, "missing confusion labels must stay absent");
  assert.equal(empty.success.testSuccessRate, undefined, "missing test outcomes must stay absent");
  assert.equal(empty.success.averageTestDurationMs, undefined);
  assert.equal(empty.coverage.pathCoverage, undefined, "an empty plan has no coverage denominator");
  assert.equal(empty.business?.requirementCoverage, undefined);

  const measured = calculateTestQualityMetrics({
    ...baseInput(),
    coverage: [coverage()],
    results: [{
      coverageItemId: "path-1",
      status: "completed",
      oracleResults: [{ oracleId: "oracle-1", passed: true }],
      evidenceRefs: ["artifact-1"],
      evidenceKinds: ["screenshot"],
      testOutcome: "passed",
      durationMs: 120,
      attempt: 1,
      isFlaky: false,
      isEnvironmentFailure: false
    }],
    labelledOutcomes: { truePositive: 1, falsePositive: 1, trueNegative: 1, falseNegative: 1 }
  });
  assert.equal(measured.accuracy.precision, 0.5);
  assert.equal(measured.accuracy.recall, 0.5);
  assert.equal(measured.accuracy.f1Score, 0.5);
  assert.equal(measured.accuracy.falsePositiveRate, 0.5);
  assert.equal(measured.accuracy.falseNegativeRate, 0.5);
  assert.equal(measured.success.testSuccessRate, 1);
  assert.equal(measured.success.averageTestDurationMs, 120);
  assert.equal(measured.success.firstAttemptPassRate, 1);
  assert.equal(measured.coverage.pathCoverage, 1);
  assert.equal(measured.coverage.riskCoverage, 1);
  assert.equal(measured.coverage.assertionCoverage, 1);
  assert.equal(measured.coverage.evidenceCoverage, 0.5, "one of two required artifact kinds is present");
  assert.equal(measured.business?.behaviorCoverage, 0.5, "only the explicitly observed dimension is covered");
  assert.equal(measured.business?.requirementCoverage, undefined, "paths are not a substitute for requirement labels");

  const noPredictions = calculateTestQualityMetrics({
    ...baseInput(),
    labelledFunctionIds: ["expected-function"]
  });
  assert.equal(noPredictions.business?.functionIdentificationF1, 0, "a labelled positive missed by an empty prediction is a measured zero, not missing data");
}
