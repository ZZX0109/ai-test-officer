import React, { useEffect, useReducer, useRef, useState } from "react";
import { initializeOidc, oidcConfigured } from "./auth";
import { OidcSessionPanel } from "./components/OidcSessionPanel";
import {
  Activity,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  FileSearch,
  KeyRound,
  Link2,
  ListChecks,
  PanelLeft,
  PanelRight,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Send,
  Star,
  Square,
  Timer,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { ConnectorPanel } from "./components/ConnectorPanel";
import { BotDeliveryPanel } from "./components/BotDeliveryPanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import {
  DiscoveryOrchestrationNotice,
  DiscoveryPanel,
  discoveryOrchestrationCopy
} from "./components/DiscoveryPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { InterruptDecisionPanel } from "./components/InterruptDecisionPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ImpactPanel } from "./components/ImpactPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { ProjectWizardPanel } from "./components/ProjectWizardPanel";
import { RunTimeline } from "./components/RunTimeline";
import { RunAssistantPanel } from "./components/RunAssistantPanel";
import { KnowledgeBasis } from "./components/KnowledgeBasis";
import { AssistantConversationMessage } from "./components/AssistantConversationMessage";
import { RepairWorkspace } from "./components/RepairWorkspace";
import { SecurityPanel } from "./components/SecurityPanel";
import { SourceStatusPanel } from "./components/SourceStatusPanel";
import { StoragePanel } from "./components/StoragePanel";
import { AuthenticatedArtifactImage, AuthenticatedArtifactLink } from "./components/AuthenticatedArtifact";
import { useWorkbenchState } from "./hooks/useWorkbenchState";
import {
  initialWorkspaceState,
  workspaceReducer,
  workspaceSelectors
} from "./state/workspaceReducer";
import { readProjectHistoryCache, writeProjectHistoryCache } from "./projectHistoryCache";
import { planRequiresLoginCredentials } from "./loginPlan";
import {
  analyzeConnectedContext,
  bindProjectApiCredential,
  chatWithTestAssistant,
  continuePlanningConversation,
  controlRun,
  approveScenarioDraft,
  createCredential,
  createRunRepair,
  createHarnessGapDraft,
  createProjectGrant,
  deleteCredential,
  deletePatrolPlan,
  deliverRunToBot,
  detectProject,
  detectProjectManifest,
  diagnoseProject,
  generatePlan,
  getAuditStoreStatus,
  getBenchmarkSummary,
  getLatestDemoVerification,
  getRunLlmCalls,
  getRunKnowledge,
  subscribeRunEvents,
  getGrayPlan,
  getRepairFile,
  getPatrolTrend,
  getProjectRuntime,
  getProjectRecovery,
  getAiStartRecovery,
  getSecuritySummary,
  getStorageStatus,
  getRunBundle,
  getRunEvidence,
  getRunProjection,
  getRunAgent,
  resumeRepairDecision,
  listRunRepairs,
  applyRepair,
  exportRepair,
  listHarnessGaps,
  listBotDeliveries,
  listCredentials,
  listPatrolJobs,
  listPatrolPlans,
  listPlatformCapabilities,
  listProjectGrants,
  listProjects,
  listRunHistory,
  listScenarioDrafts,
  listScenarios,
  listStorageArchives,
  probeScenarioDraft,
  rotateCredential,
  runCommitCheck,
  runDiscoveryScan,
  runPatrol,
  runPatrolPlanNow,
  runRequirementAcceptance,
  recoverAndRetryProject,
  runStorageRetention,
  createVisualRun,
  approveRunPlan,
  grantRunPermissions,
  waitForRunReport,
  saveProject,
  saveProjectLoginCredential,
  savePatrolPlan,
  sendRunAgentMessage,
  startPatrolJob,
  startProjectAsync,
  stopPatrolJob,
  stopProject,
  testCredential,
  testProjectConnection,
  installHarnessGapDraft,
  updateHarnessGap,
  updateCredential,
  updateRepairFile,
  updateRepairPlanStatus,
  validateRepair,
  waitForAgentReady
} from "./api";
import type {
  BotDelivery,
  AuditStoreStatus,
  CommitCheckResult,
  Credential,
  DemoVerificationResult,
  DiscoveryScanResult,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  IntakeAnalysis,
  LiveRunState,
  PatrolJob,
  PatrolRunResult,
  PatrolTrend,
  PermissionProfile,
  PlanningConversationResult,
  PlanningMessage,
  AssistantSuggestedAction,
  PlatformCapability,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectGrant,
  ProjectHealthCheckResult,
  ProjectRecoveryResult,
  ProjectRuntimeStatus,
  RuntimeRecoveryAdvice,
  RequirementAcceptanceResult,
  RepairFileContent,
  RepairPlanActionStatus,
  AgentGraphProjection,
  RepairDecisionValue,
  RepairPlanData,
  RepairSession,
  RunBundle,
  RunProjection,
  RunHistoryEntry,
  RunResult,
  ScenarioSummary,
  SecuritySummary,
  BenchmarkSummary,
  StorageArchive,
  StorageStatus
} from "./types";
import "./styles.css";

interface AutomationFailure {
  scenarioId: string;
  title?: string;
  target?: string;
  stage: "binding" | "execution";
  detail: string;
  requiredInformation?: string[];
}

function auditStoreClass(auditStore: AuditStoreStatus | null) {
  if (!auditStore) return "warning";
  if (auditStore.schemaVersionMatches === false || auditStore.migrationComplete === false || auditStore.integrityOk === false) {
    return "failed";
  }
  return "passed";
}

function hasBlockingPlanningQuestions(result: PlanningConversationResult) {
  return result.clarificationQuestions.some((question) =>
    /可能修改数据|沙盒测试数据|哪些操作禁止|暂未识别到页面|最重要的入口页面/.test(question)
  );
}

function isPlanningAutomationBusy(phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked") {
  return ["preparing-project", "discovering", "binding", "starting-run", "running"].includes(phase);
}

function userFacingAutomationError(raw: string) {
  if (/Scenario draft probe failed|fix missingInfo|probe\.page_|selectorProbeStatus/i.test(raw)) {
    return "真实页面路径暂未通过可执行性校验。缺少的入口、控件或预期结果已交给左侧 AI 测试助手处理。";
  }
  if (/^\s*[\[{]|\"(?:draft|gapId|scenario|missingInfo)\"\s*:/.test(raw)) {
    return "自动生成的测试路径没有通过安全校验。详细诊断已保存，左侧 AI 测试助手会提示需要补充的内容。";
  }
  return raw.length > 260 ? `${raw.slice(0, 257)}…` : raw;
}

function boundedAssistantText(value: unknown, limit: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const compact = text
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|afk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

function userFacingAssistantError(error: unknown) {
  const detail = error instanceof Error ? error.message : "模型调用失败";
  if (/Validation failed|fieldErrors|provider_http_400/i.test(detail)) {
    return "模型解释请求没有通过格式校验。系统已压缩上下文，你可以直接重新发送问题；机器结论和证据不受影响。";
  }
  if (/output_truncated|assistant_output_truncated/i.test(detail)) {
    return "模型已经返回回答，但结构化内容在结尾被截断。系统会保留当前诊断并使用更大的输出预算重试，不会清除机器结论或证据。";
  }
  if (/401|403|credential|api[_ ]?key|model_not_configured/i.test(detail)) {
    return "当前模型凭据不可用。请在右上角 API Key 配置中检查凭据后重新发送；现有测试不会被放行或清除。";
  }
  if (/timeout|incomplete|network|fetch/i.test(detail)) {
    return "模型服务本次没有在时限内完成回答。可以直接重试，机器结论和已保存证据不会变化。";
  }
  return "AI 测试官本次没有返回有效回答。系统已保留运行状态和证据，你可以重新发送问题或查看技术详情。";
}

export function commandFallbackAction(
  message: string,
  runState?: string
): Exclude<AssistantSuggestedAction, "none"> | undefined {
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  if (/查看.*(证据|截图|日志|trace)|打开.*(证据|截图|日志)/i.test(normalized)) return "open-evidence";
  if (/docker|podman|沙盒|启动.*项目|前端.*打不开|端口.*不可达/i.test(normalized)) return "retry-runtime";
  if (/重新扫描|扫描页面|discovery/i.test(normalized)) return "retry-discovery";
  if (/暂停|先停一下|等一下/i.test(normalized)) return "pause-run";
  if (/取消|终止|停止测试/i.test(normalized)) return "cancel-run";
  if (/重试.*失败|重新.*失败|修复.*失败|重新绑定/i.test(normalized)) return "retry-failed-path";
  if (/继续.*(其他|剩余|安全|可执行)|跳过.*继续/i.test(normalized)) return "continue-safe-paths";
  if (/修改.*计划|调整.*计划|修改.*范围|调整.*范围/i.test(normalized)) return "revise-plan";
  if (/恢复|继续测试/i.test(normalized) && runState === "paused") return "resume-run";
  if (/开始测试|执行计划|开始执行/i.test(normalized)) return "start-run";
  return undefined;
}

export function isExplicitAssistantActionConfirmation(
  message: string,
  action: Exclude<AssistantSuggestedAction, "none"> | undefined
) {
  if (!action || ![
    "retry-runtime",
    "retry-discovery",
    "retry-failed-path",
    "continue-safe-paths"
  ].includes(action)) return false;
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  if (/(?:为什么|怎么|如何|是什么|能否|是否|可以吗|需要做什么|该怎么办|\?|？)/i.test(normalized)) {
    return false;
  }
  return /^(?:请)?(?:确认|同意|可以|继续|执行|重试|重新|再试|修复|扫描|启动)/i.test(normalized)
    || /(?:重新尝试即可|继续处理|继续执行|重试失败链路|重新扫描页面|重新绑定路径)/i.test(normalized);
}

function auditStoreSummary(auditStore: AuditStoreStatus | null) {
  if (!auditStore) return "—";
  const version = auditStore.userVersion !== undefined
    ? `schema ${auditStore.schemaVersion}/user ${auditStore.userVersion}`
    : `schema ${auditStore.schemaVersion}`;
  const health = [
    auditStore.schemaVersionMatches === false ? "version mismatch" : undefined,
    auditStore.migrationComplete === false ? `missing migrations ${(auditStore.missingMigrations ?? []).join(",") || "unknown"}` : undefined,
    auditStore.integrityOk === false ? `integrity ${auditStore.integrityCheck ?? "failed"}` : undefined
  ].filter(Boolean);
  return `${auditStore.journalMode} · ${version} · ${health.length ? health.join(" · ") : "healthy"} · runs ${auditStore.runs}`;
}

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export function App() {
  const [workspaceState, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspaceState);
  const [oidcAuthenticated, setOidcAuthenticated] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [plan, setPlan] = useState<GrayPlan | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [appUrl, setAppUrl] = useState(viteEnv.VITE_APP_URL ?? "http://localhost:6173");
  const [projects, setProjects] = useState<ProjectConfig[]>(() => readProjectHistoryCache());
  const [projectListNotice, setProjectListNotice] = useState("");
  const selectedProjectId = workspaceState.selectedProjectId;
  const setSelectedProjectId = (projectId: string) => {
    dispatchWorkspace({ type: "project-selected", projectId });
  };
  const beginWorkspaceOperation = (
    phase: "project-loading" | "generating" | "executing" | "judging",
    projectId = selectedProjectId,
    runId?: string
  ) => {
    const requestId = crypto.randomUUID();
    dispatchWorkspace({ type: "operation-started", phase, requestId, projectId, runId });
    return requestId;
  };
  const [projectDraft, setProjectDraft] = useState<ProjectConfig | null>(null);
  const [projectPathInput, setProjectPathInput] = useState(viteEnv.VITE_PROJECT_PATH ?? "app-under-test");
  const [projectDetection, setProjectDetection] = useState<ProjectDetectionResult | null>(null);
  const [projectDetectMessage, setProjectDetectMessage] = useState("");
  const [projectDiagnosis, setProjectDiagnosis] = useState<ProjectDiagnosis | null>(null);
  const [projectGrants, setProjectGrants] = useState<ProjectGrant[]>([]);
  const [projectConnection, setProjectConnection] = useState<ProjectHealthCheckResult | null>(null);
  const [projectRuntime, setProjectRuntime] = useState<ProjectRuntimeStatus | null>(null);
  const [projectRecovery, setProjectRecovery] = useState<ProjectRecoveryResult | null>(null);
  const [projectRecoveryBusy, setProjectRecoveryBusy] = useState(false);
  // Selecting a saved project must not immediately mount its live iframe.
  // A live preview is opened only after this Workbench session has explicitly
  // diagnosed and prepared that project for testing.
  const [previewSessionProjectId, setPreviewSessionProjectId] = useState("");
  const [projectLaunchPhase, setProjectLaunchPhase] = useState("");
  const [runtimeRecoveryAdvice, setRuntimeRecoveryAdvice] = useState<RuntimeRecoveryAdvice | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [requirementText, setRequirementText] = useState("");
  const [diffText, setDiffText] = useState("");
  const [bugTicketText, setBugTicketText] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [prDiffUrl, setPrDiffUrl] = useState("");
  const [openApiPath, setOpenApiPath] = useState("");
  const [openApiUrl, setOpenApiUrl] = useState("");
  const [strictInput, setStrictInput] = useState(false);
  const [requirementPath, setRequirementPath] = useState("");
  const [requirementUrl, setRequirementUrl] = useState("");
  const [bugTicketPath, setBugTicketPath] = useState("");
  const [bugTicketUrl, setBugTicketUrl] = useState("");
  const [notifyList, setNotifyList] = useState("oncall,frontend-owner");
  const [analysis, setAnalysis] = useState<IntakeAnalysis | null>(null);
  const [planningMessages, setPlanningMessages] = useState<PlanningMessage[]>([{
    id: "planning_welcome",
    role: "assistant",
    content: "输入“全面扫描”或“灰度测试”可直接列出完整测试清单；也可以描述一个具体的验证目标。",
    createdAt: new Date().toISOString()
  }]);
  const [planningInput, setPlanningInput] = useState("");
  const [planningResult, setPlanningResult] = useState<PlanningConversationResult | null>(null);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [assistantChatBusy, setAssistantChatBusy] = useState(false);
  const [assistantSuggestedAction, setAssistantSuggestedAction] = useState<{
    action: Exclude<AssistantSuggestedAction, "none">;
    label: string;
  } | null>(null);
  // Progress of the action executed from a RepairPlanPanel. Scoped by planId so
  // one plan's failure never renders under a different plan.
  const [repairPlanActionStatus, setRepairPlanActionStatus] = useState<RepairPlanActionStatus | null>(null);
  const [planningConfirmed, setPlanningConfirmed] = useState(false);
  const [planningAutomation, setPlanningAutomation] = useState<{
    phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked";
    detail: string;
    scenarioId?: string;
  }>({ phase: "idle", detail: "" });
  const [preparationLoginUsername, setPreparationLoginUsername] = useState("");
  const [preparationLoginPassword, setPreparationLoginPassword] = useState("");
  const [preparationLoginError, setPreparationLoginError] = useState("");
  const [preparationLoginSaving, setPreparationLoginSaving] = useState(false);
  const [automationFailures, setAutomationFailures] = useState<AutomationFailure[]>([]);
  const analyzedBlockedRuns = useRef(new Set<string>());
  const surfacedAssistantNotices = useRef(new Set<string>());
  const surfacedProjectDiagnostics = useRef(new Set<string>());
  const hydratedAgentThreads = useRef(new Set<string>());
  const generationRequestRef = useRef<{ id: string; projectId: string; controller: AbortController } | null>(null);
  const diagnosisOperationRef = useRef<{ id: string; projectId: string } | null>(null);
  const [flowDeleteReadyId, setFlowDeleteReadyId] = useState<string | null>(null);
  const flowDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [capabilities, setCapabilities] = useState<PlatformCapability[]>([]);
  const [deliveries, setDeliveries] = useState<BotDelivery[]>([]);
  const [patrolJobs, setPatrolJobs] = useState<PatrolJob[]>([]);
  const [patrolPlans, setPatrolPlans] = useState<PatrolJob[]>([]);
  const [patrolTrend, setPatrolTrend] = useState<PatrolTrend | null>(null);
  const [patrolRun, setPatrolRun] = useState<PatrolRunResult | null>(null);
  const [harnessGaps, setHarnessGaps] = useState<HarnessGap[]>([]);
  const [gapDrafts, setGapDrafts] = useState<Record<string, HarnessGapScenarioDraft>>({});
  const [scenarioDrafts, setScenarioDrafts] = useState<HarnessGapScenarioDraft[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryScanResult | null>(null);
  const [demoVerification, setDemoVerification] = useState<DemoVerificationResult | null>(null);
  const [commitCheck, setCommitCheck] = useState<CommitCheckResult | null>(null);
  const [requirementAcceptance, setRequirementAcceptance] = useState<RequirementAcceptanceResult | null>(null);
  const [liveRun, setLiveRun] = useState<LiveRunState | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunProjection | null>(null);
  const [repairSession, setRepairSession] = useState<RepairSession | null>(null);
  const [repairWorkspaceOpen, setRepairWorkspaceOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [reviewReason, setReviewReason] = useState("");
  const [runPreviewModalOpen, setRunPreviewModalOpen] = useState(false);
  const [screenshotIssue, setScreenshotIssue] = useState<string | null>(null);
  const [auditStore, setAuditStore] = useState<AuditStoreStatus | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageArchives, setStorageArchives] = useState<StorageArchive[]>([]);
  const [securitySummary, setSecuritySummary] = useState<SecuritySummary | null>(null);
  const [benchmarkSummary, setBenchmarkSummary] = useState<BenchmarkSummary | null>(null);
  const [message, setMessage] = useState("");
  const [isRefreshingContext, setIsRefreshingContext] = useState(false);
  const [contextRefreshStatus, setContextRefreshStatus] = useState("刷新会重新读取已保存项目、测试场景和运行记录。");
  const [isRunning, setIsRunning] = useState(false);
  const [isPatrolling, setIsPatrolling] = useState(false);
  const [isCommitChecking, setIsCommitChecking] = useState(false);
  const [isAcceptingRequirement, setIsAcceptingRequirement] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  const [credentialFormOpen, setCredentialFormOpen] = useState(false);
  const [apiSettingsOpen, setApiSettingsOpen] = useState(false);
  const [revealProjectLoginSettings, setRevealProjectLoginSettings] = useState(false);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  /** Evidence id to scroll-to + highlight when the workbench asks to locate one. */
  const [focusEvidenceId, setFocusEvidenceId] = useState<string | null>(null);
  // The graph projection is the only place a *paused* run surfaces. Without it
  // an interrupted run is indistinguishable from a stalled one.
  const [agentProjection, setAgentProjection] = useState<AgentGraphProjection | null>(null);
  const [interruptBusy, setInterruptBusy] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [permissionProfile, setPermissionProfile] = useState<PermissionProfile>({
    observe: true,
    browserControl: false,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  });
  const [form, setForm] = useState({
    name: "SophNet gpt-5.1-codex",
    provider: "openai-compatible",
    baseUrl: "https://api.sophnet.com/v1",
    apiKey: "",
    model: "gpt-5.1-codex",
    tags: "llm,sophnet,benchmark",
    owner: "local-dev",
    scopes: "judge,planning",
    isDefault: true
  });
  const [botProvider, setBotProvider] = useState<NonNullable<BotDelivery["provider"]>>("simulated");
  const [botChannel, setBotChannel] = useState("值班群");
  const [botGithubPrUrl, setBotGithubPrUrl] = useState("");
  const [botIncludeScreenshots, setBotIncludeScreenshots] = useState(true);

  const {
    defaultCredential,
    isBusy,
    latestScreenshot,
    displayedLoopEvents,
    liveStatusText
  } = useWorkbenchState({
    credentials,
    result,
    liveRun,
    isRunning,
    isPatrolling,
    isCommitChecking,
    isAcceptingRequirement
  });
  const activeExecutablePlan = commitCheck?.executablePlan ?? requirementAcceptance?.executablePlan;
  const selectedScenario = scenarios.find((scenario) => scenario.id === scenarioId);
  const selectedCandidate = analysis?.scenarioCandidates.find((candidate) => candidate.mappedScenarioId === scenarioId);
  const selectedProjectName = projectDraft?.name ?? projects.find((project) => project.id === selectedProjectId)?.name ?? "未选择项目";
  const selectedProjectExecutionMode = projectDraft?.allowExternalProjectPath
    ? "oci"
    : projectDraft?.manifest?.execution.mode
    ?? projects.find((project) => project.id === selectedProjectId)?.manifest?.execution.mode
    // Built-in fixtures predate the manifest. They are trusted test assets,
    // whereas every uploaded project gets an OCI manifest during detection.
    ?? "trusted-local";
  const hasSelectedProject = Boolean(selectedProjectId || (projectDraft?.id && projectDetection?.executionReady !== false));
  const discoveryAllowsPlanning = !discovery?.orchestration || discovery.orchestration.status === "ready";
  const planningHasBlockingQuestions = !discoveryAllowsPlanning
    || (planningResult ? hasBlockingPlanningQuestions(planningResult) : false);
  const planningAutomationBusy = isPlanningAutomationBusy(planningAutomation.phase);
  // Credentials are a property of the confirmed plan, not merely of the
  // project manifest. This keeps login fields out of runs that never execute
  // an authentication step.
  const preparationPlan = planningResult ?? plan;
  const preparationRequiresLogin = planRequiresLoginCredentials(preparationPlan);
  const canStartRun = hasSelectedProject
    && discoveryAllowsPlanning
    && Boolean(requirementText.trim())
    && Boolean(scenarioId)
    && planningConfirmed
    && !isRunning;
  // A sandbox target is only ever rendered through the port allocated to its
  // active runtime. Never fall back to the saved container port: another app
  // may be listening there and would make a failed launch look like a live
  // preview.
  const previewUrl = projectRuntime?.status === "running"
    ? projectRuntime.frontendUrl ?? appUrl
    : appUrl;
  const projectPreviewReady = previewSessionProjectId === selectedProjectId && Boolean(previewUrl && (
    selectedProjectExecutionMode === "oci"
      ? projectRuntime?.status === "running"
      : projectConnection?.ok || projectRuntime?.status === "running"
  ));
  const evidenceCount = result?.evidence?.length ?? 0;
  const sourceContextCount = analysis?.sourceContexts?.length ?? 0;
  const planStepCount = activeExecutablePlan?.steps.length ?? plan?.levels.reduce((total, level) => total + level.paths.reduce((pathTotal, path) => pathTotal + path.steps.length, 0), 0) ?? 0;
  const latestDecision = result?.finalStatus
    ?? result?.gateStatus
    ?? activeRun?.finalStatus
    ?? activeRun?.gateStatus
    ?? (activeRun?.state && !["draft", "awaiting-plan-approval", "awaiting-permission"].includes(activeRun.state)
      ? activeRun.state === "awaiting-human-review" ? "needs-human-review" : activeRun.state
      : undefined)
    ?? commitCheck?.run?.finalStatus
    ?? commitCheck?.run?.gateStatus
    ?? requirementAcceptance?.run?.finalStatus
    ?? requirementAcceptance?.run?.gateStatus
    ?? "未运行";
  const planningDraftReady = Boolean(discoveryAllowsPlanning && planningResult && !planningConfirmed && !planningBusy);
  const nextSuggestion = result?.failureAttributions?.[0]?.suggestedFix ??
    result?.failureAttributions?.[0]?.topSuspects?.[0]?.suggestedFix ??
    (patrolTrend?.riskIncreased ? "风险趋势升高，建议打开历史运行对比失败证据。" : "先确认项目连接、输入来源和浏览器授权，然后运行一次测试。");
  const runDiagnosticText = [
    result?.summary,
    ...((result?.console ?? []).slice(-12).map((entry) => entry.text)),
    ...((result?.assertions ?? []).filter((assertion) => !assertion.passed).flatMap((assertion) => [assertion.name, assertion.actual])),
    ...((result?.failureAttributions ?? []).flatMap((failure) => [failure.title, failure.reasoning, failure.suggestedFix])),
    planningAutomation.detail
  ].filter(Boolean).join("\n");
  // A completed successful run must clear an older planning diagnostic. The
  // previous OR condition kept stale “AI can repair this” cards visible beside
  // a current pass result, which made the assistant look disconnected from the
  // run the user was viewing.
  const runIsBlocked = latestDecision === "blocked"
    || (planningAutomation.phase === "blocked" && latestDecision !== "pass");
  const loginServiceUnavailable = runIsBlocked &&
    /resolveLogin[\s\S]{0,180}(retry|timeout|timed out|network|refused|502|503|unavailable)|maximum retry count[\s\S]{0,80}resolveLogin/i.test(runDiagnosticText);
  const authBlockDetected = runIsBlocked && !loginServiceUnavailable &&
    /credential_missing|invalid credentials|log[ -]?in failed|unauthori[sz]ed|forbidden|(?:^|\D)401(?:\D|$)|(?:^|\D)403(?:\D|$)|登录失败|缺少.*(?:凭据|账号|密码)|账号或密码/i.test(runDiagnosticText);
  const hasConfiguredProjectLogin = Boolean(projectDraft?.login?.credentialId);
  const configuredApiCredentialEnvs = new Set((projectDraft?.apiCredentialBindings ?? []).map((item) => item.envName));
  const missingProjectApiCredentials = (projectDraft?.apiCredentialRequirements ?? [])
    .filter((item) => !configuredApiCredentialEnvs.has(item.envName));
  const apiCredentialFeedbackRequired = missingProjectApiCredentials.length > 0;
  const authFeedbackRequired = authBlockDetected && !hasConfiguredProjectLogin;
  const credentialReadyForRetry = authBlockDetected && hasConfiguredProjectLogin;
  const screenshotRateLimited = Boolean(screenshotIssue && /rate limit exceeded|429/i.test(screenshotIssue));
  const reviewRequired = activeRun?.state === "awaiting-human-review" || latestDecision === "needs-human-review";
  const pathBindingRepairable = planningAutomation.phase === "blocked"
    && /真实页面路径|安全校验|页面绑定|没有路径通过|失败链路|入口、控件或预期结果/i.test(planningAutomation.detail);
  const proofInfrastructureFailure = Boolean(result?.machineGate?.reasonDetails?.some((reason) =>
    /proof|evidence|artifact|integrity|关联|证据/i.test(`${reason.code} ${reason.summary}`)
  ));
  const codeRepairAvailable = Boolean(
    activeRunId
    && result
    && (
      result.executionError
      || result.assertions.some((assertion) => !assertion.passed)
      || latestDecision === "fail"
      || latestDecision === "blocked"
    )
  );
  const runtimeRecoveryAvailable = Boolean(
    projectRuntime
    && projectRuntime.status !== "running"
    && (
      ["idle", "failed", "starting", "installing"].includes(projectRuntime.status)
      || ["container_runtime_unavailable", "dependency_missing", "command_not_found", "port_conflict", "health_timeout", "early_exit"].includes(projectRuntime.failureReason ?? "")
    )
  );
  const discoveryRecoveryAvailable = Boolean(
    projectRuntime?.status === "running"
    && planningAutomation.phase === "blocked"
    && /Discovery|真实页面|页面绑定|入口、控件或预期结果|可执行路径/i.test(planningAutomation.detail)
  );
  const assistantAutoRepairAvailable = runtimeRecoveryAvailable || discoveryRecoveryAvailable || pathBindingRepairable || codeRepairAvailable;
  const assistantFeedbackRequired = runIsBlocked || runtimeRecoveryAvailable || discoveryRecoveryAvailable || authFeedbackRequired || credentialReadyForRetry || apiCredentialFeedbackRequired || screenshotRateLimited || reviewRequired || codeRepairAvailable;
  const latestPlanningAssistant = [...planningMessages].reverse().find((item) => item.role === "assistant");
  const latestPlanningAssistantMessage = latestPlanningAssistant?.content;
  const assistantQuickCommands = runIsBlocked || reviewRequired
    ? ["用简单的话解释失败原因", "重试失败链路", "继续其他可执行测试"]
    : isRunning
      ? ["现在测试到哪一步？", "继续其他可执行测试", "暂停测试"]
      : planningResult
        ? ["这份计划主要测什么？", "调整测试范围", "开始执行测试"]
        : ["全面扫描", "我应该先测试什么？"];
  const failedAssertions = (result?.assertions ?? []).filter((assertion) => !assertion.passed);
  const primaryFailure = result?.failureAttributions?.[0];
  const concreteRunFailureMessage = primaryFailure
    ? `${primaryFailure.title}：${primaryFailure.reasoning}${primaryFailure.suggestedFix ? ` 建议：${primaryFailure.suggestedFix}` : ""}`
    : failedAssertions.length
      ? `已定位到 ${failedAssertions.length} 个未通过断言：${failedAssertions.slice(0, 2).map((item) => `${item.name}（实际：${item.actual}）`).join("；")}。系统已保留对应截图、DOM、网络与 Trace，后续路径不会因此停止。`
      : result?.executionError
        ? `执行在 ${result.executionError.stepId ?? "当前步骤"} 遇到 ${result.executionError.code}：${result.executionError.message}`
        : undefined;
  const runAssistantMessage = apiCredentialFeedbackRequired
    ? `检测到被测项目自身需要 ${missingProjectApiCredentials.map((item) => item.envName).join("、")}。请选择临时沿用当前测试模型凭据，或为该项目选择单独凭据；系统只会在沙盒运行时注入，不会修改项目源码。`
    : pathBindingRepairable
    ? `真实页面扫描已经完成，但当前候选路径没有同时满足“入口存在、操作可执行、结果可验证”三项条件，因此系统没有冒险执行。可以让 AI 根据已保存的页面诊断重新生成计划。`
    : screenshotRateLimited
    ? "测试没有停止：现场截图刷新过快被临时限流，系统正在保留上一帧并自动退避重试。你无需填写反馈；如果持续超过一分钟，请打开证据详情检查运行状态。"
    : credentialReadyForRetry
    ? "测试账号已加密保存。上一次阻塞记录会保留；点击下方按钮后，系统会使用新账号重新扫描登录路径并创建一次新的测试运行。"
    : authFeedbackRequired
    ? "测试已到达需要登录的页面，但没有可用的测试账号，因此没有继续尝试受保护功能。请配置专用测试账号，或告诉我应测试的公开路径。"
    : loginServiceUnavailable
      ? "页面已经打开，但登录解析依赖的后端接口没有响应。这属于运行服务问题，不是账号配置问题；请重新检查并继续，系统会同时恢复前后端服务。"
    : runIsBlocked
      ? (concreteRunFailureMessage || planningAutomation.detail || nextSuggestion || "本次测试遇到阻塞。你可以补充入口、运行条件或预期结果，我会据此修订计划。")
      : (latestPlanningAssistantMessage ?? "可以随时补充测试目标、页面入口或预期结果。");

  function runResultFromBundle(bundle: RunBundle): RunResult {
    return {
      ...bundle.result,
      evidence: bundle.evidence ?? [],
      loopEvents: bundle.loopEvents ?? [],
      riskCoverageMatrix: bundle.riskCoverageMatrix ?? [],
      failureAttributions: bundle.failureAttributions ?? bundle.result.failureAttributions ?? [],
      runtimeStatus: bundle.runtimeStatus ?? bundle.result.runtimeStatus,
      artifactIntegrity: bundle.artifactIntegrity ?? bundle.result.artifactIntegrity
    };
  }

  function closeDrawers() {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".drawer")) focused.blur();
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
  }

  function openProjectLoginSettings() {
    if (preparationRequiresLogin) {
      setPreparationLoginError("");
      setPreparationLoginUsername("");
      setPreparationLoginPassword("");
      setPlanningAutomation({
        phase: "needs-credentials",
        detail: "当前测试计划需要登录账号，请在准备窗口中配置后继续。"
      });
      setRunPreviewModalOpen(true);
      return;
    }
    setRevealProjectLoginSettings(true);
    setLeftDrawerOpen(true);
    setRightDrawerOpen(false);
    setMessage("请在“登录与测试账号”中保存专用测试账号。密码会加密保存并仅在运行时注入沙盒。");
    window.setTimeout(() => {
      document.getElementById("project-login-settings")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }

  async function submitRunAssistantFeedback(feedback: string) {
    await chatWithAssistant(feedback);
  }

  async function repairBlockedPlanning() {
    const pendingId = `binding_repair_pending_${Date.now()}`;
    const failureSummary = automationFailures.length
      ? automationFailures.map((failure, index) =>
          `${index + 1}. ${failure.title ?? failure.scenarioId}：${failure.detail}`
          + (failure.requiredInformation?.length ? `；仍需 ${failure.requiredInformation.join("、")}` : "")
        ).join("\n")
      : planningAutomation.detail;
    const previousFlows = new Map(
      (planningResult?.businessFlows ?? []).map((flow) => [flow.id, {
        title: flow.title,
        status: flow.status,
        scenarioId: flow.scenarioId
      }])
    );
    setPlanningConfirmed(false);
    setMessage("AI 正在读取失败链路、页面探测结果和证据，重新生成可执行计划。");
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: `正在分析 ${automationFailures.length || "当前"} 条失败链路，重新读取入口、控件和验证条件。此步骤不会修改被测项目源码。`,
      createdAt: new Date().toISOString()
    }]);
    const repaired = await continueTestPlanning(
      [
        "请根据刚才保存的真实页面路径校验诊断重新规划。",
        "只保留能够绑定实际页面入口、真实控件、确定性 oracle 和完整证据要求的路径；无法验证的候选请标记为覆盖缺口，不要作为可执行测试。",
        "需要逐条说明修复了哪个入口、控件或 oracle；未发生变化时必须明确说没有修复。",
        `本轮失败链路：\n${failureSummary}`
      ].join("\n"),
      "llm-guided",
      { internalInstruction: true, preserveAutomationState: true }
    );
    if (repaired) {
      setPlanningAutomation({ phase: "idle", detail: "" });
      setMessage("失败链路分析完成，新计划已经生成。请查看调整后的路径后确认执行。");
      const llm = repaired.llmPlanning;
      const modelTrace = llm?.status === "passed"
        ? `模型 ${llm.model ?? "当前活动模型"} 已返回建议；调用 ${llm.callId ?? "未返回编号"}，耗时 ${llm.durationMs ?? 0}ms。`
        : llm?.status === "failed"
          ? `模型调用失败（${llm.errorCode ?? "unknown"}），本次仅保留规则计划。`
          : "本次未调用模型，仅使用规则扫描结果。";
      const changedBindings = repaired.businessFlows.flatMap((flow) => {
        const previous = previousFlows.get(flow.id);
        if (!previous) return [`新增“${flow.title}”：${flow.status}${flow.scenarioId ? ` → ${flow.scenarioId}` : ""}`];
        if (previous.status === flow.status && previous.scenarioId === flow.scenarioId) return [];
        return [
          `“${flow.title}”：${previous.status}${previous.scenarioId ? `/${previous.scenarioId}` : ""} → ${flow.status}${flow.scenarioId ? `/${flow.scenarioId}` : ""}`
        ];
      });
      const prioritizedTitles = (llm?.prioritizedFlowIds ?? [])
        .map((id) => repaired.businessFlows.find((flow) => flow.id === id)?.title)
        .filter((title): title is string => Boolean(title));
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: [
          modelTrace,
          `重新规划结果：${repaired.coverage.executable} 条可直接执行，${repaired.coverage.autoBindable} 条等待真实页面绑定，${repaired.coverage.gaps} 条保留为覆盖缺口。`,
          prioritizedTitles.length ? `模型优先检查：${prioritizedTitles.slice(0, 5).join("、")}。` : "",
          changedBindings.length
            ? `实际调整：${changedBindings.slice(0, 5).join("；")}${changedBindings.length > 5 ? `；另有 ${changedBindings.length - 5} 项` : ""}。`
            : "实际调整：没有路径状态或场景绑定发生变化。",
          "尚未修改被测项目代码；确认计划后系统会再次执行真实页面绑定。"
        ].filter(Boolean).join("\n")
      } : item));
    } else {
      setPlanningAutomation((current) => ({
        ...current,
        phase: "blocked",
        detail: "失败链路分析没有生成有效计划。诊断仍已保留，可以修改测试范围或稍后重试。"
      }));
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: "模型或规划服务没有生成可验证的新路径。系统没有修改源码，也没有把失败路径伪装成通过；可以继续追问具体失败原因。"
      } : item));
    }
  }

  async function openCodeRepairWorkspace() {
    if (!activeRunId) {
      setMessage("当前没有可关联的持久化运行，无法创建修复会话。");
      return;
    }
    setRepairBusy(true);
    setMessage("正在创建只读源码快照和可写沙盒副本，并根据失败证据生成最小修复。");
    const pendingId = `code_repair_pending_${Date.now()}`;
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: "正在创建沙盒源码副本，调用 Repair 模型定位失败文件，并在修改后运行定向测试。原项目保持只读。",
      createdAt: new Date().toISOString()
    }]);
    try {
      const response = await createRunRepair(activeRunId, {
        autoAnalyze: true,
        credentialId: defaultCredential?.id,
        summary: "根据当前运行的机器门禁、失败断言和证据定位最小修复。"
      });
      setRepairSession(response.repair);
      setRepairWorkspaceOpen(true);
      setMessage(response.repair.summary);
      const calls = await getRunLlmCalls(activeRunId).catch(() => null);
      const repairCall = [...(calls?.calls ?? [])].reverse().find((call) => call.purpose === "repairing");
      const changedFiles = response.repair.files.map((file) => `${file.path}（${file.additions}+/${file.deletions}-，${file.risk}）`);
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: [
          response.repair.summary,
          `失败归因：${response.repair.failureClass}。`,
          changedFiles.length ? `沙盒变更：${changedFiles.join("；")}。` : "模型没有生成可安全应用的文件变更。",
          repairCall
            ? `模型 ${repairCall.model}；调用 ${repairCall.id}；${repairCall.durationMs}ms；${repairCall.usage.totalTokens ?? 0} Token；状态 ${repairCall.status}。`
            : "本次没有可用的 Repair 模型调用记录。",
          "修复工作区已打开，可逐行查看 Diff；重新验证通过前不会应用到原项目。"
        ].join("\n")
      } : item));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "创建修复工作区失败";
      setMessage(detail);
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: `修复会话创建失败：${detail}。原机器结论和证据保持不变，没有修改项目文件。`
      } : item));
    } finally {
      setRepairBusy(false);
    }
  }

  async function saveRepairFile(file: RepairFileContent, content: string) {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await updateRepairFile(repairSession.id, file.path, {
      content,
      expectedVersion: file.version
    });
    setRepairSession(response.repair);
    return response.repair;
  }

  async function validateCurrentRepair() {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await validateRepair(repairSession.id);
    setRepairSession(response.repair);
    return response.repair;
  }

  async function exportCurrentRepair(format: "patch" | "zip") {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await exportRepair(repairSession.id, format);
    return { downloadUrl: response.export.downloadUrl };
  }

  async function applyCurrentRepair(confirmHighRisk: boolean) {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await applyRepair(repairSession.id, confirmHighRisk);
    setRepairSession(response.repair);
    return response.repair;
  }

  function returnBlockedPreparationToAssistant() {
    setRunPreviewModalOpen(false);
    setPlanningConfirmed(false);
    const detail = planningAutomation.detail || "自动准备没有形成可安全执行的路径。";
    setPlanningMessages((current) => {
      const latest = current.at(-1);
      const content = `准备阶段遇到问题：${detail} 我会保留已完成的扫描和失败证据；你可以让我分析并修复失败链路，或修改本次测试范围。`;
      return latest?.content === content ? current : [...current, {
        id: `preparation_blocked_${Date.now()}`,
        role: "assistant",
        content,
        createdAt: new Date().toISOString()
      }];
    });
    setMessage("失败诊断已发送到左侧 AI 测试助手。");
  }

  async function analyzeAutomationFailures(
    failures: AutomationFailure[],
    completedCount: number
  ) {
    setAutomationFailures(failures);
    const compact = failures.slice(0, 12).map((failure) =>
      `${failure.title ?? failure.scenarioId} [${failure.stage}]: ${failure.detail.slice(0, 220)}`
    );
    let analysis = `已继续完成 ${completedCount} 条可执行路径，并保留 ${failures.length} 条失败链路。失败证据没有被当作通过，也没有阻止后续测试。`;
    if (defaultCredential?.id && (selectedProjectId || projectDraft?.id)) {
      try {
        const response = await continuePlanningConversation({
          projectId: selectedProjectId || projectDraft!.id,
          message: [
            "这是一次测试批次结束后的内部失败归因，不要修改用户原始需求。",
            "请区分页面入口/选择器绑定、运行环境、产品缺陷、证据不足和测试脚本问题；给出下一轮最小修复动作。",
            ...compact
          ].join("\n"),
          diff: diffText,
          bugTicket: bugTicketText,
          history: planningMessages,
          planningMode: "llm-guided",
          credentialId: defaultCredential.id
        });
        analysis = response.planning.llmPlanning?.summary || response.planning.reply || analysis;
      } catch {
        // The deterministic failure queue remains authoritative when the LLM
        // is unavailable; model failure must not discard the browser results.
      }
    }
    const visibleFailures = failures.slice(0, 2).map((failure, index) =>
      `${index + 1}. ${failure.title ?? failure.scenarioId}：${userFacingAutomationError(failure.detail)}`
    );
    const userAction = failures.some((failure) => failure.requiredInformation?.length)
      ? `请补充：${failures.flatMap((failure) => failure.requiredInformation ?? []).slice(0, 3).join("、")}。`
      : "你可以直接回复“重试失败链路”，系统会只重新绑定和复验这些路径；也可以回复“继续其他可执行测试”。";
    setPlanningMessages((current) => [...current, {
      id: `automation_failure_analysis_${Date.now()}`,
      role: "assistant",
      content: [
        `状态：已完成 ${completedCount} 条；${failures.length} 条路径待处理。`,
        `阻塞：${visibleFailures.join("；")}`,
        `系统动作：已保存页面观测和失败证据，只重试失败路径。${boundedAssistantText(analysis, 160)}`,
        `需要你做什么：${userAction}`
      ].join("\n"),
      createdAt: new Date().toISOString(),
      reasoningSummary: {
        phase: "waiting-user",
        observations: visibleFailures,
        assessment: `${failures.length} 条路径尚未形成可验证闭环，不能计为通过。`,
        nextStep: "只重试失败路径，已完成路径不会重复执行。",
        userAction,
        confidence: "high"
      },
      suggestedAction: "retry-failed-path",
      requiresConfirmation: true
    }]);
    return analysis;
  }

  async function retryWithConfiguredLogin(projectOverride?: ProjectConfig) {
    setMessage("测试账号已就绪，正在重新扫描登录路径并创建新的测试运行。");
    if (planningResult && selectedProjectExecutionMode === "oci") {
      setPlanningConfirmed(true);
      await continueAutomaticPlanning(permissionProfile, projectOverride);
      return;
    }
    if (scenarioId) {
      await executeConfirmedScenarioAutomatically(scenarioId);
      return;
    }
    await continueTestPlanning("测试账号已经配置完成，请重新生成并执行需要登录的测试路径。");
  }

  async function bindMissingProjectApiCredentials(
    credentialId: string,
    source: "test-system" | "dedicated"
  ) {
    const current = projectDraft;
    if (!current?.id || !missingProjectApiCredentials.length) return;
    setPlanningAutomation((state) => ({
      ...state,
      phase: "preparing-project",
      detail: "正在将所选 API 凭据安全绑定到项目沙盒…"
    }));
    try {
      let updated = (await saveProject(current)).project;
      for (const requirement of missingProjectApiCredentials) {
        const response = await bindProjectApiCredential(updated.id, {
          envName: requirement.envName,
          credentialId,
          source,
          baseUrlEnv: requirement.baseUrlEnv,
          modelEnv: requirement.modelEnv
        });
        updated = response.project;
      }
      setProjectDraft(updated);
      setProjects((items) => {
        const next = items.some((item) => item.id === updated.id)
          ? items.map((item) => item.id === updated.id ? updated : item)
          : [updated, ...items];
        writeProjectHistoryCache(next);
        return next;
      });
      setProjectConnection(null);
      setPlanningAutomation({ phase: "idle", detail: "" });
      setMessage(source === "test-system"
        ? "已授权被测项目在沙盒中临时使用当前测试模型凭据。不会写入项目源码。"
        : "已为被测项目绑定独立 API 凭据。不会写入项目源码。");
      if (planningConfirmed && planningResult) {
        await continueAutomaticPlanning(permissionProfile, updated);
      }
    } catch (error) {
      setPlanningAutomation({
        phase: "blocked",
        detail: error instanceof Error ? error.message : "项目 API 凭据绑定失败。"
      });
      setMessage(error instanceof Error ? error.message : "项目 API 凭据绑定失败。");
    }
  }

  function resetPlanningConversation() {
    if (flowDeleteTimer.current) clearTimeout(flowDeleteTimer.current);
    setFlowDeleteReadyId(null);
    setPlanningMessages([{
      id: `planning_welcome_${Date.now()}`,
      role: "assistant",
      content: "项目已切换。输入“全面扫描”或“灰度测试”可列出完整测试清单。",
      createdAt: new Date().toISOString()
    }]);
    setPlanningInput("");
    setPlanningResult(null);
    setPlanningConfirmed(false);
    setPlanningAutomation({ phase: "idle", detail: "" });
    setAutomationFailures([]);
    setRequirementText("");
    setScenarioId("");
    setAnalysis(null);
    setPlan(null);
  }

  function scheduleFlowDelete(flowId: string) {
    if (flowDeleteTimer.current) clearTimeout(flowDeleteTimer.current);
    flowDeleteTimer.current = setTimeout(() => setFlowDeleteReadyId(flowId), 1_000);
  }

  function hideFlowDelete(flowId: string) {
    if (flowDeleteTimer.current) clearTimeout(flowDeleteTimer.current);
    flowDeleteTimer.current = null;
    setFlowDeleteReadyId((current) => current === flowId ? null : current);
  }

  function excludePlanningFlow(flowId: string) {
    const removed = planningResult?.businessFlows.find((flow) => flow.id === flowId);
    if (!removed) return;
    setPlanningResult((current) => {
      if (!current) return current;
      const businessFlows = current.businessFlows.filter((flow) => flow.id !== flowId);
      const executable = businessFlows.filter((flow) => flow.status === "executable").length;
      const autoBindable = businessFlows.filter((flow) => flow.status === "auto-bindable").length;
      const needsInput = businessFlows.filter((flow) => flow.status === "needs-input").length;
      const gaps = businessFlows.filter((flow) => flow.status === "coverage-gap").length;
      return {
        ...current,
        businessFlows,
        coverage: {
          ...current.coverage,
          discovered: businessFlows.length,
          executable,
          autoBindable,
          needsInput,
          gaps,
          confidence: businessFlows.length && gaps === 0 ? "high" : businessFlows.length ? "medium" : "low"
        },
        plan: {
          ...current.plan,
          risks: current.plan.risks.filter((risk) => !risk.id.endsWith(flowId)),
          levels: current.plan.levels.map((level) => ({
            ...level,
            paths: level.paths.filter((path) => path.id !== flowId)
          }))
        },
        recommendedScenarioId: businessFlows.find((flow) => flow.status === "executable")?.scenarioId
      };
    });
    if (removed.scenarioId && removed.scenarioId === scenarioId) setScenarioId("");
    setFlowDeleteReadyId(null);
    setMessage(`已从本次测试计划排除“${removed.title}”。不会修改项目代码。`);
  }

  function openCredentialSettings() {
    setRightDrawerOpen(false);
    setLeftDrawerOpen(false);
    setEditingCredentialId(null);
    setCredentialFormOpen(false);
    setApiSettingsOpen(true);
  }

  function renderApiSettingsDialog() {
    if (!apiSettingsOpen) return null;
    return (
      <div className="api-settings-backdrop" role="presentation" onMouseDown={() => setApiSettingsOpen(false)}>
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
            <button className="icon-button" type="button" aria-label="关闭 API Key 配置" onClick={() => setApiSettingsOpen(false)}>
              <X size={17} />
            </button>
          </header>

          <button
            className="add-credential-button"
            type="button"
            onClick={() => {
              if (credentialFormOpen) {
                cancelEdit();
                return;
              }
              cancelEdit();
              setCredentialFormOpen(true);
            }}
          >
            {credentialFormOpen ? "收起配置" : "添加新的 API Key"}
          </button>

          {credentialFormOpen && <form className="api-settings-form" onSubmit={submitCredential}>
            <label>
              配置名称
              <input aria-label="名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：我的 GPT" />
            </label>
            <label>
              服务商
              <select aria-label="Provider" value={form.provider} onChange={(event) => setForm({ ...form, provider: event.target.value })}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai-compatible">兼容 OpenAI 的服务</option>
                <option value="custom">自定义服务</option>
              </select>
            </label>
            <label>
              API 地址
              <input aria-label="Base URL" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
            </label>
            <label>
              模型名称
              <input aria-label="模型" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} placeholder="gpt-5.1-codex" />
            </label>
            <label>
              API Key
              <input aria-label="API Key" type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder={editingCredentialId ? "留空则保留原来的 Key" : "粘贴 API Key"} />
              <small>密钥不会显示在报告或测试证据中。</small>
            </label>
            <details className="api-settings-advanced">
              <summary>高级设置</summary>
              <label>标签<input aria-label="标签" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label>
              <label>Owner<input aria-label="Owner" value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></label>
              <label>Scopes<input aria-label="Scopes" value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} /></label>
              <label className="checkbox-row"><input checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} type="checkbox" />设为默认模型</label>
            </details>
            <div className="form-actions">
              <button className="primary" type="submit"><Save size={15} />{editingCredentialId ? "保存修改" : "保存 API Key"}</button>
              <button type="button" onClick={cancelEdit}>取消</button>
            </div>
          </form>}

          <section className="saved-credentials" aria-label="已保存的模型配置">
            <h3>已保存的配置</h3>
            {credentials.length ? credentials.map((credential) => (
              <article key={credential.id}>
                <div><strong>{credential.name}</strong><span>{credential.provider} · {credential.model}</span><small>{credential.apiKeyMasked}</small></div>
                <div className="row-actions">
                  <button type="button" onClick={async () => { const response = await testCredential(credential.id); setMessage(response.message); }}><FileSearch size={15} />测试</button>
                  <button className="icon-button" type="button" title="编辑" onClick={() => editCredential(credential)}><Pencil size={15} /></button>
                  <button className="icon-button" disabled={credential.isDefault} type="button" title="设为默认" onClick={async () => { await updateCredential(credential.id, { isDefault: true }); await refresh(); }}><Star size={15} /></button>
                  <button className="icon-button" type="button" title="删除" onClick={async () => { await deleteCredential(credential.id); await refresh(); }}><Trash2 size={15} /></button>
                </div>
              </article>
            )) : <p>还没有配置 API Key。</p>}
          </section>
        </section>
      </div>
    );
  }

  async function refresh(includeSecondaryData = true) {
    const projectRequest = listProjects()
      .then((data) => {
        writeProjectHistoryCache(data.projects);
        setProjectListNotice(data.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
        return data;
      })
      .catch(() => {
        const cachedProjects = readProjectHistoryCache();
        setProjectListNotice(cachedProjects.length
          ? "Agent 暂时未连接，当前显示本机保存的最近项目；恢复连接后才能识别和运行。"
          : "Agent 暂时未连接，历史项目列表目前无法读取。");
        return { projects: cachedProjects };
      });
    const [
      credentialData,
      planData,
      scenarioData,
      capabilityData,
      deliveryData,
      patrolData,
      patrolPlanData,
      gapData,
      draftData,
      verificationData,
      projectData,
      securityData,
      benchmarkData
    ] = await Promise.all([
      listCredentials().catch(() => ({ credentials })),
      getGrayPlan().catch(() => plan),
      listScenarios().catch(() => ({ scenarios })),
      listPlatformCapabilities().catch(() => ({ capabilities })),
      listBotDeliveries().catch(() => ({ deliveries })),
      listPatrolJobs().catch(() => ({ jobs: patrolJobs })),
      listPatrolPlans().catch(() => ({ plans: [] })),
      listHarnessGaps().catch(() => ({ gaps: harnessGaps })),
      listScenarioDrafts().catch(() => ({ drafts: [] })),
      getLatestDemoVerification().catch(() => ({ verification: null })),
      projectRequest,
      getSecuritySummary().catch(() => ({ security: null })),
      getBenchmarkSummary().catch(() => null)
    ]);
    setCredentials(credentialData.credentials);
    setPlan(planData);
    setScenarios(scenarioData.scenarios);
    setCapabilities(capabilityData.capabilities);
    setDeliveries(deliveryData.deliveries);
    setPatrolJobs(patrolData.jobs);
    setPatrolPlans(patrolPlanData.plans);
    setHarnessGaps(gapData.gaps);
    setScenarioDrafts(draftData.drafts);
    setDemoVerification(verificationData.verification);
    setProjects(projectData.projects);
    setSecuritySummary(securityData.security);
    setBenchmarkSummary(benchmarkData);

    if (includeSecondaryData) {
      // These views touch the persistent audit store and can each take a
      // couple of seconds on a large local database. They are deliberately
      // excluded from the initial connection path and loaded sequentially on
      // an explicit refresh, so onboarding and project launch stay responsive.
      const auditData = await getAuditStoreStatus().catch(() => ({ auditStore: null }));
      setAuditStore(auditData.auditStore);
      const historyData = await listRunHistory({ limit: 100 }).catch(() => ({ runs: [] }));
      setRunHistory(historyData.runs);
      const storageData = await getStorageStatus().catch(() => ({ storage: null }));
      setStorageStatus(storageData.storage);
      const archiveData = await listStorageArchives().catch(() => ({ archives: [] }));
      setStorageArchives(archiveData.archives);
      const trendData = await getPatrolTrend({
        projectId: selectedProjectId || undefined,
        scenarioId
      }).catch(() => ({ trend: null }));
      setPatrolTrend(trendData.trend);
    }
    if (selectedProjectId) {
      const refreshedProject = projectData.projects.find((project) => project.id === selectedProjectId);
      // Credential bindings are persisted by the Agent. Keep an open
      // Workbench in sync after a binding is saved, rather than leaving a
      // stale in-memory draft to report that a key is still missing.
      if (refreshedProject) {
        setProjectDraft((current) => {
          if (!current || current.id !== refreshedProject.id) return current;
          const currentUpdatedAt = Date.parse(current.updatedAt ?? "");
          const refreshedUpdatedAt = Date.parse(refreshedProject.updatedAt ?? "");
          return Number.isFinite(refreshedUpdatedAt) && refreshedUpdatedAt > currentUpdatedAt
            ? refreshedProject
            : current;
        });
      }
      const grantData = await listProjectGrants(selectedProjectId).catch(() => ({ grants: [] }));
      setProjectGrants(grantData.grants);
      const runtimeData = await getProjectRuntime(selectedProjectId).catch(() => ({ runtime: null }));
      setProjectRuntime(runtimeData.runtime);
    }
  }

  async function refreshInputContext() {
    if (isRefreshingContext) return;
    setIsRefreshingContext(true);
    setContextRefreshStatus("正在重新扫描当前项目…");
    setMessage("正在刷新项目和测试上下文…");
    try {
      const [projectData, scenarioData, historyData, capabilityData] = await Promise.all([
        listProjects(),
        listScenarios(),
        listRunHistory({ limit: 100 }),
        listPlatformCapabilities()
      ]);
      writeProjectHistoryCache(projectData.projects);
      setProjectListNotice(projectData.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
      setProjects(projectData.projects);
      setScenarios(scenarioData.scenarios);
      setRunHistory(historyData.runs);
      setCapabilities(capabilityData.capabilities);
      const currentPath = projectDraft?.projectPath || projects.find((project) => project.id === selectedProjectId)?.projectPath;
      if (currentPath) {
        const response = await detectProject(currentPath);
        setProjectDetection(response.detection);
        if (response.detection.exists) {
          const suggested = response.detection.suggestedConfig;
          setProjectDraft((current) => current ? {
            ...current,
            installCommand: suggested.installCommand,
            startCommand: suggested.startCommand,
            processes: suggested.processes,
            healthCheckUrl: suggested.healthCheckUrl,
            frontendUrl: suggested.frontendUrl,
            backendUrl: suggested.backendUrl
          } : suggested);
          setAppUrl(suggested.frontendUrl);
        }
      }
      if (selectedProjectId) {
        const runtimeData = await getProjectRuntime(selectedProjectId);
        setProjectRuntime(runtimeData.runtime);
      }
      setContextRefreshStatus(`刷新完成 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
      setMessage("项目与测试上下文已刷新。");
    } catch (error) {
      const cachedProjects = readProjectHistoryCache();
      if (cachedProjects.length) setProjects(cachedProjects);
      setProjectListNotice(cachedProjects.length
        ? "Agent 暂时未连接，当前显示本机保存的最近项目；恢复连接后才能刷新。"
        : "Agent 暂时未连接，历史项目列表目前无法读取。");
      setContextRefreshStatus(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败");
      setMessage(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败");
    } finally {
      setIsRefreshingContext(false);
    }
  }

  useEffect(() => {
    initializeOidc()
      .then(async (session) => {
        setOidcAuthenticated(session.authenticated);
        if (session.configured && !session.authenticated) return;
        setProjectListNotice("正在连接 AI 测试服务…");
        await waitForAgentReady();
        await refresh(false);
      })
      .catch((error) => {
        setProjectListNotice("AI 测试服务暂时不可用，正在自动重连。");
        setMessage(error instanceof Error ? error.message : "AI 测试服务暂时不可用。");
      });
  }, []);

  useEffect(() => {
    if (!projectListNotice.includes("暂时") && !projectListNotice.includes("正在连接")) return;
    const interval = window.setInterval(() => {
      void listProjects()
        .then((data) => {
          writeProjectHistoryCache(data.projects);
          setProjects(data.projects);
          setProjectListNotice(data.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
          setMessage("AI 测试服务已恢复连接。");
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [projectListNotice]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const savedProject = projects.find((project) => project.id === selectedProjectId);
    if (!savedProject) return;
    setProjectDraft((current) => {
      if (!current || current.id !== savedProject.id) return current;
      const currentUpdatedAt = Date.parse(current.updatedAt ?? "");
      const savedUpdatedAt = Date.parse(savedProject.updatedAt ?? "");
      return Number.isFinite(savedUpdatedAt) && savedUpdatedAt > currentUpdatedAt
        ? savedProject
        : current;
    });
  }, [projects, selectedProjectId]);

  // OCI projects can legitimately spend a few minutes installing dependencies
  // in an empty, disposable sandbox. Keep this UI subscribed to the runtime
  // until it reaches a stable state instead of leaving an old “installing” or
  // recoverable “failed” card on screen after the initial polling window ends.
  useEffect(() => {
    if (!selectedProjectId) return;
    let disposed = false;
    const refreshRuntime = async () => {
      const snapshot = await getProjectRuntime(selectedProjectId).catch(() => null);
      if (!snapshot || disposed) return;
      setProjectRuntime(snapshot.runtime);
      if (
        snapshot.runtime.status === "running"
        && (!projectConnection?.ok || projectDiagnosis?.overallStatus !== "passed")
      ) {
        const [connection, diagnosis] = await Promise.all([
          testProjectConnection(selectedProjectId).catch(() => null),
          diagnoseProject(selectedProjectId).catch(() => null)
        ]);
        if (!disposed && connection) setProjectConnection(connection.result);
        if (!disposed && diagnosis) setProjectDiagnosis(diagnosis.diagnosis);
      }
    };
    void refreshRuntime();
    const interval = window.setInterval(() => void refreshRuntime(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [selectedProjectId, projectConnection?.ok, projectDiagnosis?.overallStatus]);

  useEffect(() => {
    if (!activeRunId || hydratedAgentThreads.current.has(activeRunId)) return;
    hydratedAgentThreads.current.add(activeRunId);
    void getRunKnowledge(activeRunId)
      .then((snapshot) => {
        const decisions = new Map(snapshot.decisions.map((item) => [item.id, item]));
        const durable = snapshot.messages.map((item): PlanningMessage => {
          const decision = item.knowledgeDecisionId
            ? decisions.get(item.knowledgeDecisionId)
            : undefined;
          return {
            id: item.id,
            role: item.role === "system" ? "assistant" : item.role,
            content: item.content,
            createdAt: item.createdAt,
            reasoningSummary: item.reasoningSummary,
            suggestedAction: item.suggestedAction as PlanningMessage["suggestedAction"],
            requiresConfirmation: item.requiresConfirmation,
            knowledge: decision?.output,
            llmTrace: item.llmCallId ? {
              callId: item.llmCallId,
              contextId: item.knowledgeContextId,
              decisionId: item.knowledgeDecisionId,
              validationStatus: decision?.validationStatus
            } : undefined
          };
        });
        if (!durable.length) return;
        setPlanningMessages((current) => {
          const ids = new Set(current.map((item) => item.id));
          return [...current, ...durable.filter((item) => !ids.has(item.id))]
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        });
      })
      .catch(() => {
        hydratedAgentThreads.current.delete(activeRunId);
      });
  }, [activeRunId]);

  useEffect(() => {
    if (!activeRunId) return;
    return subscribeRunEvents(activeRunId, ({ id, type, payload }) => {
      // Graph lifecycle frames carry the projection itself. `agent.interrupt.*`
      // is what turns a silently paused run into a visible decision request, so
      // it must be consumed here rather than polled.
      if (type.startsWith("agent.")) {
        const projection = payload as unknown as AgentGraphProjection;
        if (projection?.runId === activeRunId) {
          setAgentProjection(projection);
          if (projection.pendingInterrupt) setInterruptError(null);
        }
        return;
      }
      if (type !== "state") return;
      const event = payload as { id?: string; type?: string; createdAt?: string; payload?: Record<string, unknown> };
      const finished = ["run_completed", "run_failed", "run_blocked", "run_cancelled", "human_review_requested"].includes(event.type ?? "");
      setLiveRun((current) => {
        const eventId = event.id ?? id ?? `${activeRunId}:${event.type ?? "state"}`;
        const events = current?.events ?? [];
        const nextEvent = {
          id: `sse:${eventId}`,
          loopType: "run_state",
          iteration: Number(id ?? 0),
          title: event.type ?? "run_state",
          status: finished ? "completed" : "running",
          timestamp: event.createdAt ?? new Date().toISOString(),
          observation: JSON.stringify(event.payload ?? {}),
          evidenceRefs: []
        } satisfies RunResult["loopEvents"][number];
        return {
          ...current,
          runId: activeRunId,
          status: finished ? "finished" : "running",
          evidenceCount: current?.evidenceCount ?? 0,
          events: events.some((item) => item.id === nextEvent.id) ? events : [...events, nextEvent].slice(-100),
          evidence: current?.evidence ?? []
        };
      });
      void getRunProjection(activeRunId).then(({ run }) => setActiveRun(run)).catch(() => undefined);
    });
  }, [activeRunId]);

  /**
   * Hydrate the graph projection whenever the active run changes.
   *
   * SSE only delivers *future* frames. A run that was already interrupted —
   * because the operator reloaded the page or the service restarted — would
   * otherwise show no decision request at all and appear permanently stuck.
   * Polling continues while an interrupt is pending so a decision made in
   * another tab clears this one too.
   */
  useEffect(() => {
    if (!activeRunId) {
      setAgentProjection(null);
      setInterruptError(null);
      return;
    }
    let disposed = false;
    const hydrate = async () => {
      try {
        const { agent } = await getRunAgent(activeRunId);
        if (!disposed && agent?.runId === activeRunId) setAgentProjection(agent);
      } catch {
        // A run started before the graph was enabled has no projection. The
        // deterministic run view stays authoritative.
      }
    };
    void hydrate();
    const interval = window.setInterval(() => void hydrate(), 4_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activeRunId]);

  useEffect(() => {
    if (!activeRunId || !activeRun || ["completed", "failed", "blocked", "cancelled"].includes(activeRun.state)) return;
    let disposed = false;
    const refreshEvidence = async () => {
      try {
        const response = await getRunEvidence(activeRunId);
        if (disposed) return;
        const latestCapturedScreenshot = [...response.evidence]
          .reverse()
          .find((item) => item.type === "screenshot" && item.file)?.file;
        setLiveRun((current) => ({
          runId: activeRunId,
          status: "running",
          latestScreenshot: latestCapturedScreenshot ?? current?.latestScreenshot,
          latestEvent: response.loopEvents.at(-1) ?? current?.latestEvent,
          evidenceCount: response.evidence.length,
          // Browser loop events are the detailed execution source. Preserve
          // control-plane events only until the first detailed event arrives.
          events: response.loopEvents.length ? response.loopEvents : (current?.events ?? []),
          evidence: response.evidence
        }));
      } catch {
        // The evidence store may not exist until the worker has started the
        // first attempt. SSE remains the source of run state while we wait.
      }
    };
    void refreshEvidence();
    const interval = window.setInterval(() => void refreshEvidence(), 900);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activeRunId, activeRun?.state]);

  useEffect(() => {
    const deterministicNoticeRequired = authFeedbackRequired
      || credentialReadyForRetry
      || apiCredentialFeedbackRequired
      || screenshotRateLimited;
    if (!deterministicNoticeRequired) return;
    const noticeKey = [
      activeRunId ?? selectedProjectId ?? projectDraft?.id ?? "pre-run",
      runAssistantMessage
    ].join(":");
    if (surfacedAssistantNotices.current.has(noticeKey)) return;
    surfacedAssistantNotices.current.add(noticeKey);
    setPlanningMessages((current) => [...current, {
      id: `assistant_notice_${Date.now()}`,
      role: "assistant",
      content: runAssistantMessage,
      createdAt: new Date().toISOString(),
      reasoningSummary: {
        phase: authFeedbackRequired || apiCredentialFeedbackRequired ? "waiting-user" : "diagnosing",
        observations: [
          authFeedbackRequired
            ? "测试到达需要登录的页面，但当前运行没有可用的测试账号"
            : apiCredentialFeedbackRequired
              ? `被测项目声明需要 ${missingProjectApiCredentials.map((item) => item.envName).join("、")}`
              : credentialReadyForRetry
                ? "测试账号已经加密保存"
                : "现场截图请求触发限流，上一帧证据仍然保留"
        ],
        assessment: runAssistantMessage,
        nextStep: authFeedbackRequired
          ? "获得测试账号句柄后恢复同一测试线程"
          : apiCredentialFeedbackRequired
            ? "获得项目凭据授权后仅向本次沙盒运行注入"
            : credentialReadyForRetry
              ? "使用新账号创建可追溯的重试 attempt"
              : "自动退避并继续采集其他证据",
        userAction: authFeedbackRequired
          ? "请点击“配置测试账号”，不要在对话中粘贴密码。"
          : apiCredentialFeedbackRequired
            ? "请选择沿用测试模型凭据或单独的项目测试凭据。"
            : credentialReadyForRetry
              ? "点击“使用账号重新测试”即可继续。"
              : "无需操作；持续超过一分钟时再打开证据详情。",
        confidence: "high"
      }
    }]);
  }, [
    activeRunId,
    selectedProjectId,
    projectDraft?.id,
    authFeedbackRequired,
    credentialReadyForRetry,
    apiCredentialFeedbackRequired,
    screenshotRateLimited,
    runAssistantMessage,
    missingProjectApiCredentials
  ]);

  useEffect(() => {
    const needsExplanation = runIsBlocked || reviewRequired || pathBindingRepairable;
    const analysisId = activeRunId ?? result?.id ?? planningResult?.id;
    const projectId = selectedProjectId || projectDraft?.id;
    if (!needsExplanation || !analysisId || !defaultCredential?.id || !projectId || assistantChatBusy) return;
    const analysisKey = [
      analysisId,
      latestDecision,
      planningAutomation.phase,
      result?.summary ?? planningAutomation.detail
    ].join(":");
    if (analyzedBlockedRuns.current.has(analysisKey)) return;
    analyzedBlockedRuns.current.add(analysisKey);
    const messageId = `run_failure_analysis_${Date.now()}`;
    setPlanningMessages((current) => [...current, {
      id: messageId,
      role: "assistant",
      content: "正在读取机器结论、失败证据和已有修复记录，整理这次问题与下一步操作…",
      createdAt: new Date().toISOString()
    }]);
    setAssistantChatBusy(true);
    const failurePacket = {
      finalStatus: result?.finalStatus ?? result?.gateStatus ?? latestDecision ?? "blocked",
      summary: result?.summary ?? planningAutomation.detail,
      executionError: result?.executionError,
      failedAssertions: (result?.assertions ?? [])
        .filter((item) => !item.passed)
        .slice(0, 8)
        .map((item) => ({ name: item.name, expected: item.expected, actual: item.actual, evidenceRefs: item.fact?.evidenceRefs ?? [] })),
      failureAttributions: (result?.failureAttributions ?? []).slice(0, 4).map((item) => ({
        title: item.title,
        reasoning: item.reasoning,
        suggestedFix: item.suggestedFix
      })),
      latestRuntimeLogs: (result?.loopEvents ?? []).slice(-6).map((item) => ({
        title: item.title,
        status: item.status,
        observation: item.observation,
        evidenceRefs: item.evidenceRefs
      })),
      planning: {
        phase: planningAutomation.phase,
        detail: planningAutomation.detail,
        discovered: planningResult?.coverage.discovered,
        executable: planningResult?.coverage.executable,
        autoBindable: planningResult?.coverage.autoBindable,
        gaps: planningResult?.coverage.gaps
      }
    };
    const diagnosisPrompt = "请解释当前运行卡点：发生了什么、系统准备如何处理、我是否需要操作。只依据已保存的运行事实和证据回答。";
    const useDurableRunThread = Boolean(activeRunId && result && !pathBindingRepairable);
    void (async () => {
      if (useDurableRunThread && activeRunId) {
        const response = await sendRunAgentMessage(activeRunId, {
          message: diagnosisPrompt,
          credentialId: defaultCredential.id,
          origin: "system-diagnosis"
        });
        setPlanningMessages((current) => current.map((item) =>
          item.id === messageId
            ? {
              ...item,
              content: response.assistant.reply,
              repairPlan: response.assistant.repairPlan,
              reasoningSummary: response.assistant.reasoningSummary,
              knowledge: response.assistant.knowledge,
              suggestedAction: response.assistant.suggestedAction,
              requiresConfirmation: response.assistant.requiresConfirmation,
              llmTrace: {
                callId: response.call.id,
                model: response.call.model,
                provider: response.call.provider,
                durationMs: response.call.durationMs,
                totalTokens: response.call.usage?.totalTokens,
                semanticRepairApplied: response.call.semanticRepairApplied,
                status: response.call.status,
                fallbackApplied: response.call.fallbackApplied,
                errorCode: response.call.errorCode,
                contextId: response.call.knowledgeContextId,
                decisionId: response.call.knowledgeDecisionId,
                validationStatus: response.call.knowledgeValidationStatus
              }
            }
            : item
        ));
        if (response.assistant.suggestedAction !== "none") {
          setAssistantSuggestedAction({
            action: response.assistant.suggestedAction,
            label: assistantActionLabel(response.assistant.suggestedAction)
          });
        }
        return;
      }
      const response = await chatWithTestAssistant({
        projectId,
        message: diagnosisPrompt,
        credentialId: defaultCredential.id,
        history: planningMessages.slice(-6).map((item) => ({
          role: item.role,
          content: boundedAssistantText(item.content, 1_500)
        })),
        context: {
          runState: planningAutomation.phase,
          finalStatus: result?.finalStatus ?? result?.gateStatus ?? latestDecision,
          summary: boundedAssistantText(result?.summary ?? planningAutomation.detail, 1_200),
          evidenceCount: liveRun?.evidenceCount ?? result?.evidence.length ?? 0,
          currentStep: boundedAssistantText(result?.executionError?.stepId ?? planningAutomation.phase, 300),
          latestLog: boundedAssistantText(result?.executionError?.message ?? planningAutomation.detail, 700),
          pageObservation: discovery?.observation,
          failedAssertions: failurePacket.failedAssertions.map((item) => ({
            name: boundedAssistantText(item.name, 240),
            expected: boundedAssistantText(item.expected, 500),
            actual: boundedAssistantText(item.actual, 500)
          })),
          planning: planningResult ? {
            discovered: planningResult.coverage.discovered,
            executable: planningResult.coverage.executable,
            autoBindable: planningResult.coverage.autoBindable,
            confirmed: planningConfirmed,
            failures: automationFailures.map((failure) => ({
              title: failure.title,
              target: failure.target ?? failure.scenarioId,
              stage: failure.stage,
              detail: boundedAssistantText(failure.detail, 1_000),
              requiredInformation: failure.requiredInformation?.slice(0, 8) ?? []
            })),
            blockingQuestions: planningResult.clarificationQuestions.slice(0, 8)
          } : undefined
        }
      });
      setPlanningMessages((current) => current.map((item) =>
        item.id === messageId
          ? {
            ...item,
            content: response.assistant.reply,
            repairPlan: response.assistant.repairPlan,
            reasoningSummary: response.assistant.reasoningSummary,
            knowledge: response.assistant.knowledge,
            suggestedAction: response.assistant.suggestedAction,
            requiresConfirmation: response.assistant.requiresConfirmation,
            llmTrace: {
              callId: response.call.id,
              model: response.call.model,
              provider: response.call.provider,
              durationMs: response.call.durationMs,
              totalTokens: response.call.usage.totalTokens,
              semanticRepairApplied: response.call.semanticRepairApplied,
              status: response.call.status,
              fallbackApplied: response.call.fallbackApplied,
              errorCode: response.call.errorCode,
              contextId: response.call.knowledgeContextId,
              decisionId: response.call.knowledgeDecisionId,
              validationStatus: response.call.knowledgeValidationStatus
            }
          }
          : item
      ));
      if (response.assistant.suggestedAction !== "none") {
        setAssistantSuggestedAction({
          action: response.assistant.suggestedAction,
          label: assistantActionLabel(response.assistant.suggestedAction)
        });
      }
    })().catch((error) => {
      // A transient Agent/model outage must not permanently suppress the
      // automatic explanation for this same blocked state. The next stable
      // render may retry after the service becomes ready.
      analyzedBlockedRuns.current.delete(analysisKey);
      const reason = error instanceof Error ? error.message : "模型调用失败";
      setPlanningMessages((current) => current.map((item) =>
        item.id === messageId
          ? {
            ...item,
            content: userFacingAssistantError(error),
            reasoningSummary: {
              phase: "waiting-user",
              observations: [
                concreteRunFailureMessage || "失败事实和证据已经保存",
                "模型解释请求未成功，技术原因已记录"
              ],
              assessment: "模型服务未返回有效解释；系统仍以确定性断言、证据完整性和机器门禁作为当前事实。",
              nextStep: "其他独立路径继续执行；失败链路保持待诊断状态，不会被自动放行。",
              userAction: /401|403|credential|api key/i.test(reason)
                ? "请检查当前模型凭据后，在对话框中要求重新分析。"
                : "你可以直接追问、打开证据或稍后重试 AI 分析。",
              confidence: "high"
            }
          }
          : item
      ));
    }).finally(() => {
      setAssistantChatBusy(false);
    });
  }, [
    activeRunId,
    result?.id,
    runIsBlocked,
    reviewRequired,
    pathBindingRepairable,
    defaultCredential?.id,
    selectedProjectId,
    projectDraft?.id,
    planningAutomation.phase,
    planningAutomation.detail,
    latestDecision,
    assistantChatBusy
  ]);

  async function submitCredential(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const payload = {
      name: form.name,
      provider: form.provider,
      baseUrl: form.baseUrl,
      model: form.model,
      tags: form.tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      owner: optionalTrim(form.owner),
      scopes: form.scopes
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      isDefault: form.isDefault
    };
    if (editingCredentialId) {
      await updateCredential(editingCredentialId, form.apiKey ? { ...payload, apiKey: form.apiKey } : payload);
      setEditingCredentialId(null);
      setMessage("API Key 配置已更新。");
    } else {
      await createCredential({
        ...payload,
        apiKey: form.apiKey
      });
      setMessage("API Key 已保存到本地加密配置。");
    }
    setForm((current) => ({ ...current, apiKey: "" }));
    await refresh();
    setCredentialFormOpen(false);
  }

  function editCredential(credential: Credential) {
    setEditingCredentialId(credential.id);
    setCredentialFormOpen(true);
    setForm({
      name: credential.name,
      provider: credential.provider,
      baseUrl: credential.baseUrl,
      apiKey: "",
      model: credential.model,
      tags: credential.tags.join(","),
      owner: credential.owner ?? "local-dev",
      scopes: (credential.scopes ?? ["judge", "planning"]).join(","),
      isDefault: credential.isDefault
    });
    setMessage("正在编辑 API Key 元数据；不填写新 Key 时会保留原 Key。");
  }

  function cancelEdit() {
    setEditingCredentialId(null);
    setCredentialFormOpen(false);
    setForm({
      name: "OpenAI Main",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4.1",
      tags: "llm,default",
      owner: "local-dev",
      scopes: "judge,planning",
      isDefault: true
    });
  }

  function recipients() {
    return notifyList
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function optionalTrim(value: string) {
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  function hasRemoteConnectorInput() {
    return Boolean(
      optionalTrim(requirementUrl) ||
      optionalTrim(bugTicketUrl) ||
      optionalTrim(openApiUrl) ||
      optionalTrim(prDiffUrl) ||
      optionalTrim(prUrl)?.startsWith("http")
    );
  }

  function connectorInput() {
    const reqUrl = optionalTrim(requirementUrl);
    const bugUrl = optionalTrim(bugTicketUrl);
    const apiUrl = optionalTrim(openApiUrl);
    return {
      requirementPath: reqUrl ? undefined : optionalTrim(requirementPath),
      requirementUrl: reqUrl,
      bugTicketPath: bugUrl ? undefined : optionalTrim(bugTicketPath),
      bugTicketUrl: bugUrl,
      openApiPath: apiUrl ? undefined : optionalTrim(openApiPath),
      openApiUrl: apiUrl,
      prUrl: optionalTrim(prUrl),
      prDiffUrl: optionalTrim(prDiffUrl),
      fallbackDiff: strictInput ? undefined : diffText,
      strictInput
    };
  }

  function selectProject(projectId: string) {
    generationRequestRef.current?.controller.abort();
    generationRequestRef.current = null;
    // Invalidate an in-flight startup/diagnosis operation. Its network work
    // may finish, but it must never write the previous project's state into
    // the newly selected project.
    diagnosisOperationRef.current = null;
    // A project picker is configuration-only. Do not let an already-running
    // runtime auto-mount an iframe and reflow the centre test canvas.
    setPreviewSessionProjectId("");
    // The execution preview belongs to the previous project/session. Closing
    // it here prevents a stale run surface from covering the next project.
    setRunPreviewModalOpen(false);
    if (!projectId) {
      setSelectedProjectId("");
      setProjectDraft(null);
      setProjectPathInput("");
      setAppUrl("");
      setProjectDetection(null);
      setProjectDetectMessage("");
      setProjectDiagnosis(null);
      setProjectConnection(null);
      setProjectRuntime(null);
      setProjectGrants([]);
      resetPlanningConversation();
      return;
    }
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    // A project owns its plan, run and report. Clearing these immediately
    // prevents the previous project's evidence from surviving while the new
    // project metadata is still loading.
    setPlan(null);
    setResult(null);
    setActiveRunId(null);
    setActiveRun(null);
    setAnalysis(null);
    resetPlanningConversation();
    if (project) {
      setProjectDraft(project);
      setProjectPathInput(project.projectPath);
      setAppUrl(project.frontendUrl);
      setProjectConnection(null);
      setProjectRuntime(null);
      setProjectDiagnosis(null);
      setProjectDetection(null);
      setProjectDetectMessage("");
      detectProject(project.projectPath)
        .then((response) => {
          setProjectDetection(response.detection);
          const detected = response.detection.suggestedConfig;
          const isSystemFixture = new Set([
            "customer_portal_lite",
            "investment_agent_workflow_external",
            "local_demo_app",
            "order_portal_lite",
            "todo_lite"
          ]).has(projectId);
          if (!project.allowExternalProjectPath || isSystemFixture) return;
          setAppUrl(detected.frontendUrl);
          setProjectDraft((current) => current?.id === projectId ? {
            ...current,
            installCommand: detected.installCommand,
            installCommandSpec: detected.installCommandSpec,
            startCommand: detected.startCommand,
            startCommandSpec: detected.startCommandSpec,
            processes: detected.processes,
            // Re-detection must update the whole launch contract.  Keeping an
            // older health URL here meant a correctly discovered workspace
            // command could still be checked against a stale Vite port.
            frontendUrl: detected.frontendUrl,
            backendUrl: detected.backendUrl,
            healthCheckUrl: detected.healthCheckUrl,
            // Re-detection may refine capabilities, but it must not silently
            // discard credentials or change the execution boundary that the
            // user explicitly saved for this project.
            login: current.login ?? detected.login ?? { method: "none" },
            apiCredentialRequirements: detected.apiCredentialRequirements ?? [],
            apiCredentialBindings: current.apiCredentialBindings ?? [],
            manifest: detected.manifest ? {
              ...detected.manifest,
              environmentAllowlist: Array.from(new Set([
                ...detected.manifest.environmentAllowlist,
                ...(current.manifest?.environmentAllowlist ?? [])
              ])),
              execution: current.allowExternalProjectPath
                ? { ...detected.manifest.execution, mode: "oci" }
                : current.manifest?.execution ?? detected.manifest.execution
            } : current.manifest
          } : current);
        })
        .catch(() => setProjectDetection(null))
        .finally(() => dispatchWorkspace({ type: "project-loaded", projectId }));
      getProjectRuntime(projectId)
        .then((response) => setProjectRuntime(response.runtime))
        .catch(() => setProjectRuntime(null));
      listProjectGrants(projectId).then((response) => setProjectGrants(response.grants)).catch(() => setProjectGrants([]));
      getPatrolTrend({ projectId, scenarioId }).then((response) => setPatrolTrend(response.trend)).catch(() => setPatrolTrend(null));
    } else {
      dispatchWorkspace({ type: "project-loaded", projectId });
    }
  }

  async function detectCurrentProjectPath(selection: {
    rootName: string;
    absolutePath?: string;
    files: Array<{ relativePath: string; content?: string }>;
  }) {
    resetPlanningConversation();
    setProjectDetectMessage("");
    setMessage("正在识别项目类型、命令和端口。");
    try {
      const response = selection.absolutePath
        ? await detectProject(selection.absolutePath)
        : await detectProjectManifest({ rootName: selection.rootName, files: selection.files });
      setProjectDetection(response.detection);
      if (response.detection.exists) {
        const suggested = { ...response.detection.suggestedConfig, allowExternalProjectPath: true };
        setProjectDraft(suggested);
        setSelectedProjectId(response.detection.executionReady === false ? "" : suggested.id);
        setProjectPathInput(suggested.projectPath);
        setAppUrl(suggested.frontendUrl);
        if (response.detection.executionReady === false) {
          setProjectDetectMessage("项目类型已识别，但浏览器无法读取本机完整路径。请在下面的 Target Project 中粘贴项目完整路径后保存。");
          setMessage("项目类型已识别，仍需补充可执行路径。");
        } else {
          setProjectDetectMessage("识别成功，已同步到下面的 Target Project。请检查后保存配置。");
          setMessage("项目识别完成，Target Project 已更新。");
        }
      } else {
        setProjectDetectMessage("没有找到项目：请确认选择的是项目根目录，并检查 Agent 是否正在运行。");
        setMessage("项目路径不可读，请检查文件夹。");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "项目识别失败";
      setProjectDetectMessage(`识别失败：${detail}。请先启动 Agent 服务后重试。`);
      setMessage(detail);
    }
  }

  async function diagnoseAndRunCurrentProject(override?: ProjectConfig) {
    const selectedCandidate = override ?? projectDraft ?? projectDetection?.suggestedConfig;
    if (!selectedCandidate) {
      setMessage("请先识别或选择一个项目。");
      return;
    }
    const diagnosisOperationId = crypto.randomUUID();
    diagnosisOperationRef.current = {
      id: diagnosisOperationId,
      projectId: selectedCandidate.id
    };
    const isCurrentDiagnosis = () => diagnosisOperationRef.current?.id === diagnosisOperationId;
    const detectedCandidate = projectDetection?.suggestedConfig;
    const canApplyDetectedLaunch = Boolean(
      detectedCandidate
      && selectedCandidate.allowExternalProjectPath
      && detectedCandidate.projectPath === selectedCandidate.projectPath
    );
    const candidate: ProjectConfig = canApplyDetectedLaunch ? {
      ...selectedCandidate,
      installCommand: detectedCandidate!.installCommand,
      installCommandSpec: detectedCandidate!.installCommandSpec,
      startCommand: detectedCandidate!.startCommand,
      startCommandSpec: detectedCandidate!.startCommandSpec,
      processes: detectedCandidate!.processes,
      frontendUrl: detectedCandidate!.frontendUrl,
      backendUrl: detectedCandidate!.backendUrl,
      healthCheckUrl: detectedCandidate!.healthCheckUrl,
      manifest: detectedCandidate!.manifest ? {
        ...detectedCandidate!.manifest,
        execution: selectedCandidate.allowExternalProjectPath
          ? { ...detectedCandidate!.manifest.execution, mode: "oci" }
          : selectedCandidate.manifest?.execution ?? detectedCandidate!.manifest.execution
      } : selectedCandidate.manifest
    } : selectedCandidate;
    setProjectConnection(null);
    setProjectDiagnosis(null);
    setRuntimeRecoveryAdvice(null);
    setProjectLaunchPhase("正在确认项目设置…");
    setMessage("正在保存设置、启动项目并检查运行条件。");
    try {
      if (projectDetection?.executionReady === false) {
        setProjectLaunchPhase("正在确认项目文件夹…");
        const verified = await detectProject(candidate.projectPath);
        if (!isCurrentDiagnosis()) return;
        if (!verified.detection.exists) {
          setMessage("项目路径不可访问，请重新选择项目文件夹。");
          return;
        }
        setProjectDetection(verified.detection);
      }
      setProjectLaunchPhase("正在保存运行设置…");
      const saved = await saveProject({
        ...candidate,
        allowExternalProjectPath: candidate.allowExternalProjectPath ?? true
      });
      if (!isCurrentDiagnosis()) return;
      diagnosisOperationRef.current = { id: diagnosisOperationId, projectId: saved.project.id };
      setProjectDraft(saved.project);
      setSelectedProjectId(saved.project.id);
      setProjectPathInput(saved.project.projectPath);
      setAppUrl(saved.project.frontendUrl);

      setProjectLaunchPhase("正在请求 Agent 启动项目…");
      const accepted = await startProjectAsync(saved.project.id);
      if (!isCurrentDiagnosis()) return;
      setProjectRuntime(accepted.runtime);
      setProjectLaunchPhase("启动任务已提交，正在等待项目响应…");
      const sandboxPrepareTimeout = saved.project.manifest?.execution.mode === "oci"
        ? (saved.project.manifest.budget.prepareTimeoutMs ?? 300_000)
        : 0;
      const startupDeadline = Date.now()
        + sandboxPrepareTimeout
        + Math.max(saved.project.timeoutMs ?? 30_000, 30_000)
        + 10_000;
      let startedRuntime = accepted.runtime;
      let missedRuntimePolls = 0;
      while (Date.now() < startupDeadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (!isCurrentDiagnosis()) return;
        const snapshot = await getProjectRuntime(saved.project.id).catch(() => null);
        if (!isCurrentDiagnosis()) return;
        if (!snapshot) {
          missedRuntimePolls += 1;
          setProjectLaunchPhase(missedRuntimePolls > 1 ? "Agent 暂时断开，正在自动重连…" : "正在同步启动状态…");
          continue;
        }
        missedRuntimePolls = 0;
        setProjectLaunchPhase(
          snapshot.runtime.status === "installing"
            ? "正在安装项目依赖…"
            : snapshot.runtime.status === "starting"
              ? "正在等待项目启动…"
              : "正在确认项目运行状态…"
        );
        setProjectRuntime(snapshot.runtime);
        startedRuntime = snapshot.runtime;
        if (!["idle", "installing", "starting"].includes(snapshot.runtime.status)) break;
      }
      setProjectRuntime(startedRuntime);
      if (startedRuntime.status !== "running") {
        setProjectLaunchPhase("正在汇总失败诊断…");
        const diagnosed = await diagnoseProject(saved.project.id).catch(() => null);
        if (!isCurrentDiagnosis()) return;
        if (diagnosed) setProjectDiagnosis(diagnosed.diagnosis);
        let recoveryAdvice: RuntimeRecoveryAdvice | null = null;
        if (defaultCredential) {
          setProjectLaunchPhase("正在使用 AI 分析启动日志…");
          const recovery = await getAiStartRecovery(saved.project.id, defaultCredential.id).catch(() => null);
          if (!isCurrentDiagnosis()) return;
          if (recovery) {
            recoveryAdvice = recovery.advice;
            setRuntimeRecoveryAdvice(recovery.advice);
          }
        }
        const failureMessage = startedRuntime.message ?? "项目启动失败，请查看诊断结果。";
        setPlanningAutomation({ phase: "blocked", detail: failureMessage });
        setMessage(failureMessage);
        void surfaceProjectDiagnosticToAssistant({
          project: saved.project,
          runtime: startedRuntime,
          diagnosis: diagnosed?.diagnosis,
          recoveryAdvice
        });
        return;
      }

      const [tested, diagnosed] = await Promise.all([
        testProjectConnection(saved.project.id),
        diagnoseProject(saved.project.id)
      ]);
      if (!isCurrentDiagnosis()) return;
      setProjectConnection(tested.result);
      setProjectDiagnosis(diagnosed.diagnosis);
      const readyForPlanning = tested.result.ok && diagnosed.diagnosis.overallStatus === "passed";
      if (readyForPlanning) {
        setPreviewSessionProjectId(saved.project.id);
        closeDrawers();
      }
      setMessage(
        readyForPlanning
          ? "项目已准备好。请在 AI 测试助手中描述你想验证的内容。"
          : diagnosed.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage
            ?? tested.result.message
      );
      if (!readyForPlanning) {
        const failureMessage = diagnosed.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage
          ?? tested.result.message;
        setPlanningAutomation({ phase: "blocked", detail: failureMessage });
        void surfaceProjectDiagnosticToAssistant({
          project: saved.project,
          runtime: startedRuntime,
          diagnosis: diagnosed.diagnosis,
          connection: tested.result
        });
      }
    } catch (error) {
      if (!isCurrentDiagnosis()) return;
      const detail = error instanceof Error ? error.message : "项目诊断失败";
      const failedRuntime: ProjectRuntimeStatus = {
        projectId: selectedCandidate.id,
        status: "failed",
        phase: "failed",
        updatedAt: new Date().toISOString(),
        failureReason: "unknown",
        message: detail
      };
      setProjectRuntime(failedRuntime);
      setPlanningAutomation({ phase: "blocked", detail });
      setMessage(detail);
      void surfaceProjectDiagnosticToAssistant({
        project: candidate,
        runtime: failedRuntime
      });
    } finally {
      if (isCurrentDiagnosis()) {
        setProjectLaunchPhase("");
        diagnosisOperationRef.current = null;
      }
    }
  }

  async function surfaceProjectDiagnosticToAssistant(input: {
    project: ProjectConfig;
    runtime: ProjectRuntimeStatus;
    diagnosis?: ProjectDiagnosis;
    connection?: ProjectHealthCheckResult;
    recoveryAdvice?: RuntimeRecoveryAdvice | null;
  }) {
    const failedStages = (input.diagnosis?.stages ?? [])
      .filter((stage) => stage.status === "failed" || stage.status === "warning");
    const diagnosticKey = [
      input.project.id,
      input.runtime.updatedAt ?? "runtime-unknown",
      input.diagnosis?.checkedAt ?? "diagnosis-unknown",
      input.connection?.checkedAt ?? "connection-unknown",
      input.runtime.failureReason ?? input.runtime.status,
      failedStages.map((stage) => `${stage.stage}:${stage.reason}`).join("|")
    ].join(":");
    if (surfacedProjectDiagnostics.current.has(diagnosticKey)) return;
    surfacedProjectDiagnostics.current.add(diagnosticKey);

    const pendingId = `project_diagnostic_${Date.now()}`;
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: "正在读取项目启动阶段、健康检查和脱敏日志，整理失败原因与下一步…",
      createdAt: new Date().toISOString()
    }]);

    const firstFailure = failedStages[0];
    const failureText = boundedAssistantText(
      firstFailure?.humanMessage
        || input.runtime.message
        || input.connection?.message
        || "项目尚未进入可测试状态",
      1_200
    );
    const missingEnv = failedStages.flatMap((stage) => stage.missingEnv ?? []);
    const ports = failedStages.flatMap((stage) => stage.portConflicts ?? []).map((item) => item.port);
    const deterministicReply = [
      `遇到的问题：${failureText}`,
      `系统已经做了什么：已保存项目启动阶段、连接检查和脱敏诊断。自动化测试尚未开始，因此不会把环境失败误报为产品缺陷。${input.recoveryAdvice?.summary ? ` AI 启动诊断：${boundedAssistantText(input.recoveryAdvice.summary, 500)}` : ""}`,
      `需要你做什么：${missingEnv.length
        ? `请在项目凭据配置中补齐 ${missingEnv.slice(0, 4).join("、")}，不要在对话中粘贴密钥。`
        : ports.length
          ? `系统可以重新分配沙盒端口；当前冲突端口为 ${ports.slice(0, 4).join("、")}。`
          : input.runtime.failureReason === "container_runtime_unavailable"
            ? "请允许系统启动 Docker Desktop 或 Podman；沙盒就绪后再重试。"
            : "无需猜测配置；可以继续问我“具体失败在哪一步”，或修正设置后重新诊断。"}`
    ].join("\n");

    try {
      const response = await chatWithTestAssistant({
        projectId: input.project.id,
        message: "请依据项目当前启动状态和诊断结果，用简单中文说明：发生了什么、系统已经做了什么、用户需要做什么。",
        credentialId: defaultCredential?.id,
        history: planningMessages.slice(-6).map((item) => ({
          role: item.role,
          content: boundedAssistantText(item.content, 1_200)
        })),
        context: {
          runState: `project-${input.runtime.status}`,
          finalStatus: "blocked",
          summary: boundedAssistantText(failureText, 1_200),
          evidenceCount: 0,
          currentStep: boundedAssistantText(input.runtime.phase ?? firstFailure?.stage ?? "project-startup", 300),
          latestLog: boundedAssistantText(input.runtime.message ?? input.connection?.message ?? failureText, 700),
          pageObservation: discovery?.observation,
          failedAssertions: []
        }
      });
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: response.assistant.reply,
        repairPlan: response.assistant.repairPlan,
        reasoningSummary: response.assistant.reasoningSummary,
        knowledge: response.assistant.knowledge,
        suggestedAction: response.assistant.suggestedAction,
        requiresConfirmation: response.assistant.requiresConfirmation,
        llmTrace: {
          callId: response.call.id,
          model: response.call.model,
          provider: response.call.provider,
          durationMs: response.call.durationMs,
          totalTokens: response.call.usage.totalTokens,
          semanticRepairApplied: response.call.semanticRepairApplied,
          status: response.call.status,
          fallbackApplied: response.call.fallbackApplied,
          errorCode: response.call.errorCode,
          contextId: response.call.knowledgeContextId,
          decisionId: response.call.knowledgeDecisionId,
          validationStatus: response.call.knowledgeValidationStatus
        }
      } : item));
    } catch (error) {
      surfacedProjectDiagnostics.current.delete(diagnosticKey);
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: `模型解读暂时不可用；以下内容来自项目启动器和健康检查的确定性诊断。\n${deterministicReply}`,
        reasoningSummary: {
          phase: "waiting-user",
          observations: [failureText],
          assessment: "项目启动或连接条件未通过，正式测试尚未开始。",
          nextStep: "保留诊断并等待项目运行条件恢复后重试。",
          userAction: deterministicReply.split("需要你做什么：")[1] ?? "修正设置后重新诊断。",
          confidence: "high"
        },
        llmTrace: {
          callId: `project_diagnostic_fallback_${Date.now()}`,
          provider: "deterministic",
          model: "project-startup-diagnostics",
          status: "failed",
          fallbackApplied: true,
          errorCode: error instanceof Error && /truncat/i.test(error.message)
            ? "assistant_output_truncated"
            : "assistant_bridge_unavailable"
        }
      } : item));
    }
  }

  async function applyAiRecoveryCandidate(candidateId: string) {
    const adviceCandidate = runtimeRecoveryAdvice?.candidates.find((item) => item.id === candidateId);
    const current = projectDraft ?? projectDetection?.suggestedConfig;
    if (!adviceCandidate || !current) return;
    const parts = adviceCandidate.command.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || !["npm", "pnpm", "yarn", "node", "python", "python3", "uv", "uvicorn"].includes(parts[0])) {
      setMessage("AI 返回的候选启动方式未通过本地 allowlist 校验。");
      return;
    }
    const commandSpec = { executable: parts[0], args: parts.slice(1), timeoutMs: 300_000 };
    const targetUrl = adviceCandidate.frontendUrl;
    const recovered: ProjectConfig = current.processes?.length
      ? {
        ...current,
        frontendUrl: targetUrl ?? current.frontendUrl,
        healthCheckUrl: targetUrl ?? current.healthCheckUrl,
        processes: current.processes.map((process, index) => index === 0
          ? { ...process, command: adviceCandidate.command, commandSpec, healthCheckUrl: targetUrl ?? process.healthCheckUrl }
          : process)
      }
      : { ...current, startCommand: adviceCandidate.command, startCommandSpec: commandSpec, frontendUrl: targetUrl ?? current.frontendUrl, healthCheckUrl: targetUrl ?? current.healthCheckUrl };
    setProjectDraft(recovered);
    setRuntimeRecoveryAdvice(null);
    await diagnoseAndRunCurrentProject(recovered);
  }

  async function saveCurrentProjectLoginCredential(input: {
    username: string;
    password: string;
    usernameEnv: string;
    passwordEnv: string;
  }) {
    if (!projectDraft) throw new Error("请先识别项目。");
    const prepared = await saveProject({
      ...projectDraft,
      login: {
        ...projectDraft.login,
        method: "env",
        usernameEnv: input.usernameEnv,
        passwordEnv: input.passwordEnv
      }
    });
    const response = await saveProjectLoginCredential(prepared.project.id, input);
    setProjectDraft(response.project);
    setSelectedProjectId(response.project.id);
    setRevealProjectLoginSettings(false);
    if (authBlockDetected) {
      setMessage("测试账号已加密保存，正在使用新账号恢复自动化测试。");
      window.setTimeout(() => {
        void retryWithConfiguredLogin(response.project);
      }, 0);
    } else {
      setMessage("测试账号已加密保存，运行时会自动注入沙盒。");
    }
    return response.project;
  }

  async function savePreparationLoginAndContinue() {
    if (!preparationRequiresLogin) {
      setPlanningAutomation({ phase: "preparing-project", detail: "正在检查沙盒、项目服务和测试路径。" });
      return;
    }
    if (projectDraft?.login?.credentialId && !preparationLoginUsername.trim() && !preparationLoginPassword) {
      setPreparationLoginError("");
      setPlanningAutomation({
        phase: !permissionProfile.observe || !permissionProfile.browserControl ? "needs-permission" : "preparing-project",
        detail: !permissionProfile.observe || !permissionProfile.browserControl
          ? "先允许本次浏览器操作，授权后系统会按顺序准备和执行测试。"
          : "正在检查沙盒、项目服务和测试路径。"
      });
      if (!permissionProfile.observe || !permissionProfile.browserControl) return;
      const activePlan = planningResult;
      if (activePlan?.recommendedScenarioId && selectedProjectExecutionMode !== "oci") {
        setScenarioId(activePlan.recommendedScenarioId);
        await executeConfirmedScenarioAutomatically(activePlan.recommendedScenarioId);
      } else {
        await continueAutomaticPlanning(permissionProfile, projectDraft ?? undefined, activePlan ?? undefined);
      }
      return;
    }
    if (!projectDraft) {
      setPreparationLoginError("项目配置尚未保存，请先完成项目接入。");
      return;
    }
    if (!preparationLoginUsername.trim() || !preparationLoginPassword) {
      setPreparationLoginError("本次计划包含登录步骤，请填写测试账号和测试密码，或先配置已保存的测试账号。");
      return;
    }
    setPreparationLoginSaving(true);
    setPreparationLoginError("");
    try {
      const savedProject = await saveCurrentProjectLoginCredential({
        username: preparationLoginUsername.trim(),
        password: preparationLoginPassword,
        usernameEnv: projectDraft.login?.usernameEnv ?? projectDetection?.loginCapability?.usernameEnv ?? "E2E_USERNAME",
        passwordEnv: projectDraft.login?.passwordEnv ?? projectDetection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD"
      });
      setPreparationLoginPassword("");
      setPlanningAutomation({
        phase: !permissionProfile.observe || !permissionProfile.browserControl ? "needs-permission" : "preparing-project",
        detail: !permissionProfile.observe || !permissionProfile.browserControl
          ? "测试账号已加密保存。请允许本次浏览器操作后继续。"
          : "测试账号已加密保存，正在检查沙盒、项目服务和测试路径。"
      });
      if (!permissionProfile.observe || !permissionProfile.browserControl) return;
      const activePlan = planningResult;
      if (activePlan?.recommendedScenarioId && selectedProjectExecutionMode !== "oci") {
        setScenarioId(activePlan.recommendedScenarioId);
        await executeConfirmedScenarioAutomatically(activePlan.recommendedScenarioId);
      } else {
        await continueAutomaticPlanning(permissionProfile, savedProject, activePlan ?? undefined);
      }
    } catch (error) {
      setPreparationLoginError(error instanceof Error ? error.message : "测试账号保存失败，请重试。");
      setPlanningAutomation({ phase: "needs-credentials", detail: "测试账号尚未保存，项目准备暂停。" });
    } finally {
      setPreparationLoginSaving(false);
    }
  }

  async function stopCurrentProject() {
    if (!projectDraft) return;
    const response = await stopProject(projectDraft.id);
    setProjectRuntime(response.runtime);
    setMessage(response.runtime.message ?? `项目状态：${response.runtime.status}`);
  }

  async function recoverProjectAndRetry(mode: "auto" | "runtime" | "discovery" = "auto") {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      const detail = "当前没有已选择的项目，因此没有可执行的恢复操作。";
      setMessage(detail);
      setPlanningMessages((current) => [...current, {
        id: `recovery_unavailable_${Date.now()}`,
        role: "assistant",
        content: `遇到的问题：${detail}\n系统正在做什么：未启动重试，也没有创建代码修复。\n需要你操作：先选择并保存一个项目。`,
        createdAt: new Date().toISOString()
      }]);
      return;
    }
    if (projectRecoveryBusy) return;

    setProjectRecoveryBusy(true);
    const pendingId = `project_recovery_${Date.now()}`;
    const initialText = mode === "discovery"
      ? "遇到的问题：页面 Discovery 尚未完成。\n系统正在做什么：正在重新扫描页面、控件、网络和可执行路径。\n需要你操作：暂时无需操作。"
      : "遇到的问题：安全沙盒或项目服务尚未就绪。\n系统正在做什么：正在重新启动沙盒、检查 Docker Desktop、项目服务和页面连通性。\n需要你操作：暂时无需操作；若 180 秒后仍不可用，系统会给出明确提示。";
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: initialText,
      createdAt: new Date().toISOString()
    }]);
    setMessage(mode === "discovery" ? "正在重新扫描页面并绑定路径…" : "正在重新启动沙盒并诊断项目…");

    try {
      const accepted = await recoverAndRetryProject(projectId, mode);
      let recovery = accepted.recovery;
      setProjectRecovery(recovery);
      const deadline = Date.now() + 190_000;
      while (["accepted", "running"].includes(recovery.status) && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        const snapshot = await getProjectRecovery(projectId);
        recovery = snapshot.recovery;
        setProjectRecovery(recovery);
        setProjectRuntime(recovery.runtime);
        const lastEvent = recovery.events.at(-1);
        setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
          ...item,
          content: [
            "遇到的问题：正在恢复项目测试环境。",
            `系统正在做什么：${lastEvent?.message ?? "正在同步恢复状态。"}`,
            `需要你操作：${recovery.userAction}`
          ].join("\n")
        } : item));
      }
      setProjectRecovery(recovery);
      setProjectRuntime(recovery.runtime);
      const lastEvent = recovery.events.at(-1);
      const completed = recovery.status === "completed";
      const finalText = completed
        ? `遇到的问题：恢复完成。\n系统已经做了什么：${lastEvent?.message ?? "沙盒、页面连通性和 Discovery 已恢复。"}\n需要你操作：无需操作；现在可以继续生成或执行测试计划。`
        : `遇到的问题：${lastEvent?.message ?? recovery.sourceError ?? "恢复未完成。"}\n系统已经做了什么：已执行受限恢复并保留运行状态；没有修改项目源码，也没有覆盖既有证据。\n需要你操作：${recovery.userAction}`;
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: finalText,
        suggestedAction: completed ? "start-run" : "none",
        requiresConfirmation: completed
      } : item));
      setMessage(completed ? "项目环境已恢复，可以继续测试。" : recovery.userAction);
      if (completed) {
        setPlanningAutomation({ phase: "idle", detail: "项目恢复完成，等待继续规划或执行测试。" });
        setPreviewSessionProjectId(projectId);
      } else {
        setPlanningAutomation({ phase: "blocked", detail: lastEvent?.message ?? recovery.sourceError ?? "项目恢复未完成" });
      }
    } catch (error) {
      const detail = userFacingAutomationError(error instanceof Error ? error.message : "恢复请求失败");
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        content: `遇到的问题：${detail}\n系统已经做了什么：恢复请求未完成，系统没有启动代码修复或覆盖已有测试证据。\n需要你操作：请稍后重试；如果持续失败，请查看运行详情。`
      } : item));
      setMessage(detail);
    } finally {
      setProjectRecoveryBusy(false);
    }
  }

  function requireBrowserAuthorization(action: string) {
    if (permissionProfile.observe && permissionProfile.browserControl) return true;
    setMessage(`请先授权 browser_control，AI 测试官才能${action}。`);
    return false;
  }

  function assistantActionLabel(action: NonNullable<typeof assistantSuggestedAction>["action"]) {
    return {
      "revise-plan": "确认修改测试计划",
      "start-run": "确认开始测试",
      "pause-run": "确认暂停测试",
      "resume-run": "确认恢复测试",
      "cancel-run": "确认取消测试",
      "open-evidence": "打开证据详情",
      "create-repair": "创建沙盒修复",
      "retry-runtime": "重新启动沙盒并诊断",
      "retry-discovery": "重新扫描页面并绑定路径",
      "retry-failed-path": "重试失败链路",
      "continue-safe-paths": "继续其他可执行测试",
      "configure-credentials": "配置测试账号",
      "resume-interrupt": "查看待确认操作"
    }[action];
  }

  async function executeAssistantSuggestedAction(actionOverride?: Exclude<AssistantSuggestedAction, "none">) {
    const action = actionOverride ?? assistantSuggestedAction?.action;
    if (!action) return;
    try {
    if (action === "retry-runtime") {
      await recoverProjectAndRetry("runtime");
      return;
    }
    if (action === "retry-discovery") {
      await recoverProjectAndRetry("discovery");
      return;
    }
    if (action === "start-run") {
      if (!planningResult) {
        setMessage("测试清单尚未生成，正在先扫描项目。");
        await continueTestPlanning("全面扫描", "llm-guided");
        return;
      }
      setMessage("已收到确认，正在准备沙盒和测试路径。");
      setPlanningAutomation({
        phase: !permissionProfile.observe || !permissionProfile.browserControl ? "needs-permission" : "preparing-project",
        detail: !permissionProfile.observe || !permissionProfile.browserControl
          ? "需要你允许本次内置浏览器操作，授权后会自动继续。"
          : "正在提交项目启动任务，请稍候。"
      });
      try {
        await confirmPlanningDraft();
        setAssistantSuggestedAction(null);
      } catch (error) {
        const detail = userFacingAutomationError(error instanceof Error ? error.message : "测试准备失败");
        setPlanningAutomation({ phase: "blocked", detail });
        setMessage(detail);
      }
      return;
    }
    setAssistantSuggestedAction(null);
    if (action === "revise-plan") {
      setPlanningConfirmed(false);
      setPlanningAutomation({ phase: "idle", detail: "" });
      setMessage("测试计划已恢复为可编辑状态，请继续告诉 AI 要修改什么。");
      return;
    }
    if (action === "open-evidence") {
      setRightDrawerOpen(true);
      return;
    }
    if (action === "create-repair") {
      if (!activeRunId) {
        setMessage("当前没有可关联的失败运行，因此不能创建代码修复。请先恢复项目或执行一条真实失败路径。");
        return;
      }
      await openCodeRepairWorkspace();
      return;
    }
    if (action === "retry-failed-path") {
      if (pathBindingRepairable) {
        await repairBlockedPlanning();
      } else if (proofInfrastructureFailure && scenarioId) {
        setMessage("正在使用同一场景重新执行并重建步骤、断言与证据关联，不会修改项目源码。");
        await executeConfirmedScenarioAutomatically(scenarioId);
      } else {
        const runtimeNeedsRecovery = projectRuntime?.status !== "running"
          || projectRuntime?.failureReason === "container_runtime_unavailable";
        if (runtimeNeedsRecovery) {
          await recoverProjectAndRetry("runtime");
        } else if (activeRunId && codeRepairAvailable) {
          await openCodeRepairWorkspace();
        } else {
          setMessage("当前没有可重试的持久化失败路径。系统不会伪造重试或打开空的代码修复；可重新扫描页面或查看运行详情。");
          setPlanningMessages((current) => [...current, {
            id: `retry_not_available_${Date.now()}`,
            role: "assistant",
            content: "遇到的问题：当前没有可重试的测试路径。\n系统已经做了什么：没有创建代码修复，也没有覆盖既有证据。\n需要你操作：请先重新启动沙盒并扫描页面，或查看运行详情。",
            createdAt: new Date().toISOString()
          }]);
        }
      }
      return;
    }
    if (action === "continue-safe-paths") {
      const replanned = await continueTestPlanning(
        "继续执行其余能够绑定真实入口、操作、oracle 和证据的安全路径；保留当前失败链路及其证据并单独标记待诊断，不要让它阻止其他独立路径。",
        "llm-guided",
        { internalInstruction: true }
      );
      if (replanned && !hasBlockingPlanningQuestions(replanned)) {
        await confirmPlanningResult(replanned);
      }
      return;
    }
    if (action === "resume-interrupt") {
      setRunPreviewModalOpen(true);
      setMessage("请在准备窗口中确认当前待授权操作。");
      return;
    }
    if (action === "configure-credentials") {
      // owner=user credential failures: retrying is useless until an account is
      // bound. Open the credential form instead of falling through to the
      // run-control branch below (which would have cancelled the run).
      setRevealProjectLoginSettings(true);
      setPlanningAutomation({
        phase: "needs-credentials",
        detail: "请填写本项目的测试账号，保存后系统会自动继续。"
      });
      setMessage("请配置本项目的测试账号；密码只在服务端加密保存，不要在对话中发送。");
      return;
    }
    const control = action === "pause-run" ? "pause" : action === "resume-run" ? "resume" : "cancel";
    await controlActiveRun(control);
    } catch (error) {
      const detail = userFacingAutomationError(error instanceof Error ? error.message : "操作未完成");
      setMessage(detail);
      setPlanningMessages((current) => [...current, {
        id: `assistant_action_error_${Date.now()}`,
        role: "assistant",
        content: `遇到的问题：${detail}\n系统已经做了什么：已停止当前操作，未修改项目源码或覆盖证据。\n需要你操作：请重试，或查看运行详情。`,
        createdAt: new Date().toISOString()
      }]);
    }
  }

  /**
   * Execute the action a repair plan declares.
   *
   * The plan panel does not invent its own recovery logic: it reuses the exact
   * same executor as the chat suggestion, so "按钮做的事" and "AI 说的事" cannot
   * drift apart. Progress is reported back into the panel, keyed by plan id.
   */
  async function executeRepairPlanAction(
    action: Exclude<AssistantSuggestedAction, "none">,
    plan: RepairPlanData
  ) {
    // Persist the lifecycle transition so an executed plan survives a refresh
    // instead of reverting to "待处理". Backend writes are best-effort: a
    // persistence outage must not turn an explained action into an unexplained one.
    const persist = (status?: "applied" | "resolved" | "dismissed", event?: string, note?: string) => {
      if (!plan.runId || !plan.planId) return Promise.resolve(null);
      return updateRepairPlanStatus(plan.runId, plan.planId, status, { event, note }).catch(() => null);
    };

    setRepairPlanActionStatus({
      planId: plan.planId,
      state: "running",
      message: `正在执行：${assistantActionLabel(action) ?? action}`
    });
    await persist(undefined, "action_started", assistantActionLabel(action) ?? action);
    try {
      await executeAssistantSuggestedAction(action);
      setRepairPlanActionStatus({
        planId: plan.planId,
        state: "done",
        message: "已按修复方案执行；结果会在运行状态和证据中体现。"
      });
      await persist("applied", "action_executed");
    } catch (error) {
      setRepairPlanActionStatus({
        planId: plan.planId,
        state: "error",
        message: userFacingAutomationError(error instanceof Error ? error.message : "修复动作未完成")
      });
      await persist(undefined, "action_failed", error instanceof Error ? error.message : "修复动作未完成");
    }
  }

  /**
   * Open the evidence a repair plan was derived from. Without this the plan's
   * "依据证据" is an unverifiable claim.
   */
  function openRepairPlanEvidence(evidenceId: string, plan: RepairPlanData) {
    setRightDrawerOpen(true);
    setLeftDrawerOpen(false);
    // Drive the panel to scroll-to + highlight the exact evidence item rather
    // than only showing a toast. The panel reads this on mount/update.
    setFocusEvidenceId(evidenceId);
    setMessage(`已定位证据 ${evidenceId}${plan.attemptId ? `（attempt ${plan.attemptId}）` : ""}。`);
  }

  /** Locate a single evidence item referenced by a pending interrupt. */
  function openInterruptEvidence(evidenceId: string) {
    setRightDrawerOpen(true);
    setLeftDrawerOpen(false);
    setFocusEvidenceId(evidenceId);
    setMessage(`已定位证据 ${evidenceId}。`);
  }

  /**
   * Submit a human decision and resume the *paused graph*.
   *
   * This is the hinge of the whole human-in-the-loop story: the run is blocked
   * inside LangGraph's `interrupt()` and only a real backend resume restarts it
   * on the same thread. Opening a modal or writing a local note would leave the
   * run paused forever, so failures here are surfaced rather than swallowed.
   */
  async function submitInterruptDecision(decision: RepairDecisionValue, note?: string) {
    const interrupt = agentProjection?.pendingInterrupt;
    if (!interrupt || !activeRunId) return;
    setInterruptBusy(true);
    setInterruptError(null);
    try {
      const { agent } = await resumeRepairDecision(activeRunId, interrupt.id, {
        decision,
        message: note
      });
      setAgentProjection(agent);
      setMessage(
        decision === "dismiss"
          ? "已保留失败结论，测试不再自动修复。"
          : "决策已提交，测试正在从中断处继续。"
      );
      // The decision changes run state (repair session, credentials, sandbox),
      // so refresh the deterministic projection instead of trusting the graph
      // snapshot alone.
      void getRunProjection(activeRunId).then(({ run }) => setActiveRun(run)).catch(() => undefined);
      // A repair decision produces a sandbox session. Surface it immediately so
      // the operator lands in the workspace instead of hunting for it.
      if (decision === "create-session" || decision === "repair") {
        void listRunRepairs(activeRunId)
          .then(({ repairs }) => {
            const latest = repairs.at(-1);
            if (latest) setRepairSession(latest);
          })
          .catch(() => undefined);
      }
    } catch (error) {
      setInterruptError(
        userFacingAutomationError(error instanceof Error ? error.message : "决策提交失败，测试仍处于暂停状态")
      );
    } finally {
      setInterruptBusy(false);
    }
  }

  function resolveRecoverableAssistantAction(action: Exclude<AssistantSuggestedAction, "none"> | undefined) {
    if (!action) return action;
    const recoveryRequested = action === "retry-failed-path" || action === "create-repair";
    if (recoveryRequested && projectRuntime?.status !== "running") return "retry-runtime" as const;
    if (recoveryRequested && discovery?.orchestration && discovery.orchestration.status !== "ready") return "retry-discovery" as const;
    if (action === "create-repair" && !activeRunId) return undefined;
    return action;
  }

  async function chatWithAssistant(content: string) {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      setMessage("请先接入并识别项目。");
      return;
    }
    const userMessage: PlanningMessage = {
      id: `assistant_user_${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    const pendingId = `assistant_pending_${Date.now()}`;
    setPlanningMessages((current) => [...current, userMessage, {
      id: pendingId,
      role: "assistant",
      content: "正在读取当前计划、运行状态和最新证据…",
      createdAt: new Date().toISOString()
    }]);
    setPlanningInput("");
    setAssistantChatBusy(true);
    setAssistantSuggestedAction(null);
    const latestEvent = (liveRun?.events ?? result?.loopEvents ?? []).at(-1);
    try {
      const runId = activeRunId ?? (result?.id?.startsWith("run_") ? result.id : undefined);
      if (runId) {
        const response = await sendRunAgentMessage(runId, {
          message: content,
          credentialId: defaultCredential?.id
        });
        const effectiveAction = resolveRecoverableAssistantAction(response.assistant.suggestedAction !== "none"
          ? response.assistant.suggestedAction
          : commandFallbackAction(content, activeRun?.state));
        setPlanningMessages((current) => current.map((item) =>
          item.id === pendingId
            ? {
              ...item,
              content: response.assistant.reply,
              repairPlan: response.assistant.repairPlan,
              reasoningSummary: response.assistant.reasoningSummary,
              knowledge: response.assistant.knowledge,
              suggestedAction: effectiveAction ?? "none",
              requiresConfirmation: effectiveAction ? true : response.assistant.requiresConfirmation,
              llmTrace: {
                callId: response.call.id,
                model: response.call.model,
                provider: response.call.provider,
                durationMs: response.call.durationMs,
                totalTokens: response.call.usage?.totalTokens,
                semanticRepairApplied: response.call.semanticRepairApplied,
                status: response.call.status,
                fallbackApplied: response.call.fallbackApplied,
                errorCode: response.call.errorCode,
                contextId: response.call.knowledgeContextId,
                decisionId: response.call.knowledgeDecisionId,
                validationStatus: response.call.knowledgeValidationStatus
              }
            }
            : item
        ));
        if (effectiveAction) {
          setAssistantSuggestedAction({
            action: effectiveAction,
            label: assistantActionLabel(effectiveAction)
          });
        }
        if (isExplicitAssistantActionConfirmation(content, effectiveAction)) {
          setAssistantSuggestedAction(null);
          await executeAssistantSuggestedAction(effectiveAction);
        }
        return;
      }
      const response = await chatWithTestAssistant({
        projectId,
        message: content,
        credentialId: defaultCredential?.id,
          history: planningMessages.slice(-8).map((item) => ({
            role: item.role,
            content: boundedAssistantText(item.content, 1_500)
          })),
        context: {
          runState: activeRun?.state ?? (isRunning ? "running" : "idle"),
          finalStatus: result?.finalStatus ?? result?.gateStatus,
          summary: boundedAssistantText(result?.summary ?? planningAutomation.detail, 1_200),
          evidenceCount: liveRun?.evidenceCount ?? result?.evidence.length ?? 0,
          currentStep: boundedAssistantText(latestEvent?.title ?? planningAutomation.phase, 300),
          latestLog: boundedAssistantText(latestEvent?.observation ?? latestEvent?.decisionReason ?? planningAutomation.detail, 700),
          pageObservation: discovery?.observation,
          failedAssertions: (result?.assertions ?? []).filter((item) => !item.passed).slice(0, 8).map((item) => ({
            name: boundedAssistantText(item.name, 240),
            expected: boundedAssistantText(item.expected, 500),
            actual: boundedAssistantText(item.actual, 500)
          })),
          planning: planningResult ? {
            discovered: planningResult.coverage.discovered,
            executable: planningResult.coverage.executable,
            autoBindable: planningResult.coverage.autoBindable ?? 0,
            confirmed: planningConfirmed,
            failures: automationFailures.map((failure) => ({
              title: failure.title,
              target: failure.target ?? failure.scenarioId,
              stage: failure.stage,
              detail: boundedAssistantText(failure.detail, 1_000),
              requiredInformation: failure.requiredInformation?.slice(0, 8) ?? []
            })),
            blockingQuestions: planningResult.clarificationQuestions.slice(0, 8)
          } : undefined
        }
      });
      const effectiveAction = resolveRecoverableAssistantAction(response.assistant.suggestedAction !== "none"
        ? response.assistant.suggestedAction
        : commandFallbackAction(content, activeRun?.state ?? (isRunning ? "running" : "idle")));
      setPlanningMessages((current) => current.map((item) =>
        item.id === pendingId
          ? {
            ...item,
            content: response.assistant.reply,
            repairPlan: response.assistant.repairPlan,
            reasoningSummary: response.assistant.reasoningSummary,
            knowledge: response.assistant.knowledge,
            suggestedAction: effectiveAction ?? "none",
            requiresConfirmation: effectiveAction ? true : response.assistant.requiresConfirmation,
            llmTrace: {
              callId: response.call.id,
              model: response.call.model,
              provider: response.call.provider,
              durationMs: response.call.durationMs,
              totalTokens: response.call.usage.totalTokens,
              semanticRepairApplied: response.call.semanticRepairApplied,
              status: response.call.status,
              fallbackApplied: response.call.fallbackApplied,
              errorCode: response.call.errorCode,
              contextId: response.call.knowledgeContextId,
              decisionId: response.call.knowledgeDecisionId,
              validationStatus: response.call.knowledgeValidationStatus
            }
          }
          : item
      ));
      if (effectiveAction) {
        setAssistantSuggestedAction({
          action: effectiveAction,
          label: assistantActionLabel(effectiveAction)
        });
      }
      if (isExplicitAssistantActionConfirmation(content, effectiveAction)) {
        setAssistantSuggestedAction(null);
        await executeAssistantSuggestedAction(effectiveAction);
      }
    } catch (error) {
      const fallbackAction = resolveRecoverableAssistantAction(commandFallbackAction(content, activeRun?.state ?? (isRunning ? "running" : "idle")));
      setPlanningMessages((current) => current.map((item) =>
        item.id === pendingId
          ? {
            ...item,
            content: userFacingAssistantError(error),
            suggestedAction: fallbackAction ?? "none",
            requiresConfirmation: Boolean(fallbackAction),
            reasoningSummary: {
              phase: "waiting-user",
              observations: ["模型调用未成功，技术原因已记录", "机器门禁和已保存证据仍然有效"],
              assessment: "当前无法获得模型补充解释，但不会把失败误判为通过，也不会清除已经完成的测试。",
              nextStep: "系统保留现有机器结论；你可以稍后重试模型解释，或直接查看证据和控制运行。",
              userAction: "无需重复执行已完成路径；如需 AI 继续分析，请检查模型配置后重新发送消息。",
              confidence: "high"
            }
          }
          : item
      ));
      if (fallbackAction) {
        setAssistantSuggestedAction({
          action: fallbackAction,
          label: assistantActionLabel(fallbackAction)
        });
      }
      if (isExplicitAssistantActionConfirmation(content, fallbackAction)) {
        setAssistantSuggestedAction(null);
        await executeAssistantSuggestedAction(fallbackAction);
      }
    } finally {
      setAssistantChatBusy(false);
    }
  }

  async function routeAssistantContent(rawContent: string) {
    const content = rawContent.trim();
    if (!content) return;
    const normalized = content.replace(/[\s，。！？、,.!?：:；;“”"'`]/g, "");
    const fullInventoryCommand = ["全面扫描", "灰度测试"].includes(normalized);
    const questionLike = /[？?]$|^(现在|目前|为什么|为何|怎么|如何|什么|是否|有没有|能不能|测试情况|进度|结果|状态)|失败.*原因|情况.*如何/i.test(content);
    const planChange = /修改|调整|增加|添加|删除|去掉|重点测试|测试范围|重新规划|重做计划/i.test(content);
    const explicitTestGoal = /^(请|帮我|我要|我想)?(对|针对)?[^？?]*(测试|验证|检查|扫描)/i.test(content);
    if (fullInventoryCommand || (!questionLike && (planChange || explicitTestGoal) && !planningAutomationBusy)) {
      await continueTestPlanning(content, "llm-guided");
      return;
    }
    await chatWithAssistant(content);
  }

  async function routeAssistantInput() {
    await routeAssistantContent(planningInput);
  }

  async function continueTestPlanning(
    input?: string,
    planningMode: "llm-guided" | "scan-only" = "llm-guided",
    options: { internalInstruction?: boolean; preserveAutomationState?: boolean } = {}
  ) {
    const content = (input ?? planningInput).trim();
    const fullInventoryCommand = ["全面扫描", "灰度测试"].includes(
      content.replace(/[\s，。！？、,.!?：:；;“”"'`]/g, "")
    );
    // “全面扫描/灰度测试” uses the hybrid path by default: deterministic
    // discovery guarantees a list, then the LLM prioritises and explains it.
    // The explicit low-cost scan button can still opt into scan-only.
    const effectivePlanningMode = fullInventoryCommand && planningMode !== "scan-only"
      ? "llm-guided"
      : planningMode;
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      setMessage("请先接入并识别项目，再开始规划测试。");
      return;
    }
    if (!content) {
      setMessage("请先描述你想测试什么。");
      return;
    }
    const userMessage: PlanningMessage = {
      id: `planning_user_${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    if (!options.internalInstruction) {
      setPlanningMessages((current) => [...current, userMessage]);
    }
    setPlanningInput("");
    setPlanningBusy(true);
    setPlanningConfirmed(false);
    // A new full inventory must not keep rendering the previous project's or
    // previous scan's large plan while the one-page smoke gate is pending.
    if (fullInventoryCommand) {
      setPlanningResult(null);
      setDiscovery(null);
    }
    if (!options.preserveAutomationState) {
      setPlanningAutomation({ phase: "idle", detail: "" });
    }
    setScenarioId("");
    setMessage(effectivePlanningMode === "scan-only"
      ? "正在用确定性扫描列出项目测试清单。"
      : fullInventoryCommand
        ? "正在扫描完整业务流程，并由 AI 排定风险和补充遗漏。"
        : "正在分析你的目标，并由 AI 制定相关测试计划。");
    try {
      const response = await continuePlanningConversation({
        projectId,
        message: content,
        diff: diffText,
        bugTicket: bugTicketText,
        history: planningMessages,
        planningMode: effectivePlanningMode,
        credentialId: effectivePlanningMode === "llm-guided" ? defaultCredential?.id : undefined
      });
      if (response.discovery) {
        setDiscovery(response.discovery);
        setScenarioDrafts(response.discovery.drafts);
      }
      const orchestrationCopy = response.discovery
        ? discoveryOrchestrationCopy(response.discovery)
        : null;
      const smokeReady = !response.discovery?.orchestration
        || response.discovery.orchestration.status === "ready";
      const assistantMessage: PlanningMessage = {
        id: `planning_assistant_${Date.now()}`,
        role: "assistant",
        content: smokeReady || !orchestrationCopy
          ? response.planning.reply
          : [
            `遇到的问题：${orchestrationCopy.reason}`,
            `系统已经做了什么：${orchestrationCopy.completed}`,
            `需要你做什么：${orchestrationCopy.nextStep}`
          ].join("\n"),
        createdAt: new Date().toISOString()
      };
      setPlanningMessages((current) => [...current, assistantMessage]);
      setAnalysis(response.planning.analysis);
      const combinedRequirement = [...planningMessages, ...(options.internalInstruction ? [] : [userMessage])]
        .filter((item) => item.role === "user")
        .map((item) => item.content)
        .join("\n");
      setRequirementText(combinedRequirement);
      if (!smokeReady) {
        setPlanningResult(null);
        setPlanningConfirmed(false);
        setScenarioId("");
        setMessage(orchestrationCopy?.status ?? "页面预检未通过，测试尚未开始。");
        return null;
      }
      setPlanningResult(response.planning);
      setMessage(response.planning.llmPlanning?.status === "failed"
        ? "代码扫描已完成，但 AI 规划暂时不可用；已保留可继续编辑的规则计划。"
        : response.planning.llmPlanning?.status === "not_configured"
          ? "代码扫描已完成。配置 AI 模型后可获得优先级建议和追问。"
        : response.planning.phase === "clarifying"
        ? "系统需要你回答几个问题，回答后会更新计划。"
        : "测试计划草案已生成，请检查业务流程后确认。");
      return response.planning;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "测试规划失败";
      setPlanningMessages((current) => [...current, {
        id: `planning_error_${Date.now()}`,
        role: "assistant",
        content: `暂时无法生成计划：${detail}`,
        createdAt: new Date().toISOString()
      }]);
      setMessage(detail);
      return null;
    } finally {
      setPlanningBusy(false);
    }
  }

  async function ensureProjectReadyForAutomation(projectOverride?: ProjectConfig) {
    const candidate = projectOverride ?? projectDraft ?? projectDetection?.suggestedConfig;
    if (!candidate) throw new Error("没有可运行的项目配置，请重新识别项目。");
    const saved = await saveProject({
      ...candidate,
      allowExternalProjectPath: candidate.allowExternalProjectPath ?? true
    });
    setProjectDraft(saved.project);
    setSelectedProjectId(saved.project.id);
    setProjectPathInput(saved.project.projectPath);
    setAppUrl(saved.project.frontendUrl);

    const currentConnection = await testProjectConnection(saved.project.id).catch(() => null);
    if (currentConnection?.result.ok) {
      setProjectConnection(currentConnection.result);
      setPreviewSessionProjectId(saved.project.id);
      const liveUrl = projectRuntime?.status === "running"
        ? projectRuntime.frontendUrl ?? saved.project.frontendUrl
        : saved.project.frontendUrl;
      return { ...saved.project, frontendUrl: liveUrl, healthCheckUrl: liveUrl };
    }
    const accepted = await startProjectAsync(saved.project.id);
    setProjectRuntime(accepted.runtime);
    const sandboxPrepareTimeout = saved.project.manifest?.execution.mode === "oci"
      ? (saved.project.manifest.budget.prepareTimeoutMs ?? 300_000)
      : 0;
    const startupDeadline = Date.now()
      + sandboxPrepareTimeout
      + Math.max(saved.project.timeoutMs ?? 30_000, 30_000)
      + 10_000;
    let startedRuntime = accepted.runtime;
    while (Date.now() < startupDeadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      const snapshot = await getProjectRuntime(saved.project.id).catch(() => null);
      if (!snapshot) {
        setPlanningAutomation((current) => ({
          ...current,
          phase: "preparing-project",
          detail: "Agent 暂时断开，正在自动重新连接并恢复启动状态。"
        }));
        continue;
      }
      startedRuntime = snapshot.runtime;
      setProjectRuntime(startedRuntime);
      setPlanningAutomation((current) => ({
        ...current,
        phase: "preparing-project",
        detail: startedRuntime.status === "installing"
          ? "正在沙盒中安装项目依赖；完成后会自动继续。"
          : startedRuntime.status === "starting"
            ? startedRuntime.message || "正在启动 Docker 沙盒和项目服务。"
            : "正在确认项目是否可以访问。"
      }));
      if (!["idle", "installing", "starting"].includes(startedRuntime.status)) break;
    }
    if (startedRuntime.status !== "running") {
      const diagnosed = await diagnoseProject(saved.project.id).catch(() => null);
      if (diagnosed) setProjectDiagnosis(diagnosed.diagnosis);
      throw new Error(startedRuntime.message ?? "项目无法启动。");
    }
    const connected = await testProjectConnection(saved.project.id);
    setProjectConnection(connected.result);
    if (!connected.result.ok) throw new Error(connected.result.message || "项目启动后仍无法访问。");
    setPreviewSessionProjectId(saved.project.id);
    const liveUrl = startedRuntime.frontendUrl ?? saved.project.frontendUrl;
    setAppUrl(liveUrl);
    return {
      ...saved.project,
      frontendUrl: liveUrl,
      backendUrl: startedRuntime.backendUrl ?? saved.project.backendUrl,
      healthCheckUrl: startedRuntime.healthCheckUrl ?? liveUrl
    };
  }

  function chooseDiscoveryDraft(result: DiscoveryScanResult) {
    const semanticText = `${requirementText} ${planningResult?.businessFlows.map((flow) => flow.title).join(" ") ?? ""}`.toLowerCase();
    const scored = result.drafts.map((draft) => {
      const draftText = `${draft.riskKind ?? ""} ${draft.actions?.join(" ") ?? ""} ${JSON.stringify(draft.scenario)}`.toLowerCase();
      const terms = semanticText.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2);
      const matches = terms.filter((term) => draftText.includes(term)).length;
      const riskBonus = /登录|权限|login|permission/.test(semanticText) && draft.riskKind === "auth" ? 8
        : /接口|api|网络|network/.test(semanticText) && draft.riskKind === "api_contract" ? 8
          : /筛选|列表|表格|filter|table/.test(semanticText) && draft.riskKind === "table" ? 8
            : 0;
      return { draft, score: matches + riskBonus };
    });
    return scored.sort((left, right) => right.score - left.score)[0]?.draft;
  }

  async function executeConfirmedScenarioAutomatically(
    selectedScenarioId: string,
    grantedProfile = permissionProfile,
    targetOverride?: { appUrl: string; projectId: string; batchMode?: boolean; coverageScenarioIds?: string[] }
  ) {
    if (!grantedProfile.observe || !grantedProfile.browserControl) {
      setPlanningAutomation({
        phase: "needs-permission",
        detail: "测试路径已准备好。允许本次浏览器操作后，系统会自动继续。",
        scenarioId: selectedScenarioId
      });
      setMessage("测试路径已准备好，等待浏览器操作授权。");
      setRunPreviewModalOpen(true);
      return;
    }
    closeDrawers();
    // Preparation and permission use the modal; real execution belongs only
    // in the centre embedded browser.
    setRunPreviewModalOpen(false);
    setPlanningAutomation({ phase: "starting-run", detail: "正在创建运行并自动完成计划审批。", scenarioId: selectedScenarioId });
    const operationProjectId = targetOverride?.projectId ?? (selectedProjectId || projectDraft?.id || "");
    const workspaceRequestId = beginWorkspaceOperation("executing", operationProjectId);
    setIsRunning(true);
    try {
      const created = await createVisualRun(targetOverride?.appUrl ?? previewUrl, grantedProfile, selectedScenarioId, {
        requirement: requirementText,
        diff: diffText,
        projectId: targetOverride?.projectId ?? (selectedProjectId || projectDraft?.id),
        executionMode: selectedProjectExecutionMode,
        coverageScenarioIds: targetOverride?.coverageScenarioIds
      });
      setActiveRunId(created.run.id);
      setActiveRun(created.run);
      const approved = await approveRunPlan(created.run.id, created.run.version);
      setActiveRun(approved.run);
      const granted = await grantRunPermissions(created.run.id, approved.run.version);
      setActiveRun(granted.run);
      setPlanningAutomation({ phase: "running", detail: "AI 正在操作浏览器并采集截图、DOM、网络和 Trace。", scenarioId: selectedScenarioId });
      setMessage("计划已确认，AI 正在自动执行测试。");
      const report = await waitForRunReport(created.run.id);
      setResult(report);
      dispatchWorkspace({
        type: "run-completed",
        requestId: workspaceRequestId,
        projectId: operationProjectId,
        report
      });
      setPlanningAutomation({ phase: "ready", detail: report.summary, scenarioId: selectedScenarioId });
      setMessage(report.summary);
      const finalStatus = report.finalStatus ?? report.gateStatus
        ?? (report.verdict === "continue" ? "pass" : report.verdict === "stop_and_fix" ? "fail" : "needs-human-review");
      return {
        scenarioId: selectedScenarioId,
        success: finalStatus === "pass",
        finalStatus,
        detail: report.summary
      };
    } catch (error) {
      const detail = userFacingAutomationError(error instanceof Error ? error.message : "自动化测试启动失败");
      dispatchWorkspace({
        type: "operation-failed",
        requestId: workspaceRequestId,
        projectId: operationProjectId,
        error: detail
      });
      if (!targetOverride?.batchMode) {
        setPlanningAutomation({ phase: "blocked", detail, scenarioId: selectedScenarioId });
        setMessage(detail);
      }
      return {
        scenarioId: selectedScenarioId,
        success: false,
        finalStatus: "blocked" as const,
        detail
      };
    } finally {
      setIsRunning(false);
    }
  }

  function grantBrowserPermissionAndContinue() {
    const nextPermission = { ...permissionProfile, observe: true, browserControl: true };
    setPermissionProfile(nextPermission);
    setPlanningAutomation((current) => ({
      ...current,
      detail: "浏览器操作已授权，正在继续准备测试。"
    }));
    if (planningAutomation.scenarioId) {
      void executeConfirmedScenarioAutomatically(planningAutomation.scenarioId, nextPermission);
    } else {
      void continueAutomaticPlanning(nextPermission);
    }
  }

  async function continueAutomaticPlanning(
    grantedProfile = permissionProfile,
    projectOverride?: ProjectConfig,
    planningOverride?: PlanningConversationResult
  ) {
    const activePlanning = planningOverride ?? planningResult;
    if (!activePlanning) return;
    // Permission is the first user decision. Do not prepare a sandbox and then
    // jump backwards to an authorization step.
    if (!grantedProfile.observe || !grantedProfile.browserControl) {
      setPlanningAutomation({
        phase: "needs-permission",
        detail: "先允许本次浏览器操作，授权后系统会依次准备沙盒、扫描页面并生成可执行路径。"
      });
      setMessage("等待本次沙盒浏览器操作授权。");
      setRunPreviewModalOpen(true);
      return;
    }
    setAutomationFailures([]);
    setPlanningAutomation({ phase: "preparing-project", detail: "正在启动并连接被测项目。" });
    setMessage("计划已确认，正在自动准备项目。");
    // Track the scenario selected by this invocation. React state updates are
    // asynchronous, so reading planningAutomation in catch could attribute a
    // new ANDFlow failure to a stale scenario from the previous project.
    let activeScenarioId: string | undefined;
    try {
      const project = await ensureProjectReadyForAutomation(projectOverride);
      setPlanningAutomation({ phase: "discovering", detail: "正在读取真实页面、控件、接口和可验证结果。" });
      const reusableDiscovery = discovery
        && discovery.target.projectId === project.id
        && discovery.orchestration?.status === "ready"
        && Date.now() - new Date(discovery.observation.capturedAt).getTime() < 10 * 60_000
        ? discovery
        : undefined;
      const response = reusableDiscovery
        ? { discovery: reusableDiscovery }
        : await runDiscoveryScan({
            appUrl: project.frontendUrl,
            projectId: project.id,
            sourceContexts: activePlanning.analysis.sourceContexts,
            goal: requirementText || activePlanning.plan.sessionName,
            credentialId: defaultCredential?.id
          });
      setDiscovery(response.discovery);
      setScenarioDrafts(response.discovery.drafts);
      // A login wall is not a defect: the page loaded and was observed. Stop the
      // automation and hand the operator a concrete, owner-tagged action instead
      // of a generic "no executable path" failure.
      if (response.discovery.status === "waiting-auth") {
        setPlanningMessages((current) => [...current, {
          id: `discovery_waiting_auth_${Date.now()}`,
          role: "assistant",
          content: response.discovery.message,
          createdAt: new Date().toISOString(),
          repairPlan: {
            owner: "user",
            type: "credential_required",
            executable: false,
            problem: "被测页面是登录入口，未配置可用的测试账号。",
            steps: [
              "打开凭据管理，新增本项目可用的测试账号。",
              "不要在对话中直接发送密码，凭据只在服务端加密保存。",
              "保存后重新执行页面扫描。"
            ],
            validation: "重新扫描后页面不再停留在登录页，且能发现可操作控件。",
            message: response.discovery.message,
            status: "pending",
            // A login wall is cleared by binding an account, never by re-granting
            // browser permission — the action must open the credential form.
            action: "configure-credentials"
          }
        }]);
        setPlanningAutomation({
          // NOT "needs-permission": browser control is already granted here, and
          // showing the permission dialog leaves the user pressing a button that
          // cannot clear the block.
          phase: "needs-credentials",
          detail: "被测页面需要登录，请先配置测试账号再重新扫描。"
        });
        setRevealProjectLoginSettings(true);
        setMessage("被测页面需要登录，请先配置测试账号。");
        return;
      }
      if (response.discovery.status === "failed") throw new Error(response.discovery.message);
      const recommendedIds = response.discovery.recommendedScenarioIds?.length
        ? response.discovery.recommendedScenarioIds
        : response.discovery.recommendedScenarioId
          ? [response.discovery.recommendedScenarioId]
          : [];
      const selectedDrafts = recommendedIds.length
        ? recommendedIds
            .map((id) => response.discovery.drafts.find((draft) => draft.scenarioId === id))
            .filter((draft): draft is HarnessGapScenarioDraft => Boolean(draft))
        : [chooseDiscoveryDraft(response.discovery)].filter((draft): draft is HarnessGapScenarioDraft => Boolean(draft));
      if (!selectedDrafts.length) throw new Error("页面扫描没有找到可安全执行的测试路径。");
      setPlanningMessages((current) => [...current, {
        id: `discovery_summary_${Date.now()}`,
        role: "assistant",
        content: `真实页面扫描完成：从 ${response.discovery.suggestions.length} 条可验证候选中选出 ${selectedDrafts.length} 条低风险路径自动执行。代码扫描识别的组件数量不等于已通过的测试数量；有副作用或缺少业务 oracle 的功能会保留待确认，不会伪装成已覆盖。`,
        createdAt: new Date().toISOString()
      }]);
      const selectionMode = response.discovery.selectionProvenance?.mode === "llm-assisted"
        ? "LLM 已在真实页面候选中选定最符合目标的路径"
        : response.discovery.selectionProvenance?.mode === "deterministic-fallback"
          ? "LLM 选择不可用，已采用验证过的安全基线路径"
          : selectedDrafts.length > 1
            ? `全面灰度模式已选出 ${selectedDrafts.length} 条低风险真实页面路径`
            : "规则已找到唯一高置信度路径";
      setPlanningAutomation({
        phase: "binding",
        detail: `${selectionMode}；正在验证元素、动作、oracle 和证据要求。`,
        scenarioId: selectedDrafts[0]?.scenarioId
      });
      const approvedScenarioIds: string[] = [];
      const bindingFailures: AutomationFailure[] = [];
      const bindingRepairs: string[] = [];
      for (const [index, draft] of selectedDrafts.entries()) {
        activeScenarioId = draft.scenarioId;
        setPlanningAutomation({
          phase: "binding",
          detail: `正在验证第 ${index + 1}/${selectedDrafts.length} 条路径的元素、动作、oracle 和证据要求。`,
          scenarioId: draft.scenarioId
        });
        const probed = await probeScenarioDraft(draft.scenarioId, defaultCredential?.id);
        setScenarioDrafts((current) => [probed.draft, ...current.filter((item) => item.scenarioId !== probed.draft.scenarioId)]);
        const plannedFlow = activePlanning.businessFlows.find((flow) =>
          flow.scenarioId === draft.scenarioId || flow.id === draft.gapId
        );
        const scenarioTitle = typeof draft.scenario["title"] === "string"
          ? draft.scenario["title"]
          : undefined;
        const failureTitle = plannedFlow?.title ?? scenarioTitle ?? draft.scenarioId;
        const successfulRepairs = (probed.draft.repairAttempts ?? []).filter((attempt) => attempt.status === "repaired");
        if (successfulRepairs.length) {
          bindingRepairs.push(
            `${draft.scenarioId}：${successfulRepairs.map((attempt) =>
              `${attempt.strategy === "llm-assisted" ? "AI" : "规则"}修复 ${attempt.changedFields.join("、")}`
            ).join("；")}`
          );
        }
        if (probed.draft.selectorProbeStatus !== "passed") {
          bindingFailures.push({
            scenarioId: draft.scenarioId,
            title: failureTitle,
            target: probed.draft.probeUrl ?? probed.draft.probeTrace?.navigationUrl,
            stage: "binding",
            detail: probed.draft.missingInfo?.join("、") || "无法验证选择器和预期结果",
            requiredInformation: probed.draft.missingInfo ?? []
          });
          continue;
        }
        const approved = await approveScenarioDraft(draft.scenarioId);
        if (approved.draft.draftReviewStatus === "approved") {
          approvedScenarioIds.push(approved.draft.scenarioId);
        } else {
          bindingFailures.push({
            scenarioId: draft.scenarioId,
            title: failureTitle,
            target: approved.draft.probeUrl ?? approved.draft.probeTrace?.navigationUrl,
            stage: "binding",
            detail: approved.draft.missingInfo?.join("、") || "测试路径未通过自动可执行性校验",
            requiredInformation: approved.draft.missingInfo ?? []
          });
        }
      }
      if (bindingRepairs.length) {
        setPlanningMessages((current) => [...current, {
          id: `binding_repair_${Date.now()}`,
          role: "assistant",
          content: `页面绑定已自动修复并重新验证：${bindingRepairs.join("；")}。所有修复都限制在已观察到的按钮、标题、testId 和网络请求内，没有修改被测项目代码。`,
          createdAt: new Date().toISOString()
        }]);
      }
      if (!approvedScenarioIds.length) {
        await analyzeAutomationFailures(bindingFailures, 0);
        const detail = `${bindingFailures.length} 条候选路径未通过页面绑定，已完成 LLM/规则归因；没有可安全执行的路径被伪装成通过。`;
        setPlanningAutomation({ phase: "blocked", detail });
        setMessage(detail);
        return;
      }
      setScenarioId(approvedScenarioIds[0]!);
      const scenarioResponse = await listScenarios();
      setScenarios(scenarioResponse.scenarios);
      setPlanningAutomation({
        phase: "starting-run",
        detail: `正在创建 1 个父运行并调度 ${approvedScenarioIds.length} 条独立路径。${bindingFailures.length ? `另有 ${bindingFailures.length} 条绑定失败，已保留诊断。` : ""}`,
        scenarioId: approvedScenarioIds[0]
      });
      setScenarioId(approvedScenarioIds[0]!);
      const parentOutcome = await executeConfirmedScenarioAutomatically(approvedScenarioIds[0]!, grantedProfile, {
        appUrl: project.frontendUrl,
        projectId: project.id,
        batchMode: true,
        coverageScenarioIds: approvedScenarioIds
      });
      const completedCount = parentOutcome?.success ? approvedScenarioIds.length : 0;
      const executionFailures: AutomationFailure[] = parentOutcome?.success
        ? []
        : [{
            scenarioId: approvedScenarioIds[0]!,
            title: activePlanning.businessFlows.find((flow) => flow.scenarioId === approvedScenarioIds[0])?.title,
            target: project.frontendUrl,
            stage: "execution",
            detail: parentOutcome?.detail ?? "父运行未返回有效聚合结果"
          }];
      const queuedFailures = [
        ...bindingFailures,
        ...executionFailures
      ];
      if (queuedFailures.length) {
        await analyzeAutomationFailures(queuedFailures, completedCount);
        const detail = `已继续完成 ${completedCount} 条路径；${queuedFailures.length} 条失败链路已交给 AI 归因，等待确认修复后重试。`;
        setPlanningAutomation({ phase: "blocked", detail });
        setMessage(detail);
      } else {
        setAutomationFailures([]);
        const detail = `${completedCount} 条测试路径已全部执行完成。`;
        setPlanningAutomation({ phase: "ready", detail, scenarioId: approvedScenarioIds.at(-1) });
        setMessage(detail);
      }
    } catch (error) {
      const detail = userFacingAutomationError(error instanceof Error ? error.message : "自动生成可执行测试路径失败");
      setAutomationFailures([{
        scenarioId: activeScenarioId ?? "automation-preparation",
        title: "自动化测试准备",
        stage: "execution",
        detail
      }]);
      setPlanningAutomation({ phase: "blocked", detail });
      setMessage(detail);
    }
  }

  async function confirmPlanningResult(candidate: PlanningConversationResult) {
    if (hasBlockingPlanningQuestions(candidate)) {
      setMessage("请先回答规划中的澄清问题。");
      return;
    }
    closeDrawers();
    const requiresLogin = planRequiresLoginCredentials(candidate);
    setPreparationLoginError("");
    setPreparationLoginUsername("");
    setPreparationLoginPassword("");
    setPlanningAutomation({
      phase: requiresLogin && !projectDraft?.login?.credentialId
        ? "needs-credentials"
        : !permissionProfile.observe || !permissionProfile.browserControl ? "needs-permission" : "preparing-project",
      detail: requiresLogin && !projectDraft?.login?.credentialId
        ? "本次测试包含登录步骤，请先配置仅用于沙盒的测试账号。"
        : !permissionProfile.observe || !permissionProfile.browserControl
        ? "先允许本次浏览器操作，授权后系统会按顺序准备并执行测试。"
        : "正在检查沙盒、项目服务和测试路径。"
    });
    setRunPreviewModalOpen(true);
    setPlan(candidate.plan);
    setPlanningConfirmed(true);
    if (requiresLogin && !projectDraft?.login?.credentialId) {
      return;
    }
    // Registry scenarios are fixture-specific. Uploaded/OCI projects must
    // first bind a path to their live DOM instead of executing a similarly
    // named scenario from another project.
    if (candidate.recommendedScenarioId && selectedProjectExecutionMode !== "oci") {
      setScenarioId(candidate.recommendedScenarioId);
      await executeConfirmedScenarioAutomatically(candidate.recommendedScenarioId);
    } else {
      setScenarioId("");
      await continueAutomaticPlanning(permissionProfile, undefined, candidate);
    }
  }

  async function confirmPlanningDraft() {
    if (!planningResult) {
      setMessage("请先生成测试计划。");
      return;
    }
    await confirmPlanningResult(planningResult);
  }

  async function loadConnectedContext() {
    if (!hasSelectedProject) {
      setLeftDrawerOpen(true);
      setMessage("请先完成项目接入，再读取外部测试依据。");
      return;
    }
    setMessage("正在通过连接器读取 Git/PR、需求文档和 TAPD/Bug 上下文。");
    try {
      const response = await analyzeConnectedContext(connectorInput());
      setRequirementText(response.context.requirement || requirementText);
      setDiffText(response.context.diff || diffText);
      setBugTicketText(response.context.bugTicket || bugTicketText);
      if (response.context.prUrl) setPrUrl(response.context.prUrl);
      setAnalysis(response.analysis);
      const firstExecutable = response.analysis.scenarioCandidates.find((item) => item.executable && item.mappedScenarioId);
      if (firstExecutable?.mappedScenarioId) setScenarioId(firstExecutable.mappedScenarioId);
      setMessage("连接器上下文已读取并完成场景拆解。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "连接器读取失败");
    }
  }

  async function runDiscovery() {
    if (!hasSelectedProject) {
      setLeftDrawerOpen(true);
      setMessage("请先完成项目接入，再扫描页面生成测试点。");
      return;
    }
    if (!requireBrowserAuthorization("扫描页面并生成测试点草案")) return;
    setMessage("正在扫描页面 DOM、按钮、表单、test-id、network 和 OpenAPI。");
    try {
      const response = await runDiscoveryScan({
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        sourceContexts: analysis?.sourceContexts,
        goal: requirementText,
        credentialId: defaultCredential?.id
      });
      setDiscovery(response.discovery);
      setScenarioDrafts(response.discovery.drafts);
      setMessage(`Discovery 完成：生成 ${response.discovery.suggestions.length} 个测试点建议。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Discovery 扫描失败");
    }
  }

  async function probeDraft(id: string) {
    try {
      const response = await probeScenarioDraft(id, defaultCredential?.id);
      setScenarioDrafts((current) => [response.draft, ...current.filter((draft) => draft.scenarioId !== response.draft.scenarioId)]);
      setGapDrafts((current) => ({ ...current, [response.draft.gapId]: response.draft }));
      setMessage(`草案探测完成：${response.draft.scenarioId} · ${response.draft.selectorProbeStatus}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "草案探测失败");
    }
  }

  async function approveDraft(id: string) {
    try {
      const response = await approveScenarioDraft(id);
      setScenarioDrafts((current) => [response.draft, ...current.filter((draft) => draft.scenarioId !== response.draft.scenarioId)]);
      setGapDrafts((current) => ({ ...current, [response.draft.gapId]: response.draft }));
      if (response.draft.draftReviewStatus === "approved") setScenarioId(response.draft.scenarioId);
      await refresh();
      setMessage(`草案审批完成：${response.draft.scenarioId} · ${response.draft.draftReviewStatus ?? "draft"}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "草案审批失败");
    }
  }

  async function createGrant(payload: { subject: string; role: ProjectGrant["role"] }) {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      setMessage("请先选择项目，再添加项目授权。");
      return;
    }
    try {
      const response = await createProjectGrant(projectId, payload);
      setProjectGrants((current) => [response.grant, ...current]);
      setMessage(`已添加项目授权：${response.grant.subject} · ${response.grant.role}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "添加项目授权失败");
    }
  }

  async function rotateSelectedCredential(id: string, apiKey: string, reason?: string) {
    try {
      const response = await rotateCredential(id, { apiKey, reason });
      setCredentials((current) => current.map((credential) => credential.id === id ? response.credential : credential));
      setMessage(`凭据已轮换：${response.credential.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "凭据轮换失败");
    }
  }

  async function runPlan() {
    if (!hasSelectedProject) {
      setLeftDrawerOpen(true);
      setMessage("请先在“项目接入”中选择或识别项目，再开始测试。");
      return;
    }
    if (!requirementText.trim()) {
      setLeftDrawerOpen(true);
      setMessage("请先填写本次要验证的需求。");
      return;
    }
    if (!planningConfirmed) {
      setLeftDrawerOpen(true);
      setMessage("请先在规划对话中确认测试计划。");
      return;
    }
    if (!scenarioId) {
      setLeftDrawerOpen(true);
      setMessage("请先点击“分析输入”，让系统生成本次测试内容。");
      return;
    }
    if (!requireBrowserAuthorization("接管浏览器执行测试")) return;
    setIsRunning(true);
    setMessage("正在创建运行，等待你确认测试计划。");
    try {
      const response = await createVisualRun(previewUrl, permissionProfile, scenarioId, {
        requirement: requirementText,
        diff: diffText,
        projectId: selectedProjectId || projectDraft?.id,
        executionMode: selectedProjectExecutionMode
      });
      setActiveRunId(response.run.id);
      setActiveRun(response.run);
      setMessage("运行已创建，请先审批测试计划。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "执行失败");
      setIsRunning(false);
    }
  }

  async function approveActivePlan() {
    if (!activeRunId || !activeRun) return;
    try {
      const response = await approveRunPlan(activeRunId, activeRun.version);
      setActiveRun(response.run);
      setMessage("测试计划已审批，请确认浏览器权限。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "计划审批失败"); }
  }

  async function grantActivePermissions() {
    if (!activeRunId || !activeRun) return;
    if (!requireBrowserAuthorization("确认浏览器执行权限")) return;
    try {
      const response = await grantRunPermissions(activeRunId, activeRun.version);
      setActiveRun(response.run);
      setIsRunning(true);
      setMessage("权限已确认，Agent 正在执行并采集证据。");
      const report = await waitForRunReport(activeRunId);
      setResult(report);
      setMessage(report.summary);
    } catch (error) { setMessage(error instanceof Error ? error.message : "权限确认或执行失败");
    } finally { setIsRunning(false); }
  }

  async function controlActiveRun(action: "pause" | "resume" | "cancel" | "decision-override") {
    if (!activeRunId) return;
    try {
      const current = (await getRunProjection(activeRunId)).run;
      const payload = action === "decision-override"
        ? { status: "accepted-risk", reason: reviewReason.trim(), newLabel: "reviewer_accepted_risk" }
        : undefined;
      if (action === "decision-override" && !reviewReason.trim()) {
        setMessage("人工裁决必须填写原因。");
        return;
      }
      const response = await controlRun(activeRunId, action, { expectedVersion: current.version, payload });
      setActiveRun(response.run);
      setMessage(`运行控制已写入事件：${action} · state=${response.run.state}`);
      if (action === "cancel") setIsRunning(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `运行控制失败：${action}`);
    }
  }

  async function runCommitFlow() {
    if (!requireBrowserAuthorization("执行提交检查中的浏览器灰度验收")) return;
    setIsCommitChecking(true);
    setMessage("正在执行提交检查：读取连接器、拆场景、生成计划、执行灰度、生成报告。");
    try {
      const response = await runCommitCheck({
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        credentialId: defaultCredential?.id,
        ...connectorInput(),
        notify: recipients(),
        permissionProfile
      });
      setRequirementText(response.check.context.requirement || requirementText);
      setDiffText(response.check.context.diff || diffText);
      setBugTicketText(response.check.context.bugTicket || bugTicketText);
      setAnalysis(response.check.analysis);
      setPlan(response.check.plan);
      setCommitCheck(response.check);
      if (response.check.harnessGaps) setHarnessGaps((current) => [...response.check.harnessGaps!, ...current]);
      if (response.check.selectedScenarioId) setScenarioId(response.check.selectedScenarioId);
      if (response.check.run) setResult(response.check.run);
      if (response.check.delivery) setDeliveries((current) => [response.check.delivery!, ...current]);
      setMessage(
        response.check.skippedReason ??
        `提交检查完成：${response.check.run?.verdict ?? "未执行"}，plan=${response.check.planSource}，结果已落盘。`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交检查失败");
    } finally {
      setIsCommitChecking(false);
    }
  }

  async function runRequirementAcceptanceFlow() {
    if (!requireBrowserAuthorization("执行需求验收中的浏览器灰度验收")) return;
    setIsAcceptingRequirement(true);
    setMessage("正在执行需求验收：拆场景、生成验收计划、执行浏览器灰度、整理报告。");
    try {
      const basePayload = {
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        credentialId: defaultCredential?.id,
        notify: recipients(),
        permissionProfile
      };
      const response = await runRequirementAcceptance(
        hasRemoteConnectorInput()
          ? {
            ...basePayload,
            ...connectorInput()
          }
          : {
            ...basePayload,
            requirement: requirementText,
            diff: diffText,
            bugTicket: bugTicketText,
            prUrl,
            fallbackDiff: diffText
          }
      );
      setAnalysis(response.acceptance.analysis);
      setPlan(response.acceptance.plan);
      setRequirementAcceptance(response.acceptance);
      if (response.acceptance.harnessGaps) setHarnessGaps((current) => [...response.acceptance.harnessGaps!, ...current]);
      if (response.acceptance.selectedScenarioId) setScenarioId(response.acceptance.selectedScenarioId);
      if (response.acceptance.run) setResult(response.acceptance.run);
      if (response.acceptance.delivery) setDeliveries((current) => [response.acceptance.delivery!, ...current]);
      setMessage(
        response.acceptance.skippedReason ??
        `需求验收完成：${response.acceptance.run?.verdict ?? "未执行"}，plan=${response.acceptance.planSource}，结果已落盘。`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "需求验收失败");
    } finally {
      setIsAcceptingRequirement(false);
    }
  }

  async function regeneratePlan() {
    if (!hasSelectedProject) {
      setLeftDrawerOpen(true);
      setMessage("生成计划前，请先完成项目接入。");
      return;
    }
    if (!requirementText.trim()) {
      setLeftDrawerOpen(true);
      setMessage("生成计划前，请先填写需求。");
      return;
    }
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId || !workspaceSelectors.canGenerate(workspaceState)) return;
    generationRequestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = beginWorkspaceOperation("generating", projectId);
    generationRequestRef.current = { id: requestId, projectId, controller };
    const timeout = window.setTimeout(() => controller.abort("plan_generation_timeout"), 45_000);
    setMessage("正在生成测试计划。");
    try {
      const response = await generatePlan({
        projectId,
        requirement: requirementText,
        diff: diffText,
        credentialId: defaultCredential?.id
      }, { signal: controller.signal });
      if (generationRequestRef.current?.id !== requestId) return;
      setPlan(response.plan);
      setMessage(response.message);
      dispatchWorkspace({
        type: "plan-generated",
        requestId,
        projectId,
        plan: response.plan,
        receipt: {
          source: response.source,
          generatedAt: new Date().toISOString(),
          model: response.provenance?.model,
          ruleVersion: response.provenance?.promptVersion,
          validationStatus: response.provenance?.compilationStatus === "validated" ? "validated" : "unverified"
        }
      });
    } catch (error) {
      if (controller.signal.aborted) {
        dispatchWorkspace({ type: "operation-cancelled", requestId, projectId });
        setMessage(controller.signal.reason === "plan_generation_timeout" ? "生成计划超时，可以重试。" : "已取消生成计划。");
      } else {
        const detail = error instanceof Error ? error.message : "生成计划失败";
        dispatchWorkspace({ type: "operation-failed", requestId, projectId, error: detail });
        setMessage(detail);
      }
    } finally {
      window.clearTimeout(timeout);
      if (generationRequestRef.current?.id === requestId) generationRequestRef.current = null;
    }
  }

  function cancelPlanGeneration() {
    generationRequestRef.current?.controller.abort("user_cancelled");
  }

  async function runPatrolOnce() {
    if (!requireBrowserAuthorization("执行核心路径巡检")) return;
    setIsPatrolling(true);
    setMessage("正在执行一次核心路径巡检。");
    try {
      const response = await runPatrol({
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        scenarioId,
        credentialId: defaultCredential?.id,
        requirement: requirementText,
        diff: diffText,
        plan: plan ?? undefined,
        notify: recipients(),
        permissionProfile
      });
      setResult(response.run);
      setPatrolRun(response.patrol);
      setDeliveries((current) => [response.delivery, ...current]);
      setMessage(`巡检完成：${response.run.verdict}，已生成值班推送。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "巡检失败");
    } finally {
      setIsPatrolling(false);
    }
  }

  async function startScheduler() {
    if (!requireBrowserAuthorization("启动会接管浏览器的定时巡检")) return;
    setIsScheduling(true);
    setMessage("正在保存并启动核心路径巡检计划。");
    try {
      const planPayload = {
        id: "core_path_daily",
        title: "核心路径定时巡检",
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        scenarioId,
        intervalMs: 60_000,
        cron: "*/1 * * * *",
        notify: recipients(),
        retryPolicy: { maxRetries: 2, backoffMs: 2000 },
        escalationPolicy: {
          failureThreshold: 2,
          riskTrendThreshold: "regressed" as const,
          notify: recipients()
        },
        permissionProfile
      };
      const saved = await savePatrolPlan(planPayload);
      const response = await startPatrolJob(planPayload);
      setPatrolPlans((current) => [saved.plan, ...current.filter((job) => job.id !== saved.plan.id)]);
      setPatrolJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
      setMessage("定时巡检计划已保存并启动；失败会按 retry policy 重试。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动巡检失败");
    } finally {
      setIsScheduling(false);
    }
  }

  async function stopScheduler() {
    setIsScheduling(true);
    setMessage("正在停止核心路径定时巡检。");
    try {
      const response = await stopPatrolJob({ id: "core_path_daily" });
      setPatrolJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
      setMessage("定时巡检已停止。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "停止巡检失败");
    } finally {
      setIsScheduling(false);
    }
  }

  async function runSavedPatrolPlan(id: string) {
    if (!requireBrowserAuthorization("执行巡检计划")) return;
    setIsPatrolling(true);
    try {
      const response = await runPatrolPlanNow(id);
      setResult(response.run);
      setPatrolRun(response.patrol);
      setDeliveries((current) => [response.delivery, ...current]);
      await refresh();
      setMessage(`巡检计划执行完成：${response.run.verdict}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "执行巡检计划失败");
    } finally {
      setIsPatrolling(false);
    }
  }

  async function removeSavedPatrolPlan(id: string) {
    try {
      await deletePatrolPlan(id);
      setPatrolPlans((current) => current.filter((planItem) => planItem.id !== id));
      setMessage(`巡检计划已删除：${id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除巡检计划失败");
    }
  }

  async function deliverRun() {
    setMessage("正在生成值班推送。");
    try {
      const response = await deliverRunToBot({
        runId: result?.id,
        provider: botProvider,
        channel: botChannel,
        recipients: recipients(),
        includeScreenshots: botIncludeScreenshots,
        githubPrUrl: optionalTrim(botGithubPrUrl)
      });
      setDeliveries((current) => [response.delivery, ...current]);
      setMessage("值班推送记录已生成。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "推送失败");
    }
  }

  async function openHistoricalRun(runId: string) {
    setMessage(`正在读取历史运行：${runId}`);
    try {
      const bundle = await getRunBundle(runId);
      setResult(runResultFromBundle(bundle));
      setLiveRun(null);
      setCommitCheck(null);
      setRequirementAcceptance(null);
      setPatrolRun(null);
      setRightDrawerOpen(true);
      setLeftDrawerOpen(false);
      setMessage(`已打开历史运行：${runId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取历史运行失败");
    }
  }

  async function runRetentionDryRun() {
    try {
      const response = await runStorageRetention({ apply: false, archive: true });
      await refresh();
      setMessage(`Retention dry-run: actions=${String(response.retention.actionCount ?? 0)}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retention dry-run 失败");
    }
  }

  async function setGapStatus(gap: HarnessGap, status: HarnessGap["status"]) {
    try {
      const response = await updateHarnessGap(gap.id, { status });
      setHarnessGaps((current) => current.map((item) => item.id === gap.id ? response.gap : item));
      setMessage(`Harness gap 已标记为 ${status}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新 harness gap 失败");
    }
  }

  async function draftScenarioFromGap(gap: HarnessGap) {
    try {
      const response = await createHarnessGapDraft(gap.id);
      setGapDrafts((current) => ({ ...current, [gap.id]: response.draft }));
      setMessage(`已生成 scenario 草案：${response.draft.scenarioId}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成 scenario 草案失败");
    }
  }

  async function installScenarioFromGap(gap: HarnessGap) {
    try {
      const response = await installHarnessGapDraft(gap.id);
      setGapDrafts((current) => ({ ...current, [gap.id]: response.draft }));
      setHarnessGaps((current) => current.map((item) => item.id === gap.id ? { ...item, status: "implemented" } : item));
      await refresh();
      setScenarioId(response.draft.scenarioId);
      setMessage(`已安装 scenario 到 registry：${response.draft.scenarioId}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安装 scenario 草案失败");
    }
  }

  /* ===== Drawer content renderers ===== */

  function renderContextDrawer() {
    return (
      <>
        <div className="drawer-header">
          <h2>输入上下文</h2>
          <div className="drawer-toggles">
            <button
              className="icon-button"
              onClick={() => void refreshInputContext()}
              type="button"
              title={isRefreshingContext ? "正在刷新" : "重新扫描当前项目并刷新上下文"}
              disabled={isRefreshingContext}
              aria-label={isRefreshingContext ? "正在刷新项目上下文" : "刷新项目上下文"}
            >
              <RefreshCw className={isRefreshingContext ? "spin" : undefined} size={16} />
            </button>
            <button className="icon-button" onClick={closeDrawers} type="button" title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        {contextRefreshStatus ? <p className="drawer-refresh-status" role="status">{contextRefreshStatus}</p> : null}
        <div className="drawer-body">
          <section className="workflow-guide" aria-label="测试流程">
            <strong>按这个顺序完成测试</strong>
            <span>1. 接入项目</span>
            <span>2. 对话规划</span>
            <span>3. 确认计划</span>
            <span>4. 审批计划并执行</span>
          </section>

          <ProjectWizardPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            projectPath={projectPathInput}
            detection={projectDetection}
            onSelectProject={selectProject}
            onProjectPathChange={setProjectPathInput}
            onDetect={detectCurrentProjectPath}
            detectMessage={projectDetectMessage}
            projectListNotice={projectListNotice}
          />

          <ProjectPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            draft={projectDraft}
            detection={projectDetection}
            diagnosis={projectDiagnosis}
            status={projectRuntime}
            connection={projectConnection}
            launchPhase={projectLaunchPhase}
            recoveryAdvice={runtimeRecoveryAdvice}
            revealLoginSettings={revealProjectLoginSettings}
            onSelect={selectProject}
            onDraftChange={setProjectDraft}
            onRunDiagnosis={diagnoseAndRunCurrentProject}
            onStop={stopCurrentProject}
            onApplyRecoveryCandidate={applyAiRecoveryCandidate}
          />

          <section className="planning-conversation" aria-label="测试规划对话">
            <header>
              <div>
                <h3>测试规划</h3>
                <p>用自然语言描述目标，系统先扫描项目，再由 AI 排定优先级、提出问题并生成可确认的测试计划。</p>
              </div>
              <div className="planning-header-actions">
                {planningResult && <span>{planningResult.llmPlanning?.status === "passed" ? "AI 辅助规划" : planningResult.coverage.scope === "comprehensive" ? "全面灰度" : "定向测试"}</span>}
                <button type="button" disabled={planningBusy || !hasSelectedProject} onClick={() => void continueTestPlanning("请对当前项目进行全面灰度扫描，只盘点流程和覆盖缺口，不调用 AI。", "scan-only")}>快速扫描（省 Token）</button>
              </div>
            </header>

            <div className="planning-messages" aria-live="polite">
              {planningMessages.map((item) => (
                <article className={`planning-message ${item.role}`} key={item.id}>
                  <strong>{item.role === "assistant" ? "AI 测试官" : "你"}</strong>
                  <p>{item.content}</p>
                  <KnowledgeBasis message={item} />
                </article>
              ))}
              {planningBusy && <article className="planning-message assistant pending"><strong>AI 测试官</strong><p>正在扫描代码和整理业务流程…</p></article>}
            </div>

            {planningResult && (
              <section className="planning-draft">
                <div className="planning-coverage">
                  <article><strong>{planningResult.coverage.discovered}</strong><span>识别流程</span></article>
                  <article><strong>{planningResult.coverage.executable}</strong><span>可直接执行</span></article>
                  <article><strong>{planningResult.coverage.autoBindable ?? 0}</strong><span>可自动绑定</span></article>
                  <article><strong>{planningResult.coverage.gaps}</strong><span>覆盖缺口</span></article>
                </div>
                {(planningResult.coverage.autoBindable ?? 0) > 0 && (
                  <p className="planning-coverage-note">
                    “可自动绑定”不是失败：这些流程来自代码扫描。确认后，系统会在沙盒页面中验证真实入口、控件和结果；
                    规则无法唯一判断时才调用 LLM，最终仍无法形成动作与断言的项目才会转为覆盖缺口。
                  </p>
                )}
                {planningResult.llmPlanning?.status === "passed" && (
                  <section className="llm-planning-advice" aria-label="AI 测试规划建议">
                    <strong>AI 规划建议</strong>
                    <p>{planningResult.llmPlanning.summary}</p>
                    <small>{planningResult.llmPlanning.model} · {planningResult.llmPlanning.durationMs ? `${(planningResult.llmPlanning.durationMs / 1000).toFixed(1)} 秒` : "已完成"}</small>
                  </section>
                )}
                {planningResult.llmPlanning?.status === "not_configured" && (
                  <section className="llm-planning-advice muted" aria-label="AI 规划未配置">
                    <strong>尚未启用 AI 规划</strong>
                    <p>当前仅完成快速代码扫描。配置 API Key 后，自然语言规划会自动获得优先级建议和补充问题。</p>
                  </section>
                )}
                {planningResult.clarificationQuestions.length > 0 && (
                  <div className="planning-questions">
                    <strong>{planningHasBlockingQuestions ? "执行前必须确认" : "可选补充（不影响确认）"}</strong>
                    {planningResult.clarificationQuestions.map((question) => (
                      <button type="button" key={question} onClick={() => setPlanningInput(`关于“${question}”，我的回答是：`)}>{question}</button>
                    ))}
                  </div>
                )}
                <details className="planning-flow-list" open>
                  <summary>查看全部 {planningResult.businessFlows.length} 条业务流程</summary>
                  {planningResult.businessFlows.map((flow) => (
                    <article
                      key={flow.id}
                      className={`planning-flow ${flow.status}`}
                      onMouseEnter={() => scheduleFlowDelete(flow.id)}
                      onMouseLeave={() => hideFlowDelete(flow.id)}
                    >
                      <div>
                        <strong>{flow.title}</strong>
                        <span>{flow.kind === "page" ? "页面" : flow.kind === "component" ? "功能组件" : flow.kind === "api" ? "接口" : "测试场景"} · {flow.confidence} confidence</span>
                      </div>
                      <div className="planning-flow-actions">
                        <span className="planning-flow-status">
                          {flow.status === "executable"
                            ? "可执行"
                            : flow.status === "auto-bindable"
                              ? "可自动生成"
                              : flow.status === "needs-input"
                                ? "待补条件"
                                : "覆盖缺口"}
                        </span>
                        {flowDeleteReadyId === flow.id && (
                          <button
                            className="planning-flow-delete"
                            type="button"
                            onClick={() => excludePlanningFlow(flow.id)}
                            aria-label={`从本次测试计划删除 ${flow.title}`}
                          >
                            <Trash2 size={13} />删除
                          </button>
                        )}
                      </div>
                      <p>{flow.reason}</p>
                    </article>
                  ))}
                </details>
                <button
                  className="confirm-planning-button"
                  type="button"
                  disabled={planningHasBlockingQuestions || planningConfirmed || planningAutomationBusy}
                  onClick={() => void confirmPlanningDraft()}
                >
                  {planningAutomationBusy
                    ? "正在自动准备并执行"
                    : planningConfirmed ? "计划已确认" : planningHasBlockingQuestions ? "回答问题后确认" : "确认并自动执行"}
                </button>
                {planningConfirmed && planningAutomation.phase !== "idle" && (
                  <section className={`planning-next-step ${planningAutomation.phase === "blocked" || planningAutomation.phase === "needs-permission" ? "planning-next-step--blocked" : ""}`} aria-live="polite">
                    <strong>
                      {planningAutomation.phase === "preparing-project" ? "正在准备项目"
                        : planningAutomation.phase === "discovering" ? "正在理解真实页面"
                          : planningAutomation.phase === "binding" ? "正在生成可执行测试步骤"
                            : planningAutomation.phase === "starting-run" ? "正在启动自动化测试"
                              : planningAutomation.phase === "running" ? "AI 正在执行测试"
                                : planningAutomation.phase === "ready" ? "自动化测试已完成"
                                  : planningAutomation.phase === "needs-permission" ? "需要一次浏览器授权"
                                    : "自动化暂时无法继续"}
                    </strong>
                    <p>{planningAutomation.detail}</p>
                    {planningAutomation.phase === "needs-permission" && (
                      <button
                        type="button"
                        onClick={grantBrowserPermissionAndContinue}
                      >
                        允许本次浏览器操作并继续
                      </button>
                    )}
                    {planningAutomation.phase === "blocked" && (
                      apiCredentialFeedbackRequired ? (
                        <div className="planning-credential-actions">
                          <p>
                            项目需要 {missingProjectApiCredentials.map((item) => item.envName).join("、")}。
                            选择后会安全注入沙盒，并从当前步骤自动继续。
                          </p>
                          {missingProjectApiCredentials.some((item) => item.exposure === "browser") && (
                            <small>该变量会进入浏览器代码，建议使用可撤销的测试 Key。</small>
                          )}
                          <button
                            type="button"
                            disabled={!defaultCredential?.id || planningAutomationBusy}
                            onClick={() => defaultCredential?.id && void bindMissingProjectApiCredentials(defaultCredential.id, "test-system")}
                          >
                            沿用当前测试模型凭据
                          </button>
                          <select
                            aria-label="为被测项目选择其他 API Key"
                            defaultValue=""
                            disabled={planningAutomationBusy}
                            onChange={(event) => {
                              if (event.target.value) void bindMissingProjectApiCredentials(event.target.value, "dedicated");
                            }}
                          >
                            <option value="">选择其他已保存凭据…</option>
                            {credentials.filter((item) => item.id !== defaultCredential?.id).map((credential) => (
                              <option key={credential.id} value={credential.id}>
                                {credential.name} · {credential.model}
                              </option>
                            ))}
                          </select>
                          <button type="button" onClick={openCredentialSettings}>添加新的 API Key</button>
                        </div>
                      ) : (
                        <div className="row-actions">
                          <button type="button" onClick={() => void continueAutomaticPlanning()}>
                            重新检查并继续
                          </button>
                          <button type="button" onClick={() => {
                            setPlanningConfirmed(false);
                            setPlanningAutomation({ phase: "idle", detail: "" });
                          }}>修改计划</button>
                        </div>
                      )
                    )}
                  </section>
                )}
              </section>
            )}

            <form className="planning-composer" onSubmit={(event) => { event.preventDefault(); void continueTestPlanning(); }}>
              <textarea
                aria-label="描述测试目标"
                value={planningInput}
                onChange={(event) => setPlanningInput(event.target.value)}
                rows={3}
                placeholder="例如：全面灰度测试；重点检查登录、权限、数据刷新和报告生成。"
              />
              <button className="primary" type="submit" disabled={planningBusy || !planningInput.trim()}>
                <Send size={15} />
                {planningBusy ? "规划中" : "发送"}
              </button>
            </form>
          </section>

          <details className="optional-context">
            <summary>补充输入（可选）：代码变更、缺陷单、PR 和远程文档</summary>
            <label>
              代码变更（Git diff）
              <textarea value={diffText} onChange={(event) => setDiffText(event.target.value)} rows={6} />
              <small className="field-hint">可粘贴本次提交或 PR 的代码差异；没有也可以只按需求测试。</small>
            </label>

            <label>
              缺陷或任务编号（TAPD，可选）
              <textarea value={bugTicketText} onChange={(event) => setBugTicketText(event.target.value)} rows={3} />
            </label>

            <label>
              PR 来源（可选）
              <input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/.../pull/123" />
            </label>

            <ConnectorPanel
            requirementPath={requirementPath}
            requirementUrl={requirementUrl}
            bugTicketPath={bugTicketPath}
            bugTicketUrl={bugTicketUrl}
            prDiffUrl={prDiffUrl}
            openApiPath={openApiPath}
            openApiUrl={openApiUrl}
            strictInput={strictInput}
            hasRemoteConnectorInput={hasRemoteConnectorInput()}
            onRequirementPathChange={setRequirementPath}
            onRequirementUrlChange={setRequirementUrl}
            onBugTicketPathChange={setBugTicketPath}
            onBugTicketUrlChange={setBugTicketUrl}
            onPrDiffUrlChange={setPrDiffUrl}
            onOpenApiPathChange={setOpenApiPath}
            onOpenApiUrlChange={setOpenApiUrl}
            onStrictInputChange={setStrictInput}
            />
            <button type="button" onClick={loadConnectedContext}>
              <Link2 size={16} />
              读取以上资料
            </button>
          </details>

          {analysis && (
            <details className="analysis-box analysis-details">
              <summary>查看系统如何生成这些测试内容</summary>
              <>
                <div className="chip-list">
                  {analysis.changedAreas.map((area) => (
                    <span key={area}>{area}</span>
                  ))}
                </div>
                <div className="source-list">
                  {analysis.sources.map((source) => (
                    <article key={source.kind}>
                      <strong>{source.title}</strong>
                      <span>{source.status}</span>
                      <p>{source.summary}</p>
                    </article>
                  ))}
                </div>
                <SourceStatusPanel sources={analysis.sourceContexts} />
                <ImpactPanel impact={analysis.impactAnalysis} />
                <div className="candidate-list">
                  {analysis.scenarioCandidates.map((candidate) => (
                    <article key={candidate.id} className={candidate.executable ? "ready" : "pending"}>
                      <strong>{candidate.title}</strong>
                      <p>{candidate.reason}</p>
                      <span>
                        {candidate.riskLevel} · {candidate.source} · {candidate.executable ? "executable" : "needs harness"}
                      </span>
                      {candidate.mappedScenarioId && (
                        <button type="button" onClick={() => setScenarioId(candidate.mappedScenarioId!)}>
                          改用这项测试
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </>
            </details>
          )}

          {false && (
          <details className="optional-context" open={false} onToggle={() => undefined}>
            <summary>AI 模型与权限（可选）</summary>
            <section className="credential-box">
            <h3>AI 模型凭据</h3>
            <form onSubmit={submitCredential}>
              <input
                aria-label="名称"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="名称"
              />
              <select
                aria-label="Provider"
                value={form.provider}
                onChange={(event) => setForm({ ...form, provider: event.target.value })}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="custom">Custom</option>
              </select>
              <div className="button-row" aria-label="本地模型预设">
                <button type="button" onClick={() => setForm({ ...form, name: "Ollama Local", provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", apiKey: form.apiKey || "ollama", tags: "llm,local,ollama" })}>Ollama 预设</button>
                <button type="button" onClick={() => setForm({ ...form, name: "vLLM Local", provider: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1", model: "local-model", apiKey: form.apiKey || "local", tags: "llm,local,vllm" })}>vLLM 预设</button>
              </div>
              <input
                aria-label="Base URL"
                value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder="Base URL"
              />
              <input
                aria-label="模型"
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
                placeholder="模型"
              />
              <input
                aria-label="API Key"
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder="API Key 不会进入前端持久化"
              />
              <input
                aria-label="标签"
                value={form.tags}
                onChange={(event) => setForm({ ...form, tags: event.target.value })}
                placeholder="标签，逗号分隔"
              />
              <input
                aria-label="Owner"
                value={form.owner}
                onChange={(event) => setForm({ ...form, owner: event.target.value })}
                placeholder="Owner"
              />
              <input
                aria-label="Scopes"
                value={form.scopes}
                onChange={(event) => setForm({ ...form, scopes: event.target.value })}
                placeholder="scopes，逗号分隔"
              />
              <label className="checkbox-row">
                <input
                  checked={form.isDefault}
                  onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
                  type="checkbox"
                />
                设为默认 Key
              </label>
              <div className="form-actions">
                <button type="submit">
                  <Save size={15} />
                  {editingCredentialId ? "保存修改" : "保存 Key"}
                </button>
                {editingCredentialId && (
                  <button type="button" onClick={cancelEdit}>
                    <XCircle size={15} />
                    取消编辑
                  </button>
                )}
              </div>
            </form>

            <div className="credential-list">
              {credentials.map((credential) => (
                <article key={credential.id}>
                  <div>
                    <strong>{credential.name}</strong>
                    <span>{credential.provider} · {credential.apiKeyMasked}</span>
                    <span>{credential.model} · {credential.tags.join(", ") || "无标签"}</span>
                    <span>owner={credential.owner ?? "n/a"} · scopes={(credential.scopes ?? []).join(", ") || "default"} · rotations={credential.rotationHistory?.length ?? 0}</span>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      onClick={async () => {
                        const response = await testCredential(credential.id);
                        setMessage(response.message);
                      }}
                    >
                      <FileSearch size={15} />
                      测试连接
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="编辑"
                      onClick={() => editCredential(credential)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={credential.isDefault}
                      type="button"
                      title="设为默认"
                      onClick={async () => {
                        await updateCredential(credential.id, { isDefault: true });
                        await refresh();
                      }}
                    >
                      <Star size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="删除"
                      onClick={async () => {
                        await deleteCredential(credential.id);
                        await refresh();
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            </section>
            <SecurityPanel
              security={securitySummary}
              credentials={credentials}
              grants={projectGrants}
              selectedProjectId={selectedProjectId}
              onCreateGrant={createGrant}
              onRotateCredential={rotateSelectedCredential}
            />
          </details>
          )}
        </div>
      </>
    );
  }

  function renderEvidenceDrawer() {
    return (
      <EvidencePanel
        result={result}
        liveRun={liveRun}
        displayedLoopEvents={displayedLoopEvents}
        auditStore={auditStore}
        commitCheck={commitCheck}
        requirementAcceptance={requirementAcceptance}
        patrolRun={patrolRun}
        deliveries={deliveries}
        isBusy={isBusy}
        liveStatusText={liveStatusText}
        focusEvidenceId={focusEvidenceId}
        onClose={() => setRightDrawerOpen(false)}
      />
    );
  }

  return (
    <main className="app-shell minimal-shell">
      <header className="topbar minimal-topbar">
        <div>
          <p className="eyebrow">AI Test Officer</p>
          <h1>测试官工作台</h1>
        </div>
        <div className="minimal-topbar-actions">
          <OidcSessionPanel configured={oidcConfigured()} authenticated={oidcAuthenticated} />
          <button className="ghost-button" onClick={() => refresh()} type="button">
            <RefreshCw size={15} />
            刷新
          </button>
          <button
            className={`ghost-button ${leftDrawerOpen ? "active" : ""}`}
            onClick={() => { setLeftDrawerOpen((v) => !v); setRightDrawerOpen(false); }}
            type="button"
          >
            <PanelLeft size={15} />
            详细配置
          </button>
          <button
            className={`ghost-button ${rightDrawerOpen ? "active" : ""}`}
            onClick={() => { setRightDrawerOpen((v) => !v); setLeftDrawerOpen(false); }}
            type="button"
          >
            证据详情
            <PanelRight size={15} />
          </button>
          <button
            className="status-pill"
            type="button"
            onClick={openCredentialSettings}
            aria-label={defaultCredential ? `打开 API Key 配置：${defaultCredential.name}` : "打开 API Key 配置"}
            title="打开 API Key 配置"
          >
            <KeyRound size={16} />
            {defaultCredential ? `${defaultCredential.name} · ${defaultCredential.model}` : "未配置 API Key"}
          </button>
        </div>
      </header>
      {renderApiSettingsDialog()}

      {runPreviewModalOpen ? (
        <div className="run-preview-overlay" role="dialog" aria-modal="true" aria-label="AI 测试准备与授权">
          <section className="run-preview-dialog showing-preparation">
            <header>
                  <div>
                    <span className="section-kicker">
                  {planningAutomation.phase === "needs-credentials" ? "需要测试账号"
                    : planningAutomation.phase === "needs-permission" ? "需要你的确认"
                    : planningAutomation.phase === "blocked" ? "准备遇到问题"
                      : "正在准备测试"}
                </span>
                <strong>{planningAutomation.detail || "正在检查隔离环境与测试条件"}</strong>
              </div>
              <button type="button" onClick={() => setRunPreviewModalOpen(false)}>最小化</button>
            </header>
            <div className="run-preparation-panel" aria-live="polite">
              <ol className="run-preparation-steps">
                <li className={planningAutomation.phase === "needs-permission" || planningAutomation.phase === "needs-credentials"
                  ? "active"
                  : ["preparing-project", "discovering", "binding", "starting-run", "running", "ready"].includes(planningAutomation.phase) ? "complete" : ""}>
                  <span>1</span>
                  <div><strong>确认操作授权</strong><small>授权仅对本次运行生效，可随时取消</small></div>
                </li>
                <li className={planningAutomation.phase === "preparing-project"
                  ? "active"
                  : ["discovering", "binding", "starting-run", "running", "ready"].includes(planningAutomation.phase) ? "complete" : ""}>
                  <span>2</span>
                  <div><strong>准备隔离环境</strong><small>检查项目服务、沙盒和运行地址</small></div>
                </li>
                <li className={planningAutomation.phase === "discovering"
                  ? "active"
                  : ["binding", "starting-run", "running", "ready"].includes(planningAutomation.phase) ? "complete" : ""}>
                  <span>3</span>
                  <div><strong>扫描真实页面</strong><small>识别控件、接口和可验证结果</small></div>
                </li>
                <li className={planningAutomation.phase === "binding"
                  ? "active"
                  : ["starting-run", "running", "ready"].includes(planningAutomation.phase) ? "complete" : ""}>
                  <span>4</span>
                  <div><strong>生成可执行路径</strong><small>绑定动作、断言与证据要求</small></div>
                </li>
              </ol>
              {planningAutomation.phase === "needs-credentials" ? (
                <section className="run-permission-request run-credentials-request">
                  <strong>本次测试需要登录账号</strong>
                  <p>测试计划包含登录步骤。账号会加密保存，只在本次项目的隔离沙盒中使用，不会写入对话或项目源码。</p>
                  <div className="connector-grid">
                    <label>
                      测试账号
                      <input
                        autoComplete="off"
                        value={preparationLoginUsername}
                        onChange={(event) => setPreparationLoginUsername(event.target.value)}
                        placeholder="邮箱或用户名"
                      />
                    </label>
                    <label>
                      测试密码
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={preparationLoginPassword}
                        onChange={(event) => setPreparationLoginPassword(event.target.value)}
                        placeholder="输入测试密码"
                      />
                    </label>
                  </div>
                  {preparationLoginError ? <p className="project-login-save-message" role="alert">{preparationLoginError}</p> : null}
                  <div>
                    <button type="button" onClick={() => {
                      setRunPreviewModalOpen(false);
                      setPlanningConfirmed(false);
                      setPlanningAutomation({ phase: "idle", detail: "" });
                      setMessage("本次测试尚未开始；确认包含登录步骤的计划前，需要先配置测试账号。");
                    }}>暂不配置</button>
                    <button className="primary" type="button" disabled={preparationLoginSaving} onClick={() => void savePreparationLoginAndContinue()}>
                      {preparationLoginSaving ? "正在保存…" : "保存账号并继续"}
                    </button>
                  </div>
                </section>
              ) : planningAutomation.phase === "needs-permission" ? (
                <section className="run-permission-request">
                  <strong>允许 AI 操作本次沙盒浏览器？</strong>
                  <p>将执行点击、输入、页面跳转和证据采集；不会控制你的桌面或其他应用。</p>
                  <div>
                    <button type="button" onClick={() => setRunPreviewModalOpen(false)}>暂不授权</button>
                    <button className="primary" type="button" onClick={grantBrowserPermissionAndContinue}>允许并继续</button>
                  </div>
                </section>
              ) : planningAutomation.phase === "blocked" ? (
                <section className="run-preparation-error">
                  <strong>自动准备暂时无法继续</strong>
                  <p>{planningAutomation.detail}</p>
                    <button type="button" onClick={returnBlockedPreparationToAssistant}>返回 AI 测试助手处理</button>
                </section>
              ) : (
                <div className="run-preparation-waiting">
                  <Activity size={18} />
                  <span>{planningAutomation.detail || "正在准备，请稍候…"}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      <section className={`workspace minimal-workspace ${projectPreviewReady ? "assistant-focus" : ""}`}>
        <div
          className={`drawer-overlay ${leftDrawerOpen || rightDrawerOpen ? "open" : ""}`}
          onClick={closeDrawers}
        />

        <aside className={`drawer drawer-left ${leftDrawerOpen ? "open" : ""}`}>
          {renderContextDrawer()}
        </aside>

        <aside className={`drawer drawer-right ${rightDrawerOpen ? "open" : ""}`}>
          {renderEvidenceDrawer()}
        </aside>

        <aside className="simple-sidebar">
          <button
            className="sidebar-configure-button"
            onClick={() => {
              setLeftDrawerOpen(true);
              setRightDrawerOpen(false);
            }}
            type="button"
          >
            点击配置
          </button>
          <section className="sidebar-planning-assistant" aria-label="AI 测试助手规划">
              <header>
                <div>
                  <span className="section-kicker">AI 测试助手</span>
                  <h3>规划测试</h3>
                </div>
              </header>
              <span className="sidebar-current-project">当前项目：{selectedProjectName}</span>
              <div className="sidebar-planning-messages" aria-live="polite">
                {planningMessages.map((item, index) => {
                  const attachesRunActions = assistantFeedbackRequired
                    && item.role === "assistant"
                    && item.content === runAssistantMessage
                    && !planningMessages.slice(index + 1).some((candidate) => candidate.content === runAssistantMessage);
                  const attachedSuggestedAction = item.suggestedAction && item.suggestedAction !== "none"
                    ? item.suggestedAction
                    : undefined;
                  const isLatestAssistant = item.id === latestPlanningAssistant?.id;
                  return (
                    <AssistantConversationMessage
                      message={item}
                      key={item.id}
                      // Only the latest assistant message may act: re-running a
                      // stale plan would fight the current run state.
                      onRepairPlanAction={isLatestAssistant ? executeRepairPlanAction : undefined}
                      onOpenRepairEvidence={openRepairPlanEvidence}
                      repairPlanActionStatus={repairPlanActionStatus ?? undefined}
                      actions={attachesRunActions ? (
                        <RunAssistantPanel
                          message={runAssistantMessage}
                          blocked={runIsBlocked || screenshotRateLimited}
                          authRequired={authFeedbackRequired}
                          credentialReady={credentialReadyForRetry}
                          apiCredentialRequired={apiCredentialFeedbackRequired}
                          apiCredentialEnvNames={missingProjectApiCredentials.map((candidate) => candidate.envName)}
                          browserExposedApiCredential={missingProjectApiCredentials.some((candidate) => candidate.exposure === "browser")}
                          credentials={credentials}
                          defaultCredentialId={defaultCredential?.id}
                          busy={planningBusy || isRunning || planningAutomationBusy || assistantChatBusy || projectRecoveryBusy}
                          onSubmit={submitRunAssistantFeedback}
                          onConfigureCredentials={openProjectLoginSettings}
                          onRetryWithCredentials={retryWithConfiguredLogin}
                          onBindApiCredential={bindMissingProjectApiCredentials}
                          onOpenApiSettings={openCredentialSettings}
                          reviewRequired={reviewRequired}
                          reviewReason={reviewReason}
                          onReviewReasonChange={setReviewReason}
                          onAcceptRisk={() => controlActiveRun("decision-override")}
                          autoRepairAvailable={assistantAutoRepairAvailable}
                          autoRepairLabel={runtimeRecoveryAvailable
                            ? "重新启动沙盒并诊断"
                            : discoveryRecoveryAvailable ? "重新扫描页面并绑定路径"
                            : pathBindingRepairable ? "重新绑定并验证路径" : "生成沙盒代码修复"}
                          autoRepairDescription={runtimeRecoveryAvailable
                            ? "系统会自动启动 Docker Desktop（如需要）、重新启动沙盒、检查健康状态并重新扫描页面；不会修改项目源码。"
                            : discoveryRecoveryAvailable
                              ? "页面已经连通；系统只会重新扫描页面、控件和网络并重新绑定路径，不会修改项目源码或覆盖已有证据。"
                            : pathBindingRepairable
                              ? "根据已探测页面重新绑定入口、控件和验证条件，然后立即复验。不会修改项目源码。"
                              : "读取失败断言和证据，在沙盒副本中生成最小补丁，并展示 Diff 与验证结果。"}
                          onAutoRepair={runtimeRecoveryAvailable
                            ? () => recoverProjectAndRetry("runtime")
                            : discoveryRecoveryAvailable ? () => recoverProjectAndRetry("discovery")
                            : pathBindingRepairable ? repairBlockedPlanning : openCodeRepairWorkspace}
                          onEditPlan={() => {
                            setPlanningConfirmed(false);
                            setPlanningAutomation({ phase: "idle", detail: "" });
                          }}
                          conversationVisible={false}
                        />
                      ) : attachedSuggestedAction === "start-run" ? (
                        <div className="assistant-command-preview assistant-plan-command">
                          {planningResult && discoveryAllowsPlanning ? (
                            <>
                              <strong>本次准备测试 {planningResult.businessFlows.length} 条流程</strong>
                              <div className="assistant-plan-summary">
                                <span>{planningResult.coverage.executable} 条可直接执行</span>
                                <span>{planningResult.coverage.autoBindable ?? 0} 条自动绑定页面</span>
                                {(planningResult.coverage.needsInput + planningResult.coverage.gaps) > 0
                                  ? <span>{planningResult.coverage.needsInput + planningResult.coverage.gaps} 条需补充或阻塞</span>
                                  : null}
                              </div>
                              <details className="assistant-plan-list" open>
                                <summary>查看要测试的具体内容</summary>
                                <ol>
                                  {planningResult.businessFlows.map((flow) => (
                                    <li key={flow.id}>
                                      <span>{flow.title}</span>
                                      <small>{flow.status === "executable"
                                        ? "直接执行"
                                        : flow.status === "auto-bindable"
                                          ? "自动识别页面后执行"
                                          : flow.status === "needs-input"
                                            ? "需要补充条件"
                                            : "当前阻塞"}</small>
                                    </li>
                                  ))}
                                </ol>
                              </details>
                              <button
                                className="assistant-suggested-action"
                                type="button"
                                disabled={assistantChatBusy || isRunning || planningHasBlockingQuestions}
                                onClick={() => void executeAssistantSuggestedAction(attachedSuggestedAction)}
                              >
                                {planningHasBlockingQuestions ? "请先补充必要信息" : "确认并开始测试"}
                              </button>
                            </>
                          ) : (
                            <>
                              <strong>测试清单尚未生成</strong>
                              <span>系统会先扫描项目并列出页面、功能和接口，再允许确认执行。</span>
                              <button
                                className="assistant-suggested-action"
                                type="button"
                                disabled={assistantChatBusy || planningBusy}
                                onClick={() => void continueTestPlanning("全面扫描", "llm-guided")}
                              >
                                生成测试清单
                              </button>
                            </>
                          )}
                        </div>
                      ) : attachedSuggestedAction ? (
                        <div className="assistant-command-preview">
                          <span>{item.requiresConfirmation === false ? "可立即执行" : "确认后执行"}</span>
                          <button
                            className="assistant-suggested-action"
                            type="button"
                            disabled={assistantChatBusy}
                            onClick={() => void executeAssistantSuggestedAction(attachedSuggestedAction)}
                          >
                            {assistantActionLabel(attachedSuggestedAction)}
                          </button>
                        </div>
                      ) : isLatestAssistant && !assistantChatBusy ? (
                        <div className="assistant-quick-commands" aria-label="可以继续这样问">
                          {assistantQuickCommands.slice(0, 3).map((command) => (
                            <button key={command} type="button" onClick={() => void routeAssistantContent(command)}>
                              {command}
                            </button>
                          ))}
                        </div>
                      ) : undefined}
                    />
                  );
                })}
                {planningBusy ? (
                  <AssistantConversationMessage message={{
                    id: "planning_pending",
                    role: "assistant",
                    content: "正在分析项目和可执行路径…",
                    createdAt: new Date().toISOString()
                  }} />
                ) : null}
              </div>
              {discovery?.orchestration && discovery.orchestration.status !== "ready" ? (
                <DiscoveryOrchestrationNotice discovery={discovery} />
              ) : null}
              {planningResult && discoveryAllowsPlanning ? (
                <div className="sidebar-planning-result">
                  <span>{planningResult.coverage.discovered} 条流程 · {planningResult.coverage.executable} 条可直接执行 · {planningResult.coverage.autoBindable ?? 0} 条待页面绑定</span>
                  <details className="sidebar-flow-list" open>
                    <summary>确认本次要测试的 {planningResult.businessFlows.length} 条流程</summary>
                    <div>
                      {planningResult.businessFlows.map((flow) => (
                        <article
                          className={`planning-flow ${flow.status}`}
                          key={flow.id}
                          onMouseEnter={() => scheduleFlowDelete(flow.id)}
                          onMouseLeave={() => hideFlowDelete(flow.id)}
                        >
                          <header>
                            <strong>{flow.title}</strong>
                            <span>{flow.status === "executable" ? "可执行" : flow.status === "auto-bindable" ? "待页面绑定" : flow.status === "needs-input" ? "待补条件" : "覆盖缺口"}</span>
                          </header>
                          <p>{flow.reason}</p>
                          {flowDeleteReadyId === flow.id ? (
                            <button className="planning-flow-delete" type="button" onClick={() => excludePlanningFlow(flow.id)}>
                              <Trash2 size={13} /> 删除
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </details>
                  <button
                    className="primary execute-plan-button"
                    type="button"
                    disabled={planningHasBlockingQuestions || planningConfirmed || planningAutomationBusy}
                    onClick={() => void confirmPlanningDraft()}
                  >
                    {planningAutomationBusy ? "准备执行中" : planningConfirmed ? "计划已确认" : planningHasBlockingQuestions ? "请先补充信息" : "确认并执行"}
                  </button>
                </div>
              ) : null}
              <form className="sidebar-planning-composer" onSubmit={(event) => {
                event.preventDefault();
                if (planningInput.trim()) void routeAssistantInput();
              }}>
                <textarea
                  aria-label="向 AI 测试助手提问或描述测试目标"
                  value={planningInput}
                  onChange={(event) => setPlanningInput(event.target.value)}
                  rows={3}
                  placeholder="可问“现在测试到哪了？”；输入“全面扫描”可生成测试清单。"
                />
                <button
                  className="primary composer-send-button"
                  type="submit"
                  disabled={planningBusy || assistantChatBusy || !planningInput.trim()}
                  aria-label={planningBusy || assistantChatBusy ? "AI 正在回复" : "发送给 AI 测试助手"}
                  title={planningBusy || assistantChatBusy ? "AI 正在回复" : "发送"}
                >
                  {assistantChatBusy ? <Activity size={14} /> : <Send size={14} />}
                </button>
              </form>
            </section>

          <div className="sidebar-footer">
            <span>{runHistory.length} 次历史运行</span>
            <button onClick={() => setRightDrawerOpen(true)} type="button">打开记录</button>
          </div>
        </aside>

        <section
          // A project switch replaces the centre workspace instead of reusing
          // an old scroll container. This lets the browser initialise the new
          // workspace at its natural top position without imperative scroll
          // restoration or focus-jumping workarounds.
          key={`workspace:${selectedProjectId || "none"}`}
          className="main-panel simple-main"
        >
          <div className="mission-stage">
            <div>
              <p className="eyebrow">AI 测试任务</p>
              <h2>{selectedCandidate?.title ?? selectedScenario?.title ?? (scenarioId || "等待生成测试内容")}</h2>
              <p className="mission-summary" aria-label="本次测试摘要">
                测试对象：{selectedProjectName}　·　测试依据：{sourceContextCount || analysis?.sources.length || 0} 个来源　·　执行计划：{planStepCount || "待生成"}{planStepCount ? " 步" : ""}{planningDraftReady ? "　·　测试计划草案已生成，请检查业务流程后确认。" : ""}
              </p>
            </div>
            <div className="run-command-actions">
              <button
                className="primary"
                disabled={!canStartRun}
                onClick={runPlan}
                title={!hasSelectedProject ? "请先选择或识别项目" : !requirementText.trim() ? "请先填写需求" : undefined}
                type="button"
              >
                {isRunning ? <Activity size={16} /> : <Play size={16} />}
                {isRunning ? "执行中" : "开始测试"}
              </button>
              {activeRunId && (
                <>
                  <button disabled={activeRun?.state !== "awaiting-plan-approval"} onClick={() => void approveActivePlan()} type="button">审批计划</button>
                  <button disabled={activeRun?.state !== "awaiting-permission" || !permissionProfile.browserControl} onClick={() => void grantActivePermissions()} type="button">确认权限并执行</button>
                  <button disabled={!activeRun || !["queued", "preparing", "running", "collecting", "judging"].includes(activeRun.state)} onClick={() => void controlActiveRun("pause")} type="button">暂停</button>
                  <button disabled={!activeRun || activeRun.state !== "paused"} onClick={() => void controlActiveRun("resume")} type="button">恢复</button>
                  <button disabled={!activeRun || ["completed", "failed", "blocked", "cancelled"].includes(activeRun.state)} onClick={() => void controlActiveRun("cancel")} type="button">取消</button>
                </>
              )}
            </div>
          </div>

          {(isRunning || planningAutomationBusy) ? (
            <div className="mission-status">
              <span className={isRunning ? "status-dot running" : "status-dot"} />
              {message || (isRunning ? "Agent 正在执行计划并收集证据" : "正在准备测试环境")}
            </div>
          ) : null}

          {false && projectPreviewReady && (!planningConfirmed || planningBusy || planningAutomation.phase === "blocked" || planningAutomation.phase === "needs-permission") ? (
            <section className="assistant-planning-stage" aria-label="AI 测试助手规划">
              <header>
                <div>
                  <span className="section-kicker">AI 测试助手</span>
                  <h3>告诉我想验证什么</h3>
                  <p>用自然语言描述目标。系统会先复用低成本扫描，再在复杂、陌生或有冲突时调用 LLM 制定可执行计划。</p>
                </div>
                <button type="button" disabled={planningBusy} onClick={() => void continueTestPlanning("请对当前项目进行全面灰度扫描，只盘点流程和覆盖缺口，不调用 AI。", "scan-only")}>快速扫描</button>
              </header>
              <div className="assistant-planning-messages" aria-live="polite">
                {planningMessages.slice(-3).map((item) => (
                  <article className={item.role} key={item.id}>
                    <strong>{item.role === "assistant" ? "AI 测试官" : "你"}</strong>
                    <p>{item.content}</p>
                  </article>
                ))}
                {planningBusy ? <article className="assistant pending"><strong>AI 测试官</strong><p>正在分析项目、需求与可执行路径…</p></article> : null}
              </div>
              {planningResult ? (
                <div className="assistant-planning-result">
                  <div className="planning-coverage">
                    <article><strong>{planningResult!.coverage.discovered}</strong><span>识别流程</span></article>
                    <article><strong>{planningResult!.coverage.executable}</strong><span>可直接执行</span></article>
                    <article><strong>{planningResult!.coverage.autoBindable ?? 0}</strong><span>待真实页面绑定</span></article>
                    <article><strong>{planningResult!.coverage.gaps}</strong><span>需补条件</span></article>
                  </div>
                  <div className="model-budget-summary">
                    <strong>本次模型预算</strong>
                    <span>Planner ≤ 2 · Judge ≤ 1 · Triage ≤ 1</span>
                    <span>总 Token ≤ 12,000 · 总模型时间 ≤ 120 秒</span>
                    <small>价格未知时显示 unknown；达到预算后保留机器结论并转人工复核。</small>
                  </div>
                  {planningResult!.clarificationQuestions.length ? <p className="assistant-question">{planningResult!.clarificationQuestions[0]}</p> : null}
                  <button
                    className="primary"
                    type="button"
                    disabled={planningHasBlockingQuestions || planningConfirmed || planningAutomationBusy}
                    onClick={() => void confirmPlanningDraft()}
                  >
                    {planningAutomationBusy ? "正在准备执行" : planningConfirmed ? "计划已确认" : planningHasBlockingQuestions ? "请先补充信息" : "确认计划并开始测试"}
                  </button>
                </div>
              ) : null}
              <form className="planning-composer" onSubmit={(event) => { event.preventDefault(); void continueTestPlanning(); }}>
                <textarea aria-label="描述测试目标" value={planningInput} onChange={(event) => setPlanningInput(event.target.value)} rows={3} placeholder="例如：全面灰度测试；重点检查登录、权限、数据刷新和报告生成。" />
                <button className="primary" type="submit" disabled={planningBusy || !planningInput.trim()}><Send size={15} />{planningBusy ? "规划中" : "发送"}</button>
              </form>
            </section>
          ) : null}

          {repairWorkspaceOpen && repairSession ? (
            <RepairWorkspace
              session={repairSession}
              canApply={viteEnv.VITE_REPAIR_HOST_APPLY_ENABLED === "true"}
              onLoadFile={(filePath) => getRepairFile(repairSession.id, filePath).then((response) => response.file)}
              onSaveFile={saveRepairFile}
              onValidate={validateCurrentRepair}
              onExport={exportCurrentRepair}
              onApply={applyCurrentRepair}
              onClose={() => setRepairWorkspaceOpen(false)}
            />
          ) : null}

          {/* A paused run outranks everything else on screen: the graph is
              literally blocked until the operator answers, so the decision
              request sits above the live view rather than inside a drawer. */}
          {agentProjection?.pendingInterrupt && agentProjection.pendingInterrupt.status === "pending" ? (
            <InterruptDecisionPanel
              interrupt={agentProjection.pendingInterrupt}
              busy={interruptBusy}
              error={interruptError ?? undefined}
              onDecide={(decision, note) => submitInterruptDecision(decision, note)}
              onOpenEvidence={openInterruptEvidence}
              onOpenCredentials={() => {
                setLeftDrawerOpen(true);
                setMessage("请在项目设置中配置测试账号，配置完成后回到此处提交决策。");
              }}
              onRecoverSandbox={() => void executeAssistantSuggestedAction("retry-runtime")}
              onReopenDiscovery={() => void executeAssistantSuggestedAction("retry-discovery")}
              onOpenRepairWorkspace={() => void openCodeRepairWorkspace()}
            />
          ) : null}

          <section className="live-view simple-live-view" aria-label="测试现场" hidden={repairWorkspaceOpen}>
            <header className="live-view-toolbar">
              <div className="live-view-window-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <span className="live-view-mode">
                {latestScreenshot ? "沙盒执行画面" : projectPreviewReady ? "内置项目画面" : "沙盒测试现场"}
              </span>
              <code title={previewUrl}>{previewUrl || "尚未启动项目"}</code>
              {projectPreviewReady && !latestScreenshot && (
                <button type="button" onClick={() => setPreviewRevision((current) => current + 1)} aria-label="刷新项目预览">
                  <RefreshCw size={14} />
                  刷新
                </button>
              )}
            </header>
            {latestScreenshot ? (
              <div className="live-view-content">
                <AuthenticatedArtifactImage artifactUrl={latestScreenshot} alt="Agent 最新测试画面" onLoadIssue={setScreenshotIssue} />
                {isRunning && <span className="live-capture-badge"><Activity size={13} /> 正在执行</span>}
              </div>
            ) : projectPreviewReady ? (
              <div className="live-view-content">
                <iframe
                  key={`${previewUrl}:${previewRevision}`}
                  className="live-view-passive-frame"
                  src={previewUrl}
                  title={`${selectedProjectName} 项目预览`}
                  sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
                  tabIndex={-1}
                  ref={(frame) => {
                    // This is a passive visual mirror. Browser actions belong
                    // to the isolated test runtime, not to this document.
                    // React's current iframe typings do not expose `inert`.
                    frame?.setAttribute("inert", "");
                  }}
                />
                {isRunning && <span className="live-capture-badge waiting"><Activity size={13} /> 等待第一帧执行证据</span>}
              </div>
            ) : (
              <div className="live-view-placeholder">
                <div className="live-view-grid" />
                <div className="live-view-scanner" />
                <div className="live-view-dots">
                  <span />
                  <span />
                  <span />
                </div>
                <p>{hasSelectedProject ? "启动并检查项目后，这里会显示测试页面" : "选择项目后，这里会显示测试页面"}</p>
              </div>
            )}
          </section>

          <section className="timeline-stage">
            <div className="section-title-row">
              <div>
                <span className="section-kicker">执行记录</span>
                <h3>Agent 正在做什么</h3>
                <p>按时间顺序查看操作、结果和已保存的证据。</p>
              </div>
              <button
                className="timeline-plan-button"
                disabled={!workspaceSelectors.canGenerate(workspaceState) && workspaceState.phase !== "generating"}
                onClick={workspaceState.phase === "generating" ? cancelPlanGeneration : regeneratePlan}
                type="button"
              >
                {workspaceState.phase === "generating" ? <X size={15} /> : <ListChecks size={15} />}
                {workspaceState.phase === "generating" ? "取消生成" : workspaceState.phase === "failed" ? "重试生成计划" : "重新生成计划"}
              </button>
              {activeRunId && ["fail", "blocked", "needs-human-review"].includes(String(latestDecision)) ? (
                <button className="timeline-plan-button" disabled={repairBusy} onClick={() => void openCodeRepairWorkspace()} type="button">
                  <Pencil size={15} />
                  {repairBusy ? "正在准备修复" : "分析并修复"}
                </button>
              ) : null}
            </div>
            {workspaceState.generation ? (
              <p className="muted">
                计划来源：{workspaceState.generation.source}
                {workspaceState.generation.model ? ` · 模型：${workspaceState.generation.model}` : ""}
                {` · ${workspaceState.generation.validationStatus === "validated" ? "已校验" : "待校验"}`}
                {` · ${new Date(workspaceState.generation.generatedAt).toLocaleTimeString()}`}
              </p>
            ) : null}
            {workspaceState.error ? <p className="error-text" role="alert">{workspaceState.error}</p> : null}
            <RunTimeline result={result} displayedLoopEvents={displayedLoopEvents} />
          </section>

          <details className="advanced-section">
            <summary>
              <span>
                <strong>高级能力与运行细节</strong>
                <small>Discovery、巡检、推送、存储和完整计划</small>
              </span>
            </summary>
            <div className="advanced-stack">
              <DiscoveryPanel
                discovery={discovery}
                drafts={scenarioDrafts}
                onScan={runDiscovery}
                onProbeDraft={probeDraft}
                onApproveDraft={approveDraft}
              />

              <div className="compact-action-row">
                <button disabled={isPatrolling} onClick={runPatrolOnce} type="button">
                  <CalendarClock size={16} />
                  {isPatrolling ? "巡检中" : "巡检一次"}
                </button>
                <button disabled={isScheduling} onClick={startScheduler} type="button">
                  <Timer size={16} />
                  启动定时
                </button>
                <button disabled={isScheduling} onClick={stopScheduler} type="button">
                  <Square size={16} />
                  停止定时
                </button>
                <button disabled={!result} onClick={deliverRun} type="button">
                  <Send size={16} />
                  推送值班
                </button>
              </div>

              <BotDeliveryPanel
                provider={botProvider}
                channel={botChannel}
                recipients={notifyList}
                githubPrUrl={botGithubPrUrl}
                includeScreenshots={botIncludeScreenshots}
                deliveries={deliveries}
                disabled={!result}
                onProviderChange={setBotProvider}
                onChannelChange={setBotChannel}
                onRecipientsChange={setNotifyList}
                onGithubPrUrlChange={setBotGithubPrUrl}
                onIncludeScreenshotsChange={setBotIncludeScreenshots}
                onDeliver={deliverRun}
              />

              <PatrolPanel
                patrolJobs={patrolJobs}
                patrolPlans={patrolPlans}
                trend={patrolTrend}
                onRunPlan={runSavedPatrolPlan}
                onDeletePlan={removeSavedPatrolPlan}
              />

              <StoragePanel storage={storageStatus} archives={storageArchives} onDryRunRetention={runRetentionDryRun} />
              <BenchmarkPanel summary={benchmarkSummary} />
              <HistoryPanel runs={runHistory} activeRunId={result?.id} onOpenRun={openHistoricalRun} />

              <section className="capability-grid">
                <h3>平台能力映射</h3>
                {capabilities.map((capability) => (
                  <article key={capability.id}>
                    <header>
                      <strong>{capability.title}</strong>
                      <span>{capability.status}</span>
                    </header>
                    <p>{capability.purpose}</p>
                    <code>{capability.demoAction}</code>
                  </article>
                ))}
              </section>

              {activeExecutablePlan && (
                <section className="levels">
                  <h3>Executable Plan Contract</h3>
                  <article className={activeExecutablePlan.status === "valid" ? "passed" : "warning"}>
                    <strong>{activeExecutablePlan.id}</strong>
                    <p>{activeExecutablePlan.source} · {activeExecutablePlan.status} · steps={activeExecutablePlan.steps.length}</p>
                  </article>
                  {activeExecutablePlan.steps.map((step) => (
                    <article className="level" key={step.id}>
                      <header>
                        <strong>{step.title}</strong>
                        <span>{step.scenarioId}</span>
                      </header>
                      <p>assertions: {step.assertions.join(", ")}</p>
                      <p>evidence: {step.evidenceRequirements.join(", ")}</p>
                    </article>
                  ))}
                </section>
              )}

              <section className="harness-gap-box">
                <h3>Harness Gaps</h3>
                {harnessGaps.slice().reverse().slice(0, 6).map((gap) => {
                  const draft = gapDrafts[gap.id];
                  return (
                    <article key={gap.id} className={`gap ${gap.status}`}>
                      <header>
                        <strong>{gap.missingScenarioTitle}</strong>
                        <span>{gap.status}</span>
                      </header>
                      <p>{gap.requirementSummary}</p>
                      <p>Oracle: {gap.suggestedOracle}</p>
                      <code>{gap.requiredCapabilities.join(", ")}</code>
                      {draft && (
                        <div className="draft-box">
                          <strong>{draft.scenarioId}</strong>
                          <span>review={draft.draftReviewStatus ?? "draft"} · probe={draft.selectorProbeStatus ?? "not_run"}</span>
                          {draft.missingInfo?.length ? <span>missing: {draft.missingInfo.join(", ")}</span> : null}
                          {draft.scenarioFile && (
                            <AuthenticatedArtifactLink artifactUrl={draft.scenarioFile}>
                              打开草案
                            </AuthenticatedArtifactLink>
                          )}
                          {draft.installedFile && <span>installed: {draft.installedFile}</span>}
                        </div>
                      )}
                      <div className="row-actions">
                        <button type="button" onClick={() => draftScenarioFromGap(gap)}>生成草案</button>
                        <button type="button" onClick={() => installScenarioFromGap(gap)}>探测并批准入库</button>
                        <button type="button" onClick={() => setGapStatus(gap, "dismissed")}>忽略</button>
                      </div>
                    </article>
                  );
                })}
                {harnessGaps.length === 0 && <p className="empty">暂无未覆盖 harness gap。</p>}
              </section>

              <section className="risk-list">
                <h3>风险清单</h3>
                {plan?.risks.map((risk) => (
                  <article key={risk.id} className={`risk ${risk.level}`}>
                    <span>{risk.level}</span>
                    <div>
                      <strong>{risk.title}</strong>
                      <p>{risk.evidence}</p>
                    </div>
                  </article>
                ))}
              </section>

              <section className="levels">
                <h3>显式灰度层级</h3>
                {plan?.levels.map((level) => (
                  <article className="level" key={level.id}>
                    <header>
                      <strong>{level.title}</strong>
                      <span>{level.id}</span>
                    </header>
                    <p>{level.description}</p>
                    {level.paths.map((path) => (
                      <details key={path.id} open={level.id === "core_path"}>
                        <summary>{path.title}</summary>
                        <ol>
                          {path.steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>
                      </details>
                    ))}
                  </article>
                ))}
              </section>
            </div>
          </details>
        </section>

        <aside className="simple-right-rail">
          <section className={`verdict-stage ${String(latestDecision).toLowerCase()}`}>
            <p className="eyebrow">测试结论</p>
            <strong>{latestDecision}</strong>
            <p>{result?.summary ?? liveStatusText ?? "运行完成后，系统会在这里给出是否可以继续发布的结论。"}</p>
            <button onClick={() => setRightDrawerOpen(true)} type="button">查看完整证据</button>
          </section>

          <section className="insight-stage">
            <div>
              <span>已收集证据</span>
              <strong>{evidenceCount}</strong>
            </div>
            <div>
              <span>下一步建议</span>
              <p>{nextSuggestion}</p>
            </div>
          </section>

          <section className="rail-permission-card">
            <span className="section-kicker">本次运行</span>
            <h3>浏览器控制权限</h3>
            <label className="permission-toggle-row">
              <input
                checked={permissionProfile.browserControl}
                onChange={(event) =>
                  setPermissionProfile((current) => ({
                    ...current,
                    observe: true,
                    browserControl: event.target.checked
                  }))
                }
                type="checkbox"
              />
              <span className="permission-toggle" aria-hidden="true"><span /></span>
              <span>
                <strong>允许 Agent 操作内置测试画面</strong>
                <small>仅对本次运行生效，可随时关闭。</small>
              </span>
            </label>
          </section>

          <div className="rail-utility">
            <button disabled={isCommitChecking} onClick={runCommitFlow} type="button">
              {isCommitChecking ? <Activity size={15} /> : <CheckCircle2 size={15} />}
              提交检查
            </button>
            <button disabled={isAcceptingRequirement} onClick={runRequirementAcceptanceFlow} type="button">
              {isAcceptingRequirement ? <Activity size={15} /> : <FileSearch size={15} />}
              需求验收
            </button>
            <span>风险趋势：{patrolTrend?.riskTrend ?? "暂无变化"}</span>
          </div>
        </aside>
      </section>
    </main>
  );
}
