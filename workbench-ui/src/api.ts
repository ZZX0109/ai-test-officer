import type {
  BotDelivery,
  AuditStoreStatus,
  AgentGraphProjection,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  RepairDecisionAnswer,
  BenchmarkSummary,
  CommitCheckResult,
  ConnectorContext,
  Credential,
  DemoVerificationResult,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  IntakeAnalysis,
  LiveRunState,
  LlmInvocation,
  PatrolJob,
  PatrolRunResult,
  PermissionProfile,
  PlanningConversationResult,
  PlanningMessage,
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
  RepairPlanData,
  RepairSession,
  RepairWorkspaceFile,
  RunBundle,
  RunBundleDownloadManifest,
  RunHistoryEntry,
  RunProjection,
  RunResult,
  Conclusion,
  ProofEdge,
  CoverageItem,
  ScenarioSummary,
  SecuritySummary,
  DiscoveryPageObservation,
  DiscoveryScanResult,
  StorageArchive,
  StorageStatus,
  TargetAppRuntime,
  PatrolTrend
} from "./types";
import { getAccessToken } from "./auth";

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

// Use a same-origin reverse proxy by default. This keeps the browser unaware of
// the Agent's internal port and avoids CORS/localhost differences in development.
export const AGENT_URL = (viteEnv.VITE_AGENT_URL ?? "/agent-api").replace(/\/$/, "");
// The loopback Agent intentionally accepts this token in NODE_ENV=development.
// Keep production builds explicit: a deployed Workbench must use OIDC or an
// injected VITE_AGENT_TOKEN rather than silently relying on the dev credential.
export const AGENT_TOKEN = viteEnv.VITE_AGENT_TOKEN ?? (viteEnv.DEV ? "dev-local-token" : undefined);

export function getBenchmarkSummary() {
  return request<BenchmarkSummary>("/api/benchmark/summary");
}

export function getRunAgent(runId: string) {
  return request<{ agent: AgentGraphProjection | null }>(`/v1/runs/${encodeURIComponent(runId)}/agent`);
}

export function getRunBrowserSession(runId: string) {
  return request<{ session: BrowserSession | null }>(`/v1/runs/${encodeURIComponent(runId)}/browser-session`);
}

export function getRunBrowserObservations(runId: string) {
  return request<{ observations: BrowserObservation[] }>(`/v1/runs/${encodeURIComponent(runId)}/browser-observations`);
}

export function getRunBrowserActions(runId: string) {
  return request<{ decisions: BrowserActionDecision[]; actions: BrowserActionResult[] }>(`/v1/runs/${encodeURIComponent(runId)}/browser-actions`);
}

export function acquireRunBrowserControl(runId: string) {
  return request<{ session: BrowserSession }>(`/v1/runs/${encodeURIComponent(runId)}/browser-control/acquire`, { method: "POST", body: JSON.stringify({}) });
}

export function releaseRunBrowserControl(runId: string) {
  return request<{ session: BrowserSession }>(`/v1/runs/${encodeURIComponent(runId)}/browser-control/release`, { method: "POST", body: JSON.stringify({}) });
}

export function sendRunBrowserInput(runId: string, input: { kind: "click" | "type" | "press" | "scroll"; x?: number; y?: number; text?: string; key?: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space"; deltaY?: number }) {
  return request<{ observation: BrowserObservation }>(`/v1/runs/${encodeURIComponent(runId)}/browser-input`, { method: "POST", body: JSON.stringify(input) });
}

export function getRunRecoveryActions(runId: string) {
  return request<{
    decisions: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    observations: Array<Record<string, unknown>>;
  }>(`/v1/runs/${encodeURIComponent(runId)}/recovery-actions`);
}

export function getRunObservations(runId: string) {
  return request<{ observations: Array<Record<string, unknown>> }>(`/v1/runs/${encodeURIComponent(runId)}/observations`);
}

export function recoverRun(runId: string, payload: { approved?: boolean; action?: string } = {}) {
  return request<{ accepted: boolean; runId: string; agent: AgentGraphProjection | null }>(`/v1/runs/${encodeURIComponent(runId)}/recover`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function retryRunPath(runId: string, pathId: string) {
  return request<{ accepted: boolean; pathId: string }>(`/v1/runs/${encodeURIComponent(runId)}/paths/${encodeURIComponent(pathId)}/retry`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function continueRun(runId: string, approved = true) {
  return request<{ accepted: boolean }>(`/v1/runs/${encodeURIComponent(runId)}/continue`, {
    method: "POST",
    body: JSON.stringify({ approved })
  });
}

export function getRunCoverage(runId: string) {
  return request<{
    coverage: CoverageItem[];
    disposition: { executed: number; excluded: number; blocked: number; pending: number };
    complete: boolean;
  }>(`/v1/runs/${encodeURIComponent(runId)}/coverage`);
}

export function getRunLlmCalls(runId: string) {
  return request<{
    calls: LlmInvocation[];
    budgetLedger: {
      budget: { maxTotalTokens: number; totalTimeoutMs: number; maxJudgeCalls: number };
      reserved: { tokens: number; wallClockMs: number };
      consumed: { plannerCalls: number; browserActionCalls: number; judgeCalls: number; triageCalls: number; repairCalls: number; tokens: number; wallClockMs: number; estimatedCostUsd: number | null };
    };
    summary: { count: number; totalTokens: number; cost: number | "unknown"; retries: number; failures: number };
  }>(`/v1/runs/${encodeURIComponent(runId)}/llm-calls`);
}

export function getRunConclusions(runId: string) {
  return request<{
    conclusions: Conclusion[];
    manifest: { evidenceSetRoot: string; integrityStatus: string; generatedAt: string } | null;
    integrity: { valid: boolean; errors: string[] };
  }>(`/v1/runs/${encodeURIComponent(runId)}/conclusions`);
}

export function getRunKnowledge(runId: string) {
  return request<{
    contexts: Array<{ id?: string; generatedAt: string }>;
    decisions: Array<{
      id: string;
      contextId: string;
      invocationId?: string;
      validationStatus: "pending" | "verified" | "rejected" | "expired";
      output: NonNullable<PlanningMessage["knowledge"]>;
      createdAt: string;
    }>;
    conflicts: Array<{ id: string; status: "open" | "resolved" | "superseded"; claimIds: string[] }>;
    toolExecutions: Array<{ id: string; status: string; request: { tool: string; reason: string } }>;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
      reasoningSummary?: NonNullable<PlanningMessage["reasoningSummary"]>;
      suggestedAction?: PlanningMessage["suggestedAction"];
      requiresConfirmation?: boolean;
      knowledgeContextId?: string;
      knowledgeDecisionId?: string;
      llmCallId?: string;
    }>;
  }>(`/v1/runs/${encodeURIComponent(runId)}/knowledge`);
}

export function getKnowledgeClaimSource(claimId: string, contextId?: string) {
  const query = contextId ? `?contextId=${encodeURIComponent(contextId)}` : "";
  return request<{
    claimId: string;
    contextId: string;
    status: "observed" | "user-provided" | "retrieved" | "inferred" | "assumed" | "unknown";
    domain: string;
    statement?: string;
    sensitive: boolean;
    sourceRefs: string[];
    scope: {
      organizationId?: string;
      projectId?: string;
      runId?: string;
      scenarioId?: string;
      attemptId?: string;
      stepId?: string;
      commitSha?: string;
      projectDigest?: string;
      manifestHash?: string;
      lockfileHash?: string;
      registryHash?: string;
      filePath?: string;
      fileSha256?: string;
    };
  }>(`/v1/knowledge-claims/${encodeURIComponent(claimId)}/source${query}`);
}

export function getConclusionProof(runId: string, conclusionId: string) {
  return request<{
    conclusion: Conclusion;
    edges: ProofEdge[];
    evidence: RunResult["evidence"];
    artifacts: NonNullable<RunResult["artifactsV2"]>;
    attempts: NonNullable<RunResult["attempts"]>;
    steps: RunResult["steps"];
  }>(`/v1/conclusions/${encodeURIComponent(conclusionId)}/proof?runId=${encodeURIComponent(runId)}`);
}

/**
 * Owner-aware repair plan for a run.
 *
 * Returns `null` when the run has no failure attribution yet (404 from the
 * API) — "no plan" is a normal state, not an error, so callers can poll this
 * without treating the empty case as a failure.
 */
export async function getRunRepairPlan(runId: string): Promise<RepairPlanData | null> {
  try {
    const plan = await request<RepairPlanData & { persisted?: boolean; idempotencyKey?: string }>(
      `/v1/runs/${encodeURIComponent(runId)}/repair-plan`
    );
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no_repair_plan|run_not_found|\b404\b/.test(message)) return null;
    throw error;
  }
}

/**
 * Persist a repair-plan lifecycle transition on the backend (status change +
 * audit event) so an executed/resolved plan survives a workbench refresh.
 */
export async function updateRepairPlanStatus(
  runId: string,
  planId: string,
  status?: "applied" | "resolved" | "dismissed",
  opts?: { event?: string; note?: string }
): Promise<RepairPlanData | null> {
  try {
    const plan = await request<RepairPlanData & { persisted?: boolean }>(
      `/v1/runs/${encodeURIComponent(runId)}/repair-plan/${encodeURIComponent(planId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...opts })
      }
    );
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/repair_plan_not_found|run_not_found|\b404\b/.test(message)) return null;
    throw error;
  }
}

export function sendRunAgentMessage(runId: string, payload: {
  message: string;
  credentialId?: string;
  origin?: "user" | "system-diagnosis";
}) {
  return request<{
    assistant: {
      reply: string;
      reasoningSummary: NonNullable<PlanningMessage["reasoningSummary"]>;
      repairPlan?: PlanningMessage["repairPlan"];
      suggestedAction: NonNullable<PlanningMessage["suggestedAction"]>;
      requiresConfirmation: boolean;
      knowledge: {
        schemaVersion: "2.0";
        factsUsed: string[];
        inferences: Array<{ statement: string; sourceClaimIds: string[] }>;
        assumptions: Array<{ statement: string; risk: "low" | "medium" | "high" }>;
        unknowns: string[];
        toolRequests: Array<{ tool: string; input: Record<string, unknown>; reason: string; sourceClaimIds: string[] }>;
        blockingQuestions: string[];
        proposedActions: Array<{ capability: string; reason: string; sourceClaimIds: string[]; requiresConfirmation: boolean }>;
      };
    };
    call: {
      id: string;
      provider: string;
      model: string;
      status: string;
      durationMs: number;
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      semanticRepairApplied?: boolean;
      fallbackApplied?: boolean;
      errorCode?: string;
      knowledgeContextId?: string;
      knowledgeDecisionId?: string;
      knowledgeValidationStatus?: string;
    };
  }>(`/v1/runs/${encodeURIComponent(runId)}/messages`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function resumeRunAgentInterrupt(
  runId: string,
  interruptId: string,
  payload: { approved: boolean; input?: Record<string, unknown> }
) {
  return request<{ agent: AgentGraphProjection }>(
    `/v1/runs/${encodeURIComponent(runId)}/interrupts/${encodeURIComponent(interruptId)}/resume`,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

/**
 * Resume a `repair-decision` interrupt. Unlike the generic approval resume this
 * forwards a full {@link RepairDecisionAnswer}, which the graph applies before
 * continuing the very same thread — the user's choice is what unblocks the run,
 * not a bare boolean.
 */
export function resumeRepairDecision(
  runId: string,
  interruptId: string,
  answer: RepairDecisionAnswer
) {
  return request<{ agent: AgentGraphProjection }>(
    `/v1/runs/${encodeURIComponent(runId)}/interrupts/${encodeURIComponent(interruptId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({
        approved: answer.decision !== "dismiss",
        decision: answer.decision,
        ...(answer.message ? { message: answer.message } : {}),
        ...(answer.repairPlanId ? { repairPlanId: answer.repairPlanId } : {})
      })
    }
  );
}

export function listRunRepairs(runId: string) {
  return request<{ repairs: RepairSession[] }>(`/v1/runs/${encodeURIComponent(runId)}/repairs`);
}

export function createRunRepair(
  runId: string,
  payload: { autoAnalyze?: boolean; credentialId?: string; summary?: string } = {}
) {
  return request<{ repair: RepairSession }>(`/v1/runs/${encodeURIComponent(runId)}/repairs`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createProjectCodeSession(
  projectId: string,
  input: string | { summary?: string; autoAnalyze?: boolean; credentialId?: string } = {}
) {
  const payload = typeof input === "string" ? { summary: input } : input;
  return request<{ repair: RepairSession }>(`/v1/projects/${encodeURIComponent(projectId)}/code-sessions`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getRepairSession(id: string) {
  return request<{ repair: RepairSession }>(`/v1/repair-sessions/${encodeURIComponent(id)}`);
}

export function listRepairWorkspaceFiles(id: string) {
  return request<{ files: RepairWorkspaceFile[] }>(`/v1/repair-sessions/${encodeURIComponent(id)}/files`);
}

export function getRepairFile(id: string, filePath: string) {
  return request<{ file: RepairFileContent }>(
    `/v1/repair-sessions/${encodeURIComponent(id)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`
  );
}

export function updateRepairFile(
  id: string,
  filePath: string,
  payload: { content: string; expectedVersion: number }
) {
  return request<{ repair: RepairSession }>(
    `/v1/repair-sessions/${encodeURIComponent(id)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`,
    { method: "PUT", body: JSON.stringify(payload) }
  );
}

export function validateRepair(id: string, allowNetworkInstall = false) {
  return request<{ repair: RepairSession }>(`/v1/repair-sessions/${encodeURIComponent(id)}/validate`, {
    method: "POST",
    body: JSON.stringify({ allowNetworkInstall })
  });
}

export function exportRepair(id: string, format: "patch" | "zip") {
  return request<{
    export: { id: string; format: "patch" | "zip"; downloadUrl: string; sha256: string; sizeBytes: number };
  }>(`/v1/repair-sessions/${encodeURIComponent(id)}/export`, {
    method: "POST",
    body: JSON.stringify({ format })
  });
}

export function applyRepair(id: string, confirmHighRisk = false) {
  return request<{ repair: RepairSession }>(`/v1/repair-sessions/${encodeURIComponent(id)}/apply`, {
    method: "POST",
    body: JSON.stringify({ confirm: true, confirmHighRisk })
  });
}

interface RunTargetPayload {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  /** Mirrors the selected project's manifest; never silently downgrades OCI. */
  executionMode?: "oci" | "trusted-local";
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set("content-type", "application/json");
  if (AGENT_TOKEN) headers.set("x-agent-token", AGENT_TOKEN);
  const accessToken = getAccessToken();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const method = (options?.method ?? "GET").toUpperCase();
  const assistantMessageRequest = path === "/api/assistant/chat";
  // During local development the Agent can briefly restart after a contracts
  // build while Vite remains visible. Assistant messages get one retry only
  // when the Agent health endpoint proves that no backend was available; a
  // healthy Agent response is never replayed because doing so could duplicate
  // model cost. Durable run-thread messages remain excluded until their POST
  // carries an explicit idempotency key.
  const maxAttempts = method === "GET" ? 3 : assistantMessageRequest ? 2 : 1;
  // A slow optional dashboard endpoint must not leave the whole Workbench in
  // an endless "connecting" state. Mutating/LLM requests keep their own
  // operation budgets; ordinary reads receive a bounded total deadline.
  const requestSignal = options?.signal
    ?? (method === "GET" ? AbortSignal.timeout(12_000) : undefined);
  let response: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetch(`${AGENT_URL}${path}`, {
        credentials: "include",
        ...options,
        headers,
        signal: requestSignal
      });
      if (response.ok || ![500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) break;
      // A model request must not be replayed merely because it returned a
      // provider/server error: the first attempt may already have consumed
      // tokens. Retry only when the Agent health endpoint confirms that the
      // local backend itself is unavailable.
      if (assistantMessageRequest) {
        if (await agentIsReady()) break;
        await waitForAgentReady(15_000);
      }
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      if (attempt === maxAttempts) {
        throw new Error("AI 测试服务正在启动或暂时不可用，请稍候。");
      }
      if (assistantMessageRequest) {
        // If the Agent is healthy, a failed fetch may mean the response was
        // lost after the model call completed. Replaying would duplicate cost
        // and side effects, so surface the transport error instead.
        if (await agentIsReady()) {
          throw new Error("AI 回复传输中断，系统没有重复调用模型。请重新发送这条消息。");
        }
        await waitForAgentReady(15_000);
      }
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250 * attempt));
  }
  if (!response) throw new Error("AI 测试服务正在启动或暂时不可用，请稍候。");
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function agentIsReady(): Promise<boolean> {
  try {
    const headers = new Headers();
    if (AGENT_TOKEN) headers.set("x-agent-token", AGENT_TOKEN);
    const accessToken = getAccessToken();
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    const response = await fetch(`${AGENT_URL}/api/health`, {
      credentials: "include",
      headers,
      signal: AbortSignal.timeout(1_500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForAgentReady(timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const headers = new Headers();
      if (AGENT_TOKEN) headers.set("x-agent-token", AGENT_TOKEN);
      const response = await fetch(`${AGENT_URL}/api/health`, {
        headers,
        credentials: "include",
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return;
    } catch {
      // The supervisor may still be starting or restarting the Agent.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 300));
  }
  throw new Error("AI 测试服务启动超时，请重新启动工作台。");
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

export function generatePlan(
  payload: { projectId: string; requirement: string; diff: string; credentialId?: string; plannerMode?: "adaptive" | "rules" },
  options?: { signal?: AbortSignal }
) {
  return request<{
    source: string;
    message: string;
    plan: GrayPlan;
    scenarioId?: string;
    provenance?: {
      source: string;
      promptVersion?: string;
      model?: string;
      compilationStatus?: "validated" | "rejected" | "not-required";
    };
  }>("/api/generate-plan", {
    method: "POST",
    body: JSON.stringify(payload),
    signal: options?.signal
  });
}

export function analyzeIntake(payload: { requirement: string; diff: string; bugTicket?: string; prUrl?: string; projectId?: string }) {
  return request<{ analysis: IntakeAnalysis }>("/api/intake/analyze", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function continuePlanningConversation(payload: {
  projectId: string;
  message: string;
  diff?: string;
  bugTicket?: string;
  history: PlanningMessage[];
  planningMode?: "llm-guided" | "scan-only";
  credentialId?: string;
}) {
  return request<{ planning: PlanningConversationResult; discovery?: DiscoveryScanResult }>("/api/planning/conversation", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getPlanningFlowPage(payload: {
  planningId: string;
  projectId: string;
  cursor?: string;
  limit?: number;
}) {
  const query = new URLSearchParams({ projectId: payload.projectId });
  if (payload.cursor) query.set("cursor", payload.cursor);
  if (payload.limit) query.set("limit", String(payload.limit));
  return request<{
    flows: PlanningConversationResult["businessFlows"];
    page: NonNullable<PlanningConversationResult["businessFlowPage"]>;
  }>(`/api/planning/${encodeURIComponent(payload.planningId)}/flows?${query.toString()}`);
}

export function chatWithTestAssistant(payload: {
  projectId: string;
  message: string;
  credentialId?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  context: {
    runId?: string;
    runState?: string;
    finalStatus?: string;
    summary?: string;
    evidenceCount?: number;
    currentStep?: string;
    latestLog?: string;
    pageObservation?: DiscoveryPageObservation;
    failedAssertions: Array<{ name: string; expected: string; actual: string }>;
    planning?: {
      discovered: number;
      executable: number;
      autoBindable: number;
      confirmed: boolean;
      failures?: Array<{
        title?: string;
        target?: string;
        stage?: "binding" | "execution";
        detail: string;
        requiredInformation?: string[];
      }>;
      blockingQuestions?: string[];
    };
  };
}) {
  return request<{
    assistant: {
      reply: string;
      reasoningSummary: NonNullable<PlanningMessage["reasoningSummary"]>;
      repairPlan?: PlanningMessage["repairPlan"];
      intent: "status-question" | "failure-question" | "plan-change" | "execution-control" | "general";
      suggestedAction: NonNullable<PlanningMessage["suggestedAction"]>;
      requiresConfirmation: boolean;
      knowledge: {
        schemaVersion: "2.0";
        factsUsed: string[];
        inferences: Array<{ statement: string; sourceClaimIds: string[] }>;
        assumptions: Array<{ statement: string; risk: "low" | "medium" | "high" }>;
        unknowns: string[];
        toolRequests: Array<{ tool: string; input: Record<string, unknown>; reason: string; sourceClaimIds: string[] }>;
        blockingQuestions: string[];
        proposedActions: Array<{ capability: string; reason: string; sourceClaimIds: string[]; requiresConfirmation: boolean }>;
      };
    };
    call: {
      id: string;
      model: string;
      provider: string;
      status: string;
      durationMs?: number;
      usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      semanticRepairApplied?: boolean;
      fallbackApplied?: boolean;
      errorCode?: string;
      knowledgeContextId?: string;
      knowledgeDecisionId?: string;
      knowledgeValidationStatus?: string;
    };
  }>("/api/assistant/chat", {
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
  },
  onCreated?: (runId: string) => void
) {
  return runThroughV1({ appUrl, scenarioId, permissionProfile, ...(context ?? {}) }, onCreated);
}

export function createVisualRun(
  appUrl: string | undefined,
  permissionProfile: PermissionProfile,
  scenarioId: string | undefined,
  context: RunTargetPayload & {
    requirement?: string;
    diff?: string;
    coverageScenarioIds?: string[];
    coverageInventory?: Array<{
      id: string;
      title: string;
      kind: "page" | "component" | "api" | "scenario" | "data" | "background-task";
      target: string;
      sourceNodeIds: string[];
      sourceCount: number;
      surfaces?: Array<"page" | "api" | "data" | "background-task">;
      requiredEvidenceKinds?: string[];
      preconditions?: string[];
    }>;
    coverageMode?: "targeted" | "full";
    dynamicBrowser?: boolean;
    modelProfileId?: string;
  }
) {
  const idempotencyKey = crypto.randomUUID();
  return request<{ run: RunProjection }>("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      organizationId: "local",
      projectId: context.projectId,
      actor: "workbench-user",
      idempotencyKey,
      runKind: "parent",
      input: {
        appUrl,
        scenarioId,
        coverageScenarioIds: context.coverageScenarioIds ?? (scenarioId ? [scenarioId] : []),
        coverageMode: context.coverageMode ?? ((context.coverageScenarioIds?.length ?? 0) > 1 ? "full" : "targeted"),
        coverageInventory: context.coverageInventory ?? [],
        dynamicBrowser: context.dynamicBrowser ?? false,
        requirement: context.requirement,
        diff: context.diff,
        // The conversation planner and the durable Graph must use the same
        // active model profile. Previously the Workbench used SophNet to
        // explain the plan, then created a deterministic-only Run, so the LLM
        // could not participate in recovery or selective judging.
        plannerMode: context.modelProfileId ? "adaptive" : "deterministic",
        judgeMode: context.modelProfileId ? "adaptive" : "deterministic",
        modelProfileId: context.modelProfileId,
        permissionProfile,
        executionMode: "oci",
        capabilities: ["browser"]
      }
    })
  });
}

export function approveRunPlan(runId: string, expectedVersion: number) {
  return request<{ run: RunProjection }>(`/v1/runs/${encodeURIComponent(runId)}/plan-approval`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, actor: "workbench-user", idempotencyKey: `workbench:${runId}:plan:${expectedVersion}` })
  });
}

export function grantRunPermissions(runId: string, expectedVersion: number) {
  return request<{ run: RunProjection }>(`/v1/runs/${encodeURIComponent(runId)}/permissions`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, actor: "workbench-user", idempotencyKey: `workbench:${runId}:permission:${expectedVersion}` })
  });
}

export async function waitForRunReport(runId: string) {
  let run = (await getRunProjection(runId)).run;
  const terminal = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);
  const deadline = Date.now() + 20 * 60_000;
  while (!terminal.has(run.state)) {
    if (Date.now() > deadline) throw new Error("run_wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, 750));
    run = (await getRunProjection(runId)).run;
  }
  if (run.state === "cancelled") throw new Error("run_cancelled");
  return (await request<{ report: RunResult }>(`/v1/runs/${encodeURIComponent(runId)}/report`)).report;
}

export function getRunProjection(runId: string) {
  return request<{ run: RunProjection }>(`/v1/runs/${encodeURIComponent(runId)}`);
}

export function controlRun(
  runId: string,
  action: "pause" | "resume" | "cancel" | "decision-override",
  input: { expectedVersion: number; payload?: Record<string, unknown> }
) {
  return request<{ run: RunProjection }>(`/v1/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: input.expectedVersion,
      actor: "workbench-user",
      idempotencyKey: `workbench:${runId}:${action}:${input.expectedVersion}`,
      ...(input.payload ? { payload: input.payload } : {})
    })
  });
}

async function runThroughV1(payload: Record<string, unknown>, onCreated?: (runId: string) => void) {
  const idempotencyKey = crypto.randomUUID();
  let run = (await request<{ run: RunProjection }>("/v1/runs", {
    method: "POST",
    body: JSON.stringify({
      organizationId: "local",
      projectId: payload.projectId,
      actor: "workbench-user",
      idempotencyKey,
      input: {
        appUrl: payload.appUrl,
        scenarioId: payload.scenarioId,
        requirement: payload.requirement,
        diff: payload.diff,
        permissionProfile: payload.permissionProfile,
        executionMode: "oci",
        capabilities: ["browser"]
      }
    })
  })).run;
  onCreated?.(run.id);
  run = (await request<{ run: RunProjection }>(`/v1/runs/${run.id}/plan-approval`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "workbench-user", idempotencyKey: `${idempotencyKey}:plan` }) })).run;
  run = (await request<{ run: RunProjection }>(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "workbench-user", idempotencyKey: `${idempotencyKey}:permission` }) })).run;
  return waitForRunReport(run.id);
}

export function subscribeRunEvents(runId: string, onEvent: (event: { id?: string; type: string; payload: Record<string, unknown> }) => void) {
  const controller = new AbortController();
  let lastEventId: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  const connect = async () => {
    try {
      const headers = new Headers(AGENT_TOKEN ? { "x-agent-token": AGENT_TOKEN } : {});
      if (lastEventId) headers.set("last-event-id", lastEventId);
      const response = await fetch(`${AGENT_URL}/v1/runs/${encodeURIComponent(runId)}/stream`, {
        credentials: "include", headers, signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`stream_http_${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const eventType = frame.match(/^event: (.+)$/m)?.[1] ?? "message";
          const eventId = frame.match(/^id: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (!data) continue;
          if (eventId) lastEventId = eventId;
          onEvent({ id: eventId, type: eventType, payload: JSON.parse(data) as Record<string, unknown> });
          reconnectAttempt = 0;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.warn("run stream closed", error);
    }
    if (!controller.signal.aborted) {
      const delay = Math.min(5_000, 250 * 2 ** reconnectAttempt++);
      retryTimer = setTimeout(() => void connect(), delay);
    }
  };
  void connect();
  return () => { if (retryTimer) clearTimeout(retryTimer); controller.abort(); };
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

export function probeScenarioDraft(id: string, credentialId?: string) {
  return request<{ draft: HarnessGapScenarioDraft }>(`/api/scenario-drafts/${id}/probe`, {
    method: "POST",
    body: JSON.stringify(credentialId ? { credentialId } : {})
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

export function getProjectRuntime(projectId: string) {
  return request<{ runtime: ProjectRuntimeStatus }>(`/api/projects/${projectId}/runtime`);
}

export function saveProject(payload: ProjectConfig) {
  return request<{ project: ProjectConfig }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function saveProjectLoginCredential(id: string, payload: {
  username: string;
  password: string;
  usernameEnv: string;
  passwordEnv: string;
}) {
  return request<{
    project: ProjectConfig;
    credential: { id: string; projectId: string; usernameMasked: string; updatedAt: string };
  }>(`/api/projects/${id}/login-credential`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function bindProjectApiCredential(id: string, payload: {
  envName: string;
  credentialId: string;
  source: "test-system" | "dedicated";
  baseUrlEnv?: string;
  modelEnv?: string;
}) {
  return request<{
    project: ProjectConfig;
    binding: NonNullable<ProjectConfig["apiCredentialBindings"]>[number];
    credential: {
      id: string;
      name: string;
      provider: string;
      model: string;
      apiKeyMasked: string;
    };
  }>(`/api/projects/${id}/api-credential-binding`, {
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

export function chooseProjectFolder() {
  return request<{
    selection:
      | { status: "selected"; projectPath: string; rootName: string }
      | { status: "cancelled" }
      | { status: "unsupported"; reason: string };
  }>("/api/projects/choose-folder", { method: "POST" });
}

export function listProjectDirectory(payload: { projectPath: string; relativePath?: string }) {
  return request<{
    entries: Array<{
      name: string;
      relativePath: string;
      kind: "directory" | "file";
    }>;
  }>("/api/projects/list-directory", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function detectProjectManifest(payload: {
  rootName: string;
  files: Array<{ relativePath: string; content?: string }>;
}) {
  return request<{ detection: ProjectDetectionResult }>("/api/projects/detect-manifest", {
    method: "POST",
    body: JSON.stringify(payload)
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

export async function startProjectAsync(id: string) {
  // start-async is idempotent on the Agent side. Retrying this one POST is
  // safe and prevents a dev-server hot reload from looking like a button that
  // did nothing to the person using the Workbench.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await waitForAgentReady(4_000);
      return await request<{ accepted: boolean; runtime: ProjectRuntimeStatus }>(`/api/projects/${id}/start-async`, { method: "POST" });
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("AI 测试服务暂时不可用，请稍候重试。");
}

export function getAiStartRecovery(id: string, credentialId?: string) {
  return request<{ advice: RuntimeRecoveryAdvice }>(`/api/projects/${id}/ai-start-recovery`, {
    method: "POST",
    body: JSON.stringify({ credentialId })
  });
}

export function getProjectRecovery(id: string) {
  return request<{ recovery: ProjectRecoveryResult }>(`/api/projects/${encodeURIComponent(id)}/recovery`);
}

export function recoverAndRetryProject(
  id: string,
  mode: "auto" | "runtime" | "discovery" = "auto",
  credentialId?: string
) {
  return request<{ accepted: boolean; recovery: ProjectRecoveryResult }>(`/api/projects/${encodeURIComponent(id)}/recover-and-retry`, {
    method: "POST",
    body: JSON.stringify({ mode, credentialId })
  });
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

export function runDiscoveryScan(payload: RunTargetPayload & {
  sourceContexts?: unknown[];
  goal?: string;
  credentialId?: string;
}) {
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

export function getRunEvidence(runId: string) {
  return request<{
    evidence: RunResult["evidence"];
    loopEvents: RunResult["loopEvents"];
  }>(`/api/runs/${runId}/evidence`);
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
    headers: AGENT_TOKEN ? { "x-agent-token": AGENT_TOKEN } : {}
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.blob();
}
