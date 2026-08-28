// Independent evaluator for reports produced by external-differential-
// acceptance.mjs. It owns sealed labels and never changes the Agent verdict.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const inputRoot = process.env.EXTERNAL_DIFFERENTIAL_REPORTS_ROOT?.trim();
if (!inputRoot) throw new Error("EXTERNAL_DIFFERENTIAL_REPORTS_ROOT is required");
const resolvedRoot = path.resolve(inputRoot);
const relativeRoot = path.relative(rootDir, resolvedRoot);
if (!relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) throw new Error("EXTERNAL_DIFFERENTIAL_REPORTS_ROOT must be outside the repository");
const lock = JSON.parse(await readFile(path.join(rootDir, "acceptance-projects.lock.json"), "utf8"));
const allowedClassifications = new Set(["introduced-regression", "pre-existing-defect", "fixed-by-change", "expected-change", "flaky", "environment-difference", "inconclusive"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sealedLabel = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;
const results = [];

for (const project of lock.projects) {
  const missing = [];
  let input;
  try { input = JSON.parse(await readFile(path.join(resolvedRoot, `${project.id}.json`), "utf8")); } catch { missing.push("differential_report"); }
  if (input) {
    if (input.projectId !== project.id) missing.push("project_id");
    if (!input.baseRevision || !input.headRevision) missing.push("base_head_revision");
    if (input.baseRevision === input.headRevision) missing.push("base_head_same_as_head");
    if (!input.base?.runId || !input.head?.runId || input.base.runId === input.head.runId) missing.push("independent_side_runs");
    if (!input.pairManifest?.planHash || !/^[a-f0-9]{64}$/.test(input.pairManifest.planHash)) missing.push("plan_hash");
    if (!input.pairManifest?.dataHash || !/^[a-f0-9]{64}$/.test(input.pairManifest.dataHash)) missing.push("data_hash");
    if (!input.pairManifest?.environmentHash || !/^[a-f0-9]{64}$/.test(input.pairManifest.environmentHash)) missing.push("environment_hash");
    if (!allowedClassifications.has(input.pairManifest?.classification)) missing.push("classification");
    for (const side of ["base", "head"]) {
      if (!input[side]?.state || !["completed", "failed", "blocked", "awaiting-human-review"].includes(input[side].state)) missing.push(`${side}_not_terminal`);
      if (!Array.isArray(input[side]?.artifactIds) || input[side].artifactIds.length === 0) missing.push(`${side}_artifacts`);
      if (!Array.isArray(input[side]?.evidenceRefs) || input[side].evidenceRefs.length === 0) missing.push(`${side}_evidence`);
    }
  }
  const labels = input ? {
    [input.base.runId]: { side: "base", label: sealedLabel("run") },
    [input.head.runId]: { side: "head", label: sealedLabel("run") }
  } : {};
  const labelManifestSha256 = sha256(JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))));
  const report = {
    schemaVersion: "external-differential-evaluator.v1", projectId: project.id,
    sealedLabels: true, evaluatorSeparated: true, baseHeadVerified: missing.length === 0,
    labelManifestSha256, evaluatorName: "external-differential-evaluator",
    evaluatedAt: new Date().toISOString(), missing,
    classification: input?.pairManifest?.classification,
    differentialRunId: input?.differentialRunId,
    failClosed: true
  };
  await writeFile(path.join(resolvedRoot, `${project.id}.evaluator.json`), JSON.stringify(report, null, 2));
  results.push({ projectId: project.id, status: missing.length ? "evidence-incomplete" : "completed", missing });
}

const summary = { schemaVersion: "external-differential-evaluator-summary.v1", evaluatedAt: new Date().toISOString(), passed: results.every((item) => item.status === "completed"), results };
await writeFile(path.join(resolvedRoot, "latest-differential-evaluator.json"), JSON.stringify(summary, null, 2));
console.log(`External differential evaluator: ${summary.passed ? "PASS" : "NOT READY"}`);
for (const result of results) console.log(`${result.projectId}: ${result.status}${result.missing.length ? ` missing=${result.missing.join(",")}` : ""}`);
if (!summary.passed && process.env.ALLOW_INCOMPLETE_EXTERNAL_AUDIT !== "1") process.exitCode = 1;
