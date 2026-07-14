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
  workspaceControl: boolean;
  ideTerminalControl: boolean;
  systemControl: boolean;
}

export interface RunResult {
  id: string;
  scenarioFingerprint?: string;
  verdict: "continue" | "hold_for_review" | "stop_and_fix";
  summary: string;
  gateStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  finalStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
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
    origin: "runtime-captured" | "fixture" | "simulated" | "user-uploaded" | "legacy-unverified";
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
  runtimeStatus?: ProjectRuntimeStatus;
  judgeReport: LayeredJudgeReport;
  reportFile: string;
  markdownReportFile?: string;
  htmlReportFile?: string;
  runBundleFile: string;
  artifactIntegrityReportFile?: string;
  artifactIntegrity?: ArtifactIntegrityReport;
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
  startCommand?: string;
  processes?: Array<{
    name: string;
    command: string;
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
  env?: Record<string, string>;
  cleanupCommand?: string;
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
  detectedStack: Array<"vite" | "next" | "fastapi" | "express" | "unknown">;
  packageManagers: Array<"npm" | "pnpm" | "yarn" | "pip" | "uv" | "poetry">;
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

export interface DiscoveryScanResult {
  id: string;
  createdAt: string;
  target: TargetAppRuntime;
  page: {
    url: string;
    title?: string;
    headings: string[];
    links: Array<{ text: string; href: string }>;
    buttons: Array<{ text: string; testId?: string; role?: string }>;
    inputs: Array<{ label?: string; name?: string; type?: string; testId?: string }>;
    forms: Array<{ action?: string; method?: string; inputCount: number }>;
    testIds: string[];
  };
  networkEndpoints: Array<{ method: string; url: string; status?: number; path?: string }>;
  openApiOperations: Array<{ method: string; path: string; operationId?: string; summary?: string }>;
  suggestions: DiscoveryScanSuggestion[];
  drafts: HarnessGapScenarioDraft[];
  status: "passed" | "partial" | "failed";
  message: string;
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
  fixtureProjects: string[];
  byProject: Record<string, number>;
  categories: string[];
  runtimeMetrics: {
    status: string;
    experimentId?: string;
    conclusion?: string;
    completedRuns: number;
    plannedRuns: number;
    blockers: string[];
    acceptance?: { proven: boolean; reasons: string[] };
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

export interface ProjectGrant {
  id: string;
  projectId: string;
  subject: string;
  role: "viewer" | "runner" | "project_admin" | "operator" | "admin";
  tokenKind: "dev" | "deploy" | "project_admin" | "artifact_read";
  scopes: Array<"read_project" | "run_tests" | "read_artifacts" | "manage_project" | "manage_credentials" | "admin">;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
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
