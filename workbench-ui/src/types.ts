export interface Credential {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  tags: string[];
  owner?: string;
  scopes?: string[];
  isDefault: boolean;
  lastUsedAt?: string;
  rotationHistory?: Array<{
    rotatedAt: string;
    apiKeyMasked: string;
    reason?: string;
  }>;
}

export interface GrayPlan {
  sessionName: string;
  risks: Array<{ id: string; level: string; title: string; evidence: string }>;
  levels: Array<{
    id: string;
    title: string;
    description: string;
    paths: Array<{
      id: string;
      title: string;
      riskReason: string;
      expectedFrom: string;
      steps: string[];
    }>;
  }>;
}

export interface PermissionProfile {
  observe: boolean;
  browserControl: boolean;
  sourceRead?: boolean;
  sandboxWrite?: boolean;
  sandboxCommand?: boolean;
  networkInstall?: boolean;
  hostApply?: boolean;
  artifactExport?: boolean;
  workspaceControl: boolean;
  ideTerminalControl: boolean;
  systemControl: boolean;
}

export interface RunProjection {
  id: string;
  state: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  input?: Record<string, unknown>;
  gateStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  finalStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  executionStatus?: "running" | "waiting-user" | "completed" | "completed-with-gaps" | "cancelled" | "infrastructure-failed";
  humanDecision?: { status: string; reason: string; newLabel?: string };
}

export interface LlmInvocation {
  id: string;
  purpose: "planning" | "browser-action" | "judging" | "triage" | "repairing" | "assistant";
  provider: string;
  model: string;
  requestedModel?: string;
  returnedModel?: string;
  promptVersion?: string;
  graphVersion?: string;
  routeReason?: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  status: "passed" | "failed" | "blocked";
  errorCode?: string;
  failureClass?: string;
  transportMode?: string;
  fallbackReason?: string;
  fallbackImpact?: string;
  finalStatusImpact?: string;
  usage: {
    promptTokens?: number;
    cachedPromptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number | null;
    currency?: string;
    priceCatalogVersion?: string;
  };
  transportAttempts?: Array<{ attempt: number; mode: string; status: string; durationMs: number; errorCode?: string }>;
  semanticRepairAttempts?: Array<{ attempt: number; status: string; durationMs: number; validationErrors: string[] }>;
}

export interface Conclusion {
  conclusionId: string;
  runId: string;
  scenarioId: string;
  attemptId: string;
  claimType: string;
  status: string;
  source: "deterministic" | "llm-advisory" | "human";
  assertionIds: string[];
  evidenceRefs: string[];
  proofStatus: "verified" | "missing" | "invalid" | "legacy-unverified";
  policyVersion: string;
}

export interface ProofEdge {
  id: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
}

export interface CoverageItem {
  id: string;
  flowId: string;
  module: string;
  surface: string;
  risk: string;
  disposition: "pending" | "binding" | "executing" | "executed" | "failed" | "blocked" | "excluded";
  dispositionReason?: string;
}

export interface RunResult {
  id: string;
  executionStatus?: "running" | "waiting-user" | "completed" | "completed-with-gaps" | "cancelled" | "infrastructure-failed";
  releaseRecommendation?: {
    decision: "可以发布" | "不建议发布" | "有条件发布" | "无法判断，需要补充条件";
    reason: string;
  };
  scenarioFingerprint?: string;
  verdict: "continue" | "hold_for_review" | "stop_and_fix";
  summary: string;
  gateStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  finalStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  machineGate?: {
    status: "pass" | "fail" | "blocked" | "needs-human-review";
    reasons: string[];
    reasonDetails?: Array<{
      code: string;
      summary: string;
      evidenceRefs: string[];
    }>;
    assertionFailures: string[];
    evidenceComplete: boolean;
  };
  attempts?: Array<{
    id: string;
    attempt: number;
    status: "running" | "passed" | "failed" | "blocked" | "cancelled";
    startedAt: string;
    finishedAt?: string;
    retryReason?: string;
    artifactIds: string[];
  }>;
  artifactsV2?: Array<{
    id: string;
    schemaVersion: "2.0";
    runId: string;
    scenarioId: string;
    stepId?: string;
    attemptId: string;
    attempt: number;
    kind: string;
    origin: "runtime-captured" | "fixture" | "simulated" | "user-uploaded" | "legacy-unverified" | "agent-generated";
    storageUri: string;
    replicaUris: string[];
    integrity: { sha256: string; sizeBytes: number; mediaType: string; capturedAt: string; collector: { name: string; version: string } };
  }>;
  steps: Array<{
    stepId: string;
    title: string;
    status: "passed" | "failed" | "warning";
    action: string;
    screenshot?: string;
    details: string;
  }>;
  network: Array<{ method: string; url: string; status?: number }>;
  console: Array<{ type: string; text: string }>;
  assertions: Array<{
    name: string;
    passed: boolean;
    expected: string;
    actual: string;
    fact?: {
      kind: string;
      target: string;
      operator: string;
      expected: string;
      actual: string;
      severity: string;
      evidenceRefs: string[];
      failureClass?: string;
    };
  }>;
  evidence: Array<{
    id: string;
    type: string;
    title: string;
    file?: string;
    locator?: {
      pageUrl?: string;
      selector?: string;
      testId?: string;
      requestId?: string;
      method?: string;
      statusCode?: number;
      lineStart?: number;
      lineEnd?: number;
      sourceLocation?: string;
      exitCode?: number;
      snapshotSha256?: string;
    };
    payload: Record<string, unknown>;
  }>;
  loopEvents: Array<{
    id: string;
    loopType: string;
    iteration: number;
    timestamp: string;
    status: string;
    title: string;
    action?: string;
    observation?: string;
    decision?: string;
    decisionReason?: string;
    evidenceRefs: string[];
  }>;
  riskCoverageMatrix: Array<{
    riskId: string;
    riskTitle: string;
    covered: boolean;
    passed: boolean;
    pathIds: string[];
    evidenceRefs: string[];
    notes: string;
  }>;
  aggregatedVerdict: {
    runCount: number;
    failedAssertionCount: number;
    flaky: boolean;
    verdict: string;
    reason: string;
  };
  reflectionNote: string;
  conflictPacket: {
    status: string;
    reason: string;
    evidenceRefs: string[];
  };
  failureAttributions: FailureAttribution[];
  executionError?: {
    code: "action_binding_failure" | "browser_runtime_failure" | "environment_failure" | "execution_failure";
    stepId?: string;
    message: string;
    failureClass: "test_script_issue" | "environment_issue" | "unknown";
  };
  runtimeStatus?: ProjectRuntimeStatus;
  judgeReport: LayeredJudgeReport;
  reportFile: string;
  markdownReportFile?: string;
  htmlReportFile?: string;
  runBundleFile: string;
  artifactIntegrityReportFile?: string;
  artifactIntegrity?: ArtifactIntegrityReport;
  coverageItems?: CoverageItem[];
  conclusions?: Conclusion[];
  proofEdges?: ProofEdge[];
  evidenceManifest?: {
    evidenceSetRoot: string;
    integrityStatus: "verified" | "unsigned" | "integrity-invalid";
    generatedAt: string;
  };
}

export interface RunBundle {
  runId: string;
  startedAt: string;
  finishedAt: string;
  result: Omit<RunResult, "evidence" | "loopEvents" | "riskCoverageMatrix">;
  evidence: RunResult["evidence"];
  loopEvents: RunResult["loopEvents"];
  riskCoverageMatrix: RunResult["riskCoverageMatrix"];
  failureAttributions?: FailureAttribution[];
  runtimeStatus?: ProjectRuntimeStatus;
  artifactIntegrity?: ArtifactIntegrityReport;
  coverageItems?: CoverageItem[];
  conclusions?: Conclusion[];
  proofEdges?: ProofEdge[];
}

export interface LiveRunState {
  runId?: string;
  status: "idle" | "running" | "finished";
  latestScreenshot?: string;
  latestEvent?: RunResult["loopEvents"][number];
  evidenceCount: number;
  events: RunResult["loopEvents"];
  evidence: RunResult["evidence"];
}

export interface IntakeAnalysis {
  id: string;
  createdAt: string;
  sources: Array<{
    kind: string;
    title: string;
    status: string;
    summary: string;
  }>;
  sourceContexts?: SourceReadEnvelope[];
  impactAnalysis?: ImpactAnalysis;
  changedAreas: string[];
  risks: Array<{ id: string; level: string; title: string; evidence: string }>;
  scenarioCandidates: Array<{
    id: string;
    title: string;
    source: string;
    riskLevel: string;
    reason: string;
    executable: boolean;
    mappedScenarioId?: string;
    requiredCapabilities: string[];
  }>;
  recommendedTrigger: string;
}

export interface PlanningMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  reasoningSummary?: {
    phase: "observing" | "diagnosing" | "planning" | "waiting-user" | "acting" | "completed";
    observations: string[];
    assessment: string;
    nextStep: string;
    userAction: string;
    confidence: "high" | "medium" | "low";
  };
  knowledge?: {
    schemaVersion: "2.0";
    factsUsed: string[];
    inferences: Array<{ statement: string; sourceClaimIds: string[] }>;
    assumptions: Array<{ statement: string; risk: "low" | "medium" | "high" }>;
    unknowns: string[];
    toolRequests: Array<{ tool: string; input: Record<string, unknown>; reason: string; sourceClaimIds: string[] }>;
    blockingQuestions: string[];
    proposedActions: Array<{ capability: string; reason: string; sourceClaimIds: string[]; requiresConfirmation: boolean }>;
  };
  llmTrace?: {
    callId: string;
    model?: string;
    provider?: string;
    status?: string;
    durationMs?: number;
    totalTokens?: number;
    semanticRepairApplied?: boolean;
    fallbackApplied?: boolean;
    errorCode?: string;
    contextId?: string;
    decisionId?: string;
    validationStatus?: string;
  };
  suggestedAction?: AssistantSuggestedAction;
  requiresConfirmation?: boolean;
  /** A durable assistant activity row that is updated in place while the
   * Graph is still working. This is presentation state only; terminal truth
   * continues to come from the Run/Graph projection. */
  streaming?: boolean;
  /** Structured, owner-aware repair plan surfaced from the failure-attribution
   * + repair-decision chain, rendered by RepairPlanPanel. */
  repairPlan?: RepairPlanData;
}

export interface RepairPlanData {
  owner: "agent" | "user" | "environment" | "developer" | string;
  problem?: string;
  steps: string[];
  validation: string;
  message?: string;
  /** `RepairActionType` that produced this plan. Drives the executable action. */
  type?: string;
  /** Whether the agent may act without a human. */
  executable?: boolean;
  /** Persisted `repair_plans_v1.id`, so an action can be attributed and audited. */
  planId?: string;
  runId?: string;
  attemptId?: string;
  scenarioId?: string;
  status?: "pending" | "applied" | "resolved" | "dismissed" | string;
  /** Evidence ids the plan was derived from; rendered as "看证据" affordances. */
  evidenceRefs?: string[];
  policyVersion?: string;
  /** The concrete workbench action the user can execute from this plan. */
  action?: Exclude<AssistantSuggestedAction, "none">;
}

/** Lifecycle of the action button rendered inside `RepairPlanPanel`. */
export interface RepairPlanActionStatus {
  planId?: string;
  state: "idle" | "running" | "done" | "error";
  message?: string;
}

export type AssistantSuggestedAction =
  | "none"
  | "revise-plan"
  | "start-run"
  | "pause-run"
  | "resume-run"
  | "cancel-run"
  | "resume-interrupt"
  | "create-repair"
  | "retry-runtime"
  | "retry-discovery"
  | "retry-failed-path"
  | "continue-safe-paths"
  // Owner=user credential failures: retrying is useless until an account is
  // bound, so the assistant offers the credential form instead.
  | "configure-credentials"
  | "open-evidence";

export interface PlannedBusinessFlow {
  id: string;
  title: string;
  kind: "page" | "component" | "api" | "scenario" | "data" | "background-task";
  target: string;
  status: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
  confidence: "high" | "medium" | "low";
  reason: string;
  scenarioId?: string;
  requiredInformation: string[];
  sourceNodeIds?: string[];
  sourceCount?: number;
  pathVersion?: "2.0";
  summary?: string;
  surfaces?: Array<"page" | "api" | "data" | "background-task">;
  risk?: "low" | "medium" | "high";
  roles?: string[];
  actionCandidates?: string[];
  oracleCandidates?: string[];
  requiredEvidenceKinds?: string[];
  sourceLocations?: Array<{
    file: string;
    line?: number;
    parser: string;
    sourceHash: string;
  }>;
}

export interface PlanningConversationResult {
  id: string;
  phase: "clarifying" | "draft-ready";
  reply: string;
  clarificationQuestions: string[];
  businessFlows: PlannedBusinessFlow[];
  businessFunctions?: BusinessFunction[];
  projectOverview?: ProjectOverview;
  businessFunctionCount?: number;
  technicalPathCount?: number;
  businessFunctionSnapshotHash?: string;
  businessFunctionConfidence?: BusinessFunction["confidence"];
  businessFunctionPage?: {
    cursor?: string;
    nextCursor?: string;
    total: number;
    limit: number;
  };
  businessFlowPage?: {
    cursor?: string;
    nextCursor?: string;
    total: number;
    limit: number;
  };
  coverage: {
    discovered: number;
    executable: number;
    autoBindable: number;
    needsInput: number;
    gaps: number;
    sourceCandidates?: number;
    confidence: "high" | "medium" | "low";
    scope: "targeted" | "comprehensive";
  };
  plan: GrayPlan;
  analysis: IntakeAnalysis;
  businessGraph?: {
    version: "2.0";
    sourceFileCount: number;
    projectSnapshotHash: string;
    diagnostics: string[];
  };
  recommendedScenarioId?: string;
  llmPlanning?: {
    status: "not_configured" | "passed" | "failed";
    summary?: string;
    prioritizedFlowIds: string[];
    clarificationQuestions: string[];
    model?: string;
    callId?: string;
    durationMs?: number;
    errorCode?: string;
  };
}

export interface BusinessFunction {
  id: string;
  name: string;
  purpose: string;
  roles: string[];
  risk: "low" | "medium" | "high";
  status: "ready" | "needs-confirmation" | "blocked" | "unknown";
  confidence: "high" | "medium" | "low";
  pathIds: string[];
  sourceLocations: Array<{ file: string; line?: number; parser: string; sourceHash: string }>;
  evidenceRefs: string[];
  technicalPathCount: number;
  branchCount: number;
  summary: string;
}

export interface ProjectOverview {
  purpose: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: string[];
  businessFunctionCount: number;
  technicalPathCount: number;
  sourceCandidateCount: number;
  unknownCount: number;
  statusCounts?: {
    ready: number;
    "needs-confirmation": number;
    blocked: number;
    unknown: number;
  };
  snapshotHash?: string;
}

export interface HarnessGap {
  id: string;
  createdAt: string;
  source: string;
  requirementSummary: string;
  missingScenarioTitle: string;
  requiredCapabilities: string[];
  suggestedOracle: string;
  suggestedSteps: string[];
  status: "open" | "implemented" | "dismissed";
  relatedAnalysisId?: string;
  relatedRunId?: string;
  relatedCheckId?: string;
}

export interface HarnessGapScenarioDraft {
  gapId: string;
  createdAt: string;
  scenarioId: string;
  draftReviewStatus?: "draft" | "approved" | "rejected";
  selectorProbeStatus?: "not_run" | "passed" | "failed";
  riskKind?: string;
  selectors?: Record<string, unknown>;
  actions?: string[];
  oracles?: Array<Record<string, unknown>>;
  evidenceRequirements?: string[];
  missingInfo?: string[];
  probeTrace?: {
    navigationUrl?: string;
    action?: string;
    actionExecuted: boolean;
    actionError?: string;
    observedHeadings: string[];
    observedButtons: string[];
    observedTestIds: string[];
    responseUrls: string[];
    postActionUrl?: string;
  };
  repairAttempts?: Array<{
    attempt: number;
    strategy: "deterministic" | "llm-assisted";
    status: "repaired" | "not-repairable" | "failed";
    changedFields: string[];
    reason: string;
    at: string;
    model?: string;
    callId?: string;
  }>;
  probeUrl?: string;
  scenarioFile?: string;
  installedFile?: string;
  scenario: Record<string, unknown>;
}

export interface ScenarioSummary {
  id: string;
  title: string;
  summary?: string;
  capabilityKind?: string;
  genericTemplate?: boolean;
  planObservation: string;
  matcher?: {
    keywords: string[];
    riskLevel: string;
    sourceHints: string[];
    capabilities: string[];
  };
  corePath?: {
    action: string;
    pathId: string;
    title: string;
    oracleCount: number;
  };
}

export interface ConnectorContext {
  requirement: string;
  diff: string;
  bugTicket: string;
  prUrl?: string;
  prMeta?: {
    provider: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
    changedFiles: string[];
    linkedIssues: Array<{ number: number; title?: string; body?: string }>;
  };
  sourceContexts?: SourceReadEnvelope[];
  sources: IntakeAnalysis["sources"];
}

export interface JudgeFinding {
  id: string;
  severity: string;
  failureClass?: string;
  title: string;
  reasoning: string;
  evidenceRefs: string[];
}

export interface JudgeResult {
  layer: string;
  title: string;
  verdict: string;
  summary: string;
  findings: JudgeFinding[];
}

export interface LayeredJudgeReport {
  source: string;
  executionMode: string;
  llmStatus: string;
  llmError?: string;
  policyVersion: string;
  createdAt: string;
  planJudge: JudgeResult;
  evidenceJudge: JudgeResult;
  releaseJudge: JudgeResult;
}

export interface AuditStoreStatus {
  database: string;
  schemaVersion: number;
  userVersion?: number;
  schemaVersionMatches?: boolean;
  migrations?: Array<{
    version: number;
    appliedAt: string;
    description: string;
  }>;
  expectedMigrationVersions?: number[];
  missingMigrations?: number[];
  migrationComplete?: boolean;
  integrityCheck?: string;
  integrityOk?: boolean;
  runs: number;
  evidence: number;
  events: number;
  journalMode: string;
}

export interface PlatformCapability {
  id: string;
  title: string;
  status: string;
  purpose: string;
  demoAction: string;
}

export interface BotDelivery {
  id: string;
  createdAt: string;
  provider?: "wecom" | "feishu" | "slack" | "github_pr_comment" | "generic" | "simulated";
  channel: string;
  recipients: string[];
  title: string;
  body: string;
  runId?: string;
  evidenceRefs: string[];
  screenshotRefs?: string[];
  reportUrl?: string;
  blockedRelease?: boolean;
  topSuspects?: Array<{
    title: string;
    confidence: string;
    suggestedFix: string;
  }>;
  payloadSummary?: string;
  status: string;
  httpStatus?: number;
  error?: string;
}

export interface PatrolJob {
  id: string;
  title: string;
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  scenarioId: string;
  intervalMs: number;
  cron?: string;
  notify: string[];
  permissionProfile: PermissionProfile;
  status: string;
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
  };
  escalationPolicy?: {
    failureThreshold: number;
    riskTrendThreshold: "regressed" | "stable" | "any";
    notify: string[];
  };
  consecutiveFailures?: number;
  riskTrend?: "first_run" | "improved" | "regressed" | "stable";
  lastRunId?: string;
  lastDeliveryId?: string;
  lastPatrolFile?: string;
  lastError?: string;
  nextRunAt?: string;
}

export interface PatrolRunResult {
  id: string;
  createdAt: string;
  jobId?: string;
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  scenarioId?: string;
  notify?: string[];
  permissionProfile: PermissionProfile;
  run: RunResult;
  delivery: BotDelivery;
  patrolFile?: string;
}

export interface CommitCheckResult {
  id: string;
  createdAt: string;
  context: ConnectorContext;
  analysis: IntakeAnalysis;
  plan: GrayPlan;
  executablePlan?: ExecutableTestPlan;
  planSource: string;
  selectedScenarioId?: string;
  harnessGaps?: HarnessGap[];
  run?: RunResult;
  delivery?: BotDelivery;
  skippedReason?: string;
  commitCheckFile?: string;
}

export interface RequirementAcceptanceResult {
  id: string;
  createdAt: string;
  context: ConnectorContext;
  analysis: IntakeAnalysis;
  plan: GrayPlan;
  executablePlan?: ExecutableTestPlan;
  planSource: string;
  selectedScenarioId?: string;
  harnessGaps?: HarnessGap[];
  run?: RunResult;
  delivery?: BotDelivery;
  skippedReason?: string;
  acceptanceFile?: string;
}

export interface DemoVerificationResult {
  id: string;
  createdAt: string;
  ok: boolean;
  checks: Array<{
    id: string;
    title: string;
    status: "passed" | "failed";
    details: string;
    artifact?: string;
  }>;
  artifacts: Record<string, string>;
  demoVerificationFile?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  projectPath: string;
  allowExternalProjectPath?: boolean;
  installCommand?: string;
  installCommandSpec?: {
    executable: string;
    args: string[];
    timeoutMs?: number;
  };
  startCommand?: string;
  startCommandSpec?: {
    executable: string;
    args: string[];
    timeoutMs?: number;
  };
  processes?: Array<{
    name: string;
    command: string;
    commandSpec?: {
      executable: string;
      args: string[];
      timeoutMs?: number;
    };
    healthCheckUrl?: string;
    required?: boolean;
  }>;
  healthCheckUrl?: string;
  frontendUrl: string;
  backendUrl?: string;
  login?: {
    method: "none" | "form" | "storage_state" | "env";
    usernameEnv?: string;
    passwordEnv?: string;
    credentialId?: string;
    loginUrl?: string;
  };
  apiCredentialRequirements?: Array<{
    envName: string;
    providerHint?: string;
    baseUrlEnv?: string;
    modelEnv?: string;
    exposure: "server" | "browser";
    signals: string[];
  }>;
  apiCredentialBindings?: Array<{
    envName: string;
    credentialId: string;
    source: "test-system" | "dedicated";
    baseUrlEnv?: string;
    modelEnv?: string;
    configuredAt: string;
  }>;
  env?: Record<string, string>;
  cleanupCommand?: string;
  manifest?: {
    schemaVersion: "1.0";
    projectId: string;
    workspaceRoot: string;
    commands: Record<string, { executable: string; args: string[]; timeoutMs?: number } | undefined>;
    commandAllowlist: string[];
    ports: Array<{ name: string; env: string; purpose: "frontend" | "backend" | "health" | "auxiliary" }>;
    healthCheck?: { path: string; timeoutMs: number };
    environmentAllowlist: string[];
    network: { mode: "deny" | "allow-target" | "allowlist"; allowedHosts: string[] };
    fixtures: Array<{ id: string; path: string; sha256: string; destructive: boolean }>;
    capabilities: { browser: boolean; desktop: boolean; allowedBundleIds: string[] };
    execution: { mode: "oci" | "trusted-local"; image?: string; engine: "docker" | "podman" };
    budget: {
      runTimeoutMs: number;
      prepareTimeoutMs: number;
      scenarioTimeoutMs: number;
      stepTimeoutMs: number;
      maxSteps: number;
      maxAttempts: number;
      maxScreenshots: number;
      maxVideoBytes: number;
      maxLogBytes: number;
      maxArtifactBytes: number;
      maxConcurrency: number;
    };
  };
  timeoutMs?: number;
  externalSmokeProfile?: {
    login?: {
      usernameEnv?: string;
      passwordEnv?: string;
      expectedText?: string;
    };
    keyPages?: Array<{ id: string; path: string; expectedHeading?: string }>;
    form?: {
      path?: string;
      inputLabel: string;
      inputValue: string;
      submitButton: string;
      expectedText: string;
    };
    table?: {
      path?: string;
      sortButton?: string;
      filterLabel?: string;
      filterValue?: string;
      nextButton?: string;
      expectedText: string;
    };
    permission?: {
      roleControlLabel?: string;
      roleValue?: string;
      expectedText: string;
    };
    apiSteps?: Array<{
      id: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      expectedStatus?: number;
      requiresAuth?: boolean;
    }>;
    browserSteps?: Array<{
      id: string;
      action: "click" | "fill" | "upload" | "assert_text";
      label?: string;
      value?: string;
      expectedText?: string;
    }>;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectDetectionResult {
  projectPath: string;
  exists: boolean;
  detectionSource?: "filesystem" | "browser-manifest";
  executionReady?: boolean;
  detectedStack: Array<
    "node" | "react" | "vue" | "svelte" | "typescript" | "tailwind"
    | "vite" | "next" | "nuxt" | "astro" | "angular" | "remix" | "express"
    | "python" | "fastapi" | "django" | "flask" | "streamlit" | "gradio"
    | "static" | "go" | "rust" | "java" | "spring" | "ruby" | "rails"
    | "php" | "laravel" | "unknown"
  >;
  packageManagers: Array<"npm" | "pnpm" | "yarn" | "pip" | "uv" | "poetry">;
  loginCapability?: {
    detected: boolean;
    confidence: "high" | "medium" | "none";
    signals: string[];
    usernameEnv?: string;
    passwordEnv?: string;
  };
  apiCredentialCapability?: {
    detected: boolean;
    requirements: NonNullable<ProjectConfig["apiCredentialRequirements"]>;
  };
  suggestedConfig: ProjectConfig;
  ports: Array<{
    port: number;
    purpose: "frontend" | "backend" | "health" | "unknown";
    status: "available" | "listening" | "unknown";
    url: string;
  }>;
  healthCandidates: string[];
  warnings: string[];
  plainLanguageFixes: string[];
}

export interface ProjectDiagnosis {
  projectId: string;
  checkedAt: string;
  overallStatus: "passed" | "failed" | "warning";
  stages: Array<{
    stage: "path" | "install" | "start" | "health" | "frontend" | "backend" | "credential" | "ports";
    status: "passed" | "failed" | "warning" | "skipped";
    reason: string;
    humanMessage: string;
    suggestedCommands: string[];
    portConflicts?: Array<{ port: number; process?: string; fix: string }>;
    missingEnv?: string[];
  }>;
}

export interface TargetAppRuntime {
  projectId?: string;
  frontendUrl: string;
  backendUrl?: string;
  healthCheckUrl?: string;
}

export interface ProjectHealthCheckResult {
  projectId: string;
  ok: boolean;
  status: "passed" | "failed";
  reason: string;
  credential: {
    ok: boolean;
    method: "none" | "form" | "storage_state" | "env";
    credentialId?: string;
    missingEnv: string[];
  };
  apiCredential: {
    ok: boolean;
    requirements: Array<{
      envName: string;
      configured: boolean;
      credentialId?: string;
      source?: "test-system" | "dedicated";
      exposure: "server" | "browser";
    }>;
    missingEnv: string[];
  };
  frontend?: { ok: boolean; status?: number; url: string; error?: string };
  backend?: { ok: boolean; status?: number; url: string; error?: string };
  health?: { ok: boolean; status?: number; url: string; error?: string };
  processHealth?: Array<{
    name: string;
    required: boolean;
    ok: boolean;
    status?: number;
    url?: string;
    error?: string;
  }>;
  checkedAt: string;
  durationMs: number;
  message: string;
}

export interface ProjectRuntimeStatus {
  projectId: string;
  status: "idle" | "installing" | "starting" | "running" | "failed" | "stopped";
  phase?: "idle" | "installing_dependencies" | "starting_processes" | "waiting_for_health" | "ready" | "stopping" | "failed";
  phaseStartedAt?: string;
  deadlineAt?: string;
  elapsedMs?: number;
  remainingMs?: number;
  progressPercent?: number;
  updatedAt?: string;
  pid?: number;
  processes?: Array<{
    name: string;
    pid?: number;
    status: "starting" | "running" | "stopped" | "failed";
    healthCheckUrl?: string;
    required: boolean;
    failureReason?: string;
    message: string;
  }>;
  startedAt?: string;
  stoppedAt?: string;
  frontendUrl?: string;
  backendUrl?: string;
  healthCheckUrl?: string;
  failureReason?: string;
  message?: string;
}

export type ProjectRecoveryAction = "retry-runtime" | "retry-discovery" | "retry-path" | "create-repair" | "unavailable";
export type ProjectRecoveryStatus = "accepted" | "running" | "completed" | "blocked" | "failed";

export interface ProjectRecoveryEvent {
  phase: "docker_launching" | "daemon_waiting" | "sandbox_starting" | "health_checking" | "discovery_retrying" | "completed" | "blocked";
  message: string;
  at: string;
}

export interface ProjectRecoveryResult {
  recoveryId: string;
  projectId: string;
  action: ProjectRecoveryAction;
  status: ProjectRecoveryStatus;
  sourceError?: string;
  runtime: ProjectRuntimeStatus;
  events: ProjectRecoveryEvent[];
  discovery?: DiscoveryScanResult;
  /** Model advice is informative only. Applying a candidate remains an
   * explicit user action and is constrained by the local command allowlist. */
  advice?: RuntimeRecoveryAdvice;
  userAction: string;
  updatedAt: string;
}

export interface RuntimeRecoveryAdvice {
  status: "not_configured" | "passed" | "failed";
  summary?: string;
  failureClass?: "configuration" | "dependency" | "port" | "runtime" | "environment" | "unknown";
  selectedCandidateId?: string;
  nextStep?: "retry_current" | "use_candidate" | "repair_dependencies" | "ask_user";
  model?: string;
  callId?: string;
  durationMs?: number;
  errorCode?: string;
  candidates: Array<{ id: string; label: string; command: string; frontendUrl?: string }>;
}

export interface SourceReadEnvelope {
  id: string;
  kind: string;
  title: string;
  uri?: string;
  status: "connected" | "simulated" | "missing";
  summary: string;
  failureReason?: string;
  permissionState: string;
  isSimulated: boolean;
  contentHash?: string;
  readAt: string;
  trustLevel: "high" | "medium" | "low";
  evidenceUse?: "planning" | "oracle" | "audit" | "ignored";
  displayStatus?: "ready" | "simulated" | "missing" | "permission_denied" | "stale" | "failed";
  plainLanguageSummary?: string;
  readMeta?: {
    attempts?: number;
    cacheStatus?: "hit" | "miss" | "stale" | "bypass";
    httpStatus?: number;
    finalUrl?: string;
    rateLimit?: {
      limit?: number;
      remaining?: number;
      resetAt?: string;
      retryAfterMs?: number;
    };
    pagination?: {
      pagesRead: number;
      hasMore: boolean;
      itemCount?: number;
    };
    documentVersion?: string;
    openApi?: {
      title?: string;
      version?: string;
      operationCount: number;
      operations: Array<{
        method: string;
        path: string;
        operationId?: string;
        summary?: string;
        tags?: string[];
      }>;
    };
  };
}

export interface ImpactAnalysis {
  id: string;
  createdAt: string;
  affectedPages: Array<{ id: string; kind: string; target: string; reason: string; confidence: string; sourceContextIds: string[] }>;
  affectedApis: Array<{ id: string; kind: string; target: string; reason: string; confidence: string; sourceContextIds: string[] }>;
  affectedComponents: Array<{ id: string; kind: string; target: string; reason: string; confidence: string; sourceContextIds: string[] }>;
  recommendedScenarios: Array<{ scenarioId: string; reason: string; confidence: string; sourceContextIds: string[] }>;
  uncoveredRisks: Array<{ id: string; title: string; reason: string; requiredCapabilities: string[]; sourceContextIds: string[] }>;
}

export interface ExecutableTestPlan {
  id: string;
  createdAt: string;
  source: string;
  status: string;
  plan: GrayPlan;
  steps: Array<{
    id: string;
    scenarioId: string;
    compileSource?: string;
    humanReviewRequired?: boolean;
    draftScenarioRef?: string;
    draftReviewStatus?: "draft" | "approved" | "rejected";
    selectorProbeStatus?: "not_run" | "passed" | "failed";
    capabilityKind?: string;
    title: string;
    preconditions: string[];
    browserActions: string[];
    selectorStrategy: Record<string, unknown>;
    assertions: string[];
    evidenceRequirements: string[];
    failurePolicy: Record<string, unknown>;
    retryPolicy: Record<string, unknown>;
  }>;
  rejectedSteps: Array<{
    title: string;
    reason: string;
    compileSource?: string;
    humanReviewRequired?: boolean;
    draftScenarioRef?: string;
    draftReviewStatus?: "draft" | "approved" | "rejected";
    selectorProbeStatus?: "not_run" | "passed" | "failed";
    capabilityKind?: string;
  }>;
}

export interface DiscoveryScanSuggestion {
  id: string;
  title: string;
  riskKind: "auth" | "form" | "table" | "navigation" | "api_contract" | "upload" | "state_change" | "unknown";
  reason: string;
  capabilityKind?: string;
  suggestedScenarioId: string;
  selectors: Record<string, unknown>;
  actions: string[];
  oracles: Array<Record<string, unknown>>;
  evidenceRequirements: string[];
  humanReviewRequired: boolean;
  draftScenarioRef?: string;
}

export interface DiscoveryPageObservation {
  requestedUrl: string;
  finalUrl: string;
  startedAt: string;
  capturedAt: string;
  durationMs: number;
  stage: "launch" | "navigation" | "dom-ready" | "snapshot" | "selection" | "completed";
  status: "ready" | "degraded" | "failed";
  navigation: {
    documentCommitted: boolean;
    httpStatus?: number;
    warning?: string;
  };
  document: {
    readyState?: string;
    bodyTextSample?: string;
    interactiveElementCount: number;
    viewport?: { width: number; height: number };
  };
  console: Array<{ type: string; text: string }>;
  pageErrors: string[];
  failedRequests: Array<{ method: string; url: string; failure?: string }>;
  screenshot?: { storageUri: string; capturedAt: string };
  diagnosis: {
    summary: string;
    likelyCauses: string[];
    retryable: boolean;
    userActionRequired: boolean;
  };
}

export interface DiscoveryScanResult {
  id: string;
  createdAt: string;
  target: TargetAppRuntime;
  page: {
    url: string;
    title?: string;
    headings: string[];
    links: Array<{ text: string; href: string }>;
    buttons: Array<{
      text: string;
      testId?: string;
      role?: string;
      title?: string;
      type?: string;
      nearInputLabel?: string;
      inputDistance?: number;
    }>;
    inputs: Array<{ label?: string; name?: string; type?: string; testId?: string }>;
    forms: Array<{ action?: string; method?: string; inputCount: number }>;
    testIds: string[];
  };
  networkEndpoints: Array<{ method: string; url: string; status?: number; path?: string; resourceType?: string }>;
  openApiOperations: Array<{ method: string; path: string; operationId?: string; summary?: string }>;
  observation: DiscoveryPageObservation;
  suggestions: DiscoveryScanSuggestion[];
  drafts: HarnessGapScenarioDraft[];
  recommendedScenarioId?: string;
  recommendedScenarioIds?: string[];
  selectionProvenance?: {
    mode: "deterministic" | "llm-assisted" | "deterministic-fallback";
    reason: string;
    llmStatus?: "not_configured" | "passed" | "failed";
    model?: string;
    callId?: string;
    errorCode?: string;
  };
  /** `waiting-auth` means the page loaded but is a login wall — a user action,
   * not a system failure. */
  status: "passed" | "partial" | "failed" | "waiting-auth";
  requiredAction?: "credential_required";
  message: string;
  orchestration?: {
    status: "waiting" | "ready" | "blocked" | "failed";
    checkedUrl: string;
    attempts: number;
    maxAttempts: number;
    discoveryAttempts: number;
    reason: string;
    retryable: boolean;
    runtimeStatus?: "idle" | "installing" | "starting" | "running" | "stopped" | "failed";
    httpStatus?: number;
  };
}

export interface FailureAttribution {
  id: string;
  rank: number;
  failureClass: string;
  title: string;
  reasoning: string;
  suggestedFix: string;
  reproductionSteps: string[];
  changeRefs?: Array<{
    file: string;
    hunk?: string;
    lineStart?: number;
    lineEnd?: number;
    matchedSignals?: string[];
    diagnosticSignals?: Array<{
      kind: string;
      value: string;
      reason: string;
      confidence: string;
    }>;
    addedLines?: Array<{ line: number; text: string }>;
    reason: string;
    confidence: string;
  }>;
  topSuspects?: Array<{
    filePath: string;
    lineStart?: number;
    lineEnd?: number;
    componentName?: string;
    apiEndpoint?: string;
    openApiOperationId?: string;
    domTestId?: string;
    reason: string;
    confidence: string;
    evidenceRefs: string[];
    sourceContextIds: string[];
    suggestedFix: string;
  }>;
  evidenceRefs: string[];
  sourceContextIds: string[];
  confidence: string;
}

export interface ArtifactIntegrityItem {
  id: string;
  artifactUri: string;
  kind: string;
  evidenceId?: string;
  status: "present" | "missing" | "unreadable" | "path_escape" | "self_reference" | "hash_mismatch";
  origin?: "runtime-captured" | "fixture" | "simulated" | "user-uploaded" | "legacy-unverified";
  sizeBytes?: number;
  sha256?: string;
  reason?: string;
}

export interface ArtifactIntegrityReport {
  id: string;
  runId: string;
  generatedAt: string;
  artifactRoot: "/artifacts";
  summary: {
    total: number;
    present: number;
    missing: number;
    unreadable: number;
    pathEscapes: number;
    selfReferences: number;
    hashMismatches: number;
    hashed: number;
  };
  items: ArtifactIntegrityItem[];
}

export interface RunBundleDownloadManifestEntry {
  artifactUri: string;
  archivePath?: string;
  kind: string;
  status: "included" | "missing" | "unreadable" | "path_escape" | "reference_only";
  sizeBytes?: number;
  sha256?: string;
  evidenceId?: string;
  reason?: string;
}

export interface RunBundleDownloadManifest {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  policy: {
    maxInlineBytes: number;
    largeArtifactPolicy: "reference_only";
  };
  entries: RunBundleDownloadManifestEntry[];
}

export interface RunHistoryEntry {
  runId: string;
  timestamp: string;
  verdict: string;
  failedAssertionCount: number;
  appUrl: string;
  projectId?: string;
  scenarioId?: string;
  scenarioFingerprint?: string;
  comparison?: {
    previousRunId?: string;
    previousVerdict?: string;
    previousFailedAssertionCount?: number;
    failureDelta: number;
    riskTrend: "first_run" | "improved" | "regressed" | "stable";
    judgeDecisionChanged: boolean;
    summary: string;
  };
}

export interface StorageStatus {
  reportsDir: string;
  archiveRoot: string;
  reportsBytes: number;
  archiveBytes: number;
  archiveCount?: number;
  maxReportsMb: number;
  budget?: {
    maxReportsBytes?: number;
    usedBytes: number;
    remainingBytes?: number;
    status: "over_budget" | "within_budget";
  };
  overBudget: boolean;
  retentionManifest?: Record<string, unknown>;
  lastRetentionResult?: Record<string, unknown>;
  activeLocks: Array<{ projectId: string; status: string; startedAt?: string }>;
}

export interface BenchmarkSummary {
  version: string;
  status: string;
  caseCount: number;
  blindCaseCount: number;
  projectCount: number;
  fixtureProjects: Array<{ logicalProjectId: string; executionProjectId: string; targetUrl?: string; targetKind?: string; splits: string[] }>;
  byProject: Record<string, number>;
  categories: string[];
  runtimeMetrics: {
    status: string;
    experimentId?: string;
    conclusion?: string;
    completedRuns: number;
    formalEligibleRuns?: number;
    plannedRuns: number;
    blockers: string[];
    displayedSplit?: "development" | "blind";
    acceptance?: { proven: boolean; reasons: string[] };
    provenance?: { kind?: string; rawRecordCount?: number; formalEligibleRecordCount?: number; excludedRecords?: unknown[]; blindDataIncluded?: boolean };
    lanes: Record<string, Record<string, number | null>>;
  };
}

export interface StorageArchive {
  id: string;
  path: string;
  createdAt: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface PatrolTrend {
  projectId?: string;
  scenarioId?: string;
  totalRuns: number;
  failedRuns: number;
  latestRunId?: string;
  latestVerdict?: string;
  riskTrend: "first_run" | "improved" | "regressed" | "stable";
  riskIncreased: boolean;
  summary: string;
}

export type ProjectMemberRole = "owner" | "editor" | "viewer";

export interface ProjectGrant {
  id: string;
  projectId: string;
  subject: string;
  role: ProjectMemberRole;
  tokenKind: "dev" | "deploy" | "project_admin" | "artifact_read";
  scopes: Array<"read_project" | "read_artifacts" | "read_reports" | "read_evidence" | "run_tests" | "edit_project" | "edit_sandbox" | "export_source" | "apply_source" | "manage_project" | "manage_members" | "manage_credentials" | "admin">;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export type AgentGraphNode =
  | "intake"
  | "discover"
  | "diagnose-runtime"
  | "choose-recovery"
  | "recover"
  | "verify-recovery"
  | "build-coverage-map"
  | "plan"
  | "compile"
  | "approve-plan"
  | "prepare-sandbox"
  | "approve-capabilities"
  | "execute"
  | "collect-and-gate"
  | "triage-failure"
  | "selective-judge"
  | "repair"
  | "retry-path"
  | "continue-paths"
  | "finalize";

export type AgentInterruptOwner = "agent" | "user" | "environment" | "developer";

/** Concrete operations a human may pick when resolving a `repair-decision`. */
export type RepairDecisionValue =
  | "repair"
  | "create-session"
  | "provide-credentials"
  | "recover-sandbox"
  | "reopen-discovery"
  | "dismiss";

export interface AgentInterruptOption {
  value: RepairDecisionValue | string;
  label: string;
  description?: string;
}

export interface AgentInterrupt {
  id: string;
  runId: string;
  kind:
    | "plan-approval"
    | "browser-permission"
    | "credential"
    | "network-install"
    | "dangerous-operation"
    | "repair-apply"
    | "repair-decision"
    | "execution-result";
  status: "pending" | "approved" | "rejected" | "expired";
  title: string;
  detail: string;
  requestedCapabilities: string[];
  payload: Record<string, unknown>;
  /** Rich carrier for the unified human-in-the-loop `repair-decision`. */
  owner?: AgentInterruptOwner;
  context?: Record<string, unknown>;
  options?: AgentInterruptOption[];
  diagnoses?: string[];
  evidenceRefs?: string[];
  attemptId?: string;
  scenarioId?: string;
  decision?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** The answer submitted when resuming a `repair-decision` interrupt. */
export interface RepairDecisionAnswer {
  decision: RepairDecisionValue;
  message?: string;
  repairPlanId?: string;
}

export interface AgentGraphProjection {
  schemaVersion: "1.0";
  runId: string;
  threadId: string;
  mode: "shadow" | "active";
  status: "idle" | "running" | "interrupted" | "completed" | "failed" | "cancelled";
  currentNode?: AgentGraphNode;
  completedNodes: AgentGraphNode[];
  progress: number;
  pendingInterrupt?: AgentInterrupt;
  interruptOwner?: AgentInterruptOwner;
  interruptContext?: Record<string, unknown>;
  lastError?: { code: string; message: string; node?: AgentGraphNode };
  tokenUsage: number;
  repairSessionId?: string;
  recoveryDecision?: {
    action: string;
    reason: string;
    confidence: "high" | "medium" | "low";
    evidenceRefs: string[];
    expectedState: string;
    userQuestion?: string;
  };
  recoveryResult?: {
    actionId: string;
    action: string;
    status: "accepted" | "running" | "completed" | "failed" | "blocked" | "needs-confirmation";
    evidenceRefs: string[];
    nextState: string;
    errorCode?: string;
    userMessage?: string;
  };
  recoveryAttempts?: Record<string, number>;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
  observation?: Record<string, unknown>;
  browserSession?: BrowserSession;
  browserObservation?: BrowserObservation;
  browserDecision?: BrowserActionDecision;
  browserActionResult?: BrowserActionResult;
  browserAgentRequired?: boolean;
  browserLoopComplete?: boolean;
  continuationPasses?: number;
  remainingPathCount?: number;
  updatedAt: string;
}

export interface BrowserSession {
  sessionId: string;
  runId: string;
  attemptId: string;
  status: "starting" | "ready" | "waiting-user" | "recovering" | "closed" | "failed";
  owner: "agent" | "user" | "waiting-user";
  currentUrl?: string;
  lastObservationId?: string;
  actionCount: number;
  decisionCount: number;
  rebindCount: number;
  updatedAt: string;
}

export interface BrowserObservation {
  observationId: string;
  runId: string;
  attemptId: string;
  finalUrl: string;
  title: string;
  pageFingerprint: string;
  controls: Array<{ controlId: string; kind: string; role?: string; accessibleName?: string; label?: string; visible: boolean; disabled: boolean }>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ method: string; url: string; status?: number; failure?: string }>;
  evidenceRefs: string[];
  createdAt: string;
}

export interface BrowserActionDecision {
  decisionId: string;
  status: "act" | "complete" | "blocked" | "needs-confirmation";
  reasonCode?: "transient-observation" | "transient-model" | "budget-exhausted" | "policy-blocked" | "user-input-required";
  summary: string;
  actions: Array<{ actionId: string; action: string; purpose: string; expectedChange: string; risk: string }>;
  evidenceRefs: string[];
  userQuestion?: string;
}

export interface BrowserActionResult {
  resultId: string;
  actionId: string;
  coverageItemId: string;
  status: "completed" | "failed" | "blocked" | "needs-confirmation";
  summary: string;
  evidenceRefs: string[];
  oracleResults: Array<{ oracleId: string; passed: boolean; actual: string; evidenceRefs: string[] }>;
}

export interface RepairFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  baseSha256?: string;
  patchedSha256?: string;
  additions: number;
  deletions: number;
  risk: "low" | "medium" | "high" | "forbidden";
  riskReasons: string[];
  editable: boolean;
  version: number;
}

export interface RepairValidation {
  id: string;
  repairSessionId: string;
  status: "queued" | "running" | "passed" | "failed" | "blocked";
  childRunId?: string;
  commands: Array<{ executable: string; args: string[]; cwd?: string; timeoutMs?: number }>;
  targetedPassed?: boolean;
  regressionPassed?: boolean;
  artifactIds: string[];
  summary: string;
  startedAt: string;
  finishedAt?: string;
}

export interface RepairSession {
  schemaVersion: "1.0";
  id: string;
  runId: string;
  projectId: string;
  status: "draft" | "analyzing" | "editing" | "validating" | "ready-for-review" | "exported" | "applied" | "failed" | "blocked" | "cancelled";
  baseSourceSha256: string;
  workspaceRoot: string;
  summary: string;
  failureClass: "product-bug" | "test-script" | "environment" | "evidence" | "unknown";
  files: RepairFileChange[];
  validation?: RepairValidation;
  iteration: number;
  maxFiles: number;
  maxChangedLines: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepairFileContent {
  path: string;
  original: string;
  content: string;
  baseSha256?: string;
  patchedSha256?: string;
  version: number;
  risk: RepairFileChange["risk"];
  riskReasons: string[];
  editable: boolean;
}

/** A filtered source-tree entry from the repair sandbox, never a host path. */
export interface RepairWorkspaceFile {
  path: string;
  changed: boolean;
  risk: RepairFileChange["risk"];
  riskReasons: string[];
  editable: boolean;
}

export interface SecuritySummary {
  tokenMode?: string;
  tokenConfigured?: boolean;
  defaultDevTokenAllowed?: boolean;
  artifactAccess?: string;
  corsOrigins?: string[];
  grants?: string;
  credentialRotation?: string;
  [key: string]: unknown;
}
