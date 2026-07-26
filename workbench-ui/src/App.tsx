import React, { useEffect, useRef, useState } from "react";
import { initializeOidc, oidcConfigured } from "./auth";
import { OidcSessionPanel } from "./components/OidcSessionPanel";
import {
  Activity,
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
import { DiscoveryPanel } from "./components/DiscoveryPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { ImpactPanel } from "./components/ImpactPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { ProjectPanel } from "./components/ProjectPanel";
import { ProjectWizardPanel } from "./components/ProjectWizardPanel";
import { RunTimeline } from "./components/RunTimeline";
import { SecurityPanel } from "./components/SecurityPanel";
import { SourceStatusPanel } from "./components/SourceStatusPanel";
import { StoragePanel } from "./components/StoragePanel";
import { AuthenticatedArtifactImage, AuthenticatedArtifactLink } from "./components/AuthenticatedArtifact";
import { useWorkbenchState } from "./hooks/useWorkbenchState";
import { readProjectHistoryCache, writeProjectHistoryCache } from "./projectHistoryCache";
import {
  analyzeConnectedContext,
  continuePlanningConversation,
  controlRun,
  approveScenarioDraft,
  createCredential,
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
  subscribeRunEvents,
  getGrayPlan,
  getPatrolTrend,
  getProjectRuntime,
  getAiStartRecovery,
  getSecuritySummary,
  getStorageStatus,
  getRunBundle,
  getRunEvidence,
  getRunProjection,
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
  createVisualRun,
  approveRunPlan,
  grantRunPermissions,
  waitForRunReport,
  saveProject,
  saveProjectLoginCredential,
  savePatrolPlan,
  startPatrolJob,
  startProject,
  startProjectAsync,
  stopPatrolJob,
  stopProject,
  testCredential,
  testProjectConnection,
  installHarnessGapDraft,
  updateHarnessGap,
  updateCredential,
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
  PlatformCapability,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectGrant,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus,
  RuntimeRecoveryAdvice,
  RequirementAcceptanceResult,
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

function isPlanningAutomationBusy(phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "blocked") {
  return ["preparing-project", "discovering", "binding", "starting-run", "running"].includes(phase);
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
  const [oidcAuthenticated, setOidcAuthenticated] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [plan, setPlan] = useState<GrayPlan | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [appUrl, setAppUrl] = useState(viteEnv.VITE_APP_URL ?? "http://localhost:6173");
  const [projects, setProjects] = useState<ProjectConfig[]>(() => readProjectHistoryCache());
  const [projectListNotice, setProjectListNotice] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [projectDraft, setProjectDraft] = useState<ProjectConfig | null>(null);
  const [projectPathInput, setProjectPathInput] = useState(viteEnv.VITE_PROJECT_PATH ?? "app-under-test");
  const [projectDetection, setProjectDetection] = useState<ProjectDetectionResult | null>(null);
  const [projectDetectMessage, setProjectDetectMessage] = useState("");
  const [projectDiagnosis, setProjectDiagnosis] = useState<ProjectDiagnosis | null>(null);
  const [projectGrants, setProjectGrants] = useState<ProjectGrant[]>([]);
  const [projectConnection, setProjectConnection] = useState<ProjectHealthCheckResult | null>(null);
  const [projectRuntime, setProjectRuntime] = useState<ProjectRuntimeStatus | null>(null);
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
    content: "告诉我你想验证什么。你也可以直接说“全面灰度测试”，我会先扫描项目，再列出可执行流程和覆盖缺口。",
    createdAt: new Date().toISOString()
  }]);
  const [planningInput, setPlanningInput] = useState("");
  const [planningResult, setPlanningResult] = useState<PlanningConversationResult | null>(null);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [planningConfirmed, setPlanningConfirmed] = useState(false);
  const [planningAutomation, setPlanningAutomation] = useState<{
    phase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "blocked";
    detail: string;
    scenarioId?: string;
  }>({ phase: "idle", detail: "" });
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
  const [reviewReason, setReviewReason] = useState("");
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
  const planningHasBlockingQuestions = planningResult ? hasBlockingPlanningQuestions(planningResult) : false;
  const planningAutomationBusy = isPlanningAutomationBusy(planningAutomation.phase);
  const canStartRun = hasSelectedProject && Boolean(requirementText.trim()) && Boolean(scenarioId) && planningConfirmed && !isRunning;
  // A sandbox target is only ever rendered through the port allocated to its
  // active runtime. Never fall back to the saved container port: another app
  // may be listening there and would make a failed launch look like a live
  // preview.
  const previewUrl = projectRuntime?.status === "running"
    ? projectRuntime.frontendUrl ?? appUrl
    : appUrl;
  const projectPreviewReady = Boolean(previewUrl && (
    selectedProjectExecutionMode === "oci"
      ? projectRuntime?.status === "running"
      : projectConnection?.ok || projectRuntime?.status === "running"
  ));
  const evidenceCount = result?.evidence?.length ?? 0;
  const sourceContextCount = analysis?.sourceContexts?.length ?? 0;
  const planStepCount = activeExecutablePlan?.steps.length ?? plan?.levels.reduce((total, level) => total + level.paths.reduce((pathTotal, path) => pathTotal + path.steps.length, 0), 0) ?? 0;
  const latestDecision = result?.finalStatus ?? result?.gateStatus ?? commitCheck?.run?.finalStatus ?? commitCheck?.run?.gateStatus ?? requirementAcceptance?.run?.finalStatus ?? requirementAcceptance?.run?.gateStatus ?? "未运行";
  const primaryReason = selectedCandidate?.reason ?? selectedScenario?.summary ?? "填写需求并分析后，系统会生成需要验证的测试内容。";
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

  function resetPlanningConversation() {
    if (flowDeleteTimer.current) clearTimeout(flowDeleteTimer.current);
    setFlowDeleteReadyId(null);
    setPlanningMessages([{
      id: `planning_welcome_${Date.now()}`,
      role: "assistant",
      content: "项目已切换。告诉我你想验证什么，或者直接说“全面灰度测试”。",
      createdAt: new Date().toISOString()
    }]);
    setPlanningInput("");
    setPlanningResult(null);
    setPlanningConfirmed(false);
    setPlanningAutomation({ phase: "idle", detail: "" });
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
      const needsInput = businessFlows.filter((flow) => flow.status === "needs-input").length;
      const gaps = businessFlows.filter((flow) => flow.status === "coverage-gap").length;
      return {
        ...current,
        businessFlows,
        coverage: {
          ...current.coverage,
          discovered: businessFlows.length,
          executable,
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

  // OCI projects can legitimately spend a few minutes installing dependencies
  // in an empty, disposable sandbox. Keep this UI subscribed to the runtime
  // until it reaches a stable state instead of leaving an old “installing” or
  // recoverable “failed” card on screen after the initial polling window ends.
  useEffect(() => {
    if (!selectedProjectId || !projectRuntime || !["installing", "starting", "failed"].includes(projectRuntime.status)) return;
    let disposed = false;
    const refreshRuntime = async () => {
      const snapshot = await getProjectRuntime(selectedProjectId).catch(() => null);
      if (!snapshot || disposed) return;
      setProjectRuntime(snapshot.runtime);
      if (snapshot.runtime.status === "running") {
        const connection = await testProjectConnection(selectedProjectId).catch(() => null);
        if (!disposed && connection) setProjectConnection(connection.result);
      }
    };
    void refreshRuntime();
    const interval = window.setInterval(() => void refreshRuntime(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [selectedProjectId, projectRuntime?.status]);

  useEffect(() => {
    if (!activeRunId) return;
    return subscribeRunEvents(activeRunId, ({ id, type, payload }) => {
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
          latestEvent: current?.latestEvent,
          evidenceCount: response.evidence.length,
          events: current?.events ?? [],
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
            manifest: detected.manifest ? {
              ...detected.manifest,
              execution: current.allowExternalProjectPath
                ? { ...detected.manifest.execution, mode: "oci" }
                : current.manifest?.execution ?? detected.manifest.execution
            } : current.manifest
          } : current);
        })
        .catch(() => setProjectDetection(null));
      getProjectRuntime(projectId)
        .then((response) => setProjectRuntime(response.runtime))
        .catch(() => setProjectRuntime(null));
      listProjectGrants(projectId).then((response) => setProjectGrants(response.grants)).catch(() => setProjectGrants([]));
      getPatrolTrend({ projectId, scenarioId }).then((response) => setPatrolTrend(response.trend)).catch(() => setPatrolTrend(null));
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
      setProjectDraft(saved.project);
      setSelectedProjectId(saved.project.id);
      setProjectPathInput(saved.project.projectPath);
      setAppUrl(saved.project.frontendUrl);

      setProjectLaunchPhase("正在请求 Agent 启动项目…");
      const accepted = await startProjectAsync(saved.project.id);
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
        const snapshot = await getProjectRuntime(saved.project.id).catch(() => null);
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
        if (diagnosed) setProjectDiagnosis(diagnosed.diagnosis);
        if (defaultCredential) {
          setProjectLaunchPhase("正在使用 AI 分析启动日志…");
          const recovery = await getAiStartRecovery(saved.project.id, defaultCredential.id).catch(() => null);
          if (recovery) setRuntimeRecoveryAdvice(recovery.advice);
        }
        setMessage(startedRuntime.message ?? "项目启动失败，请查看诊断结果。");
        return;
      }

      const [tested, diagnosed] = await Promise.all([
        testProjectConnection(saved.project.id),
        diagnoseProject(saved.project.id)
      ]);
      setProjectConnection(tested.result);
      setProjectDiagnosis(diagnosed.diagnosis);
      setMessage(
        tested.result.ok && diagnosed.diagnosis.overallStatus === "passed"
          ? "项目已准备好测试。"
          : diagnosed.diagnosis.stages.find((stage) => stage.status === "failed")?.humanMessage
            ?? tested.result.message
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "项目诊断失败";
      setProjectRuntime({
        projectId: selectedCandidate.id,
        status: "failed",
        phase: "failed",
        updatedAt: new Date().toISOString(),
        failureReason: "unknown",
        message: detail
      });
      setMessage(detail);
    } finally {
      setProjectLaunchPhase("");
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
    setMessage("测试账号已加密保存，运行时会自动注入沙盒。");
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

  async function continueTestPlanning(input?: string, planningMode: "llm-guided" | "scan-only" = "llm-guided") {
    const content = (input ?? planningInput).trim();
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
    setPlanningMessages((current) => [...current, userMessage]);
    setPlanningInput("");
    setPlanningBusy(true);
    setPlanningConfirmed(false);
    setPlanningAutomation({ phase: "idle", detail: "" });
    setScenarioId("");
    setMessage(planningMode === "scan-only" ? "正在快速扫描项目流程。" : "正在扫描项目，并由 AI 制定测试计划。");
    try {
      const response = await continuePlanningConversation({
        projectId,
        message: content,
        diff: diffText,
        bugTicket: bugTicketText,
        history: planningMessages,
        planningMode,
        credentialId: planningMode === "llm-guided" ? defaultCredential?.id : undefined
      });
      const assistantMessage: PlanningMessage = {
        id: `planning_assistant_${Date.now()}`,
        role: "assistant",
        content: response.planning.reply,
        createdAt: new Date().toISOString()
      };
      setPlanningMessages((current) => [...current, assistantMessage]);
      setPlanningResult(response.planning);
      setAnalysis(response.planning.analysis);
      const combinedRequirement = [...planningMessages, userMessage]
        .filter((item) => item.role === "user")
        .map((item) => item.content)
        .join("\n");
      setRequirementText(combinedRequirement);
      setMessage(response.planning.llmPlanning?.status === "failed"
        ? "代码扫描已完成，但 AI 规划暂时不可用；已保留可继续编辑的规则计划。"
        : response.planning.llmPlanning?.status === "not_configured"
          ? "代码扫描已完成。配置 AI 模型后可获得优先级建议和追问。"
        : response.planning.phase === "clarifying"
        ? "系统需要你回答几个问题，回答后会更新计划。"
        : "测试计划草案已生成，请检查业务流程后确认。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "测试规划失败";
      setPlanningMessages((current) => [...current, {
        id: `planning_error_${Date.now()}`,
        role: "assistant",
        content: `暂时无法生成计划：${detail}`,
        createdAt: new Date().toISOString()
      }]);
      setMessage(detail);
    } finally {
      setPlanningBusy(false);
    }
  }

  async function ensureProjectReadyForAutomation() {
    const candidate = projectDraft ?? projectDetection?.suggestedConfig;
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
      const liveUrl = projectRuntime?.status === "running"
        ? projectRuntime.frontendUrl ?? saved.project.frontendUrl
        : saved.project.frontendUrl;
      return { ...saved.project, frontendUrl: liveUrl, healthCheckUrl: liveUrl };
    }
    const started = await startProject(saved.project.id);
    setProjectRuntime(started.runtime);
    if (started.runtime.status !== "running") {
      const diagnosed = await diagnoseProject(saved.project.id).catch(() => null);
      if (diagnosed) setProjectDiagnosis(diagnosed.diagnosis);
      throw new Error(started.runtime.message ?? "项目无法启动。");
    }
    const connected = await testProjectConnection(saved.project.id);
    setProjectConnection(connected.result);
    if (!connected.result.ok) throw new Error(connected.result.message || "项目启动后仍无法访问。");
    const liveUrl = started.runtime.frontendUrl ?? saved.project.frontendUrl;
    setAppUrl(liveUrl);
    return {
      ...saved.project,
      frontendUrl: liveUrl,
      backendUrl: started.runtime.backendUrl ?? saved.project.backendUrl,
      healthCheckUrl: started.runtime.healthCheckUrl ?? liveUrl
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
    targetOverride?: { appUrl: string; projectId: string }
  ) {
    if (!grantedProfile.browserControl) {
      setPlanningAutomation({
        phase: "needs-permission",
        detail: "测试路径已准备好。允许本次浏览器操作后，系统会自动继续。",
        scenarioId: selectedScenarioId
      });
      setMessage("测试路径已准备好，等待浏览器操作授权。");
      return;
    }
    setPlanningAutomation({ phase: "starting-run", detail: "正在创建运行并自动完成计划审批。", scenarioId: selectedScenarioId });
    setIsRunning(true);
    try {
      const created = await createVisualRun(targetOverride?.appUrl ?? previewUrl, grantedProfile, selectedScenarioId, {
        requirement: requirementText,
        diff: diffText,
        projectId: targetOverride?.projectId ?? (selectedProjectId || projectDraft?.id),
        executionMode: selectedProjectExecutionMode
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
      setPlanningAutomation({ phase: "ready", detail: report.summary, scenarioId: selectedScenarioId });
      setMessage(report.summary);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "自动化测试启动失败";
      setPlanningAutomation({ phase: "blocked", detail, scenarioId: selectedScenarioId });
      setMessage(detail);
    } finally {
      setIsRunning(false);
    }
  }

  async function continueAutomaticPlanning(grantedProfile = permissionProfile) {
    if (!planningResult) return;
    setPlanningAutomation({ phase: "preparing-project", detail: "正在启动并连接被测项目。" });
    setMessage("计划已确认，正在自动准备项目。");
    try {
      const project = await ensureProjectReadyForAutomation();
      if (!grantedProfile.observe || !grantedProfile.browserControl) {
        setPlanningAutomation({
          phase: "needs-permission",
          detail: "允许本次浏览器操作后，系统会自动扫描页面、生成路径并开始测试。"
        });
        return;
      }
      setPlanningAutomation({ phase: "discovering", detail: "正在读取真实页面、控件、接口和可验证结果。" });
      const response = await runDiscoveryScan({
        appUrl: project.frontendUrl,
        projectId: project.id,
        sourceContexts: planningResult.analysis.sourceContexts
      });
      setDiscovery(response.discovery);
      setScenarioDrafts(response.discovery.drafts);
      if (response.discovery.status === "failed") throw new Error(response.discovery.message);
      const selectedDraft = chooseDiscoveryDraft(response.discovery);
      if (!selectedDraft) throw new Error("页面扫描没有找到可安全执行的测试路径。");
      setPlanningAutomation({ phase: "binding", detail: "正在把 AI 计划绑定到真实页面元素、操作和预期结果。" });
      const probed = await probeScenarioDraft(selectedDraft.scenarioId);
      setScenarioDrafts((current) => [probed.draft, ...current.filter((draft) => draft.scenarioId !== probed.draft.scenarioId)]);
      if (probed.draft.selectorProbeStatus !== "passed") {
        throw new Error(`页面元素绑定失败：${probed.draft.missingInfo?.join("、") || "无法验证选择器和预期结果"}`);
      }
      const approved = await approveScenarioDraft(selectedDraft.scenarioId);
      if (approved.draft.draftReviewStatus !== "approved") throw new Error("测试路径未通过自动可执行性校验。");
      setScenarioId(approved.draft.scenarioId);
      const scenarioResponse = await listScenarios();
      setScenarios(scenarioResponse.scenarios);
      await executeConfirmedScenarioAutomatically(approved.draft.scenarioId, grantedProfile, {
        appUrl: project.frontendUrl,
        projectId: project.id
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "自动生成可执行测试路径失败";
      setPlanningAutomation({ phase: "blocked", detail });
      setMessage(detail);
    }
  }

  async function confirmPlanningDraft() {
    if (!planningResult || hasBlockingPlanningQuestions(planningResult)) {
      setMessage("请先回答规划中的澄清问题。");
      return;
    }
    setPlan(planningResult.plan);
    setPlanningConfirmed(true);
    if (planningResult.recommendedScenarioId) {
      setScenarioId(planningResult.recommendedScenarioId);
      await executeConfirmedScenarioAutomatically(planningResult.recommendedScenarioId);
    } else {
      setScenarioId("");
      await continueAutomaticPlanning();
    }
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
            <button className="icon-button" onClick={() => setLeftDrawerOpen(false)} type="button" title="关闭">
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
            onSelect={selectProject}
            onDraftChange={setProjectDraft}
            onRunDiagnosis={diagnoseAndRunCurrentProject}
            onStop={stopCurrentProject}
            onApplyRecoveryCandidate={applyAiRecoveryCandidate}
            onSaveLoginCredential={saveCurrentProjectLoginCredential}
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
                </article>
              ))}
              {planningBusy && <article className="planning-message assistant pending"><strong>AI 测试官</strong><p>正在扫描代码和整理业务流程…</p></article>}
            </div>

            {planningResult && (
              <section className="planning-draft">
                <div className="planning-coverage">
                  <article><strong>{planningResult.coverage.discovered}</strong><span>识别流程</span></article>
                  <article><strong>{planningResult.coverage.executable}</strong><span>可直接执行</span></article>
                  <article><strong>{planningResult.coverage.gaps}</strong><span>覆盖缺口</span></article>
                </div>
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
                          {flow.status === "executable" ? "可执行" : flow.status === "needs-input" ? "待补条件" : "覆盖缺口"}
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
                        onClick={() => {
                          const nextPermission = { ...permissionProfile, observe: true, browserControl: true };
                          setPermissionProfile(nextPermission);
                          if (planningAutomation.scenarioId) {
                            void executeConfirmedScenarioAutomatically(planningAutomation.scenarioId, nextPermission);
                          } else {
                            void continueAutomaticPlanning(nextPermission);
                          }
                        }}
                      >
                        允许本次浏览器操作并继续
                      </button>
                    )}
                    {planningAutomation.phase === "blocked" && (
                      <button type="button" onClick={() => {
                        setPlanningConfirmed(false);
                        setPlanningAutomation({ phase: "idle", detail: "" });
                      }}>修改计划后重试</button>
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
          <button className="context-nav-item" disabled={!hasSelectedProject} onClick={loadConnectedContext} title={!hasSelectedProject ? "先完成项目接入" : undefined} type="button">
            <span>02</span>
            <div>
              <strong>测试依据</strong>
              <small>{sourceContextCount || analysis?.sources.length || 0} 个已读取来源</small>
            </div>
          </button>
          <button className="context-nav-item" disabled={!hasSelectedProject} onClick={() => { setLeftDrawerOpen(true); setRightDrawerOpen(false); }} title={!hasSelectedProject ? "先完成项目接入" : "打开测试规划对话"} type="button">
            <span>03</span>
            <div>
              <strong>规划测试</strong>
              <small>{planningConfirmed ? "计划已确认" : planningResult ? `${planningResult.coverage.discovered} 条流程待确认` : "描述目标并生成计划"}</small>
            </div>
          </button>

          {scenarioId && (
            <>
              <div className="sidebar-rule" />
              <div className="sidebar-label">本次测试内容</div>
              <label className="scenario-picker">
                <span>{selectedCandidate?.title ?? selectedScenario?.title ?? scenarioId}</span>
                <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} aria-label="选择测试内容">
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
            </>
          )}

          <div className="sidebar-footer">
            <span>{runHistory.length} 次历史运行</span>
            <button onClick={() => setRightDrawerOpen(true)} type="button">打开记录</button>
          </div>
        </aside>

        <section className="main-panel simple-main">
          <div className="mission-stage">
            <div>
              <p className="eyebrow">AI 测试任务</p>
              <h2>{selectedCandidate?.title ?? selectedScenario?.title ?? (scenarioId || "等待生成测试内容")}</h2>
              <p className="mission-reason"><span>为什么测</span>{primaryReason}</p>
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

          <section className="live-view simple-live-view" aria-label="测试现场">
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
                <AuthenticatedArtifactImage artifactUrl={latestScreenshot} alt="Agent 最新测试画面" />
                {isRunning && <span className="live-capture-badge"><Activity size={13} /> 正在执行</span>}
              </div>
            ) : projectPreviewReady ? (
              <div className="live-view-content">
                <iframe
                  key={`${previewUrl}:${previewRevision}`}
                  src={previewUrl}
                  title={`${selectedProjectName} 项目预览`}
                  sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
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

          {activeRunId && (
            <section className="review-control">
              <h3>人工裁决</h3>
              <p>runId: <code>{activeRunId}</code> · state: {activeRun?.state ?? "loading"}</p>
              <label>裁决原因
                <input aria-label="裁决原因" value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="例如：已确认该环境限制可接受" />
              </label>
              <button disabled={!reviewReason.trim()} onClick={() => void controlActiveRun("decision-override")} type="button">接受风险并留痕</button>
            </section>
          )}

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
