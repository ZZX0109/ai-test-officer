import { Activity, CheckCircle2, XCircle } from "lucide-react";
import type { LiveRunState, RunResult } from "../types";

interface RunTimelineProps {
  result?: RunResult | null;
  displayedLoopEvents?: RunResult["loopEvents"] | LiveRunState["events"];
}

function friendlyEventTitle(title: string) {
  const labels: Record<string, string> = {
    plan_generated: "测试计划已生成",
    plan_compiled: "测试计划已编译",
    scenario_selected: "已选择测试场景",
    artifact_committed: "测试证据已保存"
  };
  return labels[title] ?? title;
}

function friendlyEventDescription(event: NonNullable<RunTimelineProps["displayedLoopEvents"]>[number]) {
  const raw = event.observation ?? event.decisionReason ?? event.action ?? "运行中";
  if (event.title === "plan_generated") return "正在校验测试路径、断言和证据要求。";
  const trimmed = raw.trim();
  if (trimmed.length > 240 || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "已记录执行细节；完整计划和证据可在报告中查看。";
  }
  return raw;
}

export function RunTimeline({ result, displayedLoopEvents }: RunTimelineProps) {
  const loopFallback = displayedLoopEvents?.slice(-5).map((event) => (
    <article key={event.id} className={`timeline-step ${event.status === "failed" ? "failed" : "running"}`}>
      <span className="timeline-step-marker">
        {event.status === "failed" ? <XCircle size={16} /> : <Activity size={16} />}
      </span>
      <div>
        <header>
          <strong>{friendlyEventTitle(event.title)}</strong>
          <span>{event.status === "failed" ? "需要处理" : "进行中"}</span>
        </header>
        <p>{friendlyEventDescription(event)}</p>
      </div>
    </article>
  ));

  return (
    <section className="run-timeline" aria-label="Agent 执行记录">
      <div className="run-timeline-list">
        {result?.steps.map((step) => (
          <article key={step.stepId} className={`timeline-step ${step.status}`}>
            <span className="timeline-step-marker">
              {step.status === "passed" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            </span>
            <div>
              <header>
                <strong>{step.title}</strong>
                <span>{step.status === "passed" ? "已完成" : "执行失败"}</span>
              </header>
              <p>{step.details}</p>
            </div>
          </article>
        )) ?? loopFallback ?? (
          <div className="run-timeline-empty">
            <Activity size={18} />
            <div>
              <strong>等待执行</strong>
              <p>测试开始后，这里会按顺序显示浏览器操作和证据采集状态。</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
