import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig, TargetProjectConfig } from "./types.js";
import { redactRecord } from "./redaction.js";
import { projectManifestSchema } from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const projectDir = path.join(rootDir, "data", "projects");
const PROJECT_ROOT_TEMPLATE = /^\$\{([A-Z][A-Z0-9_]*)\}(.*)$/;

function now() {
  return new Date().toISOString();
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function expandProjectPathTemplate(projectPath: string) {
  const match = projectPath.match(PROJECT_ROOT_TEMPLATE);
  if (!match) return projectPath;
  const configuredRoot = process.env[match[1]];
  if (!configuredRoot) return projectPath;
  const suffix = match[2].replace(/^[/\\]+/, "");
  return suffix ? path.resolve(configuredRoot, suffix) : path.resolve(configuredRoot);
}

export function safeProjectPath(project: Pick<ProjectConfig, "projectPath" | "allowExternalProjectPath">) {
  const template = project.projectPath.match(PROJECT_ROOT_TEMPLATE);
  if (template && !process.env[template[1]]) {
    throw new Error(`external_project_root_missing:${template[1]}`);
  }
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

function projectFile(id: string) {
  return path.join(projectDir, `${id}.json`);
}

function normalizeProjectConfig(input: ProjectConfig): ProjectConfig {
  const timestamp = now();
  const manifest = input.manifest
    ? projectManifestSchema.parse(input.manifest)
    : undefined;
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
    projectPath: expandProjectPathTemplate(input.projectPath),
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
