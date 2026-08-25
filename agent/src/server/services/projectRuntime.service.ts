import {
  getProject,
  getProjectRuntimeStatus,
  getProjectRuntimeStatusWithRecovery,
  recordProjectRuntimeStatus,
  saveProject,
  startProject,
  testProjectConnection
} from "../../projectAdapter.js";
import { detectProject } from "../../projectDetection.js";
import { createRuntimeRecoveryAdvice } from "../../runtimeStartupAdvisor.js";
import { runSmokeFirstDiscovery } from "../../smokeFirstDiscovery.js";
import type {
  ProjectRecoveryAction,
  ProjectRecoveryEvent,
  ProjectRecoveryResult,
  ProjectRuntimeStatus
} from "../../types.js";

export function createProjectRuntimeService() {
  const projectStartTasks = new Map<string, Promise<ProjectRuntimeStatus>>();
  const projectRecoveryTasks = new Map<string, Promise<ProjectRecoveryResult>>();
  const projectRecoverySnapshots = new Map<string, ProjectRecoveryResult>();

  // eslint-disable-next-line complexity -- preserving the inspected launch contract requires explicit field-by-field policy.
  async function refreshExternalProjectLaunchContract(id: string) {
    const current = await getProject(id);
    if (!current?.allowExternalProjectPath) return current;
    const detection = await detectProject(current.projectPath);
    if (!detection.exists || detection.executionReady === false) return current;
    const detected = detection.suggestedConfig;
    const detectedManifest = detected.manifest;
    const currentManifest = current.manifest;
    const manifest = detectedManifest ? {
      ...detectedManifest,
      projectId: current.id,
      // The inspected package.json is authoritative for the sandbox base image:
      // retaining an older generic Node image can fail an engines.node check
      // before the target has even started. External projects are always OCI;
      // only the selected container engine remains a user/deployment choice.
      execution: {
        ...detectedManifest.execution,
        mode: "oci" as const,
        engine: currentManifest?.execution.engine ?? detectedManifest.execution.engine,
        // Preserve user/deployment execution overrides that re-detection cannot
        // infer from package.json. preinstalledDependencies is a deliberate launch
        // setting (skip the cold install, copy host deps into the workspace) that
        // must survive the package.json-driven refresh, or the sandbox falls back
        // to a network-bound install the deny/isolated network policy blocks.
        // image is also a deployment override (e.g. a custom image with a
        // pre-baked pnpm/corepack cache) that re-detection, which infers only the
        // Node version, must not clobber back to the stock node:<ver>-slim image.
        image: currentManifest?.execution.image ?? detectedManifest.execution.image,
        preinstalledDependencies: currentManifest?.execution.preinstalledDependencies,
        preinstalledDependencyImageRoot: currentManifest?.execution.preinstalledDependencyImageRoot
      },
      network: currentManifest?.network ?? detectedManifest.network,
      budget: currentManifest?.budget ?? detectedManifest.budget,
      environmentAllowlist: Array.from(new Set([
        ...detectedManifest.environmentAllowlist,
        ...(currentManifest?.environmentAllowlist ?? [])
      ])),
      // Preserve user/deployment command-allowlist additions that re-detection
      // cannot infer from package.json (e.g. python3 for a keepalive process in
      // a Java/Maven image, or a custom CLI tool). Without this union, a
      // package.json-driven refresh silently drops custom executables, causing
      // command_not_allowed failures on the next start.
      commandAllowlist: Array.from(new Set([
        ...detectedManifest.commandAllowlist,
        ...(currentManifest?.commandAllowlist ?? [])
      ]))
    } : currentManifest;
    return saveProject({
      ...current,
      // Preserve user/deployment launch overrides that re-detection cannot
      // infer from package.json: a hand-tuned start command, an explicit
      // process list, or pinned URLs must survive the package.json-driven
      // refresh, or the sandbox falls back to a generic template (e.g. the
      // fastapi default "backend.app:app") that does not match the project.
      installCommand: current.installCommand || detected.installCommand,
      installCommandSpec: current.installCommandSpec ?? detected.installCommandSpec,
      startCommand: current.startCommand || detected.startCommand,
      startCommandSpec: current.startCommandSpec ?? detected.startCommandSpec,
      testCommand: current.testCommand || detected.testCommand,
      testCommandSpec: current.testCommandSpec ?? detected.testCommandSpec,
      processes: current.processes?.length ? current.processes : detected.processes,
      frontendUrl: current.frontendUrl || detected.frontendUrl,
      backendUrl: current.backendUrl || detected.backendUrl,
      healthCheckUrl: current.healthCheckUrl ?? detected.healthCheckUrl,
      manifest
    });
  }

  // Saving a detected project and launching its sandbox are separate durable
  // operations. A file-system watcher / hot reload can observe the old registry
  // between them, so retry the one safe failure that proves no process was ever
  // started. This only refreshes the detected manifest and retries the existing
  // allowlisted start contract; it never edits target source or runs LLM output.
  async function startProjectWithFreshConfig(id: string) {
    await refreshExternalProjectLaunchContract(id);
    let runtime = await startProject(id);
    if (runtime.failureReason !== "config_missing") return runtime;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await refreshExternalProjectLaunchContract(id);
    runtime = await startProject(id);
    return runtime;
  }

  function runtimeRecoveryAction(runtime: ProjectRuntimeStatus): ProjectRecoveryAction {
    if (runtime.status === "running") return "retry-discovery";
    if (["container_runtime_unavailable", "dependency_missing", "command_not_found", "port_conflict", "health_timeout", "early_exit", "budget_exceeded"].includes(runtime.failureReason ?? "")) return "retry-runtime";
    if (["idle", "installing", "starting"].includes(runtime.status)) return "retry-runtime";
    return "unavailable";
  }

  function recoveryUserAction(action: ProjectRecoveryAction, runtime: ProjectRuntimeStatus) {
    if (action === "retry-runtime") {
      return runtime.failureReason === "container_runtime_unavailable"
        ? "暂时无需操作；系统会先启动 Docker Desktop。若 180 秒后仍不可用，会提示你检查 Docker 是否已安装并完成系统权限确认。"
        : "暂时无需操作；系统会重新准备安全沙盒、项目服务和健康检查。";
    }
    if (action === "retry-discovery") return "暂时无需操作；系统会重新扫描页面并绑定可执行路径。";
    return "当前没有安全且可自动执行的恢复动作，请查看运行详情后补充项目启动条件。";
  }

  function appendRecoveryEvent(snapshot: ProjectRecoveryResult, phase: ProjectRecoveryEvent["phase"], message: string) {
    snapshot.events.push({ phase, message, at: new Date().toISOString() });
    snapshot.updatedAt = new Date().toISOString();
    projectRecoverySnapshots.set(snapshot.projectId, { ...snapshot, events: [...snapshot.events] });
  }

  function getRecoverySnapshot(id: string) {
    return projectRecoverySnapshots.get(id);
  }

  async function recoveryPreview(id: string): Promise<ProjectRecoveryResult> {
    const snapshot = getRecoverySnapshot(id);
    if (snapshot) return snapshot;
    const runtime = await getProjectRuntimeStatusWithRecovery(id);
    const action = runtimeRecoveryAction(runtime);
    return {
      recoveryId: "",
      projectId: id,
      action,
      status: action === "unavailable" ? "blocked" : "accepted",
      sourceError: runtime.failureReason ?? runtime.message,
      runtime,
      events: [],
      userAction: recoveryUserAction(action, runtime),
      updatedAt: new Date().toISOString()
    };
  }

  function recoverAndRetryProject(
    id: string,
    requestedMode: "auto" | "runtime" | "discovery" = "auto",
    credentialId?: string
  ): Promise<ProjectRecoveryResult> {
    const existing = projectRecoveryTasks.get(id);
    if (existing) return existing;
    // eslint-disable-next-line complexity -- this is the explicit, auditable recovery state transition; it never executes model-proposed commands.
    const task = (async (): Promise<ProjectRecoveryResult> => {
      const project = await getProject(id);
      if (!project) throw new Error("project_not_found");
      const initialRuntime = await getProjectRuntimeStatusWithRecovery(id);
      const action = requestedMode === "discovery" ? "retry-discovery" : runtimeRecoveryAction(initialRuntime);
      const initial: ProjectRecoveryResult = {
        recoveryId: `recovery_${crypto.randomUUID()}`,
        projectId: id,
        action,
        status: "accepted",
        sourceError: initialRuntime.failureReason ?? initialRuntime.message,
        runtime: initialRuntime,
        events: [],
        userAction: recoveryUserAction(action, initialRuntime),
        updatedAt: new Date().toISOString()
      };
      projectRecoverySnapshots.set(id, initial);
      const snapshot = initial;
      snapshot.status = "running";
      if (action === "unavailable") {
        snapshot.status = "blocked";
        appendRecoveryEvent(snapshot, "blocked", "当前没有可安全自动执行的恢复动作；未启动代码修复或重试路径。");
        return snapshot;
      }

      let runtime = initialRuntime;
      if (action === "retry-runtime") {
        appendRecoveryEvent(snapshot, "docker_launching", "正在检查并自动启动 Docker Desktop 安全沙盒。");
        recordProjectRuntimeStatus({
          ...runtime,
          status: "starting",
          phase: "starting_processes",
          updatedAt: new Date().toISOString(),
          message: "恢复中：正在检查 Docker Desktop 并准备安全沙盒。",
          failureReason: "none"
        });
        appendRecoveryEvent(snapshot, "daemon_waiting", "正在等待 Docker daemon 就绪（最长 180 秒）。");
        runtime = await startProjectWithFreshConfig(id);
        snapshot.runtime = runtime;
        // An adopted OCI container may legitimately report `installing` or
        // `starting` while its dependency layer is still warming. Do not turn
        // that intermediate lifecycle state into a user-facing blocked result.
        if (["installing", "starting"].includes(runtime.status)) {
          appendRecoveryEvent(snapshot, "sandbox_starting", "安全沙盒已接管，正在等待依赖安装和项目健康检查完成。");
          const waitDeadline = Date.now() + Math.min(
            Math.max(project.manifest?.budget.prepareTimeoutMs ?? 120_000, 30_000),
            300_000
          );
          while (["installing", "starting"].includes(runtime.status) && Date.now() < waitDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            runtime = await getProjectRuntimeStatusWithRecovery(id);
            snapshot.runtime = runtime;
            snapshot.updatedAt = new Date().toISOString();
            projectRecoverySnapshots.set(id, { ...snapshot, events: [...snapshot.events] });
          }
        }
        if (runtime.status !== "running") {
          snapshot.status = "blocked";
          // The deterministic starter has already tried the saved, allowlisted
          // launch contract. At this point an LLM may *recommend* one of the
          // inspected candidates, but it cannot execute it or mutate the source.
          // This turns an opaque startup block into a concrete, user-approved
          // next step without weakening the sandbox boundary.
          snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime, credentialId }).catch(() => undefined);
          snapshot.userAction = recoveryUserAction("retry-runtime", runtime);
          if (snapshot.advice?.status === "passed" && snapshot.advice.nextStep === "use_candidate" && snapshot.advice.selectedCandidateId) {
            const candidate = snapshot.advice.candidates.find((item) => item.id === snapshot.advice?.selectedCandidateId);
            snapshot.userAction = candidate
              ? `AI 已根据脱敏启动日志建议“${candidate.label}”。请确认采用后再重试；系统不会自动执行模型建议的命令。`
              : snapshot.userAction;
          }
          appendRecoveryEvent(snapshot, "blocked", runtime.message || "安全沙盒未能启动。");
          return snapshot;
        }
      }

      appendRecoveryEvent(snapshot, "health_checking", "项目已启动，正在检查沙盒内页面连通性。");
      const connection = await testProjectConnection(project);
      if (!connection.ok) {
        snapshot.runtime = await getProjectRuntimeStatusWithRecovery(id);
        snapshot.status = "blocked";
        snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime: snapshot.runtime, credentialId }).catch(() => undefined);
        snapshot.userAction = "无需立即修改源码；请等待系统完成有限恢复。若仍失败，请补充项目启动所需的外部服务或凭据。";
        if (snapshot.advice?.status === "passed" && snapshot.advice.nextStep === "use_candidate" && snapshot.advice.selectedCandidateId) {
          const candidate = snapshot.advice.candidates.find((item) => item.id === snapshot.advice?.selectedCandidateId);
          if (candidate) snapshot.userAction = `AI 已建议采用“${candidate.label}”。请确认后再修改下一次沙盒启动配置。`;
        }
        appendRecoveryEvent(snapshot, "blocked", connection.message);
        return snapshot;
      }

      appendRecoveryEvent(snapshot, "discovery_retrying", "页面已连通，正在重新扫描真实控件、网络和可执行路径。");
      const discovery = await runSmokeFirstDiscovery({
        projectId: id,
        goal: "恢复后重新扫描页面，并只绑定具备真实入口、操作、oracle 和证据要求的测试路径。",
        smokeAttempts: 2,
        discoveryAttempts: 2
      });
      snapshot.runtime = await getProjectRuntimeStatusWithRecovery(id);
      snapshot.discovery = discovery;
      if (discovery.orchestration?.status === "ready") {
        snapshot.status = "completed";
        snapshot.userAction = "无需操作；页面扫描已恢复，可以继续生成或执行测试计划。";
        appendRecoveryEvent(snapshot, "completed", "恢复完成：页面连通性和 Discovery 已通过。");
      } else {
        snapshot.status = "blocked";
        snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime: snapshot.runtime, credentialId }).catch(() => undefined);
        snapshot.userAction = discovery.observation.diagnosis.userActionRequired
          ? "请根据页面实际提示完成登录、授权或凭据配置后重试。"
          : "无需重复点击；系统已保存页面截图、DOM、控制台和网络诊断，可查看详情后补充启动条件。";
        appendRecoveryEvent(snapshot, "blocked", discovery.message);
      }
      return snapshot;
    })().catch(async (error) => {
      const runtime = await getProjectRuntimeStatusWithRecovery(id).catch(() => ({
        projectId: id,
        status: "failed" as const,
        phase: "failed" as const,
        updatedAt: new Date().toISOString(),
        failureReason: "none" as const,
        message: "恢复任务初始化失败。",
        processes: []
      }));
      const failed: ProjectRecoveryResult = {
        recoveryId: `recovery_${crypto.randomUUID()}`,
        projectId: id,
        action: requestedMode === "discovery" ? "retry-discovery" : runtimeRecoveryAction(runtime),
        status: "failed",
        runtime,
        events: [],
        userAction: "恢复请求未完成。请查看运行详情；系统没有修改项目源码或覆盖既有测试证据。",
        updatedAt: new Date().toISOString()
      };
      appendRecoveryEvent(failed, "blocked", error instanceof Error ? error.message : "恢复任务发生未知错误。");
      return failed;
    }).finally(() => projectRecoveryTasks.delete(id));
    projectRecoveryTasks.set(id, task);
    task.catch(() => undefined);
    return task;
  }

  async function startProjectAsync(id: string) {
    const current = await getProjectRuntimeStatusWithRecovery(id);
    // This endpoint is an idempotent "ensure running" operation. A healthy
    // project sandbox is reusable across diagnosis and test Runs; overwriting
    // it with a synthetic `starting` record discarded the owned container
    // handles and made every imported project appear to require a restart.
    if (current.status === "running") return { accepted: false, reused: true, runtime: current };
    if (["installing", "starting"].includes(current.status)) return { accepted: true, reused: true, runtime: current };
    if (!projectStartTasks.has(id)) {
      const previous = current;
      // Return a fresh in-progress state immediately. Without this marker the
      // first poll after a retry can receive a failed status from an earlier
      // attempt and the Workbench appears to flash/exit before the new task
      // has even reached startProject.
      recordProjectRuntimeStatus({
        projectId: id,
        status: "starting",
        phase: "starting_processes",
        updatedAt: new Date().toISOString(),
        frontendUrl: previous.frontendUrl,
        backendUrl: previous.backendUrl,
        healthCheckUrl: previous.healthCheckUrl,
        message: "Start task accepted; preparing the project runtime.",
        failureReason: "none"
      });
      const task = startProjectWithFreshConfig(id)
        .then((status) => {
          if (!["installing", "starting", "running"].includes(status.status)) recordProjectRuntimeStatus(status);
          return status;
        })
        .catch(() => {
          const failed = {
            ...getProjectRuntimeStatus(id),
            projectId: id,
            status: "failed" as const,
            phase: "failed" as const,
            remainingMs: 0,
            updatedAt: new Date().toISOString(),
            stoppedAt: new Date().toISOString(),
            failureReason: "unknown" as const,
            message: "Project start task failed unexpectedly. Retry after the Agent is healthy."
          };
          recordProjectRuntimeStatus(failed);
          return failed;
        })
        .finally(() => projectStartTasks.delete(id));
      projectStartTasks.set(id, task);
      task.catch(() => undefined);
    }
    return { accepted: true, reused: false, runtime: getProjectRuntimeStatus(id) };
  }

  return {
    getRecoverySnapshot,
    recoverAndRetryProject,
    recoveryPreview,
    refreshExternalProjectLaunchContract,
    runtimeRecoveryAction,
    startProjectAsync,
    startProjectWithFreshConfig
  };
}

export type ProjectRuntimeService = ReturnType<typeof createProjectRuntimeService>;
