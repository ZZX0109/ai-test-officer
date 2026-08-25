import {
  agentGraphNodeSchema,
  agentInterruptSchema,
} from "@ai-test-officer/contracts";
import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  type BaseCheckpointSaver
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  orderedNodes,
  GraphState,
  now,
  projection,
  makeNode,
  approvalNode,
  discoveryNode,
  executionNode,
  browserAuthorizationNode,
  repairNode,
  recoveryNode,
  liveInterrupt
} from "./graphNodes.js";
import { DiscoverySubgraphNodeInput, discoverySubgraphNode } from "./discoverySubgraphNode.js";
import { EvidenceGateNodeInput, evidenceGateNode } from "./evidenceGateNode.js";
import { FailureTriageSubgraphNodeInput, failureTriageSubgraphNode } from "./failureTriageSubgraphNode.js";
import { FinalizationNodeInput, finalizationNode } from "./finalizationNode.js";
import { PlanningSubgraphNodeInput, planningSubgraphNode } from "./planningSubgraphNode.js";
import { toJsonObject } from "./state.js";
import {
  assertTypedSubgraphCoverage,
  createBrowserExecutionSubgraph,
  createDiscoverySubgraph,
  createEvidenceGateSubgraph,
  createFailureTriageSubgraph,
  createFinalizationSubgraph,
  createNonBrowserExecutionSubgraph,
  createPlanningSubgraph,
  createRepairValidationSubgraph,
  createRuntimeRecoverySubgraph
} from "./subgraphs.js";
import type {
  AgentGraphHooks,
  AgentGraphInput,
  AgentGraphMode,
  AgentGraphNode,
  AgentGraphProjection,
  AgentGraphState,
  AgentGraphStatus,
  AgentResumePayload,
  JsonObject,
  AgentInterrupt,
  AgentPermissionProfile,
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  BrowserSession,
  RecoveryActionResult,
  RecoveryDecision,
  RepairDecisionAnswer
} from "./state.js";

export type {
  AgentGraphHooks,
  AgentGraphInput,
  AgentGraphMode,
  AgentGraphProjection,
  AgentGraphState,
  AgentGraphStatus,
  AgentResumePayload,
  JsonObject
} from "./state.js";
export { toJsonObject } from "./state.js";
export {
  createBrowserExecutionSubgraph,
  createDiscoverySubgraph,
  createEvidenceGateSubgraph,
  createFailureTriageSubgraph,
  createFinalizationSubgraph,
  createNonBrowserExecutionSubgraph,
  createPlanningSubgraph,
  createRepairValidationSubgraph,
  createRuntimeRecoverySubgraph,
  type DiscoverySubgraphInput,
  type DiscoverySubgraphOutput,
  type DiscoverySubgraphState,
  type BrowserExecutionSubgraphInput,
  type BrowserExecutionSubgraphOutput,
  type BrowserExecutionSubgraphState,
  type EvidenceGateSubgraphInput,
  type EvidenceGateSubgraphOutput,
  type EvidenceGateSubgraphState,
  type FinalizationSubgraphInput,
  type FinalizationSubgraphOutput,
  type FinalizationSubgraphState,
  type FailureTriageSubgraphInput,
  type FailureTriageSubgraphOutput,
  type FailureTriageSubgraphState,
  type NonBrowserExecutionSubgraphInput,
  type NonBrowserExecutionSubgraphOutput,
  type NonBrowserExecutionSubgraphState,
  type PlanningSubgraphInput,
  type PlanningSubgraphOutput,
  type PlanningSubgraphState,
  type RepairValidationSubgraphInput,
  type RepairValidationSubgraphOutput,
  type RepairValidationSubgraphState,
  type RuntimeRecoverySubgraphInput,
  type RuntimeRecoverySubgraphOutput,
  type RuntimeRecoverySubgraphState
} from "./subgraphs.js";

export * from "./model.js";

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
  assertTypedSubgraphCoverage(orderedNodes);
  const hooks = input.hooks ?? {};
  const discoverySubgraph = createDiscoverySubgraph({
    intake: makeNode("intake", hooks.intake, hooks),
    discover: discoveryNode(hooks)
  });
  const planningSubgraph = createPlanningSubgraph({
    buildCoverageMap: makeNode("build-coverage-map", hooks.buildCoverageMap, hooks),
    plan: makeNode("plan", hooks.plan, hooks),
    compile: makeNode("compile", hooks.compile, hooks)
  });
  const runtimeRecoverySubgraph = createRuntimeRecoverySubgraph({
    diagnoseRuntime: makeNode("diagnose-runtime", hooks.diagnoseRuntime, hooks),
    chooseRecovery: makeNode("choose-recovery", hooks.chooseRecovery, hooks),
    recover: recoveryNode(hooks),
    verifyRecovery: makeNode("verify-recovery", hooks.verifyRecovery, hooks),
    retryPath: makeNode("retry-path", hooks.retryPath, hooks)
  });
  const browserExecutionSubgraph = createBrowserExecutionSubgraph({
    prepareSandbox: makeNode("prepare-sandbox", hooks.prepareSandbox, hooks),
    approveCapabilities: approvalNode("browser-permission", hooks),
    observeBrowser: makeNode("observe-browser", hooks.observeBrowser, hooks),
    decideBrowserAction: makeNode("decide-browser-action", hooks.decideBrowserAction, hooks),
    authorizeBrowserAction: browserAuthorizationNode(hooks),
    executeBrowserAction: makeNode("execute-browser-action", hooks.executeBrowserAction, hooks),
    verifyBrowserAction: makeNode("verify-browser-action", hooks.verifyBrowserAction, hooks),
    decideNextStep: makeNode("decide-next-step", hooks.decideNextStep, hooks)
  });
  const nonBrowserExecutionSubgraph = createNonBrowserExecutionSubgraph({
    execute: executionNode(hooks),
    continuePaths: makeNode("continue-paths", hooks.continuePaths, hooks)
  });
  const evidenceGateSubgraph = createEvidenceGateSubgraph({
    collectAndGate: hooks.collectAndGate
  });
  const failureTriageSubgraph = createFailureTriageSubgraph({
    triageFailure: makeNode("triage-failure", hooks.triageFailure, hooks),
    selectiveJudge: makeNode("selective-judge", hooks.selectiveJudge, hooks)
  });
  const repairValidationSubgraph = createRepairValidationSubgraph({ repair: repairNode(hooks) });
  const finalizationSubgraph = createFinalizationSubgraph({ finalize: hooks.finalize });
  const graph = new StateGraph(GraphState)
    .addNode("intake", discoverySubgraphNode(
      (state) => discoverySubgraph.invoke(state)
    ), { input: DiscoverySubgraphNodeInput })
    .addNode("diagnose-runtime", runtimeRecoverySubgraph)
    .addNode("build-coverage-map", planningSubgraphNode(
      (state) => planningSubgraph.invoke(state)
    ), { input: PlanningSubgraphNodeInput })
    .addNode("approve-plan", approvalNode("plan-approval", hooks))
    .addNode("prepare-sandbox", browserExecutionSubgraph)
    .addNode("execute", nonBrowserExecutionSubgraph)
    .addNode("collect-and-gate", evidenceGateNode(
      (state) => evidenceGateSubgraph.invoke(state),
      hooks
    ), { input: EvidenceGateNodeInput })
    .addNode("triage-failure", failureTriageSubgraphNode(
      (state) => failureTriageSubgraph.invoke(state)
    ), { input: FailureTriageSubgraphNodeInput })
    .addNode("repair", repairValidationSubgraph)
    .addNode("finalize", finalizationNode(
      (state) => finalizationSubgraph.invoke(state),
      hooks
    ), { input: FinalizationNodeInput })
    .addEdge(START, "intake")
    // Runtime discovery is an execution-readiness signal, not the source of
    // truth for the static business inventory.  Always compile and expose the
    // code-derived coverage map before routing a blocked page into recovery;
    // otherwise a login wall or a dead port replaces the entire full-scan
    // plan with one generic error card.
    .addEdge("intake", "build-coverage-map")
    .addConditionalEdges("diagnose-runtime", (state) => {
      const action = state.recoveryDecision?.action;
      if (action === "repair-harness" || action === "repair-environment" || action === "repair-product") return "repair";
      if (state.currentNode === "retry-path") return "execute";
      if (state.recoveryResult?.status === "completed" && (action === "retry-runtime" || action === "retry-discovery")) return "intake";
      return "finalize";
    }, ["intake", "execute", "repair", "finalize"])
    .addConditionalEdges("build-coverage-map", (state) => {
      if (state.planningTerminal === true) return "finalize";
      return state.mode === "active" && state.discoveryTerminal === true ? "diagnose-runtime" : "approve-plan";
    }, ["diagnose-runtime", "approve-plan", "finalize"])
    .addEdge("approve-plan", "prepare-sandbox")
    .addConditionalEdges("prepare-sandbox", (state) => {
      if (state.execution?.aggregate === true) return "collect-and-gate";
      if (state.browserAgentRequired !== true) return "execute";
      if (state.browserBatchPending === true) return "execute";
      if (state.browserLoopComplete === true) {
        return (state.remainingPathCount ?? 0) > 0
          || (state.compiledPlan && Object.keys(state.compiledPlan).length > 0)
          ? "execute"
          : "collect-and-gate";
      }
      return "finalize";
    }, ["execute", "collect-and-gate", "finalize"])
    .addConditionalEdges("execute", (state) => {
      if (state.currentNode === "continue-paths") return "finalize";
      return state.browserBatchResumed === true ? "prepare-sandbox" : "collect-and-gate";
    }, ["prepare-sandbox", "collect-and-gate", "finalize"])
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
      if (state.recoveryDecision?.action && state.recoveryDecision.action !== "blocked") return "diagnose-runtime";
      if (failure.repairable === true) return "repair";
      return "finalize";
    }, ["diagnose-runtime", "repair", "finalize"])
    .addEdge("repair", "execute")
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
    async resume(runId: string, value: JsonObject) {
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
        interruptContext: toJsonObject(pendingInterrupt?.context) ?? values.interruptContext
      });
    }
  };
}

export function assertAgentGraphNodes() {
  return orderedNodes.map((node) => agentGraphNodeSchema.parse(node));
}
