// Production-backed capacity evidence (#2/#5): Worker API load, SSE stream
// concurrency, and real Workbench browser-context concurrency in one isolated
// Postgres/Redis/MinIO/Keycloak acceptance stack.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const outDir = path.join(root, "reports", "production-capacity");
const apiBase = "http://127.0.0.1:14317";
const oidcBase = "http://127.0.0.1:18080";
const workbenchUrl = "http://127.0.0.1:16174";
const composeProject = `ato-capacity-${randomUUID().slice(0, 8)}`;
await mkdir(outDir, { recursive: true });

function docker(args, options = {}) {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function setSecrets() {
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD"]) {
    if (!process.env[name]) process.env[name] = randomBytes(24).toString("hex");
  }
  process.env.KEYCLOAK_ADMIN ??= "capacity-admin";
  if (!process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY || !process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  }
}

function composeUp() {
  return execFileSync("docker", ["compose", "-p", composeProject, "-f", compose, "up", "-d", "--build"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, timeout: 600_000
  });
}

function composeDown() {
  try {
    return execFileSync("docker", ["compose", "-p", composeProject, "-f", compose, "down", "-v", "--remove-orphans"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, timeout: 120_000
    });
  } catch (error) {
    return String(error.message).slice(0, 300);
  }
}

async function waitFor(url, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

async function obtainToken() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${oidcBase}/realms/ai-test-officer/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "ai-test-officer-local",
          username: "acceptance-runner",
          password: "acceptance-runner-change-me"
        })
      });
      if (response.ok) {
        const body = await response.json();
        if (body.access_token) return body.access_token;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
}

async function getSlo(headers) {
  const response = await fetch(`${apiBase}/api/operations/slo`, { headers });
  const body = await response.json();
  return body.slo ?? body;
}

async function createRun(headers, index) {
  const started = performance.now();
  try {
    const response = await fetch(`${apiBase}/v1/runs`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        organizationId: "benchmark",
        actor: "capacity-runner",
        idempotencyKey: `capacity-${index}-${randomUUID()}`,
        input: {
          appUrl: "http://customer-portal-lite:7103",
          requirement: "验证客户门户表格的排序、筛选和分页功能",
          diff: "客户门户列表筛选与分页逻辑变更",
          scenarioId: "capacity_table_sort_filter_pagination",
          plannerMode: "deterministic",
          judgeMode: "deterministic",
          executionMode: "oci",
          capabilities: ["browser"],
          permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false }
        }
      })
    });
    const body = await response.json();
    return { ok: response.ok, status: response.status, elapsed: Math.round(performance.now() - started), runId: body.run?.id ?? body.id ?? null, error: body.error };
  } catch (error) {
    return { ok: false, status: 0, elapsed: Math.round(performance.now() - started), runId: null, error: String(error.message).slice(0, 160) };
  }
}

async function measureSse(headers, runIds) {
  const selected = runIds.slice(0, 20);
  const results = await Promise.all(selected.map(async (runId) => {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${apiBase}/v1/runs/${runId}/stream`, { headers, signal: controller.signal });
      const contentType = response.headers.get("content-type") ?? "";
      const reader = response.body?.getReader();
      const first = reader ? await reader.read() : { done: true, value: undefined };
      await reader?.cancel().catch(() => undefined);
      return { ok: response.ok && contentType.includes("text/event-stream") && Boolean(first.value), status: response.status, elapsed: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, status: 0, elapsed: Math.round(performance.now() - started), error: String(error.message).slice(0, 120) };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }));
  const latencies = results.map((item) => item.elapsed).sort((a, b) => a - b);
  return {
    requested: selected.length,
    opened: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    errorRate: results.length ? results.filter((item) => !item.ok).length / results.length : 0,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies.at(-1) ?? 0 },
    results
  };
}

const generatedAt = new Date().toISOString();
let stackHealthy = false;
let token = null;
let worker = { requested: 0, success: 0, failed: 0, errorRate: 1, latencyMs: {}, throughputPerSec: 0, sloBefore: null, sloAfter: null };
let sse = { requested: 0, opened: 0, failed: 0, errorRate: 1, latencyMs: {} };
let browser = null;
let gaps = [];

setSecrets();
try {
  console.log(`starting production capacity stack ${composeProject}…`);
  composeUp();
  stackHealthy = await waitFor(`${apiBase}/api/health`);
  if (!stackHealthy) throw new Error("production_stack_health_timeout");
  token = await obtainToken();
  if (!token) throw new Error("oidc_token_timeout");
  const headers = { Authorization: `Bearer ${token}` };

  const total = 50;
  const concurrency = 10;
  const queue = Array.from({ length: total }, (_, index) => index);
  const created = [];
  const wallStarted = performance.now();
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const index = queue.shift();
      if (index === undefined) break;
      created.push(await createRun(headers, index));
    }
  });
  const sloBefore = await getSlo(headers);
  await Promise.all(workers);
  const wallMs = performance.now() - wallStarted;
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const sloAfter = await getSlo(headers);
  const latencies = created.map((item) => item.elapsed).sort((a, b) => a - b);
  const successful = created.filter((item) => item.ok);
  worker = {
    requested: total,
    success: successful.length,
    failed: total - successful.length,
    errorRate: total ? (total - successful.length) / total : 0,
    throughputPerSec: total / (wallMs / 1000),
    wallMs: Math.round(wallMs),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99), max: latencies.at(-1) ?? 0 },
    sloBefore: { databaseConfigured: sloBefore.databaseConfigured, metrics: sloBefore.metrics, alerts: sloBefore.alerts?.length ?? 0 },
    sloAfter: { databaseConfigured: sloAfter.databaseConfigured, metrics: sloAfter.metrics, alerts: sloAfter.alerts?.length ?? 0 }
  };
  sse = await measureSse(headers, successful.map((item) => item.runId).filter(Boolean));

  execFileSync(process.execPath, [path.join(root, "scripts", "browser-concurrency-test.mjs"), "--url", workbenchUrl, "--concurrency", "10", "--rounds", "5"], {
    cwd: root, stdio: "inherit", env: process.env, timeout: 300_000
  });
  browser = JSON.parse(await readFile(path.join(root, "reports", "browser-concurrency", "latest.json"), "utf8"));
} catch (error) {
  gaps.push(String(error.message).slice(0, 240));
} finally {
  composeDown();
}

if (!stackHealthy) gaps.push("production_stack_not_healthy");
if (worker.success < worker.requested || worker.sloAfter?.databaseConfigured !== true) gaps.push("postgres_backed_worker_capacity_incomplete");
if (sse.opened < sse.requested) gaps.push("sse_capacity_incomplete");
if (!browser || browser.results?.failed > 0 || browser.targetPage !== "real-project-url") gaps.push("real_workbench_browser_capacity_incomplete");

const report = {
  schemaVersion: "1.0",
  generatedAt,
  objective: "#2/#5 production capacity evidence — Postgres-backed Worker, SSE, and real Workbench browser contexts",
  composeProject,
  stackHealthy,
  worker,
  sse,
  browser: browser ? {
    targetPage: browser.targetPage,
    testConfig: browser.testConfig,
    results: browser.results
  } : null,
  gaps,
  limitations: [
    "Worker measures concurrent POST /v1/runs acceptance against the Postgres-backed production API; queue completion is exercised by the production acceptance suite separately.",
    "SSE measures concurrent authenticated stream open + first event + client disconnect; durable reconnect/replay is exercised by the production acceptance suite separately.",
    "Browser measures headless Chromium contexts against the real production Workbench URL; RSS is the shared Playwright process, not per-context memory.",
    "The compose stack is disposable and torn down after this evidence run."
  ]
};
await writeFile(path.join(outDir, "latest.json"), JSON.stringify(report, null, 2));
console.log(`\nreport → reports/production-capacity/latest.json`);
console.log(`worker: ${worker.success}/${worker.requested} p95=${worker.latencyMs.p95 ?? 0}ms db=${worker.sloAfter?.databaseConfigured ?? false}`);
console.log(`sse: ${sse.opened}/${sse.requested} p95=${sse.latencyMs.p95 ?? 0}ms`);
console.log(`browser: ${browser?.results?.success ?? 0}/${browser?.results?.totalContexts ?? 0}`);
if (gaps.length) console.log(`gaps: ${gaps.join("; ")}`);
if (gaps.length) process.exitCode = 1;
