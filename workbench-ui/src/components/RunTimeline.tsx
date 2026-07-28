import { Activity, CheckCircle2, ChevronDown, Clock3, XCircle } from "lucide-react";
import type { LiveRunState, RunResult } from "../types";

interface RunTimelineProps {
  result?: RunResult | null;
  displayedLoopEvents?: RunResult["loopEvents"] | LiveRunState["events"];
}

type TimelineEvent = NonNullable<RunTimelineProps["displayedLoopEvents"]>[number];

function friendlyEventTitle(title: string) {
  const labels: Record<string, string> = {
    plan_generated: "测试计划已生成",
    plan_compiled: "测试计划已编译",
    scenario_selected: "已选择测试场景",
    artifact_committed: "测试证据已保存",
    run_preparing: "正在准备测试环境",
    run_started: "浏览器执行已开始",
    evidence_collecting: "正在整理测试证据",
    run_judging: "正在生成测试结论",
    run_completed: "本次测试已完成",
    run_failed: "本次测试执行失败",
    run_blocked: "本次测试遇到阻塞"
  };
  return labels[title] ?? title;
}

function eventStatus(event: TimelineEvent) {
  if (event.status === "failed" || event.title === "run_failed" || event.title === "run_blocked") return "failed";
  if (["passed", "completed"].includes(event.status) || event.title === "run_completed") return "passed";
  if (event.status === "waiting_for_user") return "warning";
  return "running";
}

function friendlyEventDescription(event: TimelineEvent) {
  const raw = event.observation ?? event.decisionReason ?? event.decision ?? event.action ?? "运行中";
  if (event.title === "plan_generated") return "正在校验测试路径、断言和证据要求。";
  const trimmed = raw.trim();
  if (!trimmed) return "正在等待新的运行日志。";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const payload = JSON.parse(trimmed) as Record<string, unknown>;
      const error = typeof payload.error === "string" ? payload.error : undefined;
      const finalStatus = typeof payload.finalStatus === "string" ? payload.finalStatus : undefined;
      return error ?? (finalStatus ? `最终状态：${finalStatus}` : "运行状态已更新。");
    } catch {
      return "运行状态已更新。";
    }
  }
  return trimmed.length > 260 ? `${trimmed.slice(0, 257)}…` : trimmed;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function TimelineLogStep({ event, current }: { event: TimelineEvent; current: boolean }) {
  const status = eventStatus(event);
  const latestLog = friendlyEventDescription(event);
  const details = [
    event.action ? { label: "操作", value: event.action } : undefined,
    event.decision ? { label: "决定", value: event.decision } : undefined,
    event.decisionReason ? { label: "原因", value: event.decisionReason } : undefined,
    event.evidenceRefs?.length ? { label: "证据", value: event.evidenceRefs.join("、") } : undefined
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <article className={`timeline-step ${status}${current ? " current" : ""}`}>
      <span className="timeline-step-marker">
        {status === "passed" ? <CheckCircle2 size={16} /> : status === "failed" ? <XCircle size={16} /> : <Activity size={16} />}
      </span>
      <details className="timeline-step-details">
        <summary>
          <div className="timeline-step-heading">
            <strong>{friendlyEventTitle(event.title)}</strong>
            <span>{status === "passed" ? "已完成" : status === "failed" ? "需要处理" : current ? "当前步骤" : "进行中"}</span>
          </div>
          <div className="timeline-latest-log" aria-live={current ? "polite" : "off"}>
            <span className="timeline-live-dot" />
            <p>{latestLog}</p>
            <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
          </div>
          {details.length ? <ChevronDown className="timeline-expand-icon" size={15} /> : null}
        </summary>
        {details.length ? (
          <div className="timeline-log-details">
            {details.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <code>{item.value}</code>
              </div>
            ))}
          </div>
        ) : null}
      </details>
    </article>
  );
}

export function RunTimeline({ result, displayedLoopEvents }: RunTimelineProps) {
  const events = displayedLoopEvents ?? [];
  const hasDetailedEvents = events.length > 0;

  return (
    <section className="run-timeline" aria-label="Agent 执行记录">
      <div className="run-timeline-list">
        {hasDetailedEvents ? (
          events.map((event, index) => (
            <TimelineLogStep event={event} current={index === events.length - 1 && eventStatus(event) !== "passed"} key={event.id} />
          ))
        ) : result?.steps.length ? (
          result.steps.map((step) => (
              <article key={step.stepId} className={`timeline-step ${step.status}`}>
                <span className="timeline-step-marker">
                  {step.status === "passed" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                </span>
                <div className="timeline-static-step">
                  <header>
                    <strong>{step.title}</strong>
                    <span>{step.status === "passed" ? "已完成" : "执行失败"}</span>
                  </header>
                  <div className="timeline-latest-log">
                    <span className="timeline-live-dot" />
                    <p>{step.details}</p>
                  </div>
                </div>
              </article>
          ))
        ) : (
          <div className="run-timeline-empty">
            <Clock3 size={18} />
            <div>
              <strong>等待第一条执行日志</strong>
              <p>测试开始后，当前步骤及其最新日志会在这里实时更新。</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
