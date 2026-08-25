// Production SLO measurement (#5 生产 SLO 实测).
// Starts the isolated production-acceptance compose stack (Postgres-backed),
// waits for health, generates real load against the production agent API, and
// captures the /api/operations/slo endpoint metrics (Postgres-backed, real SLO
// numbers). Produces a report with: SLO metrics, alerts, latency, throughput,
// and a gap analysis.
//
// Usage: node scripts/production-slo-measurement.mjs
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const OUT = path.join(root, "reports", "production-slo");
await mkdir(OUT, { recursive: true });
const composeProject = `ato-slo-${randomUUID().slice(0, 8)}`;
const apiBase = "http://127.0.0.1:14317";
const startedAt = new Date().toISOString();

function env(name, value) { process.env[name] = value; }

function ensureSecrets() {
  const generated = [];
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD"]) {
    if (!process.env[name]) { process.env[name] = randomBytes(24).toString("hex"); generated.push(name); }
  }
  if (!process.env.KEYCLOAK_ADMIN) {
    process.env.KEYCLOAK_ADMIN = "slo-admin";
    generated.push("KEYCLOAK_ADMIN");
  }
  // Ed25519 signing key pair
  if (!process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY || !process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
    generated.push("RUN_EVIDENCE_ED25519_PRIVATE_KEY", "RUN_EVIDENCE_ED25519_PUBLIC_KEY");
  }
  return generated;
}

function docker(args, opts = {}) {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function composeUp() {
  return execFileSync("docker", ["compose", "-p", composeProject, "-f", compose, "up", "-d", "--build"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, timeout: 600_000 });
}

function composeDown() {
  try { return execFileSync("docker", ["compose", "-p", composeProject, "-f", compose, "down", "-v", "--remove-orphans"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env }, timeout: 120_000 }); }
  catch (e) { return String(e.message).slice(0, 300); }
}

async function waitForHealth(timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${apiBase}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

async function waitForKeycloak(timeoutMs = 240_000) {
  // Keycloak imports the realm + starts accepting token requests asynchronously.
  // The agent-api health can pass before Keycloak is fully ready.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${oidcBase}/realms/ai-test-officer/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "ai-test-officer-local",
          username: "acceptance-runner",
          password: "acceptance-runner-change-me"
        })
      });
      if (res.ok) {
        const json = await res.json();
        if (json.access_token) return json.access_token;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 4_000));
  }
  return null;
}

const oidcBase = "http://127.0.0.1:18080";
let accessToken = null;

async function obtainAccessToken() {
  // Try direct first; if it fails, waitForKeycloak polls the token endpoint.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${oidcBase}/realms/ai-test-officer/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: "ai-test-officer-local",
          username: "acceptance-runner",
          password: "acceptance-runner-change-me"
        })
      });
      if (res.ok) {
        const json = await res.json();
        return json.access_token;
      }
    } catch (e) {
      if (attempt === 0) console.log(`  token attempt ${attempt + 1} failed: ${e.message}, waiting for Keycloak…`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  // Final fallback: poll the token endpoint until Keycloak is ready
  return await waitForKeycloak();
}

async function authHeaders() {
  if (!accessToken) accessToken = await obtainAccessToken();
  return { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` };
}

async function fetchSlo() {
  try {
    const res = await fetch(`${apiBase}/api/operations/slo`, { headers: await authHeaders() });
    const d = await res.json();
    if (!res.ok) return { error: `slo_${res.status}`, body: JSON.stringify(d).slice(0, 200) };
    return d.slo ?? d;
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

async function createRun(idx) {
  const start = performance.now();
  const idempotencyKey = `slo-${idx}-${crypto.randomUUID()}`;
  try {
    const res = await fetch(`${apiBase}/v1/runs`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        organizationId: "benchmark",
        actor: "acceptance-runner",
        idempotencyKey,
        input: {
          appUrl: "http://customer-portal-lite:7103",
          requirement: "验证客户门户表格的排序、筛选和分页功能",
          diff: "客户门户列表筛选与分页逻辑变更",
          scenarioId: "generic_table_sort_filter_pagination",
          plannerMode: "deterministic",
          judgeMode: "deterministic",
          executionMode: "oci",
          capabilities: ["browser"],
          permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false }
        }
      })
    });
    const json = await res.json();
    const elapsed = performance.now() - start;
    return { ok: res.ok, status: res.status, elapsed, runId: json.run?.id ?? json.id ?? null, error: json.error ?? `status_${res.status}`, rawError: JSON.stringify(json).slice(0, 150) };
  } catch (e) {
    return { ok: false, status: 0, elapsed: performance.now() - start, runId: null, error: String(e.message).slice(0, 120) };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

const generatedSecrets = ensureSecrets();
console.log(`generated secrets: ${generatedSecrets.length}`);

console.log("starting production compose stack (this builds + provisions)…");
try { const up = composeUp(); console.log(`compose up: ${up.split("\n").slice(-2).join(" | ").slice(0, 200)}`); }
catch (e) { console.log(`compose up error: ${String(e.message).slice(0, 300)}`); }

console.log("waiting for agent-api health…");
const healthy = await waitForHealth();
console.log(`health: ${healthy}`);

if (healthy) {
  console.log("obtaining OIDC access token (waiting for Keycloak realm import)…");
  try {
    accessToken = await obtainAccessToken();
    console.log(`token: ${accessToken ? accessToken.slice(0, 20) + "…" : "FAILED (null)"}`);
  } catch (e) { console.log(`token error: ${e.message}`); }
}

const sloBefore = await fetchSlo();
console.log(`slo before load: databaseConfigured=${sloBefore.databaseConfigured} stalledRuns=${sloBefore.metrics?.stalledRuns} alerts=${sloBefore.alerts?.length ?? 0}`);

// Generate load: 10 concurrency, 50 runs
const TOTAL = 50, CONCURRENCY = 10;
console.log(`generating load: concurrency=${CONCURRENCY} total=${TOTAL}…`);
const results = [];
const queue = Array.from({ length: TOTAL }, (_, i) => i);
const wallStart = performance.now();
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) {
    const idx = queue.shift();
    if (idx === undefined) break;
    const r = await createRun(idx);
    results.push(r);
  }
});
await Promise.all(workers);
const wallMs = performance.now() - wallStart;
const latencies = results.map(r => r.elapsed).sort((a, b) => a - b);
const okResults = results.filter(r => r.ok);

// Wait a moment for outbox to settle, then capture SLO after
await new Promise((r) => setTimeout(r, 5_000));
const sloAfter = await fetchSlo();
console.log(`slo after load: stalledRuns=${sloAfter.metrics?.stalledRuns} pendingOutbox=${sloAfter.metrics?.pendingOutbox} alerts=${sloAfter.alerts?.length ?? 0}`);

// Capture prometheus format
let prometheusText = "";
try {
  const pres = await fetch(`${apiBase}/api/operations/slo/prometheus`, { headers: await authHeaders() });
  prometheusText = await pres.text();
} catch (e) { prometheusText = `# capture failed: ${String(e.message).slice(0, 100)}`; }

console.log("bringing down production compose stack…");
const downResult = composeDown();

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "#5 生产 SLO 实测 — Postgres-backed production stack",
  composeProject,
  apiBase,
  startedAt,
  finishedAt: new Date().toISOString(),
  stackHealthy: healthy,
  generatedSecrets,
  sloBefore,
  sloAfter,
  loadTest: {
    config: { concurrency: CONCURRENCY, total: TOTAL, lane: "rules-plan-rules-judge (deterministic)" },
    results: {
      total: results.length,
      success: okResults.length,
      failed: results.length - okResults.length,
      errorRate: results.length ? ((results.length - okResults.length) / results.length) : 0,
      throughputPerSec: results.length / (wallMs / 1000),
      wallMs: Math.round(wallMs),
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.length ? Math.round(latencies[latencies.length - 1]) : 0
      }
    }
  },
  prometheusExcerpt: prometheusText.slice(0, 1500),
  stackTeardown: String(downResult).slice(0, 200),
  gaps: [],
  limitations: []
};

if (!healthy) report.gaps.push("stack_not_healthy");
if (sloAfter.databaseConfigured !== true) report.gaps.push("slo_database_not_configured_postgres");
if (okResults.length === 0) report.gaps.push("no_successful_runs");

report.limitations = [
  "SLO metrics captured against an isolated, disposable production-acceptance compose stack (Postgres 16 + Redis 7.4 + MinIO + Keycloak 26.1 + agent-api + worker).",
  "Load test measures run CREATION latency (POST /v1/runs) against the Postgres-backed agent; runs settle asynchronously via the worker.",
  "The compose stack is torn down after measurement; long-running SLO data (hours/days) requires a persistent production deployment.",
  "Dashboard visualization (Grafana) is not provisioned by this script; Prometheus text format is captured as the machine-readable SLO surface.",
  "Alert triggers are verified structurally (slo.alerts array) rather than via a live PagerDuty/Slack integration."
];

await writeFile(path.join(OUT, "latest.json"), JSON.stringify(report, null, 2));
console.log(`\nreport → reports/production-slo/latest.json`);
console.log(`stack healthy: ${healthy} | dbConfigured: ${sloAfter.databaseConfigured}`);
console.log(`load: success=${okResults.length}/${results.length} p50=${report.loadTest.results.latencyMs.p50}ms p95=${report.loadTest.results.latencyMs.p95}ms p99=${report.loadTest.results.latencyMs.p99}ms`);
console.log(`slo: stalledRuns=${sloAfter.metrics?.stalledRuns} pendingOutbox=${sloAfter.metrics?.pendingOutbox} alerts=${sloAfter.alerts?.length ?? 0}`);
if (report.gaps.length) console.log(`gaps: ${report.gaps.join("; ")}`);
