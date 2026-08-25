import type { Dispatch, SetStateAction } from "react";
import {
  diagnoseProject,
  getProjectRuntime,
  saveProject,
  startProjectAsync,
  testProjectConnection
} from "../api";
import type {
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus
} from "../types";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";

interface UseProjectPreparationInput {
  projectDraft: ProjectConfig | null;
  projectDetection: ProjectDetectionResult | null;
  projectRuntime: ProjectRuntimeStatus | null;
  setProjectDraft: Dispatch<SetStateAction<ProjectConfig | null>>;
  setSelectedProjectId: (projectId: string) => void;
  setProjectPathInput: Dispatch<SetStateAction<string>>;
  setAppUrl: Dispatch<SetStateAction<string>>;
  setProjectConnection: Dispatch<SetStateAction<ProjectHealthCheckResult | null>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setProjectDiagnosis: Dispatch<SetStateAction<ProjectDiagnosis | null>>;
  setPreviewSessionProjectId: Dispatch<SetStateAction<string>>;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
}

/**
 * Persists the selected target and waits for its bounded sandbox startup.
 * The hook only reports readiness; it does not generate a test plan or create
 * a test Run.
 */
export function useProjectPreparation(input: UseProjectPreparationInput) {
  async function ensureProjectReadyForAutomation(projectOverride?: ProjectConfig) {
    const candidate = projectOverride ?? input.projectDraft ?? input.projectDetection?.suggestedConfig;
    if (!candidate) throw new Error("没有可运行的项目配置，请重新识别项目。");
    const saved = await saveProject({ ...candidate, allowExternalProjectPath: candidate.allowExternalProjectPath ?? true });
    input.setProjectDraft(saved.project);
    input.setSelectedProjectId(saved.project.id);
    input.setProjectPathInput(saved.project.projectPath);
    input.setAppUrl(saved.project.frontendUrl);

    const currentConnection = await testProjectConnection(saved.project.id).catch(() => null);
    if (currentConnection?.result.ok) {
      input.setProjectConnection(currentConnection.result);
      input.setPreviewSessionProjectId(saved.project.id);
      const liveUrl = input.projectRuntime?.status === "running"
        ? input.projectRuntime.frontendUrl ?? saved.project.frontendUrl
        : saved.project.frontendUrl;
      return { ...saved.project, frontendUrl: liveUrl, healthCheckUrl: liveUrl };
    }
    const accepted = await startProjectAsync(saved.project.id);
    input.setProjectRuntime(accepted.runtime);
    const sandboxPrepareTimeout = saved.project.manifest?.execution.mode === "oci"
      ? (saved.project.manifest.budget.prepareTimeoutMs ?? 300_000)
      : 0;
    const startupDeadline = Date.now() + sandboxPrepareTimeout + Math.max(saved.project.timeoutMs ?? 30_000, 30_000) + 10_000;
    let startedRuntime = accepted.runtime;
    while (Date.now() < startupDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const snapshot = await getProjectRuntime(saved.project.id).catch(() => null);
      if (!snapshot) {
        input.setPlanningAutomation((current) => ({
          ...current,
          phase: "preparing-project",
          detail: "Agent 暂时断开，正在自动重新连接并恢复启动状态。"
        }));
        continue;
      }
      startedRuntime = snapshot.runtime;
      input.setProjectRuntime(startedRuntime);
      input.setPlanningAutomation((current) => ({
        ...current,
        phase: "preparing-project",
        detail: startedRuntime.status === "installing"
          ? "正在沙盒中安装项目依赖；完成后会自动继续。"
          : startedRuntime.status === "starting"
            ? startedRuntime.message || "正在启动 Docker 沙盒和项目服务。"
            : "正在确认项目是否可以访问。"
      }));
      if (!["idle", "installing", "starting"].includes(startedRuntime.status)) break;
    }
    if (startedRuntime.status !== "running") {
      const diagnosed = await diagnoseProject(saved.project.id).catch(() => null);
      if (diagnosed) input.setProjectDiagnosis(diagnosed.diagnosis);
      throw new Error(startedRuntime.message ?? "项目无法启动。");
    }
    const connected = await testProjectConnection(saved.project.id);
    input.setProjectConnection(connected.result);
    if (!connected.result.ok) throw new Error(connected.result.message || "项目启动后仍无法访问。");
    input.setPreviewSessionProjectId(saved.project.id);
    const liveUrl = startedRuntime.frontendUrl ?? saved.project.frontendUrl;
    input.setAppUrl(liveUrl);
    return {
      ...saved.project,
      frontendUrl: liveUrl,
      backendUrl: startedRuntime.backendUrl ?? saved.project.backendUrl,
      healthCheckUrl: startedRuntime.healthCheckUrl ?? liveUrl
    };
  }

  return { ensureProjectReadyForAutomation };
}
