import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const experimentId = process.env.BENCHMARK_EXPERIMENT_ID ?? `sophnet-development-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const credentialId = process.env.BENCHMARK_SOPHNET_CREDENTIAL_ID;
if (!credentialId) throw new Error("BENCHMARK_SOPHNET_CREDENTIAL_ID is required; pass only the local credential ID, never an API key.");
const benchmarkSplit = process.env.BENCHMARK_SPLIT ?? "development";
const runPostBenchmarkChecks = process.env.BENCHMARK_POST_RUN_CHECKS !== "0";
const sealedRun = ["blind", "development+blind", "holdout", "development+holdout"].includes(benchmarkSplit);
const evaluatorLabelsRoot = process.env.BENCHMARK_LABELS_ROOT;
const evaluatorReportsRoot = process.env.BENCHMARK_EVALUATOR_REPORTS_ROOT;

function assertExternalEvaluatorDirectory(value, name) {
  if (!value) throw new Error(`${name}_required_for_blind_benchmark`);
  const resolved = path.resolve(value);
  if (resolved === rootDir || resolved.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error(`${name}_must_be_outside_workspace_for_blind_benchmark`);
  }
  return resolved;
}

const sealedLabelsRoot = sealedRun ? assertExternalEvaluatorDirectory(evaluatorLabelsRoot, "BENCHMARK_LABELS_ROOT") : undefined;
const sealedReportsRoot = sealedRun ? assertExternalEvaluatorDirectory(evaluatorReportsRoot, "BENCHMARK_EVALUATOR_REPORTS_ROOT") : undefined;

const backgroundDir = path.join(rootDir, "reports", "background", experimentId);
const statusFile = path.join(backgroundDir, "status.json");
const children = [];
const instanceId = `benchmark_${experimentId}_${randomUUID().slice(0, 8)}`;
const {
  BENCHMARK_LABELS_ROOT: _evaluatorLabelsRoot,
  BENCHMARK_EVALUATOR_REPORTS_ROOT: _evaluatorReportsRoot,
  ...runtimeEnvironment
} = process.env;

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

async function status(state, extra = {}) {
  const payload = { experimentId, state, updatedAt: new Date().toISOString(), pids: children.map((child) => child.pid).filter(Boolean), ...extra };
  await atomicJson(statusFile, payload);
  const progress = extra.progress && extra.progress.experimentId === experimentId ? extra.progress : undefined;
  // `benchmark:evaluate` replaces latest.json with its evaluation envelope.
  // Preserve the actual matrix counters when the supervisor writes the final
  // lifecycle state instead of accidentally reporting a completed 0/0 run.
  const evaluation = Array.isArray(progress?.evaluations)
    ? progress.evaluations.find((item) => item?.experimentId === experimentId)
    : undefined;
  const completedRuns = progress?.completedRuns ?? evaluation?.completedRuns ?? 0;
  const plannedRuns = progress?.plannedRuns ?? evaluation?.plannedRuns ?? 0;
  const blockers = progress?.blockers ?? evaluation?.acceptance?.reasons ?? [];
  const benchmarkStatus = state === "failed" ? "failed" : state === "completed" ? "completed" : state === "evaluating" ? "evaluating" : "running";
  await atomicJson(path.join(rootDir, "reports", "benchmarks", "latest.json"), {
    experimentId,
    status: benchmarkStatus,
    completedRuns,
    plannedRuns,
    requestedPlannedRuns: progress?.requestedPlannedRuns,
    blockers,
    partial: progress?.partial ?? false,
    backgroundState: state,
    ...(extra.error ? { error: extra.error } : {})
  });
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("benchmark_port_reservation_failed")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function buildId() {
  const source = await readFile(path.join(rootDir, "agent", "dist", "server.js"));
  return createHash("sha256").update(source).digest("hex");
}

function start(name, args, env = {}) {
  const child = spawn("npm", args, {
    cwd: rootDir,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    // Labels are evaluator-only. Do not inherit them into the agent, fixture,
    // or benchmark-runner process even when this parent has them for the final
    // evaluation step.
    env: {
      ...runtimeEnvironment,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ...env
    }
  });
  children.push(child);
  const log = path.join(backgroundDir, `${name}.log`);
  const output = createWriteStream(log, { flags: "a" });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  return child;
}

function stop(child) {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* already stopped */ }
}

async function waitFor(url, timeoutMs = 45_000, verify) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (!verify || await verify(response))) return;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`background_service_timeout:${url}`);
}

function run(name, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = start(name, args, env);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(undefined) : reject(new Error(`background_step_failed:${name}:${code ?? "signal"}`)));
  });
}

async function readProgress() {
  try {
    const progress = JSON.parse(await readFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), "utf8"));
    return progress?.experimentId === experimentId ? progress : undefined;
  } catch { return undefined; }
}

async function cleanup() {
  for (const child of [...children].reverse()) stop(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().finally(() => process.exit(0)));

try {
  await mkdir(backgroundDir, { recursive: true });
  await status("starting");
  // Benchmarks never borrow a developer's fixed ports. Build first, then own
  // a fresh Agent + Todo + Order service group with a verifiable instance id.
  await run("agent-build", ["--workspace", "@ai-test-officer/agent", "run", "build"]);
  const [agentPort, todoApiPort, todoWebPort, orderPort] = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort()]);
  const benchmarkRunTimeoutMs = process.env.BENCHMARK_RUN_TIMEOUT_MS ?? "600000";
  const agentBuildId = await buildId();
  const todoUrl = `http://127.0.0.1:${todoWebPort}`;
  const orderUrl = `http://127.0.0.1:${orderPort}`;
  const agent = start("agent", ["--workspace", "@ai-test-officer/agent", "run", "start"], {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(agentPort),
    BENCHMARK_INSTANCE_ID: instanceId,
    AGENT_BUILD_ID: agentBuildId,
    // Parent aggregation happens inside the Agent process.  Keep its watchdog
    // on the same wall-clock budget as the client runner so it cannot remain
    // alive after the experiment has timed out and torn down its fixtures.
    PARENT_AGGREGATION_TIMEOUT_MS: benchmarkRunTimeoutMs
  });
  const api = start("todo-api", ["exec", "tsx", "app-under-test/server/mockServer.ts"], {
    APP_API_HOST: "127.0.0.1",
    APP_API_PORT: String(todoApiPort),
    APP_ALLOWED_ORIGINS: todoUrl
  });
  const web = start("todo-web", ["--workspace", "app-under-test", "exec", "--", "vite", "--host", "127.0.0.1", "--port", String(todoWebPort), "--strictPort"], {
    VITE_APP_API_URL: `http://127.0.0.1:${todoApiPort}`
  });
  const order = start("order-web", ["--prefix", "fixtures/order-portal-lite", "run", "start"], { PORT: String(orderPort) });
  await waitFor(`http://127.0.0.1:${agentPort}/api/health`, 45_000, async (response) => {
    const health = await response.json().catch(() => undefined);
    return health?.instanceId === instanceId && health?.buildId === agentBuildId;
  });
  await waitFor(`${todoUrl}/`);
  await waitFor(`${orderUrl}/health`);
  await status("running", {
    agentPid: agent.pid,
    todoApiPid: api.pid,
    todoWebPid: web.pid,
    orderWebPid: order.pid,
    services: { instanceId, agentBuildId, agentUrl: `http://127.0.0.1:${agentPort}`, todoApiUrl: `http://127.0.0.1:${todoApiPort}`, todoUrl, orderUrl }
  });

  const benchmarkEnv = Object.fromEntries(Object.entries({
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    AGENT_URL: `http://127.0.0.1:${agentPort}`,
    BENCHMARK_LOCAL_TARGET_URLS: JSON.stringify({ todo_lite: todoUrl, order_portal_lite: orderUrl }),
    BENCHMARK_MODEL_IDS: "sophnet-gpt-5.1-codex",
    BENCHMARK_SOPHNET_CREDENTIAL_ID: credentialId,
    BENCHMARK_SPLIT: benchmarkSplit,
    BENCHMARK_HOLDOUT_CASES_FILE: process.env.BENCHMARK_HOLDOUT_CASES_FILE,
    BENCHMARK_DEVELOPMENT_EXPERIMENT_ID: process.env.BENCHMARK_DEVELOPMENT_EXPERIMENT_ID,
    BENCHMARK_LANES: process.env.BENCHMARK_LANES,
    BENCHMARK_CASE_IDS: process.env.BENCHMARK_CASE_IDS ?? (sealedRun ? undefined : "todo-create-valid,todo-filter-completed,todo-viewer-permission,order-filter-pending,order-viewer-permission,order-api-failure"),
    BENCHMARK_EXPERIMENT_ID: experimentId,
    BENCHMARK_REPETITIONS: process.env.BENCHMARK_REPETITIONS ?? "3",
    BENCHMARK_RUN_TIMEOUT_MS: benchmarkRunTimeoutMs,
    PARENT_AGGREGATION_TIMEOUT_MS: benchmarkRunTimeoutMs
  }).filter(([, value]) => value !== undefined));
  await run("benchmark", ["run", "benchmark:run"], benchmarkEnv);
  await status("evaluating", { progress: await readProgress() });
  await run("evaluator", ["run", "benchmark:evaluate"], {
    ...benchmarkEnv,
    BENCHMARK_LABELS_ROOT: sealedLabelsRoot ?? process.env.BENCHMARK_LABELS_ROOT ?? path.join(rootDir, "evaluation", "benchmark-labels"),
    BENCHMARK_EVALUATOR_REPORTS_ROOT: sealedReportsRoot ?? process.env.BENCHMARK_EVALUATOR_REPORTS_ROOT
  });
  // A focused service/Graph smoke may opt out of the expensive full project
  // gate. Formal 30/90 experiments retain the default and always execute it.
  if (runPostBenchmarkChecks) {
    await run("tests", ["test"]);
    await run("typecheck", ["run", "typecheck"]);
    await run("build", ["run", "build"]);
    await run("demo", ["run", "demo:verify"]);
    await run("production-acceptance", ["run", "acceptance:production"]);
  }
  await status("completed", { progress: await readProgress() });
} catch (error) {
  await status("failed", { error: error instanceof Error ? error.message : String(error), progress: await readProgress() });
  process.exitCode = 1;
} finally {
  await cleanup();
}
