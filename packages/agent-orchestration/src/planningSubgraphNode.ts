import { Annotation } from "@langchain/langgraph";
import type {
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphState,
  AgentGraphStatus,
  AgentPermissionProfile,
  CompiledPlanState,
  CoverageMapState,
  PlanState
} from "./state.js";
import type {
  PlanningSubgraphInput,
  PlanningSubgraphOutput
} from "./subgraphs.js";

/**
 * Parent-facing projection for the pre-approval Planning child. It exposes
 * only inputs needed to create CoverageItems and compile a plan; execution,
 * gates, repair and recovery state cannot cross this boundary.
 */
export const PlanningSubgraphNodeInput = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  status: Annotation<AgentGraphStatus>(),
  completedNodes: Annotation<AgentGraphNode[]>(),
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

type PlanningSubgraphNodeState = PlanningSubgraphInput;

/** Invoke the compiled child and return only its declared planning outputs. */
export function planningSubgraphNode(
  invoke: (state: PlanningSubgraphInput) => Promise<PlanningSubgraphOutput>
) {
  return async (state: PlanningSubgraphNodeState) => {
    const update = await invoke({
      runId: state.runId,
      mode: state.mode,
      projectId: state.projectId,
      requirement: state.requirement,
      permissionProfile: state.permissionProfile,
      status: state.status,
      completedNodes: state.completedNodes,
      progress: state.progress,
      tokenUsage: state.tokenUsage,
      updatedAt: state.updatedAt,
      coverageMap: state.coverageMap,
      planData: state.planData,
      compiledPlan: state.compiledPlan,
      planningTerminal: state.planningTerminal,
      browserAgentRequired: state.browserAgentRequired,
      currentCoverageItemId: state.currentCoverageItemId,
      currentAttemptId: state.currentAttemptId
    });
    return {
      status: update.status,
      currentNode: update.currentNode,
      completedNodes: update.completedNodes,
      progress: update.progress,
      tokenUsage: update.tokenUsage,
      updatedAt: update.updatedAt,
      coverageMap: update.coverageMap,
      planData: update.planData,
      compiledPlan: update.compiledPlan,
      planningTerminal: update.planningTerminal,
      browserAgentRequired: update.browserAgentRequired,
      currentCoverageItemId: update.currentCoverageItemId,
      currentAttemptId: update.currentAttemptId
    } as Partial<AgentGraphState>;
  };
}
