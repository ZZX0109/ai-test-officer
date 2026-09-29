import { testQualityMetricsSchema, type CoverageItem } from "@ai-test-officer/contracts";
import type { BusinessFunction } from "./businessFunctionCompiler.js";

type Result = {
  coverageItemId?: string;
  status: string;
  oracleResults?: Array<{ oracleId?: string; passed: boolean }>;
  evidenceRefs?: string[];
  /** Artifact kinds must come from persisted artifact metadata, never guessed from a ref. */
  evidenceKinds?: string[];
  /** Only explicit test-level outcomes count toward test success metrics. */
  testOutcome?: "passed" | "failed";
  durationMs?: number;
  attempt?: number;
  isFlaky?: boolean;
  isEnvironmentFailure?: boolean;
};

type ConfusionMatrix = { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };

function rate(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function f1(truePositive: number, falsePositive: number, falseNegative: number): number | undefined {
  return rate(2 * truePositive, 2 * truePositive + falsePositive + falseNegative);
}

/**
 * Compute metrics only from observations with a real denominator. Missing labels,
 * outcomes, durations, artifact kinds, and coverage plans remain absent rather
 * than being converted into zero-valued claims.
 */
export function calculateTestQualityMetrics(input: {
  metricId: string;
  start: string;
  end: string;
  projectId?: string;
  functions: BusinessFunction[];
  coverage: CoverageItem[];
  results: Result[];
  labelledFunctionIds?: string[];
  labelledOutcomes?: ConfusionMatrix;
  requirements?: Array<{ id: string; covered: boolean }>;
  expectedDefectCount?: number;
  confirmedDefectCount?: number;
  diagnosisTimeMs?: number;
  repairRuns?: Array<{ regressionPassed?: boolean }>;
}) {
  const planned = input.coverage.filter((item) => item.disposition !== "excluded");
  const executed = planned.filter((item) => item.disposition === "executed" || item.disposition === "failed");
  const highRiskPlanned = planned.filter((item) => item.risk === "high" || item.risk === "critical");
  const highRiskExecuted = highRiskPlanned.filter((item) => item.disposition === "executed" || item.disposition === "failed");
  const pathCoverage = rate(executed.length, planned.length);
  const riskCoverage = rate(highRiskExecuted.length, highRiskPlanned.length);

  const plannedOracleIds = new Set(planned.flatMap((item) => item.oracleIds));
  const observedOracleIds = new Set(input.results.flatMap((result) => (result.oracleResults ?? [])
    .flatMap((oracle) => oracle.oracleId ? [oracle.oracleId] : [])));
  const oracleCoverage = plannedOracleIds.size
    ? [...plannedOracleIds].filter((id) => observedOracleIds.has(id)).length / plannedOracleIds.size
    : undefined;

  const behaviorPlan = new Set(planned.flatMap((item) => item.behaviorDimensions));
  const behaviorObserved = new Set(executed.flatMap((item) => item.coveredBehaviorDimensions));
  const behaviorCoverage = behaviorPlan.size
    ? [...behaviorPlan].filter((dimension) => behaviorObserved.has(dimension)).length / behaviorPlan.size
    : undefined;

  const hasTypedEvidence = input.results.some((result) => result.evidenceKinds !== undefined);
  let evidenceCoverage: number | undefined;
  if (hasTypedEvidence) {
    const evidenceTotal = planned.reduce((sum, item) => sum + item.requiredEvidenceKinds.length, 0);
    if (evidenceTotal > 0) {
      const satisfied = planned.reduce((sum, item) => {
        const kinds = new Set(input.results
          .filter((result) => result.coverageItemId === item.id)
          .flatMap((result) => result.evidenceKinds ?? []));
        return sum + item.requiredEvidenceKinds.filter((kind) => kinds.has(kind)).length;
      }, 0);
      evidenceCoverage = satisfied / evidenceTotal;
    }
  }

  const outcomes = input.results.filter((result) => result.testOutcome !== undefined);
  const flakySamples = input.results.filter((result) => result.isFlaky !== undefined);
  const environmentSamples = input.results.filter((result) => result.isEnvironmentFailure !== undefined);
  const durationSamples = input.results.filter((result) => Number.isFinite(result.durationMs) && (result.durationMs ?? -1) >= 0);
  const firstAttempts = outcomes.filter((result) => result.attempt === 1);
  const success = {
    testOutcomeSampleCount: outcomes.length,
    testSuccessRate: outcomes.length ? outcomes.filter((result) => result.testOutcome === "passed").length / outcomes.length : undefined,
    flakySampleCount: flakySamples.length,
    flakyTestRate: flakySamples.length ? flakySamples.filter((result) => result.isFlaky).length / flakySamples.length : undefined,
    environmentFailureSampleCount: environmentSamples.length,
    environmentFailureRate: environmentSamples.length ? environmentSamples.filter((result) => result.isEnvironmentFailure).length / environmentSamples.length : undefined,
    durationSampleCount: durationSamples.length,
    averageTestDurationMs: durationSamples.length
      ? Math.round(durationSamples.reduce((sum, result) => sum + result.durationMs!, 0) / durationSamples.length)
      : undefined,
    firstAttemptSampleCount: firstAttempts.length,
    firstAttemptPassRate: firstAttempts.length ? firstAttempts.filter((result) => result.testOutcome === "passed").length / firstAttempts.length : undefined
  };

  const matrix = input.labelledOutcomes;
  const precision = matrix ? rate(matrix.truePositive, matrix.truePositive + matrix.falsePositive) : undefined;
  const recall = matrix ? rate(matrix.truePositive, matrix.truePositive + matrix.falseNegative) : undefined;
  const falsePositiveRate = matrix ? rate(matrix.falsePositive, matrix.falsePositive + matrix.trueNegative) : undefined;
  const falseNegativeRate = matrix ? rate(matrix.falseNegative, matrix.falseNegative + matrix.truePositive) : undefined;

  let functionIdentificationF1: number | undefined;
  if (input.labelledFunctionIds !== undefined) {
    const expected = new Set(input.labelledFunctionIds);
    const discovered = new Set(input.functions.map((item) => item.id));
    const truePositive = [...discovered].filter((id) => expected.has(id)).length;
    functionIdentificationF1 = f1(truePositive, discovered.size - truePositive, expected.size - truePositive);
  }

  const requirementCoverage = input.requirements?.length
    ? input.requirements.filter((requirement) => requirement.covered).length / input.requirements.length
    : undefined;
  const defectDiscoveryRate = typeof input.expectedDefectCount === "number"
    && input.expectedDefectCount > 0
    && typeof input.confirmedDefectCount === "number"
    ? Math.min(1, input.confirmedDefectCount / input.expectedDefectCount)
    : undefined;
  const measuredRepairRuns = input.repairRuns?.filter((run) => run.regressionPassed !== undefined) ?? [];

  return testQualityMetricsSchema.parse({
    schemaVersion: "1.0",
    metricId: input.metricId,
    period: { start: input.start, end: input.end },
    projectId: input.projectId,
    accuracy: {
      totalTests: input.results.length,
      falsePositiveRate,
      falseNegativeRate,
      precision,
      recall,
      f1Score: matrix ? f1(matrix.truePositive, matrix.falsePositive, matrix.falseNegative) : undefined
    },
    success,
    coverage: {
      pathCoverage,
      riskCoverage,
      assertionCoverage: oracleCoverage,
      evidenceCoverage
    },
    business: {
      functionIdentificationF1,
      requirementCoverage,
      oracleCoverage,
      behaviorCoverage,
      defectDiscoveryRate,
      falsePositiveRate,
      falseNegativeRate,
      diagnosisTimeMs: input.diagnosisTimeMs,
      postRepairRegressionPassRate: measuredRepairRuns.length
        ? measuredRepairRuns.filter((run) => run.regressionPassed === true).length / measuredRepairRuns.length
        : undefined
    },
    generatedAt: new Date().toISOString()
  });
}
