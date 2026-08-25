import { Annotation } from "@langchain/langgraph";
import type {
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphState,
  AgentGraphStatus,
  AgentPermissionProfile,
  CoverageMapState,
  ObservationState
} from "./state.js";
import type {
  DiscoverySubgraphInput,
  DiscoverySubgraphOutput
} from "./subgraphs.js";

/**
 * Parent-facing proxy for the full Discovery child graph. This is deliberately
 * a projection-only adapter: it cannot expose plan, execution, repair, gate
 * or arbitrary parent fields to the child invocation.
 */
export const DiscoverySubgraphNodeInput = Annotation.Root({
  runId: Annotation<string>(),
  mode: Annotation<AgentGraphMode>(),
  projectId: Annotation<string | undefined>(),
  requirement: Annotation<string | undefined>(),
  permissionProfile: Annotation<AgentPermissionProfile>(),
  planApproved: Annotation<boolean | undefined>(),
  capabilitiesApproved: Annotation<boolean | undefined>(),
  status: Annotation<AgentGraphStatus>(),
  completedNodes: Annotation<AgentGraphNode[]>(),
  progress: Annotation<number>(),
  tokenUsage: Annotation<number>(),
  updatedAt: Annotation<string>(),
  coverageMap: Annotation<CoverageMapState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  discoveryTerminal: Annotation<boolean | undefined>()
});

type DiscoverySubgraphNodeState = DiscoverySubgraphInput;

export function discoverySubgraphNode(
  invoke: (state: DiscoverySubgraphInput) => Promise<DiscoverySubgraphOutput>
) {
  return async (state: DiscoverySubgraphNodeState) => {
    const update = await invoke({
      runId: state.runId,
      mode: state.mode,
      projectId: state.projectId,
      requirement: state.requirement,
      permissionProfile: state.permissionProfile,
      planApproved: state.planApproved,
      capabilitiesApproved: state.capabilitiesApproved,
      status: state.status,
      completedNodes: state.completedNodes,
      progress: state.progress,
      tokenUsage: state.tokenUsage,
      updatedAt: state.updatedAt,
      coverageMap: state.coverageMap,
      observation: state.observation,
      discoveryTerminal: state.discoveryTerminal
    });
    return {
      status: update.status,
      currentNode: update.currentNode,
      completedNodes: update.completedNodes,
      progress: update.progress,
      tokenUsage: update.tokenUsage,
      updatedAt: update.updatedAt,
      coverageMap: update.coverageMap,
      observation: update.observation,
      discoveryTerminal: update.discoveryTerminal
    } as Partial<AgentGraphState>;
  };
}
