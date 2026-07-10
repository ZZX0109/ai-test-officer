import type { RunHistoryEntry } from "../types";

interface HistoryPanelProps {
  runs: RunHistoryEntry[];
  activeRunId?: string;
  onOpenRun?: (runId: string) => void;
}

export function HistoryPanel({ runs, activeRunId, onOpenRun }: HistoryPanelProps) {
  return (
    <section className="history-box">
      <h3>历史运行</h3>
      {runs.length ? (
        <div className="source-list">
          {runs.slice().reverse().slice(0, 8).map((run) => (
            <article
              key={run.runId}
              className={`${run.failedAssertionCount ? "failed" : "passed"} ${run.runId === activeRunId ? "active-run" : ""}`}
            >
              <header>
                <strong>{run.runId}</strong>
                <span>{run.runId === activeRunId ? "viewing" : run.verdict}</span>
              </header>
              <span>{run.verdict} · failed={run.failedAssertionCount}</span>
              <p>{new Date(run.timestamp).toLocaleString()} · {run.scenarioId ?? "unknown scenario"}</p>
              {run.comparison && (
                <p>
                  trend={run.comparison.riskTrend} · delta={run.comparison.failureDelta >= 0 ? "+" : ""}{run.comparison.failureDelta}
                  {run.comparison.previousRunId ? ` · previous=${run.comparison.previousRunId}` : ""}
                  {run.comparison.judgeDecisionChanged ? " · verdict changed" : ""}
                </p>
              )}
              <p>{run.appUrl}</p>
              {onOpenRun && (
                <button type="button" onClick={() => onOpenRun(run.runId)}>
                  打开证据
                </button>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">还没有历史运行。</p>
      )}
    </section>
  );
}
