/**
 * Tool Gateway — LLM 调用数据库的唯一通道
 *
 * LLM → Tool Gateway → Service Layer → Database
 * 数据库只作为事实存储，不暴露给 Agent。
 */

import { createHash } from "node:crypto";
import type { ProjectMemoryEntry, ToolVersion, ExperienceMemoryEntry, LlmKnowledgeContext, KnowledgeToolRequest } from "@ai-test-officer/contracts";
import { getMemoryService } from "../memory/index.js";
import { emitTrajectory } from "../trajectoryEmitter.js";
import { executeKnowledgeReadTool } from "../knowledge-boundary/toolBroker.js";
import { redactValue } from "../redaction.js";

export type ToolCapability =
  | "get_project_context"
  | "get_run_status"
  | "get_evidence"
  | "get_failure_history"
  | "get_repair_history"
  | "query_project_memory"
  | "query_experience_memory"
  | "propose_write_action"
  | "check_schema_version"
  | "search_similar_experiences"
  | "inspect_runtime"
  | "read_runtime_log"
  | "inspect_health_check"
  | "observe_page"
  | "read_current_plan"
  | "read_failed_attempt"
  | "read_evidence_proof"
  | "start_sandbox"
  | "restart_sandbox"
  | "resolve_port"
  | "retry_health_check"
  | "retry_discovery"
  | "retry_failed_path"
  | "continue_safe_paths"
  | "create_validation_run"
  | "browser.observe"
  | "browser.act"
  | "api.request"
  | "test.run"
  | "assert.evaluate"
  | "fixture.seed"
  | "fixture.reset"
  | "visual.compare"
  | "artifact.read"
  | "evidence.collect";

export type SafeRecoveryCapability = Extract<ToolCapability,
  | "start_sandbox"
  | "restart_sandbox"
  | "resolve_port"
  | "retry_health_check"
  | "retry_discovery"
  | "retry_failed_path"
  | "continue_safe_paths"
  | "create_validation_run"
>;

export interface ToolCall {
  callId: string;
  capability: ToolCapability;
  params: Record<string, unknown>;
  runId: string;
  traceId?: string;
  toolVersion: string;
  /** Stable retry key for side-effecting native tool calls. */
  idempotencyKey?: string;
  /** Upper bound for the gateway handler; the underlying adapter should also
   * honour its own cancellation signal where supported. */
  timeoutMs?: number;
  /** Cancellation owned by the calling Run/Graph execution. */
  signal?: AbortSignal;
  /** Set only when an approval interrupt was explicitly accepted by a user. */
  approved?: boolean;
}

function toolTimeoutMs(value: number | undefined) {
  const configured = Number.isFinite(value) ? Number(value) : Number(process.env.TOOL_GATEWAY_TIMEOUT_MS ?? 60_000);
  return Math.min(300_000, Math.max(1, configured));
}

function outputPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(redactValue(value));
    if (!serialized) return undefined;
    return serialized.length > 8_000 ? `${serialized.slice(0, 7_999)}…` : serialized;
  } catch {
    return "[unserializable]";
  }
}

function executeWithControl<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("tool_cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(new Error("tool_timeout")), timeoutMs);
    const onAbort = () => finishReject(new Error("tool_cancelled"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    operation.then(finishResolve, finishReject);
  });
}

export interface ToolResult {
  callId: string;
  success: boolean;
  /** Structured action outcome consumed by LangGraph/Workbench. */
  status?: "completed" | "blocked" | "failed" | "needs-confirmation";
  actionId?: string;
  evidenceRefs?: string[];
  nextState?: string;
  errorCode?: string;
  userMessage?: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  cacheHit: boolean;
  durationMs: number;
}

/**
 * The knowledge broker is a policy-specialized adapter, not a second Agent
 * entry point. Route its calls through this function so all model-visible
 * tools get the same call trace and trajectory envelope as ToolGateway tools.
 */
export async function executeUnifiedKnowledgeTool(input: {
  context: LlmKnowledgeContext;
  request: KnowledgeToolRequest;
  traceId?: string;
}) {
  if (!input.context.runId) return executeKnowledgeReadTool({ context: input.context, request: input.request });
  const runId = input.context.runId;
  const requestDigest = createHash("sha256").update(JSON.stringify(input.request.input)).digest("hex").slice(0, 12);
  const callId = `knowledge:${input.request.tool}:${input.context.id ?? input.context.runId}:${requestDigest}`;
  const traceId = input.traceId ?? `knowledge-trace:${callId}`;
  const started = Date.now();
  void emitTrajectory({
    runId,
    type: "tool.call.started",
    actor: "tool-gateway",
    traceId,
    idempotencyKey: `${callId}:started:${JSON.stringify(input.request.input)}`,
    payload: { callId, toolName: input.request.tool, kind: "knowledge-read", input: input.request.input }
  });
  try {
    const result = await executeKnowledgeReadTool({ context: input.context, request: input.request });
    void emitTrajectory({
      runId,
      type: result.execution.status === "completed" ? "tool.call.completed" : "tool.call.failed",
      actor: "tool-gateway",
      traceId,
      idempotencyKey: `${callId}:completed:${result.execution.id}`,
      payload: { callId, toolName: input.request.tool, status: result.execution.status, durationMs: Date.now() - started, executionId: result.execution.id },
      evidenceRefs: result.claims.flatMap((claim) => claim.sourceRefs)
    });
    return result;
  } catch (error) {
    void emitTrajectory({
      runId,
      type: "tool.call.failed",
      actor: "tool-gateway",
      traceId,
      idempotencyKey: `${callId}:failed:${Date.now()}`,
      payload: { callId, toolName: input.request.tool, status: "failed", durationMs: Date.now() - started, errorCode: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
}

export function executeKnowledgeToolThroughGateway(input: {
  context: LlmKnowledgeContext;
  request: KnowledgeToolRequest;
  traceId?: string;
}) {
  return instance ? instance.executeKnowledge(input) : executeUnifiedKnowledgeTool(input);
}

// ─── Tool Registry ───────────────────────────────────────────────

interface RegisteredTool {
  definition: ToolVersion;
  handler: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
}

const toolMetadata = (capability: ToolCapability, name: string, inputSchema: Record<string, unknown>, options: Partial<Pick<ToolVersion, "isReadOnly" | "riskLevel" | "approvalRequired">> = {}): ToolVersion => {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0", toolId: `tool-${capability}`, toolName: name, version: "1.0.0",
    capability, isReadOnly: options.isReadOnly ?? true, inputSchema, outputSchema: {}, changelog: [],
    compatibleApiContractVersions: [], riskLevel: options.riskLevel ?? "low", approvalRequired: options.approvalRequired ?? false,
    isDeprecated: false, createdAt: now, updatedAt: now
  };
};

class ToolRegistry {
  private tools = new Map<ToolCapability, RegisteredTool>();

  register(capability: ToolCapability, tool: RegisteredTool): void {
    this.tools.set(capability, tool);
  }

  get(capability: ToolCapability): RegisteredTool | undefined {
    return this.tools.get(capability);
  }

  getDefinition(capability: string): ToolVersion | undefined {
    return this.tools.get(capability as ToolCapability)?.definition;
  }

  listDefinitions(): ToolVersion[] {
    return Array.from(this.tools.values()).map((tool) => tool.definition);
  }

  listTools(): Array<{ capability: ToolCapability; version: string; isReadOnly: boolean }> {
    return Array.from(this.tools.entries()).map(([cap, tool]) => ({
      capability: cap,
      version: tool.definition.version,
      isReadOnly: tool.definition.isReadOnly
    }));
  }
}

// ─── Service Layer 适配器 ───────────────────────────────────────

export interface ServiceLayer {
  getProjectContextRaw: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  getRunStatusRaw: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  getEvidenceRaw: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  getFailureHistoryRaw: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  getRepairHistoryRaw: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  queryProjectMemoryRaw: (projectId: string, category?: string, signal?: AbortSignal) => Promise<unknown[]>;
  queryExperienceMemoryRaw: (projectId: string, failureType?: string, signal?: AbortSignal) => Promise<unknown[]>;
  getSchemaVersionsRaw: (signal?: AbortSignal) => Promise<unknown>;
  inspectRuntimeRaw?: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  readRuntimeLogRaw?: (projectId: string, limit?: number, signal?: AbortSignal) => Promise<unknown>;
  inspectHealthCheckRaw?: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  observePageRaw?: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  readCurrentPlanRaw?: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  readFailedAttemptRaw?: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  readEvidenceProofRaw?: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  safeRecoveryActionRaw?: (action: SafeRecoveryCapability, params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  proposeWriteActionRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  browserActionRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  apiRequestRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  testRunRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  fixtureRaw?: (operation: "seed" | "reset", params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  visualCompareRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  readArtifactRaw?: (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>;
  authorizeToolCallRaw?: (runId: string, projectId?: string, signal?: AbortSignal) => Promise<boolean>;
}

// ─── Tool Gateway ────────────────────────────────────────────────

export class ToolGateway {
  private registry = new ToolRegistry();
  private serviceLayer: ServiceLayer;
  private cache = new Map<string, { expiresAt: number; data: unknown }>();
  private idempotentResults = new Map<string, ToolResult>();

  constructor(serviceLayer: ServiceLayer) {
    this.serviceLayer = serviceLayer;
    this.registerReadOnlyTools();
  }

  private registerReadOnlyTools(): void {
    // Project Context
    this.registry.register("get_project_context", {
      definition: toolMetadata("get_project_context", "get_project_context", { projectId: "string" }),
      // The application service is authoritative. ContextLayer remains the
      // redaction/aggregation facade, but the tool must not read its bootstrap
      // placeholder after the real project registry is available.
      handler: async (params, _runId, signal) => this.serviceLayer.getProjectContextRaw(String(params.projectId ?? ""), signal)
    });

    const contextTools: Array<[ToolCapability, string, Record<string, unknown>, (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>]> = [
      ["get_run_status", "get_run_status", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.getRunStatusRaw(typeof params.runId === "string" ? params.runId : runId, signal)],
      ["get_evidence", "get_evidence", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.getEvidenceRaw(typeof params.runId === "string" ? params.runId : runId, signal)],
      ["get_failure_history", "get_failure_history", { projectId: "string" }, async (params, _runId, signal) => this.serviceLayer.getFailureHistoryRaw(String(params.projectId ?? ""), signal)],
      ["get_repair_history", "get_repair_history", { projectId: "string" }, async (params, _runId, signal) => this.serviceLayer.getRepairHistoryRaw(String(params.projectId ?? ""), signal)]
    ];
    for (const [capability, name, schema, handler] of contextTools) {
      this.registry.register(capability, { definition: toolMetadata(capability, name, schema), handler });
    }

    // Query Project Memory
    this.registry.register("query_project_memory", {
      definition: toolMetadata("query_project_memory", "query_project_memory", { projectId: "string", category: "string?" }),
      handler: async (params, _runId, signal) => {
        const memory = getMemoryService();
        const projectId = typeof params.projectId === "string" ? params.projectId : "";
        const category = typeof params.category === "string" && ["tech_stack", "routing", "test_path", "login_method", "dependency_issue", "startup_config", "framework_pattern"].includes(params.category)
          ? params.category as ProjectMemoryEntry["category"] : undefined;
        if (signal?.aborted) throw new Error("tool_cancelled");
        return memory.queryProjectEntries({ projectId, ...(category ? { category } : {}), includeUnverified: true, limit: 50 });
      }
    });

    // Query Experience Memory
    this.registry.register("query_experience_memory", {
      definition: toolMetadata("query_experience_memory", "query_experience_memory", { projectId: "string?", failureType: "string?" }),
      handler: async (params, _runId, signal) => {
        if (signal?.aborted) throw new Error("tool_cancelled");
        const memory = getMemoryService();
        const failureType = typeof params.failureType === "string" && ["selector_not_found", "timeout", "assertion_failed", "network_error", "page_crash", "auth_failure", "data_mismatch", "environment_issue", "flaky_test", "other"].includes(params.failureType)
          ? [params.failureType as ExperienceMemoryEntry["failureType"]] : undefined;
        return {
          retrieval: memory.retrievalDescriptor(),
          entries: await memory.queryExperienceEntries({ projectId: typeof params.projectId === "string" ? params.projectId : undefined, ...(failureType ? { failureType } : {}), limit: 50, semanticLimit: 10, semanticThreshold: 0.6, includeUnvalidated: true, offset: 0 })
        };
      }
    });

    // Search Similar Experiences
    this.registry.register("search_similar_experiences", {
      definition: toolMetadata("search_similar_experiences", "search_similar_experiences", { query: "string", projectId: "string?" }),
      handler: async (params, _runId, signal) => {
        if (signal?.aborted) throw new Error("tool_cancelled");
        const memory = getMemoryService();
        return {
          retrieval: memory.retrievalDescriptor(),
          entries: await memory.searchByEmbedding(
            params.query as string,
            params.projectId as string | undefined
          )
        };
      }
    });

    this.registry.register("check_schema_version", {
      definition: toolMetadata("check_schema_version", "check_schema_version", {}),
      handler: async (_params, _runId, signal) => this.serviceLayer.getSchemaVersionsRaw(signal)
    });
    this.registry.register("propose_write_action", {
      definition: toolMetadata("propose_write_action", "propose_write_action", { runId: "string", action: "string", reason: "string" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: false }),
      handler: async (params, runId, signal) => this.serviceLayer.proposeWriteActionRaw?.(params, runId, signal) ?? {
        status: "blocked", nextState: "waiting_user", errorCode: "write_proposal_unavailable",
        userMessage: "写操作提案已记录，但当前没有连接写安全执行器。"
      }
    });

    const observationTools: Array<[ToolCapability, string, Record<string, unknown>, (params: Record<string, unknown>, runId: string, signal?: AbortSignal) => Promise<unknown>]> = [
      ["inspect_runtime", "inspect_runtime", { projectId: "string" }, async (params, _runId, signal) => this.serviceLayer.inspectRuntimeRaw?.(String(params.projectId ?? ""), signal) ?? { status: "blocked", errorCode: "runtime_inspector_unavailable" }],
      ["read_runtime_log", "read_runtime_log", { projectId: "string", limit: "number?" }, async (params, _runId, signal) => this.serviceLayer.readRuntimeLogRaw?.(String(params.projectId ?? ""), typeof params.limit === "number" ? params.limit : 100, signal) ?? { status: "blocked", errorCode: "runtime_log_unavailable" }],
      ["inspect_health_check", "inspect_health_check", { projectId: "string" }, async (params, _runId, signal) => this.serviceLayer.inspectHealthCheckRaw?.(String(params.projectId ?? ""), signal) ?? { status: "blocked", errorCode: "health_check_unavailable" }],
      ["observe_page", "observe_page", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.observePageRaw?.(String(params.runId ?? runId), signal) ?? { status: "blocked", errorCode: "page_observer_unavailable" }],
      ["read_current_plan", "read_current_plan", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.readCurrentPlanRaw?.(String(params.runId ?? runId), signal) ?? { status: "blocked", errorCode: "plan_unavailable" }],
      ["read_failed_attempt", "read_failed_attempt", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.readFailedAttemptRaw?.(String(params.runId ?? runId), signal) ?? { status: "blocked", errorCode: "attempt_unavailable" }],
      ["read_evidence_proof", "read_evidence_proof", { runId: "string" }, async (params, runId, signal) => this.serviceLayer.readEvidenceProofRaw?.(String(params.runId ?? runId), signal) ?? { status: "blocked", errorCode: "proof_unavailable" }]
    ];
    for (const [capability, name, schema, handler] of observationTools) {
      this.registry.register(capability, { definition: toolMetadata(capability, name, schema), handler });
    }

    const safeRecoveryTools: SafeRecoveryCapability[] = ["start_sandbox", "restart_sandbox", "resolve_port", "retry_health_check", "retry_discovery", "retry_failed_path", "continue_safe_paths", "create_validation_run"];
    for (const capability of safeRecoveryTools) {
      this.registry.register(capability, {
        definition: toolMetadata(capability, capability, { runId: "string", projectId: "string?" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: true }),
        handler: async (params, runId, signal) => {
          if (!this.serviceLayer.safeRecoveryActionRaw) return { status: "blocked", actionId: `tool_${capability}`, nextState: "waiting_user", errorCode: "recovery_gateway_unavailable", userMessage: "当前恢复工具尚未连接到 Agent Graph。" };
          return this.serviceLayer.safeRecoveryActionRaw(capability, params, runId, signal);
        }
      });
    }

    // Test-facing tools use explicit semantic contracts. They never expose a
    // shell, SQL connection, arbitrary URL, or browser JavaScript primitive.
    this.registry.register("browser.observe", {
      definition: toolMetadata("browser.observe", "browser.observe", { runId: "string" }),
      handler: async (params, runId, signal) => this.serviceLayer.observePageRaw?.(String(params.runId ?? runId), signal) ?? { status: "blocked", errorCode: "browser_observer_unavailable" }
    });
    this.registry.register("browser.act", {
      definition: toolMetadata("browser.act", "browser.act", { runId: "string", action: "object", oracles: "object?", userAuthorized: "boolean?" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: true }),
      handler: async (params, runId, signal) => this.serviceLayer.browserActionRaw?.(params, runId, signal) ?? { status: "blocked", nextState: "waiting_user", errorCode: "browser_action_unavailable" }
    });
    this.registry.register("api.request", {
      definition: toolMetadata("api.request", "api.request", { runId: "string", operationId: "string", params: "object?" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: true }),
      handler: async (params, runId, signal) => this.serviceLayer.apiRequestRaw?.(params, runId, signal) ?? { status: "blocked", nextState: "waiting_user", errorCode: "api_allowlist_unavailable" }
    });
    this.registry.register("test.run", {
      definition: toolMetadata("test.run", "test.run", { runId: "string", scenarioId: "string?" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: true }),
      handler: async (params, runId, signal) => this.serviceLayer.testRunRaw?.(params, runId, signal) ?? { status: "blocked", nextState: "waiting_user", errorCode: "test_executor_unavailable" }
    });
    this.registry.register("assert.evaluate", {
      definition: toolMetadata("assert.evaluate", "assert.evaluate", { actual: "unknown", expected: "unknown?", operator: "string" }),
      handler: async (params) => {
        const operator = String(params.operator ?? "equals");
        const actual = params.actual;
        const expected = params.expected;
        const passed = operator === "truthy" ? Boolean(actual) : operator === "contains" ? String(actual).includes(String(expected)) : JSON.stringify(actual) === JSON.stringify(expected);
        return { status: passed ? "completed" : "failed", passed, operator, actual, expected, errorCode: passed ? undefined : "assertion_failed" };
      }
    });
    this.registry.register("fixture.seed", {
      definition: toolMetadata("fixture.seed", "fixture.seed", { runId: "string", fixtureId: "string" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: true }),
      handler: async (params, runId, signal) => this.serviceLayer.fixtureRaw?.("seed", params, runId, signal) ?? { status: "blocked", nextState: "waiting_user", errorCode: "fixture_manager_unavailable" }
    });
    this.registry.register("fixture.reset", {
      definition: toolMetadata("fixture.reset", "fixture.reset", { runId: "string", fixtureId: "string" }, { isReadOnly: false, riskLevel: "high", approvalRequired: true }),
      handler: async (params, runId, signal) => this.serviceLayer.fixtureRaw?.("reset", params, runId, signal) ?? { status: "blocked", nextState: "waiting_user", errorCode: "fixture_manager_unavailable" }
    });
    this.registry.register("visual.compare", {
      definition: toolMetadata("visual.compare", "visual.compare", { runId: "string", baselineId: "string", artifactId: "string" }),
      handler: async (params, runId, signal) => this.serviceLayer.visualCompareRaw?.(params, runId, signal) ?? { status: "blocked", errorCode: "visual_comparator_unavailable" }
    });
    this.registry.register("artifact.read", {
      definition: toolMetadata("artifact.read", "artifact.read", { runId: "string", artifactId: "string" }),
      handler: async (params, runId, signal) => this.serviceLayer.readArtifactRaw?.(params, runId, signal) ?? { status: "blocked", errorCode: "artifact_reader_unavailable" }
    });
    this.registry.register("evidence.collect", {
      definition: toolMetadata("evidence.collect", "evidence.collect", { runId: "string" }),
      handler: async (params, runId, signal) => this.serviceLayer.getEvidenceRaw(String(params.runId ?? runId), signal)
    });
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const startedAt = new Date().toISOString();
    const traceId = call.traceId ?? `tool-trace:${call.callId}`;
    const tool = this.registry.get(call.capability);
    const idempotencyKey = call.idempotencyKey ?? call.callId;
    const previous = this.idempotentResults.get(idempotencyKey);
    if (previous && previous.status !== "needs-confirmation") return { ...previous, cacheHit: true };
    void emitTrajectory({
      runId: call.runId,
      type: "tool.call.started",
      actor: "tool-gateway",
      traceId,
      idempotencyKey: `tool:${call.callId}:started`,
      timing: { startedAt },
      payload: { callId: call.callId, toolName: call.capability, toolVersion: call.toolVersion, params: call.params }
    });

    const finish = (result: ToolResult) => {
      void emitTrajectory({
        runId: call.runId,
        type: result.success ? "tool.call.completed" : "tool.call.failed",
        actor: "tool-gateway",
        traceId,
        idempotencyKey: `tool:${call.callId}:${result.success ? "completed" : "failed"}`,
        payload: {
          callId: call.callId, toolName: call.capability, status: result.status ?? (result.success ? "completed" : "failed"),
          durationMs: result.durationMs, errorCode: result.errorCode, cacheHit: result.cacheHit,
          outputPreview: outputPreview(result.data)
        },
        timing: { startedAt, completedAt: new Date().toISOString() },
        evidenceRefs: result.evidenceRefs ?? []
      });
      return result;
    };

    if (!tool) {
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "unknown_capability",
        error: { code: "unknown_capability", message: `Tool ${call.capability} not registered` },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    if (call.signal?.aborted) {
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "tool_cancelled",
        error: { code: "tool_cancelled", message: "Tool execution was cancelled before dispatch." },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    if (!call.runId || !call.callId || !call.params || typeof call.params !== "object" || Array.isArray(call.params)) {
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "invalid_tool_input",
        error: { code: "invalid_tool_input", message: "Tool call requires a runId, callId and object params." },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    if (typeof call.params.runId === "string" && call.params.runId !== call.runId) {
      const result = finish({
        callId: call.callId, success: false, status: "failed", nextState: "blocked", errorCode: "tool_scope_violation",
        error: { code: "tool_scope_violation", message: "A tool may only read or mutate the active run." }, cacheHit: false, durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }
    if (typeof call.params.projectId === "string" && this.serviceLayer.authorizeToolCallRaw && !await this.serviceLayer.authorizeToolCallRaw(call.runId, call.params.projectId, call.signal)) {
      const result = finish({
        callId: call.callId, success: false, status: "failed", nextState: "blocked", errorCode: "tool_project_forbidden",
        error: { code: "tool_project_forbidden", message: "The tool call is outside the active project scope." }, cacheHit: false, durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    const schema = tool.definition.inputSchema;
    for (const [key, descriptor] of Object.entries(schema)) {
      if (String(descriptor).endsWith("?") || key in call.params) continue;
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "invalid_tool_input",
        error: { code: "invalid_tool_input", message: `Missing required tool input: ${key}` },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }
    for (const [key, descriptor] of Object.entries(schema)) {
      const expected = String(descriptor).replace(/\?$/, "");
      const value = call.params[key];
      if (value === undefined || expected === "unknown" || expected === "object" && value && typeof value === "object") continue;
      const valid = expected === "string" ? typeof value === "string" : expected === "number" ? typeof value === "number" && Number.isFinite(value) : expected === "boolean" ? typeof value === "boolean" : expected === "object" ? false : true;
      if (!valid) {
        const result = finish({
          callId: call.callId, success: false, status: "failed", nextState: "blocked", errorCode: "invalid_tool_input",
          error: { code: "invalid_tool_input", message: `Invalid type for tool input: ${key}` }, cacheHit: false, durationMs: Date.now() - start
        });
        this.idempotentResults.set(idempotencyKey, result);
        return result;
      }
    }

    if (call.toolVersion !== tool.definition.version) {
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "tool_version_mismatch",
        error: { code: "tool_version_mismatch", message: `Requested ${call.toolVersion}, active ${tool.definition.version}` },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    if (!tool.definition.isReadOnly && tool.definition.approvalRequired && call.approved !== true) {
      void emitTrajectory({
        runId: call.runId,
        type: "approval.requested",
        actor: "tool-gateway",
        traceId,
        idempotencyKey: `tool:${call.callId}:approval-requested`,
        payload: { callId: call.callId, capability: call.capability, riskLevel: tool.definition.riskLevel }
      });
      const result = finish({
        callId: call.callId,
        success: false,
        status: "needs-confirmation",
        nextState: "waiting_user",
        errorCode: "capability_confirmation_required",
        userMessage: "该操作需要用户确认后才能执行。",
        error: { code: "capability_confirmation_required", message: "This capability requires a user approval interrupt." },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }

    if (!tool.definition.isReadOnly && tool.definition.approvalRequired && call.approved === true) {
      void emitTrajectory({
        runId: call.runId,
        type: "approval.resolved",
        actor: "tool-gateway",
        traceId,
        idempotencyKey: `tool:${call.callId}:approval-resolved`,
        payload: { callId: call.callId, capability: call.capability, decision: "approved" }
      });
    }

    try {
      const cacheKey = `${call.capability}:${JSON.stringify(call.params)}`;
      const cached = tool.definition.isReadOnly ? this.cache.get(cacheKey) : undefined;
      if (cached && cached.expiresAt > Date.now()) {
      const result = finish({ callId: call.callId, success: true, data: cached.data, cacheHit: true, durationMs: 0, ...structuredOutcome(cached.data) });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
      }

      const data = await executeWithControl(tool.handler(call.params, call.runId, call.signal), toolTimeoutMs(call.timeoutMs), call.signal);

      if (tool.definition.isReadOnly) this.cache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
        data
      });

      const result = finish({
        callId: call.callId,
        success: true,
        data,
        ...structuredOutcome(data),
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const controlledError = message === "tool_timeout" || message === "tool_cancelled";
      const result = finish({
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: controlledError ? message : "execution_error",
        error: { code: controlledError ? message : "execution_error", message },
        cacheHit: false,
        durationMs: Date.now() - start
      });
      this.idempotentResults.set(idempotencyKey, result);
      return result;
    }
  }

  async executeKnowledge(input: { context: LlmKnowledgeContext; request: KnowledgeToolRequest; traceId?: string }) {
    return executeUnifiedKnowledgeTool(input);
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  listToolDefinitions(): ToolVersion[] {
    return this.registry.listDefinitions();
  }
}

function structuredOutcome(value: unknown): Partial<Pick<ToolResult, "status" | "actionId" | "evidenceRefs" | "nextState" | "errorCode" | "userMessage">> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const status = record.status;
  return {
    ...(status === "completed" || status === "blocked" || status === "failed" || status === "needs-confirmation" ? { status } : {}),
    ...(typeof record.actionId === "string" ? { actionId: record.actionId } : {}),
    ...(Array.isArray(record.evidenceRefs) ? { evidenceRefs: record.evidenceRefs.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof record.nextState === "string" ? { nextState: record.nextState } : {}),
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
    ...(typeof record.userMessage === "string" ? { userMessage: record.userMessage } : {})
  };
}

let instance: ToolGateway | null = null;

export function getToolGateway(serviceLayer?: ServiceLayer): ToolGateway {
  if (serviceLayer) {
    instance = new ToolGateway(serviceLayer);
  }
  if (!instance) {
    throw new Error("ToolGateway not initialized.");
  }
  return instance;
}
