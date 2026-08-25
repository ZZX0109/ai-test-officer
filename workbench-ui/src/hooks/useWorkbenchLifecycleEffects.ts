import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { initializeOidc } from "../auth";
import {
  forgetProjectActiveRun,
  isRestorableProjectRun,
  rankProjectRunCandidates,
  readProjectActiveRun,
  rememberProjectActiveRun
} from "../activeRunCache";
import {
  diagnoseProject,
  getProjectRuntime,
  getRunAgent,
  getRunBrowserSession,
  getRunEvidence,
  getRunKnowledge,
  getRunProjection,
  listProjects,
  subscribeRunEvents,
  testProjectConnection,
  waitForAgentReady,
  waitForRunReport
} from "../api";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";
import { writeProjectHistoryCache } from "../projectHistoryCache";
import { upsertAssistantProgress } from "../workbenchLogic";
import type {
  AgentGraphProjection,
  BrowserSession,
  LiveRunState,
  PlanningMessage,
  ProjectConfig,
  ProjectDiagnosis,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus,
  RunProjection,
  RunResult
} from "../types";
import type { AutomationFailure } from "./useConfirmedScenarioExecution";

type MutableSetRef = { current: Set<string> };
type RestoreEpochRef = { current: number };

interface WorkbenchLifecycleEffectsInput {
  refresh: (includeSecondaryData?: boolean) => Promise<void>;
  projectListNotice: string;
  projects: ProjectConfig[];
  selectedProjectId: string;
  projectConnection: ProjectHealthCheckResult | null;
  projectDiagnosis: ProjectDiagnosis | null;
  projectDraft: ProjectConfig | null;
  activeRunId: string | null;
  activeRun: RunProjection | null;
  planningConfirmed: boolean;
  result: RunResult | null;
  planningResultId?: string;
  planningAutomation: PlanningAutomationPresentation;
  authFeedbackRequired: boolean;
  credentialReadyForRetry: boolean;
  apiCredentialFeedbackRequired: boolean;
  screenshotRateLimited: boolean;
  runAssistantMessage: string;
  missingProjectApiCredentials: Array<NonNullable<ProjectConfig["apiCredentialRequirements"]>[number]>;
  sidebarResizeRef: { current: { startX: number; startWidth: number; width: number } | null };
  workspaceRef: RefObject<HTMLElement | null>;
  activeRunRestoreEpochRef: RestoreEpochRef;
  hydratedAgentThreads: MutableSetRef;
  hydratedRunReports: MutableSetRef;
  surfacedAssistantNotices: MutableSetRef;
  setProjectListNotice: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  setProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setProjectDraft: Dispatch<SetStateAction<ProjectConfig | null>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setProjectConnection: Dispatch<SetStateAction<ProjectHealthCheckResult | null>>;
  setProjectDiagnosis: Dispatch<SetStateAction<ProjectDiagnosis | null>>;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setBrowserSession: Dispatch<SetStateAction<BrowserSession | null>>;
  setBrowserFrameRevision: Dispatch<SetStateAction<number>>;
  setAgentProjection: Dispatch<SetStateAction<AgentGraphProjection | null>>;
  setInterruptError: Dispatch<SetStateAction<string | null>>;
  setLiveRun: Dispatch<SetStateAction<LiveRunState | null>>;
  setActiveRun: Dispatch<SetStateAction<RunProjection | null>>;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setAutomationFailures: Dispatch<SetStateAction<AutomationFailure[]>>;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
  setCentreSurface: Dispatch<SetStateAction<"preview" | "code">>;
  setPlanningSummaryCollapsed: Dispatch<SetStateAction<boolean>>;
}

/** Keeps durable service state synchronized without mixing it into page rendering. */
export function useWorkbenchLifecycleEffects(input: WorkbenchLifecycleEffectsInput) {
  useEffect(() => {
    initializeOidc()
      .then(async (session) => {
        if (session.configured && !session.authenticated) return;
        input.setProjectListNotice("正在连接 AI 测试服务…");
        await waitForAgentReady();
        await input.refresh(false);
      })
      .catch((error) => {
        input.setProjectListNotice("AI 测试服务暂时不可用，正在自动重连。");
        input.setMessage(error instanceof Error ? error.message : "AI 测试服务暂时不可用。");
      });
  }, []);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem("ato:planning-sidebar-width"));
    if (Number.isFinite(stored) && stored >= 280 && stored <= 520) input.setSidebarWidth(stored);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const resize = input.sidebarResizeRef.current;
      if (!resize) return;
      const width = Math.max(280, Math.min(520, resize.startWidth + event.clientX - resize.startX));
      resize.width = width;
      input.workspaceRef.current?.style.setProperty("--planning-sidebar-width", `${width}px`);
    };
    const stop = () => {
      const resize = input.sidebarResizeRef.current;
      if (!resize) return;
      input.sidebarResizeRef.current = null;
      input.setSidebarWidth(resize.width);
      window.localStorage.setItem("ato:planning-sidebar-width", String(Math.round(resize.width)));
      document.body.classList.remove("is-resizing-planning-sidebar");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing-planning-sidebar");
    };
  }, []);

  useEffect(() => {
    if (!input.projectListNotice.includes("暂时") && !input.projectListNotice.includes("正在连接")) return;
    const interval = window.setInterval(() => {
      void listProjects()
        .then((data) => {
          writeProjectHistoryCache(data.projects);
          input.setProjects(data.projects);
          input.setProjectListNotice(data.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
          input.setMessage("AI 测试服务已恢复连接。");
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [input.projectListNotice]);

  useEffect(() => {
    if (!input.selectedProjectId) return;
    const savedProject = input.projects.find((project) => project.id === input.selectedProjectId);
    if (!savedProject) return;
    input.setProjectDraft((current) => {
      if (!current || current.id !== savedProject.id) return current;
      const currentUpdatedAt = Date.parse(current.updatedAt ?? "");
      const savedUpdatedAt = Date.parse(savedProject.updatedAt ?? "");
      return Number.isFinite(savedUpdatedAt) && savedUpdatedAt > currentUpdatedAt ? savedProject : current;
    });
  }, [input.projects, input.selectedProjectId]);

  useEffect(() => {
    if (!input.selectedProjectId) return;
    let disposed = false;
    const refreshRuntime = async () => {
      const snapshot = await getProjectRuntime(input.selectedProjectId).catch(() => null);
      if (!snapshot || disposed) return;
      input.setProjectRuntime(snapshot.runtime);
      if (snapshot.runtime.status === "running" && (!input.projectConnection?.ok || input.projectDiagnosis?.overallStatus !== "passed")) {
        const [connection, diagnosis] = await Promise.all([
          testProjectConnection(input.selectedProjectId).catch(() => null),
          diagnoseProject(input.selectedProjectId).catch(() => null)
        ]);
        if (!disposed && connection) input.setProjectConnection(connection.result);
        if (!disposed && diagnosis) input.setProjectDiagnosis(diagnosis.diagnosis);
      }
    };
    void refreshRuntime();
    const interval = window.setInterval(() => void refreshRuntime(), 2_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [input.selectedProjectId, input.projectConnection?.ok, input.projectDiagnosis?.overallStatus]);

  useEffect(() => {
    if (!input.activeRunId || input.hydratedAgentThreads.current.has(input.activeRunId)) return;
    const runId = input.activeRunId;
    input.hydratedAgentThreads.current.add(runId);
    void getRunKnowledge(runId)
      .then((snapshot) => {
        const decisions = new Map(snapshot.decisions.map((item) => [item.id, item]));
        const durable = snapshot.messages.map((item): PlanningMessage => {
          const decision = item.knowledgeDecisionId ? decisions.get(item.knowledgeDecisionId) : undefined;
          return {
            id: item.id, role: item.role === "system" ? "assistant" : item.role,
            content: item.content, createdAt: item.createdAt, reasoningSummary: item.reasoningSummary,
            suggestedAction: item.suggestedAction as PlanningMessage["suggestedAction"],
            requiresConfirmation: item.requiresConfirmation, knowledge: decision?.output,
            llmTrace: item.llmCallId ? {
              callId: item.llmCallId, contextId: item.knowledgeContextId,
              decisionId: item.knowledgeDecisionId, validationStatus: decision?.validationStatus
            } : undefined
          };
        });
        if (!durable.length) return;
        input.setPlanningMessages((current) => {
          const ids = new Set(current.map((item) => item.id));
          return [...current, ...durable.filter((item) => !ids.has(item.id))]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        });
      })
      .catch(() => input.hydratedAgentThreads.current.delete(runId));
  }, [input.activeRunId]);

  useEffect(() => {
    if (!input.activeRunId) return;
    const runId = input.activeRunId;
    return subscribeRunEvents(runId, ({ id, type, payload }) => {
      if (type.startsWith("browser.")) {
        if (type.startsWith("browser.session.") || type === "browser.control.changed") {
          const candidate = payload as unknown as BrowserSession;
          if (candidate?.runId === runId && candidate?.sessionId) input.setBrowserSession(candidate);
          else void getRunBrowserSession(runId).then(({ session }) => input.setBrowserSession(session)).catch(() => undefined);
        }
        if (["browser.observation.created", "browser.action.completed", "browser.action.failed"].includes(type)) {
          input.setBrowserFrameRevision((current) => current + 1);
          void getRunBrowserSession(runId).then(({ session }) => input.setBrowserSession(session)).catch(() => undefined);
        }
        return;
      }
      if (type.startsWith("agent.")) {
        const candidate = payload as unknown as AgentGraphProjection;
        const isProjectionEvent = type.startsWith("agent.node.") || type.startsWith("agent.interrupt");
        if (isProjectionEvent && candidate?.runId === runId) {
          input.setAgentProjection(candidate);
          if (candidate.pendingInterrupt) input.setInterruptError(null);
        } else if (!isProjectionEvent) {
          void getRunAgent(runId).then(({ agent }) => input.setAgentProjection(agent)).catch(() => undefined);
        }
        return;
      }
      if (type !== "state") return;
      const event = payload as { id?: string; type?: string; createdAt?: string; payload?: Record<string, unknown> };
      const finished = ["run_completed", "run_failed", "run_blocked", "run_cancelled", "human_review_requested"].includes(event.type ?? "");
      input.setLiveRun((current) => {
        const eventId = event.id ?? id ?? `${runId}:${event.type ?? "state"}`;
        const events = current?.events ?? [];
        const nextEvent = {
          id: `sse:${eventId}`, loopType: "run_state", iteration: Number(id ?? 0), title: event.type ?? "run_state",
          status: finished ? "completed" : "running", timestamp: event.createdAt ?? new Date().toISOString(),
          observation: JSON.stringify(event.payload ?? {}), evidenceRefs: []
        } satisfies RunResult["loopEvents"][number];
        return {
          ...current, runId, status: finished ? "finished" : "running", evidenceCount: current?.evidenceCount ?? 0,
          events: events.some((item) => item.id === nextEvent.id) ? events : [...events, nextEvent].slice(-100),
          evidence: current?.evidence ?? []
        };
      });
      void getRunProjection(runId).then(({ run }) => input.setActiveRun(run)).catch(() => undefined);
    });
  }, [input.activeRunId]);

  useEffect(() => {
    if (!input.activeRunId) { input.setBrowserSession(null); return; }
    const runId = input.activeRunId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSession = async () => {
      let nextSession: BrowserSession | null = null;
      try {
        nextSession = (await getRunBrowserSession(runId)).session;
        if (disposed) return;
        if (nextSession) { input.setBrowserSession(nextSession); input.setBrowserFrameRevision((current) => current + 1); }
      } catch {
        // SSE and the next bounded poll recover transient browser-session gaps.
      }
      if (disposed) return;
      if (!(nextSession && ["closed", "failed"].includes(nextSession.status))) timer = setTimeout(refreshSession, nextSession ? 1_500 : 600);
    };
    void refreshSession();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [input.activeRunId]);

  useEffect(() => {
    if (!input.activeRunId || input.hydratedRunReports.current.has(input.activeRunId)) return;
    const runId = input.activeRunId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hydrateTerminalReport = async () => {
      try {
        const projection = (await getRunProjection(runId)).run;
        if (disposed) return;
        input.setActiveRun(projection);
        const terminal = ["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(projection.state);
        if (!terminal) { timer = setTimeout(hydrateTerminalReport, 1_500); return; }
        if (projection.state === "cancelled") { input.hydratedRunReports.current.add(runId); return; }
        const report = await waitForRunReport(runId);
        if (disposed) return;
        const finalStatus = report.finalStatus ?? report.gateStatus
          ?? (report.verdict === "continue" ? "pass" : report.verdict === "stop_and_fix" ? "fail" : "needs-human-review");
        const succeeded = finalStatus === "pass";
        input.hydratedRunReports.current.add(runId);
        input.setIsRunning(false); input.setResult(report); input.setAutomationFailures([]);
        input.setPlanningAutomation({ phase: succeeded ? "ready" : "blocked", detail: report.summary });
        input.setMessage(report.summary);
        input.setPlanningMessages((current) => {
          const withoutSupersededDiagnostics = current.filter((item) => !item.id.startsWith("automation_failure_analysis_") && !item.id.startsWith("run_failure_analysis_") && !item.id.startsWith("preparation_blocked_") && !item.id.startsWith("progress:run:"));
          if (withoutSupersededDiagnostics.some((item) => item.id === `run_outcome_${runId}`)) return withoutSupersededDiagnostics;
          return [...withoutSupersededDiagnostics, {
            id: `run_outcome_${runId}`, role: "assistant",
            content: succeeded ? `本次测试已经完成。机器结论：通过。${report.summary}` : `本次测试已经结束。机器结论：${finalStatus}。${report.summary}`,
            createdAt: new Date().toISOString(),
            reasoningSummary: {
              phase: "completed", observations: [`Run ${runId} 已进入终态 ${projection.state}`], assessment: report.summary,
              nextStep: succeeded ? "可以查看本次证据和测试报告。" : "只处理报告中仍未完成的路径。",
              userAction: "无需处理已被本次终态取代的临时阻塞提示。", confidence: "high"
            }, requiresConfirmation: false
          }];
        });
      } catch {
        if (!disposed) timer = setTimeout(hydrateTerminalReport, 2_000);
      }
    };
    void hydrateTerminalReport();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); };
  }, [input.activeRunId]);

  useEffect(() => {
    if (!input.selectedProjectId || !input.activeRunId) return;
    rememberProjectActiveRun(input.selectedProjectId, input.activeRunId);
  }, [input.selectedProjectId, input.activeRunId]);

  useEffect(() => {
    if (!input.selectedProjectId || input.activeRunId) return;
    const cachedRunId = readProjectActiveRun(input.selectedProjectId);
    if (!cachedRunId) return;
    const restoreEpoch = input.activeRunRestoreEpochRef.current;
    let disposed = false;
    const restore = async () => {
      for (const runId of rankProjectRunCandidates(cachedRunId, [])) {
        try {
          const projection = await getRunProjection(runId);
          if (disposed || restoreEpoch !== input.activeRunRestoreEpochRef.current) return;
          if (!isRestorableProjectRun(projection.run, input.selectedProjectId)) { forgetProjectActiveRun(input.selectedProjectId, runId); continue; }
          const sessionResponse = await getRunBrowserSession(runId).catch(() => ({ session: undefined }));
          if (disposed || restoreEpoch !== input.activeRunRestoreEpochRef.current) return;
          input.setActiveRunId(runId); input.setActiveRun(projection.run);
          if (sessionResponse.session) {
            input.setBrowserSession(sessionResponse.session); input.setBrowserFrameRevision((current) => current + 1); input.setCentreSurface("preview");
          }
          rememberProjectActiveRun(input.selectedProjectId, runId);
          return;
        } catch {
          if (runId === cachedRunId) forgetProjectActiveRun(input.selectedProjectId, runId);
        }
      }
    };
    void restore();
    return () => { disposed = true; };
  }, [input.selectedProjectId, input.activeRunId]);

  useEffect(() => {
    if (input.planningConfirmed) input.setPlanningSummaryCollapsed(true);
  }, [input.planningConfirmed]);

  useEffect(() => {
    if (!input.activeRunId) { input.setAgentProjection(null); input.setInterruptError(null); return; }
    const runId = input.activeRunId;
    let disposed = false;
    const hydrate = async () => {
      try {
        const { agent } = await getRunAgent(runId);
        if (!disposed && agent?.runId === runId) input.setAgentProjection(agent);
      } catch {
        // Pre-graph historical Runs remain readable through their deterministic report.
      }
    };
    void hydrate();
    const interval = window.setInterval(() => void hydrate(), 4_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [input.activeRunId]);

  useEffect(() => {
    if (!input.activeRunId || !input.activeRun || ["completed", "failed", "blocked", "cancelled"].includes(input.activeRun.state)) return;
    const runId = input.activeRunId;
    let disposed = false;
    const refreshEvidence = async () => {
      try {
        const response = await getRunEvidence(runId);
        if (disposed) return;
        const latestCapturedScreenshot = [...response.evidence].reverse().find((item) => item.type === "screenshot" && item.file)?.file;
        input.setLiveRun((current) => ({
          runId, status: "running", latestScreenshot: latestCapturedScreenshot ?? current?.latestScreenshot,
          latestEvent: response.loopEvents.at(-1) ?? current?.latestEvent, evidenceCount: response.evidence.length,
          events: response.loopEvents.length ? response.loopEvents : (current?.events ?? []), evidence: response.evidence
        }));
      } catch {
        // The first evidence item may not exist until the browser worker starts.
      }
    };
    void refreshEvidence();
    const interval = window.setInterval(() => void refreshEvidence(), 900);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [input.activeRunId, input.activeRun?.state]);

  useEffect(() => {
    const required = input.authFeedbackRequired || input.credentialReadyForRetry || input.apiCredentialFeedbackRequired || input.screenshotRateLimited;
    if (!required) return;
    const noticeKey = [input.activeRunId ?? input.selectedProjectId ?? input.projectDraft?.id ?? "pre-run", input.runAssistantMessage].join(":");
    if (input.surfacedAssistantNotices.current.has(noticeKey)) return;
    input.surfacedAssistantNotices.current.add(noticeKey);
    input.setPlanningMessages((current) => upsertAssistantProgress(current, {
      id: "run-notice", role: "assistant", content: input.runAssistantMessage, createdAt: new Date().toISOString(),
      reasoningSummary: {
        phase: input.authFeedbackRequired || input.apiCredentialFeedbackRequired ? "waiting-user" : "diagnosing",
        observations: [input.authFeedbackRequired ? "测试到达需要登录的页面，但当前运行没有可用的测试账号" : input.apiCredentialFeedbackRequired ? `被测项目声明需要 ${input.missingProjectApiCredentials.map((item) => item.envName).join("、")}` : input.credentialReadyForRetry ? "测试账号已经加密保存" : "现场截图请求触发限流，上一帧证据仍然保留"],
        assessment: input.runAssistantMessage,
        nextStep: input.authFeedbackRequired ? "获得测试账号句柄后恢复同一测试线程" : input.apiCredentialFeedbackRequired ? "获得项目凭据授权后仅向本次沙盒运行注入" : input.credentialReadyForRetry ? "使用新账号创建可追溯的重试 attempt" : "自动退避并继续采集其他证据",
        userAction: input.authFeedbackRequired ? "请点击“配置测试账号”，不要在对话中粘贴密码。" : input.apiCredentialFeedbackRequired ? "请选择沿用测试模型凭据或单独的项目测试凭据。" : input.credentialReadyForRetry ? "点击“使用账号重新测试”即可继续。" : "无需操作；持续超过一分钟时再打开证据详情。",
        confidence: "high"
      }
    }, `notice:${input.activeRunId ?? input.selectedProjectId ?? "pre-run"}`));
  }, [input.activeRunId, input.selectedProjectId, input.projectDraft?.id, input.authFeedbackRequired, input.credentialReadyForRetry, input.apiCredentialFeedbackRequired, input.screenshotRateLimited, input.runAssistantMessage, input.missingProjectApiCredentials]);
}
