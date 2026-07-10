import React, { useEffect, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
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
  Search,
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
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ImpactPanel } from "./components/ImpactPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { ProjectWizardPanel } from "./components/ProjectWizardPanel";
import { RunTimeline } from "./components/RunTimeline";
import { SecurityPanel } from "./components/SecurityPanel";
import { ServiceHealthPanel } from "./components/ServiceHealthPanel";
import { SourceStatusPanel } from "./components/SourceStatusPanel";
import { StoragePanel } from "./components/StoragePanel";
import { AuthenticatedArtifactImage, AuthenticatedArtifactLink } from "./components/AuthenticatedArtifact";
import { useWorkbenchState } from "./hooks/useWorkbenchState";
import {
  AGENT_URL,
  analyzeConnectedContext,
  analyzeIntake,
  approveScenarioDraft,
  createCredential,
  createHarnessGapDraft,
  createProjectGrant,
  deleteCredential,
  deletePatrolPlan,
  deliverRunToBot,
  detectProject,
  diagnoseProject,
  generatePlan,
  getAuditStoreStatus,
  getLatestDemoVerification,
  getLatestLiveRun,
  getGrayPlan,
  getPatrolTrend,
  getSecuritySummary,
  getStorageStatus,
  getRunBundle,
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
  runStorageRetention,
  runVisualTest,
  saveProject,
  savePatrolPlan,
  startPatrolJob,
  startProject,
  stopPatrolJob,
  stopProject,
  testCredential,
  testProjectConnection,
  installHarnessGapDraft,
  updateHarnessGap,
  updateCredential
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
  PlatformCapability,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectGrant,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus,
  RequirementAcceptanceResult,
  RunBundle,
  RunHistoryEntry,
  RunResult,
  ScenarioSummary,
  SecuritySummary,
  StorageArchive,
  StorageStatus
} from "./types";
import "./styles.css";

const taskFilterFixtureScenarioId = "task_filter_completed";

const taskFilterFixtureRequirement =
  '用户在任务列表页点击"已完成"时，系统必须只展示 status=completed 的任务，并且接口请求需要携带 status=completed 查询参数。';

const taskFilterFixtureDiff = `diff --git a/app-under-test/src/api/tasks.ts b/app-under-test/src/api/tasks.ts
--- a/app-under-test/src/api/tasks.ts
+++ b/app-under-test/src/api/tasks.ts
@@ -1,6 +1,6 @@
 export async function fetchTasks(status) {
-  const query = status === "all" ? "" : \`?status=\${status}\`;
+  const query = "";
 const response = await fetch(\`\${APP_API_URL}/api/tasks\${query}\`);
}`;

function auditStoreClass(auditStore: AuditStoreStatus | null) {
  if (!auditStore) return "warning";
  if (auditStore.schemaVersionMatches === false || auditStore.migrationComplete === false || auditStore.integrityOk === false) {
    return "failed";
  }
  return "passed";
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

export function App() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [plan, setPlan] = useState<GrayPlan | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [appUrl, setAppUrl] = useState("http://localhost:6173");
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectDraft, setProjectDraft] = useState<ProjectConfig | null>(null);
  const [projectPathInput, setProjectPathInput] = useState("/Users/afa/Desktop/Hack/project-02-ai-test-officer/app-under-test");
  const [projectDetection, setProjectDetection] = useState<ProjectDetectionResult | null>(null);
  const [projectDiagnosis, setProjectDiagnosis] = useState<ProjectDiagnosis | null>(null);
  const [projectGrants, setProjectGrants] = useState<ProjectGrant[]>([]);
  const [projectConnection, setProjectConnection] = useState<ProjectHealthCheckResult | null>(null);
  const [projectRuntime, setProjectRuntime] = useState<ProjectRuntimeStatus | null>(null);
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [scenarioId, setScenarioId] = useState(taskFilterFixtureScenarioId);
  const [requirementText, setRequirementText] = useState(taskFilterFixtureRequirement);
  const [diffText, setDiffText] = useState(taskFilterFixtureDiff);
  const [bugTicketText, setBugTicketText] = useState("TAPD-1024：已完成任务筛选偶现返回全部数据，需回归核心路径。");
  const [prUrl, setPrUrl] = useState("local://demo/pr/task-filter");
  const [prDiffUrl, setPrDiffUrl] = useState("");
  const [openApiPath, setOpenApiPath] = useState("");
  const [openApiUrl, setOpenApiUrl] = useState("");
  const [strictInput, setStrictInput] = useState(false);
  const [requirementPath, setRequirementPath] = useState("data/fixtures/task-filter-requirement.md");
  const [requirementUrl, setRequirementUrl] = useState("");
  const [bugTicketPath, setBugTicketPath] = useState("data/fixtures/tapd-task-filter-bug.md");
  const [bugTicketUrl, setBugTicketUrl] = useState("");
  const [notifyList, setNotifyList] = useState("oncall,frontend-owner");
  const [analysis, setAnalysis] = useState<IntakeAnalysis | null>(null);
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
  const [auditStore, setAuditStore] = useState<AuditStoreStatus | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [storageArchives, setStorageArchives] = useState<StorageArchive[]>([]);
  const [securitySummary, setSecuritySummary] = useState<SecuritySummary | null>(null);
  const [message, setMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isPatrolling, setIsPatrolling] = useState(false);
  const [isCommitChecking, setIsCommitChecking] = useState(false);
  const [isAcceptingRequirement, setIsAcceptingRequirement] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [permissionProfile, setPermissionProfile] = useState<PermissionProfile>({
    observe: true,
    browserControl: false,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  });
  const [form, setForm] = useState({
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
  const evidenceCount = result?.evidence?.length ?? 0;
  const sourceContextCount = analysis?.sourceContexts?.length ?? 0;
  const planStepCount = activeExecutablePlan?.steps.length ?? plan?.levels.reduce((total, level) => total + level.paths.reduce((pathTotal, path) => pathTotal + path.steps.length, 0), 0) ?? 0;
  const latestDecision = result?.verdict ?? commitCheck?.run?.verdict ?? requirementAcceptance?.run?.verdict ?? "未运行";
  const primaryReason = selectedCandidate?.reason ?? selectedScenario?.summary ?? "当前场景来自 Scenario Registry，可先读取输入来源或执行 Discovery 生成更准确的测试点。";
  const nextSuggestion = result?.failureAttributions?.[0]?.suggestedFix ??
    result?.failureAttributions?.[0]?.topSuspects?.[0]?.suggestedFix ??
    (patrolTrend?.riskIncreased ? "风险趋势升高，建议打开历史运行对比失败证据。" : "先确认项目连接、输入来源和浏览器授权，然后运行一次测试。");

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
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
  }

  async function refresh() {
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
      auditData,
      projectData,
      historyData,
      storageData,
      archiveData,
      securityData,
      trendData
    ] = await Promise.all([
      listCredentials(),
      getGrayPlan(),
      listScenarios(),
      listPlatformCapabilities(),
      listBotDeliveries(),
      listPatrolJobs(),
      listPatrolPlans().catch(() => ({ plans: [] })),
      listHarnessGaps(),
      listScenarioDrafts().catch(() => ({ drafts: [] })),
      getLatestDemoVerification().catch(() => ({ verification: null })),
      getAuditStoreStatus().catch(() => ({ auditStore: null })),
      listProjects().catch(() => ({ projects: [] })),
      listRunHistory().catch(() => ({ runs: [] })),
      getStorageStatus().catch(() => ({ storage: null })),
      listStorageArchives().catch(() => ({ archives: [] })),
      getSecuritySummary().catch(() => ({ security: null })),
      getPatrolTrend({ projectId: selectedProjectId || undefined, scenarioId }).catch(() => ({ trend: null }))
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
    setAuditStore(auditData.auditStore);
    setProjects(projectData.projects);
    setRunHistory(historyData.runs);
    setStorageStatus(storageData.storage);
    setStorageArchives(archiveData.archives);
    setSecuritySummary(securityData.security);
    setPatrolTrend(trendData.trend);
    const activeProjectId = selectedProjectId || projectData.projects[0]?.id;
    if (projectData.projects.length && !selectedProjectId) {
      const firstProject = projectData.projects[0];
      setSelectedProjectId(firstProject.id);
      setProjectDraft(firstProject);
      setProjectPathInput(firstProject.projectPath);
      setAppUrl(firstProject.frontendUrl);
    }
    if (activeProjectId) {
      const grantData = await listProjectGrants(activeProjectId).catch(() => ({ grants: [] }));
      setProjectGrants(grantData.grants);
    }
  }

  function loadTaskFilterFixture() {
    setScenarioId(taskFilterFixtureScenarioId);
    setRequirementText(taskFilterFixtureRequirement);
    setDiffText(taskFilterFixtureDiff);
    setBugTicketText("TAPD-1024：已完成任务筛选偶现返回全部数据，需回归核心路径。");
    setPrUrl("local://demo/pr/task-filter");
    setPrDiffUrl("");
    setRequirementPath("data/fixtures/task-filter-requirement.md");
    setRequirementUrl("");
    setBugTicketPath("data/fixtures/tapd-task-filter-bug.md");
    setBugTicketUrl("");
    setMessage("已加载任务筛选 fixture。");
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (!isBusy) return;
    let stopped = false;
    const poll = async () => {
      try {
        const live = await getLatestLiveRun();
        if (!stopped) setLiveRun(live);
      } catch {
        // Live polling is best-effort.
      }
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [isBusy]);

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
  }

  function editCredential(credential: Credential) {
    setEditingCredentialId(credential.id);
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
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    if (project) {
      setProjectDraft(project);
      setProjectPathInput(project.projectPath);
      setAppUrl(project.frontendUrl);
      setProjectConnection(null);
      setProjectRuntime(null);
      setProjectDiagnosis(null);
      listProjectGrants(projectId).then((response) => setProjectGrants(response.grants)).catch(() => setProjectGrants([]));
      getPatrolTrend({ projectId, scenarioId }).then((response) => setPatrolTrend(response.trend)).catch(() => setPatrolTrend(null));
    }
  }

  async function detectCurrentProjectPath() {
    setMessage("正在识别项目类型、命令和端口。");
    try {
      const response = await detectProject(projectPathInput);
      setProjectDetection(response.detection);
      setMessage(response.detection.exists ? "项目识别完成，可以套用建议配置。" : "项目路径不可读，请检查文件夹。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目识别失败");
    }
  }

  function applyDetectedProject() {
    if (!projectDetection) return;
    const suggested = {
      ...projectDetection.suggestedConfig,
      allowExternalProjectPath: true
    };
    setProjectDraft(suggested);
    setSelectedProjectId(suggested.id);
    setProjectPathInput(suggested.projectPath);
    setAppUrl(suggested.frontendUrl);
    setMessage("已把向导建议填入项目配置；请确认账号环境变量后保存或诊断。");
  }

  async function diagnoseCurrentProject() {
    const candidate = projectDraft ?? projectDetection?.suggestedConfig;
    if (!candidate) {
      setMessage("请先识别或选择一个项目。");
      return;
    }
    setMessage("正在诊断项目接入链路。");
    try {
      const saved = await saveProject({ ...candidate, allowExternalProjectPath: candidate.allowExternalProjectPath ?? true });
      const response = await diagnoseProject(saved.project.id);
      setProjectDraft(saved.project);
      setSelectedProjectId(saved.project.id);
      setProjectDiagnosis(response.diagnosis);
      setMessage(response.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage ?? "项目诊断完成。");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目诊断失败");
    }
  }

  async function saveCurrentProject() {
    if (!projectDraft) return;
    const response = await saveProject(projectDraft);
    setProjectDraft(response.project);
    setSelectedProjectId(response.project.id);
    setProjectPathInput(response.project.projectPath);
    setAppUrl(response.project.frontendUrl);
    setMessage(`项目配置已保存：${response.project.name}`);
    await refresh();
  }

  async function testCurrentProject() {
    if (!projectDraft) return;
    const saved = await saveProject(projectDraft);
    const response = await testProjectConnection(saved.project.id);
    setProjectDraft(saved.project);
    setSelectedProjectId(saved.project.id);
    setProjectPathInput(saved.project.projectPath);
    setProjectConnection(response.result);
    setAppUrl(saved.project.frontendUrl);
    setMessage(response.result.message);
  }

  async function startCurrentProject() {
    if (!projectDraft) return;
    const saved = await saveProject(projectDraft);
    const response = await startProject(saved.project.id);
    setProjectRuntime(response.runtime);
    setProjectDraft(saved.project);
    setSelectedProjectId(saved.project.id);
    setProjectPathInput(saved.project.projectPath);
    setAppUrl(saved.project.frontendUrl);
    setMessage(response.runtime.message ?? `项目状态：${response.runtime.status}`);
  }

  async function stopCurrentProject() {
    if (!projectDraft) return;
    const response = await stopProject(projectDraft.id);
    setProjectRuntime(response.runtime);
    setMessage(response.runtime.message ?? `项目状态：${response.runtime.status}`);
  }

  function requireBrowserAuthorization(action: string) {
    if (permissionProfile.observe && permissionProfile.browserControl) return true;
    setMessage(`请先授权 browser_control，AI 测试官才能${action}。`);
    return false;
  }

  async function analyzeContext() {
    setMessage("正在分析 Git/需求/TAPD 输入。");
    try {
      const response = await analyzeIntake({
        requirement: requirementText,
        diff: diffText,
        bugTicket: bugTicketText,
        prUrl
      });
      setAnalysis(response.analysis);
      const firstExecutable = response.analysis.scenarioCandidates.find((item) => item.executable && item.mappedScenarioId);
      if (firstExecutable?.mappedScenarioId) setScenarioId(firstExecutable.mappedScenarioId);
      setMessage(`已生成 ${response.analysis.scenarioCandidates.length} 个候选测试场景。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "输入分析失败");
    }
  }

  async function loadConnectedContext() {
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
    if (!requireBrowserAuthorization("扫描页面并生成测试点草案")) return;
    setMessage("正在扫描页面 DOM、按钮、表单、test-id、network 和 OpenAPI。");
    try {
      const response = await runDiscoveryScan({
        appUrl,
        projectId: selectedProjectId || projectDraft?.id,
        sourceContexts: analysis?.sourceContexts
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
      const response = await probeScenarioDraft(id);
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
    if (!requireBrowserAuthorization("接管浏览器执行测试")) return;
    setIsRunning(true);
    setMessage("AI 测试官开始执行显式灰度验收。");
    try {
      const run = await runVisualTest(appUrl, permissionProfile, scenarioId, {
        requirement: requirementText,
        diff: diffText,
        plan: plan ?? undefined,
        trigger: "manual",
        credentialId: defaultCredential?.id,
        projectId: selectedProjectId || projectDraft?.id
      });
      setResult(run);
      setMessage(run.summary);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "执行失败");
    } finally {
      setIsRunning(false);
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
    setMessage("正在生成测试计划。");
    try {
      const response = await generatePlan({
        requirement: requirementText,
        diff: diffText,
        credentialId: defaultCredential?.id
      });
      setPlan(response.plan);
      setMessage(response.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成计划失败");
    }
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
            <button className="icon-button" onClick={() => refresh()} type="button" title="刷新">
              <RefreshCw size={16} />
            </button>
            <button className="icon-button" onClick={() => setLeftDrawerOpen(false)} type="button" title="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="drawer-body">
          <ProjectWizardPanel
            projectPath={projectPathInput}
            detection={projectDetection}
            diagnosis={projectDiagnosis}
            onProjectPathChange={setProjectPathInput}
            onDetect={detectCurrentProjectPath}
            onApplySuggestion={applyDetectedProject}
            onDiagnose={diagnoseCurrentProject}
          />

          <ProjectPanel
            projects={projects}
            selectedProjectId={selectedProjectId}
            draft={projectDraft}
            status={projectRuntime}
            connection={projectConnection}
            onSelect={selectProject}
            onDraftChange={setProjectDraft}
            onSave={saveCurrentProject}
            onTest={testCurrentProject}
            onStart={startCurrentProject}
            onStop={stopCurrentProject}
          />
          <ServiceHealthPanel />

          <label>
            Scenario Registry
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.id} · {scenario.corePath?.action ?? "unknown"}
                </option>
              ))}
              {!scenarios.some((scenario) => scenario.id === scenarioId) && (
                <option value={scenarioId}>{scenarioId}</option>
              )}
            </select>
          </label>
          {scenarios.find((scenario) => scenario.id === scenarioId) && (
            <article className="scenario-summary">
              <strong>{scenarios.find((scenario) => scenario.id === scenarioId)?.title}</strong>
              <p>{scenarios.find((scenario) => scenario.id === scenarioId)?.summary}</p>
              <code>
                {scenarios.find((scenario) => scenario.id === scenarioId)?.corePath?.pathId} · oracles=
                {scenarios.find((scenario) => scenario.id === scenarioId)?.corePath?.oracleCount}
              </code>
            </article>
          )}

          <label>
            需求
            <textarea value={requirementText} onChange={(event) => setRequirementText(event.target.value)} rows={4} />
          </label>

          <label>
            Git diff
            <textarea value={diffText} onChange={(event) => setDiffText(event.target.value)} rows={6} />
          </label>

          <label>
            TAPD / Bug 单
            <textarea value={bugTicketText} onChange={(event) => setBugTicketText(event.target.value)} rows={3} />
          </label>

          <label>
            PR 来源
            <input value={prUrl} onChange={(event) => setPrUrl(event.target.value)} />
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

          <div className="form-actions">
            <button type="button" onClick={loadConnectedContext}>
              <Link2 size={16} />
              读取连接器
            </button>
            <button type="button" onClick={analyzeContext}>
              <Search size={16} />
              分析输入
            </button>
            <button type="button" onClick={loadTaskFilterFixture}>
              <ClipboardList size={16} />
              加载 fixture
            </button>
          </div>

          <section className="analysis-box">
            <h3>Input Analysis</h3>
            {analysis ? (
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
                          使用 {candidate.mappedScenarioId}
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p className="empty">点击"分析输入"后会显示 MCP 输入源、影响面和候选测试场景。</p>
            )}
          </section>

          <section className="credential-box">
            <h3>Credential Center</h3>
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
          <div className="status-pill">
            <KeyRound size={16} />
            {defaultCredential ? `${defaultCredential.name} · ${defaultCredential.model}` : "未配置 API Key"}
          </div>
        </div>
      </header>

      <section className="workspace minimal-workspace">
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
          <div className="sidebar-label">本次测试</div>
          <button className="context-nav-item active" onClick={() => setLeftDrawerOpen(true)} type="button">
            <span>01</span>
            <div>
              <strong>{selectedProjectName}</strong>
              <small>项目与连接配置</small>
            </div>
          </button>
          <button className="context-nav-item" onClick={loadConnectedContext} type="button">
            <span>02</span>
            <div>
              <strong>测试依据</strong>
              <small>{sourceContextCount || analysis?.sources.length || 0} 个已读取来源</small>
            </div>
          </button>
          <button className="context-nav-item" onClick={analyzeContext} type="button">
            <span>03</span>
            <div>
              <strong>分析影响</strong>
              <small>{selectedCandidate ? "已找到推荐场景" : "识别需要验证的功能"}</small>
            </div>
          </button>

          <div className="sidebar-rule" />
          <div className="sidebar-label">测试场景</div>
          <label className="scenario-picker">
            <span>{selectedScenario?.title ?? scenarioId}</span>
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} aria-label="选择测试场景">
              {scenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.title}
                </option>
              ))}
              {!scenarios.some((scenario) => scenario.id === scenarioId) && (
                <option value={scenarioId}>{scenarioId}</option>
              )}
            </select>
          </label>

          <div className="sidebar-footer">
            <span>{runHistory.length} 次历史运行</span>
            <button onClick={() => setRightDrawerOpen(true)} type="button">打开记录</button>
          </div>
        </aside>

        <section className="main-panel simple-main">
          <div className="mission-stage">
            <div>
              <p className="eyebrow">AI 测试任务</p>
              <h2>{selectedCandidate?.title ?? selectedScenario?.title ?? scenarioId}</h2>
              <p className="mission-reason"><span>为什么测</span>{primaryReason}</p>
            </div>
            <div className="run-command-actions">
              <button className="primary" disabled={isRunning} onClick={runPlan} type="button">
                {isRunning ? <Activity size={16} /> : <Play size={16} />}
                {isRunning ? "执行中" : "开始测试"}
              </button>
            </div>
          </div>

          <div className="mission-status">
            <span className={isRunning ? "status-dot running" : "status-dot"} />
            {message || (isRunning ? "Agent 正在执行计划并收集证据" : "准备就绪：确认浏览器权限后即可开始测试")}
          </div>

          <section className="mission-facts">
            <article>
              <span>测试对象</span>
              <strong>{selectedProjectName}</strong>
            </article>
            <article>
              <span>测试依据</span>
              <strong>{sourceContextCount || analysis?.sources.length || 0} 个来源</strong>
            </article>
            <article>
              <span>执行计划</span>
              <strong>{planStepCount || "待生成"} {planStepCount ? "步" : ""}</strong>
            </article>
          </section>

          <section className="live-view simple-live-view">
            {latestScreenshot ? (
              <AuthenticatedArtifactImage artifactUrl={latestScreenshot} alt="最新测试画面" />
            ) : (
              <div className="live-view-placeholder">
                <div className="live-view-grid" />
                <div className="live-view-scanner" />
                <div className="live-view-dots">
                  <span />
                  <span />
                  <span />
                </div>
                <p>Agent 就绪，等待执行测试</p>
              </div>
            )}
          </section>

          <section className="timeline-stage">
            <div className="section-title-row">
              <div>
                <h3>Agent 正在做什么</h3>
                <p>从计划、执行到判断，每一步都留下可回看的证据。</p>
              </div>
              <button onClick={regeneratePlan} type="button">
                <ListChecks size={15} />
                生成计划
              </button>
            </div>
            <RunTimeline result={result} displayedLoopEvents={displayedLoopEvents} />
          </section>

          <label className="permission-line">
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
              <span>允许本次会话接管指定浏览器窗口执行测试</span>
              <small>只用于本次运行，可随时取消。</small>
          </label>

          <details className="advanced-section">
            <summary>更多能力：Discovery、巡检、推送、存储和计划细节</summary>
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
