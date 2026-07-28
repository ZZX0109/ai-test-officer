import type { ArtifactV2, CommandSpec, CompiledPlan, Conclusion, CoverageItem, EvidenceLocator, GateStatus, HumanDecision, JudgeRecommendation, LlmBudget, LlmCall, MachineGate, PlanProvenance, ProjectManifest, ProofEdge, ProofNode, ResourceBudget, RunEvidenceManifest, RunOutcomeSummaryV2 } from "@ai-test-officer/contracts";

export type ProviderKind = "openai-compatible" | "openai" | "anthropic" | "openrouter" | "custom";

export interface CredentialInput {
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  tags: string[];
  isDefault?: boolean;
  owner?: string;
  scopes?: string[];
}

export interface CredentialRecord {
  id: string;
  name: string;
  provider: ProviderKind;
  baseUrl: string;
  apiKeyEncrypted: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface CredentialPublic {
  id: string;
  name: string;
  provider: ProviderKind;
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
  createdAt: string;
  updatedAt: string;
}

export interface TestPath {
  id: string;
  title: string;
  riskReason: string;
  expectedFrom: "requirement" | "diff" | "existing_test" | "llm_inferred";
  steps: string[];
  retry: number;
}

export interface GrayLevel {
  id: "smoke" | "core_path" | "edge_case" | "regression";
  title: string;
  description: string;
  paths: TestPath[];
}

export interface GrayPlan {
  sessionName: string;
  risks: Array<{
    id: string;
    level: "high" | "medium" | "low";
    title: string;
    evidence: string;
    pathIds?: string[];
    coverageDisposition?: "required" | "harness_gap";
  }>;
  levels: GrayLevel[];
}

export type ProjectRuntimeFailureReason =
  | "none"
  | "config_missing"
  | "project_path_missing"
  | "install_failed"
  | "start_failed"
  | "health_timeout"
  | "frontend_unreachable"
  | "backend_unreachable"
  | "credential_missing"
  | "cleanup_failed"
  | "command_not_found"
  | "dependency_missing"
  | "port_conflict"
  | "early_exit"
  | "permission_denied"
  | "container_runtime_unavailable"
  | "budget_exceeded"
  | "cancelled"
  | "unknown";

export interface ProjectLoginConfig {
  method: "none" | "form" | "storage_state" | "env";
  usernameEnv?: string;
  passwordEnv?: string;
  credentialId?: string;
  loginUrl?: string;
}

export interface ProjectApiCredentialRequirement {
  envName: string;
  providerHint?: string;
  baseUrlEnv?: string;
  modelEnv?: string;
  exposure: "server" | "browser";
  signals: string[];
}

export interface ProjectApiCredentialBinding {
  envName: string;
  credentialId: string;
  source: "test-system" | "dedicated";
  baseUrlEnv?: string;
  modelEnv?: string;
  configuredAt: string;
}

export interface ProjectProcessConfig {
  name: string;
  command: string;
  commandSpec?: CommandSpec;
  healthCheckUrl?: string;
  required?: boolean;
}

export interface ProjectConfig {
  id: string;
  name: string;
  projectPath: string;
  allowExternalProjectPath?: boolean;
  installCommand?: string;
  installCommandSpec?: CommandSpec;
  startCommand?: string;
  startCommandSpec?: CommandSpec;
  processes?: ProjectProcessConfig[];
  healthCheckUrl?: string;
  frontendUrl: string;
  backendUrl?: string;
  testCommand?: string;
  testCommandSpec?: CommandSpec;
  allowedOrigins?: string[];
  login?: ProjectLoginConfig;
  apiCredentialRequirements?: ProjectApiCredentialRequirement[];
  apiCredentialBindings?: ProjectApiCredentialBinding[];
  env?: Record<string, string>;
  cleanupCommand?: string;
  cleanupCommandSpec?: CommandSpec;
  timeoutMs?: number;
  externalSmokeProfile?: ExternalSmokeProfile;
  manifest?: ProjectManifest;
  budget?: ResourceBudget;
  createdAt: string;
  updatedAt: string;
}

export type TargetProjectConfig = Pick<
  ProjectConfig,
  "id" | "projectPath" | "frontendUrl" | "backendUrl" | "startCommand" | "cleanupCommand" | "healthCheckUrl" | "testCommand" | "testCommandSpec" | "allowedOrigins"
> & {
  projectId: string;
  rootDir: string;
  appUrl: string;
  apiUrl?: string;
};

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
    requirements: ProjectApiCredentialRequirement[];
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

export interface ProjectRuntimeStatus {
  projectId: string;
  status: "idle" | "installing" | "starting" | "running" | "stopped" | "failed";
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
    failureReason?: ProjectRuntimeFailureReason;
    message: string;
  }>;
  startedAt?: string;
  stoppedAt?: string;
  frontendUrl?: string;
  backendUrl?: string;
  healthCheckUrl?: string;
  failureReason?: ProjectRuntimeFailureReason;
  message: string;
}

export interface ProjectHealthCheckResult {
  projectId: string;
  ok: boolean;
  status: "passed" | "failed";
  reason: ProjectRuntimeFailureReason;
  credential: {
    ok: boolean;
    method: ProjectLoginConfig["method"];
    credentialId?: string;
    missingEnv: string[];
  };
  apiCredential: {
    ok: boolean;
    requirements: Array<{
      envName: string;
      configured: boolean;
      credentialId?: string;
      source?: ProjectApiCredentialBinding["source"];
      exposure: ProjectApiCredentialRequirement["exposure"];
    }>;
    missingEnv: string[];
  };
  frontend?: { ok: boolean; status?: number; url?: string; error?: string };
  backend?: { ok: boolean; status?: number; url?: string; error?: string };
  health?: { ok: boolean; status?: number; url?: string; error?: string };
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

export interface ExternalSmokeProfile {
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
}

export interface TargetAppRuntime {
  projectId?: string;
  frontendUrl: string;
  backendUrl?: string;
  healthCheckUrl?: string;
}

export interface SourceReadEnvelope {
  id: string;
  kind: "git_diff" | "github_pr" | "github_pr_diff" | "github_issue" | "jira_issue" | "requirement_doc" | "tapd_bug" | "openapi" | "local_file" | "manual";
  title: string;
  uri?: string;
  status: "connected" | "simulated" | "missing";
  summary: string;
  failureReason?: string;
  permissionState: "granted" | "not_required" | "missing" | "denied" | "unknown";
  isSimulated: boolean;
  evidenceUse?: "primary_requirement" | "change_context" | "bug_context" | "api_contract" | "supplemental" | "not_used";
  displayStatus?: "ready" | "needs_auth" | "missing" | "simulated" | "failed";
  plainLanguageSummary?: string;
  contentHash?: string;
  readAt: string;
  trustLevel: "high" | "medium" | "low";
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

export interface ImpactAnalysisItem {
  id: string;
  kind: "page" | "api" | "component" | "scenario" | "unknown";
  target: string;
  reason: string;
  sourceContextIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface ImpactAnalysis {
  id: string;
  createdAt: string;
  affectedPages: ImpactAnalysisItem[];
  affectedApis: ImpactAnalysisItem[];
  affectedComponents: ImpactAnalysisItem[];
  recommendedScenarios: Array<{
    scenarioId: string;
    reason: string;
    confidence: "high" | "medium" | "low";
    sourceContextIds: string[];
    priority?: "critical" | "high" | "medium" | "low";
    score?: number;
    riskDrivers?: string[];
  }>;
  uncoveredRisks: Array<{
    id: string;
    title: string;
    reason: string;
    requiredCapabilities: string[];
    sourceContextIds: string[];
  }>;
  codeGraph?: import("./codeImpactGraph.js").CodeImpactGraph;
}

export interface PlanStep {
  id: string;
  scenarioId: string;
  compileSource: "registry" | "generic_template" | "harness_gap";
  humanReviewRequired: boolean;
  draftScenarioRef?: string;
  draftReviewStatus?: "draft" | "approved" | "rejected";
  selectorProbeStatus?: "not_run" | "passed" | "failed";
  capabilityKind?: ScenarioCapabilityKind;
  title: string;
  preconditions: string[];
  browserActions: string[];
  selectorStrategy: {
    priority: Array<"role" | "text" | "testId" | "css">;
    role?: string;
    text?: string;
    testId?: string;
    css?: string;
  };
  assertions: string[];
  evidenceRequirements: Array<"screenshot" | "dom" | "network" | "console" | "trace" | "video">;
  failurePolicy: {
    allowedFailureClasses: FailureClass[];
    stopOnFailure: boolean;
  };
  retryPolicy: {
    maxRetries: number;
    timeoutMs: number;
  };
}

export interface ExecutableTestPlan {
  id: string;
  createdAt: string;
  source: "scenario_registry" | "llm_validated" | "fallback" | "plan_compiler_v2";
  status: "valid" | "invalid" | "needs_harness";
  plan: GrayPlan;
  steps: PlanStep[];
  rejectedSteps: Array<{
    title: string;
    reason: string;
    compileSource?: "harness_gap";
    humanReviewRequired?: boolean;
    draftScenarioRef?: string;
    draftReviewStatus?: "draft" | "approved" | "rejected";
    selectorProbeStatus?: "not_run" | "passed" | "failed";
    capabilityKind?: ScenarioCapabilityKind;
  }>;
}

export type ScenarioCapabilityKind =
  | "domain_specific"
  | "table"
  | "complex_form"
  | "file_upload"
  | "approval_flow"
  | "openapi_contract"
  | "role_permission_matrix";

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

export interface RunRequest {
  /** Stable control-plane run id. Queue executions reuse it so live evidence,
   * SSE state and the final report share one identity. */
  runId?: string;
  appUrl?: string;
  projectId?: string;
  logicalProjectId?: string;
  planId?: string;
  target?: TargetAppRuntime;
  keepProjectRunning?: boolean;
  scenarioId?: string;
  credentialId?: string;
  judgeMode?: "deterministic" | "llm-assisted" | "adaptive";
  llmBudget?: LlmBudget;
  priorLlmTokens?: number;
  experimentId?: string;
  repetition?: number;
  planProvenance?: PlanProvenance;
  /** Opaque benchmark fixture selector; never include its target-side meaning in prompts. */
  fixtureVariantId?: string;
  trigger?: "manual" | "commit" | "requirement" | "patrol";
  requirement?: string;
  diff?: string;
  bugTicket?: string;
  plan?: GrayPlan;
  sourceContexts?: SourceReadEnvelope[];
  impactAnalysis?: ImpactAnalysis;
  executablePlan?: ExecutableTestPlan;
  /** Validated, capability-bounded Action DSL produced by the LLM planner. */
  compiledPlan?: CompiledPlan;
  maxAutoRepairs?: number;
  permissionProfile: PermissionProfile;
  signal?: AbortSignal;
}

export interface RepairAttempt {
  attempt: number;
  kind: "selector_recovery" | "wait_adjustment" | "evidence_completion" | "execution_retry";
  status: "started" | "completed" | "failed";
  reason: string;
  evidenceRefs: string[];
}

export interface RepairProposal {
  id: string;
  kind:
    | "selector_recovery"
    | "wait_strategy_adjustment"
    | "evidence_completion"
    | "environment_diagnosis"
    | "bounded_retry";
  status: "proposed" | "approved" | "rejected" | "applied";
  originalFailure: string;
  proposedChange: string;
  safeguards: string[];
  beforeEvidenceRefs: string[];
  afterEvidenceRefs: string[];
  outcome: "pending" | "passed" | "failed" | "blocked";
}

export interface DiscoveryScanSuggestion {
  id: string;
  title: string;
  riskKind: "auth" | "form" | "table" | "navigation" | "api_contract" | "upload" | "state_change" | "unknown";
  reason: string;
  capabilityKind?: ScenarioCapabilityKind;
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
  status: "passed" | "partial" | "failed";
  message: string;
}

export interface RunStepEvidence {
  stepId: string;
  title: string;
  status: "passed" | "failed" | "warning";
  action: string;
  screenshot?: string;
  details: string;
}

export type AssertionKind =
  | "element.visible"
  | "network.url_contains"
  | "text.contains"
  | "text.all_contains"
  | "state.equals"
  | "console.error"
  | "console.no_error"
  | "environment.error"
  | "unknown";

export type FailureClass =
  | "product_bug"
  | "test_script_issue"
  | "environment_issue"
  | "insufficient_evidence"
  | "unknown";

export interface AssertionFact {
  kind: AssertionKind;
  target: string;
  operator: "exists" | "contains" | "all_contains" | "equals" | "not_present";
  expected: string;
  actual: string;
  severity: "high" | "medium" | "low";
  evidenceRefs: string[];
  failureClass?: FailureClass;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  fact?: AssertionFact;
}

export interface VisualRunResult {
  id: string;
  startedAt: string;
  finishedAt: string;
  scenarioFingerprint?: string;
  verdict: "continue" | "hold_for_review" | "stop_and_fix";
  summary: string;
  steps: RunStepEvidence[];
  network: Array<{ method: string; url: string; status?: number }>;
  console: Array<{ type: string; text: string }>;
  assertions: AssertionResult[];
  evidence: EvidenceItem[];
  loopEvents: LoopEvent[];
  oracles: OracleDefinition[];
  riskCoverageMatrix: RiskCoverageItem[];
  aggregatedVerdict: AggregatedVerdict;
  reflectionNote: string;
  conflictPacket: ConflictPacket;
  failureAttributions: FailureAttribution[];
  attempts?: RunAttempt[];
  artifactsV2?: ArtifactV2[];
  gateStatus?: GateStatus;
  machineGate?: MachineGate;
  judgeRecommendation?: JudgeRecommendation;
  humanDecision?: HumanDecision;
  finalStatus?: GateStatus;
  outcomeSummary?: RunOutcomeSummaryV2;
  executionError?: {
    code: "action_binding_failure" | "browser_runtime_failure" | "environment_failure" | "execution_failure";
    stepId?: string;
    message: string;
    failureClass: "test_script_issue" | "environment_issue" | "unknown";
  };
  repairAttempts?: RepairAttempt[];
  runtimeStatus?: ProjectRuntimeStatus;
  judgeReport: LayeredJudgeReport;
  judgeRouting?: { route: "deterministic" | "llm"; reason: string; signals: string[] };
  reportFile: string;
  markdownReportFile?: string;
  htmlReportFile?: string;
  runBundleFile: string;
  artifactIntegrityReportFile?: string;
  artifactIntegrity?: ArtifactIntegrityReport;
  evidenceQuality?: EvidenceQualityReport;
  coverageItems?: CoverageItem[];
  conclusions?: Conclusion[];
  proofNodes?: ProofNode[];
  proofEdges?: ProofEdge[];
  evidenceManifest?: RunEvidenceManifest;
}

export interface AssertionEvidenceQuality {
  assertionName: string;
  passed: boolean;
  attempt?: number;
  requiredKinds: ArtifactV2["kind"][];
  collectedKinds: ArtifactV2["kind"][];
  artifactIds: string[];
  evidenceRefs: string[];
  status: "grounded" | "insufficient";
  reasons: string[];
}

export interface EvidenceQualityReport {
  generatedAt: string;
  assertions: AssertionEvidenceQuality[];
  summary: {
    totalAssertions: number;
    passedAssertions: number;
    groundedPassedAssertions: number;
    groundedPassedRate: number;
    runtimeArtifactRate: number;
    crossAttemptViolations: number;
  };
}

export type EvidenceType =
  | "screenshot"
  | "video"
  | "trace"
  | "network"
  | "console"
  | "dom"
  | "assertion"
  | "operation"
  | "permission"
  | "report"
  | "user_decision";

export interface EvidenceItem {
  id: string;
  runId: string;
  type: EvidenceType;
  title: string;
  timestamp: string;
  scenarioId?: string;
  attemptId?: string;
  attempt?: number;
  sequence?: number;
  artifactIds?: string[];
  pathId?: string;
  stepId?: string;
  url?: string;
  file?: string;
  locator?: EvidenceLocator;
  payload: Record<string, unknown>;
}

export interface RunAttempt {
  id: string;
  runId: string;
  scenarioId: string;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed" | "blocked" | "cancelled";
  retryReason?: string;
  artifactIds: string[];
}

export type LoopType =
  | "plan_loop"
  | "approval_loop"
  | "gray_execution_loop"
  | "failure_recovery_loop"
  | "evidence_conflict_loop"
  | "report_loop"
  | "human_verdict_loop"
  | "harness_improvement_loop";

export type LoopEventStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "retrying"
  | "waiting_for_user"
  | "stopped";

export interface LoopEvent {
  id: string;
  runId: string;
  loopType: LoopType;
  iteration: number;
  timestamp: string;
  status: LoopEventStatus;
  title: string;
  action?: string;
  observation?: string;
  decision?: string;
  decisionReason?: string;
  evidenceRefs: string[];
  permissionRef?: string;
}

export interface OracleDefinition {
  id: string;
  pathId: string;
  assertionName: string;
  expectedFrom: "requirement" | "diff" | "existing_test" | "historical_behavior" | "llm_inferred";
  preconditions: string[];
  action: string;
  postconditions: string[];
  requiresHumanConfirmation: boolean;
  evidenceRefs: string[];
}

export interface RiskCoverageItem {
  riskId: string;
  riskTitle: string;
  covered: boolean;
  passed: boolean;
  pathIds: string[];
  evidenceRefs: string[];
  notes: string;
}

export interface AggregatedVerdict {
  runCount: number;
  failedAssertionCount: number;
  flaky: boolean;
  verdict: "continue" | "hold_for_review" | "stop_and_fix" | "needs_review";
  reason: string;
}

export interface ConflictPacket {
  status: "not_triggered" | "needs_replay" | "resolved" | "needs_user_review";
  reason: string;
  evidenceRefs: string[];
}

export interface FailureAttribution {
  id: string;
  rank: number;
  failureClass: FailureClass;
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
      kind: "network_endpoint" | "network_status" | "query_param" | "assertion" | "impact_target" | "changed_file" | "console_stack" | "console_message" | "source_map" | "openapi_operation" | "dom_test_id" | "scenario_oracle";
      value: string;
      reason: string;
      confidence: "high" | "medium" | "low";
    }>;
    addedLines?: Array<{ line: number; text: string }>;
    reason: string;
    confidence: "high" | "medium" | "low";
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
    confidence: "high" | "medium" | "low";
    evidenceRefs: string[];
    sourceContextIds: string[];
    suggestedFix: string;
  }>;
  evidenceRefs: string[];
  sourceContextIds: string[];
  confidence: "high" | "medium" | "low";
}

export interface ArtifactIntegrityItem {
  id: string;
  artifactUri: string;
  kind: EvidenceType | "report" | "run_bundle" | "unknown";
  evidenceId?: string;
  status: "present" | "missing" | "unreadable" | "path_escape" | "self_reference" | "hash_mismatch";
  origin?: ArtifactV2["origin"];
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

export interface ArtifactGateAssessment {
  status: GateStatus;
  eligibleArtifactIds: string[];
  rejectedArtifactIds: string[];
  missingKinds: string[];
  reasons: string[];
}

export interface RunBundle {
  runId: string;
  startedAt: string;
  finishedAt: string;
  input: RunRequest;
  project?: ProjectConfig;
  sourceContexts?: SourceReadEnvelope[];
  impactAnalysis?: ImpactAnalysis;
  executablePlan?: ExecutableTestPlan;
  result: Omit<VisualRunResult, "evidence" | "loopEvents" | "oracles" | "riskCoverageMatrix">;
  evidence: EvidenceItem[];
  artifactsV2?: ArtifactV2[];
  attempts?: RunAttempt[];
  loopEvents: LoopEvent[];
  oracles: OracleDefinition[];
  riskCoverageMatrix: RiskCoverageItem[];
  conflictPacket: ConflictPacket;
  failureAttributions?: FailureAttribution[];
  runtimeStatus?: ProjectRuntimeStatus;
  artifactIntegrity?: ArtifactIntegrityReport;
  coverageItems?: CoverageItem[];
  conclusions?: Conclusion[];
  proofNodes?: ProofNode[];
  proofEdges?: ProofEdge[];
  evidenceManifest?: RunEvidenceManifest;
  judgeReport: LayeredJudgeReport;
}

export interface IntakeSource {
  kind: "git_diff" | "github_pr" | "github_pr_diff" | "github_issue" | "jira_issue" | "requirement_doc" | "tapd_bug" | "openapi" | "local_file" | "pr" | "manual";
  title: string;
  status: "connected" | "simulated" | "missing";
  summary: string;
}

export interface ScenarioCandidate {
  id: string;
  title: string;
  source: "diff" | "requirement" | "tapd_bug" | "patrol" | "llm_inferred";
  riskLevel: "high" | "medium" | "low";
  reason: string;
  executable: boolean;
  mappedScenarioId?: string;
  requiredCapabilities: string[];
}

export interface IntakeAnalysis {
  id: string;
  createdAt: string;
  sources: IntakeSource[];
  sourceContexts?: SourceReadEnvelope[];
  impactAnalysis?: ImpactAnalysis;
  changedAreas: string[];
  risks: GrayPlan["risks"];
  scenarioCandidates: ScenarioCandidate[];
  recommendedTrigger: "commit" | "requirement" | "patrol";
}

export interface HarnessGap {
  id: string;
  createdAt: string;
  source: "commit" | "requirement" | "patrol";
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

export interface ConnectorContext {
  requirement: string;
  diff: string;
  bugTicket: string;
  /** Known project boundary used to prevent generic scenarios leaking into a
   * project-specific fixture during impact analysis. */
  projectId?: string;
  prUrl?: string;
  prMeta?: {
    provider: "github";
    owner: string;
    repo: string;
    number: number;
    title: string;
    body: string;
    changedFiles: string[];
    linkedIssues: Array<{ number: number; title?: string; body?: string }>;
  };
  sourceContexts: SourceReadEnvelope[];
  sources: IntakeSource[];
}

export type JudgeLayer = "plan" | "evidence" | "release";

export interface JudgeFinding {
  id: string;
  severity: "high" | "medium" | "low";
  failureClass?: FailureClass;
  attributionRefs?: string[];
  title: string;
  reasoning: string;
  evidenceRefs: string[];
}

export interface JudgeResult {
  layer: JudgeLayer;
  title: string;
  verdict: "pass" | "needs_review" | "fail";
  summary: string;
  findings: JudgeFinding[];
}

export interface LayeredJudgeReport {
  source: "deterministic_judge" | "llm_judge" | "fallback_baseline";
  executionMode: "deterministic" | "llm_assisted" | "fallback_baseline";
  llmStatus: "not_configured" | "passed" | "failed";
  llmError?: string;
  llmCall?: LlmCall;
  llmCalls?: LlmCall[];
  policyVersion: string;
  createdAt: string;
  planJudge: JudgeResult;
  evidenceJudge: JudgeResult;
  releaseJudge: JudgeResult;
  modelRecommendation?: {
    verdict: "pass" | "needs_review" | "fail";
    summary: string;
    evidenceRefs: string[];
    failureClass?: FailureClass;
  };
}

export interface PlatformCapability {
  id: string;
  title: string;
  status: "implemented" | "simulated" | "planned";
  purpose: string;
  demoAction: string;
}

export interface BotDelivery {
  id: string;
  createdAt: string;
  provider: "wecom" | "feishu" | "slack" | "github_pr_comment" | "generic" | "simulated";
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
    confidence: "high" | "medium" | "low";
    suggestedFix: string;
  }>;
  payloadSummary?: string;
  status: "queued" | "sent" | "simulated" | "failed";
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
  status: "running" | "stopped";
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
  harnessGaps?: HarnessGap[];
  run: VisualRunResult;
  delivery: BotDelivery;
  patrolFile?: string;
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
  role: "viewer" | "runner" | "maintainer" | "project_admin" | "operator" | "admin";
  tokenKind: "dev" | "deploy" | "project_admin" | "artifact_read";
  scopes: Array<"read_project" | "run_tests" | "read_artifacts" | "edit_sandbox" | "export_source" | "apply_source" | "manage_project" | "manage_credentials" | "admin">;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
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
  run?: VisualRunResult;
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
  run?: VisualRunResult;
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
  stages: Array<{
    runId: string;
    scenarioId?: string;
    schemaVersion: "2.0";
    schedulingCompleted: boolean;
    executionStarted: boolean;
    executionSucceeded: boolean;
    requirementCovered: boolean;
    requirementPassed: boolean;
    artifactIntegrityVerified: boolean;
    evidenceGrounded: boolean;
    gateEligible: boolean;
    machineGate?: GateStatus;
    judgeRecommendation?: GateStatus;
    finalStatus?: GateStatus;
  }>;
  demoVerificationFile?: string;
}
