import type { Dispatch, SetStateAction } from "react";
import {
  getAuditStoreStatus,
  getBenchmarkSummary,
  getGrayPlan,
  getLatestDemoVerification,
  getPatrolTrend,
  getProjectRuntime,
  getSecuritySummary,
  getStorageStatus,
  listBotDeliveries,
  listCredentials,
  listHarnessGaps,
  listPatrolJobs,
  listPatrolPlans,
  listPlatformCapabilities,
  listProjectGrants,
  listProjects,
  listRunHistory,
  listScenarioDrafts,
  listScenarios,
  listStorageArchives,
  detectProject
} from "../api";
import { readProjectHistoryCache, writeProjectHistoryCache } from "../projectHistoryCache";
import type {
  AuditStoreStatus,
  BenchmarkSummary,
  BotDelivery,
  Credential,
  DemoVerificationResult,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  PatrolJob,
  PatrolTrend,
  PlatformCapability,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectGrant,
  ProjectRuntimeStatus,
  RunHistoryEntry,
  ScenarioSummary,
  SecuritySummary,
  StorageArchive,
  StorageStatus
} from "../types";

interface ContextRefreshInput {
  credentials: Credential[];
  plan: GrayPlan | null;
  projects: ProjectConfig[];
  selectedProjectId: string;
  scenarioId: string;
  projectDraft: ProjectConfig | null;
  deliveries: BotDelivery[];
  patrolJobs: PatrolJob[];
  harnessGaps: HarnessGap[];
  setCredentials: Dispatch<SetStateAction<Credential[]>>;
  setPlan: Dispatch<SetStateAction<GrayPlan | null>>;
  setProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setProjectListNotice: Dispatch<SetStateAction<string>>;
  setScenarios: Dispatch<SetStateAction<ScenarioSummary[]>>;
  setCapabilities: Dispatch<SetStateAction<PlatformCapability[]>>;
  setDeliveries: Dispatch<SetStateAction<BotDelivery[]>>;
  setPatrolJobs: Dispatch<SetStateAction<PatrolJob[]>>;
  setPatrolPlans: Dispatch<SetStateAction<PatrolJob[]>>;
  setHarnessGaps: Dispatch<SetStateAction<HarnessGap[]>>;
  setScenarioDrafts: Dispatch<SetStateAction<HarnessGapScenarioDraft[]>>;
  setDemoVerification: Dispatch<SetStateAction<DemoVerificationResult | null>>;
  setSecuritySummary: Dispatch<SetStateAction<SecuritySummary | null>>;
  setBenchmarkSummary: Dispatch<SetStateAction<BenchmarkSummary | null>>;
  setAuditStore: Dispatch<SetStateAction<AuditStoreStatus | null>>;
  setRunHistory: Dispatch<SetStateAction<RunHistoryEntry[]>>;
  setStorageStatus: Dispatch<SetStateAction<StorageStatus | null>>;
  setStorageArchives: Dispatch<SetStateAction<StorageArchive[]>>;
  setPatrolTrend: Dispatch<SetStateAction<PatrolTrend | null>>;
  setProjectDraft: Dispatch<SetStateAction<ProjectConfig | null>>;
  setProjectGrants: Dispatch<SetStateAction<ProjectGrant[]>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setProjectDetection: Dispatch<SetStateAction<ProjectDetectionResult | null>>;
  setAppUrl: Dispatch<SetStateAction<string>>;
  isRefreshingContext: boolean;
  setIsRefreshingContext: Dispatch<SetStateAction<boolean>>;
  setContextRefreshStatus: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
}

/**
 * Refreshes persisted workbench projections without altering a Run or plan.
 * Primary project data stays available from the local history cache during a
 * temporary Agent outage; slower audit views remain explicitly secondary.
 */
export function useContextRefresh(input: ContextRefreshInput) {
  async function refresh(includeSecondaryData = true) {
    const projectRequest = listProjects()
      .then((data) => {
        writeProjectHistoryCache(data.projects);
        input.setProjectListNotice(data.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
        return data;
      })
      .catch(() => {
        const cachedProjects = readProjectHistoryCache();
        input.setProjectListNotice(cachedProjects.length
          ? "Agent 暂时未连接，当前显示本机保存的最近项目；恢复连接后才能识别和运行。"
          : "Agent 暂时未连接，历史项目列表目前无法读取。");
        return { projects: cachedProjects };
      });
    const [
      credentialData, planData, scenarioData, capabilityData, deliveryData,
      patrolData, patrolPlanData, gapData, draftData, verificationData,
      projectData, securityData, benchmarkData
    ] = await Promise.all([
      listCredentials().catch(() => ({ credentials: input.credentials })),
      getGrayPlan().catch(() => input.plan),
      listScenarios().catch(() => ({ scenarios: [] })),
      listPlatformCapabilities().catch(() => ({ capabilities: [] })),
      listBotDeliveries().catch(() => ({ deliveries: input.deliveries })),
      listPatrolJobs().catch(() => ({ jobs: input.patrolJobs })),
      listPatrolPlans().catch(() => ({ plans: [] })),
      listHarnessGaps().catch(() => ({ gaps: input.harnessGaps })),
      listScenarioDrafts().catch(() => ({ drafts: [] })),
      getLatestDemoVerification().catch(() => ({ verification: null })),
      projectRequest,
      getSecuritySummary().catch(() => ({ security: null })),
      getBenchmarkSummary().catch(() => null)
    ]);
    input.setCredentials(credentialData.credentials);
    input.setPlan(planData);
    input.setScenarios(scenarioData.scenarios);
    input.setCapabilities(capabilityData.capabilities);
    input.setDeliveries(deliveryData.deliveries);
    input.setPatrolJobs(patrolData.jobs);
    input.setPatrolPlans(patrolPlanData.plans);
    input.setHarnessGaps(gapData.gaps);
    input.setScenarioDrafts(draftData.drafts);
    input.setDemoVerification(verificationData.verification);
    input.setProjects(projectData.projects);
    input.setSecuritySummary(securityData.security);
    input.setBenchmarkSummary(benchmarkData);

    if (includeSecondaryData) {
      const auditData = await getAuditStoreStatus().catch(() => ({ auditStore: null }));
      input.setAuditStore(auditData.auditStore);
      const historyData = await listRunHistory({ limit: 100 }).catch(() => ({ runs: [] }));
      input.setRunHistory(historyData.runs);
      const storageData = await getStorageStatus().catch(() => ({ storage: null }));
      input.setStorageStatus(storageData.storage);
      const archiveData = await listStorageArchives().catch(() => ({ archives: [] }));
      input.setStorageArchives(archiveData.archives);
      const trendData = await getPatrolTrend({
        projectId: input.selectedProjectId || undefined,
        scenarioId: input.scenarioId
      }).catch(() => ({ trend: null }));
      input.setPatrolTrend(trendData.trend);
    }
    if (input.selectedProjectId) {
      const refreshedProject = projectData.projects.find((project) => project.id === input.selectedProjectId);
      if (refreshedProject) {
        input.setProjectDraft((current) => {
          if (!current || current.id !== refreshedProject.id) return current;
          const currentUpdatedAt = Date.parse(current.updatedAt ?? "");
          const refreshedUpdatedAt = Date.parse(refreshedProject.updatedAt ?? "");
          return Number.isFinite(refreshedUpdatedAt) && refreshedUpdatedAt > currentUpdatedAt
            ? refreshedProject
            : current;
        });
      }
      const grantData = await listProjectGrants(input.selectedProjectId).catch(() => ({ grants: [] }));
      input.setProjectGrants(grantData.grants);
      const runtimeData = await getProjectRuntime(input.selectedProjectId).catch(() => ({ runtime: null }));
      input.setProjectRuntime(runtimeData.runtime);
    }
  }

  async function refreshInputContext() {
    if (input.isRefreshingContext) return;
    input.setIsRefreshingContext(true);
    input.setContextRefreshStatus("正在重新扫描当前项目…");
    input.setMessage("正在刷新项目和测试上下文…");
    try {
      const [projectData, scenarioData, historyData, capabilityData] = await Promise.all([
        listProjects(),
        listScenarios(),
        listRunHistory({ limit: 100 }),
        listPlatformCapabilities()
      ]);
      writeProjectHistoryCache(projectData.projects);
      input.setProjectListNotice(projectData.projects.length ? "" : "还没有接入过项目，请上传一个新项目。");
      input.setProjects(projectData.projects);
      input.setScenarios(scenarioData.scenarios);
      input.setRunHistory(historyData.runs);
      input.setCapabilities(capabilityData.capabilities);
      const currentPath = input.projectDraft?.projectPath || input.projects.find((project) => project.id === input.selectedProjectId)?.projectPath;
      if (currentPath) {
        const response = await detectProject(currentPath);
        input.setProjectDetection(response.detection);
        if (response.detection.exists) {
          const suggested = response.detection.suggestedConfig;
          input.setProjectDraft((current) => current ? {
            ...current,
            installCommand: suggested.installCommand,
            startCommand: suggested.startCommand,
            processes: suggested.processes,
            healthCheckUrl: suggested.healthCheckUrl,
            frontendUrl: suggested.frontendUrl,
            backendUrl: suggested.backendUrl
          } : suggested);
          input.setAppUrl(suggested.frontendUrl);
        }
      }
      if (input.selectedProjectId) {
        const runtimeData = await getProjectRuntime(input.selectedProjectId);
        input.setProjectRuntime(runtimeData.runtime);
      }
      input.setContextRefreshStatus(`刷新完成 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
      input.setMessage("项目与测试上下文已刷新。");
    } catch (error) {
      const cachedProjects = readProjectHistoryCache();
      if (cachedProjects.length) input.setProjects(cachedProjects);
      input.setProjectListNotice(cachedProjects.length
        ? "Agent 暂时未连接，当前显示本机保存的最近项目；恢复连接后才能刷新。"
        : "Agent 暂时未连接，历史项目列表目前无法读取。");
      input.setContextRefreshStatus(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败");
      input.setMessage(error instanceof Error ? `刷新失败：${error.message}` : "刷新失败");
    } finally {
      input.setIsRefreshingContext(false);
    }
  }

  return { refresh, refreshInputContext };
}
