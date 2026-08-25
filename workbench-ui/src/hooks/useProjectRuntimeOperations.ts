import type { Dispatch, SetStateAction } from "react";
import { forgetProjectActiveRun } from "../activeRunCache";
import {
  chatWithTestAssistant,
  detectProject,
  detectProjectManifest,
  diagnoseProject,
  getAiStartRecovery,
  getProjectRuntime,
  getReadiness,
  saveProject,
  saveProjectLoginCredential,
  startProjectAsync,
  stopProject,
  testProjectConnection
} from "../api";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";
import type {
  AgentGraphProjection,
  BrowserSession,
  Credential,
  DiscoveryScanResult,
  LiveRunState,
  PermissionProfile,
  PlanningConversationResult,
  PlanningMessage,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus,
  RepairSession,
  RunProjection,
  RunResult,
  RuntimeRecoveryAdvice
} from "../types";

type DiagnosisRef = { current: { id: string; projectId: string } | null };
type RestoreEpochRef = { current: number };
type DiagnosticKeysRef = { current: Set<string> };

interface ProjectRuntimeOperationsInput {
  credentials: Credential[];
  defaultCredential?: Credential;
  selectedProjectExecutionMode: "oci" | "trusted-local";
  projectDraft: ProjectConfig | null;
  projectDetection: ProjectDetectionResult | null;
  runtimeRecoveryAdvice: RuntimeRecoveryAdvice | null;
  planningResult: PlanningConversationResult | null;
  planningMessages: PlanningMessage[];
  discovery: DiscoveryScanResult | null;
  permissionProfile: PermissionProfile;
  preparationRequiresLogin: boolean;
  preparationLoginUsername: string;
  preparationLoginPassword: string;
  authBlockDetected: boolean;
  activeRunRestoreEpochRef: RestoreEpochRef;
  diagnosisOperationRef: DiagnosisRef;
  surfacedProjectDiagnostics: DiagnosticKeysRef;
  resetPlanningConversation: () => void;
  closeDrawers: () => void;
  boundedAssistantText: (value: unknown, limit: number) => string;
  recoverProjectAndRetry: (mode: "auto" | "runtime" | "discovery") => Promise<unknown>;
  retryWithConfiguredLogin: (projectOverride?: ProjectConfig) => Promise<void>;
  executeConfirmedScenarioAutomatically: (scenarioId: string | undefined, permission?: PermissionProfile) => Promise<unknown>;
  continueAutomaticPlanning: (
    grantedProfile?: PermissionProfile,
    projectOverride?: ProjectConfig,
    planningOverride?: PlanningConversationResult
  ) => Promise<void>;
  setProjectDetectMessage: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setProjectDetection: Dispatch<SetStateAction<ProjectDetectionResult | null>>;
  setProjectDraft: Dispatch<SetStateAction<ProjectConfig | null>>;
  setSelectedProjectId: (projectId: string) => void;
  setProjectPathInput: Dispatch<SetStateAction<string>>;
  setAppUrl: Dispatch<SetStateAction<string>>;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
  setActiveRun: Dispatch<SetStateAction<RunProjection | null>>;
  setAgentProjection: Dispatch<SetStateAction<AgentGraphProjection | null>>;
  setBrowserSession: Dispatch<SetStateAction<BrowserSession | null>>;
  setLiveRun: Dispatch<SetStateAction<LiveRunState | null>>;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setRepairSession: Dispatch<SetStateAction<RepairSession | null>>;
  setInterruptError: Dispatch<SetStateAction<string | null>>;
  setInterruptBusy: Dispatch<SetStateAction<boolean>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  setRunPreviewModalOpen: Dispatch<SetStateAction<boolean>>;
  setScreenshotIssue: Dispatch<SetStateAction<string | null>>;
  setProjectConnection: Dispatch<SetStateAction<ProjectHealthCheckResult | null>>;
  setProjectDiagnosis: Dispatch<SetStateAction<ProjectDiagnosis | null>>;
  setRuntimeRecoveryAdvice: Dispatch<SetStateAction<RuntimeRecoveryAdvice | null>>;
  setProjectLaunchPhase: Dispatch<SetStateAction<string>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
  setPreviewSessionProjectId: Dispatch<SetStateAction<string>>;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setRevealProjectLoginSettings: Dispatch<SetStateAction<boolean>>;
  setPreparationLoginError: Dispatch<SetStateAction<string>>;
  setPreparationLoginUsername: Dispatch<SetStateAction<string>>;
  setPreparationLoginPassword: Dispatch<SetStateAction<string>>;
  setPreparationLoginSaving: Dispatch<SetStateAction<boolean>>;
  setScenarioId: Dispatch<SetStateAction<string>>;
}

/**
 * Owns target-project detection, sandbox lifecycle diagnostics, and encrypted
 * test-account persistence. Planning and Run creation remain in their own
 * hooks, so this boundary cannot turn a startup failure into a test verdict.
 */
export function useProjectRuntimeOperations(input: ProjectRuntimeOperationsInput) {
  async function detectCurrentProjectPath(selection: {
    rootName: string;
    absolutePath?: string;
    files: Array<{ relativePath: string; content?: string }>;
  }) {
    input.resetPlanningConversation();
    input.setProjectDetectMessage("");
    input.setMessage("正在识别项目类型、命令和端口。");
    try {
      const response = selection.absolutePath
        ? await detectProject(selection.absolutePath)
        : await detectProjectManifest({ rootName: selection.rootName, files: selection.files });
      input.setProjectDetection(response.detection);
      if (response.detection.exists) {
        const suggested = { ...response.detection.suggestedConfig, allowExternalProjectPath: true };
        input.setProjectDraft(suggested);
        input.setSelectedProjectId(response.detection.executionReady === false ? "" : suggested.id);
        input.setProjectPathInput(suggested.projectPath);
        input.setAppUrl(suggested.frontendUrl);
        if (response.detection.executionReady === false) {
          input.setProjectDetectMessage("项目类型已识别，但浏览器无法读取本机完整路径。请在下面的 Target Project 中粘贴项目完整路径后保存。");
          input.setMessage("项目类型已识别，仍需补充可执行路径。");
        } else {
          input.setProjectDetectMessage("识别成功，已同步到下面的 Target Project。请检查后保存配置。");
          input.setMessage("项目识别完成，Target Project 已更新。");
        }
      } else {
        input.setProjectDetectMessage("没有找到项目：请确认选择的是项目根目录，并检查 Agent 是否正在运行。");
        input.setMessage("项目路径不可读，请检查文件夹。");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "项目识别失败";
      input.setProjectDetectMessage(`识别失败：${detail}。请先启动 Agent 服务后重试。`);
      input.setMessage(detail);
    }
  }

  async function surfaceProjectDiagnosticToAssistant(inputDiagnostic: {
    project: ProjectConfig;
    runtime: ProjectRuntimeStatus;
    diagnosis?: ProjectDiagnosis;
    connection?: ProjectHealthCheckResult;
    recoveryAdvice?: RuntimeRecoveryAdvice | null;
  }) {
    const failedStages = (inputDiagnostic.diagnosis?.stages ?? [])
      .filter((stage) => stage.status === "failed" || stage.status === "warning");
    const diagnosticKey = [
      inputDiagnostic.project.id,
      inputDiagnostic.runtime.updatedAt ?? "runtime-unknown",
      inputDiagnostic.diagnosis?.checkedAt ?? "diagnosis-unknown",
      inputDiagnostic.connection?.checkedAt ?? "connection-unknown",
      inputDiagnostic.runtime.failureReason ?? inputDiagnostic.runtime.status,
      failedStages.map((stage) => `${stage.stage}:${stage.reason}`).join("|")
    ].join(":");
    if (input.surfacedProjectDiagnostics.current.has(diagnosticKey)) return;
    input.surfacedProjectDiagnostics.current.add(diagnosticKey);

    const pendingId = `project_diagnostic_${Date.now()}`;
    input.setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: "正在读取项目启动阶段、健康检查和脱敏日志，整理失败原因与下一步…",
      createdAt: new Date().toISOString()
    }]);

    const firstFailure = failedStages[0];
    const failureText = input.boundedAssistantText(
      firstFailure?.humanMessage
        || inputDiagnostic.runtime.message
        || inputDiagnostic.connection?.message
        || "项目尚未进入可测试状态",
      1_200
    );
    const missingEnv = failedStages.flatMap((stage) => stage.missingEnv ?? []);
    const ports = failedStages.flatMap((stage) => stage.portConflicts ?? []).map((item) => item.port);
    const deterministicReply = [
      `遇到的问题：${failureText}`,
      `系统已经做了什么：已保存项目启动阶段、连接检查和脱敏诊断。自动化测试尚未开始，因此不会把环境失败误报为产品缺陷。${inputDiagnostic.recoveryAdvice?.summary ? ` AI 启动诊断：${input.boundedAssistantText(inputDiagnostic.recoveryAdvice.summary, 500)}` : ""}`,
      `需要你做什么：${missingEnv.length
        ? `请在项目凭据配置中补齐 ${missingEnv.slice(0, 4).join("、")}，不要在对话中粘贴密钥。`
        : ports.length
          ? `系统可以重新分配沙盒端口；当前冲突端口为 ${ports.slice(0, 4).join("、")}。`
          : inputDiagnostic.runtime.failureReason === "container_runtime_unavailable"
            ? "请允许系统启动 Docker Desktop；沙盒就绪后再重试。"
            : "无需猜测配置；可以继续问我“具体失败在哪一步”，或修正设置后重新诊断。"}`
    ].join("\n");

    try {
      const response = await chatWithTestAssistant({
        projectId: inputDiagnostic.project.id,
        message: "请依据项目当前启动状态和诊断结果，用简单中文说明：发生了什么、系统已经做了什么、用户需要做什么。",
        credentialId: input.defaultCredential?.id,
        history: input.planningMessages.slice(-6).map((item) => ({
          role: item.role,
          content: input.boundedAssistantText(item.content, 1_200)
        })),
        context: {
          runState: `project-${inputDiagnostic.runtime.status}`,
          finalStatus: "blocked",
          summary: input.boundedAssistantText(failureText, 1_200),
          evidenceCount: 0,
          currentStep: input.boundedAssistantText(inputDiagnostic.runtime.phase ?? firstFailure?.stage ?? "project-startup", 300),
          latestLog: input.boundedAssistantText(inputDiagnostic.runtime.message ?? inputDiagnostic.connection?.message ?? failureText, 700),
          pageObservation: input.discovery?.observation,
          failedAssertions: []
        }
      });
      input.setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: response.assistant.reply,
        repairPlan: response.assistant.repairPlan,
        reasoningSummary: response.assistant.reasoningSummary,
        knowledge: response.assistant.knowledge,
        suggestedAction: response.assistant.suggestedAction,
        requiresConfirmation: response.assistant.requiresConfirmation,
        llmTrace: {
          callId: response.call.id,
          model: response.call.model,
          provider: response.call.provider,
          durationMs: response.call.durationMs,
          totalTokens: response.call.usage.totalTokens,
          semanticRepairApplied: response.call.semanticRepairApplied,
          status: response.call.status,
          fallbackApplied: response.call.fallbackApplied,
          errorCode: response.call.errorCode,
          contextId: response.call.knowledgeContextId,
          decisionId: response.call.knowledgeDecisionId,
          validationStatus: response.call.knowledgeValidationStatus
        }
      } : item));
    } catch (error) {
      input.surfacedProjectDiagnostics.current.delete(diagnosticKey);
      input.setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: `模型解读暂时不可用；以下内容来自项目启动器和健康检查的确定性诊断。\n${deterministicReply}`,
        reasoningSummary: {
          phase: "waiting-user",
          observations: [failureText],
          assessment: "项目启动或连接条件未通过，正式测试尚未开始。",
          nextStep: "保留诊断并等待项目运行条件恢复后重试。",
          userAction: deterministicReply.split("需要你做什么：")[1] ?? "修正设置后重新诊断。",
          confidence: "high"
        },
        llmTrace: {
          callId: `project_diagnostic_fallback_${Date.now()}`,
          provider: "deterministic",
          model: "project-startup-diagnostics",
          status: "failed",
          fallbackApplied: true,
          errorCode: error instanceof Error && /truncat/i.test(error.message)
            ? "assistant_output_truncated"
            : "assistant_bridge_unavailable"
        }
      } : item));
    }
  }

  async function diagnoseAndRunCurrentProject(override?: ProjectConfig) {
    const selectedCandidate = override ?? input.projectDraft ?? input.projectDetection?.suggestedConfig;
    if (!selectedCandidate) {
      input.setMessage("请先识别或选择一个项目。");
      return;
    }
    // Diagnosis starts a fresh lifecycle. Never let an unfinished historical
    // Run, its interrupt, or its browser lease masquerade as work created by
    // this click. The backend record remains immutable and available in history.
    input.activeRunRestoreEpochRef.current += 1;
    forgetProjectActiveRun(selectedCandidate.id);
    input.setActiveRunId(null);
    input.setActiveRun(null);
    input.setAgentProjection(null);
    input.setBrowserSession(null);
    input.setLiveRun(null);
    input.setResult(null);
    input.setRepairSession(null);
    input.setInterruptError(null);
    input.setInterruptBusy(false);
    input.setIsRunning(false);
    input.setRunPreviewModalOpen(false);
    input.setScreenshotIssue(null);
    const diagnosisOperationId = crypto.randomUUID();
    input.diagnosisOperationRef.current = {
      id: diagnosisOperationId,
      projectId: selectedCandidate.id
    };
    const isCurrentDiagnosis = () => input.diagnosisOperationRef.current?.id === diagnosisOperationId;
    const detectedCandidate = input.projectDetection?.suggestedConfig;
    const canApplyDetectedLaunch = Boolean(
      detectedCandidate
      && selectedCandidate.allowExternalProjectPath
      && detectedCandidate.projectPath === selectedCandidate.projectPath
    );
    const candidate: ProjectConfig = canApplyDetectedLaunch ? {
      ...selectedCandidate,
      installCommand: detectedCandidate!.installCommand,
      installCommandSpec: detectedCandidate!.installCommandSpec,
      startCommand: detectedCandidate!.startCommand,
      startCommandSpec: detectedCandidate!.startCommandSpec,
      processes: detectedCandidate!.processes,
      frontendUrl: detectedCandidate!.frontendUrl,
      backendUrl: detectedCandidate!.backendUrl,
      healthCheckUrl: detectedCandidate!.healthCheckUrl,
      manifest: detectedCandidate!.manifest ? {
        ...detectedCandidate!.manifest,
        execution: selectedCandidate.allowExternalProjectPath
          ? { ...detectedCandidate!.manifest.execution, mode: "oci" }
          : selectedCandidate.manifest?.execution ?? detectedCandidate!.manifest.execution
      } : selectedCandidate.manifest
    } : selectedCandidate;
    input.setProjectConnection(null);
    input.setProjectDiagnosis(null);
    input.setRuntimeRecoveryAdvice(null);
    input.setProjectLaunchPhase("正在确认项目设置…");
    input.setMessage("正在保存设置并检查可复用的项目沙盒。");
    try {
      if (input.projectDetection?.executionReady === false) {
        input.setProjectLaunchPhase("正在确认项目文件夹…");
        const verified = await detectProject(candidate.projectPath);
        if (!isCurrentDiagnosis()) return;
        if (!verified.detection.exists) {
          input.setMessage("项目路径不可访问，请重新选择项目文件夹。");
          return;
        }
        input.setProjectDetection(verified.detection);
      }
      input.setProjectLaunchPhase("正在保存运行设置…");
      const saved = await saveProject({
        ...candidate,
        allowExternalProjectPath: candidate.allowExternalProjectPath ?? true
      });
      if (!isCurrentDiagnosis()) return;
      input.diagnosisOperationRef.current = { id: diagnosisOperationId, projectId: saved.project.id };
      input.setProjectDraft(saved.project);
      input.setSelectedProjectId(saved.project.id);
      input.setProjectPathInput(saved.project.projectPath);
      input.setAppUrl(saved.project.frontendUrl);

      input.setProjectLaunchPhase("正在检查已有沙盒；仅在未运行时启动项目…");
      // First-run readiness gate: refuse to enter step 2 unless Docker is
      // available and an LLM credential is configured. Surface the missing
      // prerequisites instead of starting and failing halfway (Docker) or
      // succeeding the sandbox only to stall at feature identification (LLM).
      const freshDocker = await getReadiness().catch(() => null);
      const startBlockers: string[] = [];
      if (!input.credentials.length) startBlockers.push("配置模型凭据（OpenAI-compatible key）");
      if (freshDocker && !freshDocker.docker.available) startBlockers.push(`启动 ${freshDocker.docker.engine}（容器运行时不可用）`);
      if (startBlockers.length) {
        input.setProjectLaunchPhase("");
        input.setMessage(`未进入沙盒运行，请先${startBlockers.join("、")}。`);
        return;
      }
      const accepted = await startProjectAsync(saved.project.id);
      if (!isCurrentDiagnosis()) return;
      input.setProjectRuntime(accepted.runtime);
      input.setProjectLaunchPhase(accepted.reused && accepted.runtime.status === "running"
        ? "已复用正在运行的项目沙盒，正在检查页面…"
        : accepted.reused
          ? "项目沙盒已在准备中，继续等待运行状态…"
          : "启动任务已提交，正在等待项目响应…");
      const sandboxPrepareTimeout = saved.project.manifest?.execution.mode === "oci"
        ? (saved.project.manifest.budget.prepareTimeoutMs ?? 300_000)
        : 0;
      const startupDeadline = Date.now()
        + sandboxPrepareTimeout
        + Math.max(saved.project.timeoutMs ?? 30_000, 30_000)
        + 10_000;
      let startedRuntime = accepted.runtime;
      let missedRuntimePolls = 0;
      while (Date.now() < startupDeadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (!isCurrentDiagnosis()) return;
        const snapshot = await getProjectRuntime(saved.project.id).catch(() => null);
        if (!isCurrentDiagnosis()) return;
        if (!snapshot) {
          missedRuntimePolls += 1;
          input.setProjectLaunchPhase(missedRuntimePolls > 1 ? "Agent 暂时断开，正在自动重连…" : "正在同步启动状态…");
          continue;
        }
        missedRuntimePolls = 0;
        input.setProjectLaunchPhase(
          snapshot.runtime.status === "installing"
            ? "正在安装项目依赖…"
            : snapshot.runtime.status === "starting"
              ? "正在等待项目启动…"
              : "正在确认项目运行状态…"
        );
        input.setProjectRuntime(snapshot.runtime);
        startedRuntime = snapshot.runtime;
        if (!["idle", "installing", "starting"].includes(snapshot.runtime.status)) break;
      }
      input.setProjectRuntime(startedRuntime);
      if (startedRuntime.status !== "running") {
        input.setProjectLaunchPhase("正在汇总失败诊断…");
        const diagnosed = await diagnoseProject(saved.project.id).catch(() => null);
        if (!isCurrentDiagnosis()) return;
        if (diagnosed) input.setProjectDiagnosis(diagnosed.diagnosis);
        let recoveryAdvice: RuntimeRecoveryAdvice | null = null;
        if (input.defaultCredential) {
          input.setProjectLaunchPhase("正在使用 AI 分析启动日志…");
          const recovery = await getAiStartRecovery(saved.project.id, input.defaultCredential.id).catch(() => null);
          if (!isCurrentDiagnosis()) return;
          if (recovery) {
            recoveryAdvice = recovery.advice;
            input.setRuntimeRecoveryAdvice(recovery.advice);
          }
        }
        const failureMessage = startedRuntime.message ?? "项目启动失败，请查看诊断结果。";
        input.setPlanningAutomation({ phase: "blocked", detail: failureMessage });
        input.setMessage(failureMessage);
        void surfaceProjectDiagnosticToAssistant({
          project: saved.project,
          runtime: startedRuntime,
          diagnosis: diagnosed?.diagnosis,
          recoveryAdvice
        });
        await input.recoverProjectAndRetry("runtime");
        return;
      }

      const [tested, diagnosed] = await Promise.all([
        testProjectConnection(saved.project.id),
        diagnoseProject(saved.project.id)
      ]);
      if (!isCurrentDiagnosis()) return;
      input.setProjectConnection(tested.result);
      input.setProjectDiagnosis(diagnosed.diagnosis);
      const readyForPlanning = tested.result.ok && diagnosed.diagnosis.overallStatus === "passed";
      if (readyForPlanning) {
        input.setPreviewSessionProjectId(saved.project.id);
        input.closeDrawers();
      }
      input.setMessage(
        readyForPlanning
          ? "项目已准备好。请在 AI 测试助手中描述你想验证的内容。"
          : diagnosed.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage
            ?? tested.result.message
      );
      if (!readyForPlanning) {
        const failureMessage = diagnosed.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage
          ?? tested.result.message;
        input.setPlanningAutomation({ phase: "blocked", detail: failureMessage });
        void surfaceProjectDiagnosticToAssistant({
          project: saved.project,
          runtime: startedRuntime,
          diagnosis: diagnosed.diagnosis,
          connection: tested.result
        });
        await input.recoverProjectAndRetry(tested.result.ok ? "discovery" : "runtime");
      }
    } catch (error) {
      if (!isCurrentDiagnosis()) return;
      const detail = error instanceof Error ? error.message : "项目诊断失败";
      const failedRuntime: ProjectRuntimeStatus = {
        projectId: selectedCandidate.id,
        status: "failed",
        phase: "failed",
        updatedAt: new Date().toISOString(),
        failureReason: "unknown",
        message: detail
      };
      input.setProjectRuntime(failedRuntime);
      input.setPlanningAutomation({ phase: "blocked", detail });
      input.setMessage(detail);
      void surfaceProjectDiagnosticToAssistant({
        project: candidate,
        runtime: failedRuntime
      });
    } finally {
      if (isCurrentDiagnosis()) {
        input.setProjectLaunchPhase("");
        input.diagnosisOperationRef.current = null;
      }
    }
  }

  async function applyAiRecoveryCandidate(candidateId: string) {
    const adviceCandidate = input.runtimeRecoveryAdvice?.candidates.find((item) => item.id === candidateId);
    const current = input.projectDraft ?? input.projectDetection?.suggestedConfig;
    if (!adviceCandidate || !current) return;
    const parts = adviceCandidate.command.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || !["npm", "pnpm", "yarn", "node", "python", "python3", "uv", "uvicorn"].includes(parts[0])) {
      input.setMessage("AI 返回的候选启动方式未通过本地 allowlist 校验。");
      return;
    }
    const commandSpec = { executable: parts[0], args: parts.slice(1), timeoutMs: 300_000 };
    const targetUrl = adviceCandidate.frontendUrl;
    const recovered: ProjectConfig = current.processes?.length
      ? {
        ...current,
        frontendUrl: targetUrl ?? current.frontendUrl,
        healthCheckUrl: targetUrl ?? current.healthCheckUrl,
        processes: current.processes.map((process, index) => index === 0
          ? { ...process, command: adviceCandidate.command, commandSpec, healthCheckUrl: targetUrl ?? process.healthCheckUrl }
          : process)
      }
      : { ...current, startCommand: adviceCandidate.command, startCommandSpec: commandSpec, frontendUrl: targetUrl ?? current.frontendUrl, healthCheckUrl: targetUrl ?? current.healthCheckUrl };
    input.setProjectDraft(recovered);
    input.setRuntimeRecoveryAdvice(null);
    await diagnoseAndRunCurrentProject(recovered);
  }

  async function saveCurrentProjectLoginCredential(credential: {
    username: string;
    password: string;
    usernameEnv: string;
    passwordEnv: string;
  }) {
    if (!input.projectDraft) throw new Error("请先识别项目。");
    const prepared = await saveProject({
      ...input.projectDraft,
      login: {
        ...input.projectDraft.login,
        method: "env",
        usernameEnv: credential.usernameEnv,
        passwordEnv: credential.passwordEnv
      }
    });
    const response = await saveProjectLoginCredential(prepared.project.id, credential);
    input.setProjectDraft(response.project);
    input.setSelectedProjectId(response.project.id);
    input.setRevealProjectLoginSettings(false);
    if (input.authBlockDetected) {
      input.setMessage("测试账号已加密保存，正在使用新账号恢复自动化测试。");
      window.setTimeout(() => {
        void input.retryWithConfiguredLogin(response.project);
      }, 0);
    } else {
      input.setMessage("测试账号已加密保存，运行时会自动注入沙盒。");
    }
    return response.project;
  }

  async function savePreparationLoginAndContinue() {
    if (!input.preparationRequiresLogin) {
      input.setPlanningAutomation({ phase: "preparing-project", detail: "正在检查沙盒、项目服务和测试路径。" });
      return;
    }
    if (input.projectDraft?.login?.credentialId && !input.preparationLoginUsername.trim() && !input.preparationLoginPassword) {
      input.setPreparationLoginError("");
      input.setPlanningAutomation({
        phase: !input.permissionProfile.observe || !input.permissionProfile.browserControl ? "needs-permission" : "preparing-project",
        detail: !input.permissionProfile.observe || !input.permissionProfile.browserControl
          ? "先允许本次浏览器操作，授权后系统会按顺序准备和执行测试。"
          : "正在检查沙盒、项目服务和测试路径。"
      });
      if (!input.permissionProfile.observe || !input.permissionProfile.browserControl) return;
      const activePlan = input.planningResult;
      if (activePlan?.recommendedScenarioId && input.selectedProjectExecutionMode !== "oci") {
        input.setScenarioId(activePlan.recommendedScenarioId);
        await input.executeConfirmedScenarioAutomatically(activePlan.recommendedScenarioId);
      } else {
        await input.continueAutomaticPlanning(input.permissionProfile, input.projectDraft ?? undefined, activePlan ?? undefined);
      }
      return;
    }
    if (!input.projectDraft) {
      input.setPreparationLoginError("项目配置尚未保存，请先完成项目接入。");
      return;
    }
    if (!input.preparationLoginUsername.trim() || !input.preparationLoginPassword) {
      input.setPreparationLoginError("本次计划包含登录步骤，请填写测试账号和测试密码，或先配置已保存的测试账号。");
      return;
    }
    input.setPreparationLoginSaving(true);
    input.setPreparationLoginError("");
    try {
      const savedProject = await saveCurrentProjectLoginCredential({
        username: input.preparationLoginUsername.trim(),
        password: input.preparationLoginPassword,
        usernameEnv: input.projectDraft.login?.usernameEnv ?? input.projectDetection?.loginCapability?.usernameEnv ?? "E2E_USERNAME",
        passwordEnv: input.projectDraft.login?.passwordEnv ?? input.projectDetection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD"
      });
      input.setPreparationLoginPassword("");
      input.setPlanningAutomation({
        phase: !input.permissionProfile.observe || !input.permissionProfile.browserControl ? "needs-permission" : "preparing-project",
        detail: !input.permissionProfile.observe || !input.permissionProfile.browserControl
          ? "测试账号已加密保存。请允许本次浏览器操作后继续。"
          : "测试账号已加密保存，正在检查沙盒、项目服务和测试路径。"
      });
      if (!input.permissionProfile.observe || !input.permissionProfile.browserControl) return;
      const activePlan = input.planningResult;
      if (activePlan?.recommendedScenarioId && input.selectedProjectExecutionMode !== "oci") {
        input.setScenarioId(activePlan.recommendedScenarioId);
        await input.executeConfirmedScenarioAutomatically(activePlan.recommendedScenarioId);
      } else {
        await input.continueAutomaticPlanning(input.permissionProfile, savedProject, activePlan ?? undefined);
      }
    } catch (error) {
      input.setPreparationLoginError(error instanceof Error ? error.message : "测试账号保存失败，请重试。");
      input.setPlanningAutomation({ phase: "needs-credentials", detail: "测试账号尚未保存，项目准备暂停。" });
    } finally {
      input.setPreparationLoginSaving(false);
    }
  }

  async function stopCurrentProject() {
    if (!input.projectDraft) return;
    const response = await stopProject(input.projectDraft.id);
    input.setProjectRuntime(response.runtime);
    input.setMessage(response.runtime.message ?? `项目状态：${response.runtime.status}`);
  }

  /** Keeps interrupt resume authoritative; credential save never starts a duplicate Run. */
  async function saveInterruptCredential(username: string, password: string) {
    if (!input.projectDraft) throw new Error("请先识别项目。");
    const usernameEnv = input.projectDraft.login?.usernameEnv ?? input.projectDetection?.loginCapability?.usernameEnv ?? "E2E_USERNAME";
    const passwordEnv = input.projectDraft.login?.passwordEnv ?? input.projectDetection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD";
    const prepared = await saveProject({
      ...input.projectDraft,
      login: { ...input.projectDraft.login, method: "env", usernameEnv, passwordEnv }
    });
    const response = await saveProjectLoginCredential(prepared.project.id, { username, password, usernameEnv, passwordEnv });
    input.setProjectDraft(response.project);
    input.setSelectedProjectId(response.project.id);
    input.setMessage("测试账号已加密保存，正在注入沙盒继续本次测试。");
  }

  return {
    detectCurrentProjectPath,
    diagnoseAndRunCurrentProject,
    applyAiRecoveryCandidate,
    saveCurrentProjectLoginCredential,
    savePreparationLoginAndContinue,
    stopCurrentProject,
    saveInterruptCredential
  };
}
