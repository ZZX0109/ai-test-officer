import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const experimentId = process.env.BENCHMARK_EXPERIMENT_ID ?? `sophnet-development-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const credentialId = process.env.BENCHMARK_SOPHNET_CREDENTIAL_ID;
if (!credentialId) throw new Error("BENCHMARK_SOPHNET_CREDENTIAL_ID is required; pass only the local credential ID, never an API key.");

const backgroundDir = path.join(rootDir, "reports", "background", experimentId);
const statusFile = path.join(backgroundDir, "status.json");
const children = [];

async function status(state, extra = {}) {
  await writeFile(statusFile, JSON.stringify({ experimentId, state, updatedAt: new Date().toISOString(), pids: children.map((child) => child.pid).filter(Boolean), ...extra }, null, 2));
}

function start(name, args, env = {}) {
  const child = spawn("npm", args, {
    cwd: rootDir,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env }
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

async function waitFor(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
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
    return JSON.parse(await readFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), "utf8"));
  } catch { return undefined; }
}

async function cleanup() {
  for (const child of [...children].reverse()) stop(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().finally(() => process.exit(0)));

try {
  await mkdir(backgroundDir, { recursive: true });
  await status("starting");
  // Do not use development watchers for a long-running benchmark. Watch mode
  // can restart or be reaped mid-experiment and turns an infrastructure blip
  // into an incomplete data set. The runner uses the already-built server and
  // fixture processes instead.
  const agent = start("agent", ["--workspace", "@ai-test-officer/agent", "run", "start"], { NODE_ENV: "development", HOST: "127.0.0.1" });
  const api = start("todo-api", ["exec", "tsx", "app-under-test/server/mockServer.ts"]);
  const web = start("todo-web", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", "6173", "--strictPort"], { npm_config_workspace: "app-under-test" });
  await waitFor("http://127.0.0.1:4317/api/health");
  await waitFor("http://127.0.0.1:6173/");
  await status("running", { agentPid: agent.pid, todoApiPid: api.pid, todoWebPid: web.pid });

  const benchmarkEnv = {
    NO_PROXY: "127.0.0.1,localhost",
    BENCHMARK_MODEL_IDS: "sophnet-gpt-5.1-codex",
    BENCHMARK_SOPHNET_CREDENTIAL_ID: credentialId,
    BENCHMARK_CASE_IDS: "todo-create-valid,todo-filter-completed,todo-viewer-permission,order-filter-pending,order-viewer-permission,order-api-failure",
    BENCHMARK_EXPERIMENT_ID: experimentId,
    BENCHMARK_REPETITIONS: "3",
    BENCHMARK_RUN_TIMEOUT_MS: "180000"
  };
  await run("benchmark", ["run", "benchmark:run"], benchmarkEnv);
  await status("evaluating", { progress: await readProgress() });
  await run("evaluator", ["run", "benchmark:evaluate"], { ...benchmarkEnv, BENCHMARK_LABELS_ROOT: path.join(rootDir, "evaluation", "benchmark-labels") });
  await run("tests", ["test"]);
  await run("typecheck", ["run", "typecheck"]);
  await run("build", ["run", "build"]);
  await run("demo", ["run", "demo:verify"]);
  await run("production-acceptance", ["run", "acceptance:production"]);
  await status("completed", { progress: await readProgress() });
} catch (error) {
  await status("failed", { error: error instanceof Error ? error.message : String(error), progress: await readProgress() });
  process.exitCode = 1;
} finally {
  await cleanup();
}
