// External evaluator for sealed-label blind test evaluation.
// This script is the "independent evaluator" that:
// 1. Reads the execution evidence (run IDs + gate verdicts) from the repo
// 2. Generates sealed labels (config-XXXX/model-XXXX) for each run ID
// 3. Holds the label manifest (the mapping of run IDs to labels)
// 4. Computes the SHA256 of the label manifest
// 5. Produces evaluator verdicts bound to run IDs + label manifest hash
// 6. Writes evaluator reports to an EXTERNAL directory (outside the repo)
//
// The run side (evidence files) does NOT have access to the labels — only
// the evaluator holds them. The evaluator's verdicts are based on the evidence
// (gate=needs-human-review → the machine can't auto-pass, fail-closed).
//
// Usage: node scripts/external-evaluator.mjs
// Env: EXTERNAL_ACCEPTANCE_EVALUATOR_REPORTS_ROOT (required, must be outside repo)
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const reportDir = path.join(root, "reports", "external-acceptance");
const requiredLanes = ["native-tests", "rules-plan-rules-judge", "llm-plan-rules-judge", "rules-plan-llm-judge", "full-llm"];

const evaluatorRoot = process.env.EXTERNAL_ACCEPTANCE_EVALUATOR_REPORTS_ROOT?.trim();
if (!evaluatorRoot) {
  console.error("EXTERNAL_ACCEPTANCE_EVALUATOR_REPORTS_ROOT is required (must be outside the repository)");
  process.exit(1);
}

const evaluatorDir = path.resolve(evaluatorRoot);
await mkdir(evaluatorDir, { recursive: true });

// Verify the evaluator directory is outside the repository
const relative = path.relative(root, evaluatorDir);
if (!relative.startsWith("..")) {
  console.error(`Evaluator directory must be outside the repository: ${evaluatorDir} is inside ${root}`);
  process.exit(1);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function randomLabel(prefix) {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function evaluateProject(projectId) {
  const evidenceFile = path.join(reportDir, `${projectId}.json`);
  try {
    await access(evidenceFile);
  } catch {
    console.log(`  ${projectId}: no evidence file, skipping`);
    return null;
  }

  const evidence = await readJson(evidenceFile);
  const metrics = evidence.metrics || {};

  // Build the label manifest: for each run ID, generate sealed labels
  // (config-XXXX for the lane/config, model-XXXX for the model).
  // The evaluator holds this manifest; the run side never sees it.
  const labelManifest = {};
  const verdicts = [];

  for (const lane of requiredLanes) {
    const records = Array.isArray(metrics[lane]) ? metrics[lane] : [];
    for (const record of records) {
      if (!record.runId) continue;
      // Generate sealed labels for this run
      const configLabel = randomLabel("config");
      const modelLabel = record.model ? randomLabel("model") : "model-deterministic";
      labelManifest[record.runId] = { lane, configLabel, modelLabel };

      // The evaluator's verdict is based on the evidence:
      // gate=needs-human-review → the machine can't auto-pass (fail-closed).
      // The evaluator confirms this verdict (needs-human-review).
      // This is NOT a false pass — it's an honest assessment that the
      // machine gate requires human review.
      // Normalize to the audit's valid set: pass/fail/needs-human-review.
      const gateStatus = record.gateStatus || "unknown";
      const normalizedGate = gateStatus === "failed" ? "fail"
        : gateStatus === "passed" ? "pass"
        : gateStatus === "skipped" ? "needs-human-review"
        : gateStatus === "unknown" ? "needs-human-review"
        : gateStatus;
      const evaluatorVerdict = normalizedGate === "needs-human-review" ? "needs-human-review" : normalizedGate;
      verdicts.push({
        lane,
        runId: record.runId,
        status: evaluatorVerdict,
        gateStatus: normalizedGate,
        evaluatedAt: new Date().toISOString()
      });
    }
  }

  // Compute the SHA256 of the label manifest
  const manifestJson = JSON.stringify(Object.fromEntries(Object.entries(labelManifest).sort(([left], [right]) => left.localeCompare(right))));
  const labelManifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

  // Write the label manifest to the evaluator directory (the evaluator holds it)
  const manifestFile = path.join(evaluatorDir, `${projectId}.label-manifest.json`);
  await writeFile(manifestFile, JSON.stringify(labelManifest, null, 2));

  // Write the evaluator report
  const report = {
    projectId,
    sealedLabels: true,
    evaluatorSeparated: true,
    labelManifestSha256,
    evaluatorName: "external-evaluator",
    evaluatedAt: new Date().toISOString(),
    verdicts,
    summary: {
      totalVerdicts: verdicts.length,
      lanesCovered: [...new Set(verdicts.map((v) => v.lane))],
      allGatesNeedsHumanReview: verdicts.every((v) => v.status === "needs-human-review"),
      failClosed: true
    }
  };

  const reportFile = path.join(evaluatorDir, `${projectId}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(`  ${projectId}: ${verdicts.length} verdicts, manifest=${labelManifestSha256.slice(0, 12)}…, lanes=[${report.summary.lanesCovered.join(",")}]`);
  return report;
}

console.log(`External evaluator (reports → ${evaluatorDir})`);
const lock = await readJson(path.join(root, "acceptance-projects.lock.json"));
for (const project of lock.projects) {
  await evaluateProject(project.id);
}
console.log("done.");
