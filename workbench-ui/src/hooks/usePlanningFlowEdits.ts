import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PlannedBusinessFlow, PlanningConversationResult } from "../types";

interface PlanningFlowEditOptions {
  planningResult: PlanningConversationResult | null;
  scenarioId: string;
  setPlanningResult: Dispatch<SetStateAction<PlanningConversationResult | null>>;
  setScenarioId: Dispatch<SetStateAction<string>>;
  setMessage: (message: string) => void;
}

/** Draft-only scope edits; persisted runs retain their own immutable plan snapshot. */
export function usePlanningFlowEdits({
  planningResult, scenarioId, setPlanningResult, setScenarioId, setMessage
}: PlanningFlowEditOptions) {
  const [excludedPlanningFlowIds, setExcludedPlanningFlowIds] = useState<Set<string>>(() => new Set());

  function resetPlanningFlowEdits() {
    setExcludedPlanningFlowIds(new Set());
  }

  function excludePlanningFlow(flowId: string) {
    const removed = planningResult?.businessFlows.find((flow) => flow.id === flowId);
    if (!removed) return;
    setExcludedPlanningFlowIds((current) => new Set([...current, flowId]));
    setPlanningResult((current) => {
      if (!current) return current;
      const businessFlows = current.businessFlows.filter((flow) => flow.id !== flowId);
      const executable = businessFlows.filter((flow) => flow.status === "executable").length;
      const autoBindable = businessFlows.filter((flow) => flow.status === "auto-bindable").length;
      const needsInput = businessFlows.filter((flow) => flow.status === "needs-input").length;
      const gaps = businessFlows.filter((flow) => flow.status === "coverage-gap").length;
      return {
        ...current,
        businessFlows,
        coverage: {
          ...current.coverage,
          discovered: businessFlows.length,
          executable,
          autoBindable,
          needsInput,
          gaps,
          sourceCandidates: businessFlows.reduce((total, flow) => total + (flow.sourceCount ?? 1), 0),
          confidence: businessFlows.length && gaps === 0 ? "high" : businessFlows.length ? "medium" : "low"
        },
        plan: {
          ...current.plan,
          risks: current.plan.risks.filter((risk) => !risk.id.endsWith(flowId)),
          levels: current.plan.levels.map((level) => ({ ...level, paths: level.paths.filter((path) => path.id !== flowId) }))
        },
        recommendedScenarioId: businessFlows.find((flow) => flow.status === "executable")?.scenarioId
      };
    });
    if (removed.scenarioId && removed.scenarioId === scenarioId) setScenarioId("");
    setMessage(`已从本次测试计划排除“${removed.title}”。不会修改项目代码。`);
  }

  function editPlanningFlowTitle(flowId: string, title: string) {
    setPlanningResult((current) => current ? {
      ...current,
      businessFlows: current.businessFlows.map((flow) => flow.id === flowId ? { ...flow, title } : flow)
    } : current);
  }

  function addPlanningFlow(title: string) {
    setPlanningResult((current) => {
      if (!current) return current;
      const flow: PlannedBusinessFlow = {
        id: `manual_${Math.random().toString(36).slice(2, 10)}`,
        title,
        kind: "scenario",
        target: "",
        status: "needs-input",
        confidence: "low",
        reason: "用户手动添加的功能，待确认页面/控件/预期结果。",
        requiredInformation: []
      };
      const businessFlows = [...current.businessFlows, flow];
      return {
        ...current,
        businessFlows,
        coverage: { ...current.coverage, discovered: businessFlows.length, needsInput: businessFlows.filter((item) => item.status === "needs-input").length }
      };
    });
    setMessage(`已添加自定义功能“${title}”。`);
  }

  return { excludedPlanningFlowIds, resetPlanningFlowEdits, excludePlanningFlow, editPlanningFlowTitle, addPlanningFlow };
}
