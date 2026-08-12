import { useEffect, useMemo, useState } from "react";
import type { AgentInterrupt, RepairDecisionValue } from "../types";

const OWNER_LABELS: Record<string, string> = {
  agent: "系统（可自动处理）",
  user: "你（需要操作）",
  environment: "环境（需要排查）",
  developer: "开发者（需要确认）"
};

// A decision the user cannot understand is a decision they cannot make. Every
// option promises exactly what happens next rather than a generic "继续".
const FALLBACK_OPTIONS: { value: RepairDecisionValue; label: string; description: string }[] = [
  { value: "repair", label: "由系统修复", description: "授权系统在沙盒中复现并生成修复方案。" },
  { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
];

/** Options that only make sense once the user has supplied extra context. */
const REQUIRES_MESSAGE = new Set<string>(["provide-credentials"]);

export interface InterruptDecisionPanelProps {
  interrupt: AgentInterrupt;
  /** Resumes the paused graph with the chosen decision. Must hit the backend. */
  onDecide: (decision: RepairDecisionValue, message?: string) => Promise<void> | void;
  /** Opens a single evidence item the diagnosis was derived from. */
  onOpenEvidence?: (evidenceId: string) => void;
  /** Jumps to the credential manager without losing the pending interrupt. */
  onOpenCredentials?: () => void;
  /** Saves a test account inline (encrypted) then resumes with "approved". */
  onSaveCredentials?: (username: string, password: string) => Promise<void>;
  /** Opens the sandbox recovery view for environment-owned failures. */
  onRecoverSandbox?: () => void;
  /** Re-runs discovery once the blocking condition has been cleared. */
  onReopenDiscovery?: () => void;
  /** Opens the editable repair workspace for developer-owned failures. */
  onOpenRepairWorkspace?: () => void;
  busy?: boolean;
  error?: string;
}

export function InterruptDecisionPanel({
  interrupt,
  onDecide,
  onOpenEvidence,
  onOpenCredentials,
  onSaveCredentials,
  onRecoverSandbox,
  onReopenDiscovery,
  onOpenRepairWorkspace,
  busy = false,
  error
}: InterruptDecisionPanelProps) {
  const options = useMemo(
    () => (interrupt.options?.length ? interrupt.options : FALLBACK_OPTIONS),
    [interrupt.options]
  );
  const [selected, setSelected] = useState<string>(options[0]?.value ?? "dismiss");
  const [message, setMessage] = useState("");
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [credSaving, setCredSaving] = useState(false);
  const [credError, setCredError] = useState("");

  // A new interrupt is a new question. Never carry the previous answer over —
  // silently resuming with a stale choice is worse than asking again.
  useEffect(() => {
    setSelected(options[0]?.value ?? "dismiss");
    setMessage("");
    setCredUsername("");
    setCredPassword("");
    setCredError("");
  }, [interrupt.id, options]);

  const owner = interrupt.owner ?? "agent";
  const ownerLabel = OWNER_LABELS[owner] ?? owner;
  const diagnoses = interrupt.diagnoses ?? [];
  const evidenceRefs = interrupt.evidenceRefs ?? [];
  const isCredential = interrupt.kind === "credential";
  const hasSavedCredential = interrupt.context?.hasSavedCredential === true;
  const usernameMasked = typeof interrupt.context?.usernameMasked === "string"
    ? (interrupt.context.usernameMasked as string)
    : undefined;
  // When no account is saved, the only honest path forward is to provide one
  // inline — "我已配置账号" without a form is a dead end the user cannot act on.
  const needsInlineCredentialForm = isCredential && !hasSavedCredential && Boolean(onSaveCredentials);
  const credFormIncomplete = needsInlineCredentialForm && (!credUsername.trim() || !credPassword.trim());
  const suggested = typeof interrupt.context?.suggestedApproach === "string"
    ? (interrupt.context.suggestedApproach as string)
    : undefined;
  const validation = typeof interrupt.context?.validation === "string"
    ? (interrupt.context.validation as string)
    : undefined;
  const sandboxBlocked = interrupt.context?.sandboxBlocked === true;
  const selectedOption = options.find((option) => option.value === selected);
  const messageRequired = REQUIRES_MESSAGE.has(selected) && message.trim().length === 0;

  const submit = async (decision: string) => {
    if (busy) return;
    if (needsInlineCredentialForm && decision === "approved" && onSaveCredentials) {
      if (credFormIncomplete) {
        setCredError("请先填写测试账号和密码。");
        return;
      }
      setCredSaving(true);
      setCredError("");
      try {
        await onSaveCredentials(credUsername.trim(), credPassword);
      } catch (saveError) {
        setCredSaving(false);
        setCredError(saveError instanceof Error ? saveError.message : "保存测试账号失败，请重试。");
        return;
      }
      setCredSaving(false);
    }
    await onDecide(decision as RepairDecisionValue, message.trim() || undefined);
  };

  const primaryBusy = busy || credSaving;

  return (
    <section className="interrupt-decision-panel" aria-label="等待你的决策" role="region">
      <header className="interrupt-decision-header">
        <span className="interrupt-decision-pulse" aria-hidden="true" />
        <div className="interrupt-decision-heading">
          <strong>{interrupt.title}</strong>
          <span className="interrupt-decision-subtitle">测试已暂停，等待决策后继续</span>
        </div>
        <span className={`interrupt-decision-owner interrupt-decision-owner-${owner}`}>{ownerLabel}</span>
      </header>

      <p className="interrupt-decision-problem">{interrupt.detail}</p>

      {diagnoses.length ? (
        <div className="interrupt-decision-block">
          <span className="interrupt-decision-label">系统已完成的诊断</span>
          <ul>
            {diagnoses.slice(0, 8).map((item, index) => (
              <li key={`${item}-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {suggested ? (
        <div className="interrupt-decision-block">
          <span className="interrupt-decision-label">建议的处理方式</span>
          <ol>
            {suggested.split("\n").filter(Boolean).map((step, index) => (
              <li key={`${step}-${index}`}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {validation ? (
        <p className="interrupt-decision-validation">
          <span className="interrupt-decision-label">验证方式</span>
          {validation}
        </p>
      ) : null}

      {sandboxBlocked ? (
        <p className="interrupt-decision-warning" role="note">
          自动修复需要沙盒写入权限。请在权限配置中放行后再选择「由系统修复」。
        </p>
      ) : null}

      <dl className="interrupt-decision-refs">
        <div>
          <dt>Run</dt>
          <dd>{interrupt.runId}</dd>
        </div>
        {interrupt.attemptId ? (
          <div>
            <dt>Attempt</dt>
            <dd>{interrupt.attemptId}</dd>
          </div>
        ) : null}
        {interrupt.scenarioId ? (
          <div>
            <dt>场景</dt>
            <dd>{interrupt.scenarioId}</dd>
          </div>
        ) : null}
      </dl>

      {evidenceRefs.length && onOpenEvidence ? (
        <div className="interrupt-decision-block">
          <span className="interrupt-decision-label">支撑证据</span>
          <ul className="interrupt-decision-evidence">
            {evidenceRefs.slice(0, 8).map((evidenceId) => (
              <li key={evidenceId}>
                <button type="button" onClick={() => onOpenEvidence(evidenceId)}>
                  {evidenceId}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {isCredential && hasSavedCredential ? (
        <p className="interrupt-decision-saved-credential" role="note">
          已保存测试账号{usernameMasked ? <strong>{usernameMasked}</strong> : null}。
          选择「使用已保存账号继续」后，系统仅在当前沙盒会话注入登录，不会显示或写入报告。
        </p>
      ) : null}

      {needsInlineCredentialForm ? (
        <div className="interrupt-decision-credential-form">
          <span className="interrupt-decision-label">填写本次测试账号（加密保存，仅注入沙盒）</span>
          <div className="interrupt-decision-credential-grid">
            <label>
              测试账号
              <input
                type="text"
                autoComplete="off"
                value={credUsername}
                disabled={primaryBusy}
                placeholder="邮箱或用户名"
                onChange={(event) => setCredUsername(event.target.value)}
              />
            </label>
            <label>
              测试密码
              <input
                type="password"
                autoComplete="new-password"
                value={credPassword}
                disabled={primaryBusy}
                placeholder="输入测试密码"
                onChange={(event) => setCredPassword(event.target.value)}
              />
            </label>
          </div>
          {credError ? <p className="interrupt-decision-error" role="alert">{credError}</p> : null}
        </div>
      ) : null}

      <fieldset className="interrupt-decision-options" disabled={busy}>
        <legend className="interrupt-decision-label">{needsInlineCredentialForm ? "填写账号后选择" : "需要你选择"}</legend>
        {options.map((option) => (
          <label
            key={option.value}
            className={`interrupt-decision-option ${selected === option.value ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              name={`interrupt-${interrupt.id}`}
              value={option.value}
              checked={selected === option.value}
              onChange={() => setSelected(option.value)}
            />
            <span className="interrupt-decision-option-body">
              <strong>{option.label}</strong>
              {option.description ? <em>{option.description}</em> : null}
            </span>
          </label>
        ))}
      </fieldset>

      <label className="interrupt-decision-message">
        <span className="interrupt-decision-label">
          补充信息{REQUIRES_MESSAGE.has(selected) ? "（必填）" : "（可选）"}
        </span>
        <textarea
          value={message}
          rows={3}
          disabled={busy}
          placeholder={
            selected === "provide-credentials"
              ? "说明已配置的账号入口或注意事项，便于系统恢复后使用。"
              : "补充你观察到的现象或额外约束，会随决策一并记录。"
          }
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>

      <div className="interrupt-decision-actions">
        <button
          type="button"
          className="primary"
          disabled={primaryBusy || messageRequired || (needsInlineCredentialForm && selected === "approved" && credFormIncomplete)}
          onClick={() => void submit(selected)}
        >
          {primaryBusy
            ? (credSaving ? "正在保存账号…" : "正在恢复测试…")
            : `确认：${selectedOption?.label ?? "继续"}`}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={primaryBusy}
          onClick={() => void submit("dismiss")}
        >
          拒绝修复并保留失败结论
        </button>
      </div>

      <div className="interrupt-decision-shortcuts">
        {onOpenCredentials ? (
          <button type="button" disabled={busy} onClick={onOpenCredentials}>配置测试账号</button>
        ) : null}
        {onRecoverSandbox ? (
          <button type="button" disabled={busy} onClick={onRecoverSandbox}>恢复沙盒环境</button>
        ) : null}
        {onReopenDiscovery ? (
          <button type="button" disabled={busy} onClick={onReopenDiscovery}>重新扫描页面</button>
        ) : null}
        {onOpenRepairWorkspace ? (
          <button type="button" disabled={busy} onClick={onOpenRepairWorkspace}>打开修复工作区</button>
        ) : null}
      </div>

      {messageRequired ? (
        <p className="interrupt-decision-hint">该选项需要先填写补充信息，说明凭据已就绪。</p>
      ) : null}
      {error ? (
        <p className="interrupt-decision-error" role="alert">{error}</p>
      ) : null}
    </section>
  );
}
