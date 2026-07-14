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
  | "budget_exceeded"
  | "cancelled"
  | "unknown";

export function classifyRuntimeFailure(error: unknown, stderr = ""): RuntimeFailureReason {
  const text = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.toLowerCase();
  if (/enoent|command not found|not recognized/.test(text)) return "command_not_found";
  if (/cannot find module|module not found|missing dependency|npm err.*enoent/.test(text)) return "dependency_missing";
  if (/eaddrinuse|address already in use|port.*in use/.test(text)) return "port_conflict";
  if (/health.*timeout|aborterror/.test(text)) return "health_timeout";
  if (/eacces|eperm|permission denied/.test(text)) return "permission_denied";
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

export function buildOciInvocation(input: { engine: "docker" | "podman"; image: string; manifest: ProjectManifest; repositoryRoot: string; command: CommandSpec }) {
  const manifest = projectManifestSchema.parse(input.manifest);
  const workspace = resolveManifestWorkspace(manifest, input.repositoryRoot);
  const token = createHash("sha256").update(`${manifest.projectId}:${randomUUID()}`).digest("hex").slice(0, 20);
  const network = manifest.network.mode === "deny" ? "none" : `ato-${token}`;
  return {
    executable: input.engine,
    args: [
      "run", "--rm", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      "--cpus", "2", "--memory", "4g", "--pids-limit", "256", "--user", "65532:65532", "--network", network,
      "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g", "--workdir", "/workspace",
      "--name", `ato-${manifest.projectId}-${token}`, input.image,
      input.command.executable, ...input.command.args
    ],
    cleanupToken: token
  };
}
