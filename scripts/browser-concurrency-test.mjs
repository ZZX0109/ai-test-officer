// Browser concurrency test (#2 真实容量测试 — browser concurrency + BrowserContext).
// Launches N concurrent Playwright browser contexts, navigates each to a target
// page (local HTTP or real project URL), and measures P50/P95/P99 latency +
// memory + context lifecycle.
//
// Usage: node scripts/browser-concurrency-test.mjs [--concurrency 5] [--rounds 10] [--headless] [--url http://...]
import { writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const OUT = path.join(process.cwd(), "reports", "browser-concurrency");
await mkdir(OUT, { recursive: true });

function parseArgs() {
  const a = { concurrency: 5, rounds: 10, headless: true, url: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--concurrency") a.concurrency = parseInt(argv[++i], 10);
    if (argv[i] === "--rounds") a.rounds = parseInt(argv[++i], 10);
    if (argv[i] === "--headed") a.headless = false;
    if (argv[i] === "--url") a.url = argv[++i];
  }
  return a;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]);
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

const args = parseArgs();
console.log(`browser concurrency test: concurrency=${args.concurrency} rounds=${args.rounds} headless=${args.headless}`);

// Target URL: use --url for a real project page, or fall back to local page
let url = args.url;
let server = null;
if (!url) {
  // A tiny local page to navigate (no network dependency)
  const TARGET_HTML = `<!DOCTYPE html><html><head><title>ATO Browser Test</title></head><body><h1>OK</h1><p id="ts">${Date.now()}</p></body></html>`;

  // Start a trivial HTTP server to serve the page
  server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(TARGET_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  url = `http://127.0.0.1:${port}/`;
}
console.log(`target page: ${url}${args.url ? " (real project URL)" : " (local HTTP)"}`);

const rssBefore = rssMb();
console.log(`RSS before: ${rssBefore} MB`);

// Launch one shared browser, create N contexts concurrently per round
const browser = await chromium.launch({ headless: args.headless });
console.log(`browser launched`);

const roundResults = [];
const allLatencies = [];

for (let round = 0; round < args.rounds; round++) {
  const roundStart = performance.now();
  const latencies = [];
  let active = args.concurrency;
  const promises = Array.from({ length: args.concurrency }, async (i) => {
    const ctxStart = performance.now();
    let context, page;
    try {
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const title = await page.title();
      // The synthetic local page exposes #ts; a real Workbench/project page
      // does not. Keep the real-page path focused on navigation + DOM reachability.
      const ts = args.url ? null : await page.locator("#ts").textContent();
      const elapsed = performance.now() - ctxStart;
      latencies.push(elapsed);
      return { ok: true, elapsed, title, ts };
    } catch (e) {
      latencies.push(performance.now() - ctxStart);
      return { ok: false, error: String(e.message).slice(0, 100) };
    } finally {
      try { await context?.close(); } catch {}
    }
  });
  const results = await Promise.all(promises);
  const roundMs = performance.now() - roundStart;
  const ok = results.filter((r) => r.ok).length;
  latencies.sort((a, b) => a - b);
  allLatencies.push(...latencies);
  roundResults.push({
    round,
    success: ok,
    failed: args.concurrency - ok,
    roundMs: Math.round(roundMs),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99)
  });
  if ((round + 1) % 5 === 0) console.log(`  round ${round + 1}/${args.rounds}: ok=${ok}/${args.concurrency} p50=${percentile(latencies, 50)}ms`);
}

await browser.close();
if (server) server.close();
const rssAfter = rssMb();

allLatencies.sort((a, b) => a - b);
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "#2 真实容量测试 — browser concurrency + BrowserContext metrics",
  testConfig: { concurrency: args.concurrency, rounds: args.rounds, headless: args.headless, browser: "chromium" },
  results: {
    totalContexts: allLatencies.length,
    success: roundResults.reduce((s, r) => s + r.success, 0),
    failed: roundResults.reduce((s, r) => s + r.failed, 0),
    errorRate: roundResults.length ? (roundResults.reduce((s, r) => s + r.failed, 0) / (roundResults.length * args.concurrency)) : 0,
    latencyMs: {
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
      max: allLatencies.length ? Math.round(allLatencies[allLatencies.length - 1]) : 0,
      min: allLatencies.length ? Math.round(allLatencies[0]) : 0
    },
    rssMb: { before: rssBefore, after: rssAfter, delta: rssAfter - rssBefore },
    contextsPerSec: allLatencies.length / (roundResults.reduce((s, r) => s + r.roundMs, 0) / 1000)
  },
  rounds: roundResults,
  gaps: [],
  targetPage: args.url ? "real-project-url" : "local-http",
  limitations: [
    args.url
      ? `Test uses a real project URL (${args.url}) to exercise real DOM/CSS/JS rendering + network.`
      : "Test uses a local HTTP page (no network dependency) to isolate browser/context lifecycle cost from network latency. Use --url to test a real project page.",
    "One shared browser instance; each context is isolated (cookies, storage).",
    "RSS measured at the Node.js process level (includes Playwright driver), not per-context memory.",
    "Headless mode; headed mode may have different performance characteristics.",
    "BrowserContext isolation (cookies, storage, origin) is verified structurally; SSE stream concurrency is measured separately in worker-load-slo-test.mjs."
  ]
};

const totalFailed = report.results.failed;
if (totalFailed > 0) report.gaps.push(`browser_context_failures (${totalFailed})`);
if (report.results.latencyMs.p95 > 5000) report.gaps.push(`high_p95_latency (${report.results.latencyMs.p95}ms)`);

await writeFile(path.join(OUT, "latest.json"), JSON.stringify(report, null, 2));
console.log(`\nreport → reports/browser-concurrency/latest.json`);
console.log(`total: ${report.results.totalContexts} contexts | success: ${report.results.success} | failed: ${report.results.failed} | errRate: ${(report.results.errorRate * 100).toFixed(1)}%`);
console.log(`latency: p50=${report.results.latencyMs.p50}ms p95=${report.results.latencyMs.p95}ms p99=${report.results.latencyMs.p99}ms`);
console.log(`rss: ${rssBefore} → ${rssAfter} MB (delta ${rssAfter - rssBefore} MB) | contexts/s: ${report.results.contextsPerSec.toFixed(1)}`);
if (report.gaps.length) console.log(`gaps: ${report.gaps.join("; ")}`);
