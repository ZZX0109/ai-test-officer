// Worker load + SLO metrics test (#2 真实容量测试 + #5 生产 SLO).
// Generates concurrent run creation against the agent API, measures
// P50/P95/P99 latency + throughput + error rate, and captures the
// /api/operations/slo endpoint metrics before/after load.
//
// Usage: node scripts/worker-load-slo-test.mjs [--project fastapi-full-stack-template] [--concurrency 10] [--total 50]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.AGENT_TOKEN ?? "dev-local-token";
const BASE = process.env.AGENT_BASE ?? "http://127.0.0.1:4317";
const OUT = path.join(process.cwd(), "reports", "worker-load-slo");
await mkdir(OUT, { recursive: true });

function parseArgs() {
  const a = { project: "fastapi-full-stack-template", concurrency: 10, total: 50 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") a.project = argv[++i];
    if (argv[i] === "--concurrency") a.concurrency = parseInt(argv[++i], 10);
    if (argv[i] === "--total") a.total = parseInt(argv[++i], 10);
  }
  return a;
}

async function fetchSlo() {
  try {
    const res = await fetch(`${BASE}/api/operations/slo`, { headers: { "x-agent-token": TOKEN } });
    const d = await res.json();
    return d.slo ?? d;
  } catch (e) { return { error: String(e.message).slice(0, 120) }; }
}

async function createRun(projectId, lane, model, idx) {
  const start = performance.now();
  const experimentId = `load-test-${projectId}`;
  const idempotencyKey = `${experimentId}-${idx}-${crypto.randomUUID()}`;
  try {
    const res = await fetch(`${BASE}/v1/runs`, {
      method: "POST",
      headers: { "x-agent-token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        organizationId: "org_load_test",
        idempotencyKey,
        input: {
          plannerMode: lane.planner,
          judgeMode: lane.judge,
          ...(model ? { modelProfileId: model } : {}),
          experimentId,
          repetition: (idx % 10) + 1,
          cachePolicy: "bypass",
          executionProfile: "benchmark",
          promptVersion: "plan-v1"
        }
      })
    });
    const json = await res.json();
    const elapsed = performance.now() - start;
    return { ok: res.ok, status: res.status, elapsed, runId: json.run?.id ?? json.id ?? null, error: json.error };
  } catch (e) {
    return { ok: false, status: 0, elapsed: performance.now() - start, runId: null, error: String(e.message).slice(0, 120) };
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

const args = parseArgs();
const lane = { planner: "deterministic", judge: "deterministic" };
const model = null; // deterministic lane doesn't need a model

console.log(`worker load test: project=${args.project} concurrency=${args.concurrency} total=${args.total}`);

// Ensure sandbox ready
const readyRes = await fetch(`${BASE}/api/projects/${args.project}/start-async`, {
  method: "POST", headers: { "x-agent-token": TOKEN, "Content-Type": "application/json" }, body: "{}"
});
console.log(`sandbox: ${readyRes.status} ${(await readyRes.json()).runtime?.status ?? "n/a"}`);

const sloBefore = await fetchSlo();
console.log(`slo before: stalledRuns=${sloBefore.metrics?.stalledRuns} pendingOutbox=${sloBefore.metrics?.pendingOutbox} dbConfigured=${sloBefore.databaseConfigured}`);

// Generate concurrent runs
const results = [];
let sent = 0;
let active = 0;
const queue = [];
for (let i = 0; i < args.total; i++) queue.push(i);

const wallStart = performance.now();
const workers = Array.from({ length: args.concurrency }, async () => {
  while (queue.length > 0) {
    const idx = queue.shift();
    if (idx === undefined) break;
    active++;
    const r = await createRun(args.project, lane, model, idx);
    results.push(r);
    active--;
    if ((sent++ % 10) === 0) console.log(`  sent=${sent} ok=${results.filter(x=>x.ok).length} err=${results.filter(x=>!x.ok).length}`);
  }
});
await Promise.all(workers);
const wallMs = performance.now() - wallStart;

const sloAfter = await fetchSlo();

const latencies = results.map(r => r.elapsed).sort((a, b) => a - b);
const okResults = results.filter(r => r.ok);
const errResults = results.filter(r => !r.ok);

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "#2 真实容量测试 (Worker load) + #5 生产 SLO 实测",
  testConfig: { project: args.project, concurrency: args.concurrency, total: args.total, lane: "rules-plan-rules-judge (deterministic)" },
  results: {
    total: results.length,
    success: okResults.length,
    failed: errResults.length,
    errorRate: results.length ? (errResults.length / results.length) : 0,
    throughputPerSec: results.length / (wallMs / 1000),
    wallMs: Math.round(wallMs),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Math.round(latencies[latencies.length - 1]) : 0,
      min: latencies.length ? Math.round(latencies[0]) : 0
    },
    errorBreakdown: errResults.reduce((acc, r) => {
      const key = r.error ?? `status_${r.status}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})
  },
  sloBefore,
  sloAfter,
  gaps: []
};

// Identify gaps
if (sloAfter.databaseConfigured === false) report.gaps.push("slo_database_not_configured (dev agent uses SQLite, not Postgres — production SLO needs Postgres)");
if (okResults.length === 0) report.gaps.push("no_successful_runs — sandbox may not be ready or run creation failed");
if (report.results.errorRate > 0.1) report.gaps.push(`high_error_rate (${(report.results.errorRate * 100).toFixed(1)}%)`);

report.limitations = [
  "Load test measures run CREATION latency (POST /v1/runs), not full execution completion (runs settle asynchronously).",
  "Dev agent uses SQLite (databaseConfigured=false); production SLO numbers require the Postgres-backed production compose.",
  "SLO metrics from /api/operations/slo are point-in-time snapshots before/after the load burst.",
  "Browser concurrency, SSE, and BrowserContext metrics are not measured by this script (those require the Workbench UI + Playwright runtime)."
];

await writeFile(path.join(OUT, "latest.json"), JSON.stringify(report, null, 2));
console.log(`\nreport → reports/worker-load-slo/latest.json`);
console.log(`results: success=${okResults.length}/${results.length} errRate=${(report.results.errorRate * 100).toFixed(1)}% throughput=${report.results.throughputPerSec.toFixed(1)}/s`);
console.log(`latency: p50=${report.results.latencyMs.p50}ms p95=${report.results.latencyMs.p95}ms p99=${report.results.latencyMs.p99}ms max=${report.results.latencyMs.max}ms`);
console.log(`slo after: stalledRuns=${sloAfter.metrics?.stalledRuns} pendingOutbox=${sloAfter.metrics?.pendingOutbox}`);
if (report.gaps.length) console.log(`gaps: ${report.gaps.join("; ")}`);
