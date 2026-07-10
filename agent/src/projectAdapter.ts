import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectConfig,
  ProjectHealthCheckResult,
  ProjectLoginConfig,
  ProjectProcessConfig,
  ProjectRuntimeFailureReason,
  ProjectRuntimeStatus,
  TargetAppRuntime
} from "./types.js";
import { redactRecord } from "./redaction.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const projectDir = path.join(rootDir, "data", "projects");
type RunningProcess = { config: ProjectProcessConfig; process: ChildProcess };
type RunningProject = { process?: ChildProcess; processes?: RunningProcess[]; status: ProjectRuntimeStatus };
const runningProjects = new Map<string, RunningProject>();
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

function projectFile(id: string) {
  return path.join(projectDir, `${id}.json`);
}

function normalizeProjectConfig(input: ProjectConfig): ProjectConfig {
  const timestamp = now();
  return {
    ...input,
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
    startCommand: "npm run dev",
    healthCheckUrl: "http://127.0.0.1:6173",
    frontendUrl: "http://localhost:6173",
    backendUrl: "http://127.0.0.1:6172/api/health",
    login: { method: "none" },
    env: {
      VITE_TASK_FILTER_FIXTURE_BUG: "1",
      VITE_APP_API_URL: "http://localhost:6172"
    },
    cleanupCommand: "",
    timeoutMs: 25_000,
    createdAt: timestamp,
    updatedAt: timestamp
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
  const files = (await readdir(projectDir)).filter((file) => file.endsWith(".json")).sort();
  const projects: ProjectConfig[] = [];
  for (const file of files) {
    try {
      projects.push(normalizeProjectConfig(JSON.parse(await readFile(path.join(projectDir, file), "utf8")) as ProjectConfig));
    } catch {
      // Invalid project configs are surfaced through test-connection when edited.
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
  return runningProjects.get(id)?.status ?? {
    projectId: id,
    status: "idle",
    message: "Project is not running."
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

function credentialCheck(login: ProjectLoginConfig | undefined): ProjectHealthCheckResult["credential"] {
  if (!login || login.method === "none") {
    return { ok: true, method: "none", missingEnv: [] };
  }
  if (login.credentialId?.trim()) {
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

export async function testProjectConnection(project: ProjectConfig): Promise<ProjectHealthCheckResult> {
  const startedAt = Date.now();
  const resolvedPath = safeProjectPath(project);
  const timeoutMs = project.timeoutMs ?? 20_000;
  const pathOk = await exists(resolvedPath);
  const credential = credentialCheck(project.login);
  const [frontend, backend, health, processHealth] = await Promise.all([
    checkUrl(project.frontendUrl, Math.min(timeoutMs, 5_000)),
    checkUrl(project.backendUrl, Math.min(timeoutMs, 5_000)),
    checkUrl(project.healthCheckUrl, Math.min(timeoutMs, 5_000)),
    Promise.all((project.processes ?? [])
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
  const reason = healthReason({ pathOk, credentialOk: credential.ok, frontend, backend, health, processHealth });
  const ok = reason === "none";
  return {
    projectId: project.id,
    ok,
    status: ok ? "passed" : "failed",
    reason,
    credential,
    frontend,
    backend,
    health,
    processHealth,
    checkedAt: now(),
    durationMs: Date.now() - startedAt,
    message: ok ? "Project connection is healthy." : `Project connection failed: ${reason}.`
  };
}

function spawnManagedProcess(input: {
  project: ProjectConfig;
  cwd: string;
  command: string;
}) {
  const child = spawn(input.command, {
    cwd: input.cwd,
    shell: true,
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: commandEnv(input.project)
  });
  child.unref();
  return child;
}

function commandEnv(project: ProjectConfig) {
  const projectEnv = Object.fromEntries(
    Object.entries(project.env ?? {}).filter(([, value]) => value !== "[REDACTED]")
  );
  return {
    ...process.env,
    ...projectEnv
  };
}

async function waitForHealthy(project: ProjectConfig) {
  const timeoutMs = project.timeoutMs ?? 20_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await testProjectConnection(project);
    if (result.ok) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return testProjectConnection(project);
}

async function runManagedCommand(input: {
  projectId: string;
  project: ProjectConfig;
  command: string;
  cwd: string;
  timeoutMs: number;
  status?: ProjectRuntimeStatus;
}) {
  const child = spawnManagedProcess({ project: input.project, cwd: input.cwd, command: input.command });
  if (input.status) {
    runningProjects.set(input.projectId, { process: child, status: { ...input.status, pid: child.pid } });
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(async () => {
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
  return exitCode === 0;
}

async function terminateProcessTree(child: ChildProcess) {
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
}

function projectProcesses(project: ProjectConfig): ProjectProcessConfig[] {
  if (project.processes?.length) return project.processes;
  return project.startCommand?.trim()
    ? [{ name: "main", command: project.startCommand, healthCheckUrl: project.healthCheckUrl, required: true }]
    : [];
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

export async function startProject(id: string): Promise<ProjectRuntimeStatus> {
  const project = await getProject(id);
  if (!project) {
    return { projectId: id, status: "failed", failureReason: "config_missing", message: "Project config not found." };
  }
  const existing = runningProjects.get(id);
  if (existing) {
    if (isActiveRuntimeStatus(existing.status.status)) return existing.status;
    runningProjects.delete(id);
  }
  const cwd = safeProjectPath(project);
  if (!(await exists(cwd))) {
    return { projectId: id, status: "failed", failureReason: "project_path_missing", message: `Project path not found: ${project.projectPath}` };
  }
  const credential = credentialCheck(project.login);
  if (!credential.ok) {
    return {
      projectId: id,
      status: "failed",
      failureReason: "credential_missing",
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      healthCheckUrl: project.healthCheckUrl,
      message: `Project credential is missing: ${credential.missingEnv.join(", ")}.`
    };
  }
  const configuredProcesses = projectProcesses(project);
  if (!configuredProcesses.length) {
    const health = await testProjectConnection(project);
    return {
      projectId: id,
      status: health.ok ? "running" : "failed",
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      healthCheckUrl: project.healthCheckUrl,
      failureReason: health.ok ? "none" : health.reason,
      message: health.message
    };
  }
  if (project.installCommand?.trim()) {
    const installing: ProjectRuntimeStatus = {
      projectId: id,
      status: "installing",
      startedAt: now(),
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      healthCheckUrl: project.healthCheckUrl,
      message: "Project install command is running."
    };
    const installOk = await runManagedCommand({
      projectId: id,
      project,
      command: project.installCommand,
      cwd,
      timeoutMs: project.timeoutMs ?? 20_000,
      status: installing
    });
    if (!installOk) {
      const failed: ProjectRuntimeStatus = {
        ...installing,
        status: "failed",
        stoppedAt: now(),
        failureReason: "install_failed",
        message: "Project install command failed or timed out."
      };
      runningProjects.delete(id);
      return failed;
    }
  }
  const processes = configuredProcesses.map((processConfig) => ({
    config: processConfig,
    process: spawnManagedProcess({ project, cwd, command: processConfig.command })
  }));
  const status: ProjectRuntimeStatus = {
    projectId: id,
    status: "starting",
    pid: processes[0]?.process.pid,
    processes: buildProcessStatuses(processes, "starting"),
    startedAt: now(),
    frontendUrl: project.frontendUrl,
    backendUrl: project.backendUrl,
    healthCheckUrl: project.healthCheckUrl,
    message: "Project process started; waiting for health check."
  };
  runningProjects.set(id, { process: processes[0]?.process, processes, status });
  for (const managed of processes) {
    managed.process.once("exit", (code) => {
      const current = runningProjects.get(id);
      if (!current || current.status.status === "stopped") return;
      const required = managed.config.required ?? true;
      if (!required && code === 0) return;
      current.status = {
        ...current.status,
        status: code === 0 ? "stopped" : "failed",
        stoppedAt: now(),
        failureReason: code === 0 ? "none" : "start_failed",
        message: `Project process ${managed.config.name} exited with code ${code ?? "unknown"}.`
      };
    });
  }
  const health = await waitForHealthy(project);
  const updated: ProjectRuntimeStatus = {
    ...status,
    status: health.ok ? "running" : "failed",
    processes: buildProcessStatuses(processes, health.ok ? "running" : "failed", health.ok ? "none" : health.reason),
    failureReason: health.ok ? "none" : health.reason,
    message: health.message
  };
  runningProjects.set(id, { process: processes[0]?.process, processes, status: updated });
  if (!health.ok) {
    await terminateRunningProject({ processes, status: updated });
    runningProjects.delete(id);
  }
  return updated;
}

export async function stopProject(id: string): Promise<ProjectRuntimeStatus> {
  const running = runningProjects.get(id);
  const project = await getProject(id);
  if (!running) {
    return { projectId: id, status: "stopped", stoppedAt: now(), message: "Project was not running." };
  }
  if (!isActiveRuntimeStatus(running.status.status)) {
    runningProjects.delete(id);
    return {
      ...running.status,
      status: "stopped",
      stoppedAt: running.status.stoppedAt ?? now(),
      message: "Project was already stopped."
    };
  }
  await terminateRunningProject(running);
  runningProjects.delete(id);
  if (project?.cleanupCommand?.trim()) {
    const cleanupOk = await runManagedCommand({
      projectId: id,
      project,
      command: project.cleanupCommand,
      cwd: safeProjectPath(project),
      timeoutMs: project.timeoutMs ?? 20_000
    });
    if (!cleanupOk) {
      return {
        ...running.status,
        status: "failed",
        stoppedAt: now(),
        failureReason: "cleanup_failed",
        message: "Project stopped, but cleanup command failed or timed out."
      };
    }
  }
  return {
    ...running.status,
    status: "stopped",
    processes: running.status.processes?.map((item) => ({
      ...item,
      status: "stopped",
      message: "Process stopped."
    })),
    stoppedAt: now(),
    message: "Project stopped."
  };
}

export async function resolveProjectTarget(input: { projectId?: string; appUrl?: string; target?: TargetAppRuntime }) {
  if (input.target) return input.target;
  if (input.projectId) {
    const project = await getProject(input.projectId);
    if (project) {
      return {
        projectId: project.id,
        frontendUrl: input.appUrl ?? project.frontendUrl,
        backendUrl: project.backendUrl,
        healthCheckUrl: project.healthCheckUrl
      };
    }
  }
  return {
    frontendUrl: input.appUrl ?? "http://localhost:6173"
  };
}
