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
        <article><span>目标项目</span><strong>{summary?.projectCount ?? "—"}</strong></article>
        <article><span>类别</span><strong>{summary?.categories.length ?? "—"}</strong></article>
      </div>
      <div className="benchmark-projects">
        {Object.entries(summary?.byProject ?? {}).map(([projectId, count]) => <span key={projectId}>{projectId} · {count} cases</span>)}
      </div>
      <p className="empty">{summary?.runtimeMetrics.status === "awaiting_agent_runs" ? "目录已就绪；完整 Agent 运行指标将在每条 case 产生 runId 后显示。" : "运行指标已加载。"}</p>
    </section>
  );
}
