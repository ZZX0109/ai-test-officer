import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateExperiment, type BenchmarkCase, type BenchmarkRunRecord, type HumanBenchmarkLabel } from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function json<T>(file: string) { return JSON.parse(await readFile(file, "utf8")) as T; }

async function main() {
  const experimentId = process.env.BENCHMARK_EXPERIMENT_ID;
  const labelsRoot = process.env.BENCHMARK_LABELS_ROOT;
  if (!experimentId) throw new Error("BENCHMARK_EXPERIMENT_ID is required");
  if (!labelsRoot) throw new Error("BENCHMARK_LABELS_ROOT is required and must only be mounted into the evaluator");
  const config = await json<{ acceptance: Parameters<typeof evaluateExperiment>[0]["thresholds"] }>(path.join(rootDir, "data", "benchmark", "experiment.json"));
  const directory = path.join(rootDir, "reports", "benchmarks", "experiments", experimentId);
  const manifest = await json<{ plannedRuns: number; split: string; status: string }>(path.join(directory, "manifest.json"));
  if (manifest.status !== "awaiting_evaluation") throw new Error(`experiment_not_ready:${manifest.status}`);
  const files = (await readdir(path.join(directory, "runs"))).filter((file) => file.endsWith(".json"));
  const records = await Promise.all(files.map((file) => json<BenchmarkRunRecord>(path.join(directory, "runs", file))));
  const developmentCases = await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "cases.json"));
  const developmentLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "development.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
  const evaluations = [evaluateExperiment({ experimentId, split: "development", cases: developmentCases, labels: developmentLabels, records, plannedRuns: records.filter((record) => record.split === "development").length, thresholds: config.acceptance })];
  if (manifest.split.includes("blind")) {
    const blindCases = await json<Array<BenchmarkCase & { projectId: string }>>(path.join(rootDir, "data", "benchmark", "blind-cases.json"));
    const blindLabels = (await json<Array<HumanBenchmarkLabel & { requiredEvidenceTypes?: string[] }>>(path.join(labelsRoot, "blind.json"))).map((item) => ({ ...item, requiredEvidenceTypes: item.requiredEvidenceTypes ?? ["screenshot", "dom", "network", "console", "trace"] }));
    evaluations.push(evaluateExperiment({ experimentId, split: "blind", cases: blindCases, labels: blindLabels, records, plannedRuns: records.filter((record) => record.split === "blind").length, thresholds: config.acceptance }));
  }
  const blind = evaluations.find((item) => item.split === "blind");
  const output = { experimentId, createdAt: new Date().toISOString(), status: evaluations.every((item) => item.status === "completed") ? "completed" : "awaiting_agent_runs", conclusion: blind ? blind.acceptance.proven ? "llm_gain_proven" : "llm_gain_not_proven" : "development_only", evaluations };
  await writeFile(path.join(directory, "evaluation.json"), JSON.stringify(output, null, 2));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (blind && !blind.acceptance.proven) process.exitCode = 3;
}

main().catch((error) => { console.error(error); process.exitCode = 2; });
