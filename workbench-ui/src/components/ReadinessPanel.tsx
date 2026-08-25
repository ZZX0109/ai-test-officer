import { CheckCircle2, CircleAlert, Play, RefreshCw } from "lucide-react";
import type { ReadinessReport } from "../types";

interface ReadinessPanelProps {
  report: ReadinessReport | null;
  loading?: boolean;
  bootstrapping?: boolean;
  onRefresh: () => void;
  onBootstrap: () => void;
}

export function ReadinessPanel({ report, loading = false, bootstrapping = false, onRefresh, onBootstrap }: ReadinessPanelProps) {
  if (loading && !report) return <div className="readiness-panel" role="status">正在检查运行环境…</div>;
  if (!report) return null;
  const blockers = report.checks.filter((item) => item.status !== "ready");
  return (
    <section className={`readiness-panel readiness-panel--${report.status}`} aria-label="统一环境准备">
      <div className="readiness-panel__header">
        <div>
          <strong>{report.status === "ready" ? "环境已就绪" : report.status === "repairable" ? "环境可以自动修复" : "环境存在阻断项"}</strong>
          <span>{report.checks.length} 项检查 · {new Date(report.generatedAt).toLocaleTimeString()}</span>
        </div>
        <div className="readiness-panel__actions">
          <button type="button" onClick={onRefresh} disabled={loading} title="刷新检查"><RefreshCw size={15} /></button>
          {report.status !== "ready" && <button type="button" onClick={onBootstrap} disabled={bootstrapping}><Play size={15} />{bootstrapping ? "准备中" : "一键准备"}</button>}
        </div>
      </div>
      <ul className="readiness-panel__checks">
        {report.checks.map((item) => (
          <li key={item.id} className={`readiness-check readiness-check--${item.status}`}>
            {item.status === "ready" ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            <div><strong>{item.message}</strong>{item.remediation && <span>{item.remediation}</span>}</div>
          </li>
        ))}
      </ul>
      {blockers.length > 0 && <p className="readiness-panel__hint">完成自动准备后，系统会继续追踪项目沙盒和页面健康状态。</p>}
    </section>
  );
}
