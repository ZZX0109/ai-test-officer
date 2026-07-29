import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(rootDir, "scripts", "reports-retention.mjs");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "ato-retention-"));
const reportsDir = path.join(fixtureRoot, "reports");
const archiveDir = path.join(fixtureRoot, "archive");
const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);

async function createRun({ runId, projectId, finalStatus, old = false, pinned = false }) {
  const runDir = path.join(reportsDir, "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run_bundle.json"), JSON.stringify({
    runId,
    input: { projectId },
    result: { finalStatus },
    pinned
  }));
  await writeFile(path.join(runDir, "browser.log"), `${runId}\n`);
  if (pinned) await writeFile(path.join(runDir, ".pinned"), "");
  if (old) {
    await utimes(path.join(runDir, "run_bundle.json"), oldDate, oldDate);
    await utimes(path.join(runDir, "browser.log"), oldDate, oldDate);
    await utimes(runDir, oldDate, oldDate);
  }
  return runDir;
}

function execute(args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: rootDir,
    env: {
      ...process.env,
      REPORTS_DIR: reportsDir,
      REPORT_ARCHIVE_DIR: archiveDir
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const retainedSuccess = await createRun({
    runId: "success-recent",
    projectId: "project-a",
    finalStatus: "pass"
  });
  const expiredFailure = await createRun({
    runId: "failure-expired",
    projectId: "project-a",
    finalStatus: "fail",
    old: true
  });
  const pinnedFailure = await createRun({
    runId: "failure-pinned",
    projectId: "project-a",
    finalStatus: "blocked",
    old: true,
    pinned: true
  });
  const expiredSuccess = await createRun({
    runId: "success-expired",
    projectId: "project-b",
    finalStatus: "pass",
    old: true
  });

  const dryRun = execute(["--keep-success-runs=0"]);
  assert.equal(dryRun.dryRun, true);
  assert.deepEqual(
    new Set(dryRun.actions.filter((action) => action.category === "run").map((action) => action.runId)),
    new Set(["failure-expired", "success-expired"])
  );
  await stat(expiredFailure);
  await stat(expiredSuccess);
  await assert.rejects(stat(path.join(retainedSuccess, "report-manifest.json")));

  const applied = execute(["--apply", "--archive", "--keep-success-runs=0"]);
  assert.equal(applied.dryRun, false);
  await assert.rejects(stat(expiredFailure));
  await assert.rejects(stat(expiredSuccess));
  await stat(retainedSuccess);
  await stat(pinnedFailure);

  const manifest = JSON.parse(await readFile(path.join(retainedSuccess, "report-manifest.json"), "utf8"));
  assert.equal(manifest.projectId, "project-a");
  assert.equal(manifest.status, "success");
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));

  const repeated = execute(["--apply", "--archive", "--keep-success-runs=0"]);
  assert.equal(repeated.actionCount, 0);
  console.log("reports retention tests passed");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
