#!/usr/bin/env node
// For each run in an evidence file's metrics lane-arrays, fetch the run's input
// from the agent and record the modelProfileId, so the sealing step can seal
// the model per-run (not just the top-level models array).
// Usage: node scripts/backfill-blind-test-models.mjs <projectId>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, "reports", "external-acceptance");
const AGENT = process.env.AGENT_URL || "http://127.0.0.1:4317";
const TOKEN = process.env.AGENT_TOKEN || "dev-local-token";

async function fetchRun(runId) {
  const r = await fetch(`${AGENT}/v1/runs/${runId}`, { headers: { "x-agent-token": TOKEN } });
  if (!r.ok) return null;
  const body = await r.json();
  return body?.run ?? body;
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) { console.error("usage: backfill-blind-test-models.mjs <projectId>"); process.exit(1); }
  const file = path.join(DIR, `${projectId}.json`);
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  let filled = 0, total = 0, missing = 0;
  for (const [lane, runs] of Object.entries(evidence.metrics || {})) {
    if (!Array.isArray(runs)) continue; // skip nativeTests (dict) etc.
    for (const r of runs) {
      total++;
      if (r.model) { filled++; continue; }
      const run = await fetchRun(r.runId);
      const model = run?.input?.modelProfileId || null;
      if (model) { r.model = model; filled++; }
      else missing++;
    }
  }
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`backfilled ${filled}/${total} runs with model (${missing} missing)`);
}

main().catch((e) => { console.error(e?.message || String(e)); process.exit(1); });
