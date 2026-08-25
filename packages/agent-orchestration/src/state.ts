import type {
  AgentGraphNode,
  AgentGraphProjection,
  AgentInterrupt,
  AgentPermissionProfile,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  CompiledPlan,
  CoverageItem,
  MachineGate,
  PlanProvenance,
  RecoveryActionResult,
  RecoveryDecision,
  RepairDecisionAnswer,
  RunOutcomeSummaryV2
} from "@ai-test-officer/contracts";
import type {
  EvidenceGateSubgraphInput,
  EvidenceGateSubgraphOutput,
  FinalizationSubgraphInput,
  FinalizationSubgraphOutput
} from "./subgraphs.js";

export type {
  AgentGraphNode,
  AgentGraphProjection,
  AgentInterrupt,
  AgentPermissionProfile,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  CompiledPlan,
  CoverageItem,
  MachineGate,
  PlanProvenance,
  RecoveryActionResult,
  RecoveryDecision,
  RepairDecisionAnswer,
  RunOutcomeSummaryV2
} from "@ai-test-officer/contracts";

export type AgentGraphMode = "shadow" | "active";
export type AgentGraphStatus = AgentGraphProjection["status"];

/** JSON-safe state values are serializable across LangGraph checkpoints. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonObject = { [key: string]: JsonValue | undefined };
export type StateValue = string | number | boolean | null | object;
export interface StateEnvelope {
  [key: string]: StateValue | undefined;
}

export function toJsonObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AgentResumePayload extends StateEnvelope {
  approved?: boolean;
  execution?: ExecutionState;
}

export interface CoverageMapItemState extends StateEnvelope {
  id: string;
  flowId?: string;
  module?: string;
  surface?: "page" | "api" | "data" | "background-task" | "component" | "unknown" | string;
  disposition?: string;
  scenarioId?: string;
  structuredPlan?: CompiledPlan;
}

export interface DiscoveryState {
  status?: "ready" | "waiting" | "completed" | "failed" | "degraded" | string;
  reason?: string;
  evidence?: object[];
  summary?: string;
}

export interface CoverageMapState extends StateEnvelope {
  status?: string;
  items?: CoverageMapItemState[];
  discovery?: DiscoveryState;
}

export interface PlanState {
  plan?: object;
  provenance?: PlanProvenance;
}

export interface CompiledPlanState {
  compiledPlan?: CompiledPlan | object;
}

export interface ExecutionState extends StateEnvelope {
  aggregate?: boolean;
  dynamicBrowserAgent?: boolean;
  dynamicBrowserChildren?: boolean;
  resultRunId?: string;
  artifactIds?: string[];
  childRunIds?: string[];
  pathResult?: JsonObject;
  attemptId?: string;
  workerAttemptId?: string;
  executionGeneration?: number;
  phase?: string;
  sandbox?: string;
  reason?: string;
}

export interface GateState extends StateEnvelope {
  machineGate?: MachineGate;
  finalStatus?: string;
  resultRunId?: string;
  outcomeSummary?: RunOutcomeSummaryV2;
  judgeRecommendation?: object;
}

export interface FailureState extends StateEnvelope {
  status?: string;
  failureClass?: string;
  reasons?: string[];
  evidenceRefs?: string[];
  expectedFixtureFault?: boolean;
  needsLlmJudge?: boolean;
  repairable?: boolean;
  retryable?: boolean;
  message?: string;
}

export interface JudgeState extends StateEnvelope {
  unavailable?: boolean;
  error?: string;
  impact?: "machine-gate-preserved" | string;
}

export interface ObservationState extends StateEnvelope {
  id?: string;
  stage?: string;
  status?: string;
  evidenceRefs?: string[];
  summary?: string;
}

export interface AgentGraphInput {
  runId: string;
  mode: AgentGraphMode;
  requirement?: string;
  projectId?: string;
  permissionProfile: AgentPermissionProfile;
  planApproved?: boolean;
  capabilitiesApproved?: boolean;
}

export interface AgentGraphState extends AgentGraphInput {
  status: AgentGraphStatus;
  currentNode?: AgentGraphNode;
  completedNodes: AgentGraphNode[];
  progress: number;
  tokenUsage: number;
  pendingInterrupt?: AgentInterrupt;
  interruptOwner?: "agent" | "user" | "environment" | "developer";
  interruptContext?: JsonObject;
  interruptAnswer?: AgentResumePayload;
  lastError?: AgentGraphProjection["lastError"];
  coverageMap?: CoverageMapState;
  planData?: PlanState;
  compiledPlan?: CompiledPlanState;
  execution?: ExecutionState;
  gate?: GateState;
  failure?: FailureState;
  judge?: JudgeState;
  repairSessionId?: string;
  recoveryDecision?: RecoveryDecision;
  recoveryResult?: RecoveryActionResult;
  recoveryAttempts?: Record<string, number>;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
  observation?: ObservationState;
  browserSession?: BrowserSession;
  browserObservation?: BrowserObservation;
  browserDecision?: BrowserActionDecision;
  browserActionResult?: BrowserActionResult;
  browserActionAuthorized?: boolean;
  browserCredentialAuthorized?: boolean;
  browserAgentRequired?: boolean;
  browserLoopComplete?: boolean;
  browserBatchPathCount?: number;
  browserBatchPending?: boolean;
  browserBatchDelayMs?: number;
  browserBatchResumed?: boolean;
  browserRateLimitRetries?: number;
  continuationPasses?: number;
  remainingPathCount?: number;
  planningTerminal?: boolean;
  discoveryTerminal?: boolean;
  nodeAttempt?: number;
  inputHash?: string;
  updatedAt: string;
}

export interface AgentGraphHooks {
  intake?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  discover?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  buildCoverageMap?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  plan?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  compile?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  prepareSandbox?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  observeBrowser?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  decideBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  authorizeBrowserAction?: (state: AgentGraphState, resume?: AgentResumePayload) => Promise<Partial<AgentGraphState> & { browserInterrupt?: AgentInterrupt }>;
  executeBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  verifyBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  decideNextStep?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  execute?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  collectAndGate?: (state: EvidenceGateSubgraphInput) => Promise<EvidenceGateSubgraphOutput>;
  triageFailure?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  diagnoseRuntime?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  chooseRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  recover?: (state: AgentGraphState) => Promise<Partial<AgentGraphState> & { recoveryInterrupt?: AgentInterrupt }>;
  verifyRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  retryPath?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  continuePaths?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  selectiveJudge?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  repair?: (state: AgentGraphState, resume?: RepairDecisionAnswer) => Promise<Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt }>;
  finalize?: (state: FinalizationSubgraphInput) => Promise<FinalizationSubgraphOutput>;
  onProjection?: (projection: AgentGraphProjection) => Promise<void>;
}
