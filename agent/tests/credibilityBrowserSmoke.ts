import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { runVisualGrayTest } from "../src/testRunner.js";
import type { CompiledPlan } from "@ai-test-officer/contracts";

const todoUrl = process.env.CREDIBILITY_TODO_URL ?? "http://127.0.0.1:6173";
const orderUrl = process.env.CREDIBILITY_ORDER_URL ?? "http://127.0.0.1:6183";
const permissionProfile = { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false };
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function isReady(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok;
  } catch {
    return false;
  }
}

async function ensureService(name: string, url: string, args: string[], externallyConfigured: boolean, extraEnv: Record<string, string> = {}) {
  if (await isReady(url)) return undefined;
  if (externallyConfigured) throw new Error(`credibility_target_unavailable:${name}:${url}`);
  const child = spawn("npm", args, {
    cwd: rootDir,
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: { ...process.env, ...extraEnv }
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isReady(url)) return child;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  child.kill("SIGTERM");
  throw new Error(`credibility_target_start_timeout:${name}:${url}`);
}

async function stopService(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch { /* already stopped */ }
}

const todoPlan: CompiledPlan = {
  scenarioId: "todo_visitor_permission",
  steps: [
    { id: "todo-open", pathId: "open_todo_lite", action: { action: "navigate", path: "/" } },
    { id: "todo-signout", pathId: "todo_visitor_permission_path", action: { action: "click", selectorRef: "triggerButtonName" } },
    { id: "todo-oracle", pathId: "todo_visitor_permission_path", action: { action: "assert", oracleId: "todo_login_required_dom" } },
    { id: "todo-signin", pathId: "todo_relogin_regression", action: { action: "click", selectorRef: "regressionTriggerButtonName" } }
  ],
  requiredOracleIds: ["todo_login_required_dom"],
  requiredEvidenceKinds: ["screenshot", "dom", "network", "console", "trace"]
};

const orderPlan: CompiledPlan = {
  scenarioId: "order_api_failure",
  steps: [
    { id: "order-open", pathId: "open_order_portal", action: { action: "navigate", path: "/" } },
    { id: "order-fail", pathId: "order_api_failure_path", action: { action: "click", selectorRef: "triggerButtonName" } },
    { id: "order-network", pathId: "order_api_failure_path", action: { action: "assert", oracleId: "order_api_failure_query" } },
    { id: "order-dom", pathId: "order_api_failure_path", action: { action: "assert", oracleId: "order_api_failure_dom" } },
    { id: "order-retry", pathId: "order_api_failure_regression", action: { action: "click", selectorRef: "retryButtonName" } }
  ],
  requiredOracleIds: ["order_api_failure_query", "order_api_failure_dom"],
  requiredEvidenceKinds: ["screenshot", "dom", "network", "console", "trace"]
};

function assertAuditable(result: Awaited<ReturnType<typeof runVisualGrayTest>>, scenarioId: string) {
  if (result.attempts?.[0]?.scenarioId !== scenarioId) throw new Error(`credibility_scenario_mismatch:${scenarioId}`);
  if (!result.outcomeSummary?.requirementCovered) throw new Error(`credibility_requirement_not_covered:${scenarioId}`);
  if (!result.outcomeSummary.artifactIntegrityVerified || !result.outcomeSummary.evidenceGrounded) throw new Error(`credibility_evidence_incomplete:${scenarioId}`);
  for (const kind of ["screenshot", "dom", "network", "console", "trace"]) {
    if (!result.artifactsV2?.some((artifact) => artifact.kind === kind && artifact.origin === "runtime-captured")) throw new Error(`credibility_artifact_missing:${scenarioId}:${kind}`);
  }
}

const todoServer = await ensureService("todo", todoUrl, ["--workspace", "app-under-test", "run", "dev"], Boolean(process.env.CREDIBILITY_TODO_URL));
const orderServer = await ensureService("order", `${orderUrl}/health`, ["--prefix", "fixtures/order-portal-lite", "run", "start"], Boolean(process.env.CREDIBILITY_ORDER_URL), { PORT: "6183" });
try {
for (let repetition = 1; repetition <= 3; repetition += 1) {
  const todo = await runVisualGrayTest({ appUrl: todoUrl, scenarioId: todoPlan.scenarioId, fixtureVariantId: "fxv_d10a7e1c4b298f63", permissionProfile, compiledPlan: todoPlan });
  assertAuditable(todo, todoPlan.scenarioId);
  if (todo.outcomeSummary?.requirementPassed) throw new Error("credibility_todo_fault_not_detected");

  const order = await runVisualGrayTest({ appUrl: orderUrl, scenarioId: orderPlan.scenarioId, fixtureVariantId: "fxv_7f3a1c92d6e8405b", permissionProfile, compiledPlan: orderPlan });
  assertAuditable(order, orderPlan.scenarioId);
}

const partial = await runVisualGrayTest({ appUrl: orderUrl, scenarioId: todoPlan.scenarioId, permissionProfile, compiledPlan: todoPlan });
if (partial.executionError?.code !== "action_binding_failure") throw new Error(`credibility_partial_error_missing:${partial.executionError?.code}`);
if (partial.outcomeSummary?.executionSucceeded || partial.finalStatus === "pass") throw new Error("credibility_partial_execution_released");
if (!partial.artifactsV2?.some((artifact) => artifact.kind === "trace") || !partial.artifactsV2.some((artifact) => artifact.kind === "dom")) throw new Error("credibility_partial_artifacts_missing");
await access(path.join(process.cwd(), "..", "reports", partial.runBundleFile.replace(/^\/artifacts\//, "")));

console.log(JSON.stringify({ status: "passed", todoRuns: 3, orderRuns: 3, partialFailureRunId: partial.id }, null, 2));
} finally {
  await stopService(orderServer);
  await stopService(todoServer);
}
