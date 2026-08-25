import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type {
  AgentGraphNode,
  AgentGraphState,
  AgentGraphMode,
  AgentGraphStatus,
  AgentInterrupt,
  AgentPermissionProfile,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  CompiledPlanState,
  CoverageMapState,
  ExecutionState,
  FailureState,
  GateState,
  JudgeState,
  ObservationState,
  PlanState,
  RecoveryActionResult,
  RecoveryDecision
} from "./state.js";

export type AgentSubgraphName =
  | "discovery"
  | "planning"
  | "runtime-recovery"
  | "browser-execution"
  | "non-browser-execution"
  | "evidence-gate"
  | "failure-triage"
  | "repair-validation"
  | "finalization";
export interface TypedSubgraphContract {
  name: AgentSubgraphName;
  nodes: readonly AgentGraphNode[];
  reads: readonly (keyof AgentGraphState)[];
  writes: readonly (keyof AgentGraphState)[];
  stopConditions: readonly string[];
}
/**
 * Discovery is the first multi-node phase child. It intentionally excludes
 * plan, compiled actions, execution, repair and gate fields: discovery may
 * establish an observable runtime inventory, but cannot decide a verdict.
 */
export interface DiscoverySubgraphInput {
  runId: string;
  mode: AgentGraphMode;
  projectId?: string;
  requirement?: string;
  permissionProfile: AgentPermissionProfile;
  planApproved?: boolean;
  capabilitiesApproved?: boolean;
  status: AgentGraphStatus;
  completedNodes: AgentGraphNode[];
  progress: number;
  tokenUsage: number;
  updatedAt: string;
  coverageMap?: CoverageMapState;
  observation?: ObservationState;
  discoveryTerminal?: boolean;
}

export interface DiscoverySubgraphOutput {
  status?: AgentGraphStatus;
  currentNode?: AgentGraphNode;
  completedNodes?: AgentGraphNode[];
  progress?: number;
  tokenUsage?: number;
  updatedAt?: string;
  coverageMap?: CoverageMapState;
  observation?: ObservationState;
  discoveryTerminal?: boolean;
}

export type DiscoverySubgraphState = DiscoverySubgraphInput & DiscoverySubgraphOutput;

export const DiscoverySubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  planApproved: Annotation<boolean | undefined>(),
  capabilitiesApproved: Annotation<boolean | undefined>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>()
});

/** Compile the complete intake → runtime-discovery phase independently. */
export function createDiscoverySubgraph(input: {
  intake?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  discover?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(DiscoverySubgraphStateAnnotation)
    .addNode("intake", async (state: DiscoverySubgraphState) => input.intake?.(state as AgentGraphState) ?? {})
    .addNode("discover", async (state: DiscoverySubgraphState) => input.discover?.(state as AgentGraphState) ?? {})
    .addEdge(START, "intake")
    .addEdge("intake", "discover")
    .addEdge("discover", END)
    .compile({ checkpointer: input.checkpointer ?? false, name: "discovery-subgraph" });
}

/**
 * Planning owns CoverageItem materialisation, plan selection and deterministic
 * compilation. Plan approval intentionally stays in the parent graph: it is a
 * durable human interrupt, while this child has no independent checkpoint and
 * must be safe to re-run as one idempotent pre-approval phase.
 */
export interface PlanningSubgraphInput {
  runId: string;
  mode: AgentGraphMode;
  projectId?: string;
  requirement?: string;
  permissionProfile: AgentPermissionProfile;
  status: AgentGraphStatus;
  completedNodes: AgentGraphNode[];
  progress: number;
  tokenUsage: number;
  updatedAt: string;
  coverageMap?: CoverageMapState;
  planData?: PlanState;
  compiledPlan?: CompiledPlanState;
  planningTerminal?: boolean;
  browserAgentRequired?: boolean;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
}

export interface PlanningSubgraphOutput {
  status?: AgentGraphStatus;
  currentNode?: AgentGraphNode;
  completedNodes?: AgentGraphNode[];
  progress?: number;
  tokenUsage?: number;
  updatedAt?: string;
  coverageMap?: CoverageMapState;
  planData?: PlanState;
  compiledPlan?: CompiledPlanState;
  planningTerminal?: boolean;
  browserAgentRequired?: boolean;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
}

export type PlanningSubgraphState = PlanningSubgraphInput & PlanningSubgraphOutput;

export const PlanningSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  planData: Annotation<PlanState | undefined>(),
  compiledPlan: Annotation<CompiledPlanState | undefined>(),
  planningTerminal: Annotation<boolean | undefined>(),
  browserAgentRequired: Annotation<boolean | undefined>(),
  currentCoverageItemId: Annotation<string | undefined>(),
  currentAttemptId: Annotation<string | undefined>()
});

/** Compile the pre-approval planning pipeline independently with narrow state. */
export function createPlanningSubgraph(input: {
  buildCoverageMap?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  plan?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  compile?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(PlanningSubgraphStateAnnotation)
    .addNode("build-coverage-map", async (state: PlanningSubgraphState) =>
      input.buildCoverageMap?.(state as AgentGraphState) ?? {})
    .addNode("plan", async (state: PlanningSubgraphState) => input.plan?.(state as AgentGraphState) ?? {})
    .addNode("compile", async (state: PlanningSubgraphState) => input.compile?.(state as AgentGraphState) ?? {})
    .addEdge(START, "build-coverage-map")
    .addEdge("build-coverage-map", "plan")
    .addConditionalEdges("plan", (state) => state.planningTerminal === true ? END : "compile", [END, "compile"])
    .addEdge("compile", END)
    .compile({ checkpointer: input.checkpointer ?? false, name: "planning-subgraph" });
}

/**
 * Runtime recovery owns the bounded diagnosis and retry transaction. It is a
 * native child because `recover` may interrupt for credentials; the parent
 * only chooses the next business boundary after this child reaches an exit.
 */
export type RuntimeRecoverySubgraphInput = Pick<AgentGraphState,
  | "runId" | "mode" | "projectId" | "requirement" | "permissionProfile"
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "interruptAnswer"
  | "coverageMap" | "observation" | "failure" | "recoveryDecision" | "recoveryResult"
  | "recoveryAttempts" | "currentAttemptId" | "discoveryTerminal"
>;

export type RuntimeRecoverySubgraphOutput = Partial<Pick<RuntimeRecoverySubgraphInput,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "coverageMap" | "observation"
  | "failure" | "recoveryDecision" | "recoveryResult" | "recoveryAttempts" | "currentAttemptId"
  | "discoveryTerminal"
>>;

export type RuntimeRecoverySubgraphState = RuntimeRecoverySubgraphInput & RuntimeRecoverySubgraphOutput;

export const RuntimeRecoverySubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  interruptAnswer: Annotation<AgentGraphState["interruptAnswer"]>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  failure: Annotation<FailureState | undefined>(),
  recoveryDecision: Annotation<RecoveryDecision | undefined>(),
  recoveryResult: Annotation<RecoveryActionResult | undefined>(),
  recoveryAttempts: Annotation<Record<string, number> | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>()
});

function recoveryDecisionNeedsRetry(state: RuntimeRecoverySubgraphState) {
  const action = state.recoveryDecision?.action;
  const retryingExecutedPath = Boolean(state.failure?.status && state.failure.status !== "pass");
  return state.recoveryResult?.status === "completed"
    && (action === "retry-path" || (retryingExecutedPath && (action === "retry-runtime" || action === "retry-discovery")));
}

/** Compile bounded runtime recovery with a native checkpoint/resume frame. */
export function createRuntimeRecoverySubgraph(input: {
  diagnoseRuntime?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  chooseRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  recover?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  verifyRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  retryPath?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(RuntimeRecoverySubgraphStateAnnotation)
    .addNode("diagnose-runtime", async (state: RuntimeRecoverySubgraphState) =>
      input.diagnoseRuntime?.(state as AgentGraphState) ?? {})
    .addNode("choose-recovery", async (state: RuntimeRecoverySubgraphState) =>
      input.chooseRecovery?.(state as AgentGraphState) ?? {})
    .addNode("recover", async (state: RuntimeRecoverySubgraphState) =>
      input.recover?.(state as AgentGraphState) ?? {})
    .addNode("verify-recovery", async (state: RuntimeRecoverySubgraphState) =>
      input.verifyRecovery?.(state as AgentGraphState) ?? {})
    .addNode("retry-path", async (state: RuntimeRecoverySubgraphState) =>
      input.retryPath?.(state as AgentGraphState) ?? {})
    .addConditionalEdges(START, (state) => {
      const action = state.recoveryDecision?.action;
      return state.currentNode === "triage-failure" && action && action !== "blocked"
        ? "choose-recovery"
        : "diagnose-runtime";
    }, ["diagnose-runtime", "choose-recovery"])
    .addEdge("diagnose-runtime", "choose-recovery")
    .addConditionalEdges("choose-recovery", (state) => {
      const action = state.recoveryDecision?.action;
      return action && action !== "blocked" && !["repair-harness", "repair-environment", "repair-product"].includes(action)
        ? "recover"
        : END;
    }, ["recover", END])
    .addEdge("recover", "verify-recovery")
    .addConditionalEdges("verify-recovery", (state) => recoveryDecisionNeedsRetry(state) ? "retry-path" : END, ["retry-path", END])
    .addEdge("retry-path", END)
    .compile({ checkpointer: input.checkpointer, name: "runtime-recovery-subgraph" });
}

/**
 * Browser execution contains two interrupt-capable authorisation points and
 * its bounded observe/action loop. It must remain a native child so an
 * approval or credential resume cannot replay a browser side effect.
 */
export type BrowserExecutionSubgraphInput = Pick<AgentGraphState,
  | "runId" | "mode" | "projectId" | "requirement" | "permissionProfile" | "planApproved" | "capabilitiesApproved"
  | "status" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt" | "currentNode"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "coverageMap" | "compiledPlan" | "execution"
  | "observation" | "currentCoverageItemId" | "currentAttemptId" | "browserSession" | "browserObservation"
  | "browserDecision" | "browserActionResult" | "browserActionAuthorized" | "browserCredentialAuthorized"
  | "browserAgentRequired" | "browserLoopComplete" | "browserBatchPathCount" | "browserBatchPending"
  | "browserBatchDelayMs" | "browserBatchResumed" | "browserRateLimitRetries" | "remainingPathCount"
>;

export type BrowserExecutionSubgraphOutput = Partial<Pick<BrowserExecutionSubgraphInput,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "capabilitiesApproved" | "execution"
  | "observation" | "currentCoverageItemId" | "currentAttemptId" | "browserSession" | "browserObservation"
  | "browserDecision" | "browserActionResult" | "browserActionAuthorized" | "browserCredentialAuthorized"
  | "browserAgentRequired" | "browserLoopComplete" | "browserBatchPathCount" | "browserBatchPending"
  | "browserBatchDelayMs" | "browserBatchResumed" | "browserRateLimitRetries" | "remainingPathCount"
>>;

export type BrowserExecutionSubgraphState = BrowserExecutionSubgraphInput & BrowserExecutionSubgraphOutput;

export const BrowserExecutionSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  planApproved: Annotation<boolean | undefined>(),
  capabilitiesApproved: Annotation<boolean | undefined>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  compiledPlan: Annotation<CompiledPlanState | undefined>(),
  execution: Annotation<ExecutionState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  currentCoverageItemId: Annotation<string | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  browserSession: Annotation<BrowserSession | undefined>(),
  browserObservation: Annotation<BrowserObservation | undefined>(),
  browserDecision: Annotation<BrowserActionDecision | undefined>(),
  browserActionResult: Annotation<BrowserActionResult | undefined>(),
  browserActionAuthorized: Annotation<boolean | undefined>(),
  browserCredentialAuthorized: Annotation<boolean | undefined>(),
  browserAgentRequired: Annotation<boolean | undefined>(),
  browserLoopComplete: Annotation<boolean | undefined>(),
  browserBatchPathCount: Annotation<number | undefined>(),
  browserBatchPending: Annotation<boolean | undefined>(),
  browserBatchDelayMs: Annotation<number | undefined>(),
  browserBatchResumed: Annotation<boolean | undefined>(),
  browserRateLimitRetries: Annotation<number | undefined>(),
  remainingPathCount: Annotation<number | undefined>()
});

/** Compile the authorised browser loop with native interrupt/resume semantics. */
export function createBrowserExecutionSubgraph(input: {
  prepareSandbox?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  approveCapabilities?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  observeBrowser?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  decideBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  authorizeBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  executeBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  verifyBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  decideNextStep?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(BrowserExecutionSubgraphStateAnnotation)
    .addNode("prepare-sandbox", async (state: BrowserExecutionSubgraphState) =>
      input.prepareSandbox?.(state as AgentGraphState) ?? {})
    .addNode("approve-capabilities", async (state: BrowserExecutionSubgraphState) =>
      input.approveCapabilities?.(state as AgentGraphState) ?? {})
    .addNode("observe-browser", async (state: BrowserExecutionSubgraphState) =>
      input.observeBrowser?.(state as AgentGraphState) ?? {})
    .addNode("decide-browser-action", async (state: BrowserExecutionSubgraphState) =>
      input.decideBrowserAction?.(state as AgentGraphState) ?? {})
    .addNode("authorize-browser-action", async (state: BrowserExecutionSubgraphState) =>
      input.authorizeBrowserAction?.(state as AgentGraphState) ?? {})
    .addNode("execute-browser-action", async (state: BrowserExecutionSubgraphState) =>
      input.executeBrowserAction?.(state as AgentGraphState) ?? {})
    .addNode("verify-browser-action", async (state: BrowserExecutionSubgraphState) =>
      input.verifyBrowserAction?.(state as AgentGraphState) ?? {})
    .addNode("decide-next-step", async (state: BrowserExecutionSubgraphState) =>
      input.decideNextStep?.(state as AgentGraphState) ?? {})
    .addConditionalEdges(START, (state) => state.browserBatchResumed === true ? "observe-browser" : "prepare-sandbox", ["prepare-sandbox", "observe-browser"])
    .addEdge("prepare-sandbox", "approve-capabilities")
    .addConditionalEdges("approve-capabilities", (state) => {
      if (state.execution?.aggregate === true || state.browserAgentRequired !== true) return END;
      return "observe-browser";
    }, ["observe-browser", END])
    .addEdge("observe-browser", "decide-browser-action")
    .addConditionalEdges("decide-browser-action", (state) => {
      if (state.browserDecision?.status === "act" || state.browserDecision?.status === "needs-confirmation") return "authorize-browser-action";
      if (state.browserDecision?.status === "complete" || state.browserDecision?.status === "blocked") return "decide-next-step";
      return END;
    }, ["authorize-browser-action", "decide-next-step", END])
    .addConditionalEdges("authorize-browser-action", (state) =>
      state.browserDecision?.status === "act" ? "execute-browser-action" : END,
    ["execute-browser-action", END])
    .addEdge("execute-browser-action", "verify-browser-action")
    .addConditionalEdges("verify-browser-action", (state) => {
      if (state.browserActionResult?.errorCode === "browser_control_binding_stale" && (state.browserSession?.rebindCount ?? 0) <= 2) return "observe-browser";
      return "decide-next-step";
    }, ["observe-browser", "decide-next-step"])
    .addConditionalEdges("decide-next-step", (state) =>
      state.browserLoopComplete === true || state.browserBatchPending === true ? END : "observe-browser",
    ["observe-browser", END])
    .compile({ checkpointer: input.checkpointer, name: "browser-execution-subgraph" });
}

/**
 * Non-browser execution owns the Worker-result interrupt and the one bounded
 * continuation after Repair. It is native so a Worker resume cannot replay an
 * already-applied result or a repair continuation.
 */
export type NonBrowserExecutionSubgraphInput = Pick<AgentGraphState,
  | "runId" | "mode" | "projectId" | "requirement" | "permissionProfile"
  | "status" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt" | "currentNode"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "interruptAnswer" | "coverageMap"
  | "compiledPlan" | "execution" | "observation" | "currentCoverageItemId" | "currentAttemptId"
  | "browserBatchPending" | "browserBatchDelayMs" | "browserBatchResumed" | "browserBatchPathCount"
  | "continuationPasses" | "remainingPathCount"
>;

export type NonBrowserExecutionSubgraphOutput = Partial<Pick<NonBrowserExecutionSubgraphInput,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "execution" | "observation"
  | "currentCoverageItemId" | "currentAttemptId" | "browserBatchPending" | "browserBatchDelayMs"
  | "browserBatchResumed" | "browserBatchPathCount" | "continuationPasses" | "remainingPathCount"
>>;

export type NonBrowserExecutionSubgraphState = NonBrowserExecutionSubgraphInput & NonBrowserExecutionSubgraphOutput;

export const NonBrowserExecutionSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  interruptAnswer: Annotation<AgentGraphState["interruptAnswer"]>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  compiledPlan: Annotation<CompiledPlanState | undefined>(),
  execution: Annotation<ExecutionState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  currentCoverageItemId: Annotation<string | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  browserBatchPending: Annotation<boolean | undefined>(),
  browserBatchDelayMs: Annotation<number | undefined>(),
  browserBatchResumed: Annotation<boolean | undefined>(),
  browserBatchPathCount: Annotation<number | undefined>(),
  continuationPasses: Annotation<number | undefined>(),
  remainingPathCount: Annotation<number | undefined>()
});

/** Compile Worker execution and its bounded Repair continuation. */
export function createNonBrowserExecutionSubgraph(input: {
  execute?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  continuePaths?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(NonBrowserExecutionSubgraphStateAnnotation)
    .addNode("execute", async (state: NonBrowserExecutionSubgraphState) =>
      input.execute?.(state as AgentGraphState) ?? {})
    .addNode("continue-paths", async (state: NonBrowserExecutionSubgraphState) =>
      input.continuePaths?.(state as AgentGraphState) ?? {})
    .addConditionalEdges(START, (state) => state.currentNode === "repair" ? "continue-paths" : "execute", ["execute", "continue-paths"])
    .addConditionalEdges("continue-paths", (state) =>
      (state.remainingPathCount ?? 0) > 0 && (state.continuationPasses ?? 0) < 1 ? "execute" : END,
    ["execute", END])
    .addEdge("execute", END)
    .compile({ checkpointer: input.checkpointer, name: "non-browser-execution-subgraph" });
}

/**
 * Triage records deterministic failure attribution and may run a selective
 * Judge. The parent only selects the next native Recovery or Repair child;
 * those children own their own durable interrupt/resume frames.
 */
export type FailureTriageSubgraphInput = Pick<AgentGraphState,
  | "runId" | "mode" | "projectId" | "requirement" | "permissionProfile"
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "execution" | "gate" | "observation" | "currentAttemptId" | "failure" | "judge" | "recoveryDecision"
>;

export type FailureTriageSubgraphOutput = Partial<Pick<FailureTriageSubgraphInput,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "gate" | "failure" | "judge" | "recoveryDecision"
>>;

export type FailureTriageSubgraphState = FailureTriageSubgraphInput & FailureTriageSubgraphOutput;

export const FailureTriageSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  execution: Annotation<ExecutionState | undefined>(),
  gate: Annotation<GateState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  failure: Annotation<FailureState | undefined>(),
  judge: Annotation<JudgeState | undefined>(),
  recoveryDecision: Annotation<RecoveryDecision | undefined>()
});

function triageNeedsSelectiveJudge(state: FailureTriageSubgraphState) {
  const action = state.recoveryDecision?.action;
  return state.failure?.needsLlmJudge === true && (!action || action === "blocked");
}

/** Compile deterministic attribution and optional LLM advice behind a typed boundary. */
export function createFailureTriageSubgraph(input: {
  triageFailure?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  selectiveJudge?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(FailureTriageSubgraphStateAnnotation)
    .addNode("triage-failure", async (state: FailureTriageSubgraphState) =>
      input.triageFailure?.(state as AgentGraphState) ?? {})
    .addNode("selective-judge", async (state: FailureTriageSubgraphState) =>
      input.selectiveJudge?.(state as AgentGraphState) ?? {})
    .addEdge(START, "triage-failure")
    .addConditionalEdges("triage-failure", (state) => triageNeedsSelectiveJudge(state) ? "selective-judge" : END, ["selective-judge", END])
    .addEdge("selective-judge", END)
    .compile({ checkpointer: input.checkpointer ?? false, name: "failure-triage-subgraph" });
}

/**
 * Repair is compiled as a native LangGraph child rather than invoked through a
 * function proxy. Native nesting is required here: it carries `interrupt()`'s
 * resume value into the child checkpoint without replaying an already finished
 * assessment phase or exposing unrelated parent state.
 */
export type RepairValidationSubgraphInput = Pick<AgentGraphState,
  | "runId" | "mode" | "projectId" | "permissionProfile" | "status" | "currentNode" | "completedNodes"
  | "progress" | "tokenUsage" | "updatedAt" | "pendingInterrupt" | "interruptOwner"
  | "interruptContext" | "failure" | "observation" | "repairSessionId"
>;

export type RepairValidationSubgraphOutput = Partial<Pick<RepairValidationSubgraphInput,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage" | "updatedAt"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "failure" | "observation" | "repairSessionId"
>>;

export type RepairValidationSubgraphState = RepairValidationSubgraphInput & RepairValidationSubgraphOutput;

export const RepairValidationSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>({
    reducer: (left, right) => Array.from(new Set([...(left ?? []), ...(right ?? [])])),
    default: () => []
  }),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  failure: Annotation<FailureState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  repairSessionId: Annotation<string | undefined>()
});

/** Compile Repair as a native child so its human decision checkpoint is durable. */
export function createRepairValidationSubgraph(input: {
  repair?: (state: AgentGraphState) => Promise<Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt }>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(RepairValidationSubgraphStateAnnotation)
    .addNode("repair", async (state: RepairValidationSubgraphState) =>
      input.repair?.(state as AgentGraphState) ?? {})
    .addEdge(START, "repair")
    .addEdge("repair", END)
    .compile({ checkpointer: input.checkpointer, name: "repair-validation-subgraph" });
}

/**
 * The Evidence/Gate workflow is the first business boundary promoted from a
 * contract-only declaration to a real compiled LangGraph. Keep this state
 * deliberately small: collection must not inspect planning, repair or
 * arbitrary graph state in order to mint a machine decision.
 */
export interface EvidenceGateSubgraphInput {
  runId: string;
  mode: AgentGraphMode;
  projectId?: string;
  requirement?: string;
  execution?: ExecutionState;
  currentAttemptId?: string;
  browserAgentRequired?: boolean;
  browserSession?: BrowserSession;
}

export interface EvidenceGateSubgraphOutput {
  gate?: GateState;
  execution?: ExecutionState;
}

export type EvidenceGateSubgraphState = EvidenceGateSubgraphInput & EvidenceGateSubgraphOutput;

export const EvidenceGateSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  execution: Annotation<ExecutionState | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  browserAgentRequired: Annotation<boolean | undefined>(),
  browserSession: Annotation<BrowserSession | undefined>(),
  gate: Annotation<GateState | undefined>()
});

/**
 * Compile the narrow Evidence/Gate graph independently. The parent graph owns
 * the durable checkpoint and invokes this graph as one high-level node, so
 * existing thread IDs and human-interrupt recovery semantics remain stable.
 * Callers may provide a saver when exercising this graph in isolation.
 */
export function createEvidenceGateSubgraph(input: {
  collectAndGate?: (state: EvidenceGateSubgraphInput) => Promise<EvidenceGateSubgraphOutput>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(EvidenceGateSubgraphStateAnnotation)
    .addNode("collect-and-gate", async (state: EvidenceGateSubgraphInput) =>
      input.collectAndGate?.(state) ?? {})
    .addEdge(START, "collect-and-gate")
    .addEdge("collect-and-gate", END)
    .compile({
      checkpointer: input.checkpointer ?? false,
      name: "evidence-gate-subgraph"
    });
}

/** Finalization consumes only the durable facts needed to publish a terminal Run. */
export interface FinalizationSubgraphInput {
  runId: string;
  mode: AgentGraphMode;
  execution?: ExecutionState;
  gate?: GateState;
  coverageMap?: CoverageMapState;
  discoveryTerminal?: boolean;
  browserAgentRequired?: boolean;
}

export interface FinalizationSubgraphOutput {
  status?: AgentGraphStatus;
  execution?: ExecutionState;
}

export type FinalizationSubgraphState = FinalizationSubgraphInput & FinalizationSubgraphOutput;

export const FinalizationSubgraphStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  execution: Annotation<ExecutionState | undefined>(),
  gate: Annotation<GateState | undefined>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>(),
  browserAgentRequired: Annotation<boolean | undefined>(),
  status: Annotation<AgentGraphStatus | undefined>()
});

export function createFinalizationSubgraph(input: {
  finalize?: (state: FinalizationSubgraphInput) => Promise<FinalizationSubgraphOutput>;
  checkpointer?: BaseCheckpointSaver | false;
}) {
  return new StateGraph(FinalizationSubgraphStateAnnotation)
    .addNode("finalize", async (state: FinalizationSubgraphInput) => input.finalize?.(state) ?? {})
    .addEdge(START, "finalize")
    .addEdge("finalize", END)
    .compile({ checkpointer: input.checkpointer ?? false, name: "finalization-subgraph" });
}

/**
 * Transitional typed boundaries for the main graph. Each contract names the
 * state it is allowed to consume and produce; the graph builder validates that
 * every node belongs to exactly one boundary before compiling a new graph.
 * The node implementations remain independently callable through hooks while
 * the persistence-backed subgraph migration proceeds incrementally.
 */
export const typedSubgraphContracts = [
  {
    name: "discovery",
    nodes: ["intake", "discover"],
    reads: ["runId", "projectId", "requirement", "permissionProfile"],
    writes: ["coverageMap", "observation", "discoveryTerminal"],
    stopConditions: ["runtime_unavailable", "document_not_committed"]
  },
  {
    name: "planning",
    nodes: ["build-coverage-map", "plan", "compile", "approve-plan"],
    reads: ["coverageMap", "requirement", "projectId"],
    writes: ["coverageMap", "planData", "compiledPlan", "planApproved", "planningTerminal"],
    stopConditions: ["plan_rejected", "no_executable_coverage"]
  },
  {
    name: "runtime-recovery",
    nodes: ["diagnose-runtime", "choose-recovery", "recover", "verify-recovery", "retry-path"],
    reads: ["coverageMap", "failure", "recoveryDecision", "recoveryResult", "recoveryAttempts"],
    writes: ["recoveryDecision", "recoveryResult", "recoveryAttempts", "coverageMap", "discoveryTerminal"],
    stopConditions: ["recovery_blocked", "recovery_exhausted"]
  },
  {
    name: "browser-execution",
    nodes: ["prepare-sandbox", "approve-capabilities", "observe-browser", "decide-browser-action", "authorize-browser-action", "execute-browser-action", "verify-browser-action", "decide-next-step"],
    reads: ["compiledPlan", "coverageMap", "browserSession", "browserObservation", "browserDecision", "browserActionResult", "browserAgentRequired"],
    writes: ["execution", "observation", "browserSession", "browserObservation", "browserDecision", "browserActionResult", "browserLoopComplete", "remainingPathCount"],
    stopConditions: ["capability_rejected", "browser_budget_exhausted", "browser_action_blocked"]
  },
  {
    name: "non-browser-execution",
    nodes: ["execute", "continue-paths"],
    reads: ["compiledPlan", "coverageMap", "execution", "currentAttemptId"],
    writes: ["execution", "observation", "remainingPathCount", "continuationPasses"],
    stopConditions: ["worker_result_blocked", "execution_result_missing"]
  },
  {
    name: "evidence-gate",
    nodes: ["collect-and-gate"],
    reads: ["execution", "coverageMap", "observation", "currentAttemptId"],
    writes: ["gate", "execution"],
    stopConditions: ["artifact_missing", "evidence_integrity_failed", "coverage_incomplete"]
  },
  {
    name: "failure-triage",
    nodes: ["triage-failure", "selective-judge"],
    reads: ["projectId", "requirement", "permissionProfile", "gate", "execution", "observation", "currentAttemptId"],
    writes: ["gate", "failure", "judge", "recoveryDecision"],
    stopConditions: ["machine_gate_fail", "machine_gate_blocked", "judge_unavailable"]
  },
  {
    name: "repair-validation",
    nodes: ["repair"],
    reads: ["failure", "gate", "observation", "projectId"],
    writes: ["repairSessionId", "failure", "remainingPathCount"],
    stopConditions: ["repair_rejected", "validation_failed", "write_capability_missing"]
  },
  {
    name: "finalization",
    nodes: ["finalize"],
    reads: ["gate", "failure", "judge", "pendingInterrupt"],
    writes: ["status", "currentNode"],
    stopConditions: ["unresolved_interrupt", "final_status_persisted"]
  }
] as const satisfies readonly TypedSubgraphContract[];

export function assertTypedSubgraphCoverage(nodes: readonly AgentGraphNode[]) {
  const assigned: AgentGraphNode[] = typedSubgraphContracts.flatMap((contract) => contract.nodes);
  const duplicates = assigned.filter((node, index) => assigned.indexOf(node) !== index);
  const missing = nodes.filter((node) => !assigned.includes(node));
  const unexpected = assigned.filter((node) => !nodes.includes(node));
  if (duplicates.length || missing.length || unexpected.length) {
    throw new Error(`typed_subgraph_coverage_invalid:${JSON.stringify({ duplicates, missing, unexpected })}`);
  }
  return typedSubgraphContracts;
}

export function subgraphForNode(node: AgentGraphNode) {
  return typedSubgraphContracts.find((contract) => (contract.nodes as readonly AgentGraphNode[]).includes(node));
}
