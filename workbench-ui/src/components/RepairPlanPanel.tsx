import type { AssistantSuggestedAction, RepairPlanActionStatus, RepairPlanData } from "../types";

const OWNER_LABELS: Record<string, string> = {
  agent: "Agent（系统自动修复）",
  user: "你（需要操作）",
  environment: "环境（需要排查）",
  developer: "开发者（需要确认）"
};

// The step list is only addressed to the reader when the reader owns the fix.
// Labelling an agent-owned repair as "需要你" is exactly the confusion this
// panel exists to remove.
const STEP_LABELS: Record<string, string> = {
  agent: "系统将执行",
  user: "需要你",
  environment: "需要在环境上执行",
  developer: "需要开发者确认"
};

// A repair plan that cannot be executed is just a paragraph. Each action maps
// to a real workbench capability, so the label must promise exactly what will
// happen — never a generic "重试".
const ACTION_LABELS: Record<string, string> = {
  "configure-credentials": "配置测试账号",
  "retry-runtime": "重新启动沙盒并诊断",
  "retry-discovery": "重新扫描页面",
  "retry-failed-path": "重试失败链路",
  "create-repair": "打开沙盒修复并查看 Diff",
  "continue-safe-paths": "继续其他可执行测试",
  "open-evidence": "打开证据详情",
  "resume-interrupt": "查看待确认操作"
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  applied: "已执行",
  resolved: "已解决",
  dismissed: "已忽略"
};

export function RepairPlanPanel({
  data,
  onAction,
  onOpenEvidence,
  actionStatus
}: {
  data: RepairPlanData;
  /** Executes the plan's action. Omitted in read-only contexts (e.g. history). */
  onAction?: (action: Exclude<AssistantSuggestedAction, "none">, plan: RepairPlanData) => void;
  /** Opens a single evidence item the plan was derived from. */
  onOpenEvidence?: (evidenceId: string, plan: RepairPlanData) => void;
  actionStatus?: RepairPlanActionStatus;
}) {
  const ownerLabel = OWNER_LABELS[data.owner] ?? data.owner;
  const stepLabel = STEP_LABELS[data.owner] ?? "处理步骤";
  const action = data.action;
  const actionLabel = action ? ACTION_LABELS[action] ?? action : undefined;
  // Only show progress that belongs to THIS plan; a sibling plan's failure must
  // not appear under an unrelated repair.
  const status = actionStatus && (!actionStatus.planId || actionStatus.planId === data.planId)
    ? actionStatus
    : undefined;
  const running = status?.state === "running";
  const resolved = data.status === "resolved" || data.status === "applied";
  const evidenceRefs = data.evidenceRefs ?? [];
  return (
    <section className="repair-plan-panel" aria-label="修复方案">
      <header className="repair-plan-header">
        <strong>修复方案</strong>
        <span className={`repair-plan-owner repair-plan-owner-${data.owner}`}>{ownerLabel}</span>
        {data.status && STATUS_LABELS[data.status] ? (
          <span className={`repair-plan-status repair-plan-status-${data.status}`}>
            {STATUS_LABELS[data.status]}
          </span>
        ) : null}
      </header>
      {data.problem ? (
        <p className="repair-plan-problem">
          <span className="repair-plan-label">问题</span>
          {data.problem}
        </p>
      ) : null}
      {data.message ? (
        <p className="repair-plan-message">{data.message}</p>
      ) : null}
      {data.steps.length ? (
        <div className="repair-plan-steps">
          <span className="repair-plan-label">{stepLabel}</span>
          <ol>
            {data.steps.map((step, index) => (
              <li key={`${step}-${index}`}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {data.validation ? (
        <p className="repair-plan-validation">
          <span className="repair-plan-label">验证</span>
          {data.validation}
        </p>
      ) : null}
      {evidenceRefs.length && onOpenEvidence ? (
        <div className="repair-plan-evidence">
          <span className="repair-plan-label">依据证据</span>
          <ul>
            {evidenceRefs.slice(0, 6).map((evidenceId) => (
              <li key={evidenceId}>
                <button type="button" onClick={() => onOpenEvidence(evidenceId, data)}>
                  {evidenceId}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {action && onAction ? (
        <div className="repair-plan-actions">
          <button
            type="button"
            className="primary"
            disabled={running || resolved}
            onClick={() => onAction(action, data)}
          >
            {running ? "正在执行…" : resolved ? "已执行" : actionLabel}
          </button>
          {data.attemptId ? (
            <span className="repair-plan-binding">
              绑定 attempt {data.attemptId}
              {data.scenarioId ? ` · 场景 ${data.scenarioId}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
      {status?.message ? (
        <p
          className={`repair-plan-action-message ${status.state === "error" ? "repair-plan-action-error" : ""}`}
          role={status.state === "error" ? "alert" : undefined}
        >
          {status.message}
        </p>
      ) : null}
    </section>
  );
}
