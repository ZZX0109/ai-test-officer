import { spawn } from "node:child_process";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { commandSpecSchema, defaultResourceBudget, projectManifestSchema, type CommandSpec, type ProjectManifest, type ResourceBudget, type ReadinessReport } from "@ai-test-officer/contracts";
export { buildRunScopedProxyUrl, createEgressNetworkController, createIsolatedNetworkController, egressNetworkName, isolatedNetworkName, type EgressCommandRunner, type EgressNetworkHandle } from "./egressNetworkController.js";

export function networkPolicyHash(network: ProjectManifest["network"]) {
  return createHash("sha256").update(JSON.stringify({
    mode: network.mode,
    enforcement: network.enforcement,
    allowedHosts: [...network.allowedHosts].sort(),
    allowedPorts: [80, 443]
  })).digest("hex");
}

export interface ExecutionEnvironment<TargetHandle = unknown, BrowserHandle = unknown, EvidenceItem = unknown> {
  prepare(): Promise<ReadinessReport>;
  launchTarget(): Promise<TargetHandle>;
  launchBrowser(): Promise<BrowserHandle>;
  collectArtifacts(): Promise<EvidenceItem[]>;
  teardown(): Promise<void>;
}

export function createExecutionEnvironment<TTarget, TBrowser, TEvidence>(input: ExecutionEnvironment<TTarget, TBrowser, TEvidence>) {
  let state: "new" | "prepared" | "target-launched" | "browser-launched" | "collected" | "closed" = "new";
  let preparedReport: ReadinessReport | undefined;
  let preparePromise: Promise<ReadinessReport> | undefined;
  let teardownPromise: Promise<void> | undefined;
  return {
    async prepare() {
      if (state === "closed") throw new Error("execution_environment_closed");
      if (preparedReport) return preparedReport;
      if (!preparePromise) {
        preparePromise = (async () => {
          const report = await input.prepare();
          if (report.status === "blocked") throw new Error("execution_environment_not_ready");
          preparedReport = report;
          state = "prepared";
          return report;
        })();
      }
      return preparePromise;
    },
    async launchTarget() {
      if (state === "new") await this.prepare();
      if (state === "closed") throw new Error("execution_environment_closed");
      if (state === "prepared") {
        const target = await input.launchTarget();
        state = "target-launched";
        return target;
      }
      throw new Error(`execution_environment_invalid_state:${state}:launchTarget`);
    },
    async launchBrowser() {
      if (state === "new") await this.prepare();
      if (state === "prepared") await this.launchTarget();
      if (state === "closed") throw new Error("execution_environment_closed");
      if (state === "target-launched") {
        const browser = await input.launchBrowser();
        state = "browser-launched";
        return browser;
      }
      throw new Error(`execution_environment_invalid_state:${state}:launchBrowser`);
    },
    async collectArtifacts() {
      if (state === "new" || state === "prepared" || state === "target-launched") await this.launchBrowser();
      if (state === "closed") throw new Error("execution_environment_closed");
      if (state === "browser-launched") {
        const artifacts = await input.collectArtifacts();
        state = "collected";
        return artifacts;
      }
      throw new Error(`execution_environment_invalid_state:${state}:collectArtifacts`);
    },
    async teardown() {
      if (teardownPromise) return teardownPromise;
      teardownPromise = (async () => {
        if (state === "closed") return;
        state = "closed";
        await input.teardown();
      })();
      return teardownPromise;
    }
  } satisfies ExecutionEnvironment<TTarget, TBrowser, TEvidence>;
}

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
  if (/docker (api|daemon)|docker\.sock|cannot connect to.*container/.test(text)) return "container_runtime_unavailable";
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

export type AllowlistedProcessInvocation = {
  executable: string;
  args: string[];
  timeoutMs?: number;
};

async function runAllowlistedProcess(input: {
  command: AllowlistedProcessInvocation;
  cwd: string;
  env: Record<string, string>;
  allowedExecutables: string[];
  signal?: AbortSignal;
  maxLogBytes?: number;
}): Promise<LocalCommandResult> {
  const command = input.command;
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

/**
 * Runs a generated host-process invocation after checking its executable.
 * Project commands use runAllowlistedCommand and remain bounded by
 * commandSpecSchema; generated wrappers such as `docker` can legitimately
 * need more than 128 argv entries for mounts, environment, and policy flags.
 */
export function runAllowlistedInvocation(input: {
  command: AllowlistedProcessInvocation;
  cwd: string;
  env: Record<string, string>;
  allowedExecutables: string[];
  signal?: AbortSignal;
  maxLogBytes?: number;
}): Promise<LocalCommandResult> {
  return runAllowlistedProcess(input);
}

export function runAllowlistedCommand(input: {
  command: CommandSpec;
  cwd: string;
  env: Record<string, string>;
  allowedExecutables: string[];
  signal?: AbortSignal;
  maxLogBytes?: number;
}): Promise<LocalCommandResult> {
  const command = commandSpecSchema.parse(input.command);
  return runAllowlistedProcess({ ...input, command });
}

export function buildOciInvocation(input: {
  engine: "docker";
  image: string;
  manifest: ProjectManifest;
  repositoryRoot: string;
  command: CommandSpec;
  prepareCommand?: CommandSpec;
  /** Host variables available to Docker via `--env NAME`; values never enter argv. */
  environment?: Record<string, string | undefined>;
  /**
   * Optional immutable source of pre-installed dependencies. Repair workspaces
   * intentionally exclude node_modules, so they cannot be the dependency
   * source when the target project already has a populated dependency tree.
   */
  preinstalledDependencyRoot?: string;
  /** Keep a source dependency tree from being mutated by the sandbox. */
  preinstalledDependencyReadOnly?: boolean;
  networkName?: string;
  proxyUrl?: string;
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
  resources?: {
    cpus?: number;
    memoryGiB?: number;
    pidsLimit?: number;
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
  const networkPolicy = manifest.network;
  // Deny-policy runs receive a run-scoped internal bridge from the Agent when
  // a browser port must be published. Keep `none` as the direct-call fallback
  // for non-browser commands and unit-level invocation tests.
  const network = networkPolicy.mode === "deny"
    ? input.networkName ?? process.env.ATO_DENY_NETWORK_NAME ?? "none"
    : input.networkName ?? process.env.ATO_EGRESS_NETWORK_NAME;
  const proxyUrl = input.proxyUrl ?? process.env.ATO_EGRESS_PROXY_URL;
  if (networkPolicy.mode !== "deny") {
    if (networkPolicy.enforcement !== "external-egress-proxy") {
      throw new Error("network_policy_enforcement_required");
    }
    if (!network || !/^ato-egress-[a-zA-Z0-9_.-]+$/.test(network)) {
      throw new Error("egress_network_not_configured");
    }
    if (!proxyUrl || !/^https?:\/\/[^\s/]+(?::\d+)?$/i.test(proxyUrl)) {
      throw new Error("egress_proxy_not_configured");
    }
    if (networkPolicy.allowedHosts.length === 0) {
      throw new Error("egress_allowed_hosts_missing");
    }
  }
  if (networkPolicy.mode === "deny" && network !== "none" && (!network || !/^ato-isolated-[a-zA-Z0-9_.-]+$/.test(network))) {
    throw new Error("isolated_network_not_configured");
  }
  const networkPolicySha256 = networkPolicyHash(networkPolicy);
  const parallelRuntime = (input.portBindings?.length ?? 0) > 1
    || input.command.args.includes("--parallel")
    || manifest.ports.length > 1;
  // Multi-service monorepos can exceed 4 GiB briefly while the frontend and
  // backend compile together. If only esbuild is OOM-killed, Vite keeps its
  // port open and looks healthy while serving an error overlay. Scale this
  // generic profile from the manifest shape, never from a project name.
  const memoryGiB = Math.min(6, Math.max(1, input.resources?.memoryGiB ?? (parallelRuntime ? 6 : 4)));
  const cpus = Math.min(4, Math.max(1, input.resources?.cpus ?? (parallelRuntime ? 3 : 2)));
  const pidsLimit = Math.min(512, Math.max(64, input.resources?.pidsLimit ?? (parallelRuntime ? 384 : 256)));
  const preinstalledDependencies = Boolean(manifest.execution.preinstalledDependencies);
  const preinstalledDependencyImageRoot = manifest.execution.preinstalledDependencyImageRoot;
  const useImagePreinstalledDependencies = preinstalledDependencies && Boolean(preinstalledDependencyImageRoot);
  const availableEnvironment = input.environment ?? process.env;
  const environmentArgs = manifest.environmentAllowlist.flatMap((name) => availableEnvironment[name] === undefined ? [] : ["--env", name]);
  const preinstalledDependencyRoot = path.resolve(input.preinstalledDependencyRoot ?? workspace);
  // Workspace copies intentionally exclude dependency trees. A monorepo can
  // still keep package-local node_modules directories (pnpm's layout), so
  // mount the root plus the first two source levels without traversing the
  // dependency tree itself.
  const preinstalledNodeModules = (() => {
    if (!preinstalledDependencies || useImagePreinstalledDependencies) return [] as string[];
    const roots: string[] = [];
    const visit = (directory: string, depth: number) => {
      const dependencyDirectory = path.join(directory, "node_modules");
      if (existsSync(dependencyDirectory)) roots.push(dependencyDirectory);
      if (depth === 0) return;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        visit(path.join(directory, entry.name), depth - 1);
      }
    };
    visit(preinstalledDependencyRoot, 2);
    return [...new Set(roots)];
  })();
  const preinstalledNodeModulesMount = preinstalledNodeModules.flatMap((dependencyDirectory, index) => {
    const relative = path.relative(preinstalledDependencyRoot, dependencyDirectory).replaceAll(path.sep, "/");
    // The root node_modules mount preserves Node's package-resolution rules
    // (the directory must literally be named node_modules). Do not mount
    // package-local trees directly below /workspace/<package>: Docker creates
    // those parent directories as root before uid 65532 starts, preventing
    // the source tar stream from creating ordinary project files. The
    // bootstrap copies those smaller package link trees instead.
    const destination = relative === "node_modules"
      ? "/workspace/node_modules"
      : `/ato-preinstalled-deps/${index}`;
    return [
      "--mount",
      `type=bind,src=${dependencyDirectory},dst=${destination}${input.preinstalledDependencyReadOnly ? ",readonly" : ""}`
    ];
  });
  const preinstalledNodeModulesBootstrap = preinstalledNodeModules.map((dependencyDirectory, index) => {
    const relative = path.relative(preinstalledDependencyRoot, dependencyDirectory).replaceAll(path.sep, "/");
    const destination = `/workspace/${relative}`;
    const parent = path.posix.dirname(destination);
    if (relative === "node_modules") return "";
    // Package-local pnpm node_modules entries contain relative links back to
    // the root .pnpm store. Copy the small package link tree into the writable
    // workspace so those links resolve through /workspace/node_modules; a
    // symlink to the flat mount would resolve them relative to that mount.
    return `mkdir -p '${parent}' && cp -a '/ato-preinstalled-deps/${index}' '${destination}'`;
  });
  const portArgs = (input.portBindings ?? []).flatMap(({ hostPort, containerPort }) => [
    "--publish", `127.0.0.1:${hostPort}:${containerPort}`
  ]);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
  const imagePreinstalledDependenciesBootstrap = useImagePreinstalledDependencies
    ? [
      `test -d ${shellQuote(preinstalledDependencyImageRoot ?? "")}/node_modules`,
      `rm -rf /workspace/node_modules && ln -s ${shellQuote(preinstalledDependencyImageRoot ?? "")}/node_modules /workspace/node_modules`,
      // pnpm keeps package-local link trees under workspace packages. Copy
      // those trees from the image too; their links resolve through the root
      // /workspace/node_modules store linked above.
      `find ${shellQuote(preinstalledDependencyImageRoot ?? "")} -mindepth 2 -maxdepth 3 -type d -name node_modules -exec sh -c 'root="\$1"; shift; for directory do relative="\${directory#"\$root"/}"; parent="\${relative%/node_modules}"; mkdir -p "/workspace/\$parent"; cp -a "\$directory" "/workspace/\$parent/"; done' sh ${shellQuote(preinstalledDependencyImageRoot ?? "")} {} +`
    ]
    : [];
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
  const mavenRepository = dependencyCache
    ? "/sandbox-cache/maven/repository"
    : preinstalledDependencies
      ? undefined
      : "/tmp/maven/repository";
  // Official Node images ship Corepack but do not activate pnpm/yarn shims by
  // default. Keep package-manager downloads in the project-scoped dependency
  // cache so later sandbox launches do not download Corepack or packages again.
  const requiresCorepack = [input.prepareCommand, input.command]
    .filter((item): item is CommandSpec => Boolean(item))
    .some((command) => command.executable === "pnpm" || command.executable === "yarn");
  const packageManagerBootstrap = requiresCorepack
    ? dependencyCache
      ? "if ! command -v pnpm >/dev/null 2>&1 && ! command -v yarn >/dev/null 2>&1; then mkdir -p /workspace/.ato-bin /sandbox-cache/corepack; export COREPACK_HOME=/sandbox-cache/corepack; corepack enable --install-directory /workspace/.ato-bin; export PATH=/workspace/.ato-bin:$PATH; fi"
      : "if ! command -v pnpm >/dev/null 2>&1 && ! command -v yarn >/dev/null 2>&1; then mkdir -p /tmp/ato-bin /tmp/ato-corepack; export COREPACK_HOME=/tmp/ato-corepack; corepack enable --install-directory /tmp/ato-bin; export PATH=/tmp/ato-bin:$PATH; fi"
    : "";
  // Some checked-in Vite/CRA configurations force a browser open even when
  // the discovered command does not pass --open.  The sandbox has no desktop
  // session by design; intercept that Linux helper so it cannot crash the
  // target or create an external browser.  The Workbench preview remains the
  // sole visual surface.
  const internalBrowserOnly = "mkdir -p /workspace/.ato-bin; printf '#!/bin/sh\\nexit 0\\n' > /workspace/.ato-bin/xdg-open; chmod 700 /workspace/.ato-bin/xdg-open; export PATH=/workspace/.ato-bin:$PATH";
  const runtimePathBootstrap = [
    "mkdir -p /tmp/ato-home /tmp/ato-data/database /tmp/ato-data/blob /tmp/ato-data/storage /tmp/ato-config /tmp/ato-cache",
    "export PATH=/workspace/.venv/bin:/workspace/.ato-bin:$PATH"
  ].join("; ");
  // A target can deliberately load a checked-in .env with `override: true`.
  // In that case container environment variables alone cannot prevent paths
  // such as /Users/alice/app.db from escaping the sandbox's writable tmpfs.
  // Rewrite only known mutable-path keys in the private workspace copy. Never
  // touch the read-only source mount and never print the file contents.
  const sandboxEnvBootstrap = [
    "find /workspace -maxdepth 6 -type f \\( -name .env -o -name '.env.*' \\) ! -path '*/node_modules/*' ! -path '*/.git/*' -exec sed -i -E",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?DATABASE_PATH=.*$|DATABASE_PATH=/tmp/ato-data/database|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?SQLITE_PATH=.*$|SQLITE_PATH=/tmp/ato-data/database/app.sqlite|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?SQLITE_DB_PATH=.*$|SQLITE_DB_PATH=/tmp/ato-data/database/app.sqlite|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?BLOB_STORAGE_PATH=.*$|BLOB_STORAGE_PATH=/tmp/ato-data/blob|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?STORAGE_PATH=.*$|STORAGE_PATH=/tmp/ato-data/storage|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?DATA_DIR=.*$|DATA_DIR=/tmp/ato-data|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?UPLOAD_DIR=.*$|UPLOAD_DIR=/tmp/ato-data/uploads|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?LOG_DIR=.*$|LOG_DIR=/tmp/ato-data/logs|'",
    "-e 's|^[[:space:]]*(export[[:space:]]+)?CACHE_DIR=.*$|CACHE_DIR=/tmp/ato-cache|'",
    "{} +"
  ].join(" ");
  const prepareCommand = input.prepareCommand
    ? [input.prepareCommand.executable, ...input.prepareCommand.args].map(shellQuote).join(" ")
    : "";
  // When the source project carries pre-installed dependencies (host
  // node_modules / .venv populated to avoid a cold install that needs registry
  // egress), skip the prepare (install) command entirely — the dependency
  // directories are copied into the workspace below.
  const prepare = (prepareCommand && dependencyCache && !preinstalledDependencies)
    ? [
      `cache_marker=${dependencyCache.storageMode === "volume" ? "/sandbox-meta" : "/sandbox-cache"}/prepared-${dependencyCache.key}`,
      `cache_lock=${dependencyCache.storageMode === "volume" ? "/sandbox-meta" : "/sandbox-cache"}/preparing-${dependencyCache.key}`,
      "if [ -f \"$cache_marker\" ]; then if [ \"${ATO_SOURCE_CHANGED:-0}\" = \"1\" ]; then echo ATO_DEPENDENCY_CACHE_RELINK",
      // A refreshed monorepo source tree no longer contains package-level
      // node_modules links (they are intentionally excluded from the source
      // copy). Re-running the allowlisted install command against the prepared
      // offline store restores those links without downloading dependencies.
      prepareCommand,
      "else echo ATO_DEPENDENCY_CACHE_HIT; fi",
      "else cache_owner=0",
      "while [ \"$cache_owner\" -eq 0 ] && [ ! -f \"$cache_marker\" ]; do if mkdir \"$cache_lock\" 2>/dev/null; then cache_owner=1; else sleep 1; fi; done",
      "if [ \"$cache_owner\" -eq 1 ]; then trap 'rmdir \"$cache_lock\" 2>/dev/null || true' EXIT INT TERM",
      prepareCommand,
      "touch \"$cache_marker\"; rmdir \"$cache_lock\"; trap - EXIT INT TERM",
      "else echo ATO_DEPENDENCY_CACHE_HIT; fi; fi"
    ].join("; ")
    : (preinstalledDependencies ? "echo ATO_PREINSTALLED_DEPENDENCIES_SKIP_INSTALL" : prepareCommand);
  // Copy dependency directories into the writable workspace when the project
  // ships pre-installed deps; otherwise exclude them so the prepare (install)
  // step populates a fresh workspace/node_modules from the offline store.
  const dependencyExclude = preinstalledDependencies
    ? "--exclude=.git --exclude=./dist --exclude=./build --exclude=node_modules"
    : "--exclude=node_modules --exclude=.git --exclude=dist --exclude=build";
  const workspaceBootstrap = dependencyCache
    ? [
      `source_marker=/workspace/.ato-source-${dependencyCache.sourceFingerprint}`,
      "if [ -f \"$source_marker\" ]; then export ATO_SOURCE_CHANGED=0; echo ATO_SOURCE_CACHE_HIT",
      "else find /workspace -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .python-packages ! -name .venv ! -name venv ! -name .bundle ! -name vendor ! -name .ato-bin -exec rm -rf {} +",
      `tar -C /source ${dependencyExclude} -cf - . | tar -C /workspace -xf -`,
      "rm -f /workspace/.ato-source-*; touch \"$source_marker\"; export ATO_SOURCE_CHANGED=1; fi"
    ].join("; ")
    : `tar -C /source ${dependencyExclude} -cf - . | tar -C /workspace -xf -`;
  const bootstrap = [
    "set -eu",
    "mkdir -p /workspace",
    ...preinstalledNodeModulesBootstrap,
    workspaceBootstrap,
    ...imagePreinstalledDependenciesBootstrap,
    internalBrowserOnly,
    runtimePathBootstrap,
    sandboxEnvBootstrap,
    packageManagerBootstrap,
    prepare,
    "exec \"$@\""
  ].filter(Boolean).join("; ");
  return {
    executable: input.engine,
    args: [
      "run", "--rm", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      // Keep every sandbox bounded while allowing multi-process targets a
      // larger, still finite profile.
      "--cpus", String(cpus), "--memory", `${memoryGiB}g`, "--memory-swap", `${memoryGiB}g`, "--pids-limit", String(pidsLimit), "--user", "65532:65532", "--network", network!,
      "--label", "ai-test-officer.managed=true",
      "--label", `ai-test-officer.project-id=${manifest.projectId}`,
      "--label", `ai-test-officer.network-mode=${networkPolicy.mode}`,
      "--label", `ai-test-officer.network-policy-sha256=${networkPolicySha256}`,
      ...(networkPolicy.mode === "deny" ? [] : [
        "--label", `ai-test-officer.allowed-hosts=${networkPolicy.allowedHosts.join(",")}`,
        "--env", `HTTP_PROXY=${proxyUrl}`,
        "--env", `HTTPS_PROXY=${proxyUrl}`,
        "--env", "NO_PROXY=localhost,127.0.0.1,::1",
        "--env", `ATO_EGRESS_POLICY_SHA256=${networkPolicySha256}`
      ]),
      ...portArgs,
      "--env", "HOME=/tmp/ato-home",
      // Some CLI frameworks call os.userInfo() only to infer SHELL. The
      // hardened numeric uid intentionally has no passwd entry in slim
      // images, so provide the non-sensitive shell explicitly instead of
      // weakening the uid or adding a writable /etc/passwd.
      "--env", "SHELL=/bin/sh",
      // Servers that default to 127.0.0.1 are reachable only from inside the
      // container even when Docker publishes their port. Managed web targets
      // must bind the container interface; the host side remains restricted
      // to 127.0.0.1 by the --publish argument above.
      "--env", "HOST=0.0.0.0",
      // Source-controlled .env files often contain absolute paths from the
      // developer machine. The sandbox must redirect mutable state to its
      // private tmpfs instead of trying to recreate /Users, /home or C:\\.
      "--env", "XDG_DATA_HOME=/tmp/ato-data",
      "--env", "XDG_CONFIG_HOME=/tmp/ato-config",
      "--env", "XDG_CACHE_HOME=/tmp/ato-cache",
      "--env", "DATABASE_PATH=/tmp/ato-data/database",
      "--env", "BLOB_STORAGE_PATH=/tmp/ato-data/blob",
      "--env", "STORAGE_PATH=/tmp/ato-data/storage",
      "--env", "DATA_DIR=/tmp/ato-data",
      "--env", "TMPDIR=/tmp",
      "--env", `npm_config_cache=${dependencyCache ? "/sandbox-cache/npm" : "/tmp/npm-cache"}`,
      "--env", `npm_config_store_dir=${dependencyCache ? "/sandbox-cache/pnpm-store" : "/tmp/pnpm-store"}`,
      "--env", "npm_config_prefer_offline=true",
      "--env", `YARN_CACHE_FOLDER=${dependencyCache ? "/sandbox-cache/yarn" : "/tmp/yarn-cache"}`,
      "--env", `PIP_CACHE_DIR=${dependencyCache ? "/sandbox-cache/pip" : "/tmp/pip-cache"}`,
      "--env", "PIP_TARGET=/workspace/.python-packages",
      "--env", "PYTHONPATH=/workspace/.python-packages",
      "--env", "POETRY_VIRTUALENVS_IN_PROJECT=true",
      // Large Turbo monorepos can otherwise start several Jest/Vitest workers
      // that collectively exceed the documented 4 GiB sandbox budget.
      "--env", "TURBO_CONCURRENCY=1",
      "--env", `GOPATH=${dependencyCache ? "/sandbox-cache/go" : "/tmp/go"}`,
      "--env", `GOMODCACHE=${dependencyCache ? "/sandbox-cache/go/pkg/mod" : "/tmp/go/pkg/mod"}`,
      "--env", `GOCACHE=${dependencyCache ? "/sandbox-cache/go-build" : "/tmp/go-build"}`,
      "--env", `CARGO_HOME=${dependencyCache ? "/sandbox-cache/cargo" : "/tmp/cargo"}`,
      "--env", `CARGO_TARGET_DIR=${dependencyCache ? "/sandbox-cache/cargo-target" : "/tmp/cargo-target"}`,
      "--env", `GRADLE_USER_HOME=${dependencyCache ? "/sandbox-cache/gradle" : "/tmp/gradle"}`,
      ...(mavenRepository ? ["--env", `MAVEN_OPTS=-Dmaven.repo.local=${mavenRepository}`] : []),
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
        : [
            "--tmpfs", "/workspace:rw,exec,nosuid,size=8g,uid=65532,gid=65532",
            // Preinstalled dependencies stay outside the RAM-backed /workspace
            // tmpfs. The source may be the original project root (Repair copies
            // intentionally omit node_modules), and an absent directory must
            // not make Python-only projects fail before their command starts.
            ...preinstalledNodeModulesMount
          ]),
      "--workdir", "/workspace",
      "--name", containerName,
      "--entrypoint", "/bin/sh", input.image,
      "-c", bootstrap, "ato-entrypoint", input.command.executable, ...input.command.args
    ],
    cleanupToken: token,
    containerName
  };
}
