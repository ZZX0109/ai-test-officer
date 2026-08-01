// Static gate for P0 credibility (commit "fix: centralize proof bundle verification").
//
// Business/execution code MUST NOT directly hard-code proof credibility flags.
// Only `agent/src/proof/` (the Proof Bundle Service) may mint these, via
// `finalizeProofBundle()`. Any literal `: true` / `= true` assignment to one of
// the credibility booleans outside that module is a credibility lie and fails CI.
//
// Usage: node scripts/check-evidence-complete-assignment.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "src");
const FLAGGED = [
  "evidenceComplete",
  "artifactIntegrityVerified",
  "evidenceGrounded",
  "gateEligible"
];
const pattern = new RegExp(`(?:${FLAGGED.join("|")})\\s*[:=]\\s*true\\b`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (full.endsWith("/proof") || full.endsWith("\\proof")) continue; // sole allowed producer
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of walk(srcRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (pattern.test(line)) violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error("FAIL: business code directly hard-codes proof credibility flags:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("\nOnly agent/src/proof/ may set these. Route through finalizeProofBundle() instead.");
  process.exit(1);
}

console.log("OK: no hard-coded proof credibility flags outside agent/src/proof/");
