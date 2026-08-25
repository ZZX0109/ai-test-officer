import { Annotation } from "@langchain/langgraph";
import type {
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphState,
  AgentGraphStatus,
  AgentPermissionProfile,
  ExecutionState,
  FailureState,
  GateState,
  JudgeState,
  ObservationState,
  RecoveryDecision
} from "./state.js";
import type {
  FailureTriageSubgraphInput,
  FailureTriageSubgraphOutput
} from "./subgraphs.js";

/**
 * Parent-facing projection for deterministic triage and optional Judge advice.
 * The child cannot access plans, browser control, recovery result details,
 * repair sessions, or arbitrary parent state.
 */
export const FailureTriageSubgraphNodeInput = Annotation.Root({
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
  execution: Annotation<ExecutionState | undefined>(),
  gate: Annotation<GateState | undefined>(),
  observation: Annotation<ObservationState | undefined>(),
  currentAttemptId: Annotation<string | undefined>(),
  failure: Annotation<FailureState | undefined>(),
  judge: Annotation<JudgeState | undefined>(),
  recoveryDecision: Annotation<RecoveryDecision | undefined>()
});

type FailureTriageSubgraphNodeState = FailureTriageSubgraphInput;

/** Invoke the child and project only its declared failure/Judge outputs back. */
export function failureTriageSubgraphNode(
  invoke: (state: FailureTriageSubgraphInput) => Promise<FailureTriageSubgraphOutput>
) {
  return async (state: FailureTriageSubgraphNodeState) => {
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
      execution: state.execution,
      gate: state.gate,
      observation: state.observation,
      currentAttemptId: state.currentAttemptId,
      failure: state.failure,
      judge: state.judge,
      recoveryDecision: state.recoveryDecision
    });
    return {
      status: update.status,
      currentNode: update.currentNode,
      completedNodes: update.completedNodes,
      progress: update.progress,
      tokenUsage: update.tokenUsage,
      updatedAt: update.updatedAt,
      gate: update.gate,
      failure: update.failure,
      judge: update.judge,
      recoveryDecision: update.recoveryDecision
    } as Partial<AgentGraphState>;
  };
}
