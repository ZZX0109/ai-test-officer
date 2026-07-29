import { useState } from "react";
import { KeyRound, RotateCcw, ShieldPlus } from "lucide-react";
import type { Credential, ProjectGrant, SecuritySummary } from "../types";

interface SecurityPanelProps {
  security?: SecuritySummary | null;
  credentials: Credential[];
  grants: ProjectGrant[];
  selectedProjectId?: string;
  onCreateGrant: (payload: { subject: string; role: ProjectGrant["role"] }) => void;
  onRotateCredential: (id: string, apiKey: string, reason?: string) => void;
}

export function SecurityPanel({
  security,
  credentials,
  grants,
  selectedProjectId,
  onCreateGrant,
  onRotateCredential
}: SecurityPanelProps) {
  const [subject, setSubject] = useState("qa-oncall");
  const [role, setRole] = useState<ProjectGrant["role"]>("editor");
  const [rotationCredentialId, setRotationCredentialId] = useState("");
  const [rotationKey, setRotationKey] = useState("");
  const [rotationReason, setRotationReason] = useState("routine rotation");

  return (
    <section className="security-box">
      <h3>安全与权限</h3>
      <div className="trust-grid">
        <article className={security?.defaultDevTokenAllowed === false ? "passed" : "warning"}>
          <strong>Token 边界</strong>
          <span>{String(security?.tokenMode ?? "unknown")} · dev={String(security?.defaultDevTokenAllowed ?? "unknown")}</span>
        </article>
        <article className="passed">
          <strong>Artifact Access</strong>
          <span>{String(security?.artifactAccess ?? "token gated")}</span>
        </article>
        <article className="passed">
          <strong>Credential Rotation</strong>
          <span>{String(security?.credentialRotation ?? "supported")}</span>
        </article>
        <article className="passed">
          <strong>Project Grants</strong>
          <span>{selectedProjectId || "未选择项目"}</span>
        </article>
      </div>

      <div className="connector-grid">
        <label>
          授权主体
          <input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
        <label>
          项目角色
          <select value={role} onChange={(event) => setRole(event.target.value as ProjectGrant["role"])}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="owner">owner</option>
          </select>
        </label>
      </div>
      <button type="button" disabled={!selectedProjectId} onClick={() => onCreateGrant({ subject, role })}>
        <ShieldPlus size={15} />
        添加项目授权
      </button>

      <div className="source-list">
        {grants.map((grant) => (
          <article key={grant.id}>
            <strong>{grant.subject}</strong>
            <span>{grant.role} · {grant.tokenKind}</span>
            <p>{grant.scopes.join(", ")}</p>
          </article>
        ))}
        {grants.length === 0 && <p className="empty">暂无项目授权记录。</p>}
      </div>

      <div className="connector-grid">
        <label>
          轮换凭据
          <select value={rotationCredentialId} onChange={(event) => setRotationCredentialId(event.target.value)}>
            <option value="">选择凭据</option>
            {credentials.map((credential) => (
              <option value={credential.id} key={credential.id}>
                {credential.name} · {credential.apiKeyMasked}
              </option>
            ))}
          </select>
        </label>
        <label>
          新 Key
          <input
            type="password"
            value={rotationKey}
            onChange={(event) => setRotationKey(event.target.value)}
            placeholder="只发送到 agent，不进入 UI 持久化"
          />
        </label>
        <label>
          轮换原因
          <input value={rotationReason} onChange={(event) => setRotationReason(event.target.value)} />
        </label>
      </div>
      <button
        type="button"
        disabled={!rotationCredentialId || !rotationKey}
        onClick={() => {
          onRotateCredential(rotationCredentialId, rotationKey, rotationReason);
          setRotationKey("");
        }}
      >
        <RotateCcw size={15} />
        轮换凭据
      </button>

      <div className="credential-list">
        {credentials.slice(0, 4).map((credential) => (
          <article key={credential.id}>
            <div>
              <strong><KeyRound size={13} /> {credential.name}</strong>
              <span>{credential.owner ?? "no owner"} · scopes={(credential.scopes ?? []).join(", ") || "default"}</span>
              <span>lastUsed={credential.lastUsedAt ?? "never"} · rotations={credential.rotationHistory?.length ?? 0}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
