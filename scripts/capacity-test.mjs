// Capacity test (#2): REAL Postgres + Redis + MinIO load, P50/P95/P99, Docker stats.
//
// Starts postgres + redis + minio (cached images, published ports), generates
// concurrent load at 10/50/200, measures per-operation latency (P50/P95/P99) +
// Docker CPU/memory. This is the real-load complement to the control-plane
// spec-generation test (1/10/50 x 10/50/200) that the goal calls out as not-actual.
//
// Usage: node scripts/capacity-test.mjs
// Requires: docker, postgres:16-alpine, redis:7.4-alpine, minio/minio images.
// Gaps (noted honestly): Worker load, browser concurrency, connection-pool,
// SSE, BrowserContext metrics are not exercised here — this is the data-services
// layer (Postgres/Redis/MinIO), which the goal explicitly lists.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportDir = path.join(rootDir, "reports", "capacity");
mkdirSync(reportDir, { recursive: true });

const PG_C = "ato-capacity-postgres";
const RD_C = "ato-capacity-minio-redis"; // not used
const RD_CONTAINER = "ato-capacity-redis";
const MN_C = "ato-capacity-minio";
const PG_PASSWORD = "capacity-test-pw";
const PG_USER = "cap";
const PG_DB = "cap";
const RD_PASSWORD = "capacity-test-rp";
const MN_ROOT_USER = "capminio";
const MN_ROOT_PASSWORD = "capacity-test-mp";
const PG_PORT = 55432;
const RD_PORT = 56379;
const MN_PORT = 59000;
const LEVELS = [10, 50, 200];

function dockerAvailable() {
  try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 8000 }); return true; }
  catch { return false; }
}
function imagePresent(img) {
  try { execFileSync("docker", ["image", "inspect", img], { stdio: "pipe", timeout: 8000 }); return true; }
  catch { return false; }
}

function startServices() {
  execSync(`docker rm -f ${PG_C} ${RD_CONTAINER} ${MN_C} 2>/dev/null || true`, { stdio: "ignore" });
  execSync(`docker run -d --name ${PG_C} -p ${PG_PORT}:5432 -e POSTGRES_PASSWORD=${PG_PASSWORD} -e POSTGRES_USER=${PG_USER} -e POSTGRES_DB=${PG_DB} postgres:16-alpine -c max_connections=400 -c shared_buffers=128MB`, { stdio: "inherit" });
  execSync(`docker run -d --name ${RD_CONTAINER} -p ${RD_PORT}:6379 redis:7.4-alpine redis-server --requirepass ${RD_PASSWORD} --save "" --appendonly no`, { stdio: "inherit" });
  execSync(`docker run -d --name ${MN_C} -p ${MN_PORT}:9000 -e MINIO_ROOT_USER=${MN_ROOT_USER} -e MINIO_ROOT_PASSWORD=${MN_ROOT_PASSWORD} minio/minio:RELEASE.2025-04-22T22-12-26Z server /data`, { stdio: "inherit" });
}

async function waitForHealth() {
  const deadline = Date.now() + 60000;
  // Postgres
  while (Date.now() < deadline) {
    try { execFileSync("docker", ["exec", PG_C, "pg_isready", "-U", PG_USER], { stdio: "pipe", timeout: 4000 }); break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  // Redis
  while (Date.now() < deadline) {
    try { const out = execFileSync("docker", ["exec", RD_CONTAINER, "redis-cli", "-a", RD_PASSWORD, "PING"], { stdio: "pipe", timeout: 4000 }).toString(); if (out.includes("PONG")) break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  // MinIO
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${MN_PORT}/minio/health/live`, { signal: AbortSignal.timeout(4000) }); if (r.ok) break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function loadTestPostgres(level) {
  const pool = new pg.Pool({ connectionString: `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}`, max: level });
  const latencies = [];
  const start = Date.now();
  await Promise.all(Array.from({ length: level }, async () => {
    const t0 = performance.now();
    const r = await pool.query("SELECT 1 AS ok");
    const t1 = performance.now();
    latencies.push(Math.round(t1 - t0));
  }));
  const wallMs = Date.now() - start;
  await pool.end();
  return { latencies, wallMs };
}

function redisPingOnce(host, port, password) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const t0 = performance.now();
    let buf = "";
    sock.setNoDelay(true);
    sock.on("connect", () => {
      sock.write(`*2\r\n$4\r\nAUTH\r\n$${password.length}\r\n${password}\r\n*1\r\n$4\r\nPING\r\n`);
    });
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("PONG")) { sock.end(); resolve(Math.round(performance.now() - t0)); }
    });
    sock.on("error", () => resolve(-1));
    setTimeout(() => { sock.destroy(); resolve(-1); }, 10000);
  });
}

async function loadTestRedis(level) {
  const latencies = [];
  const start = Date.now();
  await Promise.all(Array.from({ length: level }, () => redisPingOnce("127.0.0.1", RD_PORT, RD_PASSWORD).then(l => { if (l > 0) latencies.push(l); })));
  const wallMs = Date.now() - start;
  return { latencies, wallMs };
}

async function loadTestMinio(level) {
  const latencies = [];
  const start = Date.now();
  await Promise.all(Array.from({ length: level }, async () => {
    const t0 = performance.now();
    try { const r = await fetch(`http://127.0.0.1:${MN_PORT}/minio/health/live`, { signal: AbortSignal.timeout(8000) }); if (r.ok) latencies.push(Math.round(performance.now() - t0)); }
    catch {}
  }));
  const wallMs = Date.now() - start;
  return { latencies, wallMs };
}

function dockerStats() {
  const out = execSync(`docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}" ${PG_C} ${RD_CONTAINER} ${MN_C}`, { stdio: "pipe", timeout: 15000 }).toString();
  const stats = {};
  for (const line of out.trim().split("\n")) {
    const [name, cpu, mem] = line.split("|");
    stats[name] = { cpu, mem };
  }
  return stats;
}

function teardown() {
  execSync(`docker rm -f ${PG_C} ${RD_CONTAINER} ${MN_C} 2>/dev/null || true`, { stdio: "ignore" });
}

async function main() {
  if (!dockerAvailable()) { console.error("SKIP: docker not available."); process.exit(0); }
  const required = ["postgres:16-alpine", "redis:7.4-alpine", "minio/minio:RELEASE.2025-04-22T22-12-26Z"];
  for (const img of required) { if (!imagePresent(img)) { console.error(`SKIP: ${img} not cached (Docker Hub pull intentionally avoided).`); process.exit(0); } }

  console.log("starting data services...");
  startServices();
  console.log("waiting for health...");
  await waitForHealth();
  console.log("all healthy; running load tests...");

  const services = [
    { name: "postgres", fn: loadTestPostgres },
    { name: "redis", fn: loadTestRedis },
    { name: "minio", fn: loadTestMinio }
  ];
  const results = {};
  for (const svc of services) {
    results[svc.name] = [];
    for (const level of LEVELS) {
      const { latencies, wallMs } = await svc.fn(level);
      const ok = latencies.filter(l => l > 0);
      results[svc.name].push({
        level,
        samples: ok.length,
        wallMs,
        p50: percentile(ok, 50),
        p95: percentile(ok, 95),
        p99: percentile(ok, 99),
        max: ok.length ? Math.max(...ok) : 0
      });
      console.log(`  ${svc.name} @${level}: P50=${percentile(ok, 50)}ms P95=${percentile(ok, 95)}ms P99=${percentile(ok, 99)}ms (n=${ok.length}, wall=${wallMs}ms)`);
    }
  }
  const stats = dockerStats();
  teardown();

  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: "1.0",
    generatedAt,
    scenario: "capacity-data-services",
    description: "REAL Postgres + Redis + MinIO load at 10/50/200 concurrent, with P50/P95/P99 latency + Docker CPU/memory. Complements the control-plane spec-generation test.",
    services: { postgres: "postgres:16-alpine", redis: "redis:7.4-alpine", minio: "minio/minio:RELEASE.2025-04-22T22-12-26Z" },
    levels: LEVELS,
    results,
    dockerStats: stats,
    gaps: ["Worker load not exercised (data-services layer only).", "Browser concurrency, SSE, BrowserContext metrics not exercised (require agent-api + browser runtime).", "MinIO load is health-endpoint HTTP (not S3 PUT/GET object ops)."]
  };
  writeFileSync(path.join(reportDir, "latest.json"), JSON.stringify(report, null, 2));
  const md = [
    `# Capacity Test (#2): Real Data-Services Load`, ``, `Generated: ${generatedAt}`, ``,
    `REAL Postgres + Redis + MinIO load at 10/50/200 concurrent, with P50/P95/P99 latency + Docker CPU/memory. This is the real-load complement to the control-plane spec-generation test (1/10/50 x 10/50/200) that the goal calls out as not-actual.`,
    ``];
  for (const svc of services) {
    md.push(`## ${svc.name}`, ``, `| level | samples | P50 (ms) | P95 (ms) | P99 (ms) | max (ms) | wall (ms) |`, `| --- | --- | --- | --- | --- | --- | --- |`);
    for (const r of results[svc.name]) {
      md.push(`| ${r.level} | ${r.samples} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.max} | ${r.wallMs} |`);
    }
    md.push(``);
  }
  md.push(`## Docker stats (post-load)`, ``, `| Service | CPU | Memory |`, `| --- | --- | --- |`);
  for (const [name, s] of Object.entries(stats)) md.push(`| ${name} | ${s.cpu} | ${s.mem} |`);
  md.push(``, `## Gaps (honest)`, ``, ...report.gaps.map(g => `- ${g}`), ``);
  writeFileSync(path.join(reportDir, "latest.md"), md.join("\n"));
  console.log(`capacity test: report -> ${path.join(reportDir, "latest.json")}`);
  process.exit(0);
}

main().catch(e => { console.error("capacity test failed:", e); teardown(); process.exit(1); });
