// File-size guard: prevent new god files.
//
// The repo carries a known set of oversized files (the "documented god files")
// that predate this guard and are decomposed incrementally. The guard fails
// the build for any NEW source file exceeding the line budget that is not on
// the explicit allowlist. Allowlist entries must each carry a decomposition
// TODO and are removed as Phase 2 of the stabilization plan lands.
//
// Run via `npm run size-guard`. Excludes generated code and build output.

import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const THRESHOLD = Number(process.env.SIZE_GUARD_THRESHOLD ?? 2000);
const NEW_FILE_THRESHOLD = Number(process.env.SIZE_GUARD_NEW_FILE_THRESHOLD ?? 800);
const execFileAsync = promisify(execFile);
const BASELINE_CONFIG = JSON.parse(await readFile(path.join(ROOT, "scripts", "god-file-baselines.json"), "utf8"));

// The four P0-2 gates are explicit, checked-in baselines rather than prose in
// a document. A file can remain above the generic threshold during migration,
// but it cannot grow back above half of its recorded pre-refactor size.
const REDUCTION_GATES = new Map(Object.entries(BASELINE_CONFIG.files));
const ALLOWLIST = new Map([...REDUCTION_GATES.entries()].filter(([file]) => file === "workbench-ui/src/App.tsx"));

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
  const content = await readFile(path.join(ROOT, relativeFile), "utf8");
  // Count lines the way wc does: trailing newline does not add an empty line.
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function sourcePath(relativeFile) {
  return /\.[cm]?tsx?$/.test(relativeFile)
    && !relativeFile.split(path.sep).some((segment) => EXCLUDE_DIR_SEGMENTS.has(segment));
}

async function addedSourceFiles() {
  const tracked = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=A", "HEAD"], { cwd: ROOT });
  const untracked = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ROOT });
  return new Set(`${tracked.stdout}\n${untracked.stdout}`.split(/\r?\n/).map((file) => file.trim()).filter(sourcePath));
}

async function main() {
  const violations = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of walk(root)) {
      const count = await lineCount(file);
      if (count <= THRESHOLD) continue;
      const allowed = ALLOWLIST.get(file);
      if (allowed) {
        if (count > allowed.maxLines) violations.push({ file, count, baselineExceeded: allowed.maxLines });
        continue;
      }
      violations.push({ file, count });
    }
  }

  // New business files must stay below the decomposition budget. This checks
  // both staged/unstaged additions and intentionally untracked files, so a
  // large file cannot evade the guard before it is added to Git.
  const addedFiles = await addedSourceFiles();
  for (const file of addedFiles) {
    const count = await lineCount(file);
    if (count > NEW_FILE_THRESHOLD) violations.push({ file, count, newFileExceeded: NEW_FILE_THRESHOLD });
  }

  // Recompute the P0-2 reduction gates independently of the generic threshold
  // scan. This keeps the acceptance criterion active even after a file drops
  // below 2,000 lines and would otherwise stop being inspected.
  for (const [file, gate] of REDUCTION_GATES) {
    const count = await lineCount(file);
    if (count > gate.maxLines && !violations.some((item) => item.file === file)) {
      violations.push({ file, count, baselineExceeded: gate.maxLines });
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
    for (const { file, count, baselineExceeded, newFileExceeded } of violations.sort((a, b) => b.count - a.count)) {
      console.error(`  ${file}: ${count} lines${baselineExceeded ? ` (50% gate ${baselineExceeded} exceeded)` : ""}${newFileExceeded ? ` (new-file budget ${newFileExceeded} exceeded)` : ""} (split the file or update the reviewed baseline)`);
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
