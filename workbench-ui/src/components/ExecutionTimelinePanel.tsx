import { ListChecks, Pencil, X } from "lucide-react";
import { FeatureTestReport } from "./FeatureTestReport";
import { FeatureTestProgress } from "./FeatureTestProgress";
import { ReviewCasePanel } from "./ReviewCasePanel";
import { RunTimeline } from "./RunTimeline";
import type { AgentGraphProjection, PlanningConversationResult, ReviewCase, RunResult } from "../types";
import type { WorkspaceState } from "../state/workspaceReducer";

type RunViewMode = "dialogue" | "report";

interface ExecutionTimelinePanelProps {
  workspaceState: WorkspaceState;
  canGenerate: boolean;
  activeRunId: string | null;
  latestDecision: string;
  repairBusy: boolean;
  agentProjection: AgentGraphProjection | null;
  reviewCase: ReviewCase | null;
  runViewMode: RunViewMode;
  result: RunResult | null;
  planningResult: PlanningConversationResult | null;
  displayedLoopEvents: RunResult["loopEvents"] | undefined;
  onGenerateOrCancel: () => void;
  onOpenRepairWorkspace: () => void;
  onOpenTrajectory: () => void;
  onRunViewModeChange: (mode: RunViewMode) => void;
}

/** Run records, trace and final report switcher. It reads the authoritative run projection only. */
export function ExecutionTimelinePanel({
  workspaceState, canGenerate, activeRunId, latestDecision, repairBusy, agentProjection,
  reviewCase, runViewMode, result, planningResult, displayedLoopEvents,
  onGenerateOrCancel, onOpenRepairWorkspace, onOpenTrajectory, onRunViewModeChange
}: ExecutionTimelinePanelProps) {
  const generationActive = workspaceState.phase === "generating";
  const allFlows = planningResult?.businessFlows ?? [];
  const flowsById = new Map(allFlows.map((flow) => [flow.id, flow]));
  const functionFlows = (planningResult?.businessFunctions ?? []).flatMap((feature) => feature.pathIds.flatMap((pathId) => {
    const flow = flowsById.get(pathId);
    return flow ? [{ ...flow, title: feature.pathIds.length === 1 ? feature.name : `${feature.name} · ${flow.title}` }] : [];
  }));
  const presentationFlows = functionFlows.length
    ? [...new Map(functionFlows.map((flow) => [flow.id, flow])).values()]
    : allFlows;
  const runActive = Boolean(activeRunId && !result) || agentProjection?.status === "running";
  return <section className="timeline-stage">
    <div className="section-title-row">
      <div>
        <span className="section-kicker">执行记录</span>
        <h3>Agent 正在做什么</h3>
        <p>按时间顺序查看操作、结果和已保存的证据。</p>
      </div>
      <button className="timeline-plan-button" disabled={!canGenerate && !generationActive} onClick={onGenerateOrCancel} type="button">
        {generationActive ? <X size={15} /> : <ListChecks size={15} />}
        {generationActive ? "取消生成" : workspaceState.phase === "failed" ? "重试生成计划" : "重新生成计划"}
      </button>
      {activeRunId && ["fail", "blocked", "needs-human-review"].includes(String(latestDecision)) ? (
        <button className="timeline-plan-button" disabled={repairBusy} onClick={onOpenRepairWorkspace} type="button"><Pencil size={15} />{repairBusy ? "正在准备修复" : "分析并修复"}</button>
      ) : null}
    </div>
    {workspaceState.generation ? <p className="muted">
      计划来源：{workspaceState.generation.source}
      {workspaceState.generation.model ? ` · 模型：${workspaceState.generation.model}` : ""}
      {` · ${workspaceState.generation.validationStatus === "validated" ? "已校验" : "待校验"}`}
      {` · ${new Date(workspaceState.generation.generatedAt).toLocaleTimeString()}`}
    </p> : null}
    {workspaceState.error ? <p className="error-text" role="alert">{workspaceState.error}</p> : null}
    {agentProjection && activeRunId ? <div className="agent-live-status" aria-live="polite">
      <span className={`agent-live-status__dot agent-live-status__dot--${agentProjection.status}`} />
      <strong>{agentProjection.currentNode ?? "准备中"}</strong>
      <span>{agentProjection.status === "interrupted" ? "等待你的确认" : agentProjection.status === "running" ? "正在执行" : agentProjection.status === "failed" ? "执行失败" : "已完成"}</span>
      <span>{Math.round((agentProjection.progress ?? 0) * 100)}%</span>
      {agentProjection.recoveryDecision ? <span>恢复：{agentProjection.recoveryDecision.action}</span> : null}
      {agentProjection.recoveryResult?.userMessage ? <span>{agentProjection.recoveryResult.userMessage}</span> : null}
    </div> : null}
    {activeRunId && presentationFlows.length ? <FeatureTestProgress
      flows={presentationFlows}
      conclusions={result?.conclusions ?? []}
      coverageItems={result?.coverageItems ?? []}
      runActive={runActive}
      onRepair={() => onOpenRepairWorkspace()}
    /> : null}
    <ReviewCasePanel reviewCase={reviewCase} />
    <div className="run-view-toggle" role="tablist" aria-label="运行视图模式">
      {(["dialogue", "report"] as const).map((mode) => (
        <button key={mode} type="button" role="tab" aria-selected={runViewMode === mode} className={`run-view-toggle__btn${runViewMode === mode ? " is-active" : ""}`} onClick={() => onRunViewModeChange(mode)}>
          {mode === "dialogue" ? "对话" : "报告"}
        </button>
      ))}
    </div>
    {runViewMode === "dialogue" ? <RunTimeline result={result} displayedLoopEvents={displayedLoopEvents} />
      : <FeatureTestReport flows={presentationFlows} conclusions={result?.conclusions ?? []} coverageItems={result?.coverageItems ?? []} onViewTrajectory={onOpenTrajectory} />}
  </section>;
}
