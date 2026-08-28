import type { Dispatch, SetStateAction } from "react";
import { getProjectRecovery, recoverAndRetryProject } from "../api";
import type { AssistantSuggestedAction, PlanningMessage, ProjectConfig, ProjectRecoveryResult, ProjectRuntimeStatus, RuntimeRecoveryAdvice } from "../types";

type PlanningAutomation = {
  phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked";
  detail: string;
  scenarioId?: string;
};

interface ProjectRecoveryOptions {
  selectedProjectId: string;
  projectDraft: ProjectConfig | null;
  credentialId?: string;
  projectRecoveryBusy: boolean;
  getActionLabel: (action: Exclude<AssistantSuggestedAction, "none">) => string;
  normalizeError: (value: string) => string;
  boundText: (value: unknown, limit: number) => string;
  setMessage: (message: string) => void;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setProjectRecoveryBusy: Dispatch<SetStateAction<boolean>>;
  setProjectRecovery: Dispatch<SetStateAction<ProjectRecoveryResult | null>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setRuntimeRecoveryAdvice: Dispatch<SetStateAction<RuntimeRecoveryAdvice | null>>;
  setAssistantSuggestedAction: Dispatch<SetStateAction<{ action: Exclude<AssistantSuggestedAction, "none">; label: string } | null>>;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomation>>;
  setPreviewSessionProjectId: Dispatch<SetStateAction<string>>;
}

/** Server-authoritative runtime recovery. UI state is only a projection of the persisted recovery record. */
export function useProjectRecovery({
  selectedProjectId, projectDraft, credentialId, projectRecoveryBusy, getActionLabel,
  normalizeError, boundText, setMessage, setPlanningMessages, setProjectRecoveryBusy,
  setProjectRecovery, setProjectRuntime, setRuntimeRecoveryAdvice,
  setAssistantSuggestedAction, setPlanningAutomation, setPreviewSessionProjectId
}: ProjectRecoveryOptions) {
  async function recoverProjectAndRetry(mode: "auto" | "runtime" | "discovery" = "auto"): Promise<ProjectRecoveryResult | undefined> {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      const detail = "当前没有已选择的项目，因此没有可执行的恢复操作。";
      setMessage(detail);
      setPlanningMessages((current) => [...current, {
        id: `recovery_unavailable_${Date.now()}`,
        role: "assistant",
        content: `遇到的问题：${detail}\n系统正在做什么：未启动重试，也没有创建代码修复。\n需要你操作：先选择并保存一个项目。`,
        createdAt: new Date().toISOString()
      }]);
      return undefined;
    }
    if (projectRecoveryBusy) return undefined;
    setProjectRecoveryBusy(true);
    const pendingId = `project_recovery_${Date.now()}`;
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: mode === "discovery"
        ? "遇到的问题：页面 Discovery 尚未完成。\n系统正在做什么：正在重新扫描页面、控件、网络和可执行路径。\n需要你操作：暂时无需操作。"
        : "遇到的问题：安全沙盒或项目服务尚未就绪。\n系统正在做什么：正在重新启动沙盒、检查 Docker Desktop、项目服务和页面连通性。\n需要你操作：暂时无需操作；若 180 秒后仍不可用，系统会给出明确提示。",
      createdAt: new Date().toISOString(),
      streaming: true
    }]);
    setMessage(mode === "discovery" ? "正在重新扫描页面并绑定路径…" : "正在重新启动沙盒并诊断项目…");
    try {
      const accepted = await recoverAndRetryProject(projectId, mode, credentialId);
      let recovery = accepted.recovery;
      setProjectRecovery(recovery);
      const deadline = Date.now() + 190_000;
      while (["accepted", "running"].includes(recovery.status) && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const snapshot = await getProjectRecovery(projectId);
        recovery = snapshot.recovery;
        setProjectRecovery(recovery);
        setProjectRuntime(recovery.runtime);
        setRuntimeRecoveryAdvice(recovery.advice ?? null);
        const lastEvent = recovery.events.at(-1);
        setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
          ...item,
          content: ["遇到的问题：正在恢复项目测试环境。", `系统正在做什么：${lastEvent?.message ?? "正在同步恢复状态。"}`, `需要你操作：${recovery.userAction}`].join("\n")
        } : item));
      }
      setProjectRecovery(recovery);
      setProjectRuntime(recovery.runtime);
      setRuntimeRecoveryAdvice(recovery.advice ?? null);
      const lastEvent = recovery.events.at(-1);
      const completed = recovery.status === "completed";
      const advisorText = recovery.advice?.status === "passed" && recovery.advice.summary ? `\nAI 判断：${boundText(recovery.advice.summary, 500)}` : "";
      const finalText = completed
        ? `遇到的问题：恢复完成。\n系统已经做了什么：${lastEvent?.message ?? "沙盒、页面连通性和 Discovery 已恢复。"}\n需要你操作：无需操作；现在可以继续生成或执行测试计划。`
        : `遇到的问题：${lastEvent?.message ?? recovery.sourceError ?? "恢复未完成。"}\n系统已经做了什么：已执行受限恢复并保留运行状态；没有修改项目源码，也没有覆盖既有证据。${advisorText}\n需要你操作：${recovery.userAction}`;
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? { ...item, streaming: false, content: finalText, suggestedAction: completed ? "start-run" : "create-repair", requiresConfirmation: true } : item));
      setAssistantSuggestedAction({ action: completed ? "start-run" : "create-repair", label: completed ? getActionLabel("start-run") : "在沙盒中分析启动问题" });
      setMessage(completed ? "项目环境已恢复，可以继续测试。" : recovery.userAction);
      if (completed) {
        setPlanningAutomation({ phase: "idle", detail: "项目恢复完成，等待继续规划或执行测试。" });
        setPreviewSessionProjectId(projectId);
      } else {
        setPlanningAutomation({ phase: "blocked", detail: lastEvent?.message ?? recovery.sourceError ?? "项目恢复未完成" });
      }
      return recovery;
    } catch (error) {
      const detail = normalizeError(error instanceof Error ? error.message : "恢复请求失败");
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        streaming: false,
        content: `遇到的问题：${detail}\n系统已经做了什么：恢复请求未完成，系统没有启动代码修复或覆盖已有测试证据。\n需要你操作：请稍后重试；如果持续失败，请查看运行详情。`
      } : item));
      setMessage(detail);
      return undefined;
    } finally {
      setProjectRecoveryBusy(false);
    }
  }
  return { recoverProjectAndRetry };
}
