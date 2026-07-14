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
  baselineDerivedFromRunId?: string;
  initialVerdict?: BenchmarkVerdict;
  deterministic: JudgeLaneRecord;
  llm?: JudgeLaneRecord;
  evidence: Array<{ id: string; type: string }>;
  attribution?: { failureClass?: string; suspectFiles?: string[]; evidenceRefs: string[] };
  executionOrigin?: "agent-run" | "seeded-fixture" | "static-report";
  gateEligible?: boolean;
  agentVersion?: string;
  configHash?: string;
  targetVersion?: string;
  artifactsV2?: Array<{ id: string; type: string; origin: "runtime-captured" | "fixture" | "simulated" | "user-uploaded" | "legacy-unverified"; sha256: string; integrityStatus: "verified" | "missing" | "mismatch" }>;
  evidenceQuality?: { groundedPassedRate: number; runtimeArtifactRate: number; crossAttemptViolations: number };
  baselines?: {
    rules?: JudgeLaneRecord;
    testCommand?: JudgeLaneRecord;
  };
}

export interface ExperimentEvaluation {
  experimentId: string;
  status: "awaiting_agent_runs" | "completed" | "blocked";
  split: "development" | "blind";
  plannedRuns: number;
  completedRuns: number;
  lanes: Record<string, Record<string, number | null>>;
  acceptance: { proven: boolean; reasons: string[] };
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
    estimatedCostUsd: usage.length ? usage.reduce((sum, item) => sum + (item?.estimatedCostUsd ?? 0), 0) : null
    ,averageDurationMs: compared.length ? compared.reduce((sum, item) => sum + (item.lane.durationMs ?? 0), 0) / compared.length : null
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
  thresholds: { blindFalseReleaseMax: number; artifactIntegrityMin: number; evidenceReferenceMin: number; evidenceGroundedMin: number; macroF1GainMin: number; taskSuccessGainMin: number; humanReviewRelativeReductionMin: number; consistencyMin: number; modelFailureMax: number };
  roi?: { manualMinutesPerCase: number; reviewMinutesPerCase: number };
}): ExperimentEvaluation {
  const labels = new Map(input.labels.map((label) => [label.benchmarkId, label]));
  const records = input.records.filter((record) => record.experimentId === input.experimentId && record.split === input.split && record.status === "completed");
  const laneKeys = Array.from(new Set(records.map((record) => `${record.lane}:${record.modelProfileId ?? "none"}`)));
  const lanes: Record<string, Record<string, number | null>> = {};
  for (const key of laneKeys) {
    const selected = records.filter((record) => `${record.lane}:${record.modelProfileId ?? "none"}` === key);
    const compared = selected.map((record) => ({ record, label: labels.get(record.benchmarkId), result: record.llm && record.lane?.includes("llm") ? record.llm : record.deterministic })).filter((item): item is typeof item & { label: HumanBenchmarkLabel; result: JudgeLaneRecord } => Boolean(item.label && item.result));
    const expectedFail = compared.filter((item) => item.label.verdict !== "pass");
    const expectedPass = compared.filter((item) => item.label.verdict === "pass");
    const durations = compared.map((item) => item.result.durationMs ?? 0);
    const usage = compared.map((item) => item.result.usage).filter(Boolean);
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
    lanes[key] = {
      macroF1: macroF1(compared.map((item) => ({ actual: item.result.verdict, expected: item.label.verdict }))),
      taskSuccessRate: ratio(compared.filter((item) => item.record.executionSucceeded).length, compared.length),
      falseReleaseRate: ratio(expectedFail.filter((item) => item.result.verdict === "pass").length, expectedFail.length),
      falseBlockRate: ratio(expectedPass.filter((item) => item.result.verdict !== "pass").length, expectedPass.length),
      humanReviewRate: ratio(compared.filter((item) => item.result.verdict === "needs_review").length, compared.length),
      planExecutableRate: ratio(compared.filter((item) => item.record.planExecutable !== false).length, compared.length),
      artifactIntegrityRate: ratio(compared.filter((item) => item.record.gateEligible).length, compared.length),
      groundedEvidenceRate: compared.length ? compared.reduce((sum, item) => sum + (item.record.evidenceQuality?.groundedPassedRate ?? 0), 0) / compared.length : null,
      evidenceReferenceAccuracy: ratio(validEvidenceReferences.filter(Boolean).length, validEvidenceReferences.length),
      meanConsistency: consistencies.length ? consistencies.reduce((sum, value) => sum + value, 0) / consistencies.length : null,
      modelFailureRate: ratio(selected.filter((item) => item.llm?.status === "failed" || item.llm?.status === "not_configured").length, selected.length),
      averageDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      p95DurationMs: percentile(durations, 0.95),
      promptTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.promptTokens ?? 0), 0) : null,
      completionTokens: usage.length ? usage.reduce((sum, item) => sum + (item?.completionTokens ?? 0), 0) : null,
      estimatedCostUsd: usage.length ? usage.reduce((sum, item) => sum + (item?.estimatedCostUsd ?? 0), 0) : null
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
      const rule = rulesRecords.find((record) => record.benchmarkId === item.id)?.deterministic.verdict;
      const full = majority(fullRecords.filter((record) => record.benchmarkId === item.id).map((record) => record.llm?.verdict ?? record.deterministic.verdict));
      return expected && rule ? { expected, rule, full } : undefined;
    }).filter((item): item is { expected: BenchmarkVerdict; rule: BenchmarkVerdict; full: BenchmarkVerdict } => Boolean(item));
    let seed = 0x5f3759df;
    const gains: number[] = [];
    for (let iteration = 0; iteration < 1000 && pairs.length; iteration += 1) {
      const sample = Array.from({ length: pairs.length }, () => { seed = (1664525 * seed + 1013904223) >>> 0; return pairs[seed % pairs.length]; });
      gains.push((macroF1(sample.map((item) => ({ actual: item.full, expected: item.expected }))) ?? 0) - (macroF1(sample.map((item) => ({ actual: item.rule, expected: item.expected }))) ?? 0));
    }
    gains.sort((a, b) => a - b);
    metrics.macroF1Gain = (metrics.macroF1 ?? 0) - (rules?.macroF1 ?? 0);
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
    const gain = full.some((lane) => (lane.macroF1 ?? 0) - (rules?.macroF1 ?? 0) >= input.thresholds.macroF1GainMin || (lane.taskSuccessRate ?? 0) - (rules?.taskSuccessRate ?? 0) >= input.thresholds.taskSuccessGainMin);
    if (!gain) reasons.push("no_measured_llm_gain");
    const reviewReduced = full.some((lane) => (rules?.humanReviewRate ?? 0) > 0 && ((rules!.humanReviewRate! - (lane.humanReviewRate ?? 1)) / rules!.humanReviewRate!) >= input.thresholds.humanReviewRelativeReductionMin);
    if (!reviewReduced) reasons.push("human_review_not_reduced");
  }
  return { experimentId: input.experimentId, status: records.length < input.plannedRuns ? "awaiting_agent_runs" : "completed", split: input.split, plannedRuns: input.plannedRuns, completedRuns: records.length, lanes, acceptance: { proven: input.split === "blind" && records.length === input.plannedRuns && reasons.length === 0, reasons } };
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
