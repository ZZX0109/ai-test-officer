import {
  agentGraphNodeSchema,
  agentInterruptSchema,
  type BrowserActionDecision,
  type BrowserActionResult,
  type BrowserObservation,
  type BrowserSession,
  type AgentGraphNode,
  type AgentGraphProjection,
  type AgentInterrupt,
  type AgentPermissionProfile,
  type RepairDecisionAnswer,
  type RecoveryActionResult,
  type RecoveryDecision
} from "@ai-test-officer/contracts";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { randomUUID } from "node:crypto";

export * from "./model.js";

export type AgentGraphMode = "shadow" | "active";
export type AgentGraphStatus = AgentGraphProjection["status"];

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
  interruptContext?: Record<string, unknown>;
  lastError?: AgentGraphProjection["lastError"];
  coverageMap?: Record<string, unknown>;
  planData?: Record<string, unknown>;
  compiledPlan?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  judge?: Record<string, unknown>;
  repairSessionId?: string;
  recoveryDecision?: RecoveryDecision;
  recoveryResult?: RecoveryActionResult;
  recoveryAttempts?: Record<string, number>;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
  observation?: Record<string, unknown>;
  browserSession?: BrowserSession;
  browserObservation?: BrowserObservation;
  browserDecision?: BrowserActionDecision;
  browserActionResult?: BrowserActionResult;
  /** True only for the current decision after a matching interrupt approval. */
  browserActionAuthorized?: boolean;
  /** A credential-use grant is scoped to one run/Playwright session. It lets
   * the agent complete the observed login form after the user has approved
   * the first credential fill, without prompting once for username and again
   * for password. It is never a host, source-write, or future-run grant. */
  browserCredentialAuthorized?: boolean;
  browserAgentRequired?: boolean;
  browserLoopComplete?: boolean;
  /** Number of parent-path continuation passes already dispatched. */
  continuationPasses?: number;
  /** Pending independent coverage paths after a repair/retry. */
  remainingPathCount?: number;
  planningTerminal?: boolean;
  /** True only when no application document can be handed to execution. A
   * committed SPA with controls still loading is not terminal; the long-lived
   * browser Agent performs the authoritative runtime observation. */
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
  authorizeBrowserAction?: (state: AgentGraphState, resume?: Record<string, unknown>) => Promise<Partial<AgentGraphState> & { browserInterrupt?: AgentInterrupt }>;
  executeBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  verifyBrowserAction?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  decideNextStep?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  execute?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  collectAndGate?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  triageFailure?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  diagnoseRuntime?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  chooseRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  recover?: (state: AgentGraphState) => Promise<Partial<AgentGraphState> & { recoveryInterrupt?: AgentInterrupt }>;
  verifyRecovery?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  retryPath?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  continuePaths?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  selectiveJudge?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  repair?: (state: AgentGraphState, resume?: RepairDecisionAnswer) => Promise<Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt }>;
  finalize?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  onProjection?: (projection: AgentGraphProjection) => Promise<void>;
}

const orderedNodes: AgentGraphNode[] = [
  "intake",
  "discover",
  "diagnose-runtime",
  "choose-recovery",
  "recover",
  "verify-recovery",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities",
  "observe-browser",
  "decide-browser-action",
  "authorize-browser-action",
  "execute-browser-action",
  "verify-browser-action",
  "decide-next-step",
  "execute",
  "collect-and-gate",
  "triage-failure",
  "selective-judge",
  "repair",
  "retry-path",
  "continue-paths",
  "finalize"
];

const GraphState = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  requirement: Annotation<string | undefined>(),
  projectId: Annotation<string | undefined>(),
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
  tokenUsage: Annotation<number>({
    // Hooks report the authoritative total from the persisted invocation
    // ledger. Summing node replays double-counts tokens after checkpoint
    // recovery, which made the Workbench budget indicator misleading.
    reducer: (_left, right) => right ?? 0,
    default: () => 0
  }),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<Record<string, unknown> | undefined>(),
  lastError: Annotation<AgentGraphProjection["lastError"] | undefined>(),
  coverageMap: Annotation<Record<string, unknown> | undefined>(),
  planData: Annotation<Record<string, unknown> | undefined>(),
  compiledPlan: Annotation<Record<string, unknown> | undefined>(),
  execution: Annotation<Record<string, unknown> | undefined>(),
  gate: Annotation<Record<string, unknown> | undefined>(),
  failure: Annotation<Record<string, unknown> | undefined>(),
  judge: Annotation<Record<string, unknown> | undefined>(),
  repairSessionId: Annotation<string | undefined>(),
  recoveryDecision: Annotation<RecoveryDecision | undefined>(),
  recoveryResult: Annotation<RecoveryActionResult | undefined>(),
  recoveryAttempts: Annotation<Record<string, number> | undefined>(),
  currentCoverageItemId: Annotation<string | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  observation: Annotation<Record<string, unknown> | undefined>(),
  browserSession: Annotation<BrowserSession | undefined>(),
  browserObservation: Annotation<BrowserObservation | undefined>(),
  browserDecision: Annotation<BrowserActionDecision | undefined>(),
  browserActionResult: Annotation<BrowserActionResult | undefined>(),
  browserActionAuthorized: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserCredentialAuthorized: Annotation<boolean>({ reducer: (left, right) => right ?? left ?? false, default: () => false }),
  browserAgentRequired: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserLoopComplete: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  continuationPasses: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  remainingPathCount: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  planningTerminal: Annotation<boolean | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>(),
  updatedAt: Annotation<string>()
});

function now() {
  return new Date().toISOString();
}

function projection(state: AgentGraphState): AgentGraphProjection {
  return {
    schemaVersion: "1.0",
    runId: state.runId,
    threadId: state.runId,
    mode: state.mode,
    status: state.status,
    currentNode: state.currentNode,
    completedNodes: state.completedNodes,
    progress: state.progress,
    pendingInterrupt: state.pendingInterrupt,
    interruptOwner: state.interruptOwner,
    interruptContext: state.interruptContext,
    lastError: state.lastError,
    tokenUsage: state.tokenUsage,
    repairSessionId: state.repairSessionId,
    recoveryDecision: state.recoveryDecision,
    recoveryResult: state.recoveryResult,
    recoveryAttempts: state.recoveryAttempts,
    currentCoverageItemId: state.currentCoverageItemId,
    currentAttemptId: state.currentAttemptId,
    observation: state.observation,
    browserSession: state.browserSession,
    browserObservation: state.browserObservation,
    browserDecision: state.browserDecision,
    browserActionResult: state.browserActionResult,
    browserAgentRequired: state.browserAgentRequired ?? false,
    browserLoopComplete: state.browserLoopComplete ?? false,
    continuationPasses: state.continuationPasses ?? 0,
    remainingPathCount: state.remainingPathCount ?? 0,
    updatedAt: state.updatedAt
  };
}

function makeNode(
  node: AgentGraphNode,
  hook: ((state: AgentGraphState) => Promise<Partial<AgentGraphState>>) | undefined,
  hooks: AgentGraphHooks
) {
  return async (state: AgentGraphState) => {
    const index = orderedNodes.indexOf(node);
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: node,
      pendingInterrupt: undefined,
      progress: index / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));
    try {
      const update = await hook?.(started) ?? {};
      const completed: AgentGraphState = {
        ...started,
        ...update,
        completedNodes: Array.from(new Set([...started.completedNodes, node])),
        progress: (index + 1) / orderedNodes.length,
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(completed));
      return {
        ...update,
        status: completed.status,
        currentNode: node,
        completedNodes: [node],
        progress: completed.progress,
        pendingInterrupt: undefined,
        updatedAt: completed.updatedAt
      };
    } catch (error) {
      const failed: AgentGraphState = {
        ...started,
        status: "failed",
        lastError: {
          code: error instanceof Error ? error.message.split(":")[0] : "agent_graph_failed",
          message: error instanceof Error ? error.message : "Agent graph failed",
          node
        },
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(failed));
      throw error;
    }
  };
}

function approvalNode(kind: "plan-approval" | "browser-permission", hooks: AgentGraphHooks) {
  const node: AgentGraphNode = kind === "plan-approval" ? "approve-plan" : "approve-capabilities";
  return async (state: AgentGraphState) => {
    if (state.mode === "shadow") {
      return {
        currentNode: node,
        completedNodes: [node],
        progress: (orderedNodes.indexOf(node) + 1) / orderedNodes.length,
        updatedAt: now()
      };
    }
    const alreadyApproved = kind === "plan-approval" ? state.planApproved : state.capabilitiesApproved;
    if (alreadyApproved) {
      return {
        currentNode: node,
        completedNodes: [node],
        pendingInterrupt: undefined,
        progress: (orderedNodes.indexOf(node) + 1) / orderedNodes.length,
        updatedAt: now()
      };
    }
    const coverageItems = Array.isArray(state.coverageMap?.items)
      ? state.coverageMap.items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      : [];
    const requestedCapabilities = kind === "plan-approval"
      ? []
      : Array.from(new Set(coverageItems.flatMap((item) => {
          switch (item.surface) {
            case "page": return ["browserControl"];
            case "api":
            case "background-task": return ["targetNetwork"];
            case "data": return ["dataRead"];
            default: return ["sandboxCommand"];
          }
        })));
    const pending: AgentInterrupt = {
      id: `interrupt_${randomUUID()}`,
      runId: state.runId,
      kind,
      status: "pending",
      title: kind === "plan-approval" ? "确认测试计划" : "确认本次测试权限",
      detail: kind === "plan-approval"
        ? "测试计划已编译，确认后才会准备沙盒。"
        : "授权只对本次沙盒运行生效，并按实际路径限制浏览器、目标网络、数据读取或命令检查能力。",
      requestedCapabilities,
      payload: {},
      createdAt: now()
    };
    await hooks.onProjection?.(projection({
      ...state,
      status: "interrupted",
      currentNode: node,
      pendingInterrupt: pending,
      progress: orderedNodes.indexOf(node) / orderedNodes.length,
      updatedAt: now()
    }));
    const answer = interrupt(pending) as { approved?: boolean };
    if (!answer?.approved) throw new Error(`${kind}_rejected`);
    return {
      ...(kind === "plan-approval" ? { planApproved: true } : { capabilitiesApproved: true }),
      currentNode: node,
      completedNodes: [node],
      pendingInterrupt: undefined,
      status: "running" as const,
      progress: (orderedNodes.indexOf(node) + 1) / orderedNodes.length,
      updatedAt: now()
    };
  };
}

function discoveryStatus(state: Pick<AgentGraphState, "coverageMap">) {
  const discovery = state.coverageMap?.discovery;
  if (!discovery || typeof discovery !== "object") return undefined;
  const status = (discovery as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

/** Active mode preserves the static plan even when runtime Discovery needs
 * recovery. Only an actual terminal runtime condition is routed away from the
 * browser Agent; a committed cold-loading SPA is handled by execution. */
function discoveryNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    if (state.mode === "shadow") return makeNode("discover", hooks.discover, hooks)(state);

    const index = orderedNodes.indexOf("discover");
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: "discover",
      pendingInterrupt: undefined,
      progress: index / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));

    try {
      // Waiting is now handled by the recovery loop instead of an opaque
      // browser-permission interrupt. This lets the Agent explain whether the
      // blocker is startup, auth, network or DOM and offer the correct action.
      // The recovery node owns the bounded retry/credential interrupt.
      const update = await hooks.discover?.(started) ?? {};
      const discoveredStatus = discoveryStatus({ coverageMap: update.coverageMap ?? started.coverageMap });
      if (discoveredStatus === "waiting") {
        (update as Partial<AgentGraphState>).discoveryTerminal = true;
      } else if (discoveredStatus === "ready") {
        // A successful retry must clear the previous terminal marker; state
        // reducers intentionally preserve fields that a hook omits.
        (update as Partial<AgentGraphState>).discoveryTerminal = false;
      }

      const completed: AgentGraphState = {
        ...started,
        ...update,
        completedNodes: Array.from(new Set([...started.completedNodes, "discover" as const])),
        progress: (index + 1) / orderedNodes.length,
        pendingInterrupt: undefined,
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(completed));
      return {
        ...update,
        status: completed.status,
        currentNode: "discover" as const,
        completedNodes: ["discover" as const],
        progress: completed.progress,
        pendingInterrupt: undefined,
        updatedAt: completed.updatedAt
      };
    } catch (error) {
      const failed: AgentGraphState = {
        ...started,
        status: "failed",
        lastError: {
          code: error instanceof Error ? error.message.split(":")[0] : "agent_graph_failed",
          message: error instanceof Error ? error.message : "Agent graph failed",
          node: "discover"
        },
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(failed));
      throw error;
    }
  };
}

function executionNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    if (state.mode === "shadow") return makeNode("execute", hooks.execute, hooks)(state);
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: "execute",
      progress: orderedNodes.indexOf("execute") / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));
    const pending: AgentInterrupt = {
      id: `interrupt_${randomUUID()}`,
      runId: state.runId,
      kind: "execution-result",
      status: "pending",
      title: "等待执行 Worker",
      detail: "任务已进入 BullMQ；浏览器、API 和证据结果提交后会自动恢复。",
      requestedCapabilities: [],
      payload: {},
      createdAt: now()
    };
    await hooks.onProjection?.(projection({
      ...started,
      status: "interrupted",
      pendingInterrupt: pending,
      updatedAt: now()
    }));
    const answer = interrupt(pending) as { execution?: Record<string, unknown> };
    if (!answer?.execution) throw new Error("execution_result_missing");
    const update = await hooks.execute?.({ ...started, execution: answer.execution }) ?? {};
    return {
      ...update,
      execution: answer.execution,
      currentNode: "execute" as const,
      completedNodes: ["execute" as const],
      pendingInterrupt: undefined,
      status: "running" as const,
      progress: (orderedNodes.indexOf("execute") + 1) / orderedNodes.length,
      updatedAt: now()
    };
  };
}

/** Checkpoint a browser action that needs credentials or a risky UI operation. */
function browserAuthorizationNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    if (state.mode === "shadow") return makeNode("authorize-browser-action", hooks.authorizeBrowserAction, hooks)(state);
    const node: AgentGraphNode = "authorize-browser-action";
    const index = orderedNodes.indexOf(node);
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: node,
      pendingInterrupt: undefined,
      progress: index / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));
    const assessed = await hooks.authorizeBrowserAction?.(started) ?? {};
    const { browserInterrupt, ...rest } = assessed as Partial<AgentGraphState> & { browserInterrupt?: AgentInterrupt };
    let update = rest;
    if (browserInterrupt) {
      await hooks.onProjection?.(projection({
        ...started,
        ...rest,
        status: "interrupted",
        pendingInterrupt: browserInterrupt,
        interruptOwner: browserInterrupt.owner,
        interruptContext: browserInterrupt.context,
        updatedAt: now()
      }));
      const answer = interrupt(browserInterrupt) as Record<string, unknown>;
      const resumed = await hooks.authorizeBrowserAction?.({ ...started, ...rest }, answer) ?? rest;
      const { browserInterrupt: _ignored, ...resumedRest } = resumed as Partial<AgentGraphState> & { browserInterrupt?: AgentInterrupt };
      update = resumedRest;
    }
    return {
      ...update,
      status: "running" as const,
      currentNode: node,
      completedNodes: [node],
      pendingInterrupt: undefined,
      interruptOwner: undefined,
      interruptContext: undefined,
      progress: (index + 1) / orderedNodes.length,
      updatedAt: now()
    };
  };
}

/**
 * Repair is the human-in-the-loop hub: when the triage attributes the failure
 * to a user / environment / developer owned cause (or the agent lacks sandbox
 * write access), the node raises a real LangGraph `interrupt()` carrying the
 * problem, the diagnosis performed so far, the suggested handling, and the
 * concrete operations the human may choose. The graph pauses here until the
 * caller resumes the same `thread_id` with a `Command({ resume })` answer, after
 * which the chosen action is applied. Even agent-owned selector or harness
 * repairs pause here: the model may explain and propose a sandbox patch, but
 * neither a sandbox write nor an original-source write can happen without an
 * explicit user decision.
 *
 * The assessment pass and the resume pass are separated by the idempotency
 * `attempt` (1 = assess, 2 = apply) so a restart that replays the assessment
 * never re-applies the user's decision.
 */
function repairNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    if (state.mode === "shadow") {
      // Shadow runs compare routing only. They must not create repair sessions,
      // invoke a provider, write a patch, or raise a user interrupt.
      const index = orderedNodes.indexOf("repair");
      return {
        status: "running" as const,
        currentNode: "repair" as const,
        completedNodes: ["repair" as const],
        progress: (index + 1) / orderedNodes.length,
        observation: {
          ...(state.observation ?? {}),
          stage: "repair",
          status: "blocked",
          summary: "Shadow 模式仅记录修复路由，不执行模型调用或沙盒写入。"
        },
        updatedAt: now()
      };
    }
    const index = orderedNodes.indexOf("repair");
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: "repair",
      pendingInterrupt: undefined,
      progress: index / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));

    const assessed = await hooks.repair?.(started) ?? {};
    const { repairInterrupt, ...assessedRest } = assessed as Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt };
    if (repairInterrupt) {
      const pending = repairInterrupt;
      await hooks.onProjection?.(projection({
        ...started,
        ...assessedRest,
        status: "interrupted",
        currentNode: "repair",
        pendingInterrupt: pending,
        interruptOwner: pending.owner,
        interruptContext: pending.context,
        progress: index / orderedNodes.length,
        updatedAt: now()
      }));
      // Real pause: the graph checkpoints and waits for Command({ resume }).
      const answer = interrupt(pending) as RepairDecisionAnswer;
      const update = await hooks.repair?.({ ...started, ...assessedRest, pendingInterrupt: undefined }, answer) ?? assessedRest;
      const { repairInterrupt: _ignored, ...updateRest } = update as Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt };
      const completed: AgentGraphState = {
        ...started,
        ...updateRest,
        currentNode: "repair",
        completedNodes: Array.from(new Set([...started.completedNodes, "repair" as const])),
        progress: (index + 1) / orderedNodes.length,
        pendingInterrupt: undefined,
        interruptOwner: undefined,
        interruptContext: undefined,
        status: "running",
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(completed));
      return {
        ...updateRest,
        status: "running",
        currentNode: "repair",
        completedNodes: ["repair" as const],
        progress: (index + 1) / orderedNodes.length,
        pendingInterrupt: undefined,
        interruptOwner: undefined,
        interruptContext: undefined,
        updatedAt: now()
      };
    }

    const completed: AgentGraphState = {
      ...started,
      ...assessedRest,
      currentNode: "repair",
      completedNodes: Array.from(new Set([...started.completedNodes, "repair" as const])),
      progress: (index + 1) / orderedNodes.length,
      pendingInterrupt: undefined,
      status: "running",
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(completed));
    return {
      ...assessedRest,
      status: "running",
      currentNode: "repair",
      completedNodes: ["repair" as const],
      progress: (index + 1) / orderedNodes.length,
      pendingInterrupt: undefined,
      updatedAt: now()
    };
  };
}

/**
 * Executes a bounded recovery action. Risky recovery tools can return an
 * interrupt carrier; LangGraph checkpoints and resumes the same thread.
 */
function recoveryNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    const node: AgentGraphNode = "recover";
    const index = orderedNodes.indexOf(node);
    const started: AgentGraphState = {
      ...state,
      status: "running",
      currentNode: node,
      pendingInterrupt: undefined,
      progress: index / orderedNodes.length,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));
    const output = await hooks.recover?.(started) ?? {};
    const { recoveryInterrupt, ...rest } = output as Partial<AgentGraphState> & { recoveryInterrupt?: AgentInterrupt };
    if (recoveryInterrupt) {
      await hooks.onProjection?.(projection({
        ...started,
        ...rest,
        status: "interrupted",
        currentNode: node,
        pendingInterrupt: recoveryInterrupt,
        interruptOwner: recoveryInterrupt.owner,
        interruptContext: recoveryInterrupt.context,
        updatedAt: now()
      }));
      const answer = interrupt(recoveryInterrupt) as Record<string, unknown>;
      const resumed = await hooks.recover?.({
        ...started,
        ...rest,
        pendingInterrupt: undefined,
        interruptOwner: undefined,
        interruptContext: undefined,
        interruptAnswer: answer
      } as AgentGraphState) ?? rest;
      return {
        ...resumed,
        status: "running" as const,
        currentNode: node,
        completedNodes: [node],
        pendingInterrupt: undefined,
        interruptOwner: undefined,
        interruptContext: undefined,
        progress: (index + 1) / orderedNodes.length,
        updatedAt: now()
      };
    }
    return {
      ...rest,
      status: "running" as const,
      currentNode: node,
      completedNodes: [node],
      pendingInterrupt: undefined,
      progress: (index + 1) / orderedNodes.length,
      updatedAt: now()
    };
  };
}

/**
 * Safety net: a node must never finalize while a human-in-the-loop interrupt is
 * still unresolved. The real `interrupt()` in `repairNode` already pauses the
 * graph, so this guard only protects against programming errors that would
 * otherwise let `finalize` run with a dangling pending interrupt.
 */
function finalizeNode(hooks: AgentGraphHooks) {
  return async (state: AgentGraphState) => {
    if (state.pendingInterrupt?.status === "pending") {
      return {
        status: "interrupted" as const,
        currentNode: "finalize" as const,
        pendingInterrupt: state.pendingInterrupt
      };
    }
    return makeNode("finalize", hooks.finalize, hooks)(state);
  };
}

/**
 * Extracts the interrupt a suspended graph is actually waiting on.
 *
 * A `interrupt()` call unwinds the node, so nothing the node was about to
 * return — including our mirrored `pendingInterrupt` channel — is committed to
 * the checkpoint. LangGraph instead records the pending value on the task
 * descriptor, which is what a restarted process must read to know a human
 * decision is still outstanding.
 */
function liveInterrupt(snapshot: { tasks?: readonly unknown[] }): AgentInterrupt | undefined {
  for (const task of snapshot.tasks ?? []) {
    const interrupts = (task as { interrupts?: readonly unknown[] }).interrupts ?? [];
    for (const entry of interrupts) {
      const value = (entry as { value?: unknown }).value;
      const parsed = agentInterruptSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

export async function createAgentCheckpointer(input?: { databaseUrl?: string; schema?: string }) {
  if (!input?.databaseUrl) return new MemorySaver();
  const saver = PostgresSaver.fromConnString(input.databaseUrl, { schema: input.schema ?? "langgraph" });
  await saver.setup();
  return saver;
}

export function createAgentOrchestrationGraph(input: {
  checkpointer: BaseCheckpointSaver;
  hooks?: AgentGraphHooks;
}) {
  const hooks = input.hooks ?? {};
  const graph = new StateGraph(GraphState)
    .addNode("intake", makeNode("intake", hooks.intake, hooks))
    .addNode("discover", discoveryNode(hooks))
    .addNode("diagnose-runtime", makeNode("diagnose-runtime", hooks.diagnoseRuntime, hooks))
    .addNode("choose-recovery", makeNode("choose-recovery", hooks.chooseRecovery, hooks))
    .addNode("recover", recoveryNode(hooks))
    .addNode("verify-recovery", makeNode("verify-recovery", hooks.verifyRecovery, hooks))
    .addNode("build-coverage-map", makeNode("build-coverage-map", hooks.buildCoverageMap, hooks))
    .addNode("plan", makeNode("plan", hooks.plan, hooks))
    .addNode("compile", makeNode("compile", hooks.compile, hooks))
    .addNode("approve-plan", approvalNode("plan-approval", hooks))
    .addNode("prepare-sandbox", makeNode("prepare-sandbox", hooks.prepareSandbox, hooks))
    .addNode("approve-capabilities", approvalNode("browser-permission", hooks))
    .addNode("observe-browser", makeNode("observe-browser", hooks.observeBrowser, hooks))
    .addNode("decide-browser-action", makeNode("decide-browser-action", hooks.decideBrowserAction, hooks))
    .addNode("authorize-browser-action", browserAuthorizationNode(hooks))
    .addNode("execute-browser-action", makeNode("execute-browser-action", hooks.executeBrowserAction, hooks))
    .addNode("verify-browser-action", makeNode("verify-browser-action", hooks.verifyBrowserAction, hooks))
    .addNode("decide-next-step", makeNode("decide-next-step", hooks.decideNextStep, hooks))
    .addNode("execute", executionNode(hooks))
    .addNode("collect-and-gate", makeNode("collect-and-gate", hooks.collectAndGate, hooks))
    .addNode("triage-failure", makeNode("triage-failure", hooks.triageFailure, hooks))
    .addNode("selective-judge", makeNode("selective-judge", hooks.selectiveJudge, hooks))
    .addNode("repair", repairNode(hooks))
    .addNode("retry-path", makeNode("retry-path", hooks.retryPath, hooks))
    .addNode("continue-paths", makeNode("continue-paths", hooks.continuePaths, hooks))
    .addNode("finalize", finalizeNode(hooks))
    .addEdge(START, "intake")
    .addEdge("intake", "discover")
    // Runtime discovery is an execution-readiness signal, not the source of
    // truth for the static business inventory.  Always compile and expose the
    // code-derived coverage map before routing a blocked page into recovery;
    // otherwise a login wall or a dead port replaces the entire full-scan
    // plan with one generic error card.
    .addEdge("discover", "build-coverage-map")
    .addEdge("diagnose-runtime", "choose-recovery")
    .addConditionalEdges("choose-recovery", (state) => {
      const action = state.recoveryDecision?.action;
      if (action === "repair-harness" || action === "repair-environment" || action === "repair-product") return "repair";
      return action && action !== "blocked" ? "recover" : "finalize";
    }, ["recover", "repair", "finalize"])
    .addEdge("recover", "verify-recovery")
    .addConditionalEdges("verify-recovery", (state) => {
      const action = state.recoveryDecision?.action;
      const status = state.recoveryResult?.status;
      // A runtime/discovery repair made *after* a path attempt failed must not
      // jump straight back to execute. Its durable Run is still `judging` and
      // must first become `queued` through retry-path; otherwise the new
      // Worker result is (correctly) rejected as a stale write. Pre-execution
      // Discovery recovery has no failure carrier and can safely re-scan.
      const retryingAnExecutedPath = Boolean(state.failure?.status && state.failure.status !== "pass");
      if (status === "completed" && (action === "retry-path" || (retryingAnExecutedPath && (action === "retry-runtime" || action === "retry-discovery")))) return "retry-path";
      if (status === "completed" && (action === "retry-runtime" || action === "retry-discovery")) return "discover";
      return "finalize";
    }, ["discover", "retry-path", "finalize"])
    .addEdge("retry-path", "execute")
    .addEdge("build-coverage-map", "plan")
    .addConditionalEdges("plan", (state) => state.planningTerminal === true ? "finalize" : "compile", ["compile", "finalize"])
    .addConditionalEdges("compile", (state) =>
      state.mode === "active" && state.discoveryTerminal === true ? "diagnose-runtime" : "approve-plan",
    ["diagnose-runtime", "approve-plan"])
    .addEdge("approve-plan", "prepare-sandbox")
    .addEdge("prepare-sandbox", "approve-capabilities")
    .addConditionalEdges("approve-capabilities", (state) => state.browserAgentRequired === true ? "observe-browser" : "execute", ["observe-browser", "execute"])
    .addEdge("observe-browser", "decide-browser-action")
    .addConditionalEdges("decide-browser-action", (state) => {
      if (state.browserDecision?.status === "act" || state.browserDecision?.status === "needs-confirmation") return "authorize-browser-action";
      if (state.browserDecision?.status === "complete" || state.browserDecision?.status === "blocked") return "decide-next-step";
      return "finalize";
    }, ["authorize-browser-action", "decide-next-step", "finalize"])
    .addConditionalEdges("authorize-browser-action", (state) => state.browserDecision?.status === "act" ? "execute-browser-action" : "finalize", ["execute-browser-action", "finalize"])
    .addEdge("execute-browser-action", "verify-browser-action")
    .addConditionalEdges("verify-browser-action", (state) => {
      if (state.browserActionResult?.errorCode === "browser_control_binding_stale" && (state.browserSession?.rebindCount ?? 0) <= 2) return "observe-browser";
      return "decide-next-step";
    }, ["observe-browser", "decide-next-step"])
    .addConditionalEdges("decide-next-step", (state) => {
      if (state.browserLoopComplete === true) {
        return (state.remainingPathCount ?? 0) > 0
          || (state.compiledPlan && Object.keys(state.compiledPlan).length > 0)
          ? "execute"
          : "collect-and-gate";
      }
      return "observe-browser";
    }, ["observe-browser", "execute", "collect-and-gate"])
    .addEdge("execute", "collect-and-gate")
    .addEdge("collect-and-gate", "triage-failure")
    .addConditionalEdges("triage-failure", (state) => {
      const failure = state.failure ?? {};
      if (!Object.keys(failure).length) return "finalize";
      // A repair decision may be useful to the user even when this Run does
      // not have sandbox-write capability. Do not suspend the execution graph
      // on a developer interrupt that cannot be approved in this run (this
      // used to leave benchmark/path runs permanently in `judging`). The
      // persisted repair plan remains available for an explicit repair session.
      if (state.recoveryDecision?.action && ["repair-harness", "repair-environment", "repair-product"].includes(state.recoveryDecision.action) && failure.repairable !== true) return "finalize";
      if (state.recoveryDecision?.action && state.recoveryDecision.action !== "blocked") return "choose-recovery";
      if (failure.needsLlmJudge === true) return "selective-judge";
      if (failure.repairable === true) return "repair";
      return "finalize";
    }, ["choose-recovery", "selective-judge", "repair", "finalize"])
    .addConditionalEdges("selective-judge", (state) =>
      state.failure?.repairable === true ? "repair" : "finalize",
    ["repair", "finalize"])
    .addEdge("repair", "continue-paths")
    .addConditionalEdges("continue-paths", (state) => {
      // A repaired parent run must return to the executor exactly once before
      // finalization.  The hook records the durable pending-path count and the
      // pass counter, so a replay after restart cannot spin forever.
      if ((state.remainingPathCount ?? 0) > 0 && (state.continuationPasses ?? 0) < 1) return "execute";
      return "finalize";
    }, ["execute", "finalize"])
    .addEdge("finalize", END)
    .compile({ checkpointer: input.checkpointer });

  return {
    graph,
    async start(payload: AgentGraphInput) {
      return graph.invoke({
        ...payload,
        status: "running",
        completedNodes: [],
        progress: 0,
        tokenUsage: 0,
        updatedAt: now()
      }, {
        configurable: { thread_id: payload.runId },
        // One browser action spans observe/decide/authorize/execute/verify/
        // route nodes. The product budget permits up to 20 actions, so the
        // LangGraph default of 25 supersteps terminated valid autonomous runs
        // after merely filling login fields. Business budgets remain the
        // authoritative loop bound; this ceiling only stays above them.
        recursionLimit: 200
      });
    },
    async resume(runId: string, value: Record<string, unknown>) {
      return graph.invoke(new Command({ resume: value }), {
        configurable: { thread_id: runId },
        recursionLimit: 200
      });
    },
    async state(runId: string) {
      const snapshot = await graph.getState({ configurable: { thread_id: runId } });
      const values = snapshot.values as AgentGraphState;
      if (!values?.runId) return undefined;
      // `interrupt()` throws, so the pausing node never commits its return
      // value: the mirrored `pendingInterrupt` channel is empty while the graph
      // is suspended. LangGraph's own task descriptors are the only source of
      // truth here, so read the live interrupt from the checkpoint first and
      // only fall back to the committed channel.
      const live = liveInterrupt(snapshot);
      const pendingInterrupt = live ?? values.pendingInterrupt;
      const status: AgentGraphStatus = snapshot.next.length === 0 && !live
        ? values.lastError ? "failed" : "completed"
        : pendingInterrupt ? "interrupted" : values.status;
      return projection({
        ...values,
        status,
        pendingInterrupt,
        interruptOwner: pendingInterrupt?.owner ?? values.interruptOwner,
        interruptContext: pendingInterrupt?.context ?? values.interruptContext
      });
    }
  };
}

export function assertAgentGraphNodes() {
  return orderedNodes.map((node) => agentGraphNodeSchema.parse(node));
}
