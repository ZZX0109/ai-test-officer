import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const reportDir = path.join(rootDir, "reports", "external-acceptance");
const requiredFrameworks = ["react-vite", "nextjs", "python-fastapi", "java-spring", "external-provider"];
const requiredLanes = [
  "native-tests",
  "rules-plan-rules-judge",
  "llm-plan-rules-judge",
  "rules-plan-llm-judge",
  "full-llm"
];
const terminalExecutionStatuses = new Set(["completed", "completed-with-gaps", "failed", "blocked", "aborted", "cancelled", "native-tests-executed"]);
const evaluatorReportsRoot = process.env.EXTERNAL_ACCEPTANCE_EVALUATOR_REPORTS_ROOT?.trim();

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function markdown(report) {
  const rows = report.projects.map((project) => `| ${project.id} | ${project.framework ?? "unreported"} | ${project.status} | ${project.repetitions ?? 0} | ${project.models ?? 0} | ${project.missing?.join(", ") || "—"} |`).join("\n");
  return `# External Project Acceptance Audit\n\nGenerated: ${report.generatedAt}\n\n` +
    `This audit is fail-closed: pinned project references, local fixtures, runs paused for human approval, or self-asserted integrity flags are not evidence that P0-8 has passed.\n\n` +
    `Independent evaluator reports: ${report.evaluatorReportsRootConfigured ? "configured outside the repository" : "not configured (all projects remain incomplete)"}.\n\n` +
    `Overall: **${report.passed ? "PASS" : "NOT READY"}**\n\n` +
    `Missing framework/provenance classes: ${report.missingFrameworks.length ? report.missingFrameworks.join(", ") : "none"}\n\n` +
    `| Project | Framework/provenance | Evidence status | Repetitions | Models | Missing proof |\n| --- | --- | --- | ---: | ---: | --- |\n${rows}\n\n` +
    `Required channels per completed project: ${requiredLanes.join(", ")}.\n`;
}

function isExternalDirectory(directory) {
  if (!directory) return false;
  const relative = path.relative(rootDir, path.resolve(directory));
  return relative.startsWith("..") && !path.isAbsolute(relative);
}

function laneRecords(evidence, lane) {
  const records = evidence.metrics?.[lane];
  return Array.isArray(records) ? records : [];
}

function hasTerminalExecution(record) {
  return typeof record?.runId === "string"
    && typeof record?.gateStatus === "string"
    && terminalExecutionStatuses.has(record.executionStatus);
}

function hasNativeCheckEvidence(evidence) {
  return Array.isArray(evidence.checks) && evidence.checks.some((check) =>
    check?.id === "native-tests" && ["passed", "failed"].includes(check.status)
  );
}

async function evaluatorReportFor(projectId) {
  if (!isExternalDirectory(evaluatorReportsRoot)) return { missing: "external_evaluator_report_root" };
  try {
    const report = await readJson(path.join(path.resolve(evaluatorReportsRoot), `${projectId}.json`));
    return { report };
  } catch {
    return { missing: "external_evaluator_report" };
  }
}

function validateEvaluatorReport(report, project, evidence, missing) {
  if (report.projectId !== project.id) missing.push("evaluator_project_id");
  if (report.sealedLabels !== true) missing.push("evaluator_sealed_labels");
  if (report.evaluatorSeparated !== true) missing.push("evaluator_separation");
  if (typeof report.labelManifestSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(report.labelManifestSha256)) {
    missing.push("evaluator_label_manifest_hash");
  }
  const verdicts = Array.isArray(report.verdicts) ? report.verdicts : [];
  for (const lane of requiredLanes) {
    const evidenceRunIds = new Set(laneRecords(evidence, lane).map((record) => record?.runId).filter((id) => typeof id === "string"));
    const laneVerdicts = verdicts.filter((verdict) => verdict?.lane === lane);
    if (!laneVerdicts.length) {
      missing.push(`evaluator_verdict:${lane}`);
      continue;
    }
    if (laneVerdicts.some((verdict) => !evidenceRunIds.has(verdict.runId) || !["pass", "fail", "needs-human-review"].includes(verdict.status))) {
      missing.push(`evaluator_verdict_binding:${lane}`);
    }
  }
}

const lock = await readJson(path.join(rootDir, "acceptance-projects.lock.json"));
const projects = await Promise.all(lock.projects.map(async (project) => {
  const evidenceFile = path.join(reportDir, `${project.id}.json`);
  try {
    const evidence = await readJson(evidenceFile);
    const lanes = Array.isArray(evidence.lanes) ? evidence.lanes : [];
    const models = Array.isArray(evidence.models) ? evidence.models : [];
    const repetitions = Number(evidence.repetitions ?? 0);
    const missing = [];
    if (evidence.projectId !== project.id) missing.push("project_id");
    if (evidence.framework !== project.framework) missing.push("framework");
    if (project.kind === "git") {
      if (evidence.repository !== project.repository) missing.push("repository");
      if (evidence.revision !== project.revision) missing.push("revision");
    } else if (evidence.treeSha256 !== project.treeSha256) {
      missing.push("tree_sha256");
    }
    if (typeof evidence.codeCommit !== "string" || !/^[a-f0-9]{40}$/.test(evidence.codeCommit)) missing.push("code_commit");
    if (typeof evidence.promptVersion !== "string" || evidence.promptVersion.length === 0) missing.push("prompt_version");
    if (!evidence.metrics || typeof evidence.metrics !== "object") missing.push("metrics");
    if (repetitions < 3) missing.push("three_repetitions");
    if (models.length < 2) missing.push("two_models");
    for (const lane of requiredLanes) {
      if (!lanes.includes(lane)) missing.push(`lane:${lane}`);
      const records = laneRecords(evidence, lane);
      const nativeCheckEvidence = lane === "native-tests" && hasNativeCheckEvidence(evidence);
      if (!records.length && !nativeCheckEvidence) missing.push(`lane_evidence:${lane}`);
      else if (records.some((record) => !hasTerminalExecution(record))) missing.push(`lane_execution_not_terminal:${lane}`);
    }
    const limitations = Array.isArray(evidence.limitations) ? evidence.limitations.join(" ") : "";
    if (/No evaluator-owned sealed labels were mounted/i.test(limitations)) missing.push("sealed_labels_not_executed");
    if (/No rules\/LLM comparison lanes were executed/i.test(limitations)) missing.push("comparison_lanes_not_executed");
    if (/No completion claim is made/i.test(limitations)) missing.push("completion_not_claimed");
    const evaluator = await evaluatorReportFor(project.id);
    if (evaluator.missing) missing.push(evaluator.missing);
    else validateEvaluatorReport(evaluator.report, project, evidence, missing);
    const completed = missing.length === 0;
    return {
      id: project.id,
      framework: typeof evidence.framework === "string" ? evidence.framework : undefined,
      status: completed ? "completed" : "evidence-incomplete",
      repetitions,
      models: models.length,
      missing,
      evidenceFile: path.relative(rootDir, evidenceFile)
    };
  } catch {
    return { id: project.id, status: "not-executed", repetitions: 0, models: 0, missing: ["evidence_file_missing"], evidenceFile: path.relative(rootDir, evidenceFile) };
  }
}));

const completedFrameworks = new Set(projects.filter((project) => project.status === "completed").map((project) => project.framework));
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  requiredFrameworks,
  requiredLanes,
  evaluatorReportsRootConfigured: isExternalDirectory(evaluatorReportsRoot),
  projects,
  missingFrameworks: requiredFrameworks.filter((framework) => !completedFrameworks.has(framework)),
  passed: projects.length === 5
    && projects.every((project) => project.status === "completed")
    && requiredFrameworks.every((framework) => completedFrameworks.has(framework))
};

await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "latest.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(reportDir, "latest.md"), markdown(report));
console.log(`External acceptance report: ${path.join(reportDir, "latest.md")}`);
if (!report.passed && process.env.ALLOW_INCOMPLETE_EXTERNAL_AUDIT !== "1") process.exitCode = 1;
