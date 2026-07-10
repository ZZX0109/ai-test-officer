import type { PatrolJob, PatrolTrend } from "../types";
import { AuthenticatedArtifactLink } from "./AuthenticatedArtifact";

interface PatrolPanelProps {
  patrolJobs: PatrolJob[];
  patrolPlans?: PatrolJob[];
  trend?: PatrolTrend | null;
  onRunPlan?: (id: string) => void;
  onDeletePlan?: (id: string) => void;
}

export function PatrolPanel({ patrolJobs, patrolPlans = [], trend, onRunPlan, onDeletePlan }: PatrolPanelProps) {
  const visiblePlans = patrolPlans.length ? patrolPlans : patrolJobs;
  return (
    <section className="patrol-jobs">
      <h3>巡检调度</h3>
      {trend ? (
        <article className={trend.riskIncreased ? "warning" : "running"}>
          <header>
            <strong>风险趋势</strong>
            <span>{trend.riskTrend}</span>
          </header>
          <p>{trend.summary}</p>
          <p>total={trend.totalRuns} · failed={trend.failedRuns} · latest={trend.latestVerdict ?? "none"}</p>
        </article>
      ) : null}
      {visiblePlans.map((job) => (
        <article key={job.id} className={job.status}>
          <header>
            <strong>{job.title}</strong>
            <span>{job.status}</span>
          </header>
          <p>{job.appUrl ?? job.target?.frontendUrl ?? job.projectId} · {job.scenarioId} · {job.cron ?? `${Math.round(job.intervalMs / 1000)}s`}</p>
          <p>Permission: observe={String(job.permissionProfile?.observe)} · browser_control={String(job.permissionProfile?.browserControl)}</p>
          {job.retryPolicy && <p>Retry: {job.retryPolicy.maxRetries} 次 · backoff {job.retryPolicy.backoffMs}ms</p>}
          {job.escalationPolicy && <p>Escalation: fail ≥ {job.escalationPolicy.failureThreshold} · notify {job.escalationPolicy.notify.join(", ")}</p>}
          {job.consecutiveFailures ? <p>连续失败：{job.consecutiveFailures}</p> : null}
          {job.nextRunAt && <p>Next: {new Date(job.nextRunAt).toLocaleString()}</p>}
          {job.lastRunId && <p>Last run: {job.lastRunId}</p>}
          {job.lastPatrolFile && (
            <AuthenticatedArtifactLink artifactUrl={job.lastPatrolFile}>
              打开最近巡检记录
            </AuthenticatedArtifactLink>
          )}
          {job.lastError && <p>Error: {job.lastError}</p>}
          <div className="row-actions">
            {onRunPlan && <button type="button" onClick={() => onRunPlan(job.id)}>立即执行</button>}
            {onDeletePlan && <button type="button" onClick={() => onDeletePlan(job.id)}>删除计划</button>}
          </div>
        </article>
      ))}
      {visiblePlans.length === 0 && <p className="empty">暂无巡检计划。</p>}
    </section>
  );
}
