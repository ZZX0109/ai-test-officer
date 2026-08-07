// Static gate for P0 credibility (commit "centralize proof bundle verification").
//
// Business/execution code MUST NOT directly assign proof credibility flags.
// Only `agent/src/proof/` (the Proof Bundle Service) may mint these, via
// `finalizeProofBundle()` and the `proofCredibility*` / `buildAggregateMachineGate`
// helpers it exports. Any assignment to one of the credibility booleans
// outside that module is a credibility lie and fails CI.
//
// This script forbids ALL assignments — literal `true`/`false`, variables,
// computed expressions, and compound operators (`||=`/`&&=`/`??=`) — not just
// the `= true` case the original version checked. A small allow-list permits
// (a) offline analysis/verification tooling that only propagates already
// verified values into its own record schemas, and (b) propagation of a value
// that is read directly from a verified source (e.g. `verdict.x`).
//
// Usage: node scripts/check-evidence-complete-assignment.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "src");

// The credibility flags that only the Proof Bundle Service may assert.
const FLAGGED = [
  "evidenceComplete",
  "artifactIntegrityVerified",
  "evidenceGrounded",
  "gateEligible",
  "proofBundleId",
  "proofValidationVersion"
];
const FLAG_ALT = FLAGGED.join("|");

// Offline analysis / verification tooling. These modules never mint a
// `MachineGate` for the live proof chain; they build their own
// benchmark/report/experiment *metric* objects that happen to share field
// names (e.g. `gateEligible`, `artifactIntegrityVerified`) with the MachineGate
// credibility contract. Those are benchmark-domain facts (e.g. "this run is
// excluded from the benchmark"), not assertions fed into the run's proof
// verdict. They are explicitly out of scope for the runtime proof-minting path.
//
// `executionPersistence.ts` is the DB *sink*: it copies already-minted gate
// fields into identically-named table columns (e.g. `evidence_complete`). It
// never computes or asserts credibility, so it is a legitimate write target
// and is whitelisted. The minting still happens only in agent/src/proof/.
const WHITELIST_FILES = new Set([
  "benchmark.ts",
  "benchmarkRunner.ts",
  "benchmarkSummary.ts",
  "demoVerifier.ts",
  "executionPersistence.ts"
]);

// A verified source whose member is safe to copy (propagation, not assertion).
// The `?.` variants cover optional chaining at call sites.
const VERIFIED_SOURCES = [
  "verdict.",
  "verdict?.",
  "machineGate.",
  "machineGate?.",
  "proofVerdict.",
  "proofVerdict?.",
  "proofMachineGate.",
  "aggregateGate.",
  "gate.",
  "result.machineGate.",
  "result.machineGate?.",
  "bundle.machineGate.",
  "child.outcomeSummary.",
  "child.outcomeSummary?.",
  "degraded.",
  "parentMachineGate."
];

// Destructuring rename, e.g. `const { gateEligible: x } = …` — a local binding,
// not a credibility flag field assignment.
const DESTRUCTURE = /\b(?:const|let|var)\s*\{[^}]*\}\s*=/;

// A type annotation RHS (so `evidenceComplete: boolean` is not flagged).
const TYPE_START = /^(boolean|string|number|null|undefined|unknown|any|void|never|symbol|bigint|object|Record|Partial|Pick|Readonly|Array|Map|Set|Promise|\w+<)/;

// Matches an assignment to a flagged name: object property `flag:` or an
// operator `flag =` / `flag ||=` / `flag &&=` / `flag ??=`. Member reads
// (`x.flag`) and comparisons (`flag ===`) are excluded by the lookbehind /
// trailing `(?!=)`. A leading `const|let|var` marks a variable declaration,
// which is also excluded.
const ASSIGN = new RegExp(
  `(?:(?:const|let|var)\\s+)?` +
    `(?<![.\\w])` +
    `(?:${FLAG_ALT})` +
    `\\s*(?::|(?:\\|\\|&&|\\?\\?)?=)(?!=)`,
  "g"
);
const DECL = new RegExp(`(?:const|let|var)\\s+(?:${FLAG_ALT})\\s*[:=]`);
const RHS = new RegExp(`(?:${FLAG_ALT})\\s*:\\s*(\\S+)`);

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
  if (WHITELIST_FILES.has(basename(file))) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    ASSIGN.lastIndex = 0;
    if (!ASSIGN.test(line)) return;
    ASSIGN.lastIndex = 0;
    // Destructuring rename (`const { x: y } = …`) — a local binding.
    if (DESTRUCTURE.test(line)) return;
    // Variable declaration (`const x =`) — a local binding, not a flag field.
    if (DECL.test(line)) return;
    // Type annotation? (`evidenceComplete: boolean`)
    const rhs = line.match(RHS);
    if (rhs && TYPE_START.test(rhs[1])) return;
    // Propagation from a verified source? (`verdict.x`, `child.outcomeSummary.x`)
    if (VERIFIED_SOURCES.some((token) => line.includes(token))) return;
    violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error("FAIL: business code directly assigns proof credibility flags:");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nOnly agent/src/proof/ may set these. Route through finalizeProofBundle() " +
      "and the proofCredibility / proofCredibilityFromGate / buildAggregateMachineGate helpers."
  );
  process.exit(1);
}

console.log("OK: no direct proof credibility flag assignments outside agent/src/proof/");
