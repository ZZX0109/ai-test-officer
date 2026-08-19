// Sandbox image readiness preflight.
//
// Extracted from projectAdapter so the launch path surfaces a missing sandbox
// image as an explicit blocker (and a bounded pull with progress) instead of
// letting `docker run` fail mid-launch with an opaque pull error. Depends on
// projectAdapter internals via an injected context to avoid a circular import.

import type { ProjectConfig, ProjectRuntimeStatus } from "./types.js";

export interface ProcessOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SandboxReadinessContext {
  captureProcessOutput: (executable: string, args: string[], timeoutMs?: number, maxBytes?: number) => Promise<ProcessOutput>;
  runningProjects: Map<string, { status: ProjectRuntimeStatus }>;
  runtimeTiming: (timeoutMs: number, phase: NonNullable<ProjectRuntimeStatus["phase"]>) => Partial<ProjectRuntimeStatus>;
  now: () => string;
  redactText: (value: string) => string;
}

export async function containerImageIsAvailable(
  engine: "docker" | "podman",
  image: string,
  ctx: SandboxReadinessContext
) {
  const result = await ctx.captureProcessOutput(engine, ["image", "inspect", image], 5_000, 64 * 1024);
  return result.exitCode === 0;
}

export async function ensureContainerImageReady(
  project: ProjectConfig,
  ctx: SandboxReadinessContext
): Promise<ProjectRuntimeStatus | undefined> {
  const manifest = project.manifest;
  if (!manifest || manifest.execution.mode !== "oci") return undefined;
  const engine = manifest.execution.engine;
  const image = manifest.execution.image;
  if (!image) return undefined;
  if (await containerImageIsAvailable(engine, image, ctx)) return undefined;

  const pullTimeoutMs = Math.min(Math.max(manifest.budget.prepareTimeoutMs ?? 300_000, 60_000), 600_000);
  const pulling: ProjectRuntimeStatus = {
    projectId: project.id,
    status: "starting",
    ...ctx.runtimeTiming(pullTimeoutMs, "pulling_sandbox_image"),
    frontendUrl: project.frontendUrl,
    backendUrl: project.backendUrl,
    healthCheckUrl: project.healthCheckUrl,
    message: `沙盒镜像 ${image} 本地缺失，正在拉取（最长 ${Math.round(pullTimeoutMs / 1000)} 秒）。`
  };
  ctx.runningProjects.set(project.id, { status: pulling });

  const pull = await ctx.captureProcessOutput(engine, ["pull", image], pullTimeoutMs, 2 * 1024 * 1024);
  if (pull.exitCode === 0 && await containerImageIsAvailable(engine, image, ctx)) {
    ctx.runningProjects.delete(project.id);
    return undefined;
  }

  const failed: ProjectRuntimeStatus = {
    ...pulling,
    status: "failed",
    phase: "failed",
    remainingMs: 0,
    updatedAt: ctx.now(),
    stoppedAt: ctx.now(),
    failureReason: "container_image_unavailable",
    message: `沙盒镜像 ${image} 拉取失败。请检查网络/registry 可达性，或手动运行 \`${engine} pull ${image}\`。${ctx.redactText(pull.stderr || pull.stdout || "")}`
  };
  ctx.runningProjects.set(project.id, { status: failed });
  return failed;
}
