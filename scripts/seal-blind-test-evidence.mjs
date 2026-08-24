#!/usr/bin/env node
// Produces an evaluator-blind (sealed) view of a blind-test evidence file:
//   - assigns a random label to each lane and each non-deterministic model.
//   - the sealed view hides lane/model names; the unseal map is a SEPARATE file.
// The evaluator judges gateStatus/outcome across configs without knowing which
// config is rules-based vs LLM-based, or which model produced which run.
// "deterministic" is left in clear text (it is model-invariant, not a secret).
// Usage: node scripts/seal-blind-test-evidence.mjs <projectId>
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "reports", "external-acceptance");

function label(prefix) { return `${prefix}-${randomBytes(2).toString("hex")}`; }

function main() {
  const projectId = process.argv[2];
  if (!projectId) { console.error("usage: seal-blind-test-evidence.mjs <projectId>"); process.exit(1); }
  const file = path.join(DIR, `${projectId}.json`);
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  const lanes = evidence.lanes || [];
  const llmModels = (evidence.models || []).filter((m) => m && m !== "deterministic");
  const laneMap = Object.fromEntries(lanes.map((l) => [l, label("config")]));
  const modelMap = Object.fromEntries(llmModels.map((m) => [m, label("model")]));

  const sealedMetrics = {};
  for (const [lane, runs] of Object.entries(evidence.metrics || {})) {
    const sl = laneMap[lane] || lane;
    if (!Array.isArray(runs)) { sealedMetrics[sl] = runs; continue; } // nativeTests etc.
    sealedMetrics[sl] = runs.map((r) => ({
      repetition: r.repetition,
      model: !r.model || r.model === "deterministic" ? "deterministic" : (modelMap[r.model] || r.model),
      runId: r.runId,
      gateStatus: r.gateStatus,
      executionStatus: r.executionStatus,
      outcome: r.outcome,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    }));
  }

  const sealed = {
    schemaVersion: "1.0",
    sealedAt: new Date().toISOString(),
    studyId: label("study"),
    framework: evidence.framework,
    repository: evidence.repository,
    revision: evidence.revision,
    labelsSealed: true,
    evaluatorSeparated: true,
    repetitions: evidence.repetitions,
    configCount: lanes.length,
    modelCount: llmModels.length + 1,
    configs: Object.values(laneMap),
    models: [...Object.values(modelMap), "deterministic"],
    metrics: sealedMetrics,
    checks: evidence.checks,
    limitations: [
      ...(evidence.limitations || []).filter((l) => !lanes.concat(evidence.models || []).some((n) => n && l.includes(n))),
      "Sealed view: lane and non-deterministic model identities replaced with random labels. The unseal map is in a SEPARATE file (.unseal-key.json) and must NOT be shared with the evaluator. Judge gateStatus/outcome across configs without knowing which is rules-based vs LLM-based.",
    ],
    status: "sealed-for-evaluator-review",
    sealNote: "This is the evaluator-blind view. Do NOT give the evaluator the .unseal-key.json file. The unseal map is revealed only after the evaluation is complete.",
  };

  const sealedFile = path.join(DIR, `${projectId}.sealed.json`);
  const unsealFile = path.join(DIR, `${projectId}.unseal-key.json`);
  writeFileSync(sealedFile, JSON.stringify(sealed, null, 2));
  writeFileSync(unsealFile, JSON.stringify({ sealedAt: sealed.sealedAt, laneMap, modelMap }, null, 2));
  console.log(`sealed -> ${path.relative(ROOT, sealedFile)}`);
  console.log(`unseal map -> ${path.relative(ROOT, unsealFile)} (keep separate from evaluator)`);
  console.log(`configs: ${lanes.length} | models: ${llmModels.length + 1} | reps: ${evidence.repetitions}`);
}

main();
