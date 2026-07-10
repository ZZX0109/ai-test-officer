import { createServer } from "node:net";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig, ProjectDetectionResult, ProjectDiagnosis, ProjectHealthCheckResult } from "./types.js";
import { getProject, testProjectConnection } from "./projectAdapter.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectPath(projectPath: string) {
  return path.isAbsolute(projectPath) ? path.resolve(projectPath) : path.resolve(rootDir, projectPath);
}

async function readJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function depsOf(pkg: Record<string, unknown> | undefined) {
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies as Record<string, unknown> : {};
  const devDependencies = pkg?.devDependencies && typeof pkg.devDependencies === "object" ? pkg.devDependencies as Record<string, unknown> : {};
  return { ...dependencies, ...devDependencies };
}

function scriptsOf(pkg: Record<string, unknown> | undefined) {
  return pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, string> : {};
}

async function detectPythonStack(projectPath: string) {
  const candidates = [
    path.join(projectPath, "requirements.txt"),
    path.join(projectPath, "pyproject.toml"),
    path.join(projectPath, "backend", "requirements.txt"),
    path.join(projectPath, "backend", "pyproject.toml")
  ];
  const text = (await Promise.all(candidates.map(async (file) => (await exists(file)) ? await readFile(file, "utf8") : ""))).join("\n");
  return /fastapi|uvicorn/i.test(text) || await exists(path.join(projectPath, "backend", "app.py"));
}

async function detectPackageManagers(projectPath: string): Promise<ProjectDetectionResult["packageManagers"]> {
  const managers: ProjectDetectionResult["packageManagers"] = [];
  if (await exists(path.join(projectPath, "package-lock.json"))) managers.push("npm");
  if (await exists(path.join(projectPath, "pnpm-lock.yaml"))) managers.push("pnpm");
  if (await exists(path.join(projectPath, "yarn.lock"))) managers.push("yarn");
  if (await exists(path.join(projectPath, "requirements.txt")) || await exists(path.join(projectPath, "backend", "requirements.txt"))) managers.push("pip");
  if (await exists(path.join(projectPath, "uv.lock"))) managers.push("uv");
  if (await exists(path.join(projectPath, "poetry.lock"))) managers.push("poetry");
  return managers.length ? managers : ["npm"];
}

async function portStatus(port: number) {
  return new Promise<"available" | "listening" | "unknown">((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE" ? "listening" : "unknown");
    });
    server.once("listening", () => {
      server.close(() => resolve("available"));
    });
    server.listen(port, "127.0.0.1");
  });
}

function firstScript(scripts: Record<string, string>, names: string[]) {
  for (const name of names) {
    if (scripts[name]) return `npm run ${name}`;
  }
  return undefined;
}

function projectIdFromPath(projectPath: string) {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `project_${Date.now()}`;
}

export async function detectProject(projectPathInput: string): Promise<ProjectDetectionResult> {
  const projectPath = resolveProjectPath(projectPathInput);
  const projectExists = await exists(projectPath);
  const pkg = projectExists ? await readJson(path.join(projectPath, "package.json")) : undefined;
  const deps = depsOf(pkg);
  const scripts = scriptsOf(pkg);
  const files = projectExists ? await readdir(projectPath).catch(() => []) : [];
  const hasFastApi = projectExists ? await detectPythonStack(projectPath) : false;
  const detectedStack: ProjectDetectionResult["detectedStack"] = [];
  if (deps.vite || /vite/i.test(Object.values(scripts).join("\n"))) detectedStack.push("vite");
  if (deps.next || files.some((file) => file === "next.config.js" || file === "next.config.mjs" || file === "next.config.ts")) detectedStack.push("next");
  if (deps.express || /express/i.test(Object.values(scripts).join("\n"))) detectedStack.push("express");
  if (hasFastApi) detectedStack.push("fastapi");
  if (!detectedStack.length) detectedStack.push("unknown");

  const packageManagers = await detectPackageManagers(projectPath);
  const installCommand = packageManagers.includes("pnpm") ? "pnpm install" : packageManagers.includes("yarn") ? "yarn install" : "npm install";
  const frontendPort = detectedStack.includes("next") ? 3000 : 5173;
  const backendPort = detectedStack.includes("fastapi") ? 8000 : detectedStack.includes("express") ? 3000 : undefined;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const backendUrl = backendPort ? `http://127.0.0.1:${backendPort}/api/health` : undefined;
  const devCommand = firstScript(scripts, ["dev", "start", "serve"]) ?? (detectedStack.includes("fastapi") ? "uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000" : "npm run dev");
  const processes: ProjectConfig["processes"] = [];
  if (detectedStack.includes("fastapi")) {
    processes.push({
      name: "api",
      command: firstScript(scripts, ["dev:api", "api", "backend"]) ?? "uvicorn backend.app:app --reload --host 127.0.0.1 --port 8000",
      healthCheckUrl: "http://127.0.0.1:8000/api/health",
      required: true
    });
  }
  if (detectedStack.includes("vite") || detectedStack.includes("next")) {
    processes.push({
      name: "web",
      command: detectedStack.includes("vite") ? `${devCommand} -- --port ${frontendPort}` : devCommand,
      healthCheckUrl: frontendUrl,
      required: true
    });
  } else if (!processes.length && devCommand) {
    processes.push({ name: "app", command: devCommand, healthCheckUrl: frontendUrl, required: true });
  }

  const suggestedConfig: ProjectConfig = {
    id: projectIdFromPath(projectPath),
    name: path.basename(projectPath).replace(/[-_]+/g, " "),
    projectPath,
    allowExternalProjectPath: path.isAbsolute(projectPathInput),
    installCommand: projectExists && pkg ? installCommand : "",
    startCommand: processes.length ? "" : devCommand,
    processes,
    healthCheckUrl: backendUrl ?? frontendUrl,
    frontendUrl,
    backendUrl,
    login: { method: "none" },
    env: {},
    timeoutMs: 30_000,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const portValues = Array.from(new Set([frontendPort, backendPort].filter((value): value is number => Boolean(value))));
  const ports = await Promise.all(portValues.map(async (port) => ({
    port,
    purpose: port === frontendPort ? "frontend" as const : "backend" as const,
    status: await portStatus(port),
    url: `http://127.0.0.1:${port}`
  })));
  const healthCandidates = [
    backendUrl,
    backendPort ? `http://127.0.0.1:${backendPort}/health` : undefined,
    frontendUrl
  ].filter((value): value is string => Boolean(value));
  const warnings = [
    projectExists ? undefined : "项目路径不存在。",
    !pkg && !hasFastApi ? "没有识别到 package.json 或 FastAPI 入口。" : undefined,
    ports.some((port) => port.status === "listening") ? "检测到推荐端口已有服务监听，启动前请确认是否为目标项目。" : undefined
  ].filter((item): item is string => Boolean(item));
  const plainLanguageFixes = [
    projectExists ? "项目路径可以访问。" : "请确认项目文件夹路径是否正确，或者在 Finder 中复制完整路径。",
    pkg ? `检测到前端/Node 项目，可先运行：${installCommand}` : "如果这是 Python 项目，请确认 requirements.txt 或 pyproject.toml 存在。",
    ports.some((port) => port.status === "listening")
      ? "如果启动失败提示端口占用，请先关闭占用端口的旧 dev server，或把项目端口改成未占用端口。"
      : "推荐端口当前可用。",
    backendUrl ? `后端健康检查建议先打开 ${backendUrl}，看到 200/ok 再运行测试。` : `前端健康检查建议先打开 ${frontendUrl}。`
  ];
  return { projectPath, exists: projectExists, detectedStack, packageManagers, suggestedConfig, ports, healthCandidates, warnings, plainLanguageFixes };
}

function diagnosisStage(input: {
  stage: ProjectDiagnosis["stages"][number]["stage"];
  passed: boolean;
  reason: string;
  humanMessage: string;
  suggestedCommands?: string[];
  portConflicts?: Array<{ port: number; process?: string; fix: string }>;
  missingEnv?: string[];
}) {
  return {
    stage: input.stage,
    status: input.passed ? "passed" as const : "failed" as const,
    reason: input.reason,
    humanMessage: input.humanMessage,
    suggestedCommands: input.suggestedCommands ?? [],
    portConflicts: input.portConflicts,
    missingEnv: input.missingEnv
  };
}

export async function diagnoseProject(id: string): Promise<ProjectDiagnosis> {
  const project = await getProject(id);
  if (!project) {
    return {
      projectId: id,
      checkedAt: new Date().toISOString(),
      overallStatus: "failed",
      stages: [diagnosisStage({
        stage: "path",
        passed: false,
        reason: "config_missing",
        humanMessage: "找不到这个项目配置。请先通过项目向导保存配置。",
        suggestedCommands: []
      })]
    };
  }
  let connection: ProjectHealthCheckResult;
  try {
    connection = await testProjectConnection(project);
  } catch (error) {
    connection = {
      projectId: id,
      ok: false,
      status: "failed",
      reason: "unknown",
      credential: { ok: false, method: project.login?.method ?? "none", missingEnv: [] },
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      message: error instanceof Error ? error.message : "项目诊断失败。"
    };
  }
  const detection = await detectProject(project.projectPath);
  const portConflicts = detection.ports
    .filter((port) => port.status === "listening")
    .map((port) => ({ port: port.port, fix: `端口 ${port.port} 已有服务监听。如果不是目标项目，请先停止旧服务或修改端口。` }));
  const stages: ProjectDiagnosis["stages"] = [
    diagnosisStage({
      stage: "path",
      passed: detection.exists,
      reason: detection.exists ? "path_ok" : "project_path_missing",
      humanMessage: detection.exists ? "项目文件夹存在，可以继续检测。" : "项目文件夹不存在，请重新选择项目路径。",
      suggestedCommands: detection.exists ? [] : ["pwd", "ls"]
    }),
    diagnosisStage({
      stage: "credential",
      passed: connection.credential.ok,
      reason: connection.credential.ok ? "credential_ok" : "credential_missing",
      humanMessage: connection.credential.ok ? "测试账号配置可用。" : `缺少测试账号环境变量：${connection.credential.missingEnv.join(", ") || "未配置"}`,
      suggestedCommands: connection.credential.missingEnv.map((name) => `export ${name}=...`),
      missingEnv: connection.credential.missingEnv
    }),
    diagnosisStage({
      stage: "frontend",
      passed: connection.frontend?.ok !== false,
      reason: connection.frontend?.ok === false ? "frontend_unreachable" : "frontend_ok",
      humanMessage: connection.frontend?.ok === false ? "前端地址打不开，请确认 dev server 是否启动、端口是否正确。" : "前端地址可访问或未配置。",
      suggestedCommands: project.processes?.map((process) => process.command) ?? (project.startCommand ? [project.startCommand] : [])
    }),
    diagnosisStage({
      stage: "backend",
      passed: connection.backend?.ok !== false,
      reason: connection.backend?.ok === false ? "backend_unreachable" : "backend_ok",
      humanMessage: connection.backend?.ok === false ? "后端健康检查不通，请先单独启动 API 服务并打开 health URL。" : "后端地址可访问或未配置。",
      suggestedCommands: project.processes?.filter((process) => /api|backend/i.test(process.name)).map((process) => process.command) ?? []
    }),
    {
      stage: "ports",
      status: portConflicts.length ? "warning" : "passed",
      reason: portConflicts.length ? "port_conflict_possible" : "ports_available",
      humanMessage: portConflicts.length ? "有推荐端口正在被占用，可能是目标项目已启动，也可能是旧服务残留。" : "推荐端口没有明显冲突。",
      suggestedCommands: portConflicts.map((item) => `lsof -nP -iTCP:${item.port} -sTCP:LISTEN`),
      portConflicts
    }
  ];
  return {
    projectId: id,
    checkedAt: new Date().toISOString(),
    overallStatus: connection.ok ? "passed" : stages.some((stage) => stage.status === "failed") ? "failed" : "warning",
    stages
  };
}
