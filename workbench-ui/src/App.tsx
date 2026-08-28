import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { initializeOidc } from "./auth";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Save,
  Star,
  Square,
  Timer,
  Trash2,
  XCircle
} from "lucide-react";
import { BotDeliveryPanel } from "./components/BotDeliveryPanel";
import { BenchmarkPanel } from "./components/BenchmarkPanel";
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { ReliabilityAssetsPanel } from "./components/ReliabilityAssetsPanel";
import { RunPreparationModal } from "./components/RunPreparationModal";
import { WorkbenchTopbar } from "./components/WorkbenchTopbar";
import { ContextDrawer } from "./components/ContextDrawer";
import { HistoryPanel } from "./components/HistoryPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { LiveWorkspacePanel } from "./components/LiveWorkspacePanel";
import { ProgressiveDetailsList } from "./components/ProgressiveDetailsList";
import { StoragePanel } from "./components/StoragePanel";
import { AdvancedCapabilitiesSection } from "./components/AdvancedCapabilitiesSection";
import { AssistantPlanningSidebar } from "./components/AssistantPlanningSidebar";
import { ApiSettingsDialog } from "./components/ApiSettingsDialog";
import { CredentialSetupWizard } from "./components/CredentialSetupWizard";
import { ExecutionTimelinePanel } from "./components/ExecutionTimelinePanel";
import { AuthenticatedArtifactLink } from "./components/AuthenticatedArtifact";
import {
  forgetProjectActiveRun,
  isRestorableProjectRun,
  rankProjectRunCandidates,
  readProjectActiveRun,
  rememberProjectActiveRun
} from "./activeRunCache";
import { useWorkbenchState } from "./hooks/useWorkbenchState";
import { useReadiness } from "./hooks/useReadiness"; import { useReviewCase } from "./hooks/useReviewCase";
import { useSharedBrowserInteractions } from "./hooks/useSharedBrowserInteractions";
import { useRepairWorkspaceActions } from "./hooks/useRepairWorkspaceActions";
import { useProjectSelection } from "./hooks/useProjectSelection";
import { useAdvancedOperations } from "./hooks/useAdvancedOperations";
import { usePlanningFlowEdits } from "./hooks/usePlanningFlowEdits";
import { usePlanningConversationRequest } from "./hooks/usePlanningConversationRequest";
import { useConfirmedScenarioExecution, type AutomationFailure } from "./hooks/useConfirmedScenarioExecution";
import { useProjectPreparation } from "./hooks/useProjectPreparation";
import { useAutomaticPlanning } from "./hooks/useAutomaticPlanning";
import { useProjectRecovery } from "./hooks/useProjectRecovery";
import { useProjectRuntimeOperations } from "./hooks/useProjectRuntimeOperations";
import { useContextRefresh } from "./hooks/useContextRefresh";
import { useWorkbenchLifecycleEffects } from "./hooks/useWorkbenchLifecycleEffects";
import { useAutomaticDiagnosticExplanation } from "./hooks/useAutomaticDiagnosticExplanation";
import { useRunInspectionActions } from "./hooks/useRunInspectionActions";
import {
  initialWorkspaceState,
  workspaceReducer,
  workspaceSelectors
} from "./state/workspaceReducer";
import { readProjectHistoryCache, writeProjectHistoryCache } from "./projectHistoryCache";
import { planRequiresLoginCredentials } from "./loginPlan";
import {
  auditStoreClass,
  auditStoreSummary,
  boundedAssistantText,
  hasBlockingPlanningQuestions,
  isPlanningAutomationBusy,
  userFacingAssistantError,
  userFacingAutomationError,
  userFacingCoverageText,
  userFacingPlanningText
} from "./appPresentation";
import {
  commandFallbackAction,
  describeRunActivity,
  isExplicitAssistantActionConfirmation,
  isUserActionableInterrupt,
  upsertAssistantProgress
} from "./workbenchLogic";

import {
  analyzeConnectedContext,
  bindProjectApiCredential,
  chatWithTestAssistant,
  continuePlanningConversation,
  getPlanningFlowPage,
  getPlanningFunctionPage,
  controlRun,
  approveScenarioDraft,
  createCredential,
  createProjectGrant,
  deleteCredential,
  detectProject,
  detectProjectManifest,
  diagnoseProject,
  generatePlan,
  getAuditStoreStatus,
  getBenchmarkSummary,
  getLatestDemoVerification,
  getRunKnowledge,
  subscribeRunEvents,
  getGrayPlan,
  getRepairFile,
  getPatrolTrend,
  getProjectRuntime,
  getAiStartRecovery,
  getSecuritySummary,
  getStorageStatus,
  getReadiness,
  getRunEvidence,
  getRunProjection,
  getRunAgent,
  getRunBrowserSession,
  resumeRepairDecision,
  listRunRepairs,
  listRepairWorkspaceFiles,
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
  runRequirementAcceptance,
  resumeRunAgentInterrupt,
  createVisualRun,
  approveRunPlan,
  grantRunPermissions,
  waitForRunReport,
  saveProject,
  saveProjectLoginCredential,
  sendRunAgentMessage,
  startProjectAsync,
  stopProject,
  testCredential,
  testProjectConnection,
  updateCredential,
  updateRepairPlanStatus,
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
  BrowserActionOverlay,
  BrowserSession,
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

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export function App() {
  const [workspaceState, dispatchWorkspace] = useReducer(workspaceReducer, initialWorkspaceState);
  const [runViewMode, setRunViewMode] = useState<"dialogue" | "report">("dialogue");
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
  const planningMessagesViewportRef = useRef<HTMLDivElement | null>(null);
  const planningMessagesPinnedRef = useRef(true);
  const requirementComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const [planningInput, setPlanningInput] = useState("");
  const [planningResult, setPlanningResult] = useState<PlanningConversationResult | null>(null);
  const [planningTrajectoryId, setPlanningTrajectoryId] = useState<string | null>(null);
  const [planningFlowPageLoading, setPlanningFlowPageLoading] = useState(false);
  const [planningFunctionPageLoading, setPlanningFunctionPageLoading] = useState(false);
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
  const hydratedRunReports = useRef(new Set<string>());
  const generationRequestRef = useRef<{ id: string; projectId: string; controller: AbortController } | null>(null);
  const diagnosisOperationRef = useRef<{ id: string; projectId: string } | null>(null);
  const activeRunRestoreEpochRef = useRef(0);
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
  // ScenarioIds whose failed conclusion has been overturned by a passed repair
  // retest. Survives closing the repair workspace (component state, not tied to
  // the current repair session) so the feature list stays green after repair.
  const [repairVerifiedScenarioIds, setRepairVerifiedScenarioIds] = useState<Set<string>>(new Set());
  const { report: readinessReport, docker: dockerReadiness, loading: readinessLoading, bootstrapping: bootstrapBusy, refresh: refreshReadiness, bootstrap: runBootstrap } = useReadiness(selectedProjectId, credentials.length);
  // Repair verdicts are tied to a specific run's scenarioIds; clear them when
  // the active run changes so a stale "repaired" flag from a previous run
  // cannot turn a new run's feature green.
  useEffect(() => {
    setRepairVerifiedScenarioIds(new Set());
  }, [activeRun?.id]);
  const [repairWorkspaceOpen, setRepairWorkspaceOpen] = useState(false);
  // Preview never grants source write access; the trajectory is read-only and
  // code mode remains a sandbox workspace that only becomes editable after an
  // explicit operator request.
  const [centreSurface, setCentreSurface] = useState<"preview" | "trajectory" | "code">("preview");
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
  const [topbarUtilityOpen, setTopbarUtilityOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(332);
  const workspaceRef = useRef<HTMLElement>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [planningSummaryCollapsed, setPlanningSummaryCollapsed] = useState(false);
  /** Evidence id to scroll-to + highlight when the workbench asks to locate one. */
  const [focusEvidenceId, setFocusEvidenceId] = useState<string | null>(null);
  // The graph projection is the only place a *paused* run surfaces. Without it
  // an interrupted run is indistinguishable from a stalled one.
  const [agentProjection, setAgentProjection] = useState<AgentGraphProjection | null>(null);
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [browserActionOverlay, setBrowserActionOverlay] = useState<BrowserActionOverlay | null>(null);
  const [, setBrowserFrameRevision] = useState(0);
  const [browserControlBusy, setBrowserControlBusy] = useState(false);
  const [browserManualInput, setBrowserManualInput] = useState("");
  const [interruptBusy, setInterruptBusy] = useState(false);
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const [permissionProfile, setPermissionProfile] = useState<PermissionProfile>({
    observe: true,
    // Uploaded projects run in an isolated browser sandbox, so normal page
    // observation/click/input is enabled for the run by default. Sensitive or
    // irreversible actions still create their own Graph interrupt.
    browserControl: true,
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
    toggleBrowserControl,
    clickSharedBrowser,
    pressSharedBrowserKey,
    typeSharedBrowserText,
    typeIntoSharedBrowser,
    syncSharedBrowserViewport
  } = useSharedBrowserInteractions({
    activeRunId,
    browserSession,
    browserManualInput,
    browserControlBusy,
    setBrowserSession,
    setBrowserControlBusy,
    setBrowserFrameRevision,
    setBrowserManualInput,
    setMessage
  });

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
  const selectedProjectName = projectDraft?.name ?? projects.find((project) => project.id === selectedProjectId)?.name ?? "未选择项目";
  const selectedProjectConfig = projectDraft ?? projects.find((project) => project.id === selectedProjectId);
  const selectedDemoProfile = selectedProjectConfig?.demoProfile?.enabled
    ? selectedProjectConfig.demoProfile
    : undefined;
  const selectedProjectExecutionMode = projectDraft?.allowExternalProjectPath
    ? "oci"
    : projectDraft?.manifest?.execution.mode
    ?? projects.find((project) => project.id === selectedProjectId)?.manifest?.execution.mode
    // Built-in fixtures predate the manifest. They are trusted test assets,
    // whereas every uploaded project gets an OCI manifest during detection.
    ?? "trusted-local";
  const hasSelectedProject = Boolean(selectedProjectId || (projectDraft?.id && projectDetection?.executionReady !== false));
  const runtimeDiscoveryReady = !discovery?.orchestration || discovery.orchestration.status === "ready";
  // A comprehensive scan is a source-backed plan, not a promise that the
  // separate Playwright session is already authenticated. Keep the full code
  // inventory reviewable/confirmable while runtime preparation is pending;
  // execution still performs its own sandbox, login and page-binding gates.
  const discoveryAllowsPlanning = runtimeDiscoveryReady || Boolean(
    planningResult?.coverage.scope === "comprehensive"
      && planningResult.businessFlows.length > 0
  );
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
    // Uploaded OCI projects intentionally do not use a fixture Scenario ID;
    // their confirmed Business Capability plan is compiled at runtime by the
    // dynamic browser Graph. Requiring scenarioId here disabled the only
    // visible Start button after the planning sidebar was collapsed.
    && Boolean(scenarioId || (planningResult && selectedProjectExecutionMode === "oci"))
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
  const presentedResultSummary = userFacingCoverageText(result?.summary);
  const plannedFunctions = planningResult?.businessFunctions ?? [];
  const resultCoverageItems = result?.coverageItems ?? [];
  const coverageByFlowId = new Map(resultCoverageItems.map((item) => [item.flowId, item]));
  const functionCoverageStates = plannedFunctions.map((feature) => {
    const paths = feature.pathIds.map((pathId) => coverageByFlowId.get(pathId));
    if (!paths.length || paths.some((item) => !item || ["pending", "binding", "executing"].includes(item.disposition))) return "pending" as const;
    if (paths.some((item) => item?.disposition === "failed")) return "failed" as const;
    if (paths.some((item) => item?.disposition === "blocked" || item?.disposition === "excluded")) return "blocked" as const;
    return paths.every((item) => item?.disposition === "executed") ? "passed" as const : "pending" as const;
  });
  const fallbackCoverageStates = !plannedFunctions.length ? resultCoverageItems.map((item) => item.disposition === "executed" ? "passed" as const
    : item.disposition === "failed" ? "failed" as const
      : item.disposition === "blocked" || item.disposition === "excluded" ? "blocked" as const : "pending" as const) : [];
  const coverageStates = functionCoverageStates.length ? functionCoverageStates : fallbackCoverageStates;
  const coverageProgress = coverageStates.length ? {
    total: coverageStates.length,
    passed: coverageStates.filter((state) => state === "passed").length,
    failed: coverageStates.filter((state) => state === "failed").length,
    blocked: coverageStates.filter((state) => state === "blocked").length,
    pending: coverageStates.filter((state) => state === "pending").length
  } : undefined;
  const plannedPathIds = new Set(plannedFunctions.flatMap((feature) => feature.pathIds));
  const unmatchedExecutedCoverage = resultCoverageItems.filter((item) =>
    (item.disposition === "executed" || item.disposition === "failed")
    && plannedPathIds.size > 0
    && !plannedPathIds.has(item.flowId)
  ).length;
  const planStepCount = activeExecutablePlan?.steps.length
    ?? planningResult?.plan.levels.reduce((total, level) => total + level.paths.reduce((pathTotal, path) => pathTotal + path.steps.length, 0), 0)
    ?? plan?.levels.reduce((total, level) => total + level.paths.reduce((pathTotal, path) => pathTotal + path.steps.length, 0), 0)
    ?? 0;
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
  const coverageIncomplete = Boolean(
    result
    && latestDecision === "pass"
    && coverageProgress
    && coverageProgress.passed < coverageProgress.total
  );
  const effectiveDecision = coverageIncomplete ? "needs-human-review" : latestDecision;
  // A run paused on a human decision (credential authorization, dangerous
  // operation, …) is NOT "queued" — the verdict panel must surface the exact
  // action the operator owes, otherwise they stare at "queued" with no idea
  // the graph is actually waiting on them.
  const pendingInterruptForVerdict = isUserActionableInterrupt(agentProjection?.pendingInterrupt)
    ? agentProjection?.pendingInterrupt
    : undefined;
  const verdictDisplay = pendingInterruptForVerdict
    ? (pendingInterruptForVerdict.kind === "credential" ? "等待你授权使用测试账号" : "等待你的操作")
    : coverageIncomplete ? "覆盖不完整"
      : effectiveDecision === "pass" ? "通过"
        : effectiveDecision === "fail" ? "失败"
          : effectiveDecision === "blocked" ? "阻塞"
            : effectiveDecision === "needs-human-review" ? "需要补充验证" : effectiveDecision;
  const verdictSummary = coverageIncomplete && coverageProgress
    ? `计划识别 ${coverageProgress.total} 个业务功能，实际通过 ${coverageProgress.passed} 个；仍有 ${coverageProgress.failed + coverageProgress.blocked + coverageProgress.pending} 个未通过完整验证，不能判定整体通过。${unmatchedExecutedCoverage ? `另有 ${unmatchedExecutedCoverage} 条计划外演示路径已执行，但不计入业务功能覆盖。` : ""}`
    : presentedResultSummary;
  const executionStatus = activeRun?.executionStatus ?? result?.executionStatus;
  const executionFinished = executionStatus
    ? ["completed", "completed-with-gaps", "cancelled", "infrastructure-failed"].includes(executionStatus)
    : Boolean(activeRun?.state && ["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(activeRun.state));
  const finalVerdictReady = Boolean(
    result
    && !isRunning
    && executionFinished
    && (!activeRunId || result.id === activeRunId)
    && (result.finalStatus || result.gateStatus || result.verdict)
  );
  const collapseRunAssistantStatus = Boolean(planningConfirmed && activeRunId && !executionFinished);
  const liveAssistantPhases = new Set(["observing", "diagnosing", "planning", "acting"]);
  const runProgressMessageId = activeRunId ? `progress:run:${activeRunId}` : undefined;
  const latestLiveAssistantId = [...planningMessages].reverse().find((candidate) => (
    candidate.role === "assistant"
    && candidate.reasoningSummary
    && liveAssistantPhases.has(candidate.reasoningSummary.phase)
  ))?.id;
  const visiblePlanningMessages = planningMessages.filter((item) => {
    if (item.role !== "assistant") return true;
    if (collapseRunAssistantStatus) {
      // A running Graph owns one stable status row. Diagnostic/model requests
      // may finish in parallel, but they must not replace this row and make
      // the sidebar alternate between several spinners. Their durable result
      // is shown after the run pauses or reaches a terminal state.
      const transient = item.streaming
        || item.id.startsWith("progress:")
        || Boolean(item.reasoningSummary && liveAssistantPhases.has(item.reasoningSummary.phase));
      return !transient || item.id === runProgressMessageId;
    }
    if (!item.reasoningSummary || !liveAssistantPhases.has(item.reasoningSummary.phase)) return true;
    return item.id === latestLiveAssistantId;
  });
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
  // Lifted workflow-guide step so the planning composer (and other left-bar
  // entries) can react to "you are on step 4: describe the test goal" instead
  // of the step indicator living only inside the drawer.
  const isExecutingRun = Boolean(activeRun?.state)
    && !["draft", "awaiting-plan-approval", "awaiting-permission", "completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(activeRun?.state ?? "");
  const currentFlowStep =
    (result?.finalStatus === "pass" || result?.finalStatus === "fail" || activeRun?.state === "completed") && !isExecutingRun ? 8
      : repairSession || repairWorkspaceOpen ? 7
      : isExecutingRun ? 6
        : planningResult?.businessFlows?.length || activeRun?.state === "awaiting-plan-approval" || runIsBlocked ? 5
          : activeRun?.state === "draft" || activeRun?.state === "awaiting-permission" ? 4
            : projectRuntime?.status === "running" ? 3
              : projectRuntime?.status === "starting" || projectRuntime?.status === "installing" || selectedProjectId ? 2
                : 1;
  // Workflow-guide step 4 ("describe the test goal"): focus the left-bar
  // requirement composer so the user lands on the input instead of hunting
  // for it once the project is running and the browser is loaded.
  useEffect(() => {
    if (currentFlowStep === 4) requirementComposerRef.current?.focus();
  }, [currentFlowStep]);
  const readinessBlockers: string[] = readinessReport?.checks
    .filter((item) => item.status === "blocked")
    .map((item) => item.message) ?? [];
  if (!hasSelectedProject) readinessBlockers.push("上传或选择一个项目");
  if (!readinessReport && !credentials.length && !selectedDemoProfile) readinessBlockers.push("配置模型凭据（OpenAI-compatible key，用于功能识别与规划）");
  if (!readinessReport && dockerReadiness && !dockerReadiness.available) readinessBlockers.push(`启动 ${dockerReadiness.engine}（容器运行时不可用）`);
  const readinessReady = readinessBlockers.length === 0;
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
  const reviewCase = useReviewCase(activeRunId, reviewRequired);
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
  const runtimeRecoveryExhausted = Boolean(
    selectedProjectId
    && projectRecovery?.projectId === selectedProjectId
    && ["blocked", "failed"].includes(projectRecovery.status)
  );
  const runtimeRecoveryAvailable = Boolean(
    projectRuntime
    && projectRuntime.status !== "running"
    && !runtimeRecoveryExhausted
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
  const startupRepairAvailable = Boolean(
    selectedProjectId
    && runtimeRecoveryExhausted
    && projectRuntime?.status !== "running"
  );
  const assistantAutoRepairAvailable = runtimeRecoveryAvailable || discoveryRecoveryAvailable || pathBindingRepairable || codeRepairAvailable || startupRepairAvailable;
  const assistantFeedbackRequired = runIsBlocked || runtimeRecoveryAvailable || discoveryRecoveryAvailable || authFeedbackRequired || credentialReadyForRetry || apiCredentialFeedbackRequired || screenshotRateLimited || reviewRequired || codeRepairAvailable || startupRepairAvailable;
  const latestPlanningAssistant = [...planningMessages].reverse().find((item) => item.role === "assistant");
  const latestPlanningAssistantMessage = latestPlanningAssistant?.content;
  const visiblePlanningTail = visiblePlanningMessages.at(-1);
  const {
    openCodeRepairWorkspace,
    openProjectCodeWorkspace,
    saveRepairFile,
    validateCurrentRepair,
    exportCurrentRepair,
    applyCurrentRepair
  } = useRepairWorkspaceActions({
    activeRunId,
    selectedProjectId,
    repairBusy,
    startupRepairAvailable,
    credentialId: defaultCredential?.id,
    projectRecovery,
    projectRuntime,
    repairSession,
    result,
    setCentreSurface,
    setRepairBusy,
    setRepairWorkspaceOpen,
    setRepairSession,
    setMessage,
    setPlanningMessages,
    setRepairVerifiedScenarioIds
  });
  const { selectProject } = useProjectSelection({
    projects,
    scenarioId,
    activeRunRestoreEpochRef,
    generationRequestRef,
    diagnosisOperationRef,
    onResetPlanning: resetPlanningConversation,
    onProjectNotFound: (projectId) => dispatchWorkspace({ type: "project-loaded", projectId }),
    onProjectLoaded: (projectId) => dispatchWorkspace({ type: "project-loaded", projectId }),
    setSelectedProjectId,
    setPreviewSessionProjectId,
    setRunPreviewModalOpen,
    setProjectDraft,
    setProjectPathInput,
    setAppUrl,
    setProjectDetection,
    setProjectDetectMessage,
    setProjectDiagnosis,
    setProjectConnection,
    setProjectRuntime,
    setProjectGrants,
    setPatrolTrend,
    setPlan,
    setResult,
    setActiveRunId,
    setActiveRun,
    setAnalysis
  });

  const demoPrefillProjectRef = useRef("");
  useEffect(() => {
    if (!selectedProjectId) {
      demoPrefillProjectRef.current = "";
      return;
    }
    if (!selectedDemoProfile || demoPrefillProjectRef.current === selectedProjectId) return;
    demoPrefillProjectRef.current = selectedProjectId;
    setRequirementText(selectedDemoProfile.defaultGoal);
    setPlanningInput(selectedDemoProfile.defaultGoal);
    // The profile scenario remains a human-readable fixture reference. The
    // official demo itself must start from the live page, not execute it as a
    // pre-bound deterministic scenario.
    setScenarioId("");
    setCentreSurface("preview");
  }, [selectedDemoProfile, selectedProjectId]);

  function startOfficialDemo(project: ProjectConfig) {
    const profile = project.demoProfile;
    if (!profile?.enabled) return;
    selectProject(project.id);
    setRequirementText(profile.defaultGoal);
    setPlanningInput(profile.defaultGoal);
    setScenarioId("");
    setCentreSurface("preview");
    setTopbarUtilityOpen(false);
    setRightDrawerOpen(false);
    setLeftDrawerOpen(true);
    setMessage("已载入官方演示：模型会在真实页面中观察、点击并采集证据。请先确认测试计划和浏览器权限；未配置模型时演示会被阻塞，不会降级成规则通过。");
  }

  const { refresh, refreshInputContext } = useContextRefresh({
    credentials,
    plan,
    projects,
    selectedProjectId,
    scenarioId,
    projectDraft,
    deliveries,
    patrolJobs,
    harnessGaps,
    setCredentials,
    setPlan,
    setProjects,
    setProjectListNotice,
    setScenarios,
    setCapabilities,
    setDeliveries,
    setPatrolJobs,
    setPatrolPlans,
    setHarnessGaps,
    setScenarioDrafts,
    setDemoVerification,
    setSecuritySummary,
    setBenchmarkSummary,
    setAuditStore,
    setRunHistory,
    setStorageStatus,
    setStorageArchives,
    setPatrolTrend,
    setProjectDraft,
    setProjectGrants,
    setProjectRuntime,
    setProjectDetection,
    setAppUrl,
    isRefreshingContext,
    setIsRefreshingContext,
    setContextRefreshStatus,
    setMessage
  });
  const {
    runPatrolOnce,
    startScheduler,
    stopScheduler,
    runSavedPatrolPlan,
    removeSavedPatrolPlan,
    deliverRun,
    setGapStatus,
    draftScenarioFromGap,
    installScenarioFromGap
  } = useAdvancedOperations({
    appUrl,
    selectedProjectId,
    projectDraft,
    scenarioId,
    credentialId: defaultCredential?.id,
    requirementText,
    diffText,
    plan,
    permissionProfile,
    result,
    botProvider,
    botChannel,
    botIncludeScreenshots,
    botGithubPrUrl,
    recipients,
    optionalTrim,
    requireBrowserAuthorization,
    refresh,
    setMessage,
    setIsPatrolling,
    setIsScheduling,
    setResult,
    setPatrolRun,
    setDeliveries,
    setPatrolPlans,
    setPatrolJobs,
    setHarnessGaps,
    setGapDrafts,
    setScenarioId
  });
  const {
    excludedPlanningFlowIds,
    resetPlanningFlowEdits,
    excludePlanningFlow,
    editPlanningFlowTitle,
    addPlanningFlow
  } = usePlanningFlowEdits({
    planningResult,
    scenarioId,
    setPlanningResult,
    setScenarioId,
    setMessage
  });
  const { continueTestPlanning } = usePlanningConversationRequest({
    selectedProjectId,
    projectDraft,
    planningInput,
    planningMessages,
    diffText,
    bugTicketText,
    defaultCredential,
    resetPlanningFlowEdits,
    setPlanningInput,
    setPlanningMessages,
    setPlanningBusy,
    setPlanningTrajectoryId,
    setPlanningConfirmed,
    setPlanningResult,
    setPlanningAutomation,
    setScenarioId,
    setDiscovery,
    setScenarioDrafts,
    setAnalysis,
    setRequirementText,
    setMessage
  });
  const { recoverProjectAndRetry } = useProjectRecovery({
    selectedProjectId,
    projectDraft,
    credentialId: defaultCredential?.id,
    projectRecoveryBusy,
    getActionLabel: assistantActionLabel,
    normalizeError: userFacingAutomationError,
    boundText: boundedAssistantText,
    setMessage,
    setPlanningMessages,
    setProjectRecoveryBusy,
    setProjectRecovery,
    setProjectRuntime,
    setRuntimeRecoveryAdvice,
    setAssistantSuggestedAction,
    setPlanningAutomation,
    setPreviewSessionProjectId
  });
  const { executeConfirmedScenarioAutomatically } = useConfirmedScenarioExecution({
    selectedProjectId,
    projectDraft,
    previewUrl,
    requirementText,
    diffText,
    executionMode: selectedProjectExecutionMode,
    permissionProfile,
    defaultCredential,
    beginWorkspaceOperation,
    dispatchWorkspace,
    closeDrawers,
    userFacingError: userFacingAutomationError,
    setPlanningAutomation,
    setMessage,
    setRunPreviewModalOpen,
    setIsRunning,
    setBrowserSession,
    setActiveRunId,
    setActiveRun,
    setResult,
    setAutomationFailures,
    setPlanningMessages
  });
  const { ensureProjectReadyForAutomation } = useProjectPreparation({
    projectDraft,
    projectDetection,
    projectRuntime,
    setProjectDraft,
    setSelectedProjectId,
    setProjectPathInput,
    setAppUrl,
    setProjectConnection,
    setProjectRuntime,
    setProjectDiagnosis,
    setPreviewSessionProjectId,
    setPlanningAutomation
  });
  const { continueAutomaticPlanning } = useAutomaticPlanning({
    permissionProfile,
    planningResult,
    requirementText,
    executionMode: selectedProjectExecutionMode,
    defaultCredential,
    discovery,
    ensureProjectReadyForAutomation,
    executeConfirmedScenarioAutomatically,
    analyzeAutomationFailures,
    userFacingError: userFacingAutomationError,
    setPlanningAutomation,
    setMessage,
    setRunPreviewModalOpen,
    setAutomationFailures,
    setPlanningMessages,
    setDiscovery,
    setScenarioDrafts,
    setScenarioId,
    setScenarios,
    setRevealProjectLoginSettings
  });
  const { openHistoricalRun, runRetentionDryRun } = useRunInspectionActions({
    refresh,
    fromBundle: runResultFromBundle,
    setMessage,
    setResult,
    setActiveRunId,
    setCentreSurface,
    setActiveRun,
    setBrowserSession,
    setBrowserFrameRevision,
    setLiveRun,
    setCommitCheck,
    setRequirementAcceptance,
    setPatrolRun,
    setRightDrawerOpen,
    setLeftDrawerOpen
  });

  useLayoutEffect(() => {
    const viewport = planningMessagesViewportRef.current;
    if (!viewport || !planningMessagesPinnedRef.current) return;
    // Only a newly inserted visible row may move the scroll position. Updating
    // the text inside the stable live row must not keep forcing scrollTop on
    // every Graph/SSE frame — that was the visible sidebar flash.
    viewport.scrollTop = viewport.scrollHeight;
  }, [
    visiblePlanningMessages.length,
    visiblePlanningTail?.id,
    planningSummaryCollapsed
  ]);
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
      ? userFacingCoverageText(concreteRunFailureMessage || planningAutomation.detail || nextSuggestion || "本次测试遇到阻塞。你可以补充入口、运行条件或预期结果，我会据此修订计划。")
      : (latestPlanningAssistantMessage ?? "可以随时补充测试目标、页面入口或预期结果。");
  const runActivity = describeRunActivity({
    runId: activeRunId,
    runState: activeRun?.state,
    isRunning,
    planningPhase: planningAutomation.phase,
    projection: agentProjection
  });

  useEffect(() => {
    if (!activeRunId || !runActivity) {
      setPlanningMessages((current) => current.filter((item) => !item.id.startsWith("progress:run:")));
      return;
    }
    setPlanningMessages((current) => upsertAssistantProgress(
      current.filter((item) => !item.id.startsWith("progress:run:") || item.id === `progress:run:${activeRunId}`), {
      id: "run-progress",
      role: "assistant",
      content: runActivity.content,
      createdAt: new Date().toISOString(),
      streaming: runActivity.streaming,
      reasoningSummary: {
        phase: runActivity.phase,
        observations: [agentProjection?.currentNode ? `当前 Graph 节点：${agentProjection.currentNode}` : "测试运行正在准备"],
        assessment: "当前 Run 尚未进入机器终态。",
        nextStep: runActivity.action,
        userAction: runActivity.streaming ? "无需操作" : "请完成当前确认",
        confidence: "high"
      }
    }, `run:${activeRunId}`));
  }, [activeRunId, runActivity?.signature]);

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
      createdAt: new Date().toISOString(),
      streaming: true
    }]);
    const repaired = await continueTestPlanning(
      [
        "请根据刚才保存的真实页面路径校验诊断重新规划。",
        "只保留能够确认实际页面入口、真实控件、确定性验证条件和完整证据要求的路径；无法验证的候选请标记为覆盖缺口，不要作为可执行测试。",
        "需要逐条说明修复了哪个入口、控件或验证条件；未发生变化时必须明确说没有修复。",
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
        streaming: false,
        content: [
          modelTrace,
          `重新规划结果：${repaired.coverage.executable} 条可直接执行，${repaired.coverage.autoBindable} 条等待实际页面确认，${repaired.coverage.gaps} 条保留为覆盖缺口。`,
          prioritizedTitles.length ? `模型优先检查：${prioritizedTitles.slice(0, 5).join("、")}。` : "",
          changedBindings.length
            ? `实际调整：${changedBindings.slice(0, 5).join("；")}${changedBindings.length > 5 ? `；另有 ${changedBindings.length - 5} 项` : ""}。`
            : "实际调整：没有路径状态或场景绑定发生变化。",
          "尚未修改被测项目代码；确认计划后系统会在实际页面确认操作步骤和预期结果。"
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
        streaming: false,
        content: "模型或规划服务没有生成可验证的新路径。系统没有修改源码，也没有把失败路径伪装成通过；可以继续追问具体失败原因。"
      } : item));
    }
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
    const requiresUserInput = failures.some((failure) => failure.requiredInformation?.length);
    const userAction = requiresUserInput
      ? `请补充：${failures.flatMap((failure) => failure.requiredInformation ?? []).slice(0, 3).join("、")}。`
      : "无需补充资料。本次 Graph 已完成有限重试并保留真实原因；其余可执行路径会继续处理。";
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
        // Never render “等待你的决定” when there is no decision for the
        // operator to make. This was the source of the contradictory blocked
        // card shown after the autonomous retry budget had already ended.
        phase: requiresUserInput ? "waiting-user" : "completed",
        observations: visibleFailures,
        assessment: `${failures.length} 条路径尚未形成可验证闭环，不能计为通过。`,
        nextStep: requiresUserInput
          ? "收到补充信息后只重试失败路径。"
          : "保留该路径的阻塞证据，并继续其余可执行路径。",
        userAction,
        confidence: "high"
      },
      suggestedAction: undefined,
      requiresConfirmation: false
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

  const {
    detectCurrentProjectPath,
    diagnoseAndRunCurrentProject,
    applyAiRecoveryCandidate,
    saveCurrentProjectLoginCredential,
    savePreparationLoginAndContinue,
    stopCurrentProject,
    saveInterruptCredential
  } = useProjectRuntimeOperations({
    credentials,
    defaultCredential,
    selectedProjectExecutionMode,
    projectDraft,
    projectDetection,
    runtimeRecoveryAdvice,
    planningResult,
    planningMessages,
    discovery,
    permissionProfile,
    preparationRequiresLogin,
    preparationLoginUsername,
    preparationLoginPassword,
    authBlockDetected,
    activeRunRestoreEpochRef,
    diagnosisOperationRef,
    surfacedProjectDiagnostics,
    resetPlanningConversation,
    closeDrawers,
    boundedAssistantText,
    recoverProjectAndRetry,
    retryWithConfiguredLogin,
    executeConfirmedScenarioAutomatically,
    continueAutomaticPlanning,
    setProjectDetectMessage,
    setMessage,
    setProjectDetection,
    setProjectDraft,
    setSelectedProjectId,
    setProjectPathInput,
    setAppUrl,
    setActiveRunId,
    setActiveRun,
    setAgentProjection,
    setBrowserSession,
    setLiveRun,
    setResult,
    setRepairSession,
    setInterruptError,
    setInterruptBusy,
    setIsRunning,
    setRunPreviewModalOpen,
    setScreenshotIssue,
    setProjectConnection,
    setProjectDiagnosis,
    setRuntimeRecoveryAdvice,
    setProjectLaunchPhase,
    setProjectRuntime,
    setPlanningAutomation,
    setPreviewSessionProjectId,
    setPlanningMessages,
    setRevealProjectLoginSettings,
    setPreparationLoginError,
    setPreparationLoginUsername,
    setPreparationLoginPassword,
    setPreparationLoginSaving,
    setScenarioId
  });

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
    resetPlanningFlowEdits();
    setPlanningMessages([{
      id: `planning_welcome_${Date.now()}`,
      role: "assistant",
      content: "项目已切换。输入“全面扫描”或“灰度测试”可列出完整测试清单。",
      createdAt: new Date().toISOString()
    }]);
    setPlanningInput("");
    setPlanningResult(null);
    setPlanningTrajectoryId(null);
    setPlanningConfirmed(false);
    setPlanningAutomation({ phase: "idle", detail: "" });
    setAutomationFailures([]);
    setRequirementText("");
    setScenarioId("");
    setAnalysis(null);
    setPlan(null);
  }

  function openCredentialSettings() {
    setRightDrawerOpen(false);
    setLeftDrawerOpen(false);
    setEditingCredentialId(null);
    setCredentialFormOpen(false);
    setApiSettingsOpen(true);
  }

  useWorkbenchLifecycleEffects({
    refresh,
    projectListNotice,
    projects,
    selectedProjectId,
    projectConnection,
    projectDiagnosis,
    projectDraft,
    activeRunId,
    activeRun,
    planningConfirmed,
    result,
    planningResultId: planningResult?.id,
    planningAutomation,
    authFeedbackRequired,
    credentialReadyForRetry,
    apiCredentialFeedbackRequired,
    screenshotRateLimited,
    runAssistantMessage,
    missingProjectApiCredentials,
    sidebarResizeRef,
    workspaceRef,
    activeRunRestoreEpochRef,
    hydratedAgentThreads,
    hydratedRunReports,
    surfacedAssistantNotices,
    setProjectListNotice,
    setMessage,
    setSidebarWidth,
    setProjects,
    setProjectDraft,
    setProjectRuntime,
    setProjectConnection,
    setProjectDiagnosis,
    setPlanningMessages,
    setBrowserSession,
    setBrowserActionOverlay,
    setBrowserFrameRevision,
    setAgentProjection,
    setInterruptError,
    setLiveRun,
    setActiveRun,
    setActiveRunId,
    setIsRunning,
    setResult,
    setAutomationFailures,
    setPlanningAutomation,
    setCentreSurface,
    setPlanningSummaryCollapsed
  });

  useAutomaticDiagnosticExplanation({
    activeRunId,
    result,
    runIsBlocked,
    reviewRequired,
    pathBindingRepairable,
    defaultCredential,
    selectedProjectId,
    projectDraft,
    planningAutomation,
    latestDecision,
    assistantChatBusy,
    planningMessages,
    planningResult,
    planningConfirmed,
    automationFailures,
    discovery,
    liveRun,
    concreteRunFailureMessage,
    analyzedBlockedRuns,
    boundedAssistantText,
    userFacingAssistantError,
    actionLabel: assistantActionLabel,
    setPlanningMessages,
    setAssistantChatBusy,
    setAssistantSuggestedAction
  });


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

  function latestPlanningGoal() {
    return [...planningMessages]
      .reverse()
      .find((item) => item.role === "user" && item.content.trim())
      ?.content.trim() || "全面扫描";
  }

  async function executeAssistantSuggestedAction(
    actionOverride?: Exclude<AssistantSuggestedAction, "none">,
    options?: { autoValidateRepair?: boolean }
  ) {
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
        // Keep the user's original goal when the assistant has only produced
        // the confirmation action. Previously this hard-coded 全面扫描, so a
        // request such as “登录并建立一个最小的工作流” silently changed
        // scope when the user clicked “生成测试清单”.
        const goal = latestPlanningGoal();
        setMessage(goal === "全面扫描" || goal === "灰度测试"
          ? "测试清单尚未生成，正在按全面扫描生成。"
          : `测试清单尚未生成，正在按“${goal}”定位并生成。`);
        await continueTestPlanning(goal, "llm-guided");
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
      if (!activeRunId && !startupRepairAvailable) {
        setMessage("当前没有可关联的失败运行或启动诊断，因此不能生成自动修复。请先运行诊断。");
        return;
      }
      await openCodeRepairWorkspace(undefined, options?.autoValidateRepair);
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
        "继续执行其余能够确认真实入口、操作、验证条件和证据的安全路径；保留当前失败链路及其证据并单独标记待诊断，不要让它阻止其他独立路径。",
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
      const { agent } = interrupt.kind === "repair-decision"
        ? await resumeRepairDecision(activeRunId, interrupt.id, {
          decision,
          message: note
        })
        : await resumeRunAgentInterrupt(activeRunId, interrupt.id, {
          approved: decision !== "dismiss",
          input: { action: decision, message: note }
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
    if (recoveryRequested && projectRuntime?.status !== "running" && !startupRepairAvailable) return "retry-runtime" as const;
    if (recoveryRequested && discovery?.orchestration && discovery.orchestration.status !== "ready") return "retry-discovery" as const;
    if (action === "create-repair" && !activeRunId && !startupRepairAvailable) return undefined;
    return action;
  }

  /**
   * A verb such as "修复项目并重新测试" is an instruction, not a question for
   * the chat model to paraphrase.  Execute it from the deterministic command
   * route so a slow or off-topic assistant reply can never delay or replace
   * the requested repair workflow.
   */
  async function executeExplicitAssistantCommand(
    content: string,
    requestedAction: Exclude<AssistantSuggestedAction, "none">
  ) {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId) {
      setMessage("请先接入并识别项目。");
      return;
    }
    const effectiveAction = resolveRecoverableAssistantAction(requestedAction);
    const userMessage: PlanningMessage = {
      id: `assistant_user_${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString()
    };
    const acknowledgement: PlanningMessage = {
      id: `assistant_command_${Date.now()}`,
      role: "assistant",
      content: effectiveAction === "create-repair"
        ? "已识别为“修复项目并重新测试”。现在开始在隔离沙盒中生成补丁；补丁生成后会自动执行受控验证。原项目不会被直接写入。"
        : effectiveAction
          ? `已识别为执行命令：${assistantActionLabel(effectiveAction) ?? effectiveAction}。正在继续。`
          : "当前没有可关联的失败运行或启动诊断，因此不能创建修复。请先运行诊断或选择一条失败运行。",
      createdAt: new Date().toISOString()
    };
    setPlanningMessages((current) => [...current, userMessage, acknowledgement]);
    setPlanningInput("");
    setAssistantSuggestedAction(null);
    if (!effectiveAction) return;
    await executeAssistantSuggestedAction(effectiveAction, {
      autoValidateRepair: requestedAction === "create-repair"
    });
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
      createdAt: new Date().toISOString(),
      streaming: true
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
        const fallbackAction = commandFallbackAction(content, activeRun?.state);
        const explicitCommandAction = isExplicitAssistantActionConfirmation(content, fallbackAction) ? fallbackAction : undefined;
        const effectiveAction = resolveRecoverableAssistantAction(explicitCommandAction ?? (response.assistant.suggestedAction !== "none"
          ? response.assistant.suggestedAction
          : fallbackAction));
        const assistantReply = explicitCommandAction === "create-repair"
          ? "已识别为代码修复请求。正在读取当前失败证据并创建隔离沙盒修复；生成补丁后会打开 Diff，验证通过前不会写回原项目。"
          : userFacingCoverageText(response.assistant.reply);
        setPlanningMessages((current) => current.map((item) =>
          item.id === pendingId
            ? {
              ...item,
              streaming: false,
              content: assistantReply,
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
          await executeAssistantSuggestedAction(effectiveAction, { autoValidateRepair: explicitCommandAction === "create-repair" });
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
          runId: activeRunId ?? (result?.id?.startsWith("run_") ? result.id : undefined),
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
      const fallbackAction = commandFallbackAction(content, activeRun?.state ?? (isRunning ? "running" : "idle"));
      const explicitCommandAction = isExplicitAssistantActionConfirmation(content, fallbackAction) ? fallbackAction : undefined;
      const effectiveAction = resolveRecoverableAssistantAction(explicitCommandAction ?? (response.assistant.suggestedAction !== "none"
        ? response.assistant.suggestedAction
        : fallbackAction));
      const assistantReply = explicitCommandAction === "create-repair"
        ? "已识别为代码修复请求。正在读取当前失败证据并创建隔离沙盒修复；生成补丁后会打开 Diff，验证通过前不会写回原项目。"
        : userFacingCoverageText(response.assistant.reply);
      setPlanningMessages((current) => current.map((item) =>
        item.id === pendingId
          ? {
            ...item,
            streaming: false,
            content: assistantReply,
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
        await executeAssistantSuggestedAction(effectiveAction, { autoValidateRepair: explicitCommandAction === "create-repair" });
      }
    } catch (error) {
      const fallbackAction = resolveRecoverableAssistantAction(commandFallbackAction(content, activeRun?.state ?? (isRunning ? "running" : "idle")));
      setPlanningMessages((current) => current.map((item) =>
        item.id === pendingId
          ? {
            ...item,
            streaming: false,
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
        await executeAssistantSuggestedAction(fallbackAction, { autoValidateRepair: fallbackAction === "create-repair" });
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
    const officialDemoGoal = selectedDemoProfile?.defaultGoal === content;
    const commandAction = commandFallbackAction(content, activeRun?.state ?? (isRunning ? "running" : "idle"));
    if (commandAction && isExplicitAssistantActionConfirmation(content, commandAction)) {
      await executeExplicitAssistantCommand(content, commandAction);
      return;
    }
    if (officialDemoGoal || fullInventoryCommand || (!questionLike && (planChange || explicitTestGoal) && !planningAutomationBusy)) {
      // The official demo uses the same model-assisted planning path as any
      // other project. Its special profile only supplies the human-readable
      // goal; it must never turn a fixed scenario into a rules-only success.
      await continueTestPlanning(content, "llm-guided");
      return;
    }
    await chatWithAssistant(content);
  }

  async function routeAssistantInput() {
    await routeAssistantContent(planningInput);
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

  async function fetchPlanningFlows(candidate: PlanningConversationResult, fetchAll = false) {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId || !candidate.businessFlowPage?.nextCursor) return candidate;
    setPlanningFlowPageLoading(true);
    try {
      let current = candidate;
      do {
        const response = await getPlanningFlowPage({
          planningId: current.id,
          projectId,
          cursor: current.businessFlowPage?.nextCursor,
          limit: fetchAll ? 100 : 24
        });
        const known = new Set(current.businessFlows.map((flow) => flow.id));
        current = {
          ...current,
          businessFlows: [...current.businessFlows, ...response.flows.filter((flow) => !known.has(flow.id) && !excludedPlanningFlowIds.has(flow.id))],
          businessFlowPage: { ...response.page, total: Math.max(0, response.page.total - excludedPlanningFlowIds.size) }
        };
      } while (fetchAll && current.businessFlowPage?.nextCursor);
      setPlanningResult((existing) => existing?.id === current.id ? current : existing);
      return current;
    } finally {
      setPlanningFlowPageLoading(false);
    }
  }

  async function fetchPlanningFunctions(candidate: PlanningConversationResult, fetchAll = false) {
    const projectId = selectedProjectId || projectDraft?.id;
    if (!projectId || !candidate.businessFunctionPage?.nextCursor) return candidate;
    setPlanningFunctionPageLoading(true);
    try {
      let current = candidate;
      do {
        const response = await getPlanningFunctionPage({
          planningId: current.id,
          projectId,
          cursor: current.businessFunctionPage?.nextCursor,
          limit: fetchAll ? 100 : 24
        });
        const known = new Set((current.businessFunctions ?? []).map((feature) => feature.id));
        current = {
          ...current,
          businessFunctions: [...(current.businessFunctions ?? []), ...(response.functions ?? []).filter((feature) => !known.has(feature.id))],
          businessFunctionPage: response.page
        };
      } while (fetchAll && current.businessFunctionPage?.nextCursor);
      setPlanningResult((existing) => existing?.id === current.id ? current : existing);
      return current;
    } finally {
      setPlanningFunctionPageLoading(false);
    }
  }

  async function confirmPlanningResult(candidate: PlanningConversationResult) {
    // The first planning response deliberately contains one page. Execution
    // is the only point where Workbench requests the complete inventory.
    const functionCompleteCandidate = await fetchPlanningFunctions(candidate, true);
    const completeCandidate = await fetchPlanningFlows(functionCompleteCandidate, true);
    candidate = completeCandidate;
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
    if (selectedDemoProfile) {
      setScenarioId("");
      await continueAutomaticPlanning(permissionProfile, undefined, candidate);
      return;
    }
    const executableScenarioId = candidate.recommendedScenarioId;
    if (executableScenarioId && selectedProjectExecutionMode !== "oci") {
      setScenarioId(executableScenarioId);
      await executeConfirmedScenarioAutomatically(executableScenarioId);
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
    if (planningResult && selectedProjectExecutionMode === "oci") {
      await confirmPlanningResult(planningResult);
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
        executionMode: selectedProjectExecutionMode,
        modelProfileId: defaultCredential?.id
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

  /* ===== Drawer content renderers ===== */

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
      <WorkbenchTopbar
        selectedProjectName={selectedProjectName}
        isOfficialDemo={Boolean(selectedDemoProfile)}
        planStepCount={planStepCount}
        canStartRun={canStartRun}
        isRunning={isRunning}
        activeRunId={activeRunId}
        activeRun={activeRun}
        permissionProfile={permissionProfile}
        leftDrawerOpen={leftDrawerOpen}
        rightDrawerOpen={rightDrawerOpen}
        topbarUtilityOpen={topbarUtilityOpen}
        defaultCredential={defaultCredential}
        onStartRun={() => void runPlan()}
        onApprovePlan={() => void approveActivePlan()}
        onGrantPermissions={() => void grantActivePermissions()}
        onPause={() => void controlActiveRun("pause")}
        onResume={() => void controlActiveRun("resume")}
        onCancel={() => void controlActiveRun("cancel")}
        onToggleUtility={() => setTopbarUtilityOpen((open) => !open)}
        onOpenLeftDrawer={() => { setLeftDrawerOpen(true); setRightDrawerOpen(false); setTopbarUtilityOpen(false); }}
        onOpenRightDrawer={() => { setRightDrawerOpen(true); setLeftDrawerOpen(false); setTopbarUtilityOpen(false); }}
        onOpenCredentials={openCredentialSettings}
      />
      <ApiSettingsDialog
        open={apiSettingsOpen}
        credentialFormOpen={credentialFormOpen}
        editingCredentialId={editingCredentialId}
        form={form}
        credentials={credentials}
        projectDraft={projectDraft}
        projectDetection={projectDetection}
        defaultCredentialId={defaultCredential?.id}
        loginUsername={preparationLoginUsername}
        loginPassword={preparationLoginPassword}
        onClose={() => setApiSettingsOpen(false)}
        onToggleCredentialForm={() => {
          if (credentialFormOpen) {
            cancelEdit();
            return;
          }
          cancelEdit();
          setCredentialFormOpen(true);
        }}
        onCancelEdit={cancelEdit}
        onFormChange={setForm}
        onSubmitCredential={submitCredential}
        onLoginUsernameChange={setPreparationLoginUsername}
        onLoginPasswordChange={setPreparationLoginPassword}
        onSaveProjectLogin={(username, password) => saveCurrentProjectLoginCredential({
          username,
          password,
          usernameEnv: projectDraft?.login?.usernameEnv ?? projectDetection?.loginCapability?.usernameEnv ?? "E2E_USERNAME",
          passwordEnv: projectDraft?.login?.passwordEnv ?? projectDetection?.loginCapability?.passwordEnv ?? "E2E_PASSWORD"
        }).then(() => undefined)}
        onTestCredential={(credentialId) => testCredential(credentialId)}
        onEditCredential={editCredential}
        onMakeDefault={(credentialId) => void updateCredential(credentialId, { isDefault: true }).then(() => refresh())}
        onDeleteCredential={(credentialId) => void deleteCredential(credentialId).then(() => refresh())}
      />

      {runPreviewModalOpen ? (
        <RunPreparationModal
          phase={planningAutomation.phase}
          detail={planningAutomation.detail}
          loginUsername={preparationLoginUsername}
          loginPassword={preparationLoginPassword}
          loginError={preparationLoginError}
          loginSaving={preparationLoginSaving}
          onClose={() => setRunPreviewModalOpen(false)}
          onLoginUsernameChange={setPreparationLoginUsername}
          onLoginPasswordChange={setPreparationLoginPassword}
          onSkipCredentials={() => {
            setRunPreviewModalOpen(false);
            setPlanningConfirmed(false);
            setPlanningAutomation({ phase: "idle", detail: "" });
            setMessage("本次测试尚未开始；确认包含登录步骤的计划前，需要先配置测试账号。");
          }}
          onSaveCredentials={() => void savePreparationLoginAndContinue()}
          onCancelPermission={() => setRunPreviewModalOpen(false)}
          onGrantPermission={grantBrowserPermissionAndContinue}
          onReturnBlocked={returnBlockedPreparationToAssistant}
        />
      ) : null}

      <section
        ref={workspaceRef}
        className={`workspace minimal-workspace ${projectPreviewReady ? "assistant-focus" : ""}`}
        style={{ "--planning-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      >
        <div
          className={`drawer-overlay ${leftDrawerOpen || rightDrawerOpen ? "open" : ""}`}
          onClick={closeDrawers}
        />

        <aside className={`drawer drawer-left ${leftDrawerOpen ? "open" : ""}`}>
          <ContextDrawer
            isRefreshingContext={isRefreshingContext}
            contextRefreshStatus={contextRefreshStatus}
            currentFlowStep={currentFlowStep}
            selectedProjectId={selectedProjectId}
            readinessReport={readinessReport}
            readinessLoading={readinessLoading}
            bootstrapBusy={bootstrapBusy}
            readinessBlockers={readinessBlockers}
            readinessReady={readinessReady}
            dockerReadiness={dockerReadiness}
            onRefreshContext={() => void refreshInputContext()}
            onClose={closeDrawers}
            onRefreshReadiness={refreshReadiness}
            onBootstrap={runBootstrap}
            projectWizard={{
              projects,
              selectedProjectId,
              projectPath: projectPathInput,
              detection: projectDetection,
              onSelectProject: selectProject,
              onStartDemo: startOfficialDemo,
              onProjectPathChange: setProjectPathInput,
              onDetect: detectCurrentProjectPath,
              detectMessage: projectDetectMessage,
              projectListNotice
            }}
            project={{
              projects,
              selectedProjectId,
              draft: projectDraft,
              detection: projectDetection,
              diagnosis: projectDiagnosis,
              status: projectRuntime,
              connection: projectConnection,
              launchPhase: projectLaunchPhase,
              recoveryAdvice: runtimeRecoveryAdvice,
              revealLoginSettings: revealProjectLoginSettings,
              onSelect: selectProject,
              onDraftChange: setProjectDraft,
              onRunDiagnosis: diagnoseAndRunCurrentProject,
              onStop: stopCurrentProject,
              onApplyRecoveryCandidate: applyAiRecoveryCandidate
            }}
            planning={{
              hasSelectedProject,
              planningResult,
              planningMessages,
              planningBusy,
              planningConfirmed,
              planningAutomation,
              planningAutomationBusy,
              planningHasBlockingQuestions,
              planningFunctionPageLoading,
              planningInput,
              currentFlowStep,
              isRunning,
              composerRef: requirementComposerRef,
              activeRun,
              result,
              repairVerifiedScenarioIds,
              credentials,
              defaultCredential,
              missingProjectApiCredentials,
              apiCredentialFeedbackRequired,
              onQuickScan: () => void continueTestPlanning("请对当前项目进行全面灰度扫描，只盘点流程和覆盖缺口，不调用 AI。", "scan-only"),
              onExcludeFlow: excludePlanningFlow,
              onEditFlowTitle: editPlanningFlowTitle,
              onAddFlow: addPlanningFlow,
              onLoadFunctions: (candidate) => void fetchPlanningFunctions(candidate),
              onConfirmPlan: () => void confirmPlanningDraft(),
              onGrantBrowserPermission: grantBrowserPermissionAndContinue,
              onBindProjectCredentials: (credentialId, source) => void bindMissingProjectApiCredentials(credentialId, source),
              onOpenCredentialSettings: openCredentialSettings,
              onContinuePlanning: () => void continueAutomaticPlanning(),
              onModifyPlan: () => {
                setPlanningConfirmed(false);
                setPlanningAutomation({ phase: "idle", detail: "" });
              },
              onOpenRepairWorkspace: (runId) => void openCodeRepairWorkspace(runId),
              onOpenTrajectory: () => setCentreSurface("trajectory"),
              onPlanningInputChange: setPlanningInput,
              onQuestionSelect: (question) => setPlanningInput(`关于“${question}”，我的回答是：`),
              onSubmit: () => void continueTestPlanning()
            }}
            contextSupplement={{
              diffText,
              bugTicketText,
              prUrl,
              requirementPath,
              requirementUrl,
              bugTicketPath,
              bugTicketUrl,
              prDiffUrl,
              openApiPath,
              openApiUrl,
              strictInput,
              hasRemoteConnectorInput: hasRemoteConnectorInput(),
              analysis,
              onDiffTextChange: setDiffText,
              onBugTicketTextChange: setBugTicketText,
              onPrUrlChange: setPrUrl,
              onRequirementPathChange: setRequirementPath,
              onRequirementUrlChange: setRequirementUrl,
              onBugTicketPathChange: setBugTicketPath,
              onBugTicketUrlChange: setBugTicketUrl,
              onPrDiffUrlChange: setPrDiffUrl,
              onOpenApiPathChange: setOpenApiPath,
              onOpenApiUrlChange: setOpenApiUrl,
              onStrictInputChange: setStrictInput,
              onLoadContext: () => void loadConnectedContext(),
              onSelectScenario: setScenarioId
            }}
          />
        </aside>

        <aside className={`drawer drawer-right ${rightDrawerOpen ? "open" : ""}`}>
          {renderEvidenceDrawer()}
        </aside>

        <AssistantPlanningSidebar
          selectedProjectName={selectedProjectName}
          messages={visiblePlanningMessages}
          messagesViewportRef={planningMessagesViewportRef}
          onMessagesScroll={(viewport) => { planningMessagesPinnedRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48; }}
          planningBusy={planningBusy}
          assistantChatBusy={assistantChatBusy}
          planningAutomationBusy={planningAutomationBusy}
          isRunning={isRunning}
          projectRecoveryBusy={projectRecoveryBusy}
          assistantFeedbackRequired={assistantFeedbackRequired}
          runAssistantMessage={runAssistantMessage}
          runIsBlocked={runIsBlocked}
          screenshotRateLimited={screenshotRateLimited}
          authFeedbackRequired={authFeedbackRequired}
          credentialReadyForRetry={credentialReadyForRetry}
          apiCredentialFeedbackRequired={apiCredentialFeedbackRequired}
          missingProjectApiCredentials={missingProjectApiCredentials}
          credentials={credentials}
          defaultCredential={defaultCredential}
          reviewRequired={reviewRequired}
          reviewReason={reviewReason}
          assistantAutoRepairAvailable={assistantAutoRepairAvailable}
          runtimeRecoveryAvailable={runtimeRecoveryAvailable}
          discoveryRecoveryAvailable={discoveryRecoveryAvailable}
          pathBindingRepairable={pathBindingRepairable}
          startupRepairAvailable={startupRepairAvailable}
          planningResult={planningResult}
          discoveryAllowsPlanning={discoveryAllowsPlanning}
          planningFunctionPageLoading={planningFunctionPageLoading}
          planningHasBlockingQuestions={planningHasBlockingQuestions}
          planningConfirmed={planningConfirmed}
          planningAutomationPhase={planningAutomation.phase}
          planningSummaryCollapsed={planningSummaryCollapsed}
          planningInput={planningInput}
          discovery={discovery}
          agentProjection={agentProjection}
          interruptBusy={interruptBusy}
          interruptError={interruptError ?? undefined}
          pendingInterruptActionable={isUserActionableInterrupt(agentProjection?.pendingInterrupt)}
          repairPlanActionStatus={repairPlanActionStatus ?? undefined}
          history={runHistory}
          onRepairPlanAction={executeRepairPlanAction}
          onOpenRepairEvidence={openRepairPlanEvidence}
          onSubmitRunFeedback={submitRunAssistantFeedback}
          onConfigureCredentials={openProjectLoginSettings}
          onRetryWithCredentials={retryWithConfiguredLogin}
          onBindApiCredential={bindMissingProjectApiCredentials}
          onOpenApiSettings={openCredentialSettings}
          onReviewReasonChange={setReviewReason}
          onAcceptRisk={() => controlActiveRun("decision-override")}
          onAutoRepair={runtimeRecoveryAvailable
            ? () => recoverProjectAndRetry("runtime")
            : discoveryRecoveryAvailable ? () => recoverProjectAndRetry("discovery")
              : pathBindingRepairable ? repairBlockedPlanning : openCodeRepairWorkspace}
          onEditPlan={() => {
            setPlanningConfirmed(false);
            setPlanningAutomation({ phase: "idle", detail: "" });
          }}
          onExecuteSuggestedAction={executeAssistantSuggestedAction}
          onContinuePlanning={() => continueTestPlanning(latestPlanningGoal(), "llm-guided")}
          onRouteAssistantContent={routeAssistantContent}
          assistantActionLabel={assistantActionLabel}
          latestPlanningAssistantId={latestPlanningAssistant?.id}
          assistantQuickCommands={assistantQuickCommands}
          onLoadPlanningFunctions={() => planningResult && fetchPlanningFunctions(planningResult)}
          onConfirmPlanningDraft={confirmPlanningDraft}
          onPlanningSummaryCollapsedChange={setPlanningSummaryCollapsed}
          onPlanningInputChange={setPlanningInput}
          onRouteAssistantInput={routeAssistantInput}
          onInterruptDecision={submitInterruptDecision}
          onOpenInterruptEvidence={openInterruptEvidence}
          onSaveInterruptCredentials={saveInterruptCredential}
          onOpenInterruptCredentials={() => {
            setLeftDrawerOpen(true);
            setMessage("请在项目设置中配置测试账号，配置完成后回到此处提交决策。");
          }}
          onOpenRepairWorkspace={openCodeRepairWorkspace}
          onOpenHistory={() => setRightDrawerOpen(true)}
        />

        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整计划栏宽度"
          onPointerDown={(event) => {
            event.preventDefault();
            sidebarResizeRef.current = { startX: event.clientX, startWidth: sidebarWidth, width: sidebarWidth };
            document.body.classList.add("is-resizing-planning-sidebar");
          }}
        />

        <section
          // A project switch replaces the centre workspace instead of reusing
          // an old scroll container. This lets the browser initialise the new
          // workspace at its natural top position without imperative scroll
          // restoration or focus-jumping workarounds.
          key={`workspace:${selectedProjectId || "none"}`}
          className="main-panel simple-main"
        >

          <LiveWorkspacePanel
            centreSurface={centreSurface}
            selectedProjectName={selectedProjectName}
            projectPreviewReady={projectPreviewReady}
            hasSelectedProject={hasSelectedProject}
            activeRunId={activeRunId}
            planningTrajectoryId={planningTrajectoryId ?? planningResult?.id}
            planningProjectId={selectedProjectId || projectDraft?.id}
            planningBusy={planningBusy}
            coverageProgress={coverageProgress}
            browserSession={browserSession}
            browserActionOverlay={browserActionOverlay}
            browserManualInput={browserManualInput}
            browserControlBusy={browserControlBusy}
            previewUrl={previewUrl}
            previewRevision={previewRevision}
            agentProjection={agentProjection}
            displayedLoopEvents={displayedLoopEvents}
            repairWorkspaceOpen={repairWorkspaceOpen}
            repairSession={repairSession}
            repairBusy={repairBusy}
            canApplyRepair={viteEnv.VITE_REPAIR_HOST_APPLY_ENABLED === "true"}
            onCentreSurfaceChange={setCentreSurface}
            onOpenCodeWorkspace={() => void openProjectCodeWorkspace()}
            onRefreshPreview={() => setPreviewRevision((current) => current + 1)}
            onBrowserManualInputChange={setBrowserManualInput}
            onTypeManualInput={() => void typeIntoSharedBrowser()}
            onToggleBrowserControl={() => void toggleBrowserControl()}
            onLoadIssue={setScreenshotIssue}
            onInteract={clickSharedBrowser}
            onPressKey={pressSharedBrowserKey}
            onTypeText={typeSharedBrowserText}
            onViewportChange={syncSharedBrowserViewport}
            onOpenProjectConfig={() => {
              setLeftDrawerOpen(true);
              setRightDrawerOpen(false);
            }}
            onListFiles={(sessionId) => listRepairWorkspaceFiles(sessionId).then((response) => response.files)}
            onLoadFile={(sessionId, filePath) => getRepairFile(sessionId, filePath).then((response) => response.file)}
            onSaveFile={saveRepairFile}
            onValidateRepair={validateCurrentRepair}
            onExportRepair={exportCurrentRepair}
            onApplyRepair={applyCurrentRepair}
          />

          {finalVerdictReady ? (
            <aside
              className={`final-verdict-float ${String(effectiveDecision).toLowerCase()}`}
              aria-live="polite"
              aria-label="测试结论"
            >
              <div className="final-verdict-heading">
                <p className="eyebrow">测试结论</p>
                <strong>{verdictDisplay}</strong>
              </div>
              <p>{verdictSummary}</p>
              <div className="final-verdict-metrics">
                {coverageProgress ? <span>业务功能：通过 {coverageProgress.passed}/{coverageProgress.total} · 失败 {coverageProgress.failed} · 阻塞 {coverageProgress.blocked} · 待处理 {coverageProgress.pending}</span> : null}
                <span>证据 {evidenceCount}</span>
                <span>{nextSuggestion}</span>
              </div>
              <button onClick={() => setRightDrawerOpen(true)} type="button">查看完整证据</button>
            </aside>
          ) : null}

          <ExecutionTimelinePanel
            workspaceState={workspaceState}
            canGenerate={workspaceSelectors.canGenerate(workspaceState)}
            activeRunId={activeRunId}
            latestDecision={String(latestDecision)}
            repairBusy={repairBusy}
            agentProjection={agentProjection}
            reviewCase={reviewCase}
            runViewMode={runViewMode}
            result={result}
            planningResult={planningResult}
            displayedLoopEvents={displayedLoopEvents}
            onGenerateOrCancel={workspaceState.phase === "generating" ? cancelPlanGeneration : regeneratePlan}
            onOpenRepairWorkspace={() => void openCodeRepairWorkspace()}
            onOpenTrajectory={() => setCentreSurface("trajectory")}
            onRunViewModeChange={setRunViewMode}
          />

          <AdvancedCapabilitiesSection
            discovery={discovery}
            scenarioDrafts={scenarioDrafts}
            onScan={runDiscovery}
            onProbeDraft={probeDraft}
            onApproveDraft={approveDraft}
            isPatrolling={isPatrolling}
            onRunPatrolOnce={runPatrolOnce}
            isScheduling={isScheduling}
            onStartScheduler={startScheduler}
            onStopScheduler={stopScheduler}
            result={result}
            onDeliverRun={deliverRun}
            botProvider={botProvider}
            botChannel={botChannel}
            notifyList={notifyList}
            botGithubPrUrl={botGithubPrUrl}
            botIncludeScreenshots={botIncludeScreenshots}
            deliveries={deliveries}
            onBotProviderChange={setBotProvider}
            onBotChannelChange={setBotChannel}
            onNotifyListChange={setNotifyList}
            onBotGithubPrUrlChange={setBotGithubPrUrl}
            onBotIncludeScreenshotsChange={setBotIncludeScreenshots}
            patrolJobs={patrolJobs}
            patrolPlans={patrolPlans}
            patrolTrend={patrolTrend}
            onRunSavedPatrolPlan={runSavedPatrolPlan}
            onRemoveSavedPatrolPlan={removeSavedPatrolPlan}
            storageStatus={storageStatus}
            storageArchives={storageArchives}
            onRunRetentionDryRun={runRetentionDryRun}
            benchmarkSummary={benchmarkSummary}
            runHistory={runHistory}
            onOpenHistoricalRun={openHistoricalRun}
            capabilities={capabilities}
            activeExecutablePlan={activeExecutablePlan}
            harnessGaps={harnessGaps}
            gapDrafts={gapDrafts}
            onDraftScenarioFromGap={draftScenarioFromGap}
            onInstallScenarioFromGap={installScenarioFromGap}
            onSetGapStatus={setGapStatus}
            plan={plan}
          />

          <details className="advanced-section reliability-assets-details">
            <summary>
              <span>
                <strong>可信验收与测试资产</strong>
                <small>差分运行、Evidence、Mutation 和安全写入</small>
              </span>
            </summary>
            <div className="advanced-stack">
              <ReliabilityAssetsPanel
                projectId={selectedProjectId || projectDraft?.id}
                sourceRunId={activeRunId}
                repositoryRoot={projectDraft?.projectPath}
              />
            </div>
          </details>
        </section>

      </section>
    </main>
  );
}
