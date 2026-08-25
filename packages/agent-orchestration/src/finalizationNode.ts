import { Annotation } from "@langchain/langgraph";
import { now, orderedNodes, projection } from "./graphNodes.js";
import type {
  AgentGraphHooks,
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphProjection,
  AgentGraphState,
  AgentGraphStatus,
  AgentInterrupt,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  RecoveryActionResult,
  RecoveryDecision
} from "./state.js";
import type {
  FinalizationSubgraphInput,
  FinalizationSubgraphOutput
} from "./subgraphs.js";

/** Projection fields remain parent-owned; finalization business data stays narrow. */
export const FinalizationNodeInput = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  status: Annotation<AgentGraphStatus>(),
  currentNode: Annotation<AgentGraphNode | undefined>(),
  completedNodes: Annotation<AgentGraphNode[]>(),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  interruptOwner: Annotation<"agent" | "user" | "environment" | "developer" | undefined>(),
  interruptContext: Annotation<AgentGraphState["interruptContext"]>(),
  lastError: Annotation<AgentGraphProjection["lastError"] | undefined>(),
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
  browserAgentRequired: Annotation<boolean | undefined>(),
  browserLoopComplete: Annotation<boolean | undefined>(),
  continuationPasses: Annotation<number | undefined>(),
  remainingPathCount: Annotation<number | undefined>(),
  execution: Annotation<AgentGraphState["execution"]>(),
  gate: Annotation<AgentGraphState["gate"]>(),
  coverageMap: Annotation<AgentGraphState["coverageMap"]>(),
  discoveryTerminal: Annotation<boolean | undefined>(),
  updatedAt: Annotation<string>()
});

type FinalizationNodeState = FinalizationSubgraphInput & Pick<AgentGraphState,
  | "status" | "currentNode" | "completedNodes" | "progress" | "tokenUsage"
  | "pendingInterrupt" | "interruptOwner" | "interruptContext" | "lastError"
  | "repairSessionId" | "recoveryDecision" | "recoveryResult" | "recoveryAttempts"
  | "currentCoverageItemId" | "currentAttemptId" | "observation" | "browserSession"
  | "browserObservation" | "browserDecision" | "browserActionResult" | "browserLoopComplete"
  | "continuationPasses" | "remainingPathCount" | "updatedAt">;

/** Preserve pending interrupts, then invoke the compiled terminal-state child graph. */
export function finalizationNode(
  invoke: (state: FinalizationSubgraphInput) => Promise<FinalizationSubgraphOutput>,
  hooks: AgentGraphHooks
) {
  const node: AgentGraphNode = "finalize";
  return async (state: FinalizationNodeState) => {
    if (state.pendingInterrupt?.status === "pending") {
      return { status: "interrupted" as const, currentNode: node, pendingInterrupt: state.pendingInterrupt };
    }
    const index = orderedNodes.indexOf(node);
    const started: AgentGraphState = {
      ...(state as AgentGraphState), status: "running", currentNode: node,
      pendingInterrupt: undefined, progress: index / orderedNodes.length, updatedAt: now()
    };
    await hooks.onProjection?.(projection(started));
    try {
      const update = await invoke({
        runId: state.runId, mode: state.mode, execution: state.execution, gate: state.gate,
        coverageMap: state.coverageMap, discoveryTerminal: state.discoveryTerminal,
        browserAgentRequired: state.browserAgentRequired
      });
      const completed: AgentGraphState = {
        ...started, ...update, completedNodes: Array.from(new Set([...started.completedNodes, node])),
        progress: (index + 1) / orderedNodes.length, updatedAt: now()
      };
      await hooks.onProjection?.(projection(completed));
      return {
        ...update, status: completed.status, currentNode: node, completedNodes: [node],
        progress: completed.progress, pendingInterrupt: undefined, updatedAt: completed.updatedAt
      };
    } catch (error) {
      const failed: AgentGraphState = {
        ...started, status: "failed",
        lastError: {
          code: error instanceof Error ? error.message.split(":")[0] : "agent_graph_failed",
          message: error instanceof Error ? error.message : "Agent graph failed", node
        }, updatedAt: now()
      };
      await hooks.onProjection?.(projection(failed));
      throw error;
    }
  };
}
