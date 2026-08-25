import type { Dispatch, SetStateAction } from "react";
import {
  approveRunPlan,
  createVisualRun,
  grantRunPermissions,
  waitForRunReport
} from "../api";
import type {
  BrowserSession,
  Credential,
  PermissionProfile,
  PlanningMessage,
  ProjectConfig,
  RunProjection,
  RunResult
} from "../types";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";
import type { WorkspaceAction } from "../state/workspaceReducer";

export interface AutomationFailure {
  scenarioId: string;
  title?: string;
  target?: string;
  stage: "binding" | "execution";
  detail: string;
  requiredInformation?: string[];
}

export interface ScenarioExecutionTarget {
  appUrl: string;
  projectId: string;
  batchMode?: boolean;
  coverageScenarioIds?: string[];
  coverageInventory?: Array<{
    id: string;
    title: string;
    status?: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
    kind: "page" | "component" | "api" | "scenario" | "data" | "background-task";
    target: string;
    sourceNodeIds: string[];
    sourceCount: number;
    surfaces?: Array<"page" | "api" | "data" | "background-task">;
    requiredEvidenceKinds?: string[];
    preconditions?: string[];
  }>;
  coverageMode?: "targeted" | "full";
  dynamicBrowser?: boolean;
}

interface UseConfirmedScenarioExecutionInput {
  selectedProjectId: string;
  projectDraft: ProjectConfig | null;
  previewUrl?: string;
  requirementText: string;
  diffText: string;
  executionMode: "oci" | "trusted-local";
  permissionProfile: PermissionProfile;
  defaultCredential?: Credential;
  beginWorkspaceOperation: (phase: "executing", projectId: string) => string;
  dispatchWorkspace: Dispatch<WorkspaceAction>;
  closeDrawers: () => void;
  userFacingError: (value: string) => string;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setRunPreviewModalOpen: Dispatch<SetStateAction<boolean>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  setBrowserSession: Dispatch<SetStateAction<BrowserSession | null>>;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
  setActiveRun: Dispatch<SetStateAction<RunProjection | null>>;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setAutomationFailures: Dispatch<SetStateAction<AutomationFailure[]>>;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
}

/**
 * Starts an already approved test plan and projects its durable Run back into
 * the workbench. It cannot compile a plan, change the Gate, or write the
 * target project; it only drives the explicit run lifecycle APIs.
 */
export function useConfirmedScenarioExecution(input: UseConfirmedScenarioExecutionInput) {
  async function executeConfirmedScenarioAutomatically(
    selectedScenarioId: string | undefined,
    grantedProfile = input.permissionProfile,
    targetOverride?: ScenarioExecutionTarget
  ) {
    if (!grantedProfile.observe || !grantedProfile.browserControl) {
      input.setPlanningAutomation({
        phase: "needs-permission",
        detail: "测试路径已准备好。允许本次浏览器操作后，系统会自动继续。",
        scenarioId: selectedScenarioId
      });
      input.setMessage("测试路径已准备好，等待浏览器操作授权。");
      input.setRunPreviewModalOpen(true);
      return;
    }
    input.closeDrawers();
    input.setRunPreviewModalOpen(false);
    input.setPlanningAutomation({ phase: "starting-run", detail: "正在创建运行并自动完成计划审批。", scenarioId: selectedScenarioId });
    const operationProjectId = targetOverride?.projectId ?? (input.selectedProjectId || input.projectDraft?.id || "");
    const workspaceRequestId = input.beginWorkspaceOperation("executing", operationProjectId);
    input.setIsRunning(true);
    try {
      const created = await createVisualRun(targetOverride?.appUrl ?? input.previewUrl, grantedProfile, selectedScenarioId, {
        requirement: input.requirementText,
        diff: input.diffText,
        projectId: targetOverride?.projectId ?? (input.selectedProjectId || input.projectDraft?.id),
        executionMode: input.executionMode,
        coverageScenarioIds: targetOverride?.coverageScenarioIds,
        coverageInventory: targetOverride?.coverageInventory,
        coverageMode: targetOverride?.coverageMode,
        dynamicBrowser: targetOverride?.dynamicBrowser,
        modelProfileId: input.defaultCredential?.id
      });
      input.setBrowserSession(null);
      input.setActiveRunId(created.run.id);
      input.setActiveRun(created.run);
      let runnable = created.run;
      if (runnable.state === "awaiting-plan-approval") runnable = (await approveRunPlan(runnable.id, runnable.version)).run;
      if (runnable.state === "awaiting-permission") runnable = (await grantRunPermissions(runnable.id, runnable.version)).run;
      input.setActiveRun(runnable);
      input.setPlanningAutomation({ phase: "running", detail: "AI 正在操作浏览器并采集截图、DOM、网络和 Trace。", scenarioId: selectedScenarioId });
      input.setMessage("计划已确认，AI 正在自动执行测试。");
      const report = await waitForRunReport(created.run.id);
      input.setResult(report);
      input.dispatchWorkspace({ type: "run-completed", requestId: workspaceRequestId, projectId: operationProjectId, report });
      input.setPlanningAutomation({ phase: "ready", detail: report.summary, scenarioId: selectedScenarioId });
      input.setMessage(report.summary);
      const finalStatus = report.finalStatus ?? report.gateStatus
        ?? (report.verdict === "continue" ? "pass" : report.verdict === "stop_and_fix" ? "fail" : "needs-human-review");
      input.setAutomationFailures([]);
      input.setPlanningMessages((current) => {
        const withoutSupersededFailure = current.filter((item) => !item.id.startsWith("automation_failure_analysis_") && !item.id.startsWith("progress:run:"));
        if (withoutSupersededFailure.some((item) => item.id === `run_outcome_${created.run.id}`)) return withoutSupersededFailure;
        return [...withoutSupersededFailure, {
          id: `run_outcome_${created.run.id}`,
          role: "assistant",
          content: finalStatus === "pass"
            ? `本次测试已经完成。机器结论：通过。${report.summary}`
            : `本次测试已经结束。机器结论：${finalStatus}。${report.summary}`,
          createdAt: new Date().toISOString(),
          reasoningSummary: {
            phase: "completed",
            observations: [`Run ${created.run.id} 已完成`],
            assessment: report.summary,
            nextStep: finalStatus === "pass" ? "可以查看本次证据和测试报告。" : "继续处理报告中仍未完成的路径。",
            userAction: "无需处理先前的临时阻塞提示。",
            confidence: "high"
          },
          requiresConfirmation: false
        }];
      });
      return { scenarioId: selectedScenarioId, success: finalStatus === "pass", finalStatus, detail: report.summary };
    } catch (error) {
      const detail = input.userFacingError(error instanceof Error ? error.message : "自动化测试启动失败");
      input.dispatchWorkspace({ type: "operation-failed", requestId: workspaceRequestId, projectId: operationProjectId, error: detail });
      if (!targetOverride?.batchMode) {
        input.setPlanningAutomation({ phase: "blocked", detail, scenarioId: selectedScenarioId });
        input.setMessage(detail);
      }
      return { scenarioId: selectedScenarioId, success: false, finalStatus: "blocked" as const, detail };
    } finally {
      input.setIsRunning(false);
    }
  }

  return { executeConfirmedScenarioAutomatically };
}
