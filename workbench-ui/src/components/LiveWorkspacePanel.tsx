import React from "react";
import { Activity, Code2, RefreshCw } from "lucide-react";
import { SharedBrowserCanvas } from "./SharedBrowserCanvas";
import { WorkbenchSectionBoundary } from "./WorkbenchSectionBoundary";
import { isUserActionableInterrupt } from "../workbenchLogic";
import type { AgentGraphProjection, BrowserSession, RepairFileContent, RepairSession, RepairWorkspaceFile } from "../types";
import type { PagePoint } from "../sharedBrowserGeometry";

const RepairWorkspace = React.lazy(() => import("./MonacoRepairWorkspace")
  .then((module) => ({ default: module.RepairWorkspace })));

interface LiveWorkspacePanelProps {
  centreSurface: "preview" | "code";
  selectedProjectName: string;
  projectPreviewReady: boolean;
  hasSelectedProject: boolean;
  activeRunId: string | null;
  browserSession: BrowserSession | null;
  browserManualInput: string;
  browserControlBusy: boolean;
  previewUrl: string;
  previewRevision: number;
  agentProjection: AgentGraphProjection | null;
  repairWorkspaceOpen: boolean;
  repairSession: RepairSession | null;
  repairBusy: boolean;
  canApplyRepair: boolean;
  onCentreSurfaceChange: (surface: "preview" | "code") => void;
  onOpenCodeWorkspace: () => void;
  onRefreshPreview: () => void;
  onBrowserManualInputChange: (value: string) => void;
  onTypeManualInput: () => void;
  onToggleBrowserControl: () => void;
  onLoadIssue: (message: string | null) => void;
  onInteract: (point: PagePoint) => Promise<void> | void;
  onPressKey: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space") => Promise<void> | void;
  onTypeText: (text: string) => Promise<void> | void;
  onViewportChange: (viewport: { width: number; height: number }) => Promise<void> | void;
  onOpenProjectConfig: () => void;
  onListFiles: (sessionId: string) => Promise<RepairWorkspaceFile[]>;
  onLoadFile: (sessionId: string, filePath: string) => Promise<RepairFileContent>;
  onSaveFile: (file: RepairFileContent, content: string) => Promise<RepairSession>;
  onValidateRepair: (allowNetworkInstall?: boolean) => Promise<RepairSession>;
  onExportRepair: (format: "patch" | "zip") => Promise<{ downloadUrl: string }>;
  onApplyRepair: (confirmHighRisk: boolean) => Promise<RepairSession>;
}

/** Central preview/code surface. Durable state and all privileged work stay in App callbacks. */
export function LiveWorkspacePanel({
  centreSurface, selectedProjectName, projectPreviewReady, hasSelectedProject, activeRunId,
  browserSession, browserManualInput, browserControlBusy, previewUrl, previewRevision,
  agentProjection, repairWorkspaceOpen, repairSession, repairBusy, canApplyRepair,
  onCentreSurfaceChange, onOpenCodeWorkspace, onRefreshPreview,
  onBrowserManualInputChange, onTypeManualInput, onToggleBrowserControl, onLoadIssue,
  onInteract, onPressKey, onTypeText, onViewportChange, onOpenProjectConfig, onListFiles,
  onLoadFile, onSaveFile, onValidateRepair, onExportRepair, onApplyRepair
}: LiveWorkspacePanelProps) {
  const browserSessionEnded = Boolean(browserSession && ["closed", "failed"].includes(browserSession.status));
  const captureStatus = () => {
    const pending = isUserActionableInterrupt(agentProjection?.pendingInterrupt);
    const pendingCredential = pending && agentProjection?.pendingInterrupt?.kind === "credential";
    if (pendingCredential) return "等待你授权使用测试账号";
    if (pending) return "等待你的操作";
    if (!activeRunId) return "项目已加载 · 等待开始测试";
    if (!browserSession) return "测试准备中 · 当前页面保持可用";
    if (browserSession.status === "closed") return "本次测试最后画面";
    if (browserSession.status === "failed") return "浏览器会话已结束 · 保留最后画面";
    return browserSession.owner === "user" ? "用户控制中" : "AI 正在真实操作";
  };

  return <section className="live-view simple-live-view" aria-label="项目工作区">
    <header className="live-view-toolbar">
      <div className="live-view-window-dots" aria-hidden="true"><span /><span /><span /></div>
      <div className="centre-surface-switch" role="tablist" aria-label="中央工作区模式">
        <button type="button" role="tab" aria-selected={centreSurface === "preview"} className={centreSurface === "preview" ? "active" : ""} onClick={() => onCentreSurfaceChange("preview")}>预览</button>
        <button type="button" role="tab" aria-selected={centreSurface === "code"} className={centreSurface === "code" ? "active" : ""} onClick={onOpenCodeWorkspace}><Code2 size={14} />代码</button>
      </div>
      <span className="live-view-mode">{centreSurface === "code" ? "项目代码（沙盒副本）" : projectPreviewReady || activeRunId ? "项目浏览器现场" : "沙盒测试现场"}</span>
      {centreSurface === "preview" ? <code title={browserSession?.currentUrl ?? previewUrl}>{(browserSession?.currentUrl ?? previewUrl) || "尚未启动项目"}</code> : <code>{selectedProjectName || "未选择项目"}</code>}
      {centreSurface === "preview" && !browserSession && projectPreviewReady && (
        <button type="button" onClick={onRefreshPreview} aria-label="刷新项目预览"><RefreshCw size={14} />刷新</button>
      )}
      {centreSurface === "preview" && activeRunId && browserSession && !browserSessionEnded ? (
        <div className="shared-browser-controls">
          <span>{browserSession.owner === "user" ? "你正在操作" : "AI 正在操作"}</span>
          {browserSession.owner === "user" ? <>
            <input value={browserManualInput} onChange={(event) => onBrowserManualInputChange(event.target.value)} placeholder="点击画面中的输入框后，在这里输入" aria-label="共享浏览器输入" />
            <button type="button" disabled={!browserManualInput} onClick={onTypeManualInput}>输入</button>
          </> : null}
          <button type="button" disabled={browserControlBusy} onClick={onToggleBrowserControl}>
            {browserControlBusy ? "切换中…" : browserSession.owner === "user" ? "交还 AI" : "接管页面"}
          </button>
        </div>
      ) : null}
    </header>
    {centreSurface === "code" ? (
      repairWorkspaceOpen && repairSession ? (
        <React.Suspense fallback={<div className="live-view-placeholder code-workspace-loading" role="status" aria-live="polite"><div className="live-view-dots"><span /><span /><span /></div><p>正在按需载入代码编辑器…</p></div>}>
          <RepairWorkspace
            session={repairSession}
            embedded
            canApply={canApplyRepair}
            onListFiles={() => onListFiles(repairSession.id)}
            onLoadFile={(filePath) => onLoadFile(repairSession.id, filePath)}
            onSaveFile={onSaveFile}
            onValidate={onValidateRepair}
            onExport={onExportRepair}
            onApply={onApplyRepair}
            onClose={() => onCentreSurfaceChange("preview")}
          />
        </React.Suspense>
      ) : <div className="live-view-placeholder code-workspace-loading"><div className="live-view-dots"><span /><span /><span /></div><p>{repairBusy ? "正在载入项目代码…" : "选择项目后即可在这里查看受控代码副本。"}</p></div>
    ) : projectPreviewReady || activeRunId ? (
      <div className={`live-view-content shared-browser-view ${browserSession?.owner === "user" ? "user-controlled" : "agent-controlled"} ${browserSessionEnded ? "session-ended" : ""}`}>
        <WorkbenchSectionBoundary label="实时浏览器">
          <SharedBrowserCanvas
            runId={activeRunId ?? undefined}
            session={browserSession}
            fallbackUrl={projectPreviewReady ? previewUrl : undefined}
            refreshRevision={previewRevision}
            onLoadIssue={onLoadIssue}
            onInteract={onInteract}
            onPressKey={onPressKey}
            onTypeText={onTypeText}
            onViewportChange={onViewportChange}
          />
        </WorkbenchSectionBoundary>
        <span className={`live-capture-badge ${browserSession?.owner === "user" || isUserActionableInterrupt(agentProjection?.pendingInterrupt) || !browserSession ? "waiting" : ""}`}><Activity size={13} /> {captureStatus()}</span>
      </div>
    ) : (
      <div className="live-view-placeholder">
        <div className="live-view-grid" />
        {hasSelectedProject ? <><div className="live-view-scanner" /><div className="live-view-dots"><span /><span /><span /></div><p>启动并检查项目后，这里会显示测试页面</p></> : (
          <div className="live-view-project-setup" aria-label="配置测试项目"><strong>先配置要测试的项目</strong><p>选择本地项目后，系统会在沙盒中识别、启动并显示测试页面。</p><button className="primary" type="button" onClick={onOpenProjectConfig}>点击配置</button></div>
        )}
      </div>
    )}
  </section>;
}
