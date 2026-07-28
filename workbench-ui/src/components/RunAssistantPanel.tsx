import { Bot, KeyRound, Send } from "lucide-react";
import { FormEvent, useState } from "react";
import type { Credential } from "../types";

interface RunAssistantPanelProps {
  message: string;
  blocked?: boolean;
  authRequired?: boolean;
  credentialReady?: boolean;
  apiCredentialRequired?: boolean;
  apiCredentialEnvNames?: string[];
  browserExposedApiCredential?: boolean;
  credentials?: Credential[];
  defaultCredentialId?: string;
  busy?: boolean;
  onSubmit: (feedback: string) => Promise<void> | void;
  onConfigureCredentials: () => void;
  onRetryWithCredentials?: () => Promise<void> | void;
  onBindApiCredential?: (credentialId: string, source: "test-system" | "dedicated") => Promise<void> | void;
  onOpenApiSettings?: () => void;
  reviewRequired?: boolean;
  reviewReason?: string;
  onReviewReasonChange?: (reason: string) => void;
  onAcceptRisk?: () => Promise<void> | void;
  autoRepairAvailable?: boolean;
  onAutoRepair?: () => Promise<void> | void;
  onEditPlan?: () => void;
}

const SECRET_PATTERN = /\b(?:password|passwd|pwd|api[_ -]?key|access[_ -]?token)\b\s*[:=：]\s*\S+|(?:密码|密钥)\s*[:=：]\s*\S+/i;

export function RunAssistantPanel({
  message,
  blocked = false,
  authRequired = false,
  credentialReady = false,
  apiCredentialRequired = false,
  apiCredentialEnvNames = [],
  browserExposedApiCredential = false,
  credentials = [],
  defaultCredentialId,
  busy = false,
  onSubmit,
  onConfigureCredentials,
  onRetryWithCredentials,
  onBindApiCredential,
  onOpenApiSettings,
  reviewRequired = false,
  reviewReason = "",
  onReviewReasonChange,
  onAcceptRisk,
  autoRepairAvailable = false,
  onAutoRepair,
  onEditPlan
}: RunAssistantPanelProps) {
  const [feedback, setFeedback] = useState("");
  const [localMessage, setLocalMessage] = useState("");
  const [selectedCredentialId, setSelectedCredentialId] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = feedback.trim();
    if (!content || busy) return;
    if (SECRET_PATTERN.test(content)) {
      setLocalMessage("检测到疑似密码或 API Key。为了避免进入对话记录，请使用加密凭据配置。");
      setFeedback("");
      onConfigureCredentials();
      return;
    }
    setLocalMessage("");
    await onSubmit(content);
    setFeedback("");
  }

  return (
    <section className={`run-assistant ${blocked && !autoRepairAvailable ? "blocked" : ""} ${autoRepairAvailable ? "auto-repair-message" : ""}`} aria-label="AI 测试助手">
      <header>
        <Bot size={15} />
        <strong>AI 测试助手</strong>
        <span>{busy ? "处理中" : autoRepairAvailable ? "可自动处理" : apiCredentialRequired ? "等待 API 凭据" : credentialReady ? "账号已就绪" : blocked ? "等待反馈" : "在线"}</span>
      </header>
      <p className="run-assistant-message">{message}</p>
      {autoRepairAvailable && onAutoRepair ? (
        <div className="run-assistant-auto-repair">
          <span>我会读取失败链路和已保存证据，重新绑定真实页面、操作与验证结果；其他可执行测试不会因此中止。</span>
          <button type="button" disabled={busy} onClick={() => void onAutoRepair()}>
            {busy ? "正在分析失败链路" : "分析并修复失败链路"}
          </button>
          {onEditPlan ? <button className="secondary" type="button" disabled={busy} onClick={onEditPlan}>修改测试范围</button> : null}
        </div>
      ) : null}
      {authRequired ? (
        <button className="run-assistant-credential" type="button" onClick={onConfigureCredentials}>
          <KeyRound size={14} />
          配置测试账号
        </button>
      ) : null}
      {credentialReady && onRetryWithCredentials ? (
        <button className="run-assistant-retry" type="button" disabled={busy} onClick={() => void onRetryWithCredentials()}>
          <KeyRound size={14} />
          使用账号重新测试
        </button>
      ) : null}
      {apiCredentialRequired && onBindApiCredential ? (
        <div className="run-assistant-api-credential">
          <strong>项目运行需要 API Key</strong>
          <span>{apiCredentialEnvNames.join("、")}</span>
          {browserExposedApiCredential ? (
            <small className="credential-warning">项目会把该 Key 暴露给浏览器代码，只建议使用可撤销的测试 Key。</small>
          ) : null}
          <button
            type="button"
            disabled={busy || !defaultCredentialId}
            onClick={() => defaultCredentialId && void onBindApiCredential(defaultCredentialId, "test-system")}
          >
            沿用当前测试模型凭据
          </button>
          <div className="dedicated-credential-row">
            <select
              aria-label="选择项目专用 API Key"
              value={selectedCredentialId}
              onChange={(event) => setSelectedCredentialId(event.target.value)}
            >
              <option value="">选择另一条已保存凭据</option>
              {credentials.filter((item) => item.id !== defaultCredentialId).map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.model}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || !selectedCredentialId}
              onClick={() => void onBindApiCredential(selectedCredentialId, "dedicated")}
            >
              使用单独凭据
            </button>
          </div>
          <button className="link-button" type="button" onClick={onOpenApiSettings}>
            添加新的 API Key
          </button>
        </div>
      ) : null}
      {reviewRequired && onReviewReasonChange && onAcceptRisk ? (
        <div className="run-assistant-review">
          <strong>需要人工裁决</strong>
          <span>系统已保留原始结论和证据。只有确认接受风险时才会改变最终裁决。</span>
          <input
            aria-label="裁决原因"
            value={reviewReason}
            onChange={(event) => onReviewReasonChange(event.target.value)}
            placeholder="说明为什么可以接受当前风险"
          />
          <button type="button" disabled={busy || !reviewReason.trim()} onClick={() => void onAcceptRisk()}>
            接受风险并留痕
          </button>
        </div>
      ) : null}
      {!autoRepairAvailable ? (
        <>
          <form onSubmit={submit}>
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              rows={3}
              aria-label="向 AI 测试助手反馈"
              placeholder="补充页面入口、账号角色或预期结果…"
            />
            <button type="submit" disabled={busy || !feedback.trim()}>
              <Send size={13} />
              {busy ? "处理中" : "发送反馈"}
            </button>
          </form>
          <small>{localMessage || "请勿在对话中填写密码或 API Key；凭据只通过加密配置保存并在运行时注入沙盒。"}</small>
        </>
      ) : null}
    </section>
  );
}
