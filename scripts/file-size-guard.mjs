// File-size guard: prevent new god files.
//
// The repo carries a known set of oversized files (the "documented god files")
// that predate this guard and are decomposed incrementally. The guard fails
// the build for any NEW source file exceeding the line budget that is not on
// the explicit allowlist. Allowlist entries must each carry a decomposition
// TODO and are removed as Phase 2 of the stabilization plan lands.
//
// Run via `npm run size-guard`. Excludes generated code and build output.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const THRESHOLD = Number(process.env.SIZE_GUARD_THRESHOLD ?? 2000);

// Files exceeding THRESHOLD that pre-date the guard. Each must be removed from
// this list when its decomposition lands; do not add new entries here.
const ALLOWLIST = new Map([
  ["agent/src/server.ts", "Phase 2: extract remaining routers into server/routes/"],
  ["agent/src/agentGraphService.ts", "Phase 2: split into graph-hooks / projection / recovery-adapter"],
  ["agent/src/testRunner.ts", "Phase 2: split into lifecycle-policy / executable-plan-binding / attempt-runner"],
  ["workbench-ui/src/App.tsx", "Phase 2: sink panel state into Panel components and state/ reducers"]
]);

const SCAN_ROOTS = ["agent/src", "packages", "workbench-ui/src", "app-under-test/src"];
const EXCLUDE_DIR_SEGMENTS = new Set(["dist", "generated", "node_modules", ".workbuddy"]);

async function* walk(relativeRoot) {
  const absolute = path.join(ROOT, relativeRoot);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIR_SEGMENTS.has(entry.name)) continue;
      yield* walk(relative);
    } else if (/\.[cm]?tsx?$/.test(entry.name)) {
      yield relative;
    }
  }
}

async function lineCount(relativeFile) {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(path.join(ROOT, relativeFile), "utf8");
  // Count lines the way wc does: trailing newline does not add an empty line.
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

async function main() {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walk(root)) {
      const count = await lineCount(file);
      if (count <= THRESHOLD) continue;
      if (ALLOWLIST.has(file)) continue;
      violations.push({ file, count });
    }
  }

  const allowlistStale = [];
  for (const file of ALLOWLIST.keys()) {
    let count = 0;
    try {
      count = await lineCount(file);
    } catch {
      allowlistStale.push({ file, reason: "missing" });
      continue;
    }
    if (count <= THRESHOLD) allowlistStale.push({ file, count, reason: "now_under_threshold" });
  }

  if (violations.length > 0) {
    console.error(`size-guard: ${violations.length} file(s) exceed ${THRESHOLD} lines and are not allowlisted:`);
    for (const { file, count } of violations.sort((a, b) => b.count - a.count)) {
      console.error(`  ${file}: ${count} lines (split the file or raise the budget via SIZE_GUARD_THRESHOLD only with review)`);
    }
    console.error("");
    console.error("The allowlist is reserved for pre-existing god files under active decomposition.");
    console.error("Do not add new oversized files; decompose them instead.");
  }

  if (allowlistStale.length > 0) {
    console.error(`size-guard: ${allowlistStale.length} allowlisted file(s) no longer need the exemption; remove them:`);
    for (const { file, count, reason } of allowlistStale) {
      console.error(`  ${file}: ${reason}${count !== undefined ? ` (${count} lines)` : ""}`);
    }
  }

  if (violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
