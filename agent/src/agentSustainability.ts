/**
 * Application composition for the sustainable-agent modules.
 *
 * The modules are deliberately composed here instead of imported directly by
 * every route. This makes ContextLayer, memory, tools, tracing and write
 * safety one observable boundary and keeps the legacy API compatible.
 */
import { getContextLayer, type ContextLayerDependencies } from "./context-layer/index.js";
import { getMemoryService } from "./memory/index.js";
import { getToolGateway, type ServiceLayer } from "./tool-gateway/index.js";
import { getTracer } from "./tracing/index.js";
import { getWriteSafetyLayer } from "./write-safety/index.js";
import { getLlmInputCompiler } from "./llm-input/index.js";
import { getFeedbackLoop } from "./feedback-loop/index.js";
import type { EvidenceContext, FailureHistoryContext, ProjectContext, RepairHistoryContext, RunStatusContext } from "@ai-test-officer/contracts";

const now = () => new Date().toISOString();
const projectContext = (projectId: string): ProjectContext => ({
  schemaVersion: "1.0",
  project: { id: projectId, name: projectId, techStack: [], packageManager: "unknown" },
  routing: { frontendRoutes: [], apiEndpoints: [] }, testPaths: [],
  login: { method: "none", requiresCredentials: false },
  dependencies: { knownIssues: [], commonProblems: [] },
  summary: "项目上下文尚未完成发现。", generatedAt: now()
});
const runStatus = (runId: string): RunStatusContext => ({
  schemaVersion: "1.0", runId, state: "unknown", progress: 0, completedNodes: [], elapsedMs: 0,
  budget: { tokensUsed: 0, tokensBudget: 0, wallClockMs: 0, wallClockBudgetMs: 0, llmCallsUsed: 0, llmCallsBudget: 0 },
  activeInterrupts: [], recentErrors: [], summary: "运行状态尚未恢复。", generatedAt: now()
});
const evidence = (runId: string): EvidenceContext => ({
  schemaVersion: "1.0", runId, artifacts: [], assertions: [], summary: "尚未采集运行证据。", generatedAt: now()
});
const failureHistory = (projectId: string): FailureHistoryContext => ({
  schemaVersion: "1.0", projectId, failures: [], statistics: { total: 0, resolved: 0, open: 0 }, summary: "暂无失败历史。", generatedAt: now()
});
const repairHistory = (projectId: string): RepairHistoryContext => ({
  schemaVersion: "1.0", projectId, repairs: [], statistics: { total: 0, applied: 0, successRate: 0 }, summary: "暂无修复历史。", generatedAt: now()
});

let initialized = false;
export function initializeAgentSustainability(deps?: Partial<ContextLayerDependencies>): void {
  if (initialized) return;
  const contextDeps: ContextLayerDependencies = {
    getProjectContext: deps?.getProjectContext ?? (async (id) => projectContext(id)),
    getRunStatus: deps?.getRunStatus ?? (async (id) => runStatus(id)),
    getEvidence: deps?.getEvidence ?? (async (id) => evidence(id)),
    getFailureHistory: deps?.getFailureHistory ?? (async (id) => failureHistory(id)),
    getRepairHistory: deps?.getRepairHistory ?? (async (id) => repairHistory(id))
  };
  getContextLayer(contextDeps);
  const service: ServiceLayer = {
    getProjectContextRaw: async (id) => projectContext(id),
    getRunStatusRaw: async (id) => runStatus(id),
    getEvidenceRaw: async (id) => evidence(id),
    getFailureHistoryRaw: async (id) => failureHistory(id),
    getRepairHistoryRaw: async (id) => repairHistory(id),
    queryProjectMemoryRaw: async (id, category) => getMemoryService().queryProjectEntries({ projectId: id, ...(category ? { category: category as never } : {}), includeUnverified: true, limit: 50 }),
    queryExperienceMemoryRaw: async (id, failureType) => getMemoryService().queryExperienceEntries({ projectId: id, ...(failureType ? { failureType: [failureType as never] } : {}), includeUnvalidated: true, limit: 50, semanticLimit: 10, semanticThreshold: 0.6, offset: 0 }),
    getSchemaVersionsRaw: async () => ({ contracts: "1.0", agentModules: "1.0" })
  };
  getToolGateway(service);
  getTracer(); getWriteSafetyLayer(); getLlmInputCompiler(); getFeedbackLoop();
  initialized = true;
}

export function getAgentSustainability() {
  initializeAgentSustainability();
  return {
    context: getContextLayer(), memory: getMemoryService(), tools: getToolGateway(), tracer: getTracer(),
    writeSafety: getWriteSafetyLayer(), compiler: getLlmInputCompiler(), feedback: getFeedbackLoop()
  };
}
