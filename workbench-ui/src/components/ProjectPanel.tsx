import { Info, LoaderCircle, Stethoscope } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectConfig, ProjectDetectionResult, ProjectDiagnosis, ProjectHealthCheckResult, ProjectRuntimeStatus, RuntimeRecoveryAdvice } from "../types";

interface ProjectPanelProps {
  projects: ProjectConfig[];
  selectedProjectId: string;
  draft: ProjectConfig | null;
  detection?: ProjectDetectionResult | null;
  diagnosis?: ProjectDiagnosis | null;
  status?: ProjectRuntimeStatus | null;
  connection?: ProjectHealthCheckResult | null;
  launchPhase?: string;
  recoveryAdvice?: RuntimeRecoveryAdvice | null;
  revealLoginSettings?: boolean;
  onSelect: (id: string) => void;
  onDraftChange: (draft: ProjectConfig) => void;
  onRunDiagnosis: () => Promise<void>;
  onStop: () => void;
  onApplyRecoveryCandidate?: (candidateId: string) => void;
  onSaveLoginCredential: (input: {
    username: string;
    password: string;
    usernameEnv: string;
    passwordEnv: string;
  }) => Promise<void>;
}

export function ProjectPanel({
  projects,
  selectedProjectId,
  draft,
  detection,
  diagnosis,
  status,
  connection,
  launchPhase,
  recoveryAdvice,
  revealLoginSettings = false,
  onSelect,
  onDraftChange,
  onRunDiagnosis,
  onStop,
  onApplyRecoveryCandidate,
  onSaveLoginCredential
}: ProjectPanelProps) {
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [savingLogin, setSavingLogin] = useState(false);
  const [startRequested, setStartRequested] = useState(false);
  const [hasSeenLaunchPhase, setHasSeenLaunchPhase] = useState(false);
  const [loginSaveMessage, setLoginSaveMessage] = useState("");
  const [loginSettingsOpen, setLoginSettingsOpen] = useState(false);
  const [, setClockTick] = useState(0);
  useEffect(() => {
    setLoginUsername("");
    setLoginPassword("");
    setLoginSaveMessage("");
    setLoginSettingsOpen(false);
  }, [draft?.id]);
  useEffect(() => {
    if (revealLoginSettings) setLoginSettingsOpen(true);
  }, [revealLoginSettings]);
  useEffect(() => {
    if (launchPhase) setHasSeenLaunchPhase(true);
    if (hasSeenLaunchPhase && !launchPhase && status?.status !== "installing" && status?.status !== "starting") {
      setStartRequested(false);
      setHasSeenLaunchPhase(false);
    }
  }, [hasSeenLaunchPhase, launchPhase, status?.status]);
  useEffect(() => {
    if (status?.status !== "installing" && status?.status !== "starting") return;
    const timer = window.setInterval(() => setClockTick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [status?.status]);

  if (!draft) {
    return (
      <section className="project-box">
        <h3>Target Project</h3>
        <p className="empty">未加载项目配置。</p>
      </section>
    );
  }

  const update = (patch: Partial<ProjectConfig>) => onDraftChange({ ...draft, ...patch });
  const systemProjectIds = new Set([
    "customer_portal_lite",
    "investment_agent_workflow_external",
    "local_demo_app",
    "order_portal_lite",
    "todo_lite"
  ]);
  const systemProjects = projects.filter((project) => systemProjectIds.has(project.id));
  const login = draft.login ?? { method: "none" as const };
  const runtimeFailureMessages: Record<string, string> = {
    config_missing: "项目运行配置不存在，请重新识别并保存项目。",
    project_path_missing: "项目文件夹已移动、删除或不可访问，请重新选择项目。",
    install_failed: "依赖安装命令执行失败，请查看运行详情中的安装错误。",
    start_failed: "启动命令无法执行，系统会保留日志用于进一步诊断。",
    command_not_found: "启动所需命令不存在，请先安装对应的 Node、Python 或包管理工具。",
    dependency_missing: "项目依赖不完整，请重新安装依赖后再启动。",
    port_conflict: "目标端口已被其他进程占用。系统不会覆盖非本项目进程，请更换端口或关闭冲突程序。",
    early_exit: "项目进程启动后立即退出，通常是配置、依赖或运行时错误。",
    health_timeout: "项目进程已启动，但检查地址在等待时间内没有响应。请核对实际端口、host 和健康检查路径。",
    frontend_unreachable: "前端地址无法访问，请核对 dev server 监听地址和端口。",
    backend_unreachable: "后端健康检查无法访问，请确认 API 服务是否需要单独启动。",
    credential_missing: "项目需要登录测试账号，但所需测试凭据尚未配置。",
    permission_denied: "系统或沙盒拒绝了启动权限。macOS 原生依赖被拦截时可重新安装依赖后再试。",
    container_runtime_unavailable: "安全沙盒服务尚未就绪。macOS 本地运行时系统会自动启动 Docker Desktop；仅在未安装或启动超时时才需要手动处理。",
    budget_exceeded: "依赖安装或启动超过了项目资源预算，已安全终止。",
    cleanup_failed: "项目进程已停止，但清理命令失败，请查看残留进程和日志。",
    cancelled: "本次启动已被取消，相关进程正在清理。",
    unknown: "系统暂时无法从确定性信号判断失败原因，可使用已配置的 AI 模型分析脱敏日志并生成受控建议。"
  };
  const runtimeFailureMessage = status?.failureReason ? runtimeFailureMessages[status.failureReason] : undefined;
  const containerRuntimeUnavailable = status?.failureReason === "container_runtime_unavailable"
    || /failed to connect to the docker api|docker\.sock|docker daemon/i.test(status?.message ?? "");
  const showLoginSettings = detection?.loginCapability?.detected || login.method !== "none" || revealLoginSettings;
  const sandboxMode = draft.allowExternalProjectPath ? "oci" : (draft.manifest?.execution.mode ?? "trusted-local");
  const isPreparing = startRequested || Boolean(launchPhase) || status?.status === "installing" || status?.status === "starting";
  const remainingMs = status?.deadlineAt
    ? Math.max(0, Date.parse(status.deadlineAt) - Date.now())
    : status?.remainingMs;
  const remainingSeconds = remainingMs === undefined ? undefined : Math.ceil(remainingMs / 1000);
  const runtimePhaseLabel = status?.phase === "installing_dependencies"
    ? "正在安装依赖"
    : status?.phase === "starting_processes"
      ? "正在创建项目进程"
      : status?.phase === "waiting_for_health"
        ? "正在等待项目地址响应"
    : launchPhase
      ? "正在准备启动项目"
      : status?.status === "starting"
          ? "正在启动项目"
          : status?.status === "installing"
            ? "正在安装项目依赖"
            : "";
  const showRunResult = Boolean(
    diagnosis ||
    connection ||
    (status && status.status !== "idle") || Boolean(launchPhase) || startRequested
  );
  const runReady = status?.status === "running" && connection?.ok && diagnosis?.overallStatus === "passed";
  const runTitle = isPreparing
    ? status?.status === "installing" ? "正在安装项目依赖" : "正在启动项目"
    : runReady
      ? "项目已准备好测试"
      : status?.status === "failed" || connection?.ok === false || diagnosis?.overallStatus === "failed"
        ? "项目暂时无法运行测试"
        : status?.status === "running"
          ? "项目正在运行"
          : "诊断已完成";

  return (
    <section className="project-box">
      <h3>Target Project</h3>
      <p className="project-panel-hint">自动识别结果保持只读；下方推荐运行设置可以按项目实际情况调整。</p>

      <section className="detected-project-summary" aria-label="自动识别结果">
        <header>
          <div>
            <span>自动识别</span>
            <strong>{draft.name}</strong>
          </div>
          <span className="detected-project-summary__status">{detection?.executionReady === false ? "等待运行路径" : "已识别"}</span>
        </header>
        <dl>
          <div>
            <dt>项目路径</dt>
            <dd title={draft.projectPath}>{draft.projectPath}</dd>
          </div>
          <div>
            <dt>项目标识</dt>
            <dd>{draft.id}</dd>
          </div>
          <div>
            <dt>技术栈</dt>
            <dd>{detection?.detectedStack.filter((item) => item !== "unknown").join(" · ") || "本次扫描未识别"}</dd>
          </div>
          <div>
            <dt>依赖安装工具</dt>
            <dd>{detection?.packageManagers.join(" · ") || "本次扫描未识别或无需安装"}</dd>
          </div>
          <div>
            <dt>路径类型</dt>
            <dd>{draft.allowExternalProjectPath ? "本地外部项目" : "工作区项目"}</dd>
          </div>
          <div>
            <dt>运行隔离</dt>
            <dd>{sandboxMode === "oci" ? "安全沙盒（Docker）" : "直接在本机运行"}</dd>
          </div>
        </dl>
      </section>

      {systemProjects.length ? (
        <details className="project-login-settings system-projects">
          <summary>系统示例项目（自动测试使用，共 {systemProjects.length} 个）</summary>
          <p className="project-panel-hint">这些项目随系统提供，用于 Demo、Benchmark 和回归测试，不是你上传的项目。</p>
          <div className="system-project-list">
            {systemProjects.map((project) => (
              <button key={project.id} type="button" onClick={() => onSelect(project.id)}>
                <strong>{project.name}</strong>
                <span>{project.projectPath}</span>
              </button>
            ))}
          </div>
        </details>
      ) : null}

      <div className="project-settings-heading">
        <strong>推荐运行设置</strong>
        <span>只显示适用于当前项目的设置；这些建议可以修改</span>
      </div>
      <div className="connector-grid">
        {draft.manifest || draft.allowExternalProjectPath ? (
          <label>
            运行方式
            <input value="安全沙盒（OCI） + Workbench 内置浏览器" readOnly />
            <span className="field-help">
              源码只读挂载到 {draft.manifest?.execution.image ?? "node:22-bookworm-slim"}；依赖按锁文件指纹缓存，未变更时直接复用；项目只在 Workbench 内置浏览器中打开。
            </span>
          </label>
        ) : null}
        {detection?.executionReady === false ? (
          <label>
            项目完整路径
            <input value={draft.projectPath} onChange={(event) => update({ projectPath: event.target.value })} placeholder="/Users/name/path/to/project" />
          </label>
        ) : null}
        {draft.installCommand ? (
          <label>
            安装依赖
            <input value={draft.installCommand} onChange={(event) => update({ installCommand: event.target.value })} />
          </label>
        ) : null}
        {!draft.processes?.length ? (
          <label>
            启动项目
            <input value={draft.startCommand ?? ""} onChange={(event) => update({ startCommand: event.target.value })} placeholder="系统未识别，请填写启动命令" />
          </label>
        ) : null}
        <label>
          健康检查 URL
          <input value={draft.healthCheckUrl ?? ""} onChange={(event) => update({ healthCheckUrl: event.target.value })} />
        </label>
        <label>
          前端地址
          <input value={draft.frontendUrl} onChange={(event) => update({ frontendUrl: event.target.value })} />
        </label>
        {draft.backendUrl ? (
          <label>
            后端地址
            <input value={draft.backendUrl} onChange={(event) => update({ backendUrl: event.target.value })} />
          </label>
        ) : null}
        <label>
          启动等待时间（毫秒）
          <input
            value={draft.timeoutMs ?? 20000}
            onChange={(event) => update({ timeoutMs: Number(event.target.value) || 20000 })}
          />
          <span className="field-help">启动项目后最多等待多久。30000 表示 30 秒，不是测试执行时长。</span>
        </label>
      </div>
      {draft.processes?.length ? (
        <div className="detected-run-command">
          <strong>启动方式</strong>
          {draft.processes.map((process) => (
            <div key={process.name}>
              <code>{process.command}</code>
              {process.healthCheckUrl ? <span>启动后检查 {process.healthCheckUrl}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {showLoginSettings ? <details
        id="project-login-settings"
        className="project-login-settings"
        open={loginSettingsOpen}
        onToggle={(event) => setLoginSettingsOpen(event.currentTarget.open)}
      >
        <summary>登录与测试账号（需要登录时配置）</summary>
        <p className="project-login-explanation">
          系统只识别登录功能和配置名称，不读取项目中的明文密码。这里填写的账号会加密保存，并仅在测试启动时注入沙盒。
        </p>
        <div className="connector-grid">
          <label>
            测试账号
            <input
              autoComplete="off"
              value={loginUsername}
              onChange={(event) => setLoginUsername(event.target.value)}
              placeholder="邮箱或用户名"
            />
          </label>
          <label>
            测试密码
            <input
              type="password"
              autoComplete="new-password"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              placeholder={login.credentialId ? "已配置；留空不会修改" : "输入测试密码"}
            />
          </label>
        </div>
        <button
          type="button"
          className="secondary project-login-save"
          disabled={!loginUsername.trim() || !loginPassword || savingLogin}
          onClick={async () => {
            setSavingLogin(true);
            setLoginSaveMessage("");
            try {
              await onSaveLoginCredential({
                username: loginUsername.trim(),
                password: loginPassword,
                usernameEnv: login.usernameEnv ?? detection?.loginCapability?.usernameEnv ?? "E2E_USERNAME",
                passwordEnv: login.passwordEnv ?? detection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD"
              });
              setLoginPassword("");
              setLoginSaveMessage("测试账号已加密保存，运行时会自动注入沙盒。");
            } catch (error) {
              setLoginSaveMessage(error instanceof Error ? error.message : "测试账号保存失败。");
            } finally {
              setSavingLogin(false);
            }
          }}
        >
          {savingLogin ? "正在保存…" : login.credentialId ? "更新测试账号" : "保存测试账号"}
        </button>
        {loginSaveMessage ? <p className="project-login-save-message">{loginSaveMessage}</p> : null}
        <details className="wizard-details project-login-advanced">
          <summary>查看系统识别的登录配置</summary>
          <p>账号变量：{login.usernameEnv ?? detection?.loginCapability?.usernameEnv ?? "E2E_USERNAME"}</p>
          <p>密码变量：{login.passwordEnv ?? detection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD"}</p>
          <p>凭据状态：{login.credentialId ? "已加密配置" : "尚未配置"}</p>
        </details>
      </details> : null}
      <div className="form-actions project-primary-actions">
        <button className="primary" type="button" onClick={async () => {
          setStartRequested(true);
          setHasSeenLaunchPhase(false);
          try {
            await onRunDiagnosis();
          } finally {
            setStartRequested(false);
          }
        }} disabled={isPreparing} aria-busy={isPreparing}>
          {isPreparing ? <LoaderCircle className="spin" size={15} /> : <Stethoscope size={15} />}
          {isPreparing ? "正在启动…" : "诊断并运行"}
        </button>
      </div>
      {showRunResult ? (
        <article className={`project-run-result ${runReady ? "passed" : status?.status === "failed" || connection?.ok === false ? "failed" : "warning"}`}>
          <header>
            <div>
              <strong>{runTitle}</strong>
              <p>{runReady
                ? "启动、连接和运行条件检查均已通过。"
                : runtimeFailureMessage ?? (isPreparing ? (launchPhase || "系统会自动完成安装、启动和连接检查。") : "请根据下面的提示处理后重新诊断。")}</p>
            </div>
            <span>{runReady ? "可测试" : isPreparing ? "处理中" : "需处理"}</span>
          </header>
          {isPreparing ? (
            <div className="runtime-progress" role="status" aria-live="polite">
              <div className="runtime-progress__labels">
                <strong>{launchPhase || runtimePhaseLabel || "正在连接 Agent"}</strong>
                <span>{remainingSeconds !== undefined ? `最多还需约 ${remainingSeconds} 秒` : "正在获取进度"}</span>
              </div>
              <div className="runtime-progress__track" aria-hidden="true">
                <span style={{ width: `${Math.max(4, status?.progressPercent ?? 4)}%` }} />
              </div>
              <p>{status?.status === "installing"
                ? `首次准备隔离依赖，已等待 ${Math.max(0, Math.floor((status?.elapsedMs ?? 0) / 1000))} 秒；完成后相同依赖环境会直接复用。`
                : `已经等待 ${Math.max(0, Math.floor((status?.elapsedMs ?? 0) / 1000))} 秒；如果项目提前就绪，会立即进入下一步。`}</p>
            </div>
          ) : null}
          {recoveryAdvice && !runReady ? <section className={`runtime-ai-advice ${recoveryAdvice.status}`} aria-live="polite">
            <strong>AI 启动诊断</strong>
            {recoveryAdvice.status === "passed" ? <>
              <p>{recoveryAdvice.summary}</p>
              <span>判断：{recoveryAdvice.failureClass ?? "unknown"} · 模型：{recoveryAdvice.model ?? "已配置模型"}</span>
              {recoveryAdvice.selectedCandidateId && status?.failureReason !== "budget_exceeded" ? <div className="runtime-ai-advice__action">
                <p>可尝试：{recoveryAdvice.candidates.find((item) => item.id === recoveryAdvice.selectedCandidateId)?.label ?? "已验证候选启动方式"}</p>
                <button type="button" className="secondary" onClick={() => onApplyRecoveryCandidate?.(recoveryAdvice.selectedCandidateId!)} disabled={!onApplyRecoveryCandidate}>
                  采用 AI 建议并重试
                </button>
              </div> : null}
            </> : recoveryAdvice.status === "not_configured" ? <p>未配置可用 AI 模型，已保留确定性诊断结果。</p> : <p>AI 诊断未完成；不会影响上方的确定性失败结论。</p>}
          </section> : null}
          {containerRuntimeUnavailable && !runReady && draft.allowExternalProjectPath ? <section className="runtime-local-fallback">
            <strong>沙盒服务未运行</strong>
            <p>系统已尝试自动启动 Docker Desktop。若仍停在这里，请确认 Docker Desktop 已安装且没有权限弹窗；系统不会退回本机直接启动。</p>
          </section> : null}
          {diagnosis && !runtimeFailureMessage ? <div className="diagnosis-summary">
            {diagnosis.stages.filter((stage) => stage.status !== "passed" && stage.status !== "skipped").map((stage) => (
              <div className="diagnosis-step" key={stage.stage}>
                <strong>{stage.humanMessage}</strong>
                {stage.missingEnv?.length ? <p>还需要填写：{stage.missingEnv.join(", ")}</p> : null}
                {stage.portConflicts?.map((conflict) => <p key={`${stage.stage}-${conflict.port}`}>端口 {conflict.port}：{conflict.fix}</p>)}
              </div>
            ))}
          </div> : null}
          {status?.status === "running" && status.pid ? <button className="text-button" type="button" onClick={onStop}>停止项目</button> : null}
          {status?.status === "running" && !status.pid ? (
            <p className="runtime-adopted-note">
              {sandboxMode === "oci"
                ? "项目已在系统沙盒中运行。测试官会使用沙盒分配的地址，关闭页面不会中断运行。"
                : "检测到项目已经在本机运行。测试官已连接该地址，但不会停止不属于本次启动的进程。"}
            </p>
          ) : null}
          <details className="wizard-details">
            <summary><Info size={14} /> 查看运行详情</summary>
            {status?.message ? <p className="runtime-error-detail">{status.message}</p> : null}
            {connection ? (
              <div className="connection-detail-list">
                <p>前端：{connection.frontend?.ok ? "正常" : "无响应"}</p>
                <p>后端：{connection.backend?.ok ? "正常" : connection.backend ? "无响应" : "不适用"}</p>
                <p>登录：{connection.credential.ok ? "正常" : `缺少 ${connection.credential.missingEnv.join(", ")}`}</p>
              </div>
            ) : null}
            {diagnosis?.stages.map((stage) => (
              <div className="diagnosis-step" key={stage.stage}>
                <strong>{stage.stage} · {stage.status}</strong>
                <p>{stage.humanMessage}</p>
                {stage.missingEnv?.length ? <code>缺少环境变量：{stage.missingEnv.join(", ")}</code> : null}
                {stage.portConflicts?.map((conflict) => <code key={`${stage.stage}-${conflict.port}`}>端口 {conflict.port}：{conflict.fix}</code>)}
                {stage.suggestedCommands.length ? <code>{stage.suggestedCommands.join(" && ")}</code> : null}
              </div>
            ))}
          </details>
        </article>
      ) : null}
    </section>
  );
}
