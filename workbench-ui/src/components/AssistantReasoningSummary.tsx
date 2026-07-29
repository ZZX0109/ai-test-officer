import { Activity, CheckCircle2, CircleHelp, ListChecks } from "lucide-react";
import type { PlanningMessage } from "../types";

const phaseLabel: Record<NonNullable<PlanningMessage["reasoningSummary"]>["phase"], string> = {
  observing: "正在观察",
  diagnosing: "正在诊断",
  planning: "正在规划",
  "waiting-user": "等待你的决定",
  acting: "正在处理",
  completed: "分析完成"
};

/**
 * Shows an auditable decision summary, not private model chain-of-thought.
 * Every displayed observation is still governed by the message Knowledge
 * Context and can be inspected through KnowledgeBasis.
 */
export function AssistantReasoningSummary({ message }: { message: PlanningMessage }) {
  const summary = message.reasoningSummary;
  if (!summary) return null;

  return (
    <details className="assistant-reasoning-summary" open={summary.phase === "waiting-user"}>
      <summary>
        <Activity size={13} />
        AI 判断摘要
        <span>{phaseLabel[summary.phase]} · {summary.confidence === "high" ? "高可信" : summary.confidence === "medium" ? "中等可信" : "低可信"}</span>
      </summary>
      <div>
        {summary.observations.length ? (
          <section>
            <h5><CheckCircle2 size={12} /> 已观察到</h5>
            <ul>{summary.observations.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
          </section>
        ) : null}
        <section>
          <h5><CircleHelp size={12} /> 当前判断</h5>
          <p>{summary.assessment}</p>
        </section>
        <section>
          <h5><ListChecks size={12} /> 下一步</h5>
          <p>{summary.nextStep}</p>
          <strong className="assistant-user-action">{summary.userAction}</strong>
        </section>
      </div>
      <small>这是基于可验证事实生成的判断摘要，不包含模型内部原始思维链。</small>
    </details>
  );
}
