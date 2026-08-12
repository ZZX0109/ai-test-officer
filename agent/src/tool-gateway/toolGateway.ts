/**
 * Tool Gateway — LLM 调用数据库的唯一通道
 *
 * LLM → Tool Gateway → Service Layer → Database
 * 数据库只作为事实存储，不暴露给 Agent。
 */

import type { ProjectMemoryEntry, ToolVersion, ExperienceMemoryEntry } from "@ai-test-officer/contracts";
import { getMemoryService } from "../memory/index.js";

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
  | "create_validation_run";

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

// ─── Tool Registry ───────────────────────────────────────────────

interface RegisteredTool {
  definition: ToolVersion;
  handler: (params: Record<string, unknown>, runId: string) => Promise<unknown>;
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
  getProjectContextRaw: (projectId: string) => Promise<unknown>;
  getRunStatusRaw: (runId: string) => Promise<unknown>;
  getEvidenceRaw: (runId: string) => Promise<unknown>;
  getFailureHistoryRaw: (projectId: string) => Promise<unknown>;
  getRepairHistoryRaw: (projectId: string) => Promise<unknown>;
  queryProjectMemoryRaw: (projectId: string, category?: string) => Promise<unknown[]>;
  queryExperienceMemoryRaw: (projectId: string, failureType?: string) => Promise<unknown[]>;
  getSchemaVersionsRaw: () => Promise<unknown>;
  inspectRuntimeRaw?: (projectId: string) => Promise<unknown>;
  readRuntimeLogRaw?: (projectId: string, limit?: number) => Promise<unknown>;
  inspectHealthCheckRaw?: (projectId: string) => Promise<unknown>;
  observePageRaw?: (runId: string) => Promise<unknown>;
  readCurrentPlanRaw?: (runId: string) => Promise<unknown>;
  readFailedAttemptRaw?: (runId: string) => Promise<unknown>;
  readEvidenceProofRaw?: (runId: string) => Promise<unknown>;
  safeRecoveryActionRaw?: (action: SafeRecoveryCapability, params: Record<string, unknown>, runId: string) => Promise<unknown>;
}

// ─── Tool Gateway ────────────────────────────────────────────────

export class ToolGateway {
  private registry = new ToolRegistry();
  private serviceLayer: ServiceLayer;
  private cache = new Map<string, { expiresAt: number; data: unknown }>();

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
      handler: async (params) => this.serviceLayer.getProjectContextRaw(String(params.projectId ?? ""))
    });

    const contextTools: Array<[ToolCapability, string, Record<string, unknown>, (params: Record<string, unknown>, runId: string) => Promise<unknown>]> = [
      ["get_run_status", "get_run_status", { runId: "string" }, async (params, runId) => this.serviceLayer.getRunStatusRaw(typeof params.runId === "string" ? params.runId : runId)],
      ["get_evidence", "get_evidence", { runId: "string" }, async (params, runId) => this.serviceLayer.getEvidenceRaw(typeof params.runId === "string" ? params.runId : runId)],
      ["get_failure_history", "get_failure_history", { projectId: "string" }, async (params) => this.serviceLayer.getFailureHistoryRaw(String(params.projectId ?? ""))],
      ["get_repair_history", "get_repair_history", { projectId: "string" }, async (params) => this.serviceLayer.getRepairHistoryRaw(String(params.projectId ?? ""))]
    ];
    for (const [capability, name, schema, handler] of contextTools) {
      this.registry.register(capability, { definition: toolMetadata(capability, name, schema), handler });
    }

    // Query Project Memory
    this.registry.register("query_project_memory", {
      definition: toolMetadata("query_project_memory", "query_project_memory", { projectId: "string", category: "string?" }),
      handler: async (params) => {
        const memory = getMemoryService();
        const projectId = typeof params.projectId === "string" ? params.projectId : "";
        const category = typeof params.category === "string" && ["tech_stack", "routing", "test_path", "login_method", "dependency_issue", "startup_config", "framework_pattern"].includes(params.category)
          ? params.category as ProjectMemoryEntry["category"] : undefined;
        return memory.queryProjectEntries({ projectId, ...(category ? { category } : {}), includeUnverified: true, limit: 50 });
      }
    });

    // Query Experience Memory
    this.registry.register("query_experience_memory", {
      definition: toolMetadata("query_experience_memory", "query_experience_memory", { projectId: "string?", failureType: "string?" }),
      handler: async (params) => {
        const memory = getMemoryService();
        const failureType = typeof params.failureType === "string" && ["selector_not_found", "timeout", "assertion_failed", "network_error", "page_crash", "auth_failure", "data_mismatch", "environment_issue", "flaky_test", "other"].includes(params.failureType)
          ? [params.failureType as ExperienceMemoryEntry["failureType"]] : undefined;
        return memory.queryExperienceEntries({ projectId: typeof params.projectId === "string" ? params.projectId : undefined, ...(failureType ? { failureType } : {}), limit: 50, semanticLimit: 10, semanticThreshold: 0.6, includeUnvalidated: true, offset: 0 });
      }
    });

    // Search Similar Experiences
    this.registry.register("search_similar_experiences", {
      definition: toolMetadata("search_similar_experiences", "search_similar_experiences", { query: "string", projectId: "string?" }),
      handler: async (params) => {
        const memory = getMemoryService();
        return memory.searchByEmbedding(
          params.query as string,
          params.projectId as string | undefined
        );
      }
    });

    const observationTools: Array<[ToolCapability, string, Record<string, unknown>, (params: Record<string, unknown>, runId: string) => Promise<unknown>]> = [
      ["inspect_runtime", "inspect_runtime", { projectId: "string" }, async (params) => this.serviceLayer.inspectRuntimeRaw?.(String(params.projectId ?? "")) ?? { status: "blocked", errorCode: "runtime_inspector_unavailable" }],
      ["read_runtime_log", "read_runtime_log", { projectId: "string", limit: "number?" }, async (params) => this.serviceLayer.readRuntimeLogRaw?.(String(params.projectId ?? ""), typeof params.limit === "number" ? params.limit : 100) ?? { status: "blocked", errorCode: "runtime_log_unavailable" }],
      ["inspect_health_check", "inspect_health_check", { projectId: "string" }, async (params) => this.serviceLayer.inspectHealthCheckRaw?.(String(params.projectId ?? "")) ?? { status: "blocked", errorCode: "health_check_unavailable" }],
      ["observe_page", "observe_page", { runId: "string" }, async (params, runId) => this.serviceLayer.observePageRaw?.(String(params.runId ?? runId)) ?? { status: "blocked", errorCode: "page_observer_unavailable" }],
      ["read_current_plan", "read_current_plan", { runId: "string" }, async (params, runId) => this.serviceLayer.readCurrentPlanRaw?.(String(params.runId ?? runId)) ?? { status: "blocked", errorCode: "plan_unavailable" }],
      ["read_failed_attempt", "read_failed_attempt", { runId: "string" }, async (params, runId) => this.serviceLayer.readFailedAttemptRaw?.(String(params.runId ?? runId)) ?? { status: "blocked", errorCode: "attempt_unavailable" }],
      ["read_evidence_proof", "read_evidence_proof", { runId: "string" }, async (params, runId) => this.serviceLayer.readEvidenceProofRaw?.(String(params.runId ?? runId)) ?? { status: "blocked", errorCode: "proof_unavailable" }]
    ];
    for (const [capability, name, schema, handler] of observationTools) {
      this.registry.register(capability, { definition: toolMetadata(capability, name, schema), handler });
    }

    const safeRecoveryTools: SafeRecoveryCapability[] = ["start_sandbox", "restart_sandbox", "resolve_port", "retry_health_check", "retry_discovery", "retry_failed_path", "continue_safe_paths", "create_validation_run"];
    for (const capability of safeRecoveryTools) {
      this.registry.register(capability, {
        definition: toolMetadata(capability, capability, { runId: "string", projectId: "string?" }, { isReadOnly: false, riskLevel: "medium", approvalRequired: false }),
        handler: async (params, runId) => {
          if (!this.serviceLayer.safeRecoveryActionRaw) return { status: "blocked", actionId: `tool_${capability}`, nextState: "waiting_user", errorCode: "recovery_gateway_unavailable", userMessage: "当前恢复工具尚未连接到 Agent Graph。" };
          return this.serviceLayer.safeRecoveryActionRaw(capability, params, runId);
        }
      });
    }
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const tool = this.registry.get(call.capability);

    if (!tool) {
      return {
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "unknown_capability",
        error: { code: "unknown_capability", message: `Tool ${call.capability} not registered` },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    if (call.toolVersion !== tool.definition.version) {
      return {
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "tool_version_mismatch",
        error: { code: "tool_version_mismatch", message: `Requested ${call.toolVersion}, active ${tool.definition.version}` },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    if (!tool.definition.isReadOnly && tool.definition.approvalRequired) {
      return {
        callId: call.callId,
        success: false,
        status: "needs-confirmation",
        nextState: "waiting_user",
        errorCode: "capability_confirmation_required",
        userMessage: "该操作需要用户确认后才能执行。",
        error: { code: "capability_confirmation_required", message: "This capability requires a user approval interrupt." },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    try {
      const cacheKey = `${call.capability}:${JSON.stringify(call.params)}`;
      const cached = tool.definition.isReadOnly ? this.cache.get(cacheKey) : undefined;
      if (cached && cached.expiresAt > Date.now()) {
        return { callId: call.callId, success: true, data: cached.data, cacheHit: true, durationMs: 0, ...structuredOutcome(cached.data) };
      }

      const data = await tool.handler(call.params, call.runId);

      if (tool.definition.isReadOnly) this.cache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
        data
      });

      return {
        callId: call.callId,
        success: true,
        data,
        ...structuredOutcome(data),
        cacheHit: false,
        durationMs: Date.now() - start
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: call.callId,
        success: false,
        status: "failed",
        nextState: "blocked",
        errorCode: "execution_error",
        error: { code: "execution_error", message },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }
  }

  getRegistry(): ToolRegistry {
    return this.registry;
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
