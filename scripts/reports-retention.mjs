import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const reportsDir = path.resolve(process.env.REPORTS_DIR ?? path.join(rootDir, "reports"));
const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const archive = args.has("--archive");
const maxAgeDays = numberOption("REPORT_RETENTION_DAYS", "--max-age-days", 7);
const keepRuns = numberOption("REPORT_KEEP_RUNS", "--keep-runs", 20);
const keepLooseArtifacts = numberOption("REPORT_KEEP_LOOSE_ARTIFACTS", "--keep-loose-artifacts", 30);
const maxReportsMb = numberOption("REPORT_MAX_REPORTS_MB", "--max-reports-mb", 100);
const maxReportsBytes = maxReportsMb > 0 ? maxReportsMb * 1024 * 1024 : undefined;
const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
const storageHome = path.resolve(process.env.AI_TEST_OFFICER_HOME ?? path.join(homedir(), ".ai-test-officer"));
const archiveRoot = path.resolve(process.env.REPORT_ARCHIVE_DIR ?? path.join(storageHome, "reports-archive", archiveNamespace()));
const archiveDir = path.join(archiveRoot, new Date().toISOString().replace(/[:.]/g, "-"));
const protectedNames = new Set([".gitkeep", "index.json", "latest.json", "latest-run-id.txt"]);
const looseArtifactDirs = [
  "videos",
  "commit-checks",
  "requirement-acceptance",
  "patrol-runs",
  "demo-verification",
  "judge-eval",
  "harness-gaps",
  "bot",
  "screenshots"
];
const actions = [];
const plannedFiles = new Set();

function argValue(name) {
  const item = process.argv.slice(2).find((value) => value.startsWith(`${name}=`));
  return item?.slice(name.length + 1);
}

function numberOption(envName, argName, fallback) {
  const parsed = Number(process.env[envName] ?? argValue(argName) ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function archiveNamespace() {
  const hash = createHash("sha1").update(rootDir).digest("hex").slice(0, 10);
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
    return { entry, file, stats: await stat(file) };
  }));
}

async function byteSize(file, stats = undefined) {
  const current = stats ?? await stat(file);
  if (!current.isDirectory()) return current.size;
  const children = await entries(file);
  const sizes = await Promise.all(children.map(({ file: childFile, stats: childStats }) => byteSize(childFile, childStats)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function displayPath(file) {
  const rootRelative = path.relative(rootDir, file);
  if (!rootRelative.startsWith("..") && !path.isAbsolute(rootRelative)) return rootRelative;
  return path.join(path.basename(reportsDir), path.relative(reportsDir, file));
}

async function latestRunId() {
  try {
    return (await readFile(path.join(reportsDir, "runs", "latest-run-id.txt"), "utf8")).trim();
  } catch {
    return undefined;
  }
}

function shouldPruneByAge(stats) {
  return stats.mtimeMs < cutoff;
}

async function planRemove(file, reason) {
  const resolved = path.resolve(file);
  if (plannedFiles.has(resolved)) return 0;
  plannedFiles.add(resolved);
  const stats = await stat(resolved);
  const bytes = await byteSize(resolved, stats);
  const relativeToReports = path.relative(reportsDir, resolved);
  actions.push({ file: displayPath(resolved), reason, mode: archive ? "archive" : "delete", bytes });
  if (!apply) return bytes;
  if (archive) {
    const target = path.join(archiveDir, relativeToReports);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(resolved, target);
    return bytes;
  }
  await rm(resolved, { recursive: true, force: true });
  return bytes;
}

async function runDirectoryEntries() {
  return (await entries(path.join(reportsDir, "runs")))
    .filter(({ entry }) => entry.isDirectory() && entry.name.startsWith("run_"))
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
}

async function activeRunIds() {
  const latest = await latestRunId();
  const ids = new Set((await runDirectoryEntries()).map(({ entry }) => entry.name));
  if (latest) ids.add(latest);
  return ids;
}

async function pruneRunScoped() {
  const latest = await latestRunId();
  const runEntries = await runDirectoryEntries();
  const keep = new Set(runEntries.slice(0, keepRuns).map(({ entry }) => entry.name));
  if (latest) keep.add(latest);
  for (const { entry, file, stats } of runEntries) {
    if (entry.name === latest) continue;
    if (keep.has(entry.name) && !shouldPruneByAge(stats)) continue;
    await planRemove(file, keep.has(entry.name) ? `older than ${maxAgeDays} days` : `exceeds keepRuns=${keepRuns}`);
    const screenshotDir = path.join(reportsDir, "screenshots", entry.name);
    if (await exists(screenshotDir)) await planRemove(screenshotDir, `paired screenshots for ${entry.name}`);
    const traceFile = path.join(reportsDir, "traces", `${entry.name}.zip`);
    if (await exists(traceFile)) await planRemove(traceFile, `paired trace for ${entry.name}`);
  }
}

async function pruneOrphanedRunArtifacts() {
  const runIds = await activeRunIds();
  for (const { entry, file } of await entries(path.join(reportsDir, "screenshots"))) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_") || runIds.has(entry.name)) continue;
    await planRemove(file, `orphaned screenshots without run bundle ${entry.name}`);
  }
  for (const { entry, file } of await entries(path.join(reportsDir, "traces"))) {
    if (!entry.isFile() || !entry.name.startsWith("run_") || !entry.name.endsWith(".zip")) continue;
    const runId = entry.name.replace(/\.zip$/, "");
    if (!runIds.has(runId)) await planRemove(file, `orphaned trace without run bundle ${runId}`);
  }
}

async function pruneLooseArtifacts() {
  for (const dirName of looseArtifactDirs) {
    const items = (await entries(path.join(reportsDir, dirName)))
      .filter(({ entry }) => !protectedNames.has(entry.name))
      .filter(({ entry }) => dirName !== "screenshots" || entry.isFile())
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    const keep = new Set(items.slice(0, keepLooseArtifacts).map(({ file }) => file));
    for (const { file, stats } of items) {
      if (keep.has(file) && !shouldPruneByAge(stats)) continue;
      await planRemove(file, keep.has(file) ? `older than ${maxAgeDays} days` : `exceeds keepLooseArtifacts=${keepLooseArtifacts}`);
    }
  }
}

async function collectSizeCandidates() {
  const latest = await latestRunId();
  const candidates = new Map();
  async function add(file, stats, reason) {
    const resolved = path.resolve(file);
    if (plannedFiles.has(resolved) || candidates.has(resolved)) return;
    candidates.set(resolved, {
      file: resolved,
      stats,
      bytes: await byteSize(resolved, stats),
      reason
    });
  }
  for (const { entry, file, stats } of await runDirectoryEntries()) {
    if (entry.name !== latest) await add(file, stats, `reports size exceeds ${maxReportsMb} MB`);
  }
  for (const { entry, file, stats } of await entries(path.join(reportsDir, "screenshots"))) {
    if (protectedNames.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === latest) continue;
    await add(file, stats, `reports size exceeds ${maxReportsMb} MB`);
  }
  for (const { entry, file, stats } of await entries(path.join(reportsDir, "traces"))) {
    if (protectedNames.has(entry.name)) continue;
    if (entry.name === `${latest}.zip`) continue;
    await add(file, stats, `reports size exceeds ${maxReportsMb} MB`);
  }
  for (const dirName of looseArtifactDirs.filter((dirName) => dirName !== "screenshots")) {
    for (const { entry, file, stats } of await entries(path.join(reportsDir, dirName))) {
      if (!protectedNames.has(entry.name)) await add(file, stats, `reports size exceeds ${maxReportsMb} MB`);
    }
  }
  return [...candidates.values()].sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
}

async function enforceSizeBudget(totalBytesBefore) {
  if (!maxReportsBytes || totalBytesBefore <= maxReportsBytes) return totalBytesBefore - plannedBytes();
  let projectedBytesAfter = totalBytesBefore - plannedBytes();
  for (const candidate of await collectSizeCandidates()) {
    if (projectedBytesAfter <= maxReportsBytes) break;
    if (plannedFiles.has(candidate.file)) continue;
    await planRemove(candidate.file, candidate.reason);
    projectedBytesAfter -= candidate.bytes;
  }
  return projectedBytesAfter;
}

function plannedBytes() {
  return actions.reduce((sum, action) => sum + (action.bytes ?? 0), 0);
}

const totalBytesBefore = await byteSize(reportsDir).catch(() => 0);
await pruneRunScoped();
await pruneOrphanedRunArtifacts();
await pruneLooseArtifacts();
const projectedBytesAfter = await enforceSizeBudget(totalBytesBefore);
const manifest = {
  createdAt: new Date().toISOString(),
  dryRun: !apply,
  archive,
  archiveDir: archive ? archiveDir : undefined,
  maxAgeDays,
  keepRuns,
  keepLooseArtifacts,
  maxReportsMb,
  totalBytesBefore,
  projectedBytesAfter,
  plannedBytes: plannedBytes(),
  actionCount: actions.length,
  actions
};
await mkdir(reportsDir, { recursive: true });
await writeFile(path.join(reportsDir, "retention-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
