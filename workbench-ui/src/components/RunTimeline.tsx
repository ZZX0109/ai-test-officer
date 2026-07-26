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
    <article key={event.id} className={`step ${event.status === "failed" ? "failed" : "passed"}`}>
      {event.status === "failed" ? <XCircle size={16} /> : <Activity size={16} />}
      <div>
        <strong>{friendlyEventTitle(event.title)}</strong>
        <p>{friendlyEventDescription(event)}</p>
      </div>
    </article>
  ));

  return (
    <section>
      <h3>Agent Actions</h3>
      <div className="step-list">
        {result?.steps.map((step) => (
          <article key={step.stepId} className={`step ${step.status}`}>
            {step.status === "passed" ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <div>
              <strong>{step.title}</strong>
              <p>{step.details}</p>
            </div>
          </article>
        )) ?? loopFallback ?? <p className="empty">执行后会显示鼠标、键盘和浏览器操作。</p>}
      </div>
    </section>
  );
}
