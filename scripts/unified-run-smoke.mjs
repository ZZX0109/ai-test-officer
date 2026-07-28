import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const existingAgent = await fetch("http://127.0.0.1:4317/api/health").then((response) => response.ok).catch(() => false);
const existingApp = await fetch("http://127.0.0.1:6173").then((response) => response.ok).catch(() => false);
const smokeToken = existingAgent ? (process.env.AGENT_API_TOKEN ?? "dev-local-token") : "smoke-token";
const env = { ...process.env, NODE_ENV: "development", AGENT_API_TOKEN: smokeToken, HOST: "127.0.0.1", PORT: "4317", HEADLESS: "1", TRACE: "1" };
const children = [];
function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extraEnv }, detached: true, stdio: "inherit" });
  children.push(child);
  return child;
}
async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`health_timeout:${url}`);
}
async function api(route, method = "GET", body) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:4317${route}`, {
        method,
        headers: { "content-type": "application/json", "x-agent-token": smokeToken },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok) return response.json();
      const detail = await response.text();
      if (![502, 503, 504].includes(response.status)) throw new Error(`${route}:${response.status}:${detail}`);
      lastError = new Error(`${route}:${response.status}:${detail}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${route}:`) && !/:50[234]:/.test(error.message)) throw error;
      lastError = error;
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`${route}:transport_failed`);
}
try {
  if (!existingApp) start("npm", ["--workspace", "app-under-test", "run", "dev"]);
  if (!existingAgent) start("node", ["agent/dist/server.js"]);
  await Promise.all([waitFor("http://127.0.0.1:6173"), waitFor("http://127.0.0.1:4317/api/health")]);
  const key = `smoke-${Date.now()}`;
  let { run } = await api("/v1/runs", "POST", { organizationId: "local", actor: "ci-smoke", idempotencyKey: key, input: { appUrl: "http://127.0.0.1:6173", scenarioId: "task_filter_active", requirement: "Active filter only shows active tasks", executionMode: "trusted-local", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } } });
  ({ run } = await api(`/v1/runs/${run.id}/plan-approval`, "POST", { expectedVersion: run.version, actor: "ci-smoke", idempotencyKey: `${key}:plan` }));
  ({ run } = await api(`/v1/runs/${run.id}/permissions`, "POST", { expectedVersion: run.version, actor: "ci-smoke", idempotencyKey: `${key}:permission` }));
  const terminal = new Set(["completed", "failed", "blocked", "awaiting-human-review", "cancelled"]);
  while (!terminal.has(run.state)) { await new Promise((resolve) => setTimeout(resolve, 500)); ({ run } = await api(`/v1/runs/${run.id}`)); }
  const { report } = await api(`/v1/runs/${run.id}/report`);
  const { artifacts } = await api(`/v1/runs/${run.id}/artifacts`);
  if (!report.finalStatus || !report.machineGate || !report.judgeRecommendation) throw new Error("unified_decision_missing");
  if (!artifacts.some((artifact) => artifact.origin === "runtime-captured")) throw new Error("runtime_artifact_missing");
  console.log(JSON.stringify({ runId: run.id, state: run.state, finalStatus: report.finalStatus, artifactCount: artifacts.length }));
} finally {
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
}
