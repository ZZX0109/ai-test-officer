import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const reportsDir = path.resolve(process.env.REPORTS_DIR ?? path.join(rootDir, "reports"));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const archive = args.has("--archive");
const pruneLocalStores = args.has("--prune-local-stores");
const successfulRetentionDays = numberOption("REPORT_SUCCESS_RETENTION_DAYS", "--success-days", 30);
const failedRetentionDays = numberOption("REPORT_FAILED_RETENTION_DAYS", "--failed-days", 7);
const keepSuccessfulRunsPerProject = numberOption("REPORT_KEEP_SUCCESS_RUNS", "--keep-success-runs", 20);
const sandboxCacheDays = numberOption("SANDBOX_CACHE_RETENTION_DAYS", "--sandbox-cache-days", 2);
const now = Date.now();
const storageHome = path.resolve(process.env.AI_TEST_OFFICER_HOME ?? path.join(homedir(), ".ai-test-officer"));
const archiveRoot = path.resolve(process.env.REPORT_ARCHIVE_DIR ?? path.join(storageHome, "reports-archive", archiveNamespace()));
const archiveDir = path.join(archiveRoot, new Date().toISOString().replace(/[:.]/g, "-"));
const plannedFiles = new Set();
const actions = [];

function argValue(name) {
  const item = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return item?.slice(name.length + 1);
}

function numberOption(envName, argName, fallback) {
  const value = Number(process.env[envName] ?? argValue(argName) ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function archiveNamespace() {
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 12);
  return `${path.basename(rootDir)}-${hash}`;
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function entries(dir) {
  if (!(await exists(dir))) return [];
  return Promise.all((await readdir(dir, { withFileTypes: true })).map(async (entry) => {
    const file = path.join(dir, entry.name);
    return { entry, file, stats: await lstat(file) };
  }));
}

async function byteSize(file, suppliedStats) {
  const current = suppliedStats ?? await lstat(file);
  if (current.isSymbolicLink()) return current.size;
  if (!current.isDirectory()) return current.size;
  const children = await entries(file);
  const sizes = await Promise.all(children.map(({ file: child, stats }) => byteSize(child, stats)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function relativeReportPath(file) {
  return path.relative(reportsDir, file).split(path.sep).join("/");
}

function classifyArtifact(file) {
  const extension = path.extname(file).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "screenshot";
  if ([".mp4", ".webm", ".mov"].includes(extension)) return "video";
  if (extension === ".zip" && /trace/i.test(file)) return "trace";
  if ([".log", ".txt"].includes(extension)) return "log";
  if (extension === ".json" && /manifest/i.test(file)) return "manifest";
  if (extension === ".json") return "report-body";
  return "other";
}

async function hashFile(file) {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}

async function walkFiles(dir) {
  const output = [];
  for (const item of await entries(dir)) {
    if (item.entry.name === "report-manifest.json") continue;
    if (item.entry.isDirectory()) output.push(...await walkFiles(item.file));
    else if (item.entry.isFile()) output.push({ file: item.file, stats: item.stats });
  }
  return output;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeStatus(bundle) {
  const raw = String(
    bundle?.result?.finalStatus
      ?? bundle?.result?.gateStatus
      ?? bundle?.result?.decision
      ?? bundle?.result?.status
      ?? bundle?.state
      ?? "unknown"
  );
  if (["pass", "passed", "continue", "completed", "success"].includes(raw)) return "success";
  if (["fail", "failed", "blocked", "cancelled", "needs-human-review", "hold_for_review"].includes(raw)) return "failed";
  return "unknown";
}

function projectId(bundle) {
  return String(
    bundle?.input?.projectId
      ?? bundle?.result?.projectId
      ?? bundle?.target?.projectId
      ?? "local"
  );
}

async function createRunManifest(runDir, stats) {
  const bundle = await readJson(path.join(runDir, "run_bundle.json"));
  const files = await walkFiles(runDir);
  const pinned = Boolean(bundle?.pinned || bundle?.result?.pinned || await exists(path.join(runDir, ".pinned")));
  const manifest = {
    schemaVersion: "1.0",
    runId: String(bundle?.runId ?? path.basename(runDir)),
    projectId: projectId(bundle),
    status: normalizeStatus(bundle),
    pinned,
    generatedAt: new Date().toISOString(),
    runCreatedAt: bundle?.startedAt ?? bundle?.result?.startedAt ?? stats.birthtime.toISOString(),
    files: await Promise.all(files.map(async ({ file, stats: fileStats }) => ({
      path: relativeReportPath(file),
      type: classifyArtifact(file),
      sizeBytes: fileStats.size,
      sha256: await hashFile(file),
      generatedAt: fileStats.mtime.toISOString(),
      retentionStatus: pinned ? "pinned" : "managed"
    })))
  };
  if (apply) {
    await writeFile(path.join(runDir, "report-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifest;
}

async function planRemove(file, reason, category, retention = {}) {
  const resolved = path.resolve(file);
  if (plannedFiles.has(resolved) || !(await exists(resolved))) return;
  plannedFiles.add(resolved);
  const stats = await stat(resolved);
  const bytes = await byteSize(resolved, stats);
  actions.push({
    // `file` and `archiveDir` remain as compatibility aliases for the
    // pre-v2 maintenance CLI. New callers should use `path` and
    // `archiveDirectory`.
    file: relativeReportPath(resolved),
    path: relativeReportPath(resolved),
    category,
    reason,
    mode: archive ? "archive" : "delete",
    sizeBytes: bytes,
    ...retention
  });
  if (!apply) return;
  if (archive) {
    const target = path.join(archiveDir, relativeReportPath(resolved));
    await mkdir(path.dirname(target), { recursive: true });
    await rename(resolved, target);
  } else {
    await rm(resolved, { recursive: true, force: true });
  }
}

function olderThan(stats, days) {
  return stats.mtimeMs < now - days * 24 * 60 * 60 * 1000;
}

async function planRunRetention() {
  const runEntries = (await entries(path.join(reportsDir, "runs")))
    .filter(({ entry }) => entry.isDirectory())
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  const successfulByProject = new Map();
  const records = [];
  for (const item of runEntries) {
    const manifest = await createRunManifest(item.file, item.stats);
    records.push({ ...item, manifest });
    if (manifest.status === "success") {
      const projectRuns = successfulByProject.get(manifest.projectId) ?? [];
      projectRuns.push(manifest.runId);
      successfulByProject.set(manifest.projectId, projectRuns);
    }
  }

  for (const item of records) {
    if (item.manifest.pinned) continue;
    const projectSuccesses = successfulByProject.get(item.manifest.projectId) ?? [];
    const isRecentSuccess = projectSuccesses.slice(0, keepSuccessfulRunsPerProject).includes(item.manifest.runId);
    const retentionDays = item.manifest.status === "success" ? successfulRetentionDays : failedRetentionDays;
    if (isRecentSuccess || !olderThan(item.stats, retentionDays)) continue;
    await planRemove(
      item.file,
      `${item.manifest.status} run exceeded ${retentionDays} day retention and is outside the latest ${keepSuccessfulRunsPerProject} successful project runs`,
      "run",
      { projectId: item.manifest.projectId, runId: item.manifest.runId, status: item.manifest.status }
    );
    await planRemove(path.join(reportsDir, "screenshots", item.manifest.runId), `paired artifact for expired run ${item.manifest.runId}`, "screenshot", { runId: item.manifest.runId });
    await planRemove(path.join(reportsDir, "traces", `${item.manifest.runId}.zip`), `paired artifact for expired run ${item.manifest.runId}`, "trace", { runId: item.manifest.runId });
  }
}

async function planLooseArtifactRetention() {
  const knownRunIds = new Set(
    (await entries(path.join(reportsDir, "runs")))
      .filter(({ entry }) => entry.isDirectory())
      .map(({ entry }) => entry.name)
  );
  for (const item of await entries(path.join(reportsDir, "screenshots"))) {
    if (knownRunIds.has(item.entry.name) || !olderThan(item.stats, failedRetentionDays)) continue;
    await planRemove(item.file, `orphaned screenshot set exceeded ${failedRetentionDays} day retention`, "screenshot");
  }
  for (const item of await entries(path.join(reportsDir, "traces"))) {
    const runId = item.entry.name.replace(/\.zip$/i, "");
    if (knownRunIds.has(runId) || !olderThan(item.stats, failedRetentionDays)) continue;
    await planRemove(item.file, `orphaned trace exceeded ${failedRetentionDays} day retention`, "trace");
  }
  for (const directory of ["commit-checks", "logs", "tmp"]) {
    for (const item of await entries(path.join(reportsDir, directory))) {
      if (!olderThan(item.stats, failedRetentionDays)) continue;
      await planRemove(item.file, `loose artifact exceeded ${failedRetentionDays} day retention`, "loose-artifact");
    }
  }
}

async function planSandboxCacheRetention() {
  for (const project of await entries(path.join(reportsDir, "sandbox-cache"))) {
    if (!project.entry.isDirectory()) continue;
    const caches = (await entries(project.file))
      .filter(({ entry }) => entry.isDirectory())
      .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
    for (const [index, cache] of caches.entries()) {
      if (index === 0 && !olderThan(cache.stats, sandboxCacheDays)) continue;
      await planRemove(
        cache.file,
        index === 0 ? `sandbox cache older than ${sandboxCacheDays} days` : "superseded sandbox cache",
        "sandbox-cache",
        { projectId: project.entry.name }
      );
    }
  }
}

async function planLocalStoreRetention() {
  if (!pruneLocalStores) return;
  for (const candidate of [
    path.join(reportsDir, "audit"),
    path.join(reportsDir, "run-state.sqlite"),
    path.join(reportsDir, "run-state.sqlite-shm"),
    path.join(reportsDir, "run-state.sqlite-wal")
  ]) {
    await planRemove(candidate, "local development state archived before rebuilding from production stores", "local-state");
  }
}

const totalBytesBefore = await byteSize(reportsDir).catch(() => 0);
await planRunRetention();
await planLooseArtifactRetention();
await planSandboxCacheRetention();
await planLocalStoreRetention();
const plannedBytes = actions.reduce((sum, action) => sum + action.sizeBytes, 0);
const manifest = {
  schemaVersion: "2.0",
  generatedAt: new Date().toISOString(),
  dryRun: !apply,
  archive,
  archiveDirectory: archive ? archiveDir : undefined,
  archiveDir: archive ? archiveDir : undefined,
  policy: {
    successfulRetentionDays,
    failedRetentionDays,
    keepSuccessfulRunsPerProject,
    sandboxCacheDays,
    pinnedRetention: "forever",
    pruneLocalStores
  },
  totalBytesBefore,
  projectedBytesAfter: Math.max(0, totalBytesBefore - plannedBytes),
  plannedBytes,
  actionCount: actions.length,
  actions
};
await mkdir(reportsDir, { recursive: true });
await writeFile(path.join(reportsDir, "retention-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
