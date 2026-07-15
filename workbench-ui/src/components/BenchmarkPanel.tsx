import type { BenchmarkSummary } from "../types";

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function BenchmarkPanel({ summary }: { summary: BenchmarkSummary | null }) {
  return (
    <section className="benchmark-box">
      <div className="section-title-row">
        <div><h3>Benchmark</h3><p>跨目标项目验证目录与运行状态。</p></div>
        <span className="status-pill">{summary?.status ?? "loading"}</span>
      </div>
      <div className="benchmark-metrics">
        <article><span>需求用例</span><strong>{summary?.caseCount ?? "—"}</strong></article>
        <article><span>隔离盲测</span><strong>{summary?.blindCaseCount ?? "—"}</strong></article>
        <article><span>目标项目</span><strong>{summary?.projectCount ?? "—"}</strong></article>
        <article><span>类别</span><strong>{summary?.categories.length ?? "—"}</strong></article>
      </div>
      <div className="benchmark-projects">
        {Object.entries(summary?.byProject ?? {}).map(([projectId, count]) => <span key={projectId}>{projectId} · {count} cases</span>)}
      </div>
      <p className="empty">{summary?.runtimeMetrics.status === "completed"
        ? summary.runtimeMetrics.conclusion === "llm_gain_proven" ? "盲测已证明 LLM 增益。" : "盲测已完成，但尚未证明 LLM 增益。"
        : summary?.runtimeMetrics.status === "blocked" ? `实验被阻塞：${summary.runtimeMetrics.blockers.join("、")}` : `调度记录完成 ${summary?.runtimeMetrics.completedRuns ?? 0}/${summary?.runtimeMetrics.plannedRuns ?? 0}；这不代表测试成功。`}</p>
      {summary?.runtimeMetrics.acceptance && <p className={summary.runtimeMetrics.acceptance.proven ? "status-ok" : "status-warning"}>{summary.runtimeMetrics.acceptance.proven ? "发布阈值通过" : `未通过：${summary.runtimeMetrics.acceptance.reasons.join("、")}`}</p>}
      <div className="benchmark-projects">
        {Object.entries(summary?.runtimeMetrics.lanes ?? {}).map(([lane, metrics]) => (
          <article key={lane} aria-label={`实验通道 ${lane}`}>
            <strong>{lane}</strong>
            <span>调度完成 {percent(metrics.schedulingCompletionRate)}</span>
            <span>执行成功 {percent(metrics.executionSuccessRate)}</span>
            <span>需求覆盖 {percent(metrics.requirementCoverageRate)}</span>
            <span>门禁合格 {percent(metrics.gateEligibleRate)}</span>
            <span>模型推荐正确 {percent(metrics.recommendationAccuracy)}</span>
            <span>最终裁决正确 {percent(metrics.finalStatusAccuracy ?? metrics.finalDecisionAccuracy)}</span>
            <span>任务成功 {percent(metrics.taskSuccessRate)}</span>
            <span>Macro-F1 {metrics.macroF1 == null ? "—" : metrics.macroF1.toFixed(3)}</span>
            <span>误放行 {percent(metrics.falseReleaseRate)}</span>
            <span>误阻塞 {percent(metrics.falseBlockRate)}</span>
            <span>人工复核 {percent(metrics.humanReviewRate)}</span>
            <span>证据完整 {percent(metrics.artifactIntegrityRate)}</span>
            <span>平均 Token {metrics.averageTotalTokensPerRun == null ? "—" : Math.round(metrics.averageTotalTokensPerRun).toLocaleString()}</span>
          </article>
        ))}
      </div>
    </section>
  );
}
