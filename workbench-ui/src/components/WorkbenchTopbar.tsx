import { Activity, Bot, FileSearch, KeyRound, Play, ShieldCheck } from "lucide-react";
import type { Credential, PermissionProfile, RunProjection } from "../types";

interface WorkbenchTopbarProps {
  selectedProjectName: string;
  isOfficialDemo?: boolean;
  planStepCount: number;
  canStartRun: boolean;
  isRunning: boolean;
  activeRunId: string | null;
  activeRun: RunProjection | null;
  permissionProfile: PermissionProfile;
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  topbarUtilityOpen: boolean;
  defaultCredential?: Credential;
  onStartRun: () => void;
  onApprovePlan: () => void;
  onGrantPermissions: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onToggleUtility: () => void;
  onOpenLeftDrawer: () => void;
  onOpenRightDrawer: () => void;
  onOpenCredentials: () => void;
}

export function WorkbenchTopbar({
  selectedProjectName,
  isOfficialDemo = false,
  planStepCount,
  canStartRun,
  isRunning,
  activeRunId,
  activeRun,
  permissionProfile,
  leftDrawerOpen,
  rightDrawerOpen,
  topbarUtilityOpen,
  defaultCredential,
  onStartRun,
  onApprovePlan,
  onGrantPermissions,
  onPause,
  onResume,
  onCancel,
  onToggleUtility,
  onOpenLeftDrawer,
  onOpenRightDrawer,
  onOpenCredentials
}: WorkbenchTopbarProps) {
  const modelDriven = activeRun?.input?.requireModelExecution === true || (isOfficialDemo && !activeRunId);
  const executionModeLabel = modelDriven ? "模型测试" : "规则测试";
  const executionModeDetail = modelDriven
    ? defaultCredential ? "模型调用、浏览器动作和证据均为通过必需条件" : "需要配置模型后才能开始"
    : "使用已确认的规则路径与机器 Oracle";
  return (
    <header className="topbar minimal-topbar">
      <div className="topbar-brand">
        <p className="eyebrow">AI Test Officer</p>
        <h1>测试官工作台</h1>
      </div>
      <div className="topbar-run-summary" aria-label="当前测试任务">
        <span>{executionModeLabel}</span>
        <strong>{selectedProjectName}</strong>
        <small role="status" aria-live="polite" title={executionModeDetail}>
          {planStepCount ? `${planStepCount} 步 · ${executionModeDetail}` : executionModeDetail}
        </small>
      </div>
      <div className="topbar-run-actions">
        <button className="primary" disabled={!canStartRun} onClick={onStartRun} type="button">
          {isRunning ? <Activity size={15} /> : <Play size={15} />}
          {isRunning ? "执行中" : "开始测试"}
        </button>
        {activeRunId ? (
          <>
            {activeRun?.state === "awaiting-plan-approval" ? <button onClick={onApprovePlan} type="button">审批计划</button> : null}
            {activeRun?.state === "awaiting-permission" ? <button disabled={!permissionProfile.browserControl} onClick={onGrantPermissions} type="button">确认权限并执行</button> : null}
            <button disabled={!activeRun || !["queued", "preparing", "running", "collecting", "judging"].includes(activeRun.state)} onClick={onPause} type="button">暂停</button>
            {activeRun?.state === "paused" ? <button onClick={onResume} type="button">恢复</button> : null}
            <button disabled={!activeRun || ["completed", "failed", "blocked", "cancelled"].includes(activeRun.state)} onClick={onCancel} type="button">取消</button>
          </>
        ) : null}
      </div>
      <div className="minimal-topbar-actions">
        <div className="topbar-utility-menu">
          <button className={`ghost-button ${leftDrawerOpen || rightDrawerOpen ? "active" : ""}`} onClick={onToggleUtility} type="button" aria-expanded={topbarUtilityOpen}>
            <FileSearch size={15} />
            配置与证据
          </button>
          {topbarUtilityOpen ? (
            <div className="topbar-utility-popover">
              <button type="button" onClick={onOpenLeftDrawer}>项目与运行配置</button>
              <button type="button" onClick={onOpenRightDrawer}>证据与运行记录</button>
            </div>
          ) : null}
        </div>
        <button
          className="status-pill"
          type="button"
          onClick={onOpenCredentials}
          aria-label={defaultCredential ? `打开 API Key 配置：${defaultCredential.name}` : "打开 API Key 配置"}
          title="打开 API Key 配置"
        >
          <KeyRound size={16} />
          {isOfficialDemo
            ? defaultCredential ? `官方演示 · 模型测试 · ${defaultCredential.model}` : "官方演示 · 需要 API Key"
            : defaultCredential ? `${defaultCredential.name} · ${defaultCredential.model}` : "未配置 API Key"}
        </button>
        <span className={`execution-mode-badge execution-mode-badge--${modelDriven ? "model" : "rules"}`} role="status" aria-label={`执行模式：${executionModeLabel}`} title={executionModeDetail}>
          {modelDriven ? <Bot size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
          {executionModeLabel}
        </span>
      </div>
    </header>
  );
}
