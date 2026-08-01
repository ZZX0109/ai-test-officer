import {
  agentGraphNodeSchema,
  type AgentGraphNode,
  type AgentGraphProjection,
  type AgentInterrupt,
  type AgentPermissionProfile
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
  lastError?: AgentGraphProjection["lastError"];
  coverageMap?: Record<string, unknown>;
  planData?: Record<string, unknown>;
  compiledPlan?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  judge?: Record<string, unknown>;
  repairSessionId?: string;
  planningTerminal?: boolean;
  /**
   * Discovery is a hard precondition for active full-browser planning.  A
   * blocked/failed smoke probe ends the planning branch before coverage or an
   * LLM planner can expand it.
   */
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
  execute?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  collectAndGate?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  triageFailure?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  selectiveJudge?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  repair?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  finalize?: (state: AgentGraphState) => Promise<Partial<AgentGraphState>>;
  onProjection?: (projection: AgentGraphProjection) => Promise<void>;
}

const orderedNodes: AgentGraphNode[] = [
  "intake",
  "discover",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities",
  "execute",
  "collect-and-gate",
  "triage-failure",
  "selective-judge",
  "repair",
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
    reducer: (left, right) => (left ?? 0) + (right ?? 0),
    default: () => 0
  }),
  pendingInterrupt: Annotation<AgentInterrupt | undefined>(),
  lastError: Annotation<AgentGraphProjection["lastError"] | undefined>(),
  coverageMap: Annotation<Record<string, unknown> | undefined>(),
  planData: Annotation<Record<string, unknown> | undefined>(),
  compiledPlan: Annotation<Record<string, unknown> | undefined>(),
  execution: Annotation<Record<string, unknown> | undefined>(),
  gate: Annotation<Record<string, unknown> | undefined>(),
  failure: Annotation<Record<string, unknown> | undefined>(),
  judge: Annotation<Record<string, unknown> | undefined>(),
  repairSessionId: Annotation<string | undefined>(),
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
    lastError: state.lastError,
    tokenUsage: state.tokenUsage,
    repairSessionId: state.repairSessionId,
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

/**
 * Active mode must not fan out coverage from a page which has not completed a
 * real browser smoke.  "waiting" is recoverable and therefore checkpoints as
 * an interrupt; "blocked"/"failed" are routed straight to finalize.  Shadow
 * mode intentionally keeps the historical linear flow for comparison.
 */
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
      let update = await hooks.discover?.(started) ?? {};
      while (discoveryStatus({ coverageMap: update.coverageMap ?? started.coverageMap }) === "waiting") {
        const pending: AgentInterrupt = {
          id: `interrupt_${randomUUID()}`,
          runId: state.runId,
          // A Discovery retry needs the same bounded browser capability as the
          // later execution.  Reusing this public kind keeps existing clients
          // compatible while the title/payload make the waiting state explicit.
          kind: "browser-permission",
          status: "pending",
          title: "等待项目页面就绪",
          detail: String(
            (update.coverageMap?.discovery as Record<string, unknown> | undefined)?.reason
            ?? "项目仍在启动；页面就绪后可恢复同一运行并重新执行 Discovery smoke。"
          ),
          requestedCapabilities: ["browserControl"],
          payload: {
            action: "retry-discovery-smoke",
            discoveryStatus: "waiting"
          },
          createdAt: now()
        };
        await hooks.onProjection?.(projection({
          ...started,
          ...update,
          status: "interrupted",
          currentNode: "discover",
          pendingInterrupt: pending,
          updatedAt: now()
        }));
        const answer = interrupt(pending) as { approved?: boolean; retry?: boolean };
        if (!answer?.approved && !answer?.retry) {
          update = {
            ...update,
            discoveryTerminal: true,
            coverageMap: {
              ...(update.coverageMap ?? started.coverageMap ?? {}),
              discovery: {
                ...((update.coverageMap?.discovery as Record<string, unknown> | undefined) ?? {}),
                status: "blocked",
                reason: "discovery_retry_declined"
              }
            }
          };
          break;
        }
        // LangGraph resumes a node from its beginning.  Re-running the hook
        // here performs one fresh bounded probe after the saved approval.
        update = await hooks.discover?.({ ...started, ...update, pendingInterrupt: undefined }) ?? update;
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
    .addNode("build-coverage-map", makeNode("build-coverage-map", hooks.buildCoverageMap, hooks))
    .addNode("plan", makeNode("plan", hooks.plan, hooks))
    .addNode("compile", makeNode("compile", hooks.compile, hooks))
    .addNode("approve-plan", approvalNode("plan-approval", hooks))
    .addNode("prepare-sandbox", makeNode("prepare-sandbox", hooks.prepareSandbox, hooks))
    .addNode("approve-capabilities", approvalNode("browser-permission", hooks))
    .addNode("execute", executionNode(hooks))
    .addNode("collect-and-gate", makeNode("collect-and-gate", hooks.collectAndGate, hooks))
    .addNode("triage-failure", makeNode("triage-failure", hooks.triageFailure, hooks))
    .addNode("selective-judge", makeNode("selective-judge", hooks.selectiveJudge, hooks))
    .addNode("repair", makeNode("repair", hooks.repair, hooks))
    .addNode("finalize", makeNode("finalize", hooks.finalize, hooks))
    .addEdge(START, "intake")
    .addEdge("intake", "discover")
    .addConditionalEdges("discover", (state) =>
      state.mode === "active" && state.discoveryTerminal === true ? "finalize" : "build-coverage-map",
    ["build-coverage-map", "finalize"])
    .addEdge("build-coverage-map", "plan")
    .addConditionalEdges("plan", (state) => state.planningTerminal === true ? "finalize" : "compile", ["compile", "finalize"])
    .addEdge("compile", "approve-plan")
    .addEdge("approve-plan", "prepare-sandbox")
    .addEdge("prepare-sandbox", "approve-capabilities")
    .addEdge("approve-capabilities", "execute")
    .addEdge("execute", "collect-and-gate")
    .addEdge("collect-and-gate", "triage-failure")
    .addConditionalEdges("triage-failure", (state) => {
      const failure = state.failure ?? {};
      if (!Object.keys(failure).length) return "finalize";
      if (failure.needsLlmJudge === true) return "selective-judge";
      if (failure.repairable === true) return "repair";
      return "finalize";
    }, ["selective-judge", "repair", "finalize"])
    .addConditionalEdges("selective-judge", (state) =>
      state.failure?.repairable === true ? "repair" : "finalize",
    ["repair", "finalize"])
    .addEdge("repair", "finalize")
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
      }, { configurable: { thread_id: payload.runId } });
    },
    async resume(runId: string, value: Record<string, unknown>) {
      return graph.invoke(new Command({ resume: value }), { configurable: { thread_id: runId } });
    },
    async state(runId: string) {
      const snapshot = await graph.getState({ configurable: { thread_id: runId } });
      const values = snapshot.values as AgentGraphState;
      if (!values?.runId) return undefined;
      const status: AgentGraphStatus = snapshot.next.length === 0
        ? values.lastError ? "failed" : "completed"
        : values.pendingInterrupt ? "interrupted" : values.status;
      return projection({ ...values, status });
    }
  };
}

export function assertAgentGraphNodes() {
  return orderedNodes.map((node) => agentGraphNodeSchema.parse(node));
}
