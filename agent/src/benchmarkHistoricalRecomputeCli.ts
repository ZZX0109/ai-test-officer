import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateExperiment, recomputeHistoricalBenchmarkRecords, type BenchmarkCase, type BenchmarkRunRecord, type HumanBenchmarkLabel } from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function json<T>(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function main() {
  const experimentId = process.env.BENCHMARK_HISTORICAL_EXPERIMENT_ID;
  const labelsRoot = process.env.BENCHMARK_LABELS_ROOT;
  if (!experimentId) throw new Error("BENCHMARK_HISTORICAL_EXPERIMENT_ID is required");
  if (!labelsRoot) throw new Error("BENCHMARK_LABELS_ROOT is required and must only be mounted into the evaluator");

  const sourceDir = path.join(rootDir, "reports", "benchmarks", "experiments", experimentId);
  const manifest = await json<{ plannedRuns: number; split: "development" | "blind"; caseIds: string[] }>(path.join(sourceDir, "manifest.json"));
  if (manifest.split !== "development") throw new Error("historical_recompute_only_supports_development_experiments");
  const rawFiles = (await readdir(path.join(sourceDir, "runs"))).filter((file) => file.endsWith(".json"));
  const rawRecords = await Promise.all(rawFiles.map((file) => json<BenchmarkRunRecord>(path.join(sourceDir, "runs", file))));
  const cases = (await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "cases.json")))
    .filter((item) => manifest.caseIds.includes(item.id));
  const labels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "development.json")))
    .filter((item) => manifest.caseIds.includes(item.benchmarkId))
    .map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
  const recomputed = recomputeHistoricalBenchmarkRecords(rawRecords, labels);
  const config = await json<{ acceptance: Parameters<typeof evaluateExperiment>[0]["thresholds"]; roi?: { manualMinutesPerCase: number; reviewMinutesPerCase: number } }>(path.join(rootDir, "data", "benchmark", "experiment.json"));
  const evaluation = evaluateExperiment({
    experimentId,
    split: "development",
    cases,
    labels,
    records: recomputed.records,
    plannedRuns: manifest.plannedRuns,
    thresholds: config.acceptance,
    roi: config.roi
  });
  const output = {
    experimentId,
    createdAt: new Date().toISOString(),
    status: "awaiting_blind_runs",
    conclusion: "development_only",
    provenance: {
      kind: "historical-recompute",
      sourceExperimentId: experimentId,
      rawRecordCount: rawRecords.length,
      formalEligibleRecordCount: recomputed.records.filter((item) => item.status === "completed").length,
      excludedRecords: recomputed.exclusions,
      rawRecordsModified: false,
      blindDataIncluded: false
    },
    evaluations: [evaluation]
  };
  const targetDir = path.join(rootDir, "reports", "benchmarks", "recomputed", experimentId);
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, "evaluation.json"), JSON.stringify(output, null, 2));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
