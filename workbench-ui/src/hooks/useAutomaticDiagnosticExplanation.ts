import { useEffect, type Dispatch, type SetStateAction } from "react";
import { chatWithTestAssistant, sendRunAgentMessage } from "../api";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";
import { upsertAssistantProgress } from "../workbenchLogic";
import type {
  AssistantSuggestedAction,
  Credential,
  DiscoveryScanResult,
  LiveRunState,
  PlanningConversationResult,
  PlanningMessage,
  ProjectConfig,
  RunResult
} from "../types";
import type { AutomationFailure } from "./useConfirmedScenarioExecution";

interface AutomaticDiagnosticExplanationInput {
  activeRunId: string | null;
  result: RunResult | null;
  runIsBlocked: boolean;
  reviewRequired: boolean;
  pathBindingRepairable: boolean;
  defaultCredential?: Credential;
  selectedProjectId: string;
  projectDraft: ProjectConfig | null;
  planningAutomation: PlanningAutomationPresentation;
  latestDecision: string;
  assistantChatBusy: boolean;
  planningMessages: PlanningMessage[];
  planningResult: PlanningConversationResult | null;
  planningConfirmed: boolean;
  automationFailures: AutomationFailure[];
  discovery: DiscoveryScanResult | null;
  liveRun: LiveRunState | null;
  concreteRunFailureMessage?: string;
  analyzedBlockedRuns: { current: Set<string> };
  boundedAssistantText: (value: unknown, limit: number) => string;
  userFacingAssistantError: (error: unknown) => string;
  actionLabel: (action: Exclude<AssistantSuggestedAction, "none">) => string;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setAssistantChatBusy: Dispatch<SetStateAction<boolean>>;
  setAssistantSuggestedAction: Dispatch<SetStateAction<{ action: Exclude<AssistantSuggestedAction, "none">; label: string } | null>>;
}

/** Adds one evidence-grounded assistant explanation per durable blocked conclusion. */
export function useAutomaticDiagnosticExplanation(input: AutomaticDiagnosticExplanationInput) {
  useEffect(() => {
    const needsExplanation = input.runIsBlocked || input.reviewRequired || input.pathBindingRepairable;
    const analysisId = input.activeRunId ?? input.result?.id ?? input.planningResult?.id;
    const projectId = input.selectedProjectId || input.projectDraft?.id;
    if (!needsExplanation || !analysisId || !input.defaultCredential?.id || !projectId || input.assistantChatBusy) return;
    const analysisKey = [analysisId, input.latestDecision, input.planningAutomation.phase].join(":");
    if (input.analyzedBlockedRuns.current.has(analysisKey)) return;
    input.analyzedBlockedRuns.current.add(analysisKey);
    const messageId = `progress:diagnosis:${analysisId}`;
    input.setPlanningMessages((current) => upsertAssistantProgress(current, {
      id: messageId,
      role: "assistant",
      content: "正在读取机器结论、失败证据和已有修复记录，整理这次问题与下一步操作…",
      createdAt: new Date().toISOString(),
      streaming: true
    }, `diagnosis:${analysisId}`));
    input.setAssistantChatBusy(true);
    const diagnosisPrompt = "请解释当前运行卡点：发生了什么、系统准备如何处理、我是否需要操作。只依据已保存的运行事实和证据回答。";
    const replaceMessage = (response: Awaited<ReturnType<typeof chatWithTestAssistant>> | Awaited<ReturnType<typeof sendRunAgentMessage>>) => {
      input.setPlanningMessages((current) => current.map((item) => item.id === messageId ? {
        ...item,
        content: response.assistant.reply,
        streaming: false,
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
          totalTokens: response.call.usage?.totalTokens,
          semanticRepairApplied: response.call.semanticRepairApplied,
          status: response.call.status,
          fallbackApplied: response.call.fallbackApplied,
          errorCode: response.call.errorCode,
          contextId: response.call.knowledgeContextId,
          decisionId: response.call.knowledgeDecisionId,
          validationStatus: response.call.knowledgeValidationStatus
        }
      } : item));
      if (response.assistant.suggestedAction !== "none") {
        input.setAssistantSuggestedAction({
          action: response.assistant.suggestedAction,
          label: input.actionLabel(response.assistant.suggestedAction)
        });
      }
    };
    void (async () => {
      if (input.activeRunId && input.result && !input.pathBindingRepairable) {
        const response = await sendRunAgentMessage(input.activeRunId, {
          message: diagnosisPrompt,
          credentialId: input.defaultCredential!.id,
          origin: "system-diagnosis"
        });
        replaceMessage(response);
        return;
      }
      const response = await chatWithTestAssistant({
        projectId,
        message: diagnosisPrompt,
        credentialId: input.defaultCredential!.id,
        history: input.planningMessages.slice(-6).map((item) => ({
          role: item.role,
          content: input.boundedAssistantText(item.content, 1_500)
        })),
        context: {
          runState: input.planningAutomation.phase,
          finalStatus: input.result?.finalStatus ?? input.result?.gateStatus ?? input.latestDecision,
          summary: input.boundedAssistantText(input.result?.summary ?? input.planningAutomation.detail, 1_200),
          evidenceCount: input.liveRun?.evidenceCount ?? input.result?.evidence.length ?? 0,
          currentStep: input.boundedAssistantText(input.result?.executionError?.stepId ?? input.planningAutomation.phase, 300),
          latestLog: input.boundedAssistantText(input.result?.executionError?.message ?? input.planningAutomation.detail, 700),
          pageObservation: input.discovery?.observation,
          failedAssertions: (input.result?.assertions ?? []).filter((item) => !item.passed).slice(0, 8).map((item) => ({
            name: input.boundedAssistantText(item.name, 240),
            expected: input.boundedAssistantText(item.expected, 500),
            actual: input.boundedAssistantText(item.actual, 500)
          })),
          planning: input.planningResult ? {
            discovered: input.planningResult.coverage.discovered,
            executable: input.planningResult.coverage.executable,
            autoBindable: input.planningResult.coverage.autoBindable,
            confirmed: input.planningConfirmed,
            failures: input.automationFailures.map((failure) => ({
              title: failure.title,
              target: failure.target ?? failure.scenarioId,
              stage: failure.stage,
              detail: input.boundedAssistantText(failure.detail, 1_000),
              requiredInformation: failure.requiredInformation?.slice(0, 8) ?? []
            })),
            blockingQuestions: input.planningResult.clarificationQuestions.slice(0, 8)
          } : undefined
        }
      });
      replaceMessage(response);
    })().catch((error) => {
      input.analyzedBlockedRuns.current.delete(analysisKey);
      const reason = error instanceof Error ? error.message : "模型调用失败";
      input.setPlanningMessages((current) => current.map((item) => item.id === messageId ? {
        ...item,
        content: input.userFacingAssistantError(error),
        streaming: false,
        reasoningSummary: {
          phase: "waiting-user",
          observations: [input.concreteRunFailureMessage || "失败事实和证据已经保存", "模型解释请求未成功，技术原因已记录"],
          assessment: "模型服务未返回有效解释；系统仍以确定性断言、证据完整性和机器门禁作为当前事实。",
          nextStep: "其他独立路径继续执行；失败链路保持待诊断状态，不会被自动放行。",
          userAction: /401|403|credential|api key/i.test(reason) ? "请检查当前模型凭据后，在对话框中要求重新分析。" : "你可以直接追问、打开证据或稍后重试 AI 分析。",
          confidence: "high"
        }
      } : item));
    }).finally(() => input.setAssistantChatBusy(false));
  }, [
    input.activeRunId, input.result?.id, input.runIsBlocked, input.reviewRequired,
    input.pathBindingRepairable, input.defaultCredential?.id, input.selectedProjectId,
    input.projectDraft?.id, input.planningAutomation.phase, input.planningAutomation.detail,
    input.latestDecision, input.assistantChatBusy
  ]);
}
