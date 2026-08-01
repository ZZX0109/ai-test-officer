import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { runVisualGrayTest } from "../src/testRunner.js";

const appUrl = process.env.COMPILED_PLAN_SMOKE_URL ?? "http://127.0.0.1:6173";
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function isReady(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

async function ensureAppServer() {
  if (await isReady(appUrl)) return undefined;
  if (process.env.COMPILED_PLAN_SMOKE_URL) throw new Error(`compiled_plan_smoke_target_unavailable:${appUrl}`);
  const child = spawn("npm", ["--workspace", "app-under-test", "run", "dev"], {
    cwd: rootDir,
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: { ...process.env }
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isReady(appUrl)) return child;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill("SIGTERM");
  throw new Error(`compiled_plan_smoke_target_start_timeout:${appUrl}`);
}

async function stopAppServer(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch { /* already stopped */ }
}

const appServer = await ensureAppServer();
try {
const result = await runVisualGrayTest({
  appUrl,
  scenarioId: "task_filter_completed",
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  },
  compiledPlan: {
    scenarioId: "task_filter_completed",
    steps: [
      { id: "open", pathId: "open_task_page", action: { action: "navigate", path: "/" } },
      { id: "click", pathId: "completed_filter_path", action: { action: "click", selectorRef: "triggerButtonName" } },
      { id: "query", pathId: "completed_filter_path", action: { action: "assert", oracleId: "completed_filter_query" } },
      { id: "dom", pathId: "completed_filter_path", action: { action: "assert", oracleId: "completed_filter_dom" } },
      { id: "regression", pathId: "all_filter_regression", action: { action: "click", selectorRef: "regressionTriggerButtonName" } }
    ],
    requiredOracleIds: ["completed_filter_query", "completed_filter_dom"],
    requiredEvidenceKinds: ["screenshot", "dom", "network", "console", "trace"]
  }
});

if (result.assertions.some((assertion) => !assertion.passed)) {
  throw new Error(`compiled_plan_smoke_assertion_failed:${result.id}`);
}
const executed = result.steps.map((step) => step.stepId);
for (const stepId of ["open", "click", "query", "dom", "regression"]) {
  if (!executed.includes(stepId)) throw new Error(`compiled_plan_smoke_step_missing:${stepId}`);
  const stepObservations = result.evidence.filter((item) =>
    item.type === "dom"
    && item.stepId === stepId
    && (item.title.startsWith("操作前页面观测") || item.title.startsWith("操作后页面观测"))
  );
  if (stepObservations.length !== 2) {
    throw new Error(`compiled_plan_smoke_step_observation_missing:${stepId}:${stepObservations.length}`);
  }
  if (stepObservations.some((item) => !item.artifactIds?.length || !item.locator?.snapshotSha256)) {
    throw new Error(`compiled_plan_smoke_step_observation_unlinked:${stepId}`);
  }
}
if (!result.artifactsV2?.some((artifact) => artifact.kind === "trace")) {
  throw new Error("compiled_plan_smoke_trace_missing");
}
if (result.artifactsV2.some((artifact) => !artifact.stepId)) {
  throw new Error("compiled_plan_smoke_artifact_step_link_missing");
}
if (!result.riskCoverageMatrix.find((item) => item.riskId === "risk_smoke")?.passed) {
  throw new Error("compiled_plan_smoke_risk_not_covered");
}
if (!result.riskCoverageMatrix.find((item) => item.riskId === "risk_regression")?.passed) {
  throw new Error("compiled_plan_regression_risk_not_covered");
}
console.log(JSON.stringify({ runId: result.id, finalStatus: result.finalStatus, executed, artifactKinds: result.artifactsV2.map((artifact) => artifact.kind) }, null, 2));
} finally {
  await stopAppServer(appServer);
}
