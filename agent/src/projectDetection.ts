import { createServer } from "node:net";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig, ProjectDetectionResult, ProjectDiagnosis, ProjectHealthCheckResult } from "./types.js";
import type { CommandSpec, ProjectManifest } from "@ai-test-officer/contracts";
import { getProject, projectWithActiveRuntime, testProjectConnection } from "./projectAdapter.js";

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

async function detectLoginCapability(projectPath: string, dependencies: Record<string, unknown>) {
  const dependencySignals: string[] = [];
  const implementationSignals: string[] = [];
  let usernameEnv: string | undefined;
  let passwordEnv: string | undefined;
  const authDependencies = [
    "next-auth", "@auth/core", "passport", "@supabase/supabase-js",
    "firebase", "firebase-admin", "auth0", "@auth0/auth0-react"
  ];
  for (const dependency of authDependencies) {
    if (dependencies[dependency]) dependencySignals.push(`dependency:${dependency}`);
  }
  const ignored = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage"]);
  const pending = [{ directory: projectPath, depth: 0 }];
  let scanned = 0;
  while (pending.length && scanned < 500) {
    const current = pending.shift()!;
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (scanned++ >= 500) break;
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(current.directory, entry.name);
      const relative = path.relative(projectPath, entryPath).replaceAll("\\", "/");
      if (/(^|\/)(login|sign-?in|sign-?up)(\/|\.|-|_)/i.test(relative)) implementationSignals.push(`path:${relative}`);
      if (entry.isFile() && /\.(?:[cm]?[jt]sx?|vue|svelte|py)$/i.test(entry.name) && !/(?:migration|generated|fixture)/i.test(relative)) {
        const source = await readFile(entryPath, "utf8").catch(() => "");
        const sample = source.slice(0, 250_000);
        const hasLoginCall = /signInWithPassword|signInWithEmailAndPassword|passport\.authenticate|authenticateUser|\/api\/(?:auth\/)?login/i.test(sample);
        const hasIdentityField = /(?:name|id|type)\s*=\s*["'](?:email|username|user)["']|getByLabelText\(\s*["'][^"']*(?:email|username|用户名|邮箱)/i.test(sample);
        const hasPasswordField = /(?:name|id|type)\s*=\s*["']password["']|getByLabelText\(\s*["'][^"']*(?:password|密码)/i.test(sample);
        if (hasLoginCall || (hasIdentityField && hasPasswordField)) implementationSignals.push(`code:${relative}`);
        usernameEnv ??= /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]*(?:USER|EMAIL|LOGIN)[A-Z0-9_]*)/.exec(sample)?.[1];
        passwordEnv ??= /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]*(?:PASSWORD|PASSWD|PWD)[A-Z0-9_]*)/.exec(sample)?.[1];
      }
      if (entry.isDirectory() && current.depth < 4) pending.push({ directory: entryPath, depth: current.depth + 1 });
    }
  }
  const uniqueImplementationSignals = Array.from(new Set(implementationSignals));
  const uniqueSignals = Array.from(new Set([...uniqueImplementationSignals, ...dependencySignals])).slice(0, 12);
  const hasLoginPath = uniqueImplementationSignals.some((signal) => signal.startsWith("path:"));
  const hasLoginCode = uniqueImplementationSignals.some((signal) => signal.startsWith("code:"));
  return {
    detected: hasLoginPath || hasLoginCode,
    confidence: hasLoginPath ? "high" as const : hasLoginCode ? "medium" as const : "none" as const,
    signals: uniqueSignals,
    usernameEnv,
    passwordEnv
  };
}

function apiCredentialRequirement(envName: string, signal: string) {
  const normalized = envName.toUpperCase();
  const browserPrefix = /^(?:VITE|NEXT_PUBLIC|PUBLIC)_/.test(normalized);
  const keyStem = normalized.replace(/_API_KEY$|_TOKEN$|_KEY$/, "");
  const providerHint = keyStem
    .replace(/^(?:VITE|NEXT_PUBLIC|PUBLIC)_/, "")
    .replaceAll("_", " ")
    .toLowerCase();
  return {
    envName: normalized,
    providerHint: providerHint || undefined,
    baseUrlEnv: `${keyStem}_BASE_URL`,
    modelEnv: `${keyStem}_MODEL`,
    exposure: browserPrefix ? "browser" as const : "server" as const,
    signals: [signal]
  };
}

function apiCredentialNames(source: string) {
  const names = new Set<string>();
  const expressions = [
    /(?:process\.env\.|import\.meta\.env\.)([A-Z_][A-Z0-9_]*)/g,
    /(?:os\.getenv\(\s*|os\.environ(?:\.get)?\(\s*|os\.environ\[\s*)["']([A-Z_][A-Z0-9_]*)["']/g,
    /^\s*([A-Z_][A-Z0-9_]*)\s*=/gm
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      const name = match[1]?.toUpperCase();
      if (name && /(?:^|_)(?:API_KEY|ACCESS_TOKEN)$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

async function detectApiCredentialCapability(projectPath: string) {
  const ignored = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage", ".venv", "venv"]);
  const pending = [{ directory: projectPath, depth: 0 }];
  const requirements = new Map<string, ReturnType<typeof apiCredentialRequirement>>();
  let scanned = 0;
  while (pending.length && scanned < 700) {
    const current = pending.shift()!;
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (scanned++ >= 700) break;
      if (ignored.has(entry.name) || /^\.env$|^\.env\.(?!example|sample|template)/i.test(entry.name)) continue;
      const entryPath = path.join(current.directory, entry.name);
      const relative = path.relative(projectPath, entryPath).replaceAll("\\", "/");
      if (entry.isDirectory() && current.depth < 5) {
        pending.push({ directory: entryPath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|vue|svelte|py|env|example|sample|template|md|toml|ya?ml)$/i.test(entry.name)) continue;
      const source = (await readFile(entryPath, "utf8").catch(() => "")).slice(0, 250_000);
      for (const envName of apiCredentialNames(source)) {
        const signal = `env:${relative}:${envName}`;
        const existing = requirements.get(envName);
        if (existing) existing.signals = Array.from(new Set([...existing.signals, signal])).slice(0, 8);
        else requirements.set(envName, apiCredentialRequirement(envName, signal));
      }
    }
  }
  return { detected: requirements.size > 0, requirements: [...requirements.values()] };
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

type EcosystemLaunch = {
  stack: ProjectDetectionResult["detectedStack"];
  installCommand?: string;
  command: string;
  port: number;
  processName: string;
  image: string;
  allowlist: string[];
};

async function readFirstExisting(projectPath: string, candidates: string[]) {
  for (const candidate of candidates) {
    const filePath = path.join(projectPath, candidate);
    if (await exists(filePath)) return { relativePath: candidate, content: await readFile(filePath, "utf8").catch(() => "") };
  }
  return undefined;
}

async function detectNonNodeLaunch(projectPath: string, files: string[]): Promise<EcosystemLaunch | undefined> {
  const pythonDefinition = await readFirstExisting(projectPath, [
    "pyproject.toml", "requirements.txt", "backend/pyproject.toml", "backend/requirements.txt"
  ]);
  const pythonText = pythonDefinition?.content ?? "";
  if (files.includes("manage.py") || /(?:^|\n)\s*django(?:[<>=~ ]|$)/im.test(pythonText)) {
    return {
      stack: ["python", "django"],
      installCommand: files.includes("uv.lock") ? "uv sync" : files.includes("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .",
      command: "python manage.py runserver 0.0.0.0:8000",
      port: 8000,
      processName: "web",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python", "python3", "pip", "uv"]
    };
  }
  const streamlitEntry = ["streamlit_app.py", "app.py", "main.py"].find((file) => files.includes(file));
  if (streamlitEntry && /\bstreamlit\b/i.test(pythonText)) {
    return {
      stack: ["python", "streamlit"],
      installCommand: files.includes("uv.lock") ? "uv sync" : "pip install -r requirements.txt",
      command: `python -m streamlit run ${streamlitEntry} --server.address 0.0.0.0 --server.port 8501`,
      port: 8501,
      processName: "web",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python", "python3", "pip", "uv"]
    };
  }
  const pythonEntry = ["app.py", "main.py", "backend/app.py", "backend/main.py"].find((file) => files.includes(file));
  if (pythonEntry && /\bgradio\b/i.test(pythonText)) {
    return {
      stack: ["python", "gradio"],
      installCommand: files.includes("uv.lock") ? "uv sync" : "pip install -r requirements.txt",
      command: `python ${pythonEntry}`,
      port: 7860,
      processName: "web",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python", "python3", "pip", "uv"]
    };
  }
  if (pythonEntry && /\bflask\b/i.test(pythonText)) {
    const moduleName = pythonEntry.replace(/\.py$/i, "").replaceAll("/", ".");
    return {
      stack: ["python", "flask"],
      installCommand: files.includes("uv.lock") ? "uv sync" : "pip install -r requirements.txt",
      command: `python -m flask --app ${moduleName} run --host 0.0.0.0 --port 5000`,
      port: 5000,
      processName: "web",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python", "python3", "pip", "uv"]
    };
  }
  if (pythonEntry && /\b(?:fastapi|uvicorn)\b/i.test(pythonText)) {
    const moduleName = pythonEntry.replace(/\.py$/i, "").replaceAll("/", ".");
    return {
      stack: ["python", "fastapi"],
      installCommand: files.includes("uv.lock") ? "uv sync" : "pip install -r requirements.txt",
      command: `python -m uvicorn ${moduleName}:app --host 0.0.0.0 --port 8000`,
      port: 8000,
      processName: "api",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python", "python3", "pip", "uv", "uvicorn"]
    };
  }
  if (files.includes("go.mod")) {
    return {
      stack: ["go"],
      command: "go run .",
      port: 8080,
      processName: "web",
      image: "golang:1.23-bookworm",
      allowlist: ["go"]
    };
  }
  if (files.includes("Cargo.toml")) {
    return {
      stack: ["rust"],
      command: "cargo run",
      port: 8080,
      processName: "web",
      image: "rust:1.84-bookworm",
      allowlist: ["cargo"]
    };
  }
  if (files.includes("pom.xml") || files.includes("mvnw")) {
    return {
      stack: ["java", "spring"],
      command: files.includes("mvnw") ? "./mvnw spring-boot:run" : "mvn spring-boot:run",
      port: 8080,
      processName: "web",
      image: "maven:3.9-eclipse-temurin-21",
      allowlist: ["mvn", "./mvnw", "java"]
    };
  }
  if (files.includes("build.gradle") || files.includes("build.gradle.kts") || files.includes("gradlew")) {
    return {
      stack: ["java", "spring"],
      command: files.includes("gradlew") ? "./gradlew bootRun" : "gradle bootRun",
      port: 8080,
      processName: "web",
      image: "gradle:8.12-jdk21",
      allowlist: ["gradle", "./gradlew", "java"]
    };
  }
  if (files.includes("Gemfile") && (files.includes("config.ru") || await exists(path.join(projectPath, "bin", "rails")))) {
    return {
      stack: ["ruby", "rails"],
      installCommand: "bundle install",
      command: "bundle exec rails server -b 0.0.0.0 -p 3000",
      port: 3000,
      processName: "web",
      image: "ruby:3.3-bookworm",
      allowlist: ["bundle", "ruby"]
    };
  }
  if (files.includes("artisan")) {
    return {
      stack: ["php", "laravel"],
      installCommand: "composer install",
      command: "php artisan serve --host 0.0.0.0 --port 8000",
      port: 8000,
      processName: "web",
      image: "composer:2",
      allowlist: ["php", "composer"]
    };
  }
  if (files.includes("index.html")) {
    return {
      stack: ["static"],
      command: "python3 -m http.server 4173 --bind 0.0.0.0",
      port: 4173,
      processName: "web",
      image: "python:3.12-slim-bookworm",
      allowlist: ["python3"]
    };
  }
  return undefined;
}

async function detectPackageManagers(projectPath: string): Promise<ProjectDetectionResult["packageManagers"]> {
  const managers: ProjectDetectionResult["packageManagers"] = [];
  const hasNpmLock = await exists(path.join(projectPath, "package-lock.json"));
  const hasPnpmLock = await exists(path.join(projectPath, "pnpm-lock.yaml"));
  const hasYarnLock = await exists(path.join(projectPath, "yarn.lock"));
  if (hasNpmLock) managers.push("npm");
  if (hasPnpmLock) managers.push("pnpm");
  if (hasYarnLock) managers.push("yarn");
  if (!hasNpmLock && !hasPnpmLock && !hasYarnLock && await exists(path.join(projectPath, "package.json"))) {
    managers.push("npm");
  }
  if (await exists(path.join(projectPath, "requirements.txt")) || await exists(path.join(projectPath, "backend", "requirements.txt"))) managers.push("pip");
  if (await exists(path.join(projectPath, "uv.lock"))) managers.push("uv");
  if (await exists(path.join(projectPath, "poetry.lock"))) managers.push("poetry");
  return managers;
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

function configuredFrontendPort(scripts: Record<string, string>, configText: string, fallback: number) {
  const scriptText = Object.values(scripts).join("\n");
  const scriptMatch = /(?:--port|--listen|-l|-p)\s*[= ]\s*(\d{2,5})\b/.exec(scriptText);
  if (scriptMatch) return Number(scriptMatch[1]);
  const viteConfigMatch = /\bserver\s*:\s*\{[\s\S]{0,2500}?\bport\s*:\s*(\d{2,5})\b/m.exec(configText);
  if (viteConfigMatch) return Number(viteConfigMatch[1]);
  const viteDefaultPort = /\bport\s*:\s*[\s\S]{0,180}?\|\|\s*(\d{2,5})\b/m.exec(configText);
  if (viteDefaultPort) return Number(viteDefaultPort[1]);
  return fallback;
}

async function readFrontendConfig(projectPath: string) {
  const candidates = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];
  for (const candidate of candidates) {
    const filePath = path.join(projectPath, candidate);
    if (await exists(filePath)) return readFile(filePath, "utf8").catch(() => "");
  }
  return "";
}

type NodePackageManager = "npm" | "pnpm" | "yarn";
type FrontendFramework = "vite" | "next" | "react-scripts" | "generic";

function workspacePatterns(pkg: Record<string, unknown> | undefined) {
  const value = pkg?.workspaces;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (value && typeof value === "object" && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === "string");
  }
  return [];
}

async function workspaceDirectories(projectPath: string, pkg: Record<string, unknown> | undefined) {
  const roots = new Set<string>(["packages", "apps", "frontend", "client", "web", "ui"]);
  const direct = new Set<string>();
  for (const pattern of workspacePatterns(pkg)) {
    const normalized = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("..")) continue;
    const wildcardIndex = normalized.search(/[*{[]/);
    if (wildcardIndex === -1) direct.add(normalized);
    else {
      const prefix = normalized.slice(0, wildcardIndex).replace(/\/+$/, "");
      if (prefix) roots.add(prefix);
    }
  }
  const directories = new Set<string>();
  for (const relative of direct) {
    const candidate = path.join(projectPath, relative);
    if (await exists(path.join(candidate, "package.json"))) directories.add(candidate);
  }
  for (const relative of roots) {
    const root = path.join(projectPath, relative);
    if (await exists(path.join(root, "package.json"))) directories.add(root);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 80)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const candidate = path.join(root, entry.name);
      if (await exists(path.join(candidate, "package.json"))) directories.add(candidate);
    }
  }
  return Array.from(directories).slice(0, 120);
}

function frontendFramework(dependencies: Record<string, unknown>, scripts: Record<string, string>): FrontendFramework | undefined {
  const scriptText = Object.values(scripts).join("\n");
  if (dependencies.vite || /\bvite\b/i.test(scriptText)) return "vite";
  if (dependencies.next || /\bnext\s+dev\b/i.test(scriptText)) return "next";
  if (dependencies["react-scripts"] || /\breact-scripts\s+start\b/i.test(scriptText)) return "react-scripts";
  const hasUiDependency = Boolean(dependencies.react || dependencies.vue || dependencies.svelte || dependencies["@angular/core"]);
  return hasUiDependency && (scripts.dev || scripts.start || scripts.serve) ? "generic" : undefined;
}

function workspaceStartCommand(input: {
  manager: NodePackageManager;
  packageName: string;
  framework: FrontendFramework;
  script: "dev" | "start" | "serve";
  port: number;
}) {
  const { manager, packageName, framework, script, port } = input;
  if (framework === "vite" && manager === "pnpm") {
    return `pnpm --filter ${packageName} exec vite --host 0.0.0.0 --port ${port} --strictPort`;
  }
  const prefix = manager === "pnpm"
    ? `pnpm --filter ${packageName} run ${script}`
    : manager === "npm"
      ? `npm --workspace ${packageName} run ${script} --`
      : `yarn workspace ${packageName} run ${script}`;
  if (framework === "vite") return `${prefix} --host 0.0.0.0 --port ${port} --strictPort`;
  if (framework === "next") return `${prefix} --hostname 0.0.0.0 --port ${port}`;
  return prefix;
}

async function detectWorkspaceFrontend(
  projectPath: string,
  pkg: Record<string, unknown> | undefined,
  manager: NodePackageManager
) {
  const candidates: Array<{
    name: string;
    framework: FrontendFramework;
    port: number;
    command: string;
    score: number;
  }> = [];
  for (const workspacePath of await workspaceDirectories(projectPath, pkg)) {
    const workspacePackage = await readJson(path.join(workspacePath, "package.json"));
    const workspaceDeps = depsOf(workspacePackage);
    const workspaceScripts = scriptsOf(workspacePackage);
    const packageName = typeof workspacePackage?.name === "string" ? workspacePackage.name : "";
    if (!packageName || !/^[@a-zA-Z0-9._/-]+$/.test(packageName)) continue;
    const framework = frontendFramework(workspaceDeps, workspaceScripts);
    const script = (["dev", "start", "serve"] as const).find((name) => Boolean(workspaceScripts[name]));
    if (!framework || !script) continue;
    const config = await readFrontendConfig(workspacePath);
    const fallbackPort = framework === "vite" ? 5173 : 3000;
    const port = configuredFrontendPort(workspaceScripts, config, fallbackPort);
    const label = `${packageName} ${path.basename(workspacePath)}`;
    const score = (framework === "vite" || framework === "next" ? 100 : 50)
      + (/(?:^|[-_/])(ui|web|client|frontend|app)(?:$|[-_/])/i.test(label) ? 30 : 0)
      + (workspaceDeps.react || workspaceDeps.vue || workspaceDeps.svelte ? 15 : 0)
      - (/(?:server|api|worker|cli)/i.test(label) ? 80 : 0);
    candidates.push({
      name: packageName,
      framework,
      port,
      command: workspaceStartCommand({ manager, packageName, framework, script, port }),
      score
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0];
}

async function detectWorkspaceBackend(
  projectPath: string,
  pkg: Record<string, unknown> | undefined
) {
  const candidates: Array<{ name: string; score: number; port: number; healthPath: string }> = [];
  for (const workspacePath of await workspaceDirectories(projectPath, pkg)) {
    const workspacePackage = await readJson(path.join(workspacePath, "package.json"));
    const dependencies = depsOf(workspacePackage);
    const workspaceScripts = scriptsOf(workspacePackage);
    const packageName = typeof workspacePackage?.name === "string" ? workspacePackage.name : "";
    const script = (["dev", "start", "serve"] as const).find((name) => Boolean(workspaceScripts[name]));
    if (!packageName || !script || !/^[@a-zA-Z0-9._/-]+$/.test(packageName)) continue;
    const label = `${packageName} ${path.basename(workspacePath)}`;
    const hasServerDependency = Boolean(
      dependencies.express
      || dependencies.fastify
      || dependencies.koa
      || dependencies.hapi
      || dependencies["@nestjs/core"]
      || dependencies["@oclif/core"]
    );
    const serverNamed = /(?:^|[-_/])(server|api|backend)(?:$|[-_/])/i.test(label);
    if (!hasServerDependency && !serverNamed) continue;
    const envText = (await Promise.all(
      [".env", ".env.local", ".env.development"].map((name) =>
        readFile(path.join(workspacePath, name), "utf8").catch(() => "")
      )
    )).join("\n");
    const scriptText = Object.values(workspaceScripts).join("\n");
    const port = Number(
      /(?:--port|--listen|-l|-p)\s*[= ]\s*(\d{2,5})\b/.exec(scriptText)?.[1]
      ?? /^\s*PORT\s*=\s*(\d{2,5})\s*$/m.exec(envText)?.[1]
      ?? 3000
    );
    const healthSourceParts: string[] = [];
    const pending = [{ directory: workspacePath, depth: 0 }];
    let scanned = 0;
    while (pending.length && scanned < 350) {
      const current = pending.shift()!;
      const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (scanned++ >= 350) break;
        if (["node_modules", "dist", "build", ".git", "coverage"].includes(entry.name)) continue;
        const absolute = path.join(current.directory, entry.name);
        if (entry.isDirectory() && current.depth < 4) {
          pending.push({ directory: absolute, depth: current.depth + 1 });
        } else if (entry.isFile() && /\.(?:[cm]?[jt]s|json)$/i.test(entry.name)) {
          healthSourceParts.push((await readFile(absolute, "utf8").catch(() => "")).slice(0, 120_000));
        }
      }
    }
    const targetedHealthFiles = await Promise.all([
      "src/utils/constants.ts",
      "src/routes/index.ts",
      "src/routes/health.ts",
      "src/routes/health/index.ts",
      "src/app.ts",
      "src/server.ts",
      "server.ts",
      "server.js"
    ].map((relative) => readFile(path.join(workspacePath, relative), "utf8").catch(() => "")));
    const healthSource = [...targetedHealthFiles, ...healthSourceParts].join("\n");
    const healthPath = ["/api/v1/health", "/api/health", "/health", "/api/v1/ping", "/ping"]
      .find((candidate) => healthSource.includes(candidate))
      ?? "/";
    candidates.push({
      name: packageName,
      score: (hasServerDependency ? 80 : 0) + (serverNamed ? 60 : 0),
      port,
      healthPath
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0];
}

function rootWorkspaceDevCommand(
  manager: NodePackageManager,
  frontendName: string,
  backendName: string
) {
  // Turbo/Nx may refuse to start an otherwise valid repository when an old
  // lockfile entry cannot be parsed. pnpm can launch the two verified
  // workspaces directly in one container, preserving localhost proxying
  // between UI and API without depending on the repository orchestrator.
  if (manager === "pnpm") {
    return `pnpm --parallel --filter ${backendName} --filter ${frontendName} run dev`;
  }
  return manager === "yarn" ? "yarn run dev" : "npm run dev";
}

function packageScriptCommand(manager: NodePackageManager, script: string) {
  return manager === "pnpm"
    ? `pnpm run ${script}`
    : manager === "yarn"
      ? `yarn run ${script}`
      : `npm run ${script}`;
}

function projectIdFromPath(projectPath: string) {
  return path.basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `project_${Date.now()}`;
}

function commandSpec(command: string | undefined, timeoutMs = 300_000): CommandSpec | undefined {
  const parts = command?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!parts.length || parts.some((part) => /[;&|`$<>]/.test(part))) return undefined;
  return { executable: parts[0], args: parts.slice(1), timeoutMs };
}

function nodeEngineFromPackage(pkg: Record<string, unknown> | undefined) {
  const engines = pkg?.engines;
  if (!engines || typeof engines !== "object") return undefined;
  const node = (engines as Record<string, unknown>).node;
  return typeof node === "string" ? node.trim() : undefined;
}

function sandboxImage(stack: ProjectDetectionResult["detectedStack"], nodeEngine?: string) {
  return stack.includes("python") || stack.includes("fastapi")
    ? "python:3.12-slim-bookworm"
    : (() => {
      // Prefer a pinned image when a project declares an exact Node engine.
      // This keeps package-manager engine checks inside the sandbox aligned
      // with the uploaded repository, rather than silently using the Agent's
      // own Node version.
      const exact = (nodeEngine?.match(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?:$|[^0-9])/) ?? [])[1];
      if (exact) return `node:${exact}-bookworm-slim`;
      const major = nodeEngine?.match(/\d{2}/)?.[0];
      return `node:${major ?? "22"}-bookworm-slim`;
    })();
}

// Stack-aware first-start grace. Heavy frameworks can exceed the default
// 5-minute prepare budget on a cold start (JVM + Hibernate + Flyway/Liquibase
// for Spring, Django/Rails migrations). A slow-but-healthy boot must not be
// misjudged as "not ready" just because it crossed the generic deadline.
function prepareBudgetForStack(stack: ProjectDetectionResult["detectedStack"]): number {
  const has = (token: string) => stack.some((item) => item === token);
  if (has("spring") || has("java")) return 600_000;
  if (has("django") || has("rails")) return 450_000;
  return 300_000;
}

// Apply a manifest-declared health path to the probe URL. The manifest's
// healthCheck.path used to be declared but never consumed, so a project that
// serves health on /actuator/health or /healthz could only be probed at "/",
// which 404s during boot and is misjudged as "not ready". "/" (the default)
// is a no-op so existing behavior is unchanged unless a path is declared.
function withHealthPath(baseUrl: string | undefined, path?: string): string | undefined {
  if (!baseUrl || !path || path === "/") return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.pathname = path.startsWith("/") ? path : `/${path}`;
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function sandboxManifest(input: {
  projectId: string;
  stack: ProjectDetectionResult["detectedStack"];
  nodeEngine?: string;
  image?: string;
  commandAllowlist?: string[];
  install?: CommandSpec;
  start?: CommandSpec;
  test?: CommandSpec;
  frontendPort: number;
  backendPort?: number;
  /** Detected backend health path (e.g. "/api/health" for FastAPI). Applied to
   * manifest.healthCheck.path so the runtime probes the right endpoint and
   * withHealthPath keeps manifest path + healthCheckUrl consistent. Omitted for
   * frontend-only projects, where "/" is correct. */
  healthCheckPath?: string;
}): ProjectManifest {
  return {
    schemaVersion: "1.0",
    projectId: input.projectId,
    workspaceRoot: ".",
    commands: { install: input.install, start: input.start, test: input.test },
    commandAllowlist: input.commandAllowlist
      ?? ["npm", "npx", "node", "pnpm", "yarn", "python", "python3", "pip", "uv", "uvicorn"],
    ports: [
      { name: "frontend", env: "FRONTEND_PORT", purpose: "frontend" },
      ...(input.backendPort ? [{ name: "backend", env: "BACKEND_PORT", purpose: "backend" as const }] : [])
    ],
    healthCheck: { path: input.healthCheckPath ?? "/", timeoutMs: 30_000 },
    environmentAllowlist: ["NODE_ENV", "FRONTEND_PORT", "BACKEND_PORT"],
    network: { mode: "allow-target", allowedHosts: ["127.0.0.1", "localhost"] },
    fixtures: [],
    apiOperations: [],
    dataSources: [],
    backgroundTasks: [],
    capabilities: { browser: true, desktop: false, allowedBundleIds: [] },
    execution: { mode: "oci", image: input.image ?? sandboxImage(input.stack, input.nodeEngine), engine: "docker" },
    budget: {
      runTimeoutMs: 1_200_000,
      prepareTimeoutMs: prepareBudgetForStack(input.stack),
      scenarioTimeoutMs: 300_000,
      stepTimeoutMs: 45_000,
      maxSteps: 50,
      maxAttempts: 2,
      maxScreenshots: 100,
      maxVideoBytes: 500 * 1024 * 1024,
      maxLogBytes: 50 * 1024 * 1024,
      maxArtifactBytes: 1024 * 1024 * 1024,
      maxConcurrency: 2
    }
  };
}

type ManifestApiOperation = ProjectManifest["apiOperations"][number];

function openApiOperations(document: unknown): ManifestApiOperation[] {
  if (!document || typeof document !== "object") return [];
  const paths = (document as { paths?: unknown }).paths;
  if (!paths || typeof paths !== "object") return [];
  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
  const operations: ManifestApiOperation[] = [];
  for (const [pathTemplate, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathTemplate.startsWith("/") || !pathItem || typeof pathItem !== "object") continue;
    for (const [rawMethod, operationValue] of Object.entries(pathItem as Record<string, unknown>)) {
      const method = rawMethod.toLowerCase();
      if (!methods.has(method) || !operationValue || typeof operationValue !== "object") continue;
      const operation = operationValue as Record<string, unknown>;
      const generatedId = `${method}_${pathTemplate}`
        .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const declaredId = typeof operation.operationId === "string" ? operation.operationId : generatedId;
      const operationId = declaredId.replace(/[^a-zA-Z0-9_.:-]+/g, "_");
      if (!operationId) continue;
      const responseCodes = operation.responses && typeof operation.responses === "object"
        ? Object.keys(operation.responses as Record<string, unknown>)
            .filter((code) => /^[1-5]\d\d$/.test(code))
            .map(Number)
        : [];
      operations.push({
        operationId,
        method: method.toUpperCase() as ManifestApiOperation["method"],
        pathTemplate,
        baseUrlRef: "backend",
        allowedStatusCodes: responseCodes.length ? responseCodes : [200],
        destructive: method === "delete"
      });
    }
  }
  return Array.from(new Map(operations.map((operation) => [operation.operationId, operation])).values());
}

async function detectFilesystemOpenApi(projectPath: string) {
  const candidates = [
    "openapi.json",
    "swagger.json",
    "docs/openapi.json",
    "api/openapi.json",
    "backend/openapi.json"
  ];
  const collected: ManifestApiOperation[] = [];
  for (const relative of candidates) {
    try {
      collected.push(...openApiOperations(JSON.parse(await readFile(path.join(projectPath, relative), "utf8"))));
    } catch {
      // Invalid or absent specifications are not executable contracts.
    }
  }
  return Array.from(new Map(collected.map((operation) => [operation.operationId, operation])).values());
}

function detectUploadedOpenApi(files: Array<{ relativePath: string; content?: string }>) {
  const collected: ManifestApiOperation[] = [];
  for (const file of files) {
    if (!/(^|\/)(openapi|swagger)\.json$/i.test(file.relativePath) || !file.content) continue;
    try {
      collected.push(...openApiOperations(JSON.parse(file.content)));
    } catch {
      // The project remains usable, but malformed OpenAPI is not allow-listed.
    }
  }
  return Array.from(new Map(collected.map((operation) => [operation.operationId, operation])).values());
}

// External service dependency detection at the upload step. A project that
// references a database / cache / queue / search / cloud-store the sandbox
// does not provision must surface that BEFORE the user starts the sandbox
// (step 1 / upload), instead of starting and crashing or silently degrading
// (e.g. running without the DB). Signals come from package.json deps,
// requirements.txt, and .env / .env.example variable names.
const DATABASE_CLIENT_PACKAGES: Record<string, string> = {
  pg: "PostgreSQL", "pg-pool": "PostgreSQL", postgres: "PostgreSQL", "pg-promise": "PostgreSQL",
  mysql: "MySQL", mysql2: "MySQL", mariadb: "MariaDB",
  mongodb: "MongoDB", mongoose: "MongoDB",
  "@prisma/client": "Prisma（外部数据库）", prisma: "Prisma（外部数据库）",
  "@redis/client": "Redis", redis: "Redis", ioredis: "Redis"
};
const SERVICE_CLIENT_PACKAGES: Record<string, string> = {
  amqplib: "RabbitMQ（AMQP）", kafkajs: "Kafka",
  "@elastic/elasticsearch": "Elasticsearch",
  "@aws-sdk/client-s3": "AWS S3", "aws-sdk": "AWS",
  "@google-cloud/firestore": "Google Firestore", "firebase-admin": "Firebase",
  "@supabase/supabase-js": "Supabase"
};
const DATABASE_PYTHON_PACKAGES: Record<string, string> = {
  psycopg2: "PostgreSQL", psycopg: "PostgreSQL", asyncpg: "PostgreSQL",
  "mysql-connector": "MySQL", pymysql: "MySQL",
  pymongo: "MongoDB", mongoengine: "MongoDB",
  redis: "Redis", sqlalchemy: "SQLAlchemy（外部数据库）",
  elasticsearch: "Elasticsearch", pika: "RabbitMQ（AMQP）",
  "confluent-kafka": "Kafka", boto3: "AWS"
};
const EXTERNAL_SERVICE_ENV = /\b(DATABASE_URL|POSTGRES_URL|MYSQL_URL|MONGO(?:DB)?_URI|REDIS_URL|REDIS_HOST|AMQP_URL|RABBITMQ_URL|KAFKA_URL|ELASTICSEARCH_URL|S3_BUCKET|S3_ENDPOINT|STORAGE_ENDPOINT)\b/;

export async function detectExternalServiceDependencies(input: {
  deps: Record<string, unknown>;
  files: string[];
  projectPath: string;
}): Promise<string[]> {
  const services = new Set<string>();
  for (const [pkg, service] of Object.entries(DATABASE_CLIENT_PACKAGES)) {
    if (input.deps[pkg]) services.add(service);
  }
  for (const [pkg, service] of Object.entries(SERVICE_CLIENT_PACKAGES)) {
    if (input.deps[pkg]) services.add(service);
  }
  // Python projects: scan requirements.txt for DB / queue / cloud clients.
  if (input.files.includes("requirements.txt")) {
    const requirements = await readFile(path.join(input.projectPath, "requirements.txt"), "utf8").catch(() => "");
    for (const [pkg, service] of Object.entries(DATABASE_PYTHON_PACKAGES)) {
      if (new RegExp(`^\\s*${pkg.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "im").test(requirements)) {
        services.add(service);
      }
    }
  }
  // .env / .env.example variable names signal the project EXPECTS an external
  // service even when the client package is abstracted away (e.g. Prisma).
  for (const envFile of [".env", ".env.example", ".env.local"]) {
    if (!input.files.includes(envFile)) continue;
    const envText = await readFile(path.join(input.projectPath, envFile), "utf8").catch(() => "");
    if (EXTERNAL_SERVICE_ENV.test(envText)) {
      services.add("外部服务（.env 声明了 DATABASE_URL / REDIS_URL / AMQP_URL 等）");
      break;
    }
  }
  return [...services].map((service) => `${service} — 沙盒未提供该外部依赖，启动会失败或需降级运行；请在确认前配置或知悉。`);
}

export async function detectProject(projectPathInput: string): Promise<ProjectDetectionResult> {
  const projectPath = resolveProjectPath(projectPathInput);
  const projectExists = await exists(projectPath);
  const pkg = projectExists ? await readJson(path.join(projectPath, "package.json")) : undefined;
  const deps = depsOf(pkg);
  const scripts = scriptsOf(pkg);
  const files = projectExists ? await readdir(projectPath).catch(() => []) : [];
  const ecosystemLaunch = projectExists && !pkg
    ? await detectNonNodeLaunch(projectPath, files)
    : undefined;
  const hasFastApi = projectExists ? await detectPythonStack(projectPath) : false;
  const frontendConfigText = projectExists ? await readFrontendConfig(projectPath) : "";
  const loginCapability = projectExists
    ? await detectLoginCapability(projectPath, deps)
    : { detected: false, confidence: "none" as const, signals: [], usernameEnv: undefined, passwordEnv: undefined };
  const apiCredentialCapability = projectExists
    ? await detectApiCredentialCapability(projectPath)
    : { detected: false, requirements: [] };
  const detectedStack: ProjectDetectionResult["detectedStack"] = [];
  if (pkg) detectedStack.push("node");
  if (deps.react) detectedStack.push("react");
  if (deps.vue) detectedStack.push("vue");
  if (deps.svelte) detectedStack.push("svelte");
  if (deps.typescript || files.some((file) => file.startsWith("tsconfig"))) detectedStack.push("typescript");
  if (deps.tailwindcss || files.some((file) => file.startsWith("tailwind.config."))) detectedStack.push("tailwind");
  if (hasFastApi || files.includes("requirements.txt") || files.includes("pyproject.toml")) detectedStack.push("python");
  if (deps.vite || /vite/i.test(Object.values(scripts).join("\n"))) detectedStack.push("vite");
  if (deps.next || files.some((file) => file === "next.config.js" || file === "next.config.mjs" || file === "next.config.ts")) detectedStack.push("next");
  if (deps.express || /express/i.test(Object.values(scripts).join("\n"))) detectedStack.push("express");
  if (hasFastApi) detectedStack.push("fastapi");
  for (const stack of ecosystemLaunch?.stack ?? []) {
    if (!detectedStack.includes(stack)) detectedStack.push(stack);
  }
  if (!detectedStack.length) detectedStack.push("unknown");

  const packageManagers = await detectPackageManagers(projectPath);
  const nodePackageManager: NodePackageManager = packageManagers.includes("pnpm")
    ? "pnpm"
    : packageManagers.includes("yarn")
      ? "yarn"
      : "npm";
  const workspaceFrontend = projectExists && pkg
    ? await detectWorkspaceFrontend(projectPath, pkg, nodePackageManager)
    : undefined;
  const workspaceBackend = projectExists && pkg
    ? await detectWorkspaceBackend(projectPath, pkg)
    : undefined;
  const rootDevScript = scripts.dev ?? "";
  const orchestratedWorkspace = Boolean(
    workspaceFrontend
    && workspaceBackend
    && /\b(?:turbo|concurrently|nx|lerna)\b/i.test(rootDevScript)
  );
  if (workspaceFrontend?.framework === "vite" && !detectedStack.includes("vite")) detectedStack.push("vite");
  if (workspaceFrontend?.framework === "next" && !detectedStack.includes("next")) detectedStack.push("next");
  if (workspaceBackend && !detectedStack.includes("express")) detectedStack.push("express");
  const hasNpmLock = projectExists && await exists(path.join(projectPath, "package-lock.json"));
  const installCommand = ecosystemLaunch?.installCommand ?? (packageManagers.includes("pnpm")
    // A monorepo may contain heavyweight test tooling (for example Cypress)
    // unrelated to the detected browser application.  Install only the
    // selected UI workspace and its dependency graph inside the sandbox. When
    // the root dev script orchestrates both UI and API, install the root lock
    // graph once so the frontend proxy does not start without its backend.
    ? orchestratedWorkspace
      ? `pnpm --filter ${workspaceBackend!.name}... --filter ${workspaceFrontend!.name}... install --frozen-lockfile`
      : workspaceFrontend?.name
      ? `pnpm --filter ${workspaceFrontend.name} install --frozen-lockfile`
      : "pnpm install --frozen-lockfile"
    : packageManagers.includes("yarn")
      ? "yarn install"
      : packageManagers.includes("uv")
        ? "uv sync"
        : packageManagers.includes("poetry")
          ? "poetry install"
          : packageManagers.includes("pip")
            ? "pip install -r requirements.txt"
            : packageManagers.includes("npm")
              ? hasNpmLock ? "npm ci" : "npm install"
              : "");
  const frontendPort = ecosystemLaunch?.port
    ?? workspaceFrontend?.port
    ?? configuredFrontendPort(scripts, frontendConfigText, detectedStack.includes("next") ? 3000 : 5173);
  const backendPort = orchestratedWorkspace
    ? workspaceBackend?.port
    : ecosystemLaunch?.processName === "api"
    ? ecosystemLaunch.port
    : detectedStack.includes("fastapi")
      ? 8000
      : detectedStack.includes("express")
        ? 3000
        : undefined;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const backendHealthPath = orchestratedWorkspace
    ? workspaceBackend?.healthPath ?? "/"
    : detectedStack.includes("fastapi")
      ? "/api/health"
      : "/api/health";
  const backendUrl = backendPort ? `http://127.0.0.1:${backendPort}${backendHealthPath}` : undefined;
  const baseDevCommand = ecosystemLaunch?.command
    ?? (orchestratedWorkspace
      ? rootWorkspaceDevCommand(nodePackageManager, workspaceFrontend!.name, workspaceBackend!.name)
      : undefined)
    ?? workspaceFrontend?.command
    ?? firstScript(scripts, ["dev", "start", "serve"])
    ?? (detectedStack.includes("fastapi") ? "python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000" : "npm run dev");
  const devCommand = detectedStack.includes("vite") && !/--host\b/.test(baseDevCommand)
    ? `${baseDevCommand} -- --host 0.0.0.0`
    : baseDevCommand;
  const processes: ProjectConfig["processes"] = [];
  if (orchestratedWorkspace) {
    processes.push({
      name: "app",
      command: baseDevCommand,
      healthCheckUrl: frontendUrl,
      required: true
    });
  } else if (ecosystemLaunch) {
    processes.push({
      name: ecosystemLaunch.processName,
      command: devCommand,
      healthCheckUrl: frontendUrl,
      required: true
    });
  } else if (detectedStack.includes("fastapi")) {
    processes.push({
      name: "api",
      command: firstScript(scripts, ["dev:api", "api", "backend"]) ?? "python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000",
      healthCheckUrl: "http://127.0.0.1:8000/api/health",
      required: true
    });
  }
  if (!orchestratedWorkspace && !ecosystemLaunch && (workspaceFrontend || detectedStack.includes("vite") || detectedStack.includes("next"))) {
    processes.push({
      name: "web",
      command: workspaceFrontend ? workspaceFrontend.command : detectedStack.includes("vite") ? `${devCommand} --port ${frontendPort} --strictPort` : devCommand,
      healthCheckUrl: frontendUrl,
      required: true
    });
  } else if (!processes.length && devCommand) {
    processes.push({ name: "app", command: devCommand, healthCheckUrl: frontendUrl, required: true });
  }

  const projectId = projectIdFromPath(projectPath);
  const installCommandSpec = commandSpec(projectExists && installCommand ? installCommand : undefined);
  const testCommand = projectExists && scripts.test
    ? packageScriptCommand(nodePackageManager, "test")
    : undefined;
  const testCommandSpec = commandSpec(testCommand, 600_000);
  const processSpecs = processes.map((process) => ({ ...process, commandSpec: commandSpec(process.command) }));
  const detectedApiOperations = projectExists ? await detectFilesystemOpenApi(projectPath) : [];
  const detectedManifest = sandboxManifest({
    projectId,
    stack: detectedStack,
    nodeEngine: nodeEngineFromPackage(pkg),
    image: ecosystemLaunch?.image,
    commandAllowlist: ecosystemLaunch?.allowlist,
    install: installCommandSpec,
    start: processSpecs[0]?.commandSpec ?? commandSpec(devCommand),
    test: testCommandSpec,
    frontendPort,
    backendPort,
    healthCheckPath: backendPort ? backendHealthPath : undefined
  });
  const suggestedConfig: ProjectConfig = {
    id: projectId,
    name: path.basename(projectPath).replace(/[-_]+/g, " "),
    projectPath,
    allowExternalProjectPath: path.isAbsolute(projectPathInput),
    installCommand: projectExists ? installCommand : "",
    installCommandSpec,
    startCommand: processes.length ? "" : devCommand,
    startCommandSpec: processes.length ? undefined : commandSpec(devCommand),
    testCommand,
    testCommandSpec,
    processes: processSpecs,
    healthCheckUrl: withHealthPath(backendUrl ?? frontendUrl, detectedManifest.healthCheck?.path),
    frontendUrl,
    backendUrl,
    login: loginCapability.detected ? {
      method: "env",
      usernameEnv: loginCapability.usernameEnv ?? "E2E_USERNAME",
      passwordEnv: loginCapability.passwordEnv ?? "E2E_PASSWORD"
    } : { method: "none" },
    apiCredentialRequirements: apiCredentialCapability.requirements,
    apiCredentialBindings: [],
    env: {},
    manifest: {
      ...detectedManifest,
      apiOperations: detectedApiOperations,
      environmentAllowlist: Array.from(new Set([
        ...detectedManifest.environmentAllowlist,
        ...apiCredentialCapability.requirements.flatMap((item) => [
          item.envName,
          item.baseUrlEnv,
          item.modelEnv
        ].filter((value): value is string => Boolean(value)))
      ]))
    },
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
  const externalServiceDependencies = projectExists
    ? await detectExternalServiceDependencies({ deps, files, projectPath })
    : [];
  const warnings = [
    projectExists ? undefined : "项目路径不存在。",
    !pkg && !ecosystemLaunch ? "没有识别到受支持的项目入口或依赖清单。" : undefined,
    apiCredentialCapability.detected
      ? `检测到项目需要 API 凭据：${apiCredentialCapability.requirements.map((item) => item.envName).join(", ")}。启动前需要明确选择凭据。`
      : undefined,
    ...externalServiceDependencies
  ].filter((item): item is string => Boolean(item));
  const plainLanguageFixes = [
    projectExists ? "项目路径可以访问。" : "请确认项目文件夹路径是否正确，或者在 Finder 中复制完整路径。",
    pkg
      ? `检测到前端/Node 项目，系统将自动准备：${installCommand || "无需安装依赖"}`
      : ecosystemLaunch
        ? `检测到 ${ecosystemLaunch.stack.join(" + ")} 项目，系统将自动在沙盒中启动。`
        : "请确认项目根目录包含框架入口或依赖清单。",
    backendUrl ? `后端健康检查建议先打开 ${backendUrl}，看到 200/ok 再运行测试。` : `前端健康检查建议先打开 ${frontendUrl}。`
  ];
  return {
    projectPath,
    exists: projectExists,
    detectionSource: "filesystem",
    executionReady: projectExists,
    detectedStack,
    packageManagers,
    loginCapability,
    apiCredentialCapability,
    externalServiceDependencies,
    suggestedConfig,
    ports,
    healthCandidates,
    warnings,
    plainLanguageFixes
  };
}

export async function detectProjectManifest(input: {
  rootName: string;
  files: Array<{ relativePath: string; content?: string }>;
}): Promise<ProjectDetectionResult> {
  const normalizedRoot = input.rootName.trim() || "uploaded-project";
  const safeRootName = path.basename(normalizedRoot);
  const configuredDiscoveryRoots = (process.env.PROJECT_DISCOVERY_ROOTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const developmentDiscoveryRoots = process.env.NODE_ENV === "development"
    ? [rootDir, path.dirname(rootDir), path.dirname(path.dirname(rootDir))]
    : [];
  const discoveryRoots = Array.from(new Set([...configuredDiscoveryRoots, ...developmentDiscoveryRoots]));
  for (const discoveryRoot of discoveryRoots) {
    const candidate = path.resolve(discoveryRoot, safeRootName);
    if (path.dirname(candidate) !== discoveryRoot || !await exists(candidate)) continue;
    const detected = await detectProject(candidate);
    if (detected.exists) return detected;
  }

  const fileNames = input.files.map((file) => file.relativePath.replaceAll("\\", "/"));
  const packageEntry = input.files.find((file) => /(^|\/)package\.json$/i.test(file.relativePath));
  let pkg: Record<string, unknown> | undefined;
  try {
    pkg = packageEntry?.content ? JSON.parse(packageEntry.content) as Record<string, unknown> : undefined;
  } catch {
    pkg = undefined;
  }
  const dependencyNames = depsOf(pkg);
  const scripts = scriptsOf(pkg);
  const textFiles = input.files.map((file) => file.content ?? "").join("\n");
  const manifestApiRequirements = new Map<string, ReturnType<typeof apiCredentialRequirement>>();
  for (const file of input.files) {
    for (const envName of apiCredentialNames((file.content ?? "").slice(0, 250_000))) {
      const signal = `env:${file.relativePath}:${envName}`;
      const existing = manifestApiRequirements.get(envName);
      if (existing) existing.signals = Array.from(new Set([...existing.signals, signal])).slice(0, 8);
      else manifestApiRequirements.set(envName, apiCredentialRequirement(envName, signal));
    }
  }
  const apiCredentialCapability = {
    detected: manifestApiRequirements.size > 0,
    requirements: [...manifestApiRequirements.values()]
  };
  const detectedStack: ProjectDetectionResult["detectedStack"] = [];
  if (packageEntry) detectedStack.push("node");
  if (dependencyNames.react) detectedStack.push("react");
  if (dependencyNames.vue) detectedStack.push("vue");
  if (dependencyNames.svelte) detectedStack.push("svelte");
  if (dependencyNames.typescript || fileNames.some((name) => /(^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(name))) detectedStack.push("typescript");
  if (dependencyNames.tailwindcss || fileNames.some((name) => /(^|\/)tailwind\.config\.[^/]+$/i.test(name))) detectedStack.push("tailwind");
  if (fileNames.some((name) => /(^|\/)(requirements\.txt|pyproject\.toml)$/i.test(name))) detectedStack.push("python");
  if (dependencyNames.vite || /vite/i.test(Object.values(scripts).join("\n")) || fileNames.some((name) => /(^|\/)vite\.config\.[^/]+$/i.test(name))) detectedStack.push("vite");
  if (dependencyNames.next || fileNames.some((name) => /(^|\/)next\.config\.[^/]+$/i.test(name))) detectedStack.push("next");
  if (dependencyNames.express || /express/i.test(Object.values(scripts).join("\n"))) detectedStack.push("express");
  if (/fastapi|uvicorn/i.test(textFiles) || fileNames.some((name) => /(^|\/)backend\/app\.py$/i.test(name))) detectedStack.push("fastapi");
  if (!detectedStack.length) detectedStack.push("unknown");

  const packageManagers: ProjectDetectionResult["packageManagers"] = [];
  if (fileNames.some((name) => /(^|\/)package-lock\.json$/i.test(name))) packageManagers.push("npm");
  if (fileNames.some((name) => /(^|\/)pnpm-lock\.yaml$/i.test(name))) packageManagers.push("pnpm");
  if (fileNames.some((name) => /(^|\/)yarn\.lock$/i.test(name))) packageManagers.push("yarn");
  if (fileNames.some((name) => /(^|\/)requirements\.txt$/i.test(name))) packageManagers.push("pip");
  if (fileNames.some((name) => /(^|\/)uv\.lock$/i.test(name))) packageManagers.push("uv");
  if (fileNames.some((name) => /(^|\/)poetry\.lock$/i.test(name))) packageManagers.push("poetry");
  if (!packageManagers.length && packageEntry) packageManagers.push("npm");
  const nodePackageManager: NodePackageManager = packageManagers.includes("pnpm")
    ? "pnpm"
    : packageManagers.includes("yarn")
      ? "yarn"
      : "npm";

  const frontendPort = configuredFrontendPort(scripts, textFiles, detectedStack.includes("next") ? 3000 : 5173);
  const backendPort = detectedStack.includes("fastapi") ? 8000 : detectedStack.includes("express") ? 3000 : undefined;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  const backendUrl = backendPort ? `http://127.0.0.1:${backendPort}/api/health` : undefined;
  const installCommand = packageManagers.includes("pnpm") ? "pnpm install" : packageManagers.includes("yarn") ? "yarn install" : packageManagers.includes("pip") ? "pip install -r requirements.txt" : "npm install";
  const resolvedInstallCommand = packageManagers.includes("npm") && fileNames.some((name) => /(^|\/)package-lock\.json$/i.test(name))
    ? "npm ci"
    : installCommand;
  const baseDevCommand = firstScript(scripts, ["dev", "start", "serve"]) ?? (detectedStack.includes("fastapi") ? "python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000" : "npm run dev");
  const devCommand = detectedStack.includes("vite") && !/--host\b/.test(baseDevCommand)
    ? `${baseDevCommand} -- --host 0.0.0.0 --port ${frontendPort} --strictPort`
    : baseDevCommand;
  const now = new Date().toISOString();
  const projectId = projectIdFromPath(normalizedRoot);
  const detectedApiOperations = detectUploadedOpenApi(input.files);
  const installCommandSpec = commandSpec(resolvedInstallCommand);
  const startCommandSpec = commandSpec(devCommand);
  const testCommand = scripts.test ? packageScriptCommand(nodePackageManager, "test") : undefined;
  const testCommandSpec = commandSpec(testCommand, 600_000);
  // Hoisted so the manifest's declared health path can shape healthCheckUrl
  // below, instead of the path being dead metadata that never reaches the probe.
  const detectedManifest = (() => {
    const manifest = sandboxManifest({
      projectId,
      stack: detectedStack,
      nodeEngine: nodeEngineFromPackage(pkg),
      install: installCommandSpec,
      start: startCommandSpec,
      test: testCommandSpec,
      frontendPort,
      backendPort,
      healthCheckPath: backendPort ? "/api/health" : undefined
    });
    return {
      ...manifest,
      apiOperations: detectedApiOperations,
      environmentAllowlist: Array.from(new Set([
        ...manifest.environmentAllowlist,
        ...apiCredentialCapability.requirements.flatMap((item) => [
          item.envName,
          item.baseUrlEnv,
          item.modelEnv
        ].filter((value): value is string => Boolean(value)))
      ]))
    };
  })();
  const suggestedConfig: ProjectConfig = {
    id: projectId,
    name: normalizedRoot.replace(/[-_]+/g, " "),
    projectPath: normalizedRoot,
    allowExternalProjectPath: true,
    installCommand: resolvedInstallCommand,
    installCommandSpec,
    startCommand: devCommand,
    startCommandSpec,
    testCommand,
    testCommandSpec,
    healthCheckUrl: withHealthPath(backendUrl ?? frontendUrl, detectedManifest.healthCheck?.path),
    frontendUrl,
    backendUrl,
    login: { method: "none" },
    apiCredentialRequirements: apiCredentialCapability.requirements,
    apiCredentialBindings: [],
    env: {},
    manifest: detectedManifest,
    timeoutMs: 30_000,
    createdAt: now,
    updatedAt: now
  };
  const portValues = Array.from(new Set([frontendPort, backendPort].filter((value): value is number => Boolean(value))));
  const ports = await Promise.all(portValues.map(async (port) => ({
    port,
    purpose: port === frontendPort ? "frontend" as const : "backend" as const,
    status: await portStatus(port),
    url: `http://127.0.0.1:${port}`
  })));
  const recognized = Boolean(packageEntry || detectedStack.some((stack) => stack !== "unknown"));
  const dependencyLoginSignals = [
    ...["@supabase/supabase-js", "next-auth", "@auth/core", "passport", "firebase", "@auth0/auth0-react"]
      .filter((dependency) => Boolean(dependencyNames[dependency]))
      .map((dependency) => `dependency:${dependency}`),
  ];
  const implementationLoginSignals = [
    ...fileNames
      .filter((name) => /(^|\/)(login|sign-?in|sign-?up)(\/|\.|-|_)/i.test(name))
      .slice(0, 12)
      .map((name) => `path:${name}`),
    ...input.files
      .filter((file) => {
        const sample = (file.content ?? "").slice(0, 250_000);
        const hasLoginCall = /signInWithPassword|signInWithEmailAndPassword|passport\.authenticate|authenticateUser|\/api\/(?:auth\/)?login/i.test(sample);
        const hasIdentityField = /(?:name|id|type)\s*=\s*["'](?:email|username|user)["']/i.test(sample);
        const hasPasswordField = /(?:name|id|type)\s*=\s*["']password["']/i.test(sample);
        return hasLoginCall || (hasIdentityField && hasPasswordField);
      })
      .slice(0, 12)
      .map((file) => `code:${file.relativePath}`)
  ];
  const uniqueImplementationLoginSignals = Array.from(new Set(implementationLoginSignals));
  const uniqueLoginSignals = Array.from(new Set([...uniqueImplementationLoginSignals, ...dependencyLoginSignals]));
  const manifestText = input.files.map((file) => file.content ?? "").join("\n").slice(0, 1_000_000);
  const usernameEnv = /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]*(?:USER|EMAIL|LOGIN)[A-Z0-9_]*)/.exec(manifestText)?.[1];
  const passwordEnv = /(?:process\.env\.|import\.meta\.env\.)([A-Z0-9_]*(?:PASSWORD|PASSWD|PWD)[A-Z0-9_]*)/.exec(manifestText)?.[1];
  return {
    projectPath: normalizedRoot,
    exists: recognized,
    detectionSource: "browser-manifest",
    executionReady: false,
    detectedStack,
    packageManagers,
    loginCapability: {
      detected: uniqueImplementationLoginSignals.length > 0,
      confidence: uniqueImplementationLoginSignals.some((signal) => signal.startsWith("path:")) ? "high" : uniqueImplementationLoginSignals.length ? "medium" : "none",
      signals: uniqueLoginSignals,
      usernameEnv,
      passwordEnv
    },
    apiCredentialCapability,
    suggestedConfig,
    ports,
    healthCandidates: [backendUrl, frontendUrl].filter((value): value is string => Boolean(value)),
    warnings: recognized
      ? ["浏览器已识别项目清单，但不会暴露本机完整路径；运行前需要填写项目完整路径。"]
      : ["选择的目录中没有找到可识别的 package.json、Python 清单或框架配置。"],
    plainLanguageFixes: recognized
      ? ["项目类型已识别。请在下方 Target Project 的“项目路径”中粘贴 Finder 显示的完整路径。"]
      : ["请确认选择的是项目根目录，而不是 dist、build 或单独的子目录。"]
  };
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
  const storedProject = await getProject(id);
  if (!storedProject) {
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
  const project = projectWithActiveRuntime(storedProject);
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
      apiCredential: {
        ok: false,
        requirements: (project.apiCredentialRequirements ?? []).map((item) => ({
          envName: item.envName,
          configured: false,
          exposure: item.exposure
        })),
        missingEnv: (project.apiCredentialRequirements ?? []).map((item) => item.envName)
      },
      checkedAt: new Date().toISOString(),
      durationMs: 0,
      message: error instanceof Error ? error.message : "项目诊断失败。"
    };
  }
  const detection = await detectProject(project.projectPath);
  const portConflicts = connection.ok ? [] : detection.ports
    .filter((port) => port.status === "listening")
    .map((port) => ({
      port: port.port,
      fix: project.manifest?.execution.mode === "oci"
        ? "目标地址当前无响应；沙盒启动时应改用空闲的宿主机映射端口。"
        : "目标地址当前无响应，请改用空闲端口；系统不会终止来源不明的本机进程。"
    }));
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
      passed: connection.credential.ok && connection.apiCredential.ok,
      reason: connection.credential.ok && connection.apiCredential.ok ? "credential_ok" : "credential_missing",
      humanMessage: !connection.credential.ok
        ? `缺少测试账号环境变量：${connection.credential.missingEnv.join(", ") || "未配置"}`
        : !connection.apiCredential.ok
          ? `项目需要 API 凭据：${connection.apiCredential.missingEnv.join(", ")}。请在 AI 测试助手中选择安全凭据。`
          : "测试账号和项目 API 凭据均可用。",
      suggestedCommands: [],
      missingEnv: [...connection.credential.missingEnv, ...connection.apiCredential.missingEnv]
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
      humanMessage: portConflicts.length ? "目标地址无法连接，并且端口已由其他进程占用。" : connection.ok ? "目标项目已经连接，不需要处理端口。" : "没有检测到端口冲突。",
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
