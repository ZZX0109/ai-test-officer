import type { ReactNode } from "react";
import { Bot, ChevronDown, Clock3, UserRound } from "lucide-react";
import type {
  AssistantSuggestedAction,
  PlanningMessage,
  RepairPlanActionStatus,
  RepairPlanData
} from "../types";
import { AssistantReasoningSummary } from "./AssistantReasoningSummary";
import { KnowledgeBasis } from "./KnowledgeBasis";
import { RepairPlanPanel } from "./RepairPlanPanel";

function conciseLabelledReply(content: string) {
  const labels = ["遇到的问题", "系统已经做了什么", "需要你做什么"] as const;
  const lines = content.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const selected = labels.flatMap((label) => {
    const line = lines.find((candidate) => candidate.startsWith(`${label}：`) || candidate.startsWith(`${label}:`));
    if (!line) return [];
    const compact = line.replace(/\s+/g, " ");
    return [compact.length > 260 ? `${compact.slice(0, 257)}…` : compact];
  });
  return selected.length === labels.length ? selected.join("\n") : undefined;
}

function assistantPresentation(content: string) {
  const normalized = content.trim();
  const labelledReply = conciseLabelledReply(normalized);
  const technical = (
    /(?:Validation failed|provider_[a-z_]+|action_binding_failure|page\.[a-z]+:|Call log:|\{"error")/i.test(normalized)
      ? normalized
      : undefined
  );
  if (labelledReply) {
    return { visible: labelledReply, technical };
  }
  const withoutTelemetry = normalized
    .replace(/\n{2,}(?:模型\s+\S+|[\w.-]+\s+·\s+\d+\s+Token)[^\n]*$/i, "")
    .replace(
      /probe\.page_unavailable:page\.waitForFunction:\s*Timeout\s*\d+ms exceeded(?:\.\s*Call log:[^\n]*)?/gi,
      "目标页面在等待时间内没有出现可操作内容，页面入口或加载状态尚未确认"
    )
    .replace(
      /action_binding_failure(?::\s*)?(?:page\.[^\n；。]*)?/gi,
      "当前页面没有找到与计划匹配的可验证控件"
    )
    .trim();

  if (/Validation failed|fieldErrors|provider_http_400/i.test(normalized)) {
    return {
      visible: "模型解释请求没有通过格式校验。测试证据和机器结论已经保留，系统会压缩上下文后重试；这不会把失败误判为通过。",
      technical
    };
  }
  if (/page\.screenshot.*timeout|截图.*超时/i.test(normalized)) {
    return {
      visible: "当前页面截图在等待时间内没有完成。系统已保留已有步骤和证据，其他测试会继续；该链路会单独进入诊断。",
      technical
    };
  }
  if (/AI (?:助手|解释).*暂时(?:无法|不可用)/i.test(normalized)) {
    return {
      visible: "模型暂时没有返回有效解释。机器结论和已有证据仍然有效，你可以直接追问或稍后重试分析。",
      technical
    };
  }
  if (technical) {
    const visible = /(?:ERR_CONNECTION_REFUSED|connect(?:ion)? refused|端口.*(?:错误|不可访问))/i.test(normalized)
      ? "遇到的问题：测试页面当前无法连接。\n系统已经做了什么：已保存页面预检和连接失败信息，正式测试尚未开始。\n需要你做什么：请确认项目服务和测试地址正确后重试。"
      : /(?:401|403|unauthori[sz]ed|forbidden)/i.test(normalized)
        ? "遇到的问题：页面明确返回认证或权限错误。\n系统已经做了什么：已停止受保护路径并保留响应证据。\n需要你做什么：请绑定专用测试凭据或确认可测试的公开路径。"
        : "遇到的问题：当前步骤返回了技术错误。\n系统已经做了什么：已保留机器结论和现有证据，其他独立路径不会因此被误判为通过。\n需要你做什么：可查看技术详情，或让系统重试当前失败链路。";
    return { visible, technical };
  }
  return { visible: withoutTelemetry || "消息已记录。", technical };
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function AssistantConversationMessage({
  message,
  actions,
  onRepairPlanAction,
  onOpenRepairEvidence,
  repairPlanActionStatus
}: {
  message: PlanningMessage;
  actions?: ReactNode;
  /**
   * Executes the repair plan's action. When omitted the panel renders read-only
   * — used for历史消息, where re-running an action would be misleading.
   */
  onRepairPlanAction?: (action: Exclude<AssistantSuggestedAction, "none">, plan: RepairPlanData) => void;
  onOpenRepairEvidence?: (evidenceId: string, plan: RepairPlanData) => void;
  repairPlanActionStatus?: RepairPlanActionStatus;
}) {
  const presentation = assistantPresentation(message.content);
  const assistant = message.role === "assistant";
  const progress = message.id.startsWith("progress:");
  const streaming = message.id.includes("pending") || Boolean(message.streaming);

  return (
    <article className={`${message.role} assistant-conversation-message${streaming ? " pending" : ""}${progress ? " is-progress" : ""}`}>
      <header className="assistant-message-header">
        <span className="assistant-message-avatar" aria-hidden="true">
          {assistant ? <Bot size={14} /> : <UserRound size={14} />}
        </span>
        <strong>{assistant ? "AI 测试官" : "你"}</strong>
        <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
      </header>
      <div className="assistant-message-copy">
        {presentation.visible.split(/\n+/).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
      {streaming ? (
        <span className="assistant-typing" aria-label="AI 正在思考并执行">
          <b>{message.streaming ? "正在思考" : "正在回复"}</b><i /><i /><i />
        </span>
      ) : null}
      {assistant && !streaming && message.llmTrace ? (
        <details className="assistant-call-details">
          <summary>
            <Clock3 size={12} />
            {message.llmTrace.fallbackApplied ? "回复来源" : "模型调用详情"}
            <ChevronDown size={12} />
          </summary>
          <div>
            {message.llmTrace.fallbackApplied ? (
              <span className="assistant-source-note">
                模型本次没有返回合格的结构化答复；系统依据已保存的测试事实生成了这段说明。
              </span>
            ) : null}
            <span>{message.llmTrace.model ?? "当前模型"}</span>
            {message.llmTrace.durationMs !== undefined ? <span>{message.llmTrace.durationMs} ms</span> : null}
            {message.llmTrace.totalTokens !== undefined ? <span>{message.llmTrace.totalTokens} Token</span> : null}
            {message.llmTrace.errorCode ? <span>{message.llmTrace.errorCode}</span> : null}
            <code>{message.llmTrace.callId}</code>
          </div>
        </details>
      ) : null}
      {assistant && !streaming && presentation.technical ? (
        <details className="assistant-technical-details">
          <summary>查看技术详情</summary>
          <pre>{presentation.technical}</pre>
        </details>
      ) : null}
      {assistant && !streaming ? <AssistantReasoningSummary message={message} /> : null}
      {assistant && !streaming ? <KnowledgeBasis message={message} /> : null}
      {assistant && !streaming && message.repairPlan ? (
        <RepairPlanPanel
          data={message.repairPlan}
          onAction={onRepairPlanAction}
          onOpenEvidence={onOpenRepairEvidence}
          actionStatus={repairPlanActionStatus}
        />
      ) : null}
      {actions ? <div className="assistant-inline-actions">{actions}</div> : null}
    </article>
  );
}
