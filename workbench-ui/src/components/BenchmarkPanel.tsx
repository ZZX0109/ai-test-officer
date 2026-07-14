import type { BenchmarkSummary } from "../types";

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
        : summary?.runtimeMetrics.status === "blocked" ? `实验被阻塞：${summary.runtimeMetrics.blockers.join("、")}` : `真实运行进度 ${summary?.runtimeMetrics.completedRuns ?? 0}/${summary?.runtimeMetrics.plannedRuns ?? 0}`}</p>
      {summary?.runtimeMetrics.acceptance && <p className={summary.runtimeMetrics.acceptance.proven ? "status-ok" : "status-warning"}>{summary.runtimeMetrics.acceptance.proven ? "发布阈值通过" : `未通过：${summary.runtimeMetrics.acceptance.reasons.join("、")}`}</p>}
      <div className="benchmark-projects">
        {Object.entries(summary?.runtimeMetrics.lanes ?? {}).map(([lane, metrics]) => <span key={lane}>{lane} · F1 {metrics.macroF1 == null ? "—" : metrics.macroF1.toFixed(2)} · 复核 {metrics.humanReviewRate == null ? "—" : `${(metrics.humanReviewRate * 100).toFixed(0)}%`}</span>)}
      </div>
    </section>
  );
}
