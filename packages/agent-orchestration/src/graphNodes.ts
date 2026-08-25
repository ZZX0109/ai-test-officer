import { Annotation, interrupt } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { agentInterruptSchema } from "@ai-test-officer/contracts";
import { toJsonObject } from "./state.js";
import type {
  AgentGraphHooks,
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphProjection,
  AgentGraphState,
  AgentGraphStatus,
  AgentInterrupt,
  AgentPermissionProfile,
  AgentResumePayload,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  RecoveryActionResult,
  RecoveryDecision,
  RepairDecisionAnswer
} from "./state.js";

export const orderedNodes: AgentGraphNode[] = [
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

export const GraphState = Annotation.Root({
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
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  lastError: Annotation<AgentGraphProjection["lastError"] | undefined>(),
  coverageMap: Annotation<AgentGraphState["coverageMap"]>(),
  planData: Annotation<AgentGraphState["planData"]>(),
  compiledPlan: Annotation<AgentGraphState["compiledPlan"]>(),
  execution: Annotation<AgentGraphState["execution"]>(),
  gate: Annotation<AgentGraphState["gate"]>(),
  failure: Annotation<AgentGraphState["failure"]>(),
  judge: Annotation<AgentGraphState["judge"]>(),
  repairSessionId: Annotation<string | undefined>(),
  recoveryDecision: Annotation<RecoveryDecision | undefined>(),
  recoveryResult: Annotation<RecoveryActionResult | undefined>(),
  recoveryAttempts: Annotation<Record<string, number> | undefined>(),
  currentCoverageItemId: Annotation<string | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  observation: Annotation<AgentGraphState["observation"]>(),
  browserSession: Annotation<BrowserSession | undefined>(),
  browserObservation: Annotation<BrowserObservation | undefined>(),
  browserDecision: Annotation<BrowserActionDecision | undefined>(),
  browserActionResult: Annotation<BrowserActionResult | undefined>(),
  browserActionAuthorized: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserCredentialAuthorized: Annotation<boolean>({ reducer: (left, right) => right ?? left ?? false, default: () => false }),
  browserAgentRequired: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserLoopComplete: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserBatchPathCount: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  browserBatchPending: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserBatchDelayMs: Annotation<number | undefined>(),
  browserBatchResumed: Annotation<boolean>({ reducer: (_left, right) => right ?? false, default: () => false }),
  browserRateLimitRetries: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  continuationPasses: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  remainingPathCount: Annotation<number>({ reducer: (_left, right) => right ?? 0, default: () => 0 }),
  planningTerminal: Annotation<boolean | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>(),
  updatedAt: Annotation<string>()
});

export function now() {
  return new Date().toISOString();
}

export function projection(state: AgentGraphState): AgentGraphProjection {
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

export function makeNode(
  node: AgentGraphNode,
  hook: ((state: AgentGraphState) => Promise<Partial<AgentGraphState>>) | undefined,
  hooks: AgentGraphHooks
) {
  return async (state: AgentGraphState) => {
    const index = orderedNodes.indexOf(node);
    const started: AgentGraphState = {
      ...state,
      status: "running" as const,
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

export function approvalNode(kind: "plan-approval" | "browser-permission", hooks: AgentGraphHooks) {
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
    const coverageItems = state.coverageMap?.items ?? [];
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
    const answer = interrupt(pending) as AgentResumePayload;
    if (!answer?.approved) throw new Error(`${kind}_rejected`);
    return {
      ...(kind === "plan-approval" ? { planApproved: true } : { capabilitiesApproved: true }),
      // A delegated parent can be waiting at this approval checkpoint while
      // its child paths finish in independent Graph threads. Preserve the
      // aggregate resume payload so the routing edge can jump directly to
      // Evidence & Gate instead of entering the browser loop on the parent.
      ...(answer.execution ? { execution: answer.execution } : {}),
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
  return discovery.status;
}

/** Active mode preserves the static plan even when runtime Discovery needs
 * recovery. Only an actual terminal runtime condition is routed away from the
 * browser Agent; a committed cold-loading SPA is handled by execution. */
export function discoveryNode(hooks: AgentGraphHooks) {
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

export function executionNode(hooks: AgentGraphHooks) {
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
    const browserBatch = state.browserBatchPending === true;
    const pending: AgentInterrupt = {
      id: `interrupt_${randomUUID()}`,
      runId: state.runId,
      kind: "execution-result",
      status: "pending",
      title: browserBatch ? "继续下一批页面测试" : "等待执行 Worker",
      detail: browserBatch
        ? "当前页面批次已持久化，系统将自动恢复下一批，避免长流程占用同一次图调用。"
        : "任务已进入 BullMQ；浏览器、API 和证据结果提交后会自动恢复。",
      requestedCapabilities: [],
      payload: browserBatch ? {
        phase: "browser-batch",
        delayMs: Math.max(0, Math.min(state.browserBatchDelayMs ?? 0, 30_000))
      } : {},
      createdAt: now()
    };
    await hooks.onProjection?.(projection({
      ...started,
      status: "interrupted",
      pendingInterrupt: pending,
      updatedAt: now()
    }));
    const answer = interrupt(pending) as AgentResumePayload;
    if (browserBatch) {
      if (answer?.execution?.phase !== "browser-batch") throw new Error("browser_batch_resume_missing");
      return {
        browserBatchPending: false,
        browserBatchDelayMs: undefined,
        browserBatchResumed: true,
        browserBatchPathCount: 0,
        currentNode: "execute" as const,
        completedNodes: ["execute" as const],
        pendingInterrupt: undefined,
        status: "running" as const,
        progress: (orderedNodes.indexOf("execute") + 1) / orderedNodes.length,
        updatedAt: now()
      };
    }
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
export function browserAuthorizationNode(hooks: AgentGraphHooks) {
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
        interruptContext: toJsonObject(browserInterrupt.context),
        updatedAt: now()
      }));
      const answer = interrupt(browserInterrupt) as AgentResumePayload;
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
export function repairNode(hooks: AgentGraphHooks) {
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
        interruptContext: toJsonObject(pending.context),
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
        status: "running" as const,
        updatedAt: now()
      };
      await hooks.onProjection?.(projection(completed));
      return {
        ...updateRest,
        status: "running" as const,
        currentNode: "repair" as const,
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
      status: "running" as const,
      updatedAt: now()
    };
    await hooks.onProjection?.(projection(completed));
    return {
      ...assessedRest,
      status: "running" as const,
      currentNode: "repair" as const,
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
export function recoveryNode(hooks: AgentGraphHooks) {
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
        interruptContext: toJsonObject(recoveryInterrupt.context),
        updatedAt: now()
      }));
      const answer = interrupt(recoveryInterrupt) as AgentResumePayload;
      const resumed = await hooks.recover?.({
        ...started,
        ...rest,
        pendingInterrupt: undefined,
        interruptOwner: undefined,
        interruptContext: undefined,
        interruptAnswer: answer
      }) ?? rest;
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
export function finalizeNode(hooks: AgentGraphHooks) {
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
export function liveInterrupt(snapshot: { tasks?: readonly unknown[] }): AgentInterrupt | undefined {
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
