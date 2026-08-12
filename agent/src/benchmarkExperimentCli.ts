import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateExperiment,
  validateExperimentRunMatrix,
  type BenchmarkCase,
  type BenchmarkRunRecord,
  type ExperimentEvaluation,
  type HumanBenchmarkLabel
} from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function json<T>(file: string) { return JSON.parse(await readFile(file, "utf8")) as T; }

/** Avoid a dashboard observing a half-written experiment lifecycle document. */
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

function externalDirectory(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name}_required_for_blind_evaluation`);
  const resolved = path.resolve(value);
  if (resolved === rootDir || resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`${name}_must_be_outside_workspace_for_blind_evaluation`);
  }
  return resolved;
}

type EvaluationOutput = {
  experimentId: string;
  createdAt: string;
  status: string;
  conclusion: string;
  provenance: Record<string, unknown>;
  evaluations: ExperimentEvaluation[];
};

function publicEvaluation<T extends EvaluationOutput>(output: T): T {
  return {
    ...output,
    evaluations: output.evaluations.map((evaluation) => ({
      ...evaluation,
      // A public blind report must not let a developer infer evaluator labels
      // from a per-run mismatch, failure category, or expected scenario. The
      // complete diagnostic stays in the evaluator-owned report directory.
      diagnostics: evaluation.split === "blind" || evaluation.split === "holdout" ? [] : evaluation.diagnostics
    }))
  } as T;
}

function pct(value: unknown) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
}

function evaluationMarkdown(output: { experimentId: string; conclusion: string; evaluations: Array<{ split: string; completedRuns: number; plannedRuns: number; lanes: Record<string, Record<string, number | null>>; diagnostics: Array<{ benchmarkId: string; lane: string; repetition: number; expectedScenarioId?: string; selectedScenarioId?: string; primaryCause?: string; effects: string[]; browserStarted: boolean; recommendationValid: boolean; finalStatus?: string }> }> }) {
  const lines = [
    `# Benchmark isolated evaluation: ${output.experimentId}`,
    "",
    `Conclusion: **${output.conclusion}**`,
    "",
    "> Scheduling completion only means a run record reached a terminal workflow state. It does not imply execution success, requirement coverage, gate eligibility, or a correct final decision.",
    ""
  ];
  for (const evaluation of output.evaluations) {
    lines.push(`## ${evaluation.split} (${evaluation.completedRuns}/${evaluation.plannedRuns} scheduled records)`, "", "| Lane | Scheduled | Executed | Requirement covered | Gate eligible | Recommendation correct | Final status correct | Task success | Macro-F1 | False release | False block | Human review | Artifact integrity | Stream fallback | Avg tokens |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const [lane, metrics] of Object.entries(evaluation.lanes)) {
      lines.push(`| ${lane} | ${pct(metrics.schedulingCompletionRate)} | ${pct(metrics.executionSuccessRate)} | ${pct(metrics.requirementCoverageRate)} | ${pct(metrics.gateEligibleRate)} | ${pct(metrics.recommendationAccuracy)} | ${pct(metrics.finalStatusAccuracy)} | ${pct(metrics.taskSuccessRate)} | ${typeof metrics.macroF1 === "number" ? metrics.macroF1.toFixed(3) : "—"} | ${pct(metrics.falseReleaseRate)} | ${pct(metrics.falseBlockRate)} | ${pct(metrics.humanReviewRate)} | ${pct(metrics.artifactIntegrityRate)} | ${pct(metrics.transportFallbackRate)} | ${typeof metrics.averageTotalTokensPerRun === "number" ? Math.round(metrics.averageTotalTokensPerRun) : "—"} |`);
    }
    lines.push("", "### Per-run diagnosis", "", "| Case | Lane | Rep | Expected scenario | Selected scenario | Primary cause | Effects | Browser started | Recommendation valid | Final status |", "|---|---|---:|---|---|---|---|---:|---:|---|");
    for (const item of evaluation.diagnostics) lines.push(`| ${item.benchmarkId} | ${item.lane} | ${item.repetition} | ${item.expectedScenarioId ?? "—"} | ${item.selectedScenarioId ?? "—"} | ${item.primaryCause ?? "—"} | ${item.effects.join(", ") || "—"} | ${item.browserStarted ? "yes" : "no"} | ${item.recommendationValid ? "yes" : "no"} | ${item.finalStatus ?? "—"} |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const experimentId = process.env.BENCHMARK_EXPERIMENT_ID;
  const labelsRoot = process.env.BENCHMARK_LABELS_ROOT;
  if (!experimentId) throw new Error("BENCHMARK_EXPERIMENT_ID is required");
  if (!labelsRoot) throw new Error("BENCHMARK_LABELS_ROOT is required and must only be mounted into the evaluator");
  const config = await json<{ acceptance: Parameters<typeof evaluateExperiment>[0]["thresholds"]; roi?: { manualMinutesPerCase: number; reviewMinutesPerCase: number } }>(path.join(rootDir, "data", "benchmark", "experiment.json"));
  const directory = path.join(rootDir, "reports", "benchmarks", "experiments", experimentId);
  const manifest = await json<{ plannedRuns: number; split: string; suites?: string[]; status: string; caseIds?: string[]; repetitions?: number; lanes?: BenchmarkRunRecord["lane"][]; models?: Array<{ id: string }> }>(path.join(directory, "manifest.json"));
  const sealedEvaluation = manifest.split.includes("blind") || manifest.split.includes("holdout");
  const evaluatorReportsRoot = sealedEvaluation
    ? externalDirectory(process.env.BENCHMARK_EVALUATOR_REPORTS_ROOT, "BENCHMARK_EVALUATOR_REPORTS_ROOT")
    : undefined;
  if (sealedEvaluation) externalDirectory(labelsRoot, "BENCHMARK_LABELS_ROOT");
  // Evaluation is a derived, immutable-from-raw-records snapshot.  Allow a
  // completed experiment to be re-evaluated after an evaluator bug fix; do
  // not require mutating the manifest back to a pseudo-running state.
  if (manifest.status !== "awaiting_evaluation" && manifest.status !== "completed") {
    throw new Error(`experiment_not_ready:${manifest.status}`);
  }
  if (!manifest.caseIds?.length) throw new Error("experiment_manifest_case_ids_missing");
  if (!manifest.repetitions || !manifest.models) throw new Error("experiment_manifest_matrix_definition_missing");
  const files = (await readdir(path.join(directory, "runs"))).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(files.map((file) => json<BenchmarkRunRecord>(path.join(directory, "runs", file))));
  // Older scoped experiments predate the lanes field; infer their exact matrix
  // from persisted records rather than pretending they must be a full 90-run
  // release experiment.
  const matrixLanes = manifest.lanes?.length ? manifest.lanes : [...new Set(records.map((record) => record.lane))];
  const selectedCaseIds = new Set(manifest.caseIds);
  const evaluations: ReturnType<typeof evaluateExperiment>[] = [];
  if (manifest.split.includes("development")) {
    const developmentCases = await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "cases.json"));
    const extendedCases = manifest.suites?.includes("extended") ? await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "extended-cases.json")) : [];
    const developmentLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "development.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
    const extendedLabels = extendedCases.length ? (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "extended.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] })) : [];
    const allDevelopmentCases = [...developmentCases, ...extendedCases].filter((item) => selectedCaseIds.has(item.id));
    const allDevelopmentLabels = [...developmentLabels, ...extendedLabels].filter((item) => selectedCaseIds.has(item.benchmarkId));
    const developmentRecords = records.filter((record) => record.split === "development");
    const developmentMatrix = validateExperimentRunMatrix({ records: developmentRecords, caseIds: allDevelopmentCases.map((item) => item.id), modelIds: manifest.models.map((model) => model.id), repetitions: manifest.repetitions, lanes: matrixLanes });
    if (!developmentMatrix.complete) throw new Error(`experiment_run_matrix_incomplete:${JSON.stringify(developmentMatrix)}`);
    evaluations.push(evaluateExperiment({ experimentId, split: "development", cases: allDevelopmentCases, labels: allDevelopmentLabels, records, plannedRuns: developmentMatrix.expectedRuns, thresholds: config.acceptance, roi: config.roi }));
  }
  if (manifest.split.includes("blind")) {
    const blindCases = (await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "blind-cases.json"))).filter((item) => selectedCaseIds.has(item.id));
    const blindLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "blind.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
    const selectedBlindLabels = blindLabels.filter((item) => selectedCaseIds.has(item.benchmarkId));
    const blindRecords = records.filter((record) => record.split === "blind");
    const blindMatrix = validateExperimentRunMatrix({ records: blindRecords, caseIds: blindCases.map((item) => item.id), modelIds: manifest.models.map((model) => model.id), repetitions: manifest.repetitions, lanes: matrixLanes });
    if (!blindMatrix.complete) throw new Error(`experiment_blind_run_matrix_incomplete:${JSON.stringify(blindMatrix)}`);
    evaluations.push(evaluateExperiment({ experimentId, split: "blind", cases: blindCases, labels: selectedBlindLabels, records, plannedRuns: blindMatrix.expectedRuns, thresholds: config.acceptance, roi: config.roi }));
  }
  if (manifest.split.includes("holdout")) {
    const holdoutCaseFile = path.basename(process.env.BENCHMARK_HOLDOUT_CASES_FILE ?? "holdout-cases.json");
    const holdoutCases = (await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", holdoutCaseFile))).filter((item) => selectedCaseIds.has(item.id));
    const holdoutLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "holdout.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
    const selectedHoldoutLabels = holdoutLabels.filter((item) => selectedCaseIds.has(item.benchmarkId));
    const holdoutRecords = records.filter((record) => record.split === "holdout");
    const holdoutMatrix = validateExperimentRunMatrix({ records: holdoutRecords, caseIds: holdoutCases.map((item) => item.id), modelIds: manifest.models.map((model) => model.id), repetitions: manifest.repetitions, lanes: matrixLanes });
    if (!holdoutMatrix.complete) throw new Error(`experiment_holdout_run_matrix_incomplete:${JSON.stringify(holdoutMatrix)}`);
    evaluations.push(evaluateExperiment({ experimentId, split: "holdout", cases: holdoutCases, labels: selectedHoldoutLabels, records, plannedRuns: holdoutMatrix.expectedRuns, thresholds: config.acceptance, roi: config.roi }));
  }
  const blind = evaluations.find((item) => item.split === "blind");
  const holdout = evaluations.find((item) => item.split === "holdout");
  const output = {
    experimentId,
    createdAt: new Date().toISOString(),
    status: blind || holdout ? evaluations.every((item) => item.status === "completed") ? "completed" : "awaiting_agent_runs" : "awaiting_blind_runs",
    conclusion: blind ? blind.acceptance.proven ? "llm_gain_proven" : "llm_gain_not_proven" : holdout ? holdout.acceptance.reasons.length === 0 ? "holdout_validation_passed" : "holdout_validation_failed" : "development_only",
    provenance: { kind: "live-evaluation", rawRecordsModified: false, blindDataIncluded: Boolean(blind), holdoutDataIncluded: Boolean(holdout), holdoutIsThirdPartyBlind: false },
    evaluations
  };
  const publicOutput = sealedEvaluation ? publicEvaluation(output) : output;
  if (sealedEvaluation) {
    const evaluatorDirectory = path.join(evaluatorReportsRoot!, experimentId);
    await mkdir(evaluatorDirectory, { recursive: true });
    await writeFile(path.join(evaluatorDirectory, "evaluation.json"), JSON.stringify(output, null, 2));
    await writeFile(path.join(evaluatorDirectory, "evaluation-summary.md"), evaluationMarkdown(output));
  }
  await atomicJson(path.join(directory, "evaluation.json"), publicOutput);
  await writeFile(path.join(directory, "evaluation-summary.md"), evaluationMarkdown(publicOutput));
  await atomicJson(path.join(rootDir, "reports", "benchmarks", "latest.json"), publicOutput);
  // `awaiting_evaluation` is a transient runner state. Once an evaluator has
  // emitted a complete matrix it must never leave the experiment manifest
  // looking active; a supervisor restart would otherwise report contradictory
  // lifecycle states for the exact same experiment.
  await atomicJson(path.join(directory, "manifest.json"), {
    ...manifest,
    status: "completed",
    completedRuns: records.length,
    evaluatedAt: output.createdAt,
    evaluationStatus: publicOutput.status,
    conclusion: publicOutput.conclusion
  });
  console.log(JSON.stringify(publicOutput, null, 2));
  if (blind && !blind.acceptance.proven) process.exitCode = 3;
}

main().catch((error) => { console.error(error); process.exitCode = 2; });
