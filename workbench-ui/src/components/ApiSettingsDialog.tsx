import { FileSearch, Pencil, Save, Star, Trash2, X } from "lucide-react";
import { useState } from "react";
import { CredentialSetupWizard } from "./CredentialSetupWizard";
import type { Credential, ProjectConfig, ProjectDetectionResult } from "../types";

export interface CredentialFormValues {
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  tags: string;
  owner: string;
  scopes: string;
  isDefault: boolean;
}

interface ApiSettingsDialogProps {
  open: boolean;
  credentialFormOpen: boolean;
  editingCredentialId: string | null;
  form: CredentialFormValues;
  credentials: Credential[];
  projectDraft: ProjectConfig | null;
  projectDetection: ProjectDetectionResult | null;
  defaultCredentialId?: string;
  loginUsername: string;
  loginPassword: string;
  onClose: () => void;
  onToggleCredentialForm: () => void;
  onCancelEdit: () => void;
  onFormChange: (form: CredentialFormValues) => void;
  onSubmitCredential: (event: React.FormEvent<HTMLFormElement>) => void;
  onLoginUsernameChange: (value: string) => void;
  onLoginPasswordChange: (value: string) => void;
  onSaveProjectLogin: (username: string, password: string) => Promise<void>;
  onTestCredential: (credentialId: string) => Promise<{ ok: boolean; status: number; message: string }>;
  onEditCredential: (credential: Credential) => void;
  onMakeDefault: (credentialId: string) => void;
  onDeleteCredential: (credentialId: string) => void;
}

export function ApiSettingsDialog({
  open, credentialFormOpen, editingCredentialId, form, credentials, projectDraft,
  projectDetection, defaultCredentialId, loginUsername, loginPassword, onClose,
  onToggleCredentialForm, onCancelEdit, onFormChange, onSubmitCredential,
  onLoginUsernameChange, onLoginPasswordChange, onSaveProjectLogin,
  onTestCredential, onEditCredential, onMakeDefault, onDeleteCredential
}: ApiSettingsDialogProps) {
  const [testStates, setTestStates] = useState<Record<string, { status: "testing" | "success" | "error"; message: string }>>({});

  async function testSavedCredential(credentialId: string) {
    setTestStates((current) => ({ ...current, [credentialId]: { status: "testing", message: "正在连接模型…" } }));
    try {
      const result = await onTestCredential(credentialId);
      setTestStates((current) => ({
        ...current,
        [credentialId]: { status: result.ok ? "success" : "error", message: result.message }
      }));
    } catch (error) {
      setTestStates((current) => ({
        ...current,
        [credentialId]: {
          status: "error",
          message: error instanceof Error ? error.message : "连接测试失败，请检查 Agent 服务和 API 配置。"
        }
      }));
    }
  }

  if (!open) return null;
  return (

      <div className="api-settings-backdrop" role="presentation" onMouseDown={onClose}>
        <section
          className="api-settings-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="api-settings-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header>
            <div>
              <p className="eyebrow">AI 配置</p>
              <h2 id="api-settings-title">API Key 与模型</h2>
              <p>配置一次后，测试计划和问题分析会自动使用默认模型。</p>
            </div>
            <button className="icon-button" type="button" aria-label="关闭 API Key 配置" onClick={onClose}>
              <X size={17} />
            </button>
          </header>

          <button
            className="add-credential-button"
            type="button"
            onClick={onToggleCredentialForm}
          >
            {credentialFormOpen ? "收起配置" : "添加新的 API Key"}
          </button>

          {credentialFormOpen && <form className="api-settings-form" onSubmit={onSubmitCredential}>
            <label>
              配置名称
              <input aria-label="名称" value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} placeholder="例如：我的 GPT" />
            </label>
            <label>
              服务商
              <select aria-label="Provider" value={form.provider} onChange={(event) => onFormChange({ ...form, provider: event.target.value })}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai-compatible">兼容 OpenAI 的服务</option>
                <option value="custom">自定义服务</option>
              </select>
            </label>
            <label>
              API 地址
              <input aria-label="Base URL" value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
            </label>
            <label>
              模型名称
              <input aria-label="模型" value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} placeholder="gpt-5.1-codex" />
            </label>
            <label>
              API Key
              <input aria-label="API Key" type="password" value={form.apiKey} onChange={(event) => onFormChange({ ...form, apiKey: event.target.value })} placeholder={editingCredentialId ? "留空则保留原来的 Key" : "粘贴 API Key"} />
              <small>密钥不会显示在报告或测试证据中。</small>
            </label>
            <details className="api-settings-advanced">
              <summary>高级设置</summary>
              <label>标签<input aria-label="标签" value={form.tags} onChange={(event) => onFormChange({ ...form, tags: event.target.value })} /></label>
              <label>Owner<input aria-label="Owner" value={form.owner} onChange={(event) => onFormChange({ ...form, owner: event.target.value })} /></label>
              <label>Scopes<input aria-label="Scopes" value={form.scopes} onChange={(event) => onFormChange({ ...form, scopes: event.target.value })} /></label>
              <label className="checkbox-row"><input checked={form.isDefault} onChange={(event) => onFormChange({ ...form, isDefault: event.target.checked })} type="checkbox" />设为默认模型</label>
            </details>
            <div className="form-actions">
              <button className="primary" type="submit"><Save size={15} />{editingCredentialId ? "保存修改" : "保存 API Key"}</button>
              <button type="button" onClick={onCancelEdit}>取消</button>
            </div>
          </form>}
          <CredentialSetupWizard project={projectDraft} modelCredentialId={defaultCredentialId} username={loginUsername} password={loginPassword} onUsernameChange={onLoginUsernameChange} onPasswordChange={onLoginPasswordChange} onSaveLogin={onSaveProjectLogin} />
          <section className="saved-credentials" aria-label="已保存的模型配置">
            <h3>已保存的配置</h3>
            {credentials.length ? credentials.map((credential) => (
              <article key={credential.id} className={credential.isDefault ? "is-default" : undefined}>
                <div>
                  <div className="credential-title-row">
                    <strong>{credential.name}</strong>
                    {credential.isDefault ? <span className="default-model-badge">当前默认</span> : null}
                  </div>
                  <span>{credential.provider} · {credential.model}</span>
                  <small>{credential.apiKeyMasked}</small>
                </div>
                <div className="row-actions">
                  <button type="button" aria-label={`测试 API Key：${credential.name}`} disabled={testStates[credential.id]?.status === "testing"} onClick={() => void testSavedCredential(credential.id)}>
                    <FileSearch size={15} />{testStates[credential.id]?.status === "testing" ? "测试中…" : "测试"}
                  </button>
                  <button className="icon-button" type="button" title="编辑" onClick={() => onEditCredential(credential)}><Pencil size={15} /></button>
                  <button
                    className={`icon-button default-model-action${credential.isDefault ? " is-current" : ""}`}
                    disabled={credential.isDefault}
                    type="button"
                    aria-label={credential.isDefault ? `${credential.name} 是当前默认模型` : `设 ${credential.name} 为默认模型`}
                    aria-pressed={credential.isDefault}
                    title={credential.isDefault ? "当前默认模型" : "设为默认模型"}
                    onClick={() => onMakeDefault(credential.id)}
                  >
                    <Star size={15} fill={credential.isDefault ? "currentColor" : "none"} />
                  </button>
                  <button className="icon-button" type="button" title="删除" onClick={() => onDeleteCredential(credential.id)}><Trash2 size={15} /></button>
                </div>
                {testStates[credential.id] ? <p className={`credential-test-result ${testStates[credential.id].status}`} role={testStates[credential.id].status === "error" ? "alert" : "status"} aria-live="polite">{testStates[credential.id].message}</p> : null}
              </article>
            )) : <p>还没有配置 API Key。</p>}
          </section>
        </section>
      </div>
  );
}
