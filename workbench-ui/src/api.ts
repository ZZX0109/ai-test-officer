import type {
  BotDelivery,
  AuditStoreStatus,
  CommitCheckResult,
  ConnectorContext,
  Credential,
  DemoVerificationResult,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  IntakeAnalysis,
  LiveRunState,
  PatrolJob,
  PatrolRunResult,
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
  RunBundleDownloadManifest,
  RunHistoryEntry,
  RunResult,
  ScenarioSummary,
  SecuritySummary,
  DiscoveryScanResult,
  StorageArchive,
  StorageStatus,
  TargetAppRuntime,
  PatrolTrend
} from "./types";

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

export const AGENT_URL = viteEnv.VITE_AGENT_URL ?? "http://localhost:4317";
export const AGENT_TOKEN = viteEnv.VITE_AGENT_TOKEN ?? "dev-local-token";

interface RunTargetPayload {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENT_URL}${path}`, {
    headers: { "content-type": "application/json", "x-agent-token": AGENT_TOKEN, ...(options?.headers ?? {}) },
    ...options
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function listCredentials() {
  return request<{ credentials: Credential[] }>("/api/credentials");
}

export function createCredential(payload: {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  tags: string[];
  owner?: string;
  scopes?: string[];
  isDefault: boolean;
}) {
  return request<{ credential: Credential }>("/api/credentials", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateCredential(
  id: string,
  payload: Partial<{
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    tags: string[];
    owner: string;
    scopes: string[];
    isDefault: boolean;
  }>
) {
  return request<{ credential: Credential }>(`/api/credentials/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function deleteCredential(id: string) {
  return request<{ deleted: boolean }>(`/api/credentials/${id}`, { method: "DELETE" });
}

export function rotateCredential(id: string, payload: { apiKey: string; reason?: string }) {
  return request<{ credential: Credential }>(`/api/credentials/${id}/rotate`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function testCredential(id: string) {
  return request<{ ok: boolean; status: number; message: string }>(`/api/credentials/${id}/test`, {
    method: "POST"
  });
}

export function getGrayPlan() {
  return request<GrayPlan>("/api/gray-plan");
}

export function generatePlan(payload: { requirement: string; diff: string; credentialId?: string }) {
  return request<{ source: string; message: string; plan: GrayPlan }>("/api/generate-plan", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function analyzeIntake(payload: { requirement: string; diff: string; bugTicket?: string; prUrl?: string }) {
  return request<{ analysis: IntakeAnalysis }>("/api/intake/analyze", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function analyzeConnectedContext(payload: {
  requirementPath?: string;
  requirementUrl?: string;
  bugTicketPath?: string;
  bugTicketUrl?: string;
  prUrl?: string;
  prDiffUrl?: string;
  gitBase?: string;
  gitHead?: string;
  staged?: boolean;
  fallbackDiff?: string;
  openApiPath?: string;
  openApiUrl?: string;
  strictInput?: boolean;
}) {
  return request<{ context: ConnectorContext; analysis: IntakeAnalysis }>("/api/intake/analyze-connected", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runCommitCheck(payload: RunTargetPayload & {
  scenarioId?: string;
  credentialId?: string;
  requirementPath?: string;
  requirementUrl?: string;
  bugTicketPath?: string;
  bugTicketUrl?: string;
  prUrl?: string;
  prDiffUrl?: string;
  gitBase?: string;
  gitHead?: string;
  staged?: boolean;
  fallbackDiff?: string;
  openApiPath?: string;
  openApiUrl?: string;
  strictInput?: boolean;
  notify?: string[];
  permissionProfile: PermissionProfile;
}) {
  return request<{ check: CommitCheckResult }>("/api/commit-check/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runRequirementAcceptance(payload: RunTargetPayload & {
  scenarioId?: string;
  credentialId?: string;
  requirement?: string;
  diff?: string;
  bugTicket?: string;
  requirementPath?: string;
  requirementUrl?: string;
  bugTicketPath?: string;
  bugTicketUrl?: string;
  prUrl?: string;
  prDiffUrl?: string;
  gitBase?: string;
  gitHead?: string;
  staged?: boolean;
  fallbackDiff?: string;
  openApiPath?: string;
  openApiUrl?: string;
  strictInput?: boolean;
  notify?: string[];
  permissionProfile: PermissionProfile;
}) {
  return request<{ acceptance: RequirementAcceptanceResult }>("/api/requirement-acceptance/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listPlatformCapabilities() {
  return request<{ capabilities: PlatformCapability[] }>("/api/platform-capabilities");
}

export function getAuditStoreStatus() {
  return request<{ auditStore: AuditStoreStatus }>("/api/audit-store/status");
}

export function listScenarios() {
  return request<{ scenarios: ScenarioSummary[] }>("/api/scenarios");
}

export function getLatestLiveRun() {
  return request<LiveRunState>("/api/live-run/latest");
}

export function runVisualTest(
  appUrl: string | undefined,
  permissionProfile: PermissionProfile,
  scenarioId?: string,
  context?: RunTargetPayload & {
    requirement?: string;
    diff?: string;
    plan?: GrayPlan;
    trigger?: "manual" | "commit" | "requirement" | "patrol";
    credentialId?: string;
    keepProjectRunning?: boolean;
  }
) {
  return request<RunResult>("/api/run-visual-test", {
    method: "POST",
    body: JSON.stringify({ appUrl, scenarioId, permissionProfile, ...(context ?? {}) })
  });
}

export function runPatrol(payload: RunTargetPayload & {
  scenarioId?: string;
  credentialId?: string;
  requirement?: string;
  diff?: string;
  plan?: GrayPlan;
  notify?: string[];
  permissionProfile: PermissionProfile;
}) {
  return request<{ run: RunResult; delivery: BotDelivery; patrol: PatrolRunResult }>("/api/patrol/run-now", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listPatrolJobs() {
  return request<{ jobs: PatrolJob[] }>("/api/patrol/jobs");
}

export function startPatrolJob(payload: {
  id?: string;
  title?: string;
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  scenarioId?: string;
  intervalMs?: number;
  cron?: string;
  notify?: string[];
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
  };
  escalationPolicy?: {
    failureThreshold: number;
    riskTrendThreshold: "regressed" | "stable" | "any";
    notify: string[];
  };
  permissionProfile: PermissionProfile;
}) {
  return request<{ job: PatrolJob }>("/api/patrol/start", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function stopPatrolJob(payload: { id?: string }) {
  return request<{ job: PatrolJob }>("/api/patrol/stop", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listPatrolPlans() {
  return request<{ plans: PatrolJob[] }>("/api/patrol/plans");
}

export function savePatrolPlan(payload: Partial<PatrolJob> & { id?: string }) {
  return request<{ plan: PatrolJob }>("/api/patrol/plans", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updatePatrolPlan(id: string, payload: Partial<PatrolJob>) {
  return request<{ plan: PatrolJob }>(`/api/patrol/plans/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function deletePatrolPlan(id: string) {
  return request<{ deleted: boolean }>(`/api/patrol/plans/${id}`, { method: "DELETE" });
}

export function runPatrolPlanNow(id: string) {
  return request<{ run: RunResult; delivery: BotDelivery; patrol: PatrolRunResult }>(`/api/patrol/plans/${id}/run-now`, {
    method: "POST"
  });
}

export function getPatrolTrend(filters?: { projectId?: string; scenarioId?: string }) {
  const params = new URLSearchParams();
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.scenarioId) params.set("scenarioId", filters.scenarioId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{ trend: PatrolTrend }>(`/api/patrol/trends${suffix}`);
}

export function listHarnessGaps() {
  return request<{ gaps: HarnessGap[] }>("/api/harness-gaps");
}

export function updateHarnessGap(id: string, payload: { status: HarnessGap["status"] }) {
  return request<{ gap: HarnessGap }>(`/api/harness-gaps/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function createHarnessGapDraft(id: string) {
  return request<{ draft: HarnessGapScenarioDraft }>(`/api/harness-gaps/${id}/draft-scenario`, {
    method: "POST"
  });
}

export function installHarnessGapDraft(id: string) {
  return request<{ draft: HarnessGapScenarioDraft }>(`/api/harness-gaps/${id}/install-draft`, {
    method: "POST"
  });
}

export function listScenarioDrafts() {
  return request<{ drafts: HarnessGapScenarioDraft[] }>("/api/scenario-drafts");
}

export function probeScenarioDraft(id: string) {
  return request<{ draft: HarnessGapScenarioDraft }>(`/api/scenario-drafts/${id}/probe`, {
    method: "POST"
  });
}

export function approveScenarioDraft(id: string) {
  return request<{ draft: HarnessGapScenarioDraft }>(`/api/scenario-drafts/${id}/approve`, {
    method: "POST"
  });
}

export function getLatestDemoVerification() {
  return request<{ verification: DemoVerificationResult }>("/api/demo-verification/latest");
}

export function listBotDeliveries() {
  return request<{ deliveries: BotDelivery[] }>("/api/bot/deliveries");
}

export function deliverLatestRun(payload: { runId?: string; channel?: string; recipients?: string[] }) {
  return request<{ delivery: BotDelivery }>("/api/bot/deliveries", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deliverRunToBot(payload: {
  runId?: string;
  provider?: BotDelivery["provider"];
  channel?: string;
  recipients?: string[];
  includeScreenshots?: boolean;
  githubPrUrl?: string;
}) {
  return request<{ delivery: BotDelivery }>("/api/bot/deliveries", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listProjects() {
  return request<{ projects: ProjectConfig[] }>("/api/projects");
}

export function saveProject(payload: ProjectConfig) {
  return request<{ project: ProjectConfig }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function detectProject(projectPath: string) {
  return request<{ detection: ProjectDetectionResult }>("/api/projects/detect", {
    method: "POST",
    body: JSON.stringify({ projectPath })
  });
}

export function diagnoseProject(id: string) {
  return request<{ diagnosis: ProjectDiagnosis }>(`/api/projects/${id}/diagnose`, {
    method: "POST"
  });
}

export function testProjectConnection(id: string) {
  return request<{ result: ProjectHealthCheckResult }>(`/api/projects/${id}/test-connection`, {
    method: "POST"
  });
}

export function startProject(id: string) {
  return request<{ runtime: ProjectRuntimeStatus }>(`/api/projects/${id}/start`, { method: "POST" });
}

export function stopProject(id: string) {
  return request<{ runtime: ProjectRuntimeStatus }>(`/api/projects/${id}/stop`, { method: "POST" });
}

export function listProjectGrants(projectId: string) {
  return request<{ grants: ProjectGrant[] }>(`/api/projects/${projectId}/grants`);
}

export function createProjectGrant(projectId: string, payload: {
  subject: string;
  role: ProjectGrant["role"];
  tokenKind?: ProjectGrant["tokenKind"];
  scopes?: ProjectGrant["scopes"];
  expiresAt?: string;
}) {
  return request<{ grant: ProjectGrant }>(`/api/projects/${projectId}/grants`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteProjectGrant(projectId: string, grantId: string) {
  return request<{ deleted: boolean }>(`/api/projects/${projectId}/grants/${grantId}`, { method: "DELETE" });
}

export function runDiscoveryScan(payload: RunTargetPayload & { sourceContexts?: unknown[] }) {
  return request<{ discovery: DiscoveryScanResult }>("/api/discovery/scan", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listRunHistory(filters?: { projectId?: string; scenarioId?: string; verdict?: string; from?: string; to?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.scenarioId) params.set("scenarioId", filters.scenarioId);
  if (filters?.verdict) params.set("verdict", filters.verdict);
  if (filters?.from) params.set("from", filters.from);
  if (filters?.to) params.set("to", filters.to);
  if (filters?.limit) params.set("limit", String(filters.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<{ runs: RunHistoryEntry[] }>(`/api/run-history${suffix}`);
}

export function getStorageStatus() {
  return request<{ storage: StorageStatus }>("/api/storage/status");
}

export function getSecuritySummary() {
  return request<{ security: SecuritySummary }>("/api/security/summary");
}

export function listStorageArchives() {
  return request<{ archives: StorageArchive[] }>("/api/storage/archives");
}

export function runStorageRetention(payload: { apply?: boolean; archive?: boolean }) {
  return request<{ retention: Record<string, unknown> }>("/api/storage/retention/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getRunBundle(runId: string) {
  return request<RunBundle>(`/api/runs/${runId}`);
}

export function createRunBundleDownload(runId: string, payload?: { maxInlineBytes?: number }) {
  return request<{
    archive: {
      zipFile: string;
      manifestFile: string;
      manifest: RunBundleDownloadManifest;
    };
  }>(`/api/runs/${runId}/download-bundle`, {
    method: "POST",
    body: JSON.stringify(payload ?? {})
  });
}

export async function downloadArtifactBlob(artifactUrl: string) {
  const response = await fetch(`${AGENT_URL}${artifactUrl}`, {
    headers: { "x-agent-token": AGENT_TOKEN }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.blob();
}
