import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectConfig,
  ProjectHealthCheckResult,
  ProjectLoginConfig,
  ProjectProcessConfig,
  ProjectRuntimeFailureReason,
  ProjectRuntimeStatus,
  TargetAppRuntime,
  TargetProjectConfig
} from "./types.js";
import { redactRecord, redactText } from "./redaction.js";
import { commandSpecSchema, projectManifestSchema, type CommandSpec } from "@ai-test-officer/contracts";
import { buildOciInvocation, classifyRuntimeFailure } from "@ai-test-officer/execution-worker";
import { getProjectLoginSecret } from "./projectLoginStore.js";
import { decrypt, getCredential } from "./credentialStore.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const projectDir = path.join(rootDir, "data", "projects");
const sandboxCacheDir = path.join(rootDir, "reports", "sandbox-cache");
type RunningProcess = { config: ProjectProcessConfig; process: ChildProcess };
type OciContainerRef = { engine: "docker" | "podman"; containerName: string };
type RunningProject = {
  process?: ChildProcess;
  processes?: RunningProcess[];
  ociContainers?: OciContainerRef[];
  status: ProjectRuntimeStatus;
};
const runningProjects = new Map<string, RunningProject>();
const projectStartPromises = new Map<string, Promise<ProjectRuntimeStatus>>();
const sandboxRecoveryPromises = new Map<string, Promise<void>>();
const recoveredSandboxMonitors = new Set<string>();
const processLogs = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();
const ociProcesses = new WeakMap<ChildProcess, { engine: "docker" | "podman"; containerName: string }>();
const activeRuntimeStatuses = new Set<ProjectRuntimeStatus["status"]>(["installing", "starting", "running"]);

function now() {
  return new Date().toISOString();
}

function safeProjectPath(project: Pick<ProjectConfig, "projectPath" | "allowExternalProjectPath">) {
  const resolved = path.isAbsolute(project.projectPath)
    ? path.resolve(project.projectPath)
    : path.resolve(rootDir, project.projectPath);
  const relative = path.relative(rootDir, resolved);
  const outsideWorkspace = relative.startsWith("..") || path.isAbsolute(relative);
  if (outsideWorkspace && !project.allowExternalProjectPath) {
    throw new Error(`Project path escapes workspace. Set allowExternalProjectPath=true to connect external local projects: ${project.projectPath}`);
  }
  return resolved;
}

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const sandboxFingerprintIgnoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
  "target",
  "venv"
]);

async function collectDependencyDescriptors(cwd: string) {
  const descriptorNames = new Set([
    ".npmrc",
    ".nvmrc",
    ".python-version",
    ".yarnrc.yml",
    "Cargo.lock",
    "Cargo.toml",
    "Gemfile",
    "Gemfile.lock",
    "Pipfile.lock",
    "composer.json",
    "composer.lock",
    "go.mod",
    "go.sum",
    "build.gradle",
    "build.gradle.kts",
    "gradle.lockfile",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "poetry.lock",
    "pom.xml",
    "pyproject.toml",
    "requirements.txt",
    "settings.gradle",
    "settings.gradle.kts",
    "uv.lock",
    "yarn.lock"
  ]);
  const indexed = await captureProcessOutput(
    "git",
    ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"],
    10_000,
    10 * 1024 * 1024
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
        if (!sandboxFingerprintIgnoredDirectories.has(entry.name)) pending.push(absolute);
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
        if (!sandboxFingerprintIgnoredDirectories.has(entry.name)) pending.push(absolute);
        continue;
      }
      visited += 1;
      try {
        const metadata = await lstat(absolute);
        digest.update(relative);
        digest.update(`:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`);
        if (metadata.isSymbolicLink()) digest.update(`:${await readlink(absolute)}`);
      } catch {
        // Files can legitimately disappear while an editor or build process
        // updates the selected folder. The next scan will produce a new key.
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
  engine: "docker" | "podman";
  image: string;
  name: string;
  projectId: string;
}) {
  const inspected = await captureProcessOutput(input.engine, ["volume", "inspect", input.name], 10_000);
  const existed = inspected.exitCode === 0;
  if (inspected.exitCode !== 0) {
    const created = await captureProcessOutput(input.engine, [
      "volume", "create",
      "--label", "ai-test-officer.managed=true",
      "--label", `ai-test-officer.project-id=${input.projectId}`,
      input.name
    ], 20_000);
    if (created.exitCode !== 0) return { ready: false, existed: false };
  }
  // The target application still runs as uid 65532. This one-shot container
  // only assigns ownership of an empty managed volume; it never mounts or
  // executes the untrusted project source.
  const initialized = await captureProcessOutput(input.engine, [
    "run", "--rm", "--user", "0:0",
    "--mount", `type=volume,src=${input.name},dst=/cache`,
    "--entrypoint", "/bin/sh",
    input.image,
    "-c", "chown 65532:65532 /cache && chmod 700 /cache"
  ], 120_000);
  return { ready: initialized.exitCode === 0, existed };
}

export async function prepareSandboxDependencyCache(
  project: ProjectConfig,
  cwd: string,
  options?: {
    /**
     * Dependency descriptors may come from the immutable source project while
     * `cwd` points at a writable repair copy. This lets validation reuse the
     * prepared dependency volume without treating ordinary source edits as a
     * dependency change.
     */
    dependencyDescriptorRoot?: string;
    /**
     * Keep the package store shared while assigning a distinct writable
     * workspace to repair/validation runs. A validation source refresh must
     * never mutate the volume used by a live target runtime.
     */
    workspaceNamespace?: string;
  }
) {
  if (project.manifest?.execution.mode !== "oci") return undefined;
  const dependencyDescriptorRoot = options?.dependencyDescriptorRoot ?? cwd;
  const digest = createHash("sha256");
  digest.update(project.manifest.execution.image ?? "");
  digest.update(JSON.stringify(project.installCommandSpec ?? project.manifest.commands.install ?? null));
  // Include nested workspace descriptors, not just the repository root. A
  // dependency change in apps/web/package.json must invalidate the prepared
  // environment even when the root lockfile has not been regenerated yet.
  for (const file of await collectDependencyDescriptors(dependencyDescriptorRoot)) {
    const relative = path.relative(dependencyDescriptorRoot, file).replaceAll(path.sep, "/");
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      digest.update(relative);
      digest.update(await readFile(file));
    } catch {
      // Missing dependency descriptors are represented by the remaining
      // manifest and command fingerprint.
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
    const untrackedFiles = untracked.stdout.split(/\r?\n/).filter(Boolean).slice(0, 2_000);
    for (const relative of untrackedFiles) {
      const candidate = path.resolve(cwd, relative);
      if (candidate !== cwd && !candidate.startsWith(`${cwd}${path.sep}`)) continue;
      sourceDigest.update(relative);
      try {
        const metadata = await lstat(candidate);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        sourceDigest.update(await readFile(candidate));
      } catch {
        // Directories and files that disappear during scanning are ignored.
      }
    }
  } else {
    // Finder-selected folders often are not Git repositories. Use a stable
    // metadata fingerprint so unchanged 50k-file projects do not get copied
    // into the sandbox again on every start.
    sourceDigest.update(await fingerprintNonGitSource(cwd));
  }
  const sourceFingerprint = sourceDigest.digest("hex").slice(0, 24);
  const safeProjectId = project.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeWorkspaceNamespace = options?.workspaceNamespace
    ?.replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 80);
  const cacheRoot = path.join(sandboxCacheDir, safeProjectId, key);
  const workspaceRoot = safeWorkspaceNamespace
    ? path.join(cacheRoot, "workspaces", safeWorkspaceNamespace)
    : path.join(cacheRoot, "workspace");
  const packageCacheRoot = path.join(cacheRoot, "packages");
  const metadataRoot = path.join(cacheRoot, "metadata");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(packageCacheRoot, { recursive: true }),
    mkdir(metadataRoot, { recursive: true })
  ]);
  // Docker Desktop preserves host bind permissions. These directories contain
  // only project-scoped disposable dependency data and must be writable by the
  // non-root sandbox uid.
  await Promise.all([
    chmod(workspaceRoot, 0o777),
    chmod(packageCacheRoot, 0o777),
    chmod(metadataRoot, 0o777)
  ]);
  // Preserve already-created bind caches so an in-progress preparation is
  // never discarded. Brand-new caches use engine-native volumes, which avoid
  // Docker Desktop's very slow macOS bind-mount writes for node_modules.
  const hasLegacyBindData = await directoryHasEntries(workspaceRoot)
    || await directoryHasEntries(packageCacheRoot);
  const packageVolumeKey = createHash("sha256").update(`${safeProjectId}:${key}`).digest("hex").slice(0, 24);
  const workspaceVolumeKey = createHash("sha256")
    .update(`${safeProjectId}:${key}:${safeWorkspaceNamespace ?? "runtime"}`)
    .digest("hex")
    .slice(0, 24);
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
  const volumePrepared = volumePreparedMarker
    && workspaceVolumeState.existed
    && packageVolumeState.existed;
  const bindPrepared = await exists(path.join(packageCacheRoot, `prepared-${key}`));
  // Prefer a previously prepared engine-native volume even when an obsolete
  // bind cache is still present. The old rule treated any legacy workspace
  // file as authoritative, so a valid multi-gigabyte volume was ignored and
  // every launch repeated a cold install until the health check timed out.
  const storageMode = volumeReady && (volumePrepared || !hasLegacyBindData || !bindPrepared)
    ? "volume" as const
    : "bind" as const;
  const markerRoot = storageMode === "volume" ? metadataRoot : packageCacheRoot;
  const prepared = storageMode === "volume"
    ? volumePrepared
    : bindPrepared;
  if (!prepared) {
    // A metadata marker can outlive a deleted/recreated Docker volume. Never
    // allow that stale marker to make an empty volume look prepared.
    await rm(path.join(markerRoot, `prepared-${key}`), { force: true });
    await rm(path.join(markerRoot, `preparing-${key}`), { recursive: true, force: true });
  }
  return {
    key,
    sourceFingerprint,
    storageMode,
    workspaceRoot,
    packageCacheRoot,
    metadataRoot,
    workspaceVolume,
    packageCacheVolume,
    prepared
  };
}

async function needsDependencyInstall(project: ProjectConfig, cwd: string) {
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

function projectFile(id: string) {
  return path.join(projectDir, `${id}.json`);
}

function normalizeProjectConfig(input: ProjectConfig): ProjectConfig {
  const timestamp = now();
  const manifest = input.manifest
    ? projectManifestSchema.parse(input.manifest)
    : undefined;
  // Uploaded/external projects always execute in the OCI boundary in the
  // running application. Test fixtures may still construct trusted-local
  // projects in NODE_ENV=test for adapter unit tests.
  const enforcedManifest = input.allowExternalProjectPath && process.env.NODE_ENV !== "test" && manifest
    ? {
      ...manifest,
      execution: {
        ...manifest.execution,
        mode: "oci" as const,
        image: manifest.execution.image ?? "node:22-bookworm-slim",
        engine: manifest.execution.engine ?? "docker" as const
      }
    }
    : manifest;
  return {
    ...input,
    manifest: enforcedManifest,
    allowExternalProjectPath: input.allowExternalProjectPath ?? false,
    processes: input.processes?.map((processConfig) => ({
      ...processConfig,
      required: processConfig.required ?? true
    })),
    timeoutMs: input.timeoutMs ?? 20_000,
    env: redactRecord(input.env ?? {}),
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp
  };
}

export function defaultProjectConfig(): ProjectConfig {
  const timestamp = now();
  return {
    id: "local_demo_app",
    name: "Local Demo App Under Test",
    projectPath: "app-under-test",
    allowExternalProjectPath: false,
    installCommand: "",
    installCommandSpec: undefined,
    startCommand: "npm run dev",
    healthCheckUrl: "http://127.0.0.1:6173",
    frontendUrl: "http://localhost:6173",
    backendUrl: "http://127.0.0.1:6172/api/health",
    allowedOrigins: ["http://127.0.0.1:6173", "http://localhost:6173"],
    login: { method: "none" },
    env: {
      VITE_TASK_FILTER_FIXTURE_BUG: "0",
      VITE_APP_API_URL: "http://localhost:6172"
    },
    cleanupCommand: "",
    timeoutMs: 25_000,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function toTargetProjectConfig(project: ProjectConfig): TargetProjectConfig {
  return {
    ...project,
    projectId: project.id,
    rootDir: safeProjectPath(project),
    appUrl: project.frontendUrl,
    apiUrl: project.backendUrl,
    testCommand: project.testCommand,
    testCommandSpec: project.testCommandSpec,
    allowedOrigins: project.allowedOrigins ?? []
  };
}

export async function ensureProjectRegistry() {
  await mkdir(projectDir, { recursive: true });
  const file = projectFile(defaultProjectConfig().id);
  if (!(await exists(file))) {
    await writeFile(file, JSON.stringify(defaultProjectConfig(), null, 2));
  }
}

export async function listProjects() {
  await ensureProjectRegistry();
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(projectDir))
    .filter((file) => file.endsWith(".json") && !file.endsWith(".open_api.json") && !/(?:^|[_-])(selftest|self_test)(?:[_-]|$)|runtime[_-]?unavailable.*selftest/i.test(file))
    .sort();
  const projects: ProjectConfig[] = [];
  for (const file of files) {
    try {
      const candidate = JSON.parse(await readFile(path.join(projectDir, file), "utf8")) as Partial<ProjectConfig>;
      if (
        typeof candidate.id !== "string"
        || !candidate.id.trim()
        || typeof candidate.name !== "string"
        || !candidate.name.trim()
        || typeof candidate.projectPath !== "string"
        || !candidate.projectPath.trim()
        || typeof candidate.frontendUrl !== "string"
        || !candidate.frontendUrl.trim()
      ) {
        continue;
      }
      projects.push(normalizeProjectConfig(candidate as ProjectConfig));
    } catch {
      // Auxiliary and invalid JSON files are not project registry entries.
    }
  }
  return projects;
}

export async function getProject(id: string) {
  await ensureProjectRegistry();
  try {
    return normalizeProjectConfig(JSON.parse(await readFile(projectFile(id), "utf8")) as ProjectConfig);
  } catch {
    return undefined;
  }
}

export async function saveProject(input: ProjectConfig) {
  await ensureProjectRegistry();
  const existing = await getProject(input.id);
  const project = normalizeProjectConfig({
    ...input,
    createdAt: existing?.createdAt ?? input.createdAt ?? now(),
    updatedAt: now()
  });
  safeProjectPath(project);
  await writeFile(projectFile(project.id), JSON.stringify(project, null, 2));
  return project;
}

export function getProjectRuntimeStatus(id: string): ProjectRuntimeStatus {
  const running = runningProjects.get(id);
  const status = running?.status;
  if (status) {
    const current = Date.now();
    const phaseStarted = status.phaseStartedAt ? Date.parse(status.phaseStartedAt) : undefined;
    const deadline = status.deadlineAt ? Date.parse(status.deadlineAt) : undefined;
    const elapsedMs = phaseStarted && Number.isFinite(phaseStarted) ? Math.max(0, current - phaseStarted) : status.elapsedMs;
    const remainingMs = status.status === "running"
      ? 0
      : deadline && Number.isFinite(deadline)
        ? Math.max(0, deadline - current)
        : status.remainingMs;
    const phaseBudget = phaseStarted && deadline && deadline > phaseStarted ? deadline - phaseStarted : undefined;
    const logs = running?.processes
      ?.map((item) => {
        const log = processLogs.get(item.process);
        return `${log?.stdout ?? ""}\n${log?.stderr ?? ""}`;
      })
      .join("\n") ?? "";
    const installProgress = logs.match(/Progress:\s+resolved\s+(\d+),.*?added\s+(\d+)/g)?.at(-1);
    const installingDependencies = status.status === "starting" && Boolean(installProgress || /Lockfile is up to date|Installing dependencies/i.test(logs));
    return {
      ...status,
      status: installingDependencies ? "installing" : status.status,
      phase: installingDependencies ? "installing_dependencies" : status.phase,
      elapsedMs,
      remainingMs,
      progressPercent: status.status === "running"
        ? 100
        : phaseBudget && elapsedMs !== undefined
          ? Math.min(95, Math.round((elapsedMs / phaseBudget) * 100))
        : status.progressPercent,
      message: installingDependencies
        ? `Sandbox is installing project dependencies${installProgress ? ` (${installProgress.replace(/^Progress:\s*/, "")})` : ""}.`
        : status.message,
      updatedAt: now()
    };
  }
  return {
    projectId: id,
    status: "idle",
    phase: "idle",
    progressPercent: 0,
    updatedAt: now(),
    message: "Project is not running."
  };
}

/** Rehydrates OCI runtime state after an Agent hot reload or service restart.
 * The container is the durable execution process; the in-memory map is only a
 * cache and must never make a healthy sandbox appear idle. */
export async function getProjectRuntimeStatusWithRecovery(id: string): Promise<ProjectRuntimeStatus> {
  const cached = getProjectRuntimeStatus(id);
  if (cached.status !== "idle") {
    // A process can disappear after a successful launch (for example a Vite
    // dev server exits when its esbuild service crashes).  Returning the
    // in-memory `running` snapshot forever leaves the Workbench iframe pointed
    // at a dead port and makes the failure look like a browser problem.  Poll
    // the runtime endpoint before advertising a managed project as live.
    if (cached.status === "running") {
      const containerFailure = await inspectManagedContainerFailure(runningProjects.get(id));
      if (containerFailure) {
        const failed: ProjectRuntimeStatus = {
          ...cached,
          status: "failed",
          phase: "failed",
          progressPercent: 100,
          failureReason: containerFailure,
          updatedAt: now(),
          message: containerFailure === "budget_exceeded"
            ? "安全沙盒内存不足，前端编译进程已退出。系统将使用重型项目资源配置重建沙盒。"
            : "安全沙盒进程已退出，需要重新启动并诊断。"
        };
        runningProjects.set(id, { ...runningProjects.get(id), status: failed });
        return failed;
      }
      const project = await getProject(id);
      if (project) {
        const health = await testProjectConnection(projectWithActiveRuntime(project));
        if (!health.ok) {
          const failed: ProjectRuntimeStatus = {
            ...cached,
            status: "failed",
            phase: "failed",
            progressPercent: 100,
            failureReason: health.reason,
            updatedAt: now(),
            message: `项目运行已停止或不可访问：${health.reason}。可重新启动沙盒并诊断。`
          };
          runningProjects.set(id, { ...runningProjects.get(id), status: failed });
          return failed;
        }
      }
    }
    // Saving a project and submitting an async start can overlap during an
    // Agent hot reload. In that narrow window an earlier lookup may record
    // config_missing even though the registry file has since been committed.
    // Do not leave the Workbench stuck on that stale terminal state: re-read
    // the registry and return the project to a retryable idle state.
    if (cached.status === "failed" && cached.failureReason === "config_missing" && await getProject(id)) {
      runningProjects.delete(id);
      return {
        projectId: id,
        status: "idle",
        phase: "idle",
        progressPercent: 0,
        updatedAt: now(),
        failureReason: "none",
        message: "项目配置已刷新，可以重新启动。"
      };
    }
    return cached;
  }
  const project = await getProject(id);
  if (!project || project.manifest?.execution.mode !== "oci") return cached;
  // Runtime polling is on the UI's hot path. Docker/Podman can take several
  // seconds to answer while starting or recovering, so never make the page
  // wait for a container inspection. A single background recovery updates the
  // in-memory state for the next poll instead.
  if (!sandboxRecoveryPromises.has(id)) {
    const recovery = inspectRunningSandbox(project)
      .then((recovered) => {
        if (!recovered) return;
        runningProjects.set(id, recovered.running);
        if (recovered.running.status.status !== "running") {
          monitorRecoveredSandbox(id, recovered.runtimeProject);
        }
      })
      .catch(() => undefined)
      .finally(() => sandboxRecoveryPromises.delete(id));
    sandboxRecoveryPromises.set(id, recovery);
  }
  return {
    ...cached,
    message: "正在后台检查沙盒运行状态。"
  };
}

export function recordProjectRuntimeStatus(status: ProjectRuntimeStatus) {
  runningProjects.set(status.projectId, { status: { ...status, updatedAt: now() } });
}

function runtimeTiming(timeoutMs: number, phase: NonNullable<ProjectRuntimeStatus["phase"]>) {
  const phaseStartedAt = now();
  return {
    phase,
    phaseStartedAt,
    deadlineAt: new Date(Date.parse(phaseStartedAt) + timeoutMs).toISOString(),
    elapsedMs: 0,
    remainingMs: timeoutMs,
    progressPercent: 0,
    updatedAt: phaseStartedAt
  };
}

function isActiveRuntimeStatus(status: ProjectRuntimeStatus["status"]) {
  return activeRuntimeStatuses.has(status);
}

async function checkUrl(url: string | undefined, timeoutMs: number) {
  if (!url) return undefined;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, url };
  } catch (error) {
    return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
  }
}

function healthReason(input: {
  pathOk: boolean;
  credentialOk: boolean;
  frontend?: { ok: boolean };
  backend?: { ok: boolean };
  health?: { ok: boolean };
  processHealth?: Array<{ required: boolean; ok: boolean }>;
}): ProjectRuntimeFailureReason {
  if (!input.pathOk) return "project_path_missing";
  if (!input.credentialOk) return "credential_missing";
  if (input.processHealth?.some((item) => item.required && !item.ok)) return "health_timeout";
  if (input.health && !input.health.ok) return "health_timeout";
  if (input.frontend && !input.frontend.ok) return "frontend_unreachable";
  if (input.backend && !input.backend.ok) return "backend_unreachable";
  return "none";
}

function hasEnvValue(name: string | undefined) {
  return Boolean(name?.trim() && process.env[name.trim()]?.trim());
}

function credentialCheck(login: ProjectLoginConfig | undefined, projectSecretResolved = false): ProjectHealthCheckResult["credential"] {
  if (!login || login.method === "none") {
    return { ok: true, method: "none", missingEnv: [] };
  }
  if (login.credentialId?.trim()) {
    if (login.credentialId.startsWith("login_") && !projectSecretResolved) {
      return {
        ok: false,
        method: login.method,
        credentialId: login.credentialId,
        missingEnv: ["encrypted project login credential"]
      };
    }
    return {
      ok: true,
      method: login.method,
      credentialId: login.credentialId,
      missingEnv: []
    };
  }
  const requiredEnv = [login.usernameEnv, login.passwordEnv]
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item));
  const missingEnv = requiredEnv.filter((name) => !hasEnvValue(name));
  const missingConfiguredNames = [
    login.usernameEnv?.trim() ? undefined : "usernameEnv",
    login.passwordEnv?.trim() ? undefined : "passwordEnv"
  ].filter((item): item is string => Boolean(item));
  return {
    ok: missingEnv.length === 0 && missingConfiguredNames.length === 0,
    method: login.method,
    missingEnv: [...missingConfiguredNames, ...missingEnv]
  };
}

function apiCredentialCheck(
  project: ProjectConfig,
  resolvedCredentialIds: Set<string>
): ProjectHealthCheckResult["apiCredential"] {
  const requirements = project.apiCredentialRequirements ?? [];
  const bindings = new Map((project.apiCredentialBindings ?? []).map((binding) => [binding.envName, binding]));
  const status = requirements.map((requirement) => {
    const binding = bindings.get(requirement.envName);
    return {
      envName: requirement.envName,
      configured: Boolean(binding && resolvedCredentialIds.has(binding.credentialId)),
      credentialId: binding?.credentialId,
      source: binding?.source,
      exposure: requirement.exposure
    };
  });
  return {
    ok: status.every((item) => item.configured),
    requirements: status,
    missingEnv: status.filter((item) => !item.configured).map((item) => item.envName)
  };
}

async function withProjectSecrets(project: ProjectConfig) {
  const login = project.login;
  let runtimeProject = project;
  let loginSecretResolved = false;
  if (login?.credentialId?.startsWith("login_")) {
    const secret = await getProjectLoginSecret(login.credentialId);
    if (secret && secret.projectId === project.id && login.usernameEnv && login.passwordEnv) {
      runtimeProject = {
        ...runtimeProject,
        env: {
          ...(runtimeProject.env ?? {}),
          [login.usernameEnv]: secret.username,
          [login.passwordEnv]: secret.password
        }
      };
      loginSecretResolved = true;
    }
  }
  const resolvedCredentialIds = new Set<string>();
  for (const binding of project.apiCredentialBindings ?? []) {
    const credential = await getCredential(binding.credentialId);
    if (!credential) continue;
    const apiKey = await decrypt(credential.apiKeyEncrypted).catch(() => undefined);
    if (!apiKey) continue;
    runtimeProject = {
      ...runtimeProject,
      env: {
        ...(runtimeProject.env ?? {}),
        [binding.envName]: apiKey,
        ...(binding.baseUrlEnv ? { [binding.baseUrlEnv]: credential.baseUrl } : {}),
        ...(binding.modelEnv ? { [binding.modelEnv]: credential.model } : {})
      }
    };
    resolvedCredentialIds.add(binding.credentialId);
  }
  return {
    project: runtimeProject,
    loginSecretResolved,
    resolvedCredentialIds
  };
}

export async function testProjectConnection(project: ProjectConfig): Promise<ProjectHealthCheckResult> {
  const startedAt = Date.now();
  const hydrated = await withProjectSecrets(projectWithActiveRuntime(project));
  const runtimeProject = hydrated.project;
  const resolvedPath = safeProjectPath(runtimeProject);
  const timeoutMs = runtimeProject.timeoutMs ?? 20_000;
  const pathOk = await exists(resolvedPath);
  const credential = credentialCheck(runtimeProject.login, hydrated.loginSecretResolved);
  const apiCredential = apiCredentialCheck(runtimeProject, hydrated.resolvedCredentialIds);
  const [frontend, backend, health, processHealth] = await Promise.all([
    checkUrl(runtimeProject.frontendUrl, Math.min(timeoutMs, 5_000)),
    checkUrl(runtimeProject.backendUrl, Math.min(timeoutMs, 5_000)),
    checkUrl(runtimeProject.healthCheckUrl, Math.min(timeoutMs, 5_000)),
    Promise.all((runtimeProject.processes ?? [])
      .filter((processConfig) => Boolean(processConfig.healthCheckUrl))
      .map(async (processConfig) => {
        const result = await checkUrl(processConfig.healthCheckUrl, Math.min(timeoutMs, 5_000));
        return {
          name: processConfig.name,
          required: processConfig.required ?? true,
          ok: result?.ok ?? false,
          status: result?.status,
          url: result?.url ?? processConfig.healthCheckUrl,
          error: result?.error
        };
      }))
  ]);
  const reason = healthReason({ pathOk, credentialOk: credential.ok && apiCredential.ok, frontend, backend, health, processHealth });
  const ok = reason === "none";
  return {
    projectId: project.id,
    ok,
    status: ok ? "passed" : "failed",
    reason,
    credential,
    apiCredential,
    frontend,
    backend,
    health,
    processHealth,
    checkedAt: now(),
    durationMs: Date.now() - startedAt,
    message: ok ? "Project connection is healthy." : `Project connection failed: ${reason}.`
  };
}

/**
 * A running project is the authoritative source for its allocated endpoints.
 * Discovery may update a workspace command or port after an older registry
 * entry was loaded. Connection checks and diagnostics must not keep probing
 * those stale endpoints while the managed runtime is healthy elsewhere.
 */
export function projectWithActiveRuntime(project: ProjectConfig): ProjectConfig {
  const runtime = runningProjects.get(project.id)?.status;
  if (!runtime || !isActiveRuntimeStatus(runtime.status)) return project;
  const runtimeProcesses = new Map((runtime.processes ?? []).map((item) => [item.name, item]));
  return {
    ...project,
    frontendUrl: runtime.frontendUrl ?? project.frontendUrl,
    backendUrl: runtime.backendUrl ?? project.backendUrl,
    healthCheckUrl: runtime.healthCheckUrl ?? runtime.frontendUrl ?? project.healthCheckUrl,
    processes: project.processes?.map((processConfig) => ({
      ...processConfig,
      healthCheckUrl: runtimeProcesses.get(processConfig.name)?.healthCheckUrl
        ?? (project.processes?.length === 1 ? runtime.processes?.[0]?.healthCheckUrl : undefined)
        ?? processConfig.healthCheckUrl
    }))
  };
}

function portFromUrl(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

function replaceUrlPort(value: string | undefined, hostPort: number) {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.protocol = "http:";
    parsed.hostname = "127.0.0.1";
    parsed.port = String(hostPort);
    return parsed.toString();
  } catch {
    return value;
  }
}

/**
 * OCI targets receive a fresh loopback bridge for every launch. This prevents
 * an unrelated local service on a fixed port from being shown as this run.
 */
async function allocateLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error
        ? reject(error)
        : port
          ? resolve(port)
          : reject(new Error("loopback_port_unavailable")));
    });
  });
}

async function projectWithSandboxRuntimeUrls(project: ProjectConfig) {
  if (project.manifest?.execution.mode !== "oci") {
    return {
      project,
      containerPortFor: (_url?: string) => undefined,
      portBindings: [] as Array<{ hostPort: number; containerPort: number }>
    };
  }
  const hostPorts = new Map<number, number>();
  const bridgeUrl = async (url?: string) => {
    const containerPort = portFromUrl(url);
    if (!url || !containerPort) return url;
    let hostPort = hostPorts.get(containerPort);
    if (!hostPort) {
      hostPort = await allocateLoopbackPort();
      hostPorts.set(containerPort, hostPort);
    }
    return replaceUrlPort(url, hostPort);
  };
  return {
    project: {
      ...project,
      frontendUrl: await bridgeUrl(project.frontendUrl) ?? project.frontendUrl,
      backendUrl: await bridgeUrl(project.backendUrl) ?? project.backendUrl,
      healthCheckUrl: await bridgeUrl(project.healthCheckUrl) ?? project.healthCheckUrl,
      processes: project.processes
        ? await Promise.all(project.processes.map(async (processConfig) => ({
          ...processConfig,
          healthCheckUrl: await bridgeUrl(processConfig.healthCheckUrl)
        })))
        : project.processes
    },
    containerPortFor: (url?: string) => portFromUrl(url),
    portBindings: [...hostPorts.entries()].map(([containerPort, hostPort]) => ({ hostPort, containerPort }))
  };
}

async function captureProcessOutput(executable: string, args: string[], timeoutMs = 5_000, maxBytes = 512 * 1024) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-maxBytes);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: null, stdout, stderr });
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function inspectManagedContainerFailure(running: RunningProject | undefined): Promise<ProjectRuntimeFailureReason | undefined> {
  for (const container of running?.ociContainers ?? []) {
    const result = await captureProcessOutput(container.engine, [
      "inspect",
      "--format", "{{.State.Status}}|{{.State.OOMKilled}}",
      container.containerName
    ]);
    if (result.exitCode !== 0) return "early_exit";
    const [state, oomKilled] = result.stdout.trim().split("|");
    if (oomKilled === "true") return "budget_exceeded";
    if (state !== "running") return "early_exit";
  }
  return undefined;
}

async function containerEngineIsReady(engine: "docker" | "podman") {
  const result = await captureProcessOutput(engine, ["info"], 5_000, 64 * 1024);
  return result.exitCode === 0;
}

async function ensureContainerEngineReady(project: ProjectConfig): Promise<ProjectRuntimeStatus | undefined> {
  if (project.manifest?.execution.mode !== "oci") return undefined;
  const engine = project.manifest.execution.engine;
  if (await containerEngineIsReady(engine)) return undefined;

  const autoStartEnabled = process.env.CONTAINER_RUNTIME_AUTOSTART !== "0";
  const canLaunchDockerDesktop = autoStartEnabled && process.platform === "darwin" && engine === "docker";
  if (!canLaunchDockerDesktop) {
    return {
      projectId: project.id,
      status: "failed",
      phase: "failed",
      updatedAt: now(),
      stoppedAt: now(),
      failureReason: "container_runtime_unavailable",
      message: `${engine} is installed but its daemon is unavailable. Automatic desktop startup is not supported in this environment.`
    };
  }

  const appCheck = await captureProcessOutput("open", ["-Ra", "Docker"], 5_000, 16 * 1024);
  if (appCheck.exitCode !== 0) {
    return {
      projectId: project.id,
      status: "failed",
      phase: "failed",
      updatedAt: now(),
      stoppedAt: now(),
      failureReason: "container_runtime_unavailable",
      message: "Docker Desktop is not installed or cannot be located in /Applications."
    };
  }

  const timeoutMs = Math.min(
    Math.max(project.manifest.budget.prepareTimeoutMs ?? 120_000, 60_000),
    180_000
  );
  const starting: ProjectRuntimeStatus = {
    projectId: project.id,
    status: "starting",
    ...runtimeTiming(timeoutMs, "starting_processes"),
    frontendUrl: project.frontendUrl,
    backendUrl: project.backendUrl,
    healthCheckUrl: project.healthCheckUrl,
    message: "正在自动启动 Docker Desktop，并等待安全沙盒服务就绪。"
  };
  runningProjects.set(project.id, { status: starting });

  const launched = await captureProcessOutput("open", ["-gj", "-a", "Docker"], 10_000, 16 * 1024);
  if (launched.exitCode !== 0) {
    const failed: ProjectRuntimeStatus = {
      ...starting,
      status: "failed",
      phase: "failed",
      remainingMs: 0,
      updatedAt: now(),
      stoppedAt: now(),
      failureReason: "container_runtime_unavailable",
      message: `Docker Desktop could not be started automatically: ${redactText(launched.stderr || launched.stdout || "open command failed")}.`
    };
    runningProjects.set(project.id, { status: failed });
    return failed;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await containerEngineIsReady(engine)) {
      runningProjects.delete(project.id);
      return undefined;
    }
    const current = runningProjects.get(project.id);
    if (!current || current.status.status === "stopped") {
      return {
        projectId: project.id,
        status: "failed",
        phase: "failed",
        remainingMs: 0,
        updatedAt: now(),
        stoppedAt: now(),
        failureReason: "cancelled",
        message: "Docker Desktop startup was cancelled."
      };
    }
    current.status = {
      ...current.status,
      elapsedMs: Date.now() - startedAt,
      remainingMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
      progressPercent: Math.min(90, Math.max(5, Math.round(((Date.now() - startedAt) / timeoutMs) * 100))),
      updatedAt: now()
    };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const failed: ProjectRuntimeStatus = {
    ...starting,
    status: "failed",
    phase: "failed",
    remainingMs: 0,
    updatedAt: now(),
    stoppedAt: now(),
    failureReason: "container_runtime_unavailable",
    message: `Docker Desktop was opened, but the Docker daemon did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`
  };
  runningProjects.set(project.id, { status: failed });
  return failed;
}

function projectWithPortMappings(project: ProjectConfig, mappings: Map<number, number>) {
  const mapUrl = (url?: string) => {
    const containerPort = portFromUrl(url);
    const hostPort = containerPort ? mappings.get(containerPort) : undefined;
    return hostPort ? replaceUrlPort(url, hostPort) : url;
  };
  return {
    ...project,
    frontendUrl: mapUrl(project.frontendUrl) ?? project.frontendUrl,
    backendUrl: mapUrl(project.backendUrl) ?? project.backendUrl,
    healthCheckUrl: mapUrl(project.healthCheckUrl) ?? project.healthCheckUrl,
    processes: project.processes?.map((processConfig) => ({
      ...processConfig,
      healthCheckUrl: mapUrl(processConfig.healthCheckUrl)
    }))
  };
}

async function inspectRunningSandbox(project: ProjectConfig) {
  if (project.manifest?.execution.mode !== "oci") return undefined;
  const engine = project.manifest.execution.engine;
  const prefix = `ato-${project.manifest.projectId}-`;
  const listed = await captureProcessOutput(engine, [
    "ps",
    "--filter", `name=${prefix}`,
    "--format", "{{.Names}}"
  ]);
  if (listed.exitCode !== 0) return undefined;
  const names = listed.stdout
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter((name) => name.startsWith(prefix));
  for (const containerName of names) {
    const stateResult = await captureProcessOutput(engine, [
      "inspect",
      "--format", "{{.State.Status}}|{{.State.OOMKilled}}",
      containerName
    ]);
    const [containerState, oomKilled] = stateResult.stdout.trim().split("|");
    if (stateResult.exitCode !== 0 || containerState !== "running" || oomKilled === "true") {
      // An OOM may kill only esbuild while leaving Vite and its HTTP port
      // alive. That container is poisoned even though a shallow GET succeeds.
      await captureProcessOutput(engine, ["rm", "-f", containerName], 15_000, 64 * 1024);
      continue;
    }
    const ports = await captureProcessOutput(engine, ["port", containerName]);
    if (ports.exitCode !== 0) continue;
    const mappings = new Map<number, number>();
    for (const line of ports.stdout.split(/\r?\n/)) {
      const match = line.match(/^(\d+)\/tcp\s+->\s+(?:127\.0\.0\.1|\[::1\]):(\d+)$/);
      if (match) mappings.set(Number(match[1]), Number(match[2]));
    }
    const runtimeProject = projectWithPortMappings(project, mappings);
    const logResult = await captureProcessOutput(engine, ["logs", "--tail", "40", containerName]);
    const health = await testProjectConnection(runtimeProject);
    const installing = !health.ok && (
      Boolean(project.installCommandSpec ?? project.manifest.commands.install)
      || /Progress:\s+resolved|Corepack is about to download|postinstall/i.test(`${logResult.stdout}\n${logResult.stderr}`)
    );
    const timestamp = now();
    const timeoutMs = (installing
      ? Math.max(project.manifest.budget.prepareTimeoutMs ?? 300_000, 900_000)
      : project.manifest.budget.prepareTimeoutMs ?? 300_000) + (project.timeoutMs ?? 20_000);
    const status: ProjectRuntimeStatus = {
      projectId: project.id,
      status: health.ok ? "running" : installing ? "installing" : "starting",
      phase: health.ok ? "ready" : installing ? "installing_dependencies" : "waiting_for_health",
      phaseStartedAt: timestamp,
      deadlineAt: new Date(Date.parse(timestamp) + timeoutMs).toISOString(),
      elapsedMs: 0,
      remainingMs: health.ok ? 0 : timeoutMs,
      progressPercent: health.ok ? 100 : 5,
      updatedAt: timestamp,
      startedAt: timestamp,
      frontendUrl: runtimeProject.frontendUrl,
      backendUrl: runtimeProject.backendUrl,
      healthCheckUrl: runtimeProject.healthCheckUrl,
      processes: (runtimeProject.processes ?? []).map((processConfig) => ({
        name: processConfig.name,
        status: health.ok ? "running" : "starting",
        healthCheckUrl: processConfig.healthCheckUrl,
        required: processConfig.required ?? true,
        failureReason: health.ok ? "none" : undefined,
        message: health.ok ? "Recovered sandbox process is healthy." : "Recovered sandbox process is still preparing."
      })),
      failureReason: health.ok ? "none" : undefined,
      message: health.ok
        ? "Recovered the existing sandbox after the Agent restarted."
        : "Recovered the existing sandbox; waiting for dependency installation and health checks."
    };
    return {
      runtimeProject,
      running: {
        ociContainers: [{ engine, containerName }],
        status
      } satisfies RunningProject
    };
  }
  return undefined;
}

function monitorRecoveredSandbox(projectId: string, runtimeProject: ProjectConfig) {
  if (recoveredSandboxMonitors.has(projectId)) return;
  recoveredSandboxMonitors.add(projectId);
  void (async () => {
    try {
      while (true) {
        const running = runningProjects.get(projectId);
        if (!running || !["installing", "starting"].includes(running.status.status)) return;
        const health = await testProjectConnection(runtimeProject);
        if (health.ok) {
          running.status = {
            ...running.status,
            status: "running",
            phase: "ready",
            progressPercent: 100,
            remainingMs: 0,
            updatedAt: now(),
            failureReason: "none",
            message: "Recovered sandbox is healthy and ready for the embedded browser."
          };
          return;
        }
        const deadline = running.status.deadlineAt ? Date.parse(running.status.deadlineAt) : Date.now();
        if (Date.now() >= deadline) {
          running.status = {
            ...running.status,
            status: "failed",
            phase: "failed",
            remainingMs: 0,
            updatedAt: now(),
            stoppedAt: now(),
            failureReason: "health_timeout",
            message: "Recovered sandbox did not become healthy before its startup deadline."
          };
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } finally {
      recoveredSandboxMonitors.delete(projectId);
    }
  })();
}

function spawnManagedProcess(input: {
  project: ProjectConfig;
  cwd: string;
  command: string | CommandSpec;
  healthCheckUrl?: string;
  containerPort?: number;
  portBindings?: Array<{ hostPort: number; containerPort: number }>;
  dependencyCache?: Awaited<ReturnType<typeof prepareSandboxDependencyCache>>;
}) {
  const isLegacy = typeof input.command === "string";
  if (isLegacy && process.env.NODE_ENV === "production" && process.env.ALLOW_LEGACY_SHELL_COMMANDS !== "1") {
    throw new Error("legacy_shell_command_forbidden");
  }
  const useOci = input.project.manifest?.execution.mode === "oci";
  if (useOci && typeof input.command === "string") throw new Error("oci_structured_command_required");
  const child = useOci
    ? (() => {
      const execution = input.project.manifest!.execution;
      const hostPort = portFromUrl(input.healthCheckUrl);
      const containerPort = input.containerPort ?? hostPort;
      const invocation = buildOciInvocation({
        engine: execution.engine,
        image: execution.image!,
        manifest: input.project.manifest!,
        repositoryRoot: input.cwd,
        command: commandSpecSchema.parse(input.command),
        prepareCommand: input.project.installCommandSpec,
        dependencyCache: input.dependencyCache,
        portBindings: input.portBindings?.length
          ? input.portBindings
          : hostPort && containerPort
            ? [{ hostPort, containerPort }]
            : []
      });
      const spawned = spawn(invocation.executable, invocation.args, {
        cwd: input.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: commandEnv(input.project)
      });
      ociProcesses.set(spawned, { engine: execution.engine, containerName: invocation.containerName });
      return spawned;
    })()
    : typeof input.command === "string"
    ? spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: commandEnv(input.project)
    })
    : (() => {
      const command = commandSpecSchema.parse(input.command);
      if (input.project.manifest && !input.project.manifest.commandAllowlist.includes(command.executable)) {
        throw new Error(`command_not_allowed:${command.executable}`);
      }
      return spawn(command.executable, command.args, {
        cwd: input.cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: commandEnv(input.project)
      });
    })();
  const logs = { stdout: "", stderr: "" };
  const sensitiveEnvNames = new Set([
    ...(input.project.apiCredentialRequirements ?? []).map((item) => item.envName),
    input.project.login?.passwordEnv
  ].filter((value): value is string => Boolean(value)));
  const secretValues = Object.entries(input.project.env ?? {})
    .filter(([name, value]) => sensitiveEnvNames.has(name) && value.length >= 6 && value !== "[REDACTED]")
    .map(([, value]) => value);
  const append = (current: string, chunk: unknown) => {
    let safe = redactText(`${current}${String(chunk)}`);
    for (const secret of secretValues) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe.slice(-50 * 1024 * 1024);
  };
  child.stdout?.on("data", (chunk) => { logs.stdout = append(logs.stdout, chunk); });
  child.stderr?.on("data", (chunk) => { logs.stderr = append(logs.stderr, chunk); });
  processLogs.set(child, logs);
  child.unref();
  return child;
}

function commandEnv(project: ProjectConfig) {
  const projectEnv = Object.fromEntries(
    Object.entries(project.env ?? {}).filter(([, value]) => value !== "[REDACTED]")
  );
  return {
    ...process.env,
    ...projectEnv,
    // The Workbench is the only visual surface for a managed target. This
    // policy deliberately overrides project-level BROWSER/CI values so a
    // checked-out Vite/CRA config cannot take over the user's desktop.
    BROWSER: "none",
    CI: "1",
    AI_TEST_OFFICER_NO_DESKTOP_BROWSER: "1"
  };
}

function detectedLocalServerUrl(projectId?: string) {
  if (!projectId) return undefined;
  const running = runningProjects.get(projectId);
  const output = running?.processes
    ?.map((item) => processLogs.get(item.process)?.stdout ?? "")
    .join("\n") ?? "";
  const candidates = [...output.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+/gi)].map((match) => match[0]);
  return candidates.at(-1)?.replace("localhost", "127.0.0.1");
}

async function waitForHealthy(project: ProjectConfig, projectId?: string) {
  const timeoutMs = project.manifest?.execution.mode === "oci"
    ? (project.manifest.budget.prepareTimeoutMs ?? 300_000) + (project.timeoutMs ?? 20_000)
    : project.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await testProjectConnection(project);
    if (result.ok) return result;
    const detectedRuntimeUrl = project.manifest?.execution.mode === "oci"
      ? undefined
      : detectedLocalServerUrl(projectId);
    if (detectedRuntimeUrl && !project.backendUrl && detectedRuntimeUrl !== project.frontendUrl) {
      const detectedProject: ProjectConfig = {
        ...project,
        frontendUrl: detectedRuntimeUrl,
        healthCheckUrl: detectedRuntimeUrl,
        processes: project.processes?.map((item) => ({ ...item, healthCheckUrl: detectedRuntimeUrl }))
      };
      const detectedResult = await testProjectConnection(detectedProject);
      if (detectedResult.ok) return Object.assign(detectedResult, { detectedRuntimeUrl });
    }
    if (projectId && runningProjects.get(projectId)?.status.status === "failed") return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return testProjectConnection(project);
}

async function runManagedCommand(input: {
  projectId: string;
  project: ProjectConfig;
  command: string;
  commandSpec?: CommandSpec;
  cwd: string;
  timeoutMs: number;
  status?: ProjectRuntimeStatus;
}) {
  const child = spawnManagedProcess({ project: input.project, cwd: input.cwd, command: input.commandSpec ?? input.command });
  if (input.status) {
    runningProjects.set(input.projectId, { process: child, status: { ...input.status, pid: child.pid } });
  }
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(async () => {
      timedOut = true;
      await terminateProcessTree(child);
      resolve(null);
    }, input.timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const current = runningProjects.get(input.projectId);
  if (current?.process === child) {
    runningProjects.delete(input.projectId);
  }
  const logs = processLogs.get(child);
  const failureReason = exitCode === 0
    ? "none" as const
    : timedOut
      ? "budget_exceeded" as const
      : classifyRuntimeFailure(`exit code ${exitCode ?? "unknown"}`, logs?.stderr);
  return {
    ok: exitCode === 0,
    failureReason,
    stderr: logs?.stderr ?? "",
    stdout: logs?.stdout ?? ""
  };
}

async function terminateProcessTree(child: ChildProcess) {
  const oci = ociProcesses.get(child);
  if (oci) {
    await new Promise<void>((resolve) => {
      const remover = spawn(oci.engine, ["rm", "--force", oci.containerName], { stdio: "ignore" });
      remover.once("exit", () => resolve());
      remover.once("error", () => resolve());
    });
  }
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 650));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group exited after SIGTERM.
  }
}

async function terminateRunningProject(running: RunningProject) {
  const processes = [
    running.process,
    ...(running.processes?.map((item) => item.process) ?? [])
  ].filter((item): item is ChildProcess => Boolean(item));
  await Promise.all(processes.map((child) => terminateProcessTree(child)));
  const processContainers = processes
    .map((child) => ociProcesses.get(child))
    .filter((item): item is OciContainerRef => Boolean(item));
  const containers = [...(running.ociContainers ?? []), ...processContainers]
    .filter((item, index, all) => all.findIndex((candidate) =>
      candidate.engine === item.engine && candidate.containerName === item.containerName) === index);
  await Promise.all(containers.map(({ engine, containerName }) =>
    captureProcessOutput(engine, ["rm", "--force", containerName], 15_000)));
}

function projectProcesses(project: ProjectConfig): ProjectProcessConfig[] {
  if (project.processes?.length) return project.processes;
  return project.startCommandSpec || project.startCommand?.trim()
    ? [{ name: "main", command: project.startCommand ?? "", commandSpec: project.startCommandSpec, healthCheckUrl: project.healthCheckUrl, required: true }]
    : [];
}

function commandTimeoutMs(project: ProjectConfig, command: "install" | "start") {
  const spec = command === "install"
    ? project.installCommandSpec ?? project.manifest?.commands.install
    : project.startCommandSpec ?? project.manifest?.commands.start;
  return spec?.timeoutMs
    ?? (command === "install" && project.installCommand?.trim() === "npm ci"
      ? Math.max(project.timeoutMs ?? 20_000, 120_000)
      : project.timeoutMs ?? 20_000);
}

function buildProcessStatuses(processes: RunningProcess[], status: "starting" | "running" | "stopped" | "failed", reason?: ProjectRuntimeFailureReason) {
  return processes.map((item) => ({
    name: item.config.name,
    pid: item.process.pid,
    status,
    healthCheckUrl: item.config.healthCheckUrl,
    required: item.config.required ?? true,
    failureReason: reason,
    message: status === "running"
      ? "Process health check passed."
      : status === "failed"
        ? `Process failed: ${reason ?? "unknown"}.`
        : `Process is ${status}.`
  }));
}

async function startProjectOnce(id: string): Promise<ProjectRuntimeStatus> {
  const storedProject = await getProject(id);
  if (!storedProject) {
    return { projectId: id, status: "failed", failureReason: "config_missing", message: "Project config not found." };
  }
  const hydrated = await withProjectSecrets(storedProject);
  const project = hydrated.project;
  if (
    process.env.NODE_ENV !== "test"
    && project.allowExternalProjectPath
    && project.manifest?.execution.mode !== "oci"
  ) {
    return {
      projectId: id,
      status: "failed",
      phase: "failed",
      updatedAt: now(),
      stoppedAt: now(),
      failureReason: "permission_denied",
      message: "External projects must run in the OCI sandbox. Re-detect and save the project manifest before starting."
    };
  }
  if (process.env.NODE_ENV !== "test" && project.allowExternalProjectPath && !project.manifest) {
    return {
      projectId: id,
      status: "failed",
      phase: "failed",
      updatedAt: now(),
      stoppedAt: now(),
      failureReason: "permission_denied",
      message: "External projects require a detected OCI project manifest before starting."
    };
  }
  if (process.env.NODE_ENV === "production" && !project.manifest) {
    return { projectId: id, status: "failed", failureReason: "permission_denied", message: "Production execution requires a versioned project manifest and defaults to OCI isolation." };
  }
  const existing = runningProjects.get(id);
  if (existing) {
    // A locally adopted process is not owned by the Agent and may disappear
    // after it was first observed. Do not keep returning a cached "running"
    // status: re-check the actual endpoint before allowing a browser run to
    // rely on it. Installing/starting processes are still in flight and must
    // remain single-flight to prevent a duplicate launch.
    if (
      existing.status.status !== "running"
      && isActiveRuntimeStatus(existing.status.status)
      && (existing.process || (existing.processes?.length ?? 0) > 0 || (existing.ociContainers?.length ?? 0) > 0)
    ) return existing.status;
    if (existing.status.status === "running") {
      const containerFailure = await inspectManagedContainerFailure(existing);
      if (!containerFailure) {
        const activeHealth = await testProjectConnection(projectWithActiveRuntime(project));
        if (activeHealth.ok) return existing.status;
      }
    }
    runningProjects.delete(id);
  }
  const cwd = safeProjectPath(project);
  if (!(await exists(cwd))) {
    return { projectId: id, status: "failed", failureReason: "project_path_missing", message: `Project path not found: ${project.projectPath}` };
  }
  const credential = credentialCheck(project.login, hydrated.loginSecretResolved);
  const apiCredential = apiCredentialCheck(project, hydrated.resolvedCredentialIds);
  if (!credential.ok || !apiCredential.ok) {
    return {
      projectId: id,
      status: "failed",
      failureReason: "credential_missing",
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      healthCheckUrl: project.healthCheckUrl,
      message: `Project credential is missing: ${[...credential.missingEnv, ...apiCredential.missingEnv].join(", ")}.`
    };
  }
  const containerRuntimeFailure = await ensureContainerEngineReady(project);
  if (containerRuntimeFailure) return containerRuntimeFailure;
  const recoveredSandbox = await inspectRunningSandbox(project);
  if (recoveredSandbox) {
    runningProjects.set(id, recoveredSandbox.running);
    if (recoveredSandbox.running.status.status !== "running") {
      monitorRecoveredSandbox(id, recoveredSandbox.runtimeProject);
    }
    return recoveredSandbox.running.status;
  }
  const sandboxRuntime = await projectWithSandboxRuntimeUrls(project);
  const dependencyCache = await prepareSandboxDependencyCache(project, cwd);
  let runtimeProject = sandboxRuntime.project;
  if (dependencyCache && !dependencyCache.prepared && runtimeProject.manifest) {
    runtimeProject = {
      ...runtimeProject,
      manifest: {
        ...runtimeProject.manifest,
        budget: {
          ...runtimeProject.manifest.budget,
          // A cold dependency snapshot is a one-time environment preparation
          // step. Large monorepos must not be killed by the normal warm-start
          // deadline before their reusable cache has been created.
          prepareTimeoutMs: Math.max(runtimeProject.manifest.budget.prepareTimeoutMs ?? 300_000, 900_000)
        }
      }
    };
  }
  // The Agent process may restart while a trusted local dev server remains
  // healthy. Re-adopt its observable state instead of spawning a duplicate
  // process that immediately fails on the same port. We intentionally do not
  // assign a PID: an unowned process must never be terminated by the Agent.
  if (project.allowExternalProjectPath && project.manifest?.execution.mode !== "oci") {
    const existingHealth = await testProjectConnection(project);
    if (existingHealth.ok) {
      const adopted: ProjectRuntimeStatus = {
        projectId: id,
        status: "running",
        phase: "ready",
        progressPercent: 100,
        updatedAt: now(),
        startedAt: now(),
        frontendUrl: project.frontendUrl,
        backendUrl: project.backendUrl,
        healthCheckUrl: project.healthCheckUrl,
        message: "Project is already healthy; adopted the existing local service without starting a duplicate.",
        failureReason: "none"
      };
      runningProjects.set(id, { status: adopted });
      return adopted;
    }
  }
  const configuredProcesses = projectProcesses(project);
  const runtimeProcesses = projectProcesses(runtimeProject);
  if (!configuredProcesses.length) {
    const health = await testProjectConnection(runtimeProject);
    return {
      projectId: id,
      status: health.ok ? "running" : "failed",
      frontendUrl: runtimeProject.frontendUrl,
      backendUrl: runtimeProject.backendUrl,
      healthCheckUrl: runtimeProject.healthCheckUrl,
      failureReason: health.ok ? "none" : health.reason,
      message: health.message
    };
  }
  if (
    project.manifest?.execution.mode !== "oci"
    && (project.installCommandSpec || project.installCommand?.trim())
    && await needsDependencyInstall(project, cwd)
  ) {
    const installTimeoutMs = commandTimeoutMs(project, "install");
    const installing: ProjectRuntimeStatus = {
      projectId: id,
      status: "installing",
      startedAt: now(),
      ...runtimeTiming(
        installTimeoutMs,
        "installing_dependencies"
      ),
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      healthCheckUrl: project.healthCheckUrl,
      message: "Project install command is running."
    };
    const installResult = await runManagedCommand({
      projectId: id,
      project,
      command: project.installCommand ?? "",
      commandSpec: project.installCommandSpec,
      cwd,
      timeoutMs: installTimeoutMs,
      status: installing
    });
    if (!installResult.ok) {
      const failed: ProjectRuntimeStatus = {
        ...installing,
        status: "failed",
        phase: "failed",
        progressPercent: undefined,
        remainingMs: 0,
        updatedAt: now(),
        stoppedAt: now(),
        failureReason: installResult.failureReason === "budget_exceeded" ? "budget_exceeded" : "install_failed",
        message: `Project dependency installation failed: ${installResult.failureReason}.${installResult.stderr ? ` stderr=${installResult.stderr.slice(-2_000)}` : installResult.stdout ? ` output=${installResult.stdout.slice(-2_000)}` : " No actionable installer output was captured."}`
      };
      runningProjects.set(id, { status: failed });
      return failed;
    }
  }
  const processes = configuredProcesses.map((processConfig, index) => {
    const runtimeProcess = runtimeProcesses[index] ?? processConfig;
    return {
      config: runtimeProcess,
      process: spawnManagedProcess({
        project: runtimeProject,
        cwd,
        command: runtimeProcess.commandSpec ?? runtimeProcess.command,
        healthCheckUrl: runtimeProcess.healthCheckUrl,
        containerPort: sandboxRuntime.containerPortFor(processConfig.healthCheckUrl ?? project.healthCheckUrl),
        // A single workspace command commonly starts several services (for
        // example Vite on 8080 and an API on 3000). Publish every discovered
        // endpoint from that one container; otherwise the UI becomes reachable
        // while the required backend health check waits forever.
        portBindings: configuredProcesses.length === 1 ? sandboxRuntime.portBindings : undefined,
        dependencyCache
      })
    };
  });
  const status: ProjectRuntimeStatus = {
    projectId: id,
    status: "starting",
    ...runtimeTiming(
      runtimeProject.manifest?.execution.mode === "oci"
        ? (runtimeProject.manifest.budget.prepareTimeoutMs ?? 300_000) + (runtimeProject.timeoutMs ?? 20_000)
        : runtimeProject.timeoutMs ?? 20_000,
      "waiting_for_health"
    ),
    pid: processes[0]?.process.pid,
    processes: buildProcessStatuses(processes, "starting"),
    startedAt: now(),
    frontendUrl: runtimeProject.frontendUrl,
    backendUrl: runtimeProject.backendUrl,
    healthCheckUrl: runtimeProject.healthCheckUrl,
    message: runtimeProject.manifest?.execution.mode === "oci"
      ? dependencyCache?.prepared
        ? "Sandbox dependency cache matched; starting the project."
        : "Sandbox is creating a reusable dependency cache and waiting for the project health check."
      : "Project process started; waiting for health check."
  };
  const spawnedOciContainers = processes
    .map((managed) => ociProcesses.get(managed.process))
    .filter((item): item is OciContainerRef => Boolean(item));
  runningProjects.set(id, {
    process: processes[0]?.process,
    processes,
    ociContainers: spawnedOciContainers,
    status
  });
  const ownsProcess = (running: RunningProject, process: ChildProcess) =>
    running.process === process || running.processes?.some((item) => item.process === process) === true;
  for (const managed of processes) {
    managed.process.once("error", (error) => {
      const current = runningProjects.get(id);
      // A late event from a superseded launch must never overwrite the state
      // of a newer process or an adopted healthy runtime.
      if (!current || !ownsProcess(current, managed.process)) return;
      const reason = classifyRuntimeFailure(error, processLogs.get(managed.process)?.stderr);
      current.status = {
        ...current.status,
        status: "failed",
        phase: "failed",
        remainingMs: 0,
        updatedAt: now(),
        stoppedAt: now(),
        failureReason: reason,
        message: `Project process ${managed.config.name} failed to start: ${reason}.`
      };
    });
    managed.process.once("exit", (code) => {
      const current = runningProjects.get(id);
      if (!current || !ownsProcess(current, managed.process) || current.status.status === "stopped") return;
      const required = managed.config.required ?? true;
      if (!required && code === 0) return;
      const logs = processLogs.get(managed.process);
      const classified = code === 0 ? "none" : classifyRuntimeFailure(`exit code ${code}`, logs?.stderr);
      const reason = classified === "unknown" ? "early_exit" : classified;
      current.status = {
        ...current.status,
        status: code === 0 ? "stopped" : "failed",
        phase: code === 0 ? "idle" : "failed",
        remainingMs: 0,
        updatedAt: now(),
        stoppedAt: now(),
        failureReason: reason,
        message: `Project process ${managed.config.name} exited with code ${code ?? "unknown"}.${logs?.stderr ? ` stderr=${logs.stderr.slice(-2000)}` : ""}`
      };
    });
  }
  const health = await waitForHealthy(runtimeProject, id);
  const processFailure = runningProjects.get(id)?.status;
  if (processFailure?.status === "failed") {
    await terminateRunningProject({ processes, status: processFailure });
    const retainedFailure = {
      ...processFailure,
      processes: buildProcessStatuses(processes, "failed", processFailure.failureReason)
    };
    runningProjects.set(id, { status: retainedFailure });
    return retainedFailure;
  }
  const failureStderr = processes
    .map((managed) => processLogs.get(managed.process)?.stderr ?? "")
    .filter(Boolean)
    .join("\n")
    .slice(-2_000);
  const healthFailureReason = health.ok
    ? "none"
    : (() => {
      const classified = classifyRuntimeFailure("health check failed", failureStderr);
      return classified === "unknown" ? health.reason : classified;
    })();
  const detectedRuntimeUrl = "detectedRuntimeUrl" in health && typeof health.detectedRuntimeUrl === "string"
    ? health.detectedRuntimeUrl
    : undefined;
  const updated: ProjectRuntimeStatus = {
    ...status,
    status: health.ok ? "running" : "failed",
    phase: health.ok ? "ready" : "failed",
    remainingMs: 0,
    progressPercent: health.ok ? 100 : undefined,
    updatedAt: now(),
    frontendUrl: detectedRuntimeUrl ?? runtimeProject.frontendUrl,
    backendUrl: runtimeProject.backendUrl,
    healthCheckUrl: detectedRuntimeUrl ?? runtimeProject.healthCheckUrl,
    processes: buildProcessStatuses(processes, health.ok ? "running" : "failed", healthFailureReason),
    failureReason: healthFailureReason,
    message: health.ok
      ? health.message
      : `Project failed to become healthy: ${healthFailureReason}.${failureStderr ? ` stderr=${failureStderr}` : ""}`
  };
  runningProjects.set(id, {
    process: processes[0]?.process,
    processes,
    ociContainers: spawnedOciContainers,
    status: updated
  });
  if (!health.ok) {
    await terminateRunningProject({ processes, status: updated });
    runningProjects.set(id, { status: updated });
  }
  return updated;
}

export function startProject(id: string): Promise<ProjectRuntimeStatus> {
  const current = projectStartPromises.get(id);
  if (current) return current;
  const task = startProjectOnce(id).finally(() => {
    if (projectStartPromises.get(id) === task) projectStartPromises.delete(id);
  });
  projectStartPromises.set(id, task);
  return task;
}

export async function stopProject(id: string): Promise<ProjectRuntimeStatus> {
  const project = await getProject(id);
  let running = runningProjects.get(id);
  // Agent hot reloads and service restarts clear the in-memory map while the
  // managed OCI container intentionally keeps running. Stop must discover and
  // remove that container directly instead of returning a false "stopped".
  if (!running && project?.manifest?.execution.mode === "oci") {
    const recovered = await inspectRunningSandbox(project);
    running = recovered?.running;
    if (running) runningProjects.set(id, running);
  }
  if (!running) {
    return { projectId: id, status: "stopped", stoppedAt: now(), message: "Project was not running." };
  }
  if (!isActiveRuntimeStatus(running.status.status)) {
    runningProjects.delete(id);
    return {
      ...running.status,
      status: "stopped",
      phase: "idle",
      remainingMs: 0,
      updatedAt: now(),
      stoppedAt: running.status.stoppedAt ?? now(),
      message: "Project was already stopped."
    };
  }
  await terminateRunningProject(running);
  runningProjects.delete(id);
  if (project?.cleanupCommandSpec || project?.cleanupCommand?.trim()) {
    const cleanupResult = await runManagedCommand({
      projectId: id,
      project,
      command: project.cleanupCommand ?? "",
      commandSpec: project.cleanupCommandSpec,
      cwd: safeProjectPath(project),
      timeoutMs: project.timeoutMs ?? 20_000
    });
    if (!cleanupResult.ok) {
      return {
        ...running.status,
        status: "failed",
        phase: "failed",
        remainingMs: 0,
        updatedAt: now(),
        stoppedAt: now(),
        failureReason: "cleanup_failed",
        message: "Project stopped, but cleanup command failed or timed out."
      };
    }
  }
  return {
    ...running.status,
    status: "stopped",
    phase: "idle",
    remainingMs: 0,
    progressPercent: 0,
    updatedAt: now(),
    processes: running.status.processes?.map((item) => ({
      ...item,
      status: "stopped",
      message: "Process stopped."
    })),
    stoppedAt: now(),
    message: "Project stopped."
  };
}

export async function resolveProjectTarget(input: {
  projectId?: string;
  appUrl?: string;
  target?: TargetAppRuntime;
  /**
   * A benchmark owns its fixture service group and passes a freshly allocated
   * URL.  It must not be replaced by a persisted developer/runtime endpoint
   * (which can point at a stale fixed port).  Interactive OCI projects keep
   * their managed-runtime precedence by leaving this false.
   */
  preferAppUrl?: boolean;
}) {
  if (input.preferAppUrl && input.appUrl) {
    return {
      projectId: input.projectId,
      frontendUrl: input.appUrl,
      backendUrl: input.appUrl,
      healthCheckUrl: input.appUrl
    };
  }
  if (input.projectId) {
    const project = await getProject(input.projectId);
    if (project) {
      if (project.manifest?.execution.mode === "oci" && !runningProjects.has(project.id)) {
        const recovered = await inspectRunningSandbox(project);
        if (recovered) {
          runningProjects.set(project.id, recovered.running);
          if (recovered.running.status.status !== "running") {
            monitorRecoveredSandbox(project.id, recovered.runtimeProject);
          }
        }
      }
      // A managed runtime owns its externally reachable endpoint. The URL
      // supplied by a client or persisted plan may still contain the container
      // port (for example 8080) while OCI has published it on an ephemeral host
      // port. Never let that stale value override the active runtime mapping.
      const activeProject = projectWithActiveRuntime(project);
      return {
        projectId: activeProject.id,
        frontendUrl: activeProject.frontendUrl,
        backendUrl: activeProject.backendUrl,
        healthCheckUrl: activeProject.healthCheckUrl
      };
    }
  }
  if (input.target) return input.target;
  return {
    frontendUrl: input.appUrl ?? "http://localhost:6173"
  };
}
