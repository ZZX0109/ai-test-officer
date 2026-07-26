import { spawn } from "node:child_process";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { commandSpecSchema, defaultResourceBudget, projectManifestSchema, type CommandSpec, type ProjectManifest, type ResourceBudget } from "@ai-test-officer/contracts";

export type RuntimeFailureReason =
  | "command_not_found"
  | "dependency_missing"
  | "port_conflict"
  | "health_timeout"
  | "early_exit"
  | "permission_denied"
  | "container_runtime_unavailable"
  | "budget_exceeded"
  | "cancelled"
  | "unknown";

export function classifyRuntimeFailure(error: unknown, stderr = ""): RuntimeFailureReason {
  const text = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.toLowerCase();
  if (/docker (api|daemon)|docker\.sock|podman.*socket|cannot connect to.*container/.test(text)) return "container_runtime_unavailable";
  if (/enoent|command not found|not recognized/.test(text)) return "command_not_found";
  if (/cannot find module|module not found|missing dependency|npm err.*enoent/.test(text)) return "dependency_missing";
  if (/eaddrinuse|address already in use|port.*in use/.test(text)) return "port_conflict";
  if (/enospc|no space left on device|disk quota exceeded|exit code 137|\bkilled\b|oomkilled/.test(text)) return "budget_exceeded";
  if (/health.*timeout|aborterror/.test(text)) return "health_timeout";
  if (/eacces|eperm|permission denied|library load disallowed by system policy|code signature.*not valid/.test(text)) return "permission_denied";
  if (/budget|timed out|timeout/.test(text)) return "budget_exceeded";
  if (/cancel|abort/.test(text)) return "cancelled";
  if (/exited|exit code/.test(text)) return "early_exit";
  return "unknown";
}

export function resolveManifestWorkspace(manifest: ProjectManifest, repositoryRoot: string) {
  const root = path.resolve(repositoryRoot);
  const workspace = path.resolve(root, manifest.workspaceRoot);
  if (workspace !== root && !workspace.startsWith(`${root}${path.sep}`)) throw new Error("workspace_path_escape");
  return workspace;
}

export function environmentFromAllowlist(manifest: ProjectManifest, source: NodeJS.ProcessEnv) {
  return Object.fromEntries(manifest.environmentAllowlist.filter((name: string) => source[name] !== undefined).map((name: string) => [name, source[name]!])) as Record<string, string>;
}

async function allocateEphemeralPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function allocateManifestPorts(manifest: ProjectManifest) {
  const entries: Array<[string, string]> = [];
  for (const requested of manifest.ports) entries.push([requested.env, String(await allocateEphemeralPort())]);
  return Object.fromEntries(entries);
}

export class BudgetTracker {
  private steps = 0;
  private screenshots = 0;
  private artifactBytes = 0;
  constructor(readonly budget: ResourceBudget = defaultResourceBudget) {}
  consume(input: { steps?: number; screenshots?: number; artifactBytes?: number }) {
    this.steps += input.steps ?? 0;
    this.screenshots += input.screenshots ?? 0;
    this.artifactBytes += input.artifactBytes ?? 0;
    if (this.steps > this.budget.maxSteps || this.screenshots > this.budget.maxScreenshots || this.artifactBytes > this.budget.maxArtifactBytes) {
      throw new Error("budget_exceeded");
    }
  }
}

export interface LocalCommandResult { exitCode: number | null; stdout: string; stderr: string; failureReason?: RuntimeFailureReason }

export async function runAllowlistedCommand(input: {
  command: CommandSpec;
  cwd: string;
  env: Record<string, string>;
  allowedExecutables: string[];
  signal?: AbortSignal;
  maxLogBytes?: number;
}): Promise<LocalCommandResult> {
  const command = commandSpecSchema.parse(input.command);
  if (!input.allowedExecutables.includes(command.executable)) throw new Error(`command_not_allowed:${command.executable}`);
  const maxLogBytes = input.maxLogBytes ?? defaultResourceBudget.maxLogBytes;
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, { cwd: input.cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...input.env }, detached: process.platform !== "win32", shell: false });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-maxLogBytes);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (!child.pid) return;
      try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    };
    const timer = setTimeout(terminate, command.timeoutMs ?? defaultResourceBudget.stepTimeoutMs);
    input.signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", (error) => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr, failureReason: classifyRuntimeFailure(error, stderr) }); });
    child.once("exit", (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, failureReason: exitCode === 0 ? undefined : classifyRuntimeFailure(`exit code ${exitCode}`, stderr) }); });
  });
}

export function buildOciInvocation(input: {
  engine: "docker" | "podman";
  image: string;
  manifest: ProjectManifest;
  repositoryRoot: string;
  command: CommandSpec;
  prepareCommand?: CommandSpec;
  portBindings?: Array<{ hostPort: number; containerPort: number }>;
  dependencyCache?: {
    key: string;
    sourceFingerprint: string;
    storageMode?: "bind" | "volume";
    workspaceRoot: string;
    packageCacheRoot: string;
    metadataRoot?: string;
    workspaceVolume?: string;
    packageCacheVolume?: string;
  };
}) {
  const manifest = projectManifestSchema.parse(input.manifest);
  for (const command of [input.prepareCommand, input.command].filter((item): item is CommandSpec => Boolean(item))) {
    if (!manifest.commandAllowlist.includes(command.executable)) {
      throw new Error(`command_not_allowed:${command.executable}`);
    }
  }
  const workspace = resolveManifestWorkspace(manifest, input.repositoryRoot);
  const token = createHash("sha256").update(`${manifest.projectId}:${randomUUID()}`).digest("hex").slice(0, 20);
  const containerName = `ato-${manifest.projectId}-${token}`;
  const network = manifest.network.mode === "deny" ? "none" : "bridge";
  const environmentArgs = manifest.environmentAllowlist.flatMap((name) => ["--env", name]);
  const portArgs = (input.portBindings ?? []).flatMap(({ hostPort, containerPort }) => [
    "--publish", `127.0.0.1:${hostPort}:${containerPort}`
  ]);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const dependencyCache = input.dependencyCache
    ? {
      key: input.dependencyCache.key.replace(/[^a-zA-Z0-9_.-]/g, "_"),
      sourceFingerprint: input.dependencyCache.sourceFingerprint.replace(/[^a-zA-Z0-9_.-]/g, "_"),
      storageMode: input.dependencyCache.storageMode ?? "bind",
      workspaceRoot: path.resolve(input.dependencyCache.workspaceRoot),
      packageCacheRoot: path.resolve(input.dependencyCache.packageCacheRoot),
      metadataRoot: input.dependencyCache.metadataRoot ? path.resolve(input.dependencyCache.metadataRoot) : undefined,
      workspaceVolume: input.dependencyCache.workspaceVolume?.replace(/[^a-zA-Z0-9_.-]/g, "_"),
      packageCacheVolume: input.dependencyCache.packageCacheVolume?.replace(/[^a-zA-Z0-9_.-]/g, "_")
    }
    : undefined;
  // Official Node images ship Corepack but do not activate pnpm/yarn shims by
  // default. Keep package-manager downloads in the project-scoped dependency
  // cache so later sandbox launches do not download Corepack or packages again.
  const requiresCorepack = [input.prepareCommand, input.command]
    .filter((item): item is CommandSpec => Boolean(item))
    .some((command) => command.executable === "pnpm" || command.executable === "yarn");
  const packageManagerBootstrap = requiresCorepack
    ? dependencyCache
      ? "mkdir -p /workspace/.ato-bin /sandbox-cache/corepack; export COREPACK_HOME=/sandbox-cache/corepack; corepack enable --install-directory /workspace/.ato-bin; export PATH=/workspace/.ato-bin:$PATH"
      : "mkdir -p /tmp/ato-bin /tmp/ato-corepack; export COREPACK_HOME=/tmp/ato-corepack; corepack enable --install-directory /tmp/ato-bin; export PATH=/tmp/ato-bin:$PATH"
    : "";
  // Some checked-in Vite/CRA configurations force a browser open even when
  // the discovered command does not pass --open.  The sandbox has no desktop
  // session by design; intercept that Linux helper so it cannot crash the
  // target or create an external browser.  The Workbench preview remains the
  // sole visual surface.
  const internalBrowserOnly = "mkdir -p /workspace/.ato-bin; printf '#!/bin/sh\\nexit 0\\n' > /workspace/.ato-bin/xdg-open; chmod 700 /workspace/.ato-bin/xdg-open; export PATH=/workspace/.ato-bin:$PATH";
  const runtimePathBootstrap = "export PATH=/workspace/.venv/bin:/workspace/.ato-bin:$PATH";
  const prepareCommand = input.prepareCommand
    ? [input.prepareCommand.executable, ...input.prepareCommand.args].map(shellQuote).join(" ")
    : "";
  const prepare = prepareCommand && dependencyCache
    ? [
      `cache_marker=${dependencyCache.storageMode === "volume" ? "/sandbox-meta" : "/sandbox-cache"}/prepared-${dependencyCache.key}`,
      `cache_lock=${dependencyCache.storageMode === "volume" ? "/sandbox-meta" : "/sandbox-cache"}/preparing-${dependencyCache.key}`,
      "if [ -f \"$cache_marker\" ]; then echo ATO_DEPENDENCY_CACHE_HIT",
      "else cache_owner=0",
      "while [ \"$cache_owner\" -eq 0 ] && [ ! -f \"$cache_marker\" ]; do if mkdir \"$cache_lock\" 2>/dev/null; then cache_owner=1; else sleep 1; fi; done",
      "if [ \"$cache_owner\" -eq 1 ]; then trap 'rmdir \"$cache_lock\" 2>/dev/null || true' EXIT INT TERM",
      prepareCommand,
      "touch \"$cache_marker\"; rmdir \"$cache_lock\"; trap - EXIT INT TERM",
      "else echo ATO_DEPENDENCY_CACHE_HIT; fi; fi"
    ].join("; ")
    : prepareCommand;
  const workspaceBootstrap = dependencyCache
    ? [
      `source_marker=/workspace/.ato-source-${dependencyCache.sourceFingerprint}`,
      "if [ -f \"$source_marker\" ]; then echo ATO_SOURCE_CACHE_HIT",
      "else find /workspace -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .python-packages ! -name .venv ! -name venv ! -name .bundle ! -name vendor ! -name .ato-bin -exec rm -rf {} +",
      "tar -C /source --exclude=node_modules --exclude=.git --exclude=dist --exclude=build -cf - . | tar -C /workspace -xf -",
      "rm -f /workspace/.ato-source-*; touch \"$source_marker\"; fi"
    ].join("; ")
    : "tar -C /source --exclude=node_modules --exclude=.git --exclude=dist --exclude=build -cf - . | tar -C /workspace -xf -";
  const bootstrap = [
    "set -eu",
    "mkdir -p /workspace",
    workspaceBootstrap,
    internalBrowserOnly,
    runtimePathBootstrap,
    packageManagerBootstrap,
    prepare,
    "exec \"$@\""
  ].filter(Boolean).join("; ");
  return {
    executable: input.engine,
    args: [
      "run", "--rm", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      // Keep each sandbox within the documented 4 GiB production budget. The
      // Agent prevents duplicate containers for the same project, so a stale
      // runtime cannot silently consume the Docker VM's remaining memory.
      "--cpus", "2", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "256", "--user", "65532:65532", "--network", network,
      "--label", "ai-test-officer.managed=true",
      "--label", `ai-test-officer.project-id=${manifest.projectId}`,
      ...portArgs,
      "--env", "HOME=/tmp",
      "--env", `npm_config_cache=${dependencyCache ? "/sandbox-cache/npm" : "/tmp/npm-cache"}`,
      "--env", `npm_config_store_dir=${dependencyCache ? "/sandbox-cache/pnpm-store" : "/tmp/pnpm-store"}`,
      "--env", "npm_config_prefer_offline=true",
      "--env", `YARN_CACHE_FOLDER=${dependencyCache ? "/sandbox-cache/yarn" : "/tmp/yarn-cache"}`,
      "--env", `PIP_CACHE_DIR=${dependencyCache ? "/sandbox-cache/pip" : "/tmp/pip-cache"}`,
      "--env", "PIP_TARGET=/workspace/.python-packages",
      "--env", "PYTHONPATH=/workspace/.python-packages",
      "--env", "POETRY_VIRTUALENVS_IN_PROJECT=true",
      "--env", `GOPATH=${dependencyCache ? "/sandbox-cache/go" : "/tmp/go"}`,
      "--env", `GOMODCACHE=${dependencyCache ? "/sandbox-cache/go/pkg/mod" : "/tmp/go/pkg/mod"}`,
      "--env", `GOCACHE=${dependencyCache ? "/sandbox-cache/go-build" : "/tmp/go-build"}`,
      "--env", `CARGO_HOME=${dependencyCache ? "/sandbox-cache/cargo" : "/tmp/cargo"}`,
      "--env", `CARGO_TARGET_DIR=${dependencyCache ? "/sandbox-cache/cargo-target" : "/tmp/cargo-target"}`,
      "--env", `GRADLE_USER_HOME=${dependencyCache ? "/sandbox-cache/gradle" : "/tmp/gradle"}`,
      "--env", `MAVEN_OPTS=-Dmaven.repo.local=${dependencyCache ? "/sandbox-cache/maven/repository" : "/tmp/maven/repository"}`,
      "--env", `BUNDLE_PATH=${dependencyCache ? "/sandbox-cache/bundle" : "/tmp/bundle"}`,
      "--env", `GEM_HOME=${dependencyCache ? "/sandbox-cache/gems" : "/tmp/gems"}`,
      "--env", `GEM_PATH=${dependencyCache ? "/sandbox-cache/gems" : "/tmp/gems"}`,
      "--env", `COMPOSER_HOME=${dependencyCache ? "/sandbox-cache/composer" : "/tmp/composer"}`,
      "--env", `COMPOSER_CACHE_DIR=${dependencyCache ? "/sandbox-cache/composer-cache" : "/tmp/composer-cache"}`,
      ...environmentArgs,
      "--mount", `type=bind,src=${workspace},dst=/source,readonly`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=3g",
      ...(dependencyCache
        ? dependencyCache.storageMode === "volume"
          && dependencyCache.workspaceVolume
          && dependencyCache.packageCacheVolume
          && dependencyCache.metadataRoot
          ? [
            "--mount", `type=volume,src=${dependencyCache.workspaceVolume},dst=/workspace,volume-nocopy`,
            "--mount", `type=volume,src=${dependencyCache.packageCacheVolume},dst=/sandbox-cache,volume-nocopy`,
            "--mount", `type=bind,src=${dependencyCache.metadataRoot},dst=/sandbox-meta`
          ]
          : [
            "--mount", `type=bind,src=${dependencyCache.workspaceRoot},dst=/workspace`,
            "--mount", `type=bind,src=${dependencyCache.packageCacheRoot},dst=/sandbox-cache`
          ]
        : ["--tmpfs", "/workspace:rw,exec,nosuid,size=3g,uid=65532,gid=65532"]),
      "--workdir", "/workspace",
      "--name", containerName,
      "--entrypoint", "/bin/sh", input.image,
      "-c", bootstrap, "ato-entrypoint", input.command.executable, ...input.command.args
    ],
    cleanupToken: token,
    containerName
  };
}
