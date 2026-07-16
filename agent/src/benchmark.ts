import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type BenchmarkVerdict = "pass" | "needs_review" | "fail";
export type BenchmarkRunStatus = "awaiting_agent_runs" | "completed" | "skipped" | "invalid";

export interface BenchmarkCase {
  id: string;
  title: string;
  requirementId: string;
  requirement: string;
  projectProfile: string;
  scenarioHint?: string;
  status: BenchmarkRunStatus;
}

export interface HumanBenchmarkLabel {
  benchmarkId: string;
  verdict: BenchmarkVerdict;
  expectedScenarioId?: string;
  failureClass?: "product_bug" | "test_script_issue" | "environment_issue" | "insufficient_evidence" | "unknown";
  requiredEvidenceTypes: string[];
  expectedEvidenceRefs?: string[];
  expectedSuspectFiles?: string[];
}

export interface BenchmarkRunRecord {
  benchmarkId: string;
  runId: string;
  status: Exclude<BenchmarkRunStatus, "awaiting_agent_runs">;
  startedAt: string;
  finishedAt: string;
  requirementCovered: boolean;
  executionSucceeded: boolean;
  retryCount: number;
  experimentId?: string;
  split?: "development" | "blind";
  lane?: "test-command" | "rules-deterministic" | "llm-plan-deterministic-judge" | "rules-plan-llm-judge" | "full-llm";
  modelProfileId?: string;
  repetition?: number;
  planExecutable?: boolean;
  planSource?: "deterministic" | "llm";
  selectedScenarioId?: string;
  finalStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  planProvenance?: {
    source: "deterministic" | "llm" | "scenario_fallback" | "adaptive-rule-fallback" | "cached-llm";
    promptVersion?: string;
    modelProfileId?: string;
    model?: string;
    llmCallId?: string;
    compilationStatus?: "validated" | "rejected" | "not-required";
    fallbackReason?: string;
  };
  attempts?: Array<{
    id: string;
    runId: string;
    scenarioId: string;
    attempt: number;
    status: string;
  }>;
  llmCalls?: Array<{
    id: string;
    runId?: string;
    experimentId?: string;
    purpose: "planning" | "judging";
    provider: string;
    model: string;
    requestId?: string;
    status: string;
    durationMs?: number;
    usage?: JudgeLaneRecord["usage"];
  }>;
  baselineDerivedFromRunId?: string;
  initialVerdict?: BenchmarkVerdict;
  deterministic: JudgeLaneRecord;
  llm?: JudgeLaneRecord;
  evidence: Array<{ id: string; type: string }>;
  attribution?: { failureClass?: string; suspectFiles?: string[]; evidenceRefs: string[] };
  executionOrigin?: "agent-run" | "command-baseline" | "seeded-fixture" | "static-report";
  gateEligible?: boolean;
  artifactIntegrityVerified?: boolean;
  agentVersion?: string;
  configHash?: string;
  targetVersion?: string;
  artifactsV2?: Array<{
    id: string;
    type: string;
    origin: "runtime-captured" | "fixture" | "simulated" | "user-uploaded" | "legacy-unverified";
    sha256: string;
    integrityStatus: "verified" | "missing" | "mismatch";
    runId?: string;
    scenarioId?: string;
    stepId?: string;
    attemptId?: string;
    attempt?: number;
    capturedAt?: string;
    sizeBytes?: number;
    mediaType?: string;
    storageUri?: string;
  }>;
  evidenceQuality?: { groundedPassedRate: number; runtimeArtifactRate: number; crossAttemptViolations: number };
  baselines?: {
    rules?: JudgeLaneRecord;
    testCommand?: JudgeLaneRecord;
  };
}

export interface HistoricalBenchmarkExclusion {
  runId: string;
  benchmarkId: string;
  reasons: string[];
}

export interface HistoricalBenchmarkRecompute {
  records: BenchmarkRunRecord[];
  exclusions: HistoricalBenchmarkExclusion[];
}

export interface ExperimentEvaluation {
  experimentId: string;
  status: "awaiting_agent_runs" | "completed" | "blocked";
  split: "development" | "blind";
  plannedRuns: number;
  completedRuns: number;
  lanes: Record<string, Record<string, number | null>>;
  diagnostics: BenchmarkRunDiagnostic[];
  acceptance: { proven: boolean; readyForBlind: boolean; reasons: string[] };
}

export type BenchmarkFailureCategory =
  | "scenario_selection_error"
  | "planner_provider_failure"
  | "plan_compilation_error"
  | "browser_execution_error"
  | "requirement_not_covered"
  | "artifact_integrity_failure"
  | "judge_recommendation_error"
  | "model_call_failure";

export interface BenchmarkRunDiagnostic {
  benchmarkId: string;
  runId: string;
  lane: string;
  repetition: number;
  expectedScenarioId?: string;
  selectedScenarioId?: string;
  primaryCause?: BenchmarkFailureCategory;
  effects: BenchmarkFailureCategory[];
  browserStarted: boolean;
  executionSucceeded: boolean;
  requirementCovered: boolean;
  artifactIntegrityVerified: boolean;
  gateEligible: boolean;
  recommendation?: BenchmarkVerdict;
  recommendationValid: boolean;
  finalStatus?: BenchmarkRunRecord["finalStatus"];
  llmCalls: BenchmarkRunRecord["llmCalls"];
}

function finalVerdict(status: BenchmarkRunRecord["finalStatus"]): BenchmarkVerdict | undefined {
  if (status === "pass" || status === "fail") return status;
  if (status === "blocked" || status === "needs-human-review") return "needs_review";
  return undefined;
}

export function diagnoseBenchmarkRun(record: BenchmarkRunRecord, label?: HumanBenchmarkLabel): BenchmarkRunDiagnostic {
  const effects: BenchmarkFailureCategory[] = [];
  const plannerFailed = record.planProvenance?.compilationStatus === "rejected" || record.planExecutable === false;
  const providerFailure = plannerFailed && /fetch_failed|provider_http|timeout|llm_not_configured/i.test(record.planProvenance?.fallbackReason ?? "");
  const browserStarted = Boolean(record.attempts?.length || record.artifactsV2?.some((artifact) => artifact.origin === "runtime-captured"));
  const recommendation = record.llm?.verdict;
  const recommendationValid = Boolean(record.llm && record.llm.status === "passed" && !record.llm.fallback);
  if (label?.expectedScenarioId && record.selectedScenarioId !== label.expectedScenarioId) effects.push("scenario_selection_error");
  if (providerFailure) effects.push("planner_provider_failure");
  else if (plannerFailed) effects.push("plan_compilation_error");
  if (browserStarted && !record.executionSucceeded) effects.push("browser_execution_error");
  if (!record.requirementCovered) effects.push("requirement_not_covered");
  if (!record.artifactIntegrityVerified || record.gateEligible !== true) effects.push("artifact_integrity_failure");
  if (record.llm && (record.llm.status === "failed" || record.llm.fallback || record.llmCalls?.some((call) => call.status !== "passed"))) effects.push("model_call_failure");
  if (record.llm && ((!recommendationValid && record.llmCalls?.some((call) => call.purpose === "judging")) || (recommendationValid && label && recommendation !== label.verdict))) effects.push("judge_recommendation_error");
  const priority: BenchmarkFailureCategory[] = ["planner_provider_failure", "plan_compilation_error", "browser_execution_error", "scenario_selection_error", "requirement_not_covered", "artifact_integrity_failure", "model_call_failure", "judge_recommendation_error"];
  return {
    benchmarkId: record.benchmarkId,
    runId: record.runId,
    lane: record.lane ?? "unknown",
    repetition: record.repetition ?? 1,
    expectedScenarioId: label?.expectedScenarioId,
    selectedScenarioId: record.selectedScenarioId,
    primaryCause: priority.find((category) => effects.includes(category)),
    effects,
    browserStarted,
    executionSucceeded: record.executionSucceeded,
    requirementCovered: record.requirementCovered,
    artifactIntegrityVerified: record.artifactIntegrityVerified === true,
    gateEligible: record.gateEligible === true,
    recommendation,
    recommendationValid,
    finalStatus: record.finalStatus,
    llmCalls: record.llmCalls ?? []
  };
}

export function validateExperimentRunMatrix(input: {
  records: BenchmarkRunRecord[];
  caseIds: string[];
  modelIds: string[];
  repetitions: number;
}) {
  const expected = new Set<string>();
  for (const caseId of input.caseIds) {
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      expected.add(`${caseId}:rules-deterministic:none:${repetition}`);
      expected.add(`${caseId}:test-command:none:${repetition}`);
      for (const modelId of input.modelIds) {
        for (const lane of ["llm-plan-deterministic-judge", "rules-plan-llm-judge", "full-llm"]) {
          expected.add(`${caseId}:${lane}:${modelId}:${repetition}`);
        }
      }
    }
  }
  const actual = input.records.map((record) => `${record.benchmarkId}:${record.lane ?? "missing"}:${record.modelProfileId ?? "none"}:${record.repetition ?? 1}`);
  const seen = new Set<string>();
  const duplicates = actual.filter((key) => seen.has(key) || !seen.add(key));
  const actualSet = new Set(actual);
  return {
    expectedRuns: expected.size,
    actualRuns: actual.length,
    missing: [...expected].filter((key) => !actualSet.has(key)),
    unexpected: [...actualSet].filter((key) => !expected.has(key)),
    duplicates: [...new Set(duplicates)],
    complete: actual.length === expected.size && duplicates.length === 0 && [...expected].every((key) => actualSet.has(key)) && [...actualSet].every((key) => expected.has(key))
  };
}

export interface JudgeLaneRecord {
  verdict: BenchmarkVerdict;
  evidenceRefs: string[];
  failureClass?: string;
  status: "passed" | "not_configured" | "failed";
  fallback?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; estimatedCostUsd?: number };
  durationMs?: number;
}

export interface BenchmarkEvaluation {
  createdAt: string;
  totalCases: number;
  awaitingAgentRuns: number;
  completedRuns: number;
  metrics: Record<string, number | null>;
  lanes: Record<string, Record<string, number | null>>;
  cases: Array<{ id: string; status: BenchmarkRunStatus; runId?: string }>;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function totalKnownCost(usage: Array<JudgeLaneRecord["usage"] | undefined>) {
  const known = usage.filter((item): item is NonNullable<JudgeLaneRecord["usage"]> => Boolean(item));
  // A provider without published/verified pricing must remain unpriced.  Treating
  // it as zero makes a paid experiment look free in the benchmark dashboard.
  return known.length && known.every((item) => typeof item.estimatedCostUsd === "number")
    ? known.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
    : null;
}

function setScore(actual: string[], expected: string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    precision: ratio([...actualSet].filter((item) => expectedSet.has(item)).length, actualSet.size),
    recall: ratio([...expectedSet].filter((item) => actualSet.has(item)).length, expectedSet.size)
  };
}

function macroF1(records: Array<{ actual: string; expected: string }>) {
  const classes = ["pass", "needs_review", "fail"];
  if (!records.length) return null;
  return classes.reduce((sum, item) => {
    const tp = records.filter((record) => record.actual === item && record.expected === item).length;
    const fp = records.filter((record) => record.actual === item && record.expected !== item).length;
    const fn = records.filter((record) => record.actual !== item && record.expected === item).length;
    const f1 = tp === 0 ? 0 : (2 * tp) / ((2 * tp) + fp + fn);
    return sum + f1;
  }, 0) / classes.length;
}

function laneMetrics(records: BenchmarkRunRecord[], labels: Map<string, HumanBenchmarkLabel>, lane: "deterministic" | "llm") {
  const available = records
    .map((record) => ({ record, label: labels.get(record.benchmarkId), lane: lane === "llm" ? record.llm : record.deterministic }))
    .filter((item): item is { record: BenchmarkRunRecord; label: HumanBenchmarkLabel; lane: JudgeLaneRecord } => Boolean(item.label && item.lane));
  const compared = available.filter((item) => item.lane.status === "passed" || lane === "deterministic");
  const evidence = compared.map((item) => setScore(item.lane.evidenceRefs, item.label.expectedEvidenceRefs ?? []));
  const expectedFailing = compared.filter((item) => item.label.verdict !== "pass");
  const expectedPassing = compared.filter((item) => item.label.verdict === "pass");
  const usage = compared.map((item) => item.lane.usage).filter(Boolean);
  const productBugCases = compared.filter((item) => item.label.failureClass === "product_bug");
  const predictedProductBugs = compared.filter((item) => item.lane.failureClass === "product_bug");
  const trueProductBugs = predictedProductBugs.filter((item) => item.label.failureClass === "product_bug");
  return {
    macroF1: macroF1(compared.map((item) => ({ actual: item.lane.verdict, expected: item.label.verdict }))),
    falseReleaseRate: ratio(expectedFailing.filter((item) => item.lane.verdict === "pass").length, expectedFailing.length),
    falseBlockRate: ratio(expectedPassing.filter((item) => item.lane.verdict !== "pass").length, expectedPassing.length),
    evidenceReferencePrecision: evidence.length ? evidence.reduce((sum, item) => sum + (item.precision ?? 0), 0) / evidence.length : null,
    evidenceReferenceRecall: evidence.length ? evidence.reduce((sum, item) => sum + (item.recall ?? 0), 0) / evidence.length : null,
    productBugPrecision: ratio(trueProductBugs.length, predictedProductBugs.length),
    productBugRecall: ratio(trueProductBugs.length, productBugCases.length),
    fallbackRate: lane === "llm" ? ratio(available.filter((item) => item.lane.fallback || item.lane.status === "failed").length, available.length) : 0,
    notConfiguredRate: lane === "llm" ? ratio(available.filter((item) => item.lane.status === "not_configured").length, available.length) : 0,
    promptTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.promptTokens ?? 0), 0) : null,
    completionTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.completionTokens ?? 0), 0) : null,
    estimatedCostUsd: totalKnownCost(usage)
    ,averageDurationMs: compared.length ? compared.reduce((sum, item) => sum + (item.lane.durationMs ?? 0), 0) / compared.length : null
  };
}

export function hasCompleteBenchmarkTrace(record: BenchmarkRunRecord) {
  if (!record.runId || !record.attempts?.length || !record.artifactsV2?.length) return false;
  const attemptIds = new Set(record.attempts.map((attempt) => attempt.id));
  const attemptsValid = record.attempts.every((attempt) => attempt.id && attempt.runId && attempt.scenarioId && attempt.attempt > 0);
  const artifactsValid = record.artifactsV2.every((artifact) =>
    artifact.runId
    && artifact.scenarioId
    && artifact.stepId
    && artifact.attemptId
    && attemptIds.has(artifact.attemptId)
    && typeof artifact.attempt === "number"
    && artifact.capturedAt
    && typeof artifact.sizeBytes === "number"
    && artifact.mediaType
  );
  const llmRequired = record.lane?.includes("llm") ?? false;
  const llmValid = !llmRequired || Boolean(record.llmCalls?.length && record.llmCalls.every((call) => call.id && call.runId && call.provider && call.model && call.status));
  return attemptsValid && artifactsValid && llmValid;
}

/**
 * Converts an old, permissive benchmark record into the current formal-gate
 * representation without changing the source file. Invalid records become
 * `invalid`, so evaluators retain them for audit but exclude them from formal
 * metrics and release claims.
 */
export function normalizeHistoricalBenchmarkRecord(record: BenchmarkRunRecord, label?: HumanBenchmarkLabel): { record: BenchmarkRunRecord; exclusion?: HistoricalBenchmarkExclusion } {
  const reasons: string[] = [];
  const commandBaseline = record.lane === "test-command" || record.executionOrigin === "command-baseline";
  if (commandBaseline) reasons.push("command_baseline_not_formal_evidence");
  if (!record.finalStatus) reasons.push("final_status_missing");
  if (!record.requirementCovered) reasons.push("requirement_not_covered");
  if (record.gateEligible !== true) reasons.push("gate_not_eligible");
  if (record.artifactIntegrityVerified !== true) reasons.push("artifact_integrity_not_verified");
  if (!hasCompleteBenchmarkTrace(record)) reasons.push("artifact_v2_trace_incomplete");
  if (record.artifactsV2?.some((artifact) => artifact.integrityStatus !== "verified" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || (artifact.origin !== "runtime-captured" && artifact.origin !== "fixture"))) reasons.push("artifact_v2_integrity_invalid");
  if (label?.expectedScenarioId && record.selectedScenarioId !== label.expectedScenarioId) reasons.push("scenario_selection_mismatch");
  if (!reasons.length) return { record };

  const safeStatus = record.finalStatus === "fail" || record.finalStatus === "blocked"
    ? record.finalStatus
    : "needs-human-review";
  return {
    record: {
      ...record,
      status: "invalid",
      requirementCovered: false,
      gateEligible: false,
      artifactIntegrityVerified: false,
      finalStatus: safeStatus,
      executionOrigin: commandBaseline ? "command-baseline" : record.executionOrigin ?? "static-report"
    },
    exclusion: { runId: record.runId, benchmarkId: record.benchmarkId, reasons }
  };
}

export function recomputeHistoricalBenchmarkRecords(records: BenchmarkRunRecord[], labels: HumanBenchmarkLabel[] = []): HistoricalBenchmarkRecompute {
  const labelByBenchmarkId = new Map(labels.map((label) => [label.benchmarkId, label]));
  const normalized = records.map((record) => normalizeHistoricalBenchmarkRecord(record, labelByBenchmarkId.get(record.benchmarkId)));
  return {
    records: normalized.map((item) => item.record),
    exclusions: normalized.flatMap((item) => item.exclusion ? [item.exclusion] : [])
  };
}

function isIndependentCompletedRun(record: BenchmarkRunRecord) {
  return record.status === "completed"
    && record.executionOrigin === "agent-run"
    && record.gateEligible === true
    && Boolean(record.agentVersion && record.configHash && record.targetVersion)
    && Boolean(record.artifactsV2?.some((artifact) => artifact.origin === "runtime-captured" && artifact.integrityStatus === "verified"));
}

export function evaluateBenchmark(cases: BenchmarkCase[], labels: HumanBenchmarkLabel[], records: BenchmarkRunRecord[]): BenchmarkEvaluation {
  const labelsById = new Map(labels.map((label) => [label.benchmarkId, label]));
  const caseIds = new Set(cases.map((item) => item.id));
  if (cases.length === 0) throw new Error("Benchmark manifest must declare at least one case");
  if (caseIds.size !== cases.length) throw new Error("Benchmark manifest contains duplicate case IDs");
  if (labelsById.size !== cases.length || cases.some((item) => !labelsById.has(item.id))) {
    throw new Error("Every benchmark case must have exactly one human label");
  }
  if (labels.some((label) => !caseIds.has(label.benchmarkId))) throw new Error("Human labels contain unknown benchmark IDs");

  const validRecords = records.filter((record) => caseIds.has(record.benchmarkId) && isIndependentCompletedRun(record));
  const latestByCase = new Map<string, BenchmarkRunRecord>();
  for (const record of validRecords.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))) latestByCase.set(record.benchmarkId, record);
  const completed = Array.from(latestByCase.values());
  const labelsForCompleted = completed.map((record) => labelsById.get(record.benchmarkId)!);
  const evidenceScores = completed.map((record, index) => setScore(record.evidence.map((item) => item.type), labelsForCompleted[index].requiredEvidenceTypes));
  const attributionScores = completed.map((record, index) => setScore(record.attribution?.suspectFiles ?? [], labelsForCompleted[index].expectedSuspectFiles ?? []));
  const durations = completed.map((record) => new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime()).filter((value) => Number.isFinite(value) && value >= 0);
  const awaitingAgentRuns = cases.filter((item) => !latestByCase.has(item.id)).length;
  const initialFailures = completed.filter((item) => item.retryCount > 0);

  return {
    createdAt: new Date().toISOString(),
    totalCases: cases.length,
    awaitingAgentRuns,
    completedRuns: completed.length,
    metrics: {
      requirementCoverage: ratio(completed.filter((item) => item.requirementCovered).length, cases.length),
      executionSuccessRate: ratio(completed.filter((item) => item.executionSucceeded).length, completed.length),
      evidenceCompleteness: evidenceScores.length ? evidenceScores.reduce((sum, item) => sum + (item.recall ?? 0), 0) / evidenceScores.length : null,
      failureAttributionPrecision: attributionScores.length ? attributionScores.reduce((sum, item) => sum + (item.precision ?? 0), 0) / attributionScores.length : null,
      failureAttributionRecall: attributionScores.length ? attributionScores.reduce((sum, item) => sum + (item.recall ?? 0), 0) / attributionScores.length : null,
      flakyRetryRate: ratio(initialFailures.length, completed.length),
      averageRunTimeMs: durations.length ? durations.reduce((sum, item) => sum + item, 0) / durations.length : null
    },
    lanes: {
      deterministic: laneMetrics(completed, labelsById, "deterministic"),
      llm: laneMetrics(completed, labelsById, "llm"),
      rulesBaseline: laneMetrics(completed.map((record) => ({ ...record, deterministic: record.baselines?.rules ?? record.deterministic })), labelsById, "deterministic"),
      testCommandBaseline: laneMetrics(completed.map((record) => ({ ...record, deterministic: record.baselines?.testCommand ?? record.deterministic })), labelsById, "deterministic")
    },
    cases: cases.map((item) => ({ id: item.id, status: latestByCase.has(item.id) ? "completed" : item.status, runId: latestByCase.get(item.id)?.runId }))
  };
}

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function evaluateExperiment(input: {
  experimentId: string;
  split: "development" | "blind";
  cases: BenchmarkCase[];
  labels: HumanBenchmarkLabel[];
  records: BenchmarkRunRecord[];
  plannedRuns: number;
  thresholds: { blindFalseReleaseMax: number; artifactIntegrityMin: number; evidenceReferenceMin: number; evidenceGroundedMin: number; macroF1GainMin: number; taskSuccessGainMin: number; humanReviewRelativeReductionMin: number; consistencyMin: number; modelFailureMax: number; developmentMacroF1GainMin?: number; developmentTaskSuccessGainMin?: number; developmentHumanReviewMax?: number };
  roi?: { manualMinutesPerCase: number; reviewMinutesPerCase: number };
}): ExperimentEvaluation {
  const labels = new Map(input.labels.map((label) => [label.benchmarkId, label]));
  const records = input.records.filter((record) => record.experimentId === input.experimentId && record.split === input.split && record.status === "completed");
  const laneKeys = Array.from(new Set(records.map((record) => `${record.lane}:${record.modelProfileId ?? "none"}`)));
  const lanes: Record<string, Record<string, number | null>> = {};
  for (const key of laneKeys) {
    const selected = records.filter((record) => `${record.lane}:${record.modelProfileId ?? "none"}` === key);
    const compared = selected.map((record) => ({ record, label: labels.get(record.benchmarkId), result: record.llm && record.lane?.includes("llm") ? record.llm : record.deterministic })).filter((item): item is typeof item & { label: HumanBenchmarkLabel; result: JudgeLaneRecord } => Boolean(item.label && item.result));
    const validRecommendations = compared.filter((item) => item.result.status === "passed" && !item.result.fallback);
    const finalCompared = compared.map((item) => ({ ...item, finalVerdict: finalVerdict(item.record.finalStatus) })).filter((item): item is typeof item & { finalVerdict: BenchmarkVerdict } => Boolean(item.finalVerdict));
    const expectedFail = finalCompared.filter((item) => item.label.verdict !== "pass");
    const expectedPass = finalCompared.filter((item) => item.label.verdict === "pass");
    const durations = compared.map((item) => item.result.durationMs ?? 0);
    const usage = compared.map((item) => item.result.usage).filter(Boolean);
    const calls = selected.flatMap((item) => item.llmCalls ?? []);
    const planningCalls = calls.filter((call) => call.purpose === "planning");
    const judgingCalls = calls.filter((call) => call.purpose === "judging");
    const plannerRuns = selected.filter((record) => (record.llmCalls ?? []).some((call) => call.purpose === "planning"));
    const repairedPlannerRuns = plannerRuns.filter((record) => (record.llmCalls ?? []).filter((call) => call.purpose === "planning").length > 1);
    const judgeRuns = selected.filter((record) => (record.llmCalls ?? []).some((call) => call.purpose === "judging"));
    const repairedJudgeRuns = judgeRuns.filter((record) => (record.llmCalls ?? []).filter((call) => call.purpose === "judging").length > 1);
    const automatedMinutes = durations.reduce((sum, value) => sum + value, 0) / 60_000;
    const reviewMinutes = compared.filter((item) => item.result.verdict === "needs_review").length * (input.roi?.reviewMinutesPerCase ?? 0);
    const baselineMinutes = compared.length * (input.roi?.manualMinutesPerCase ?? 0);
    const grouped = new Map<string, string[]>();
    for (const item of compared) grouped.set(item.record.benchmarkId, [...(grouped.get(item.record.benchmarkId) ?? []), item.result.verdict]);
    const consistencies = [...grouped.values()].map((values) => Math.max(...[...new Set(values)].map((value) => values.filter((item) => item === value).length)) / values.length);
    const validEvidenceReferences = compared.map((item) => {
      const ids = new Set(item.record.evidence.map((evidence) => evidence.id));
      return item.result.evidenceRefs.length > 0 && item.result.evidenceRefs.every((id) => ids.has(id));
    });
    const scenarioSelections = compared.filter((item) => Boolean(item.label.expectedScenarioId));
    lanes[key] = {
      schedulingCompletionRate: ratio(selected.filter((item) => item.status === "completed").length, selected.length),
      executionSuccessRate: ratio(compared.filter((item) => item.record.executionSucceeded).length, compared.length),
      gateEligibleRate: ratio(compared.filter((item) => item.record.gateEligible === true && item.record.artifactIntegrityVerified === true).length, compared.length),
      finalDecisionAvailabilityRate: ratio(compared.filter((item) => Boolean(item.record.finalStatus)).length, compared.length),
      recommendationAccuracy: ratio(validRecommendations.filter((item) => item.result.verdict === item.label.verdict).length, validRecommendations.length),
      recommendationMacroF1: macroF1(validRecommendations.map((item) => ({ actual: item.result.verdict, expected: item.label.verdict }))),
      finalStatusAccuracy: ratio(finalCompared.filter((item) => item.finalVerdict === item.label.verdict).length, finalCompared.length),
      finalDecisionAccuracy: ratio(finalCompared.filter((item) => item.finalVerdict === item.label.verdict).length, finalCompared.length),
      macroF1: macroF1(finalCompared.map((item) => ({ actual: item.finalVerdict, expected: item.label.verdict }))),
      taskSuccessRate: ratio(compared.filter((item) => item.record.executionSucceeded && item.record.planExecutable !== false && item.record.gateEligible === true && item.record.artifactIntegrityVerified === true && item.result.status === "passed" && (!item.label.expectedScenarioId || item.record.selectedScenarioId === item.label.expectedScenarioId)).length, compared.length),
      scenarioSelectionAccuracy: ratio(scenarioSelections.filter((item) => item.record.selectedScenarioId === item.label.expectedScenarioId).length, scenarioSelections.length),
      requirementCoverageRate: ratio(compared.filter((item) => item.record.requirementCovered).length, compared.length),
      falseReleaseRate: ratio(expectedFail.filter((item) => item.finalVerdict === "pass").length, expectedFail.length),
      falseBlockRate: ratio(expectedPass.filter((item) => item.finalVerdict !== "pass").length, expectedPass.length),
      humanReviewRate: ratio(finalCompared.filter((item) => item.finalVerdict === "needs_review").length, finalCompared.length),
      planExecutableRate: ratio(compared.filter((item) => item.record.planExecutable !== false).length, compared.length),
      firstPassPlanRate: ratio(plannerRuns.filter((record) => record.planExecutable !== false && (record.llmCalls ?? []).filter((call) => call.purpose === "planning").length === 1).length, plannerRuns.length),
      plannerRepairRate: ratio(repairedPlannerRuns.length, plannerRuns.length),
      averagePlannerCallsPerRun: plannerRuns.length ? planningCalls.length / plannerRuns.length : null,
      firstPassJudgeRate: ratio(judgeRuns.filter((record) => record.llm?.status === "passed" && (record.llmCalls ?? []).filter((call) => call.purpose === "judging").length === 1).length, judgeRuns.length),
      judgeRepairRate: ratio(repairedJudgeRuns.length, judgeRuns.length),
      averageJudgeCallsPerRun: judgeRuns.length ? judgingCalls.length / judgeRuns.length : null,
      artifactIntegrityRate: ratio(compared.filter((item) => item.record.gateEligible && item.record.artifactIntegrityVerified === true && item.record.artifactsV2?.length && item.record.artifactsV2.every((artifact) => artifact.integrityStatus === "verified" && /^[a-f0-9]{64}$/.test(artifact.sha256) && (artifact.origin === "runtime-captured" || artifact.origin === "fixture"))).length, compared.length),
      groundedEvidenceRate: compared.length ? compared.reduce((sum, item) => sum + (item.record.evidenceQuality?.groundedPassedRate ?? 0), 0) / compared.length : null,
      evidenceReferenceAccuracy: ratio(validEvidenceReferences.filter(Boolean).length, validEvidenceReferences.length),
      runTraceabilityRate: ratio(compared.filter((item) => hasCompleteBenchmarkTrace(item.record)).length, compared.length),
      meanConsistency: consistencies.length ? consistencies.reduce((sum, value) => sum + value, 0) / consistencies.length : null,
      modelFailureRate: ratio(selected.filter((item) => item.llm?.status === "failed" || item.llm?.status === "not_configured" || item.llm?.fallback).length, selected.length),
      averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      p95DurationMs: percentile(durations, 0.95),
      averageLlmCallDurationMs: calls.length ? calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / calls.length : null,
      p95LlmCallDurationMs: percentile(calls.map((call) => call.durationMs ?? 0), 0.95),
      averagePlannerCallDurationMs: planningCalls.length ? planningCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / planningCalls.length : null,
      averageJudgeCallDurationMs: judgingCalls.length ? judgingCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / judgingCalls.length : null,
      blockedRate: ratio(compared.filter((item) => item.record.finalStatus === "blocked").length, compared.length),
      promptTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.promptTokens ?? 0), 0) : null,
      completionTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.completionTokens ?? 0), 0) : null,
      averagePromptTokensPerRun: usage.length ? usage.reduce((sum, item) => sum + (item?.promptTokens ?? 0), 0) / compared.length : null,
      averageCompletionTokensPerRun: usage.length ? usage.reduce((sum, item) => sum + (item?.completionTokens ?? 0), 0) / compared.length : null,
      averageTotalTokensPerRun: usage.length ? usage.reduce((sum, item) => sum + (item?.totalTokens ?? 0), 0) / compared.length : null,
      estimatedCostUsd: totalKnownCost(usage)
      ,estimatedManualMinutesAvoided: input.roi ? Math.max(0, baselineMinutes - automatedMinutes - reviewMinutes) : null
      ,estimatedHumanReviewMinutes: input.roi ? reviewMinutes : null
    };
  }
  const rules = lanes["rules-deterministic:none"];
  const full = Object.entries(lanes).filter(([key]) => key.startsWith("full-llm:")).map(([, value]) => value);
  const reasons: string[] = [];
  const majority = (values: BenchmarkVerdict[]): BenchmarkVerdict => [...new Set(values)].sort((a, b) => values.filter((item) => item === b).length - values.filter((item) => item === a).length)[0] ?? "needs_review";
  const rulesRecords = records.filter((record) => record.lane === "rules-deterministic");
  for (const [key, metrics] of Object.entries(lanes).filter(([key]) => key.startsWith("full-llm:"))) {
    const fullRecords = records.filter((record) => `${record.lane}:${record.modelProfileId ?? "none"}` === key);
    const pairs = input.cases.map((item) => {
      const expected = labels.get(item.id)?.verdict;
      const rule = majority(rulesRecords.filter((record) => record.benchmarkId === item.id).map((record) => finalVerdict(record.finalStatus) ?? record.deterministic.verdict));
      const full = majority(fullRecords.filter((record) => record.benchmarkId === item.id).map((record) => finalVerdict(record.finalStatus) ?? "needs_review"));
      return expected && rule ? { expected, rule, full } : undefined;
    }).filter((item): item is { expected: BenchmarkVerdict; rule: BenchmarkVerdict; full: BenchmarkVerdict } => Boolean(item));
    let seed = 0x5f3759df;
    const gains: number[] = [];
    for (let iteration = 0; iteration < 1000 && pairs.length; iteration += 1) {
      const sample = Array.from({ length: pairs.length }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return pairs[seed % pairs.length]; });
      gains.push((macroF1(sample.map((item) => ({ actual: item.full, expected: item.expected }))) ?? 0) - (macroF1(sample.map((item) => ({ actual: item.rule, expected: item.expected }))) ?? 0));
    }
    gains.sort((a, b) => a - b);
    // The paired interval samples benchmark cases and uses each lane's majority
    // verdict. Keep the point estimate on that same case-level estimand; the raw
    // per-repetition difference is useful, but must not be paired with this CI.
    metrics.runLevelMacroF1Gain = (metrics.macroF1 ?? 0) - (rules?.macroF1 ?? 0);
    metrics.macroF1Gain = pairs.length
      ? (macroF1(pairs.map((item) => ({ actual: item.full, expected: item.expected }))) ?? 0)
        - (macroF1(pairs.map((item) => ({ actual: item.rule, expected: item.expected }))) ?? 0)
      : null;
    metrics.macroF1GainCiLow = percentile(gains, 0.025);
    metrics.macroF1GainCiHigh = percentile(gains, 0.975);
  }
  if (input.split === "blind") {
    if (full.some((lane) => (lane.falseReleaseRate ?? 1) > input.thresholds.blindFalseReleaseMax)) reasons.push("blind_false_release");
    if (full.some((lane) => (lane.artifactIntegrityRate ?? 0) < input.thresholds.artifactIntegrityMin)) reasons.push("artifact_integrity");
    if (full.some((lane) => (lane.evidenceReferenceAccuracy ?? 0) < input.thresholds.evidenceReferenceMin)) reasons.push("evidence_reference_accuracy");
    if (full.some((lane) => (lane.groundedEvidenceRate ?? 0) < input.thresholds.evidenceGroundedMin)) reasons.push("evidence_quality");
    if (full.some((lane) => (lane.meanConsistency ?? 0) < input.thresholds.consistencyMin)) reasons.push("consistency");
    if (full.some((lane) => (lane.modelFailureRate ?? 1) > input.thresholds.modelFailureMax)) reasons.push("model_failure");
    const gain = full.length > 0 && full.every((lane) => (lane.macroF1 ?? 0) - (rules?.macroF1 ?? 0) >= input.thresholds.macroF1GainMin || (lane.taskSuccessRate ?? 0) - (rules?.taskSuccessRate ?? 0) >= input.thresholds.taskSuccessGainMin);
    if (!gain) reasons.push("no_measured_llm_gain");
    const reviewReduced = full.length > 0 && full.every((lane) => (rules?.humanReviewRate ?? 0) > 0 && ((rules!.humanReviewRate! - (lane.humanReviewRate ?? 1)) / rules!.humanReviewRate!) >= input.thresholds.humanReviewRelativeReductionMin);
    if (!reviewReduced) reasons.push("human_review_not_reduced");
  }
  if (input.split === "development") {
    if (full.some((lane) => (lane.falseReleaseRate ?? 1) > 0)) reasons.push("development_false_release");
    if (full.some((lane) => (lane.artifactIntegrityRate ?? 0) < 1 || (lane.groundedEvidenceRate ?? 0) < 1)) reasons.push("development_evidence_incomplete");
    if (full.some((lane) => (lane.modelFailureRate ?? 1) >= input.thresholds.modelFailureMax)) reasons.push("development_model_failure");
    if (full.some((lane) => (lane.humanReviewRate ?? 1) > (input.thresholds.developmentHumanReviewMax ?? 0.30))) reasons.push("development_human_review_high");
    if (full.some((lane) => (lane.taskSuccessRate ?? 0) - (rules?.taskSuccessRate ?? 0) < (input.thresholds.developmentTaskSuccessGainMin ?? -0.10))) reasons.push("development_task_success_regression");
    if (full.some((lane) => (lane.macroF1 ?? 0) - (rules?.macroF1 ?? 0) < (input.thresholds.developmentMacroF1GainMin ?? -0.05))) reasons.push("development_macro_f1_regression");
  }
  const complete = records.length === input.plannedRuns;
  return { experimentId: input.experimentId, status: complete ? "completed" : "awaiting_agent_runs", split: input.split, plannedRuns: input.plannedRuns, completedRuns: records.length, lanes, diagnostics: records.map((record) => diagnoseBenchmarkRun(record, labels.get(record.benchmarkId))), acceptance: { proven: input.split === "blind" && complete && reasons.length === 0, readyForBlind: input.split === "development" && complete && reasons.length === 0, reasons } };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function evaluateBenchmarkFromDisk(rootDir: string) {
  const benchmarkDir = path.join(rootDir, "data", "benchmark");
  const runsDir = path.join(rootDir, "reports", "benchmarks", "runs");
  const rawCases = await readJson<Array<BenchmarkCase & { projectId?: string; expectedVerdict?: BenchmarkVerdict }>>(path.join(benchmarkDir, "cases.json"));
  const cases = rawCases.map((item) => ({ ...item, title: item.title ?? item.id, requirementId: item.requirementId ?? item.id, projectProfile: item.projectProfile ?? item.projectId ?? "unknown", status: item.status ?? "awaiting_agent_runs" }));
  const labelsRoot = process.env.BENCHMARK_LABELS_ROOT;
  if (!labelsRoot) throw new Error("BENCHMARK_LABELS_ROOT is required for evaluation; labels are not readable by the Agent runtime");
  const labels = (await readJson<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "development.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console"] }));
  const runFiles = await readdir(runsDir).catch(() => [] as string[]);
  const records = await Promise.all(runFiles.filter((file) => file.endsWith(".json")).map((file) => readJson<BenchmarkRunRecord>(path.join(runsDir, file))));
  const evaluation = evaluateBenchmark(cases, labels, records);
  const outputDir = path.join(rootDir, "reports", "benchmarks");
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "latest.json"), JSON.stringify(evaluation, null, 2));
  return evaluation;
}
