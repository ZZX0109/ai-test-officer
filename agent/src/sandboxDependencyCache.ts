import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "./types.js";
import { captureProcessOutput } from "./processOutput.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const sandboxCacheDir = path.join(rootDir, "reports", "sandbox-cache");
const ignoredDirectories = new Set([
  ".git", ".next", ".nuxt", ".output", ".turbo", ".venv", "__pycache__", "build", "coverage", "dist",
  "node_modules", "reports", "target", "venv"
]);

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function collectDependencyDescriptors(cwd: string) {
  const descriptorNames = new Set([
    ".npmrc", ".nvmrc", ".python-version", ".yarnrc.yml", "Cargo.lock", "Cargo.toml", "Gemfile", "Gemfile.lock",
    "Pipfile.lock", "composer.json", "composer.lock", "go.mod", "go.sum", "build.gradle", "build.gradle.kts",
    "gradle.lockfile", "npm-shrinkwrap.json", "package-lock.json", "package.json", "pnpm-lock.yaml",
    "pnpm-workspace.yaml", "poetry.lock", "pom.xml", "pyproject.toml", "requirements.txt", "settings.gradle",
    "settings.gradle.kts", "uv.lock", "yarn.lock"
  ]);
  const indexed = await captureProcessOutput(
    "git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"], 10_000, 10 * 1024 * 1024
  );
  if (indexed.exitCode === 0) {
    return indexed.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((relative) => descriptorNames.has(path.basename(relative)))
      .slice(0, 2_000)
      .map((relative) => path.resolve(cwd, relative))
      .filter((absolute) => absolute === cwd || absolute.startsWith(`${cwd}${path.sep}`))
      .sort((left, right) => left.localeCompare(right));
  }
  const result: string[] = [];
  const pending = [cwd];
  while (pending.length && result.length < 2_000) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= 2_000) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(absolute);
      } else if (entry.isFile() && descriptorNames.has(entry.name)) {
        result.push(absolute);
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function fingerprintNonGitSource(cwd: string) {
  const digest = createHash("sha256");
  const pending = [cwd];
  let visited = 0;
  while (pending.length && visited < 100_000) {
    const directory = pending.pop()!;
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= 100_000) break;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(cwd, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(absolute);
        continue;
      }
      visited += 1;
      try {
        const metadata = await lstat(absolute);
        digest.update(relative);
        digest.update(`:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`);
        if (metadata.isSymbolicLink()) digest.update(`:${await readlink(absolute)}`);
      } catch {
        // The folder may be edited while it is being fingerprinted.
      }
    }
  }
  digest.update(`:visited=${visited}:pending=${pending.length}`);
  return digest.digest("hex").slice(0, 24);
}

async function directoryHasEntries(directory: string) {
  return (await readdir(directory).catch(() => [])).length > 0;
}

async function initializeSandboxVolume(input: {
  engine: "docker";
  image: string;
  name: string;
  projectId: string;
}) {
  const inspected = await captureProcessOutput(input.engine, ["volume", "inspect", input.name], 10_000);
  const existed = inspected.exitCode === 0;
  if (inspected.exitCode !== 0) {
    const created = await captureProcessOutput(input.engine, [
      "volume", "create", "--label", "ai-test-officer.managed=true",
      "--label", `ai-test-officer.project-id=${input.projectId}`, input.name
    ], 20_000);
    if (created.exitCode !== 0) return { ready: false, existed: false };
  }
  const initialized = await captureProcessOutput(input.engine, [
    "run", "--rm", "--user", "0:0", "--mount", `type=volume,src=${input.name},dst=/cache`,
    "--entrypoint", "/bin/sh", input.image, "-c", "chown 65532:65532 /cache && chmod 700 /cache"
  ], 120_000);
  return { ready: initialized.exitCode === 0, existed };
}

export async function prepareSandboxDependencyCache(
  project: ProjectConfig,
  cwd: string,
  options?: { dependencyDescriptorRoot?: string; workspaceNamespace?: string }
) {
  if (project.manifest?.execution.mode !== "oci") return undefined;
  if (project.manifest.execution.preinstalledDependencies) return undefined;
  const dependencyDescriptorRoot = options?.dependencyDescriptorRoot ?? cwd;
  const digest = createHash("sha256");
  digest.update(project.manifest.execution.image ?? "");
  digest.update(JSON.stringify(project.installCommandSpec ?? project.manifest.commands.install ?? null));
  for (const file of await collectDependencyDescriptors(dependencyDescriptorRoot)) {
    const relative = path.relative(dependencyDescriptorRoot, file).replaceAll(path.sep, "/");
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      digest.update(relative);
      digest.update(await readFile(file));
    } catch {
      // The manifest and command fingerprint remain authoritative.
    }
  }
  const key = digest.digest("hex").slice(0, 24);
  const sourceDigest = createHash("sha256");
  const gitHead = await captureProcessOutput("git", ["-C", cwd, "rev-parse", "HEAD"], 5_000);
  if (gitHead.exitCode === 0) {
    sourceDigest.update(gitHead.stdout);
    const gitDiff = await captureProcessOutput("git", ["-C", cwd, "diff", "--binary", "HEAD"], 15_000, 50 * 1024 * 1024);
    sourceDigest.update(gitDiff.stdout);
    const untracked = await captureProcessOutput("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], 10_000);
    for (const relative of untracked.stdout.split(/\r?\n/).filter(Boolean).slice(0, 2_000)) {
      const candidate = path.resolve(cwd, relative);
      if (candidate !== cwd && !candidate.startsWith(`${cwd}${path.sep}`)) continue;
      sourceDigest.update(relative);
      try {
        const metadata = await lstat(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        sourceDigest.update(await readFile(candidate));
      } catch {
        // The source can change while it is being scanned.
      }
    }
  } else {
    sourceDigest.update(await fingerprintNonGitSource(cwd));
  }
  const sourceFingerprint = sourceDigest.digest("hex").slice(0, 24);
  const safeProjectId = project.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeWorkspaceNamespace = options?.workspaceNamespace?.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  const cacheRoot = path.join(sandboxCacheDir, safeProjectId, key);
  const workspaceRoot = safeWorkspaceNamespace ? path.join(cacheRoot, "workspaces", safeWorkspaceNamespace) : path.join(cacheRoot, "workspace");
  const packageCacheRoot = path.join(cacheRoot, "packages");
  const metadataRoot = path.join(cacheRoot, "metadata");
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(packageCacheRoot, { recursive: true }), mkdir(metadataRoot, { recursive: true })]);
  await Promise.all([chmod(workspaceRoot, 0o777), chmod(packageCacheRoot, 0o777), chmod(metadataRoot, 0o777)]);
  const hasLegacyBindData = await directoryHasEntries(workspaceRoot) || await directoryHasEntries(packageCacheRoot);
  const packageVolumeKey = createHash("sha256").update(`${safeProjectId}:${key}`).digest("hex").slice(0, 24);
  const workspaceVolumeKey = createHash("sha256").update(`${safeProjectId}:${key}:${safeWorkspaceNamespace ?? "runtime"}`).digest("hex").slice(0, 24);
  const workspaceVolume = `ato-workspace-${workspaceVolumeKey}`;
  const packageCacheVolume = `ato-packages-${packageVolumeKey}`;
  const engine = project.manifest.execution.engine ?? "docker";
  const image = project.manifest.execution.image ?? "node:22-bookworm-slim";
  const [workspaceVolumeState, packageVolumeState] = await Promise.all([
    initializeSandboxVolume({ engine, image, name: workspaceVolume, projectId: project.id }),
    initializeSandboxVolume({ engine, image, name: packageCacheVolume, projectId: project.id })
  ]);
  const volumeReady = workspaceVolumeState.ready && packageVolumeState.ready;
  const volumePreparedMarker = await exists(path.join(metadataRoot, `prepared-${key}`));
  const volumePrepared = volumePreparedMarker && workspaceVolumeState.existed && packageVolumeState.existed;
  const bindPrepared = await exists(path.join(packageCacheRoot, `prepared-${key}`));
  const storageMode = volumeReady && (volumePrepared || !hasLegacyBindData || !bindPrepared) ? "volume" as const : "bind" as const;
  const markerRoot = storageMode === "volume" ? metadataRoot : packageCacheRoot;
  const prepared = storageMode === "volume" ? volumePrepared : bindPrepared;
  if (!prepared) {
    await rm(path.join(markerRoot, `prepared-${key}`), { force: true });
    await rm(path.join(markerRoot, `preparing-${key}`), { recursive: true, force: true });
  }
  return { key, sourceFingerprint, storageMode, workspaceRoot, packageCacheRoot, metadataRoot, workspaceVolume, packageCacheVolume, prepared };
}

export async function needsDependencyInstall(project: ProjectConfig, cwd: string) {
  if (project.manifest?.execution.mode === "oci") return true;
  const command = `${project.installCommandSpec?.executable ?? ""} ${project.installCommandSpec?.args.join(" ") ?? project.installCommand ?? ""}`.trim();
  if (!/\b(npm|pnpm|yarn)\b/.test(command)) return true;
  const dependencyDir = path.join(cwd, "node_modules");
  if (!(await exists(dependencyDir))) return true;
  const lockCandidates = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  const lock = (await Promise.all(lockCandidates.map(async (file) => {
    const candidate = path.join(cwd, file);
    return (await exists(candidate)) ? candidate : undefined;
  }))).find(Boolean);
  if (!lock) return false;
  try {
    const [dependencyStat, lockStat] = await Promise.all([stat(dependencyDir), stat(lock)]);
    return lockStat.mtimeMs > dependencyStat.mtimeMs;
  } catch {
    return true;
  }
}
