import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateExperiment, validateExperimentRunMatrix, type BenchmarkCase, type BenchmarkRunRecord, type HumanBenchmarkLabel } from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function json<T>(file: string) { return JSON.parse(await readFile(file, "utf8")) as T; }

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
  const manifest = await json<{ plannedRuns: number; split: string; suites?: string[]; status: string; caseIds?: string[]; repetitions?: number; models?: Array<{ id: string }> }>(path.join(directory, "manifest.json"));
  if (manifest.status !== "awaiting_evaluation") throw new Error(`experiment_not_ready:${manifest.status}`);
  if (!manifest.caseIds?.length) throw new Error("experiment_manifest_case_ids_missing");
  if (!manifest.repetitions || !manifest.models) throw new Error("experiment_manifest_matrix_definition_missing");
  const files = (await readdir(path.join(directory, "runs"))).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(files.map((file) => json<BenchmarkRunRecord>(path.join(directory, "runs", file))));
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
    const developmentMatrix = validateExperimentRunMatrix({ records: developmentRecords, caseIds: allDevelopmentCases.map((item) => item.id), modelIds: manifest.models.map((model) => model.id), repetitions: manifest.repetitions });
    if (!developmentMatrix.complete) throw new Error(`experiment_run_matrix_incomplete:${JSON.stringify(developmentMatrix)}`);
    evaluations.push(evaluateExperiment({ experimentId, split: "development", cases: allDevelopmentCases, labels: allDevelopmentLabels, records, plannedRuns: developmentMatrix.expectedRuns, thresholds: config.acceptance, roi: config.roi }));
  }
  if (manifest.split.includes("blind")) {
    const blindCases = (await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "blind-cases.json"))).filter((item) => selectedCaseIds.has(item.id));
    const blindLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "blind.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
    const selectedBlindLabels = blindLabels.filter((item) => selectedCaseIds.has(item.benchmarkId));
    const blindRecords = records.filter((record) => record.split === "blind");
    const blindMatrix = validateExperimentRunMatrix({ records: blindRecords, caseIds: blindCases.map((item) => item.id), modelIds: manifest.models.map((model) => model.id), repetitions: manifest.repetitions });
    if (!blindMatrix.complete) throw new Error(`experiment_blind_run_matrix_incomplete:${JSON.stringify(blindMatrix)}`);
    evaluations.push(evaluateExperiment({ experimentId, split: "blind", cases: blindCases, labels: selectedBlindLabels, records, plannedRuns: blindMatrix.expectedRuns, thresholds: config.acceptance, roi: config.roi }));
  }
  const blind = evaluations.find((item) => item.split === "blind");
  const output = {
    experimentId,
    createdAt: new Date().toISOString(),
    status: blind ? evaluations.every((item) => item.status === "completed") ? "completed" : "awaiting_agent_runs" : "awaiting_blind_runs",
    conclusion: blind ? blind.acceptance.proven ? "llm_gain_proven" : "llm_gain_not_proven" : "development_only",
    provenance: { kind: "live-evaluation", rawRecordsModified: false, blindDataIncluded: Boolean(blind) },
    evaluations
  };
  await writeFile(path.join(directory, "evaluation.json"), JSON.stringify(output, null, 2));
  await writeFile(path.join(directory, "evaluation-summary.md"), evaluationMarkdown(output));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (blind && !blind.acceptance.proven) process.exitCode = 3;
}

main().catch((error) => { console.error(error); process.exitCode = 2; });
