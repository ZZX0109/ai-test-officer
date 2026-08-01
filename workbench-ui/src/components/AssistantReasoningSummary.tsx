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

function conciseReasoningText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (/Validation failed|fieldErrors|provider_http_400/i.test(normalized)) {
    return "模型返回内容未通过结构校验，机器事实和测试证据不受影响。";
  }
  if (/page\.screenshot.*timeout|截图.*超时/i.test(normalized)) {
    return "页面截图步骤超过等待时间，已有证据已保留。";
  }
  if (/action_binding_failure/i.test(normalized)) {
    return "当前页面操作没有成功绑定到已验证控件。";
  }
  if (/Call log:|\{"error"/i.test(normalized)) {
    return "执行步骤返回了技术错误，完整原文已收纳在消息的技术详情中。";
  }
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
}

/**
 * Shows an auditable decision summary, not private model chain-of-thought.
 * Every displayed observation is still governed by the message Knowledge
 * Context and can be inspected through KnowledgeBasis.
 */
export function AssistantReasoningSummary({ message }: { message: PlanningMessage }) {
  const summary = message.reasoningSummary;
  if (!summary) return null;

  return (
    <details className="assistant-reasoning-summary">
      <summary>
        <Activity size={13} />
        查看处理依据
        <span>{phaseLabel[summary.phase]} · {summary.confidence === "high" ? "高可信" : summary.confidence === "medium" ? "中等可信" : "低可信"}</span>
      </summary>
      <div>
        {summary.observations.length ? (
          <section>
            <h5><CheckCircle2 size={12} /> 已观察到</h5>
            <ul>{summary.observations.map((item, index) => <li key={`${item}-${index}`}>{conciseReasoningText(item)}</li>)}</ul>
          </section>
        ) : null}
        <section>
          <h5><CircleHelp size={12} /> 当前判断</h5>
          <p>{conciseReasoningText(summary.assessment)}</p>
        </section>
        <section>
          <h5><ListChecks size={12} /> 下一步</h5>
          <p>{conciseReasoningText(summary.nextStep)}</p>
          <strong className="assistant-user-action">{conciseReasoningText(summary.userAction)}</strong>
        </section>
      </div>
      <small>这里只展示可验证事实、判断和下一步，不展示模型内部思维链。</small>
    </details>
  );
}
