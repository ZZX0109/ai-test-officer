import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const datasetPath = path.join(rootDir, "data", "memory", "retrieval-eval-v1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
const ids = new Set(cases.map((item) => item?.queryId));
const paraphraseGroups = new Set(cases.map((item) => item?.paraphraseGroup));
const crossProjectCases = cases.filter((item) => item?.projectType === "external-project" || item?.projectType === "cross-framework");

if (dataset.schemaVersion !== "1.0") throw new Error("memory_dataset_schema_invalid");
if (dataset.status !== "labels-ready-provider-run-required") throw new Error("memory_dataset_must_not_claim_provider_completion");
const thresholdKeys = ["recallAt5Min", "recallAt10Min", "meanReciprocalRankMin", "falseRecallRateAt10Max", "sourceTraceabilityRateMin"];
if (!dataset.thresholds || thresholdKeys.some((key) => typeof dataset.thresholds[key] !== "number" || dataset.thresholds[key] < 0 || dataset.thresholds[key] > 1)) {
  throw new Error("memory_dataset_thresholds_invalid");
}
if (dataset.queryCount !== 50 || cases.length !== 50 || ids.size !== 50) throw new Error("memory_dataset_requires_50_unique_queries");
if (paraphraseGroups.size !== 10 || crossProjectCases.length !== 20) throw new Error("memory_dataset_missing_paraphrase_or_cross_project_coverage");
if (!cases.every((item) => Array.isArray(item?.relevantEntryIds) && item.relevantEntryIds.length > 0
  && Array.isArray(item?.distractorEntryIds) && item.distractorEntryIds.length > 0
  && item.distractorEntryIds.every((id) => !item.relevantEntryIds.includes(id)))) {
  throw new Error("memory_dataset_label_or_distractor_invalid");
}

console.log(JSON.stringify({
  datasetId: dataset.datasetId,
  queryCount: cases.length,
  paraphraseGroups: paraphraseGroups.size,
  crossProjectCases: crossProjectCases.length,
  status: dataset.status,
  providerRun: "required",
  thresholds: dataset.thresholds
}, null, 2));
