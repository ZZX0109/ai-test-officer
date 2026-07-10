import { Activity, CheckCircle2, XCircle } from "lucide-react";
import type { LiveRunState, RunResult } from "../types";

interface RunTimelineProps {
  result?: RunResult | null;
  displayedLoopEvents?: RunResult["loopEvents"] | LiveRunState["events"];
}

export function RunTimeline({ result, displayedLoopEvents }: RunTimelineProps) {
  const loopFallback = displayedLoopEvents?.slice(-5).map((event) => (
    <article key={event.id} className={`step ${event.status === "failed" ? "failed" : "passed"}`}>
      {event.status === "failed" ? <XCircle size={16} /> : <Activity size={16} />}
      <div>
        <strong>{event.title}</strong>
        <p>{event.observation ?? event.decisionReason ?? event.action ?? "运行中"}</p>
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
