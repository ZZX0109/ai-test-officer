import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const retentionScript = path.join(rootDir, "scripts", "reports-retention.mjs");

async function writeArtifact(file: string, size = 16, ageMs = 0) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, "x"));
  if (ageMs) {
    const time = new Date(Date.now() - ageMs);
    await utimes(file, time, time);
  }
}

async function setAge(file: string, ageMs: number) {
  const time = new Date(Date.now() - ageMs);
  await utimes(file, time, time);
}

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runRetention(
  reportsDir: string,
  apply = false,
  archive = false,
  options: { archiveRoot?: string; storageHome?: string } = {}
) {
  const args = [
    ...(apply ? ["--apply"] : []),
    ...(archive ? ["--archive"] : [])
  ];
  const { stdout } = await execFileAsync(process.execPath, [retentionScript, ...args], {
    env: {
      ...process.env,
      REPORTS_DIR: reportsDir,
      ...(options.archiveRoot ? { REPORT_ARCHIVE_DIR: options.archiveRoot } : {}),
      ...(options.storageHome ? { AI_TEST_OFFICER_HOME: options.storageHome } : {}),
      REPORT_KEEP_SUCCESS_RUNS: "1",
      REPORT_SUCCESS_RETENTION_DAYS: "1",
      REPORT_FAILED_RETENTION_DAYS: "1"
    },
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout);
}

export async function testReportsRetention() {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-retention-"));
  const archiveReportsDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-retention-archive-reports-"));
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-retention-archive-root-"));
  const defaultArchiveReportsDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-retention-default-archive-reports-"));
  const storageHome = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-retention-home-"));
  const oldAge = 2 * 24 * 60 * 60 * 1000;
  try {
    await writeArtifact(path.join(reportsDir, "runs", "latest-run-id.txt"), 10);
    await writeFile(path.join(reportsDir, "runs", "latest-run-id.txt"), "run_latest");
    await writeArtifact(path.join(reportsDir, "runs", "run_latest", "bundle.json"), 64);
    await writeArtifact(path.join(reportsDir, "runs", "run_old", "bundle.json"), 64, oldAge);
    await setAge(path.join(reportsDir, "runs", "run_old"), oldAge);
    await writeArtifact(path.join(reportsDir, "screenshots", "run_old", "step.png"), 64, oldAge);
    await writeArtifact(path.join(reportsDir, "screenshots", "run_orphan", "step.png"), 64, oldAge);
    await setAge(path.join(reportsDir, "screenshots", "run_old"), oldAge);
    await setAge(path.join(reportsDir, "screenshots", "run_orphan"), oldAge);
    await writeArtifact(path.join(reportsDir, "traces", "run_orphan.zip"), 64, oldAge);
    await writeArtifact(path.join(reportsDir, "commit-checks", "old.json"), 64, oldAge);
    await writeArtifact(path.join(reportsDir, "commit-checks", "new.json"), 64);

    const dryRun = await runRetention(reportsDir);
    assert.equal(dryRun.dryRun, true);
    assert.ok(dryRun.actions.some((action: { file: string; reason: string }) => action.file.includes("run_old") && action.reason.includes("retention")));
    assert.ok(dryRun.actions.some((action: { file: string; reason: string }) => action.file.includes("run_orphan") && action.reason.includes("orphaned")));
    assert.ok(dryRun.actions.some((action: { file: string; reason: string }) => action.file.includes("old.json") && action.reason.includes("loose artifact")));
    assert.equal(await exists(path.join(reportsDir, "runs", "run_old")), true);

    const applied = await runRetention(reportsDir, true);
    assert.equal(applied.dryRun, false);
    assert.equal(await exists(path.join(reportsDir, "runs", "run_latest")), true);
    assert.equal(await exists(path.join(reportsDir, "runs", "run_old")), false);
    assert.equal(await exists(path.join(reportsDir, "screenshots", "run_orphan")), false);
    assert.equal(await exists(path.join(reportsDir, "traces", "run_orphan.zip")), false);
    assert.equal(await exists(path.join(reportsDir, "commit-checks", "old.json")), false);
    assert.equal((await stat(path.join(reportsDir, "retention-manifest.json"))).isFile(), true);

    await writeArtifact(path.join(archiveReportsDir, "runs", "latest-run-id.txt"), 10);
    await writeFile(path.join(archiveReportsDir, "runs", "latest-run-id.txt"), "run_latest");
    await writeArtifact(path.join(archiveReportsDir, "runs", "run_latest", "bundle.json"), 64);
    await writeArtifact(path.join(archiveReportsDir, "runs", "run_old", "bundle.json"), 64, oldAge);
    await setAge(path.join(archiveReportsDir, "runs", "run_old"), oldAge);
    await writeArtifact(path.join(archiveReportsDir, "screenshots", "run_old", "step.png"), 64, oldAge);

    const archived = await runRetention(archiveReportsDir, true, true, { archiveRoot });
    assert.equal(archived.archive, true);
    assert.equal(await exists(path.join(archiveReportsDir, "runs", "run_old")), false);
    assert.equal(await exists(path.join(archiveReportsDir, "screenshots", "run_old")), false);
    assert.equal(await exists(path.join(archived.archiveDir, "runs", "run_old", "bundle.json")), true);
    assert.equal(await exists(path.join(archived.archiveDir, "screenshots", "run_old", "step.png")), true);

    await writeArtifact(path.join(defaultArchiveReportsDir, "runs", "latest-run-id.txt"), 10);
    await writeFile(path.join(defaultArchiveReportsDir, "runs", "latest-run-id.txt"), "run_latest");
    await writeArtifact(path.join(defaultArchiveReportsDir, "runs", "run_latest", "bundle.json"), 64);
    await writeArtifact(path.join(defaultArchiveReportsDir, "runs", "run_old", "bundle.json"), 64, oldAge);
    await setAge(path.join(defaultArchiveReportsDir, "runs", "run_old"), oldAge);

    const defaultArchived = await runRetention(defaultArchiveReportsDir, true, true, { storageHome });
    assert.equal(defaultArchived.archive, true);
    assert.equal(defaultArchived.archiveDir.startsWith(path.join(storageHome, "reports-archive")), true);
    assert.equal(defaultArchived.archiveDir.includes(rootDir), false);
    assert.equal(await exists(path.join(defaultArchived.archiveDir, "runs", "run_old", "bundle.json")), true);
  } finally {
    await rm(reportsDir, { recursive: true, force: true });
    await rm(archiveReportsDir, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
    await rm(defaultArchiveReportsDir, { recursive: true, force: true });
    await rm(storageHome, { recursive: true, force: true });
  }
}
