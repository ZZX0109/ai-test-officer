import { Bot, KeyRound, Send } from "lucide-react";
import { FormEvent, useState } from "react";

interface RunAssistantPanelProps {
  message: string;
  blocked?: boolean;
  authRequired?: boolean;
  credentialReady?: boolean;
  busy?: boolean;
  onSubmit: (feedback: string) => Promise<void> | void;
  onConfigureCredentials: () => void;
  onRetryWithCredentials?: () => Promise<void> | void;
}

const SECRET_PATTERN = /\b(?:password|passwd|pwd)\b\s*[:=：]\s*\S+|密码\s*[:=：]\s*\S+/i;

export function RunAssistantPanel({
  message,
  blocked = false,
  authRequired = false,
  credentialReady = false,
  busy = false,
  onSubmit,
  onConfigureCredentials,
  onRetryWithCredentials
}: RunAssistantPanelProps) {
  const [feedback, setFeedback] = useState("");
  const [localMessage, setLocalMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const content = feedback.trim();
    if (!content || busy) return;
    if (SECRET_PATTERN.test(content)) {
      setLocalMessage("检测到疑似密码。为了避免进入对话记录，请使用“配置测试账号”。");
      setFeedback("");
      onConfigureCredentials();
      return;
    }
    setLocalMessage("");
    await onSubmit(content);
    setFeedback("");
  }

  return (
    <section className={`run-assistant ${blocked ? "blocked" : ""}`} aria-label="AI 测试助手">
      <header>
        <Bot size={15} />
        <strong>AI 测试助手</strong>
        <span>{busy ? "处理中" : credentialReady ? "账号已就绪" : blocked ? "等待反馈" : "在线"}</span>
      </header>
      <p className="run-assistant-message">{message}</p>
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
      <small>{localMessage || "请勿在对话中填写密码；密码只通过加密账号配置保存。"}</small>
    </section>
  );
}
