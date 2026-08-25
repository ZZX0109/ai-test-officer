import type { CommandSpec, ProjectManifest } from "@ai-test-officer/contracts";
import { appendAudit } from "./auditLog.js";
import type { ProjectRuntimeFailureReason } from "./types.js";

type LifecycleKind = "migrate" | "seed";
type LifecycleResult = { ok: boolean; failureReason: string; stderr?: string; stdout?: string };

export async function runProjectLifecycleCommands(input: {
  manifest?: ProjectManifest;
  projectId: string;
  runId?: string;
  cwd: string;
  networkName?: string;
  proxyUrl?: string;
  timeoutMs: (kind: LifecycleKind, command: CommandSpec) => number;
  run: (input: { projectId: string; command: CommandSpec; cwd: string; timeoutMs: number; networkName?: string; proxyUrl?: string }) => Promise<LifecycleResult>;
  teardown: () => Promise<void>;
}) {
  const commands: Array<[LifecycleKind, CommandSpec | undefined]> = [
    ["migrate", input.manifest?.commands.migrate],
    ["seed", input.manifest?.commands.seed]
  ];
  for (const [kind, command] of commands) {
    if (!command) continue;
    await appendAudit({ type: "agent_action", action: `project.${kind}`, result: "recorded", details: { projectId: input.projectId, runId: input.runId, executable: command.executable } });
    const result = await input.run({
      projectId: input.projectId,
      command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs(kind, command),
      networkName: input.networkName,
      proxyUrl: input.proxyUrl
    });
    if (!result.ok) {
      await appendAudit({ type: "agent_action", action: `project.${kind}`, result: "denied", details: { projectId: input.projectId, runId: input.runId, executable: command.executable, failureReason: result.failureReason } });
      await input.teardown().catch(() => undefined);
      const failureReason: ProjectRuntimeFailureReason = result.failureReason === "budget_exceeded"
        ? "budget_exceeded"
        : kind === "migrate" ? "migration_failed" : "seed_failed";
      return { ok: false as const, failureReason, output: result.stderr || result.stdout };
    }
  }
  return { ok: true as const };
}
