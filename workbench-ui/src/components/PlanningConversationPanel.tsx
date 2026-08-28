import type { Ref } from "react";
import { GitBranch, Send } from "lucide-react";
import { BusinessFunctionList } from "./BusinessFunctionList";
import { FeatureTestProgress } from "./FeatureTestProgress";
import { KnowledgeBasis } from "./KnowledgeBasis";
import { PlanningFlowEditor } from "./PlanningFlowEditor";
import type { Credential, PlanningConversationResult, PlanningMessage, ProjectConfig, RunProjection, RunResult } from "../types";

export type PlanningAutomationPresentation = {
  phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked";
  detail: string;
  scenarioId?: string;
};

type ProjectApiCredentialRequirement = NonNullable<ProjectConfig["apiCredentialRequirements"]>[number];

interface PlanningConversationPanelProps {
  hasSelectedProject: boolean;
  planningResult: PlanningConversationResult | null;
  planningMessages: PlanningMessage[];
  planningBusy: boolean;
  planningConfirmed: boolean;
  planningAutomation: PlanningAutomationPresentation;
  planningAutomationBusy: boolean;
  planningHasBlockingQuestions: boolean;
  planningFunctionPageLoading: boolean;
  planningInput: string;
  currentFlowStep: number;
  isRunning: boolean;
  composerRef: Ref<HTMLTextAreaElement>;
  activeRun: RunProjection | null;
  result: RunResult | null;
  repairVerifiedScenarioIds: Set<string>;
  credentials: Credential[];
  defaultCredential?: Credential;
  missingProjectApiCredentials: ProjectApiCredentialRequirement[];
  apiCredentialFeedbackRequired: boolean;
  onQuickScan: () => void;
  onExcludeFlow: (flowId: string) => void;
  onEditFlowTitle: (flowId: string, title: string) => void;
  onAddFlow: (title: string) => void;
  onLoadFunctions: (result: PlanningConversationResult) => void;
  onConfirmPlan: () => void;
  onGrantBrowserPermission: () => void;
  onBindProjectCredentials: (credentialId: string, source: "test-system" | "dedicated") => void;
  onOpenCredentialSettings: () => void;
  onContinuePlanning: () => void;
  onModifyPlan: () => void;
  onOpenRepairWorkspace: (runId?: string) => void;
  onOpenTrajectory: () => void;
  onPlanningInputChange: (value: string) => void;
  onQuestionSelect: (question: string) => void;
  onSubmit: () => void;
}

/**
 * Planning-only presentation layer. It deliberately receives the durable run
 * projection as read-only data; mutations stay in App callbacks backed by the
 * API so this panel cannot become a second source of truth for a Graph run.
 */
export function PlanningConversationPanel({
  hasSelectedProject, planningResult, planningMessages, planningBusy, planningConfirmed,
  planningAutomation, planningAutomationBusy, planningHasBlockingQuestions,
  planningFunctionPageLoading, planningInput, currentFlowStep, isRunning, composerRef, activeRun, result,
  repairVerifiedScenarioIds, credentials, defaultCredential, missingProjectApiCredentials,
  apiCredentialFeedbackRequired, onQuickScan, onExcludeFlow, onEditFlowTitle, onAddFlow,
  onLoadFunctions, onConfirmPlan, onGrantBrowserPermission, onBindProjectCredentials,
  onOpenCredentialSettings, onContinuePlanning, onModifyPlan, onOpenRepairWorkspace,
  onOpenTrajectory,
  onPlanningInputChange, onQuestionSelect, onSubmit
}: PlanningConversationPanelProps) {
  return (
    <section className="planning-conversation" aria-label="测试规划对话">
      <header>
        <div>
          <h3>测试规划</h3>
          <p>用自然语言描述目标，系统先扫描项目，再由 AI 排定优先级、提出问题并生成可确认的测试计划。</p>
        </div>
        <div className="planning-header-actions">
          {planningResult && <span>{planningResult.llmPlanning?.status === "passed" ? "AI 辅助规划" : planningResult.coverage.scope === "comprehensive" ? "全面灰度" : "定向测试"}</span>}
          <button className="planning-trajectory-toggle" type="button" onClick={onOpenTrajectory} title="在右侧查看本次运行的统一轨迹"><GitBranch size={14} aria-hidden />轨迹</button>
          <button type="button" disabled={planningBusy || !hasSelectedProject} onClick={onQuickScan}>快速扫描（省 Token）</button>
        </div>
      </header>

      <div className="planning-messages" aria-live="polite">
        {planningMessages.map((item) => (
          <article className={`planning-message ${item.role}`} key={item.id}>
            <strong>{item.role === "assistant" ? "AI 测试官" : "你"}</strong>
            <p>{item.content}</p>
            <KnowledgeBasis message={item} />
          </article>
        ))}
        {planningBusy && <article className="planning-message assistant pending"><strong>AI 测试官</strong><p>正在扫描代码和整理业务流程…</p></article>}
      </div>

      {planningResult && (
        <section className="planning-draft">
          {planningResult.projectOverview ? (
            <section className="project-overview" aria-label="项目用途">
              <strong>项目用途</strong>
              <p>{planningResult.projectOverview.purpose}</p>
            </section>
          ) : null}
          <div className="planning-coverage business-function-overview">
            <article><strong>{planningResult.businessFunctionCount ?? planningResult.businessFunctions?.length ?? 0}</strong><span>识别到的业务功能</span></article>
            <article><strong>{planningResult.projectOverview?.statusCounts?.ready ?? planningResult.businessFunctions?.filter((feature) => feature.status === "ready").length ?? 0}</strong><span>可直接规划</span></article>
            <article><strong>{planningResult.projectOverview?.statusCounts?.["needs-confirmation"] ?? planningResult.businessFunctions?.filter((feature) => feature.status === "needs-confirmation").length ?? 0}</strong><span>需要补充条件</span></article>
            <article><strong>{((planningResult.projectOverview?.statusCounts?.blocked ?? 0) + (planningResult.projectOverview?.statusCounts?.unknown ?? 0)) || (planningResult.businessFunctions?.filter((feature) => feature.status === "blocked" || feature.status === "unknown").length ?? 0)}</strong><span>待确认</span></article>
          </div>
          {planningResult.businessFlows?.length && !planningConfirmed ? (
            <PlanningFlowEditor
              flows={planningResult.businessFlows}
              disabled={planningAutomationBusy}
              onExclude={onExcludeFlow}
              onEditTitle={onEditFlowTitle}
              onAdd={onAddFlow}
            />
          ) : null}
          {(activeRun || result) && planningResult.businessFlows?.some((flow) => flow.scenarioId) ? (
            <FeatureTestProgress
              flows={planningResult.businessFlows}
              conclusions={result?.conclusions ?? []}
              runActive={Boolean(activeRun?.state) && !["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(activeRun?.state ?? "")}
              repairVerifiedScenarioIds={repairVerifiedScenarioIds}
              onRepair={(runId) => onOpenRepairWorkspace(runId)}
            />
          ) : null}
          {planningResult.businessGraph ? (
            <details className="planning-technical-basis">
              <summary>查看处理依据</summary>
              <p>Agent 已建立业务功能与内部测试路径的映射。运行时会在沙盒中重新绑定页面、接口和验证条件。</p>
              <small>业务图版本 {planningResult.businessGraph.version} · 快照 {planningResult.businessFunctionSnapshotHash?.slice(0, 12) ?? planningResult.businessGraph.projectSnapshotHash.slice(0, 12)}</small>
              {planningResult.businessGraph.diagnostics.length ? <p>{planningResult.businessGraph.diagnostics.join("；")}</p> : null}
            </details>
          ) : null}
          {planningResult.llmPlanning?.status === "passed" && (
            <section className="llm-planning-advice" aria-label="AI 测试规划建议">
              <strong>AI 规划建议</strong>
              <p>{planningResult.llmPlanning.summary}</p>
              <small>{planningResult.llmPlanning.model} · {planningResult.llmPlanning.durationMs ? `${(planningResult.llmPlanning.durationMs / 1000).toFixed(1)} 秒` : "已完成"}</small>
            </section>
          )}
          {planningResult.llmPlanning?.status === "not_configured" && (
            <section className="llm-planning-advice muted" aria-label="AI 规划未配置">
              <strong>尚未启用 AI 规划</strong>
              <p>当前仅完成快速代码扫描。配置 API Key 后，自然语言规划会自动获得优先级建议和补充问题。</p>
            </section>
          )}
          {planningResult.clarificationQuestions.length > 0 && (
            <div className="planning-questions">
              <strong>{planningHasBlockingQuestions ? "执行前必须确认" : "可选补充（不影响确认）"}</strong>
              {planningResult.clarificationQuestions.map((question) => (
                <button type="button" key={question} onClick={() => onQuestionSelect(question)}>{question}</button>
              ))}
            </div>
          )}
          {planningResult.businessFunctions?.length ? (
            <BusinessFunctionList
              functions={planningResult.businessFunctions}
              total={planningResult.businessFunctionCount}
              nextCursor={planningResult.businessFunctionPage?.nextCursor}
              loading={planningFunctionPageLoading}
              onLoadMore={() => onLoadFunctions(planningResult)}
            />
          ) : (
            <section className="business-function-empty">
              <strong>业务功能正在整理</strong>
              <p>当前历史计划没有保存业务功能摘要；重新扫描后，Agent 会按功能展示，技术路径仅在处理依据中保留。</p>
            </section>
          )}
          <button
            className="confirm-planning-button"
            type="button"
            disabled={planningHasBlockingQuestions || planningConfirmed || planningAutomationBusy}
            onClick={onConfirmPlan}
          >
            {planningAutomationBusy
              ? "正在自动准备并执行"
              : planningConfirmed
                ? (isRunning ? "测试执行中" : "计划已确认 · 等待执行启动")
                : planningHasBlockingQuestions ? "回答问题后确认" : "确认并自动执行"}
          </button>
          {planningConfirmed && planningAutomation.phase !== "idle" && (
            <section className={`planning-next-step ${planningAutomation.phase === "blocked" || planningAutomation.phase === "needs-permission" ? "planning-next-step--blocked" : ""}`} aria-live="polite">
              <strong>
                {planningAutomation.phase === "preparing-project" ? "正在准备项目"
                  : planningAutomation.phase === "discovering" ? "正在理解真实页面"
                    : planningAutomation.phase === "binding" ? "正在生成可执行测试步骤"
                      : planningAutomation.phase === "starting-run" ? "正在启动自动化测试"
                        : planningAutomation.phase === "running" ? "AI 正在执行测试"
                          : planningAutomation.phase === "ready" ? "自动化测试已完成"
                            : planningAutomation.phase === "needs-permission" ? "需要一次浏览器授权"
                              : "自动化暂时无法继续"}
              </strong>
              <p>{planningAutomation.detail}</p>
              {planningAutomation.phase === "needs-permission" && (
                <button type="button" onClick={onGrantBrowserPermission}>允许本次浏览器操作并继续</button>
              )}
              {planningAutomation.phase === "blocked" && (
                apiCredentialFeedbackRequired ? (
                  <div className="planning-credential-actions">
                    <p>项目需要 {missingProjectApiCredentials.map((item) => item.envName).join("、")}。选择后会安全注入沙盒，并从当前步骤自动继续。</p>
                    {missingProjectApiCredentials.some((item) => item.exposure === "browser") && (
                      <small>该变量会进入浏览器代码，建议使用可撤销的测试 Key。</small>
                    )}
                    <button
                      type="button"
                      disabled={!defaultCredential?.id || planningAutomationBusy}
                      onClick={() => defaultCredential?.id && onBindProjectCredentials(defaultCredential.id, "test-system")}
                    >沿用当前测试模型凭据</button>
                    <select
                      aria-label="为被测项目选择其他 API Key"
                      defaultValue=""
                      disabled={planningAutomationBusy}
                      onChange={(event) => {
                        if (event.target.value) onBindProjectCredentials(event.target.value, "dedicated");
                      }}
                    >
                      <option value="">选择其他已保存凭据…</option>
                      {credentials.filter((item) => item.id !== defaultCredential?.id).map((credential) => (
                        <option key={credential.id} value={credential.id}>{credential.name} · {credential.model}</option>
                      ))}
                    </select>
                    <button type="button" onClick={onOpenCredentialSettings}>添加新的 API Key</button>
                  </div>
                ) : (
                  <div className="row-actions">
                    <button type="button" onClick={onContinuePlanning}>重新检查并继续</button>
                    <button type="button" onClick={onModifyPlan}>修改计划</button>
                  </div>
                )
              )}
            </section>
          )}
        </section>
      )}

      <form className={`planning-composer${currentFlowStep === 4 ? " is-flow-focus" : ""}`} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <textarea
          ref={composerRef}
          aria-label="描述测试目标"
          value={planningInput}
          onChange={(event) => onPlanningInputChange(event.target.value)}
          rows={3}
          placeholder="例如：全面灰度测试；重点检查登录、权限、数据刷新和报告生成。"
        />
        <button className="primary" type="submit" disabled={planningBusy || !planningInput.trim()}>
          <Send size={15} />
          {planningBusy ? "规划中" : "发送"}
        </button>
      </form>
    </section>
  );
}
