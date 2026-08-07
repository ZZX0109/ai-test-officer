/**
 * Tool Gateway — LLM 调用数据库的唯一通道
 *
 * LLM → Tool Gateway → Service Layer → Database
 * 数据库只作为事实存储，不暴露给 Agent。
 */

import type { ProjectMemoryEntry, ToolVersion, ExperienceMemoryEntry } from "@ai-test-officer/contracts";
import { getContextLayer } from "../context-layer/index.js";
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
  | "search_similar_experiences";

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

const toolMetadata = (capability: ToolCapability, name: string, inputSchema: Record<string, unknown>): ToolVersion => {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0", toolId: `tool-${capability}`, toolName: name, version: "1.0.0",
    capability, isReadOnly: true, inputSchema, outputSchema: {}, changelog: [],
    compatibleApiContractVersions: [], riskLevel: "low", approvalRequired: false,
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
      handler: async (params) => {
        const contextLayer = getContextLayer();
        return contextLayer.getProjectContext({
          projectId: params.projectId as string,
          subject: "llm_agent",
          maxContextTokens: 8_000
        });
      }
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
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    const tool = this.registry.get(call.capability);

    if (!tool) {
      return {
        callId: call.callId,
        success: false,
        error: { code: "unknown_capability", message: `Tool ${call.capability} not registered` },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    if (call.toolVersion !== tool.definition.version) {
      return {
        callId: call.callId,
        success: false,
        error: { code: "tool_version_mismatch", message: `Requested ${call.toolVersion}, active ${tool.definition.version}` },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    if (!tool.definition.isReadOnly) {
      return {
        callId: call.callId,
        success: false,
        error: { code: "write_not_allowed", message: "Write tools must go through write safety layer" },
        cacheHit: false,
        durationMs: Date.now() - start
      };
    }

    try {
      const cacheKey = `${call.capability}:${JSON.stringify(call.params)}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { callId: call.callId, success: true, data: cached.data, cacheHit: true, durationMs: 0 };
      }

      const data = await tool.handler(call.params, call.runId);

      this.cache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
        data
      });

      return {
        callId: call.callId,
        success: true,
        data,
        cacheHit: false,
        durationMs: Date.now() - start
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: call.callId,
        success: false,
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
