import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { listRunLocks } from "./runLock.js";

const execFileAsync = promisify(execFile);
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function entries(dir: string) {
  if (!(await exists(dir))) return [];
  return Promise.all((await readdir(dir, { withFileTypes: true })).map(async (entry) => {
    const file = path.join(dir, entry.name);
    return { entry, file, stats: await stat(file) };
  }));
}

async function byteSize(file: string, currentStats?: Awaited<ReturnType<typeof stat>>): Promise<number> {
  const stats = currentStats ?? await stat(file);
  if (!stats.isDirectory()) return Number(stats.size);
  const children = await entries(file);
  const sizes = await Promise.all(children.map(({ file: childFile, stats: childStats }) => byteSize(childFile, childStats)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function projectArchiveNamespace() {
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 10);
  return `${path.basename(rootDir)}-${hash}`;
}

export function defaultArchiveRoot() {
  const storageHome = path.resolve(process.env.AI_TEST_OFFICER_HOME ?? path.join(homedir(), ".ai-test-officer"));
  return path.resolve(process.env.REPORT_ARCHIVE_DIR ?? path.join(storageHome, "reports-archive", projectArchiveNamespace()));
}

async function readRetentionManifest() {
  try {
    return JSON.parse(await readFile(path.join(reportsDir, "retention-manifest.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function storageStatus() {
  const maxReportsMb = Number(process.env.REPORT_MAX_REPORTS_MB ?? 100);
  const maxReportsBytes = Number.isFinite(maxReportsMb) && maxReportsMb > 0 ? maxReportsMb * 1024 * 1024 : undefined;
  const reportsBytes = await byteSize(reportsDir).catch(() => 0);
  const archiveRoot = defaultArchiveRoot();
  const archiveBytes = await byteSize(archiveRoot).catch(() => 0);
  const archiveCount = (await entries(archiveRoot)).filter(({ entry }) => entry.isDirectory()).length;
  const retentionManifest = await readRetentionManifest();
  const overBudget = Boolean(maxReportsBytes && reportsBytes > maxReportsBytes);
  return {
    reportsDir,
    archiveRoot,
    reportsBytes,
    archiveBytes,
    archiveCount,
    maxReportsMb,
    budget: {
      maxReportsBytes,
      usedBytes: reportsBytes,
      remainingBytes: maxReportsBytes ? Math.max(0, maxReportsBytes - reportsBytes) : undefined,
      status: overBudget ? "over_budget" : "within_budget"
    },
    overBudget,
    retentionManifest,
    lastRetentionResult: retentionManifest,
    activeLocks: listRunLocks()
  };
}

export async function listStorageArchives() {
  const archiveRoot = defaultArchiveRoot();
  const archiveEntries = (await entries(archiveRoot))
    .filter(({ entry }) => entry.isDirectory())
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
  return Promise.all(archiveEntries.map(async ({ entry, file, stats }) => ({
    id: entry.name,
    path: file,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    sizeBytes: await byteSize(file, stats)
  })));
}

export async function runStorageRetention(input: { apply?: boolean; archive?: boolean }) {
  const script = path.join(rootDir, "scripts", "reports-retention.mjs");
  const args = [
    ...(input.apply ? ["--apply"] : []),
    ...(input.archive ?? true ? ["--archive"] : [])
  ];
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd: rootDir,
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}
