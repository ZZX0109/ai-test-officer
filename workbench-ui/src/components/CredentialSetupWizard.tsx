import { useState } from "react";
import { checkProjectCredentialSetup } from "../api";
import type { ProjectConfig } from "../types";

interface CredentialSetupWizardProps {
  project: ProjectConfig | null;
  modelCredentialId?: string;
  username: string;
  password: string;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSaveLogin: (username: string, password: string) => Promise<void>;
}

export function CredentialSetupWizard(props: CredentialSetupWizardProps) {
  const [checks, setChecks] = useState<Array<{ id: string; status: "ready" | "blocked"; message: string; remediation?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    if (!props.project?.id) return;
    setBusy(true);
    try { setChecks((await checkProjectCredentialSetup(props.project.id, props.modelCredentialId)).checks); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!props.username.trim() || !props.password) return;
    setBusy(true);
    try { await props.onSaveLogin(props.username.trim(), props.password); props.onPasswordChange(""); await check(); }
    finally { setBusy(false); }
  };
  return <section className="credential-setup-wizard" aria-label="统一凭据配置向导">
    <div className="credential-setup-wizard__heading"><div><p className="eyebrow">统一配置向导</p><h3>模型与项目凭据</h3></div><span>密钥只进入加密存储，运行时才注入</span></div>
    <p>模型凭据用于规划和分析；项目登录凭据只用于当前项目的沙盒登录。两者作用域分离，但可以在这里一次完成检查。</p>
    {props.project ? <div className="credential-setup-wizard__project"><strong>{props.project.name}</strong><div className="connector-grid">
      <label>项目测试账号<input autoComplete="off" value={props.username} onChange={(event) => props.onUsernameChange(event.target.value)} placeholder={props.project.login?.credentialId ? "留空则保留已保存账号" : "邮箱或用户名"} /></label>
      <label>项目测试密码<input type="password" autoComplete="new-password" value={props.password} onChange={(event) => props.onPasswordChange(event.target.value)} placeholder="仅在保存时提交" /></label>
    </div><div className="form-actions"><button type="button" disabled={busy || !props.username.trim() || !props.password} onClick={() => void save()}>保存项目登录凭据</button><button type="button" disabled={busy} onClick={() => void check()}>{busy ? "检查中…" : "检查全部凭据"}</button></div></div> : <p>选择并保存项目后，这里可以配置项目登录凭据。</p>}
    {checks ? <ul className="credential-setup-checks" aria-live="polite">{checks.map((item) => <li key={item.id} className={item.status}><strong>{item.status === "ready" ? "通过" : "阻断"}</strong><span>{item.message}</span>{item.remediation ? <small>{item.remediation}</small> : null}</li>)}</ul> : null}
  </section>;
}
