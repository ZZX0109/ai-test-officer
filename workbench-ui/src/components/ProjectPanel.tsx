import type { ProjectConfig, ProjectHealthCheckResult, ProjectRuntimeStatus } from "../types";

interface ProjectPanelProps {
  projects: ProjectConfig[];
  selectedProjectId: string;
  draft: ProjectConfig | null;
  status?: ProjectRuntimeStatus | null;
  connection?: ProjectHealthCheckResult | null;
  onSelect: (id: string) => void;
  onDraftChange: (draft: ProjectConfig) => void;
  onSave: () => void;
  onTest: () => void;
  onStart: () => void;
  onStop: () => void;
}

export function ProjectPanel({
  projects,
  selectedProjectId,
  draft,
  status,
  connection,
  onSelect,
  onDraftChange,
  onSave,
  onTest,
  onStart,
  onStop
}: ProjectPanelProps) {
  if (!draft) {
    return (
      <section className="project-box">
        <h3>Target Project</h3>
        <p className="empty">未加载项目配置。</p>
      </section>
    );
  }

  const update = (patch: Partial<ProjectConfig>) => onDraftChange({ ...draft, ...patch });
  const login = draft.login ?? { method: "none" as const };
  const updateLogin = (patch: Partial<NonNullable<ProjectConfig["login"]>>) => update({
    login: {
      ...login,
      ...patch,
      method: patch.method ?? login.method
    }
  });

  return (
    <section className="project-box">
      <h3>Target Project</h3>
      <label>
        选择项目
        <select value={selectedProjectId} onChange={(event) => onSelect(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      <div className="connector-grid">
        <label>
          Project ID
          <input value={draft.id} onChange={(event) => update({ id: event.target.value })} />
        </label>
        <label>
          名称
          <input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
        </label>
        <label>
          项目路径
          <input value={draft.projectPath} onChange={(event) => update({ projectPath: event.target.value })} />
        </label>
        <label>
          安装命令
          <input value={draft.installCommand ?? ""} onChange={(event) => update({ installCommand: event.target.value })} />
        </label>
        <label className="checkbox-row">
          <input
            checked={Boolean(draft.allowExternalProjectPath)}
            onChange={(event) => update({ allowExternalProjectPath: event.target.checked })}
            type="checkbox"
          />
          允许外部绝对路径
        </label>
        <label>
          启动命令
          <input value={draft.startCommand ?? ""} onChange={(event) => update({ startCommand: event.target.value })} />
        </label>
        <label>
          健康检查 URL
          <input value={draft.healthCheckUrl ?? ""} onChange={(event) => update({ healthCheckUrl: event.target.value })} />
        </label>
        <label>
          前端地址
          <input value={draft.frontendUrl} onChange={(event) => update({ frontendUrl: event.target.value })} />
        </label>
        <label>
          后端地址
          <input value={draft.backendUrl ?? ""} onChange={(event) => update({ backendUrl: event.target.value })} />
        </label>
        <label>
          超时 ms
          <input
            value={draft.timeoutMs ?? 20000}
            onChange={(event) => update({ timeoutMs: Number(event.target.value) || 20000 })}
          />
        </label>
        <label>
          登录方式
          <select
            value={login.method}
            onChange={(event) => updateLogin({ method: event.target.value as NonNullable<ProjectConfig["login"]>["method"] })}
          >
            <option value="none">none</option>
            <option value="form">form</option>
            <option value="env">env</option>
            <option value="storage_state">storage_state</option>
          </select>
        </label>
        <label>
          登录 URL
          <input value={login.loginUrl ?? ""} onChange={(event) => updateLogin({ loginUrl: event.target.value || undefined })} />
        </label>
        <label>
          用户名环境变量
          <input value={login.usernameEnv ?? ""} onChange={(event) => updateLogin({ usernameEnv: event.target.value || undefined })} placeholder="E2E_USERNAME" />
        </label>
        <label>
          密码环境变量
          <input value={login.passwordEnv ?? ""} onChange={(event) => updateLogin({ passwordEnv: event.target.value || undefined })} placeholder="E2E_PASSWORD" />
        </label>
        <label>
          Credential ID
          <input value={login.credentialId ?? ""} onChange={(event) => updateLogin({ credentialId: event.target.value || undefined })} placeholder="cred_..." />
        </label>
      </div>
      <div className="form-actions">
        <button type="button" onClick={onSave}>保存配置</button>
        <button type="button" onClick={onTest}>测试连接</button>
        <button type="button" onClick={onStart}>启动</button>
        <button type="button" onClick={onStop}>停止</button>
      </div>
      <div className="connector-status">
        <span>{status?.status ?? "idle"}</span>
        <p>{status?.message ?? connection?.message ?? "Project Adapter 会按配置启动项目并检查健康状态。"}</p>
      </div>
      {draft.processes?.length ? (
        <article className="source-card">
          <strong>Configured Processes</strong>
          {draft.processes.map((process) => (
            <p key={process.name}>
              <code>{process.name}</code> · {process.required === false ? "optional" : "required"} · {process.healthCheckUrl ?? "no health URL"}
            </p>
          ))}
        </article>
      ) : null}
      {status?.processes?.length ? (
        <article className="source-card">
          <strong>Runtime Processes</strong>
          {status.processes.map((process) => (
            <p key={process.name}>
              <code>{process.name}</code> · {process.status} · pid={process.pid ?? "n/a"} · {process.message}
            </p>
          ))}
        </article>
      ) : null}
      {connection && (
        <article className={connection.ok ? "passed" : "failed"}>
          <strong>{connection.ok ? "连接正常" : `连接失败：${connection.reason}`}</strong>
          <p>{connection.durationMs}ms · frontend={connection.frontend?.ok ? "ok" : "fail"} · backend={connection.backend?.ok ? "ok" : "n/a"}</p>
          <p>credential={connection.credential.ok ? "ok" : `missing ${connection.credential.missingEnv.join(", ")}`} · method={connection.credential.method}</p>
          {connection.processHealth?.length ? (
            <p>process={connection.processHealth.map((item) => `${item.name}:${item.ok ? "ok" : "fail"}`).join(", ")}</p>
          ) : null}
        </article>
      )}
    </section>
  );
}
