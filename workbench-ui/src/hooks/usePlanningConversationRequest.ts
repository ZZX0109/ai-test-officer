import type { Dispatch, SetStateAction } from "react";
import { continuePlanningConversation } from "../api";
import { discoveryOrchestrationCopy } from "../discoveryOrchestrationCopy";
import type {
  Credential,
  DiscoveryScanResult,
  HarnessGapScenarioDraft,
  IntakeAnalysis,
  PlanningConversationResult,
  PlanningMessage,
  ProjectConfig
} from "../types";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";

export type PlanningRequestMode = "llm-guided" | "scan-only";
export interface PlanningRequestOptions {
  internalInstruction?: boolean;
  preserveAutomationState?: boolean;
}

interface UsePlanningConversationRequestInput {
  selectedProjectId: string;
  projectDraft: ProjectConfig | null;
  planningInput: string;
  planningMessages: PlanningMessage[];
  diffText: string;
  bugTicketText: string;
  defaultCredential?: Credential;
  resetPlanningFlowEdits: () => void;
  setPlanningInput: Dispatch<SetStateAction<string>>;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setPlanningBusy: Dispatch<SetStateAction<boolean>>;
  setPlanningConfirmed: Dispatch<SetStateAction<boolean>>;
  setPlanningResult: Dispatch<SetStateAction<PlanningConversationResult | null>>;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
  setScenarioId: Dispatch<SetStateAction<string>>;
  setDiscovery: Dispatch<SetStateAction<DiscoveryScanResult | null>>;
  setScenarioDrafts: Dispatch<SetStateAction<HarnessGapScenarioDraft[]>>;
  setAnalysis: Dispatch<SetStateAction<IntakeAnalysis | null>>;
  setRequirementText: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
}

/**
 * Converts an assistant message into a durable planning request. This hook
 * intentionally stops before sandbox preparation or execution: a generated
 * plan remains a draft until the explicit planning/permission flow continues.
 */
export function usePlanningConversationRequest(input: UsePlanningConversationRequestInput) {
  async function continueTestPlanning(
    requestedInput?: string,
    planningMode: PlanningRequestMode = "llm-guided",
    options: PlanningRequestOptions = {}
  ) {
    const content = (requestedInput ?? input.planningInput).trim();
    const fullInventoryCommand = ["全面扫描", "灰度测试"].includes(
      content.replace(/[\s，。！？、,.!?：:；;“”"'`]/g, "")
    );
    const effectivePlanningMode = fullInventoryCommand && planningMode !== "scan-only"
      ? "llm-guided"
      : planningMode;
    const projectId = input.selectedProjectId || input.projectDraft?.id;
    if (!projectId) {
      input.setMessage("请先接入并识别项目，再开始规划测试。");
      return;
    }
    if (!content) {
      input.setMessage("请先描述你想测试什么。");
      return;
    }
    const userMessage: PlanningMessage = {
      id: `planning_user_${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    if (!options.internalInstruction) input.setPlanningMessages((current) => [...current, userMessage]);
    input.setPlanningInput("");
    input.setPlanningBusy(true);
    input.setPlanningConfirmed(false);
    if (fullInventoryCommand) {
      input.setPlanningResult(null);
      input.setDiscovery(null);
    }
    if (!options.preserveAutomationState) input.setPlanningAutomation({ phase: "idle", detail: "" });
    input.setScenarioId("");
    input.setMessage(effectivePlanningMode === "scan-only"
      ? "正在用确定性扫描列出项目测试清单。"
      : fullInventoryCommand
        ? "正在扫描完整业务流程，并由 AI 排定风险和补充遗漏。"
        : "正在分析你的目标，并由 AI 制定相关测试计划。");
    try {
      const response = await continuePlanningConversation({
        projectId,
        message: content,
        diff: input.diffText,
        bugTicket: input.bugTicketText,
        history: input.planningMessages,
        planningMode: effectivePlanningMode,
        credentialId: effectivePlanningMode === "llm-guided" ? input.defaultCredential?.id : undefined
      });
      if (response.discovery) {
        input.setDiscovery(response.discovery);
        input.setScenarioDrafts(response.discovery.drafts);
      }
      const orchestrationCopy = response.discovery ? discoveryOrchestrationCopy(response.discovery) : null;
      const smokeReady = !response.discovery?.orchestration || response.discovery.orchestration.status === "ready";
      const keepCodePlanWhileRuntimeWaits = fullInventoryCommand && response.planning.businessFlows.length > 0;
      const assistantMessage: PlanningMessage = {
        id: `planning_assistant_${Date.now()}`,
        role: "assistant",
        content: smokeReady || !orchestrationCopy || keepCodePlanWhileRuntimeWaits
          ? response.planning.reply
          : [
            `遇到的问题：${orchestrationCopy.reason}`,
            `系统已经做了什么：${orchestrationCopy.completed}`,
            `需要你做什么：${orchestrationCopy.nextStep}`
          ].join("\n"),
        createdAt: new Date().toISOString()
      };
      input.setPlanningMessages((current) => [...current, assistantMessage]);
      input.setAnalysis(response.planning.analysis);
      const combinedRequirement = [...input.planningMessages, ...(options.internalInstruction ? [] : [userMessage])]
        .filter((item) => item.role === "user")
        .map((item) => item.content)
        .join("\n");
      input.setRequirementText(combinedRequirement);
      if (!smokeReady && !keepCodePlanWhileRuntimeWaits) {
        input.setPlanningResult(null);
        input.setPlanningConfirmed(false);
        input.setScenarioId("");
        input.setMessage(orchestrationCopy?.status ?? "页面预检未通过，测试尚未开始。");
        return null;
      }
      input.resetPlanningFlowEdits();
      input.setPlanningResult(response.planning);
      input.setMessage(response.planning.llmPlanning?.status === "failed"
        ? "代码扫描已完成，但 AI 规划暂时不可用；已保留可继续编辑的规则计划。"
        : response.planning.llmPlanning?.status === "not_configured"
          ? "代码扫描已完成。配置 AI 模型后可获得优先级建议和追问。"
          : !smokeReady && keepCodePlanWhileRuntimeWaits
            ? "代码测试清单已生成；页面前置条件会在确认执行时自动处理。"
            : response.planning.phase === "clarifying"
              ? "系统需要你回答几个问题，回答后会更新计划。"
              : "测试计划草案已生成，请检查业务流程后确认。");
      return response.planning;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "测试规划失败";
      input.setPlanningMessages((current) => [...current, {
        id: `planning_error_${Date.now()}`,
        role: "assistant",
        content: `暂时无法生成计划：${detail}`,
        createdAt: new Date().toISOString()
      }]);
      input.setMessage(detail);
      return null;
    } finally {
      input.setPlanningBusy(false);
    }
  }

  return { continueTestPlanning };
}
