import type { Ref } from "react";
import { Activity, Send } from "lucide-react";
import { AssistantConversationMessage } from "./AssistantConversationMessage";
import { BusinessFunctionList } from "./BusinessFunctionList";
import { DiscoveryOrchestrationNotice } from "./DiscoveryPanel";
import { InterruptDecisionPanel } from "./InterruptDecisionPanel";
import { RunAssistantPanel } from "./RunAssistantPanel";
import { WorkbenchSectionBoundary } from "./WorkbenchSectionBoundary";
import type {
  AgentGraphProjection,
  AssistantSuggestedAction,
  Credential,
  DiscoveryScanResult,
  PlanningConversationResult,
  PlanningMessage,
  RepairDecisionValue,
  RepairPlanActionStatus,
  RepairPlanData,
  RunHistoryEntry
} from "../types";

type AsyncAction = () => void | Promise<unknown>;

export interface AssistantPlanningSidebarProps {
  selectedProjectName: string;
  messages: PlanningMessage[];
  messagesViewportRef: Ref<HTMLDivElement>;
  onMessagesScroll: (element: HTMLDivElement) => void;
  planningBusy: boolean;
  assistantChatBusy: boolean;
  planningAutomationBusy: boolean;
  isRunning: boolean;
  projectRecoveryBusy: boolean;
  assistantFeedbackRequired: boolean;
  runAssistantMessage: string;
  runIsBlocked: boolean;
  screenshotRateLimited: boolean;
  authFeedbackRequired: boolean;
  credentialReadyForRetry: boolean;
  apiCredentialFeedbackRequired: boolean;
  missingProjectApiCredentials: Array<{ envName: string; exposure?: "browser" | "server" }>;
  credentials: Credential[];
  defaultCredential?: Credential;
  reviewRequired: boolean;
  reviewReason: string;
  assistantAutoRepairAvailable: boolean;
  runtimeRecoveryAvailable: boolean;
  discoveryRecoveryAvailable: boolean;
  pathBindingRepairable: boolean;
  startupRepairAvailable: boolean;
  planningResult: PlanningConversationResult | null;
  discoveryAllowsPlanning: boolean;
  planningFunctionPageLoading: boolean;
  planningHasBlockingQuestions: boolean;
  planningConfirmed: boolean;
  planningAutomationPhase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked";
  planningSummaryCollapsed: boolean;
  planningInput: string;
  discovery: DiscoveryScanResult | null;
  agentProjection: AgentGraphProjection | null;
  interruptBusy: boolean;
  interruptError?: string;
  pendingInterruptActionable: boolean;
  repairPlanActionStatus?: RepairPlanActionStatus;
  history: RunHistoryEntry[];
  onRepairPlanAction: (action: Exclude<AssistantSuggestedAction, "none">, plan: RepairPlanData) => void | Promise<void>;
  onOpenRepairEvidence: (evidenceId: string, plan: RepairPlanData) => void;
  onSubmitRunFeedback: (feedback: string) => void | Promise<void>;
  onConfigureCredentials: () => void;
  onRetryWithCredentials: () => void | Promise<void>;
  onBindApiCredential: (credentialId: string, source: "test-system" | "dedicated") => void | Promise<void>;
  onOpenApiSettings: () => void;
  onReviewReasonChange: (value: string) => void;
  onAcceptRisk: () => void | Promise<void>;
  onAutoRepair: AsyncAction;
  onEditPlan: () => void;
  onExecuteSuggestedAction: (action?: Exclude<AssistantSuggestedAction, "none">) => void | Promise<void>;
  onContinuePlanning: () => void | Promise<unknown>;
  onRouteAssistantContent: (content: string) => void | Promise<void>;
  assistantActionLabel: (action: Exclude<AssistantSuggestedAction, "none">) => string;
  latestPlanningAssistantId?: string;
  assistantQuickCommands: string[];
  onLoadPlanningFunctions: () => void;
  onConfirmPlanningDraft: () => void | Promise<void>;
  onPlanningSummaryCollapsedChange: (collapsed: boolean) => void;
  onPlanningInputChange: (value: string) => void;
  onRouteAssistantInput: () => void | Promise<void>;
  onInterruptDecision: (decision: RepairDecisionValue, note?: string) => void | Promise<void>;
  onOpenInterruptEvidence: (evidenceId: string) => void;
  onSaveInterruptCredentials: (username: string, password: string) => Promise<void>;
  onOpenInterruptCredentials: () => void;
  onOpenRepairWorkspace: AsyncAction;
  onOpenHistory: () => void;
}

/**
 * The persistent left rail is a presentation-only view of the planner and
 * durable run projection. It owns neither Graph state nor mutations: every
 * action is delegated to the API-backed callbacks supplied by App.
 */
export function AssistantPlanningSidebar(props: AssistantPlanningSidebarProps) {
  const autoRepairLabel = props.runtimeRecoveryAvailable
    ? "重新启动沙盒并诊断"
    : props.discoveryRecoveryAvailable ? "重新扫描页面并绑定路径"
      : props.pathBindingRepairable ? "重新绑定并验证路径"
        : props.startupRepairAvailable ? "在沙盒中分析启动问题" : "生成沙盒代码修复";
  const autoRepairDescription = props.runtimeRecoveryAvailable
    ? "系统会自动启动 Docker Desktop（如需要）、重新启动沙盒、检查健康状态并重新扫描页面；不会修改项目源码。"
    : props.discoveryRecoveryAvailable
      ? "页面已经连通；系统只会重新扫描页面、控件和网络并重新绑定路径，不会修改项目源码或覆盖已有证据。"
      : props.pathBindingRepairable
        ? "根据已探测页面重新绑定入口、控件和验证条件，然后立即复验。不会修改项目源码。"
        : props.startupRepairAvailable
          ? "读取已保存的启动状态和日志，只修改沙盒中的启动/构建配置；原项目只读，联网安装需单独确认。"
          : "读取失败断言和证据，在沙盒副本中生成最小补丁，并展示 Diff 与验证结果。";

  return (
    <aside className="simple-sidebar">
      <section className="sidebar-planning-assistant" aria-label="AI 测试助手规划">
        <header>
          <div>
            <span className="section-kicker">AI 测试助手</span>
            <h3>规划测试</h3>
          </div>
        </header>
        <span className="sidebar-current-project">当前项目：{props.selectedProjectName}</span>
        <div
          ref={props.messagesViewportRef}
          className="sidebar-planning-messages"
          aria-live="polite"
          onScroll={(event) => props.onMessagesScroll(event.currentTarget)}
        >
          {props.messages.map((item, index) => {
            const attachesRunActions = props.assistantFeedbackRequired
              && item.role === "assistant"
              && item.content === props.runAssistantMessage
              && !props.messages.slice(index + 1).some((candidate) => candidate.content === props.runAssistantMessage);
            const attachedSuggestedAction = item.suggestedAction && item.suggestedAction !== "none"
              ? item.suggestedAction
              : undefined;
            const isLatestAssistant = item.id === props.latestPlanningAssistantId;
            return (
              <WorkbenchSectionBoundary label="这条助手消息" key={item.id}>
                <AssistantConversationMessage
                  message={item}
                  onRepairPlanAction={isLatestAssistant ? props.onRepairPlanAction : undefined}
                  onOpenRepairEvidence={props.onOpenRepairEvidence}
                  repairPlanActionStatus={props.repairPlanActionStatus}
                  actions={attachesRunActions ? (
                    <RunAssistantPanel
                      message={props.runAssistantMessage}
                      blocked={props.runIsBlocked || props.screenshotRateLimited}
                      authRequired={props.authFeedbackRequired}
                      credentialReady={props.credentialReadyForRetry}
                      apiCredentialRequired={props.apiCredentialFeedbackRequired}
                      apiCredentialEnvNames={props.missingProjectApiCredentials.map((candidate) => candidate.envName)}
                      browserExposedApiCredential={props.missingProjectApiCredentials.some((candidate) => candidate.exposure === "browser")}
                      credentials={props.credentials}
                      defaultCredentialId={props.defaultCredential?.id}
                      busy={props.planningBusy || props.isRunning || props.planningAutomationBusy || props.assistantChatBusy || props.projectRecoveryBusy}
                      onSubmit={props.onSubmitRunFeedback}
                      onConfigureCredentials={props.onConfigureCredentials}
                      onRetryWithCredentials={props.onRetryWithCredentials}
                      onBindApiCredential={props.onBindApiCredential}
                      onOpenApiSettings={props.onOpenApiSettings}
                      reviewRequired={props.reviewRequired}
                      reviewReason={props.reviewReason}
                      onReviewReasonChange={props.onReviewReasonChange}
                      onAcceptRisk={props.onAcceptRisk}
                      autoRepairAvailable={props.assistantAutoRepairAvailable}
                      autoRepairLabel={autoRepairLabel}
                      autoRepairDescription={autoRepairDescription}
                      onAutoRepair={() => { void props.onAutoRepair(); }}
                      onEditPlan={props.onEditPlan}
                      conversationVisible={false}
                    />
                  ) : attachedSuggestedAction === "start-run" ? (
                    <div className="assistant-command-preview assistant-plan-command">
                      {props.planningResult && props.discoveryAllowsPlanning ? (
                        <>
                          <strong>本次准备测试 {props.planningResult.businessFunctionCount ?? props.planningResult.businessFunctions?.length ?? 0} 个业务功能</strong>
                          <div className="assistant-plan-summary">
                            <span>Agent 会在内部编排页面、接口和数据测试路径</span>
                            {(props.planningResult.businessFunctions?.filter((feature) => feature.status !== "ready").length ?? 0) > 0
                              ? <span>{props.planningResult.businessFunctions?.filter((feature) => feature.status !== "ready").length} 个功能需补充条件</span>
                              : null}
                          </div>
                          {props.planningResult.businessFunctions?.length ? <span className="assistant-plan-list-hint">完整功能清单已在下方显示，可随时展开查看。</span> : null}
                          <button className="assistant-suggested-action" type="button" disabled={props.assistantChatBusy || props.isRunning || props.planningHasBlockingQuestions} onClick={() => void props.onExecuteSuggestedAction(attachedSuggestedAction)}>
                            {props.planningHasBlockingQuestions ? "请先补充必要信息" : "确认并开始测试"}
                          </button>
                        </>
                      ) : (
                        <>
                          <strong>测试清单尚未生成</strong>
                          <span>系统会先扫描项目并列出页面、功能和接口，再允许确认执行。</span>
                          <button className="assistant-suggested-action" type="button" disabled={props.assistantChatBusy || props.planningBusy} onClick={() => void props.onContinuePlanning()}>
                            按当前目标生成清单
                          </button>
                        </>
                      )}
                    </div>
                  ) : attachedSuggestedAction ? (
                    <div className="assistant-command-preview">
                      <span>{item.requiresConfirmation === false ? "可立即执行" : "确认后执行"}</span>
                      <button className="assistant-suggested-action" type="button" disabled={props.assistantChatBusy} onClick={() => void props.onExecuteSuggestedAction(attachedSuggestedAction)}>
                        {props.assistantActionLabel(attachedSuggestedAction)}
                      </button>
                    </div>
                  ) : isLatestAssistant && !props.assistantChatBusy ? (
                    <div className="assistant-quick-commands" aria-label="可以继续这样问">
                      {props.assistantQuickCommands.slice(0, 3).map((command) => (
                        <button key={command} type="button" onClick={() => void props.onRouteAssistantContent(command)}>{command}</button>
                      ))}
                    </div>
                  ) : undefined}
                />
              </WorkbenchSectionBoundary>
            );
          })}
          {props.planningBusy ? <AssistantConversationMessage message={{ id: "planning_pending", role: "assistant", content: "正在分析项目和可执行路径…", createdAt: new Date().toISOString(), streaming: true }} /> : null}
          {props.pendingInterruptActionable && props.agentProjection?.pendingInterrupt ? (
            <InterruptDecisionPanel
              interrupt={props.agentProjection.pendingInterrupt}
              busy={props.interruptBusy}
              error={props.interruptError}
              onDecide={props.onInterruptDecision}
              onOpenEvidence={props.onOpenInterruptEvidence}
              onSaveCredentials={props.onSaveInterruptCredentials}
              onOpenCredentials={props.onOpenInterruptCredentials}
              onRecoverSandbox={() => void props.onExecuteSuggestedAction("retry-runtime")}
              onReopenDiscovery={() => void props.onExecuteSuggestedAction("retry-discovery")}
              onOpenRepairWorkspace={props.onOpenRepairWorkspace}
            />
          ) : null}
        </div>
        {props.discovery?.orchestration && props.discovery.orchestration.status !== "ready" ? <DiscoveryOrchestrationNotice discovery={props.discovery} /> : null}
        {props.planningResult && props.discoveryAllowsPlanning ? (
          <div className={`sidebar-planning-result ${props.planningSummaryCollapsed ? "collapsed" : ""}`}>
            <button className="sidebar-planning-result-toggle" type="button" aria-expanded={!props.planningSummaryCollapsed} onClick={() => props.onPlanningSummaryCollapsedChange(!props.planningSummaryCollapsed)}>
              <span><strong>{props.planningResult.businessFunctionCount ?? props.planningResult.businessFunctions?.length ?? 0} 个业务功能</strong><small>Agent 会在内部维护测试路径</small></span>
              <span>{props.planningSummaryCollapsed ? "展开" : "收起"}</span>
            </button>
            {!props.planningSummaryCollapsed ? (
              <>
                {props.planningResult.businessFunctions?.length ? <BusinessFunctionList functions={props.planningResult.businessFunctions} total={props.planningResult.businessFunctionCount} nextCursor={props.planningResult.businessFunctionPage?.nextCursor} loading={props.planningFunctionPageLoading} onLoadMore={props.onLoadPlanningFunctions} compact /> : <p className="business-function-empty">业务功能摘要尚未生成，请重新扫描。</p>}
                <button className="primary execute-plan-button" type="button" disabled={props.planningHasBlockingQuestions || props.planningAutomationBusy || props.isRunning} onClick={() => void props.onConfirmPlanningDraft()}>
                  {props.planningAutomationBusy || props.isRunning ? "自动测试进行中" : props.planningHasBlockingQuestions ? "请先补充信息" : props.planningConfirmed && props.planningAutomationPhase === "blocked" ? "继续自动测试" : props.planningConfirmed ? "重新执行计划" : "确认并执行"}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        <form className="sidebar-planning-composer" onSubmit={(event) => { event.preventDefault(); if (props.planningInput.trim()) void props.onRouteAssistantInput(); }}>
          <textarea aria-label="向 AI 测试助手提问或描述测试目标" value={props.planningInput} onChange={(event) => props.onPlanningInputChange(event.target.value)} rows={3} placeholder="可问“现在测试到哪了？”；输入“全面扫描”可生成测试清单。" />
          <button className="primary composer-send-button" type="submit" disabled={props.planningBusy || props.assistantChatBusy || !props.planningInput.trim()} aria-label={props.planningBusy || props.assistantChatBusy ? "AI 正在回复" : "发送给 AI 测试助手"} title={props.planningBusy || props.assistantChatBusy ? "AI 正在回复" : "发送"}>
            {props.assistantChatBusy ? <Activity size={14} /> : <Send size={14} />}
          </button>
        </form>
      </section>
      <div className="sidebar-footer"><span>{props.history.length} 次历史运行</span><button onClick={props.onOpenHistory} type="button">打开记录</button></div>
    </aside>
  );
}
