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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Adapt authoritative application-service payloads into the ContextLayer contract. */
function adaptProjectContext(projectId: string, raw: unknown): ProjectContext {
  const value = asRecord(raw);
  if (value.schemaVersion === "1.0" && value.routing && value.testPaths && value.login) return value as ProjectContext;
  const project = asRecord(value.project ?? value);
  const manifest = asRecord(value.manifest ?? project.manifest);
  const routes = asRecord(manifest.routes);
  const frontendRoutes = Array.isArray(routes.frontend) ? routes.frontend : Array.isArray(routes.frontendRoutes) ? routes.frontendRoutes : [];
  const apiEndpoints = Array.isArray(routes.api) ? routes.api : Array.isArray(routes.apiEndpoints) ? routes.apiEndpoints : [];
  // ProjectManifest keeps the authoritative API inventory under
  // `apiOperations` (there is no requirement for a synthetic `routes` tree).
  // Include those operations in the context instead of silently handing the
  // model an empty routing section.
  const manifestApiOperations = Array.isArray(manifest.apiOperations) ? manifest.apiOperations : [];
  const frontendUrl = typeof project.frontendUrl === "string" ? project.frontendUrl : undefined;
  const rootRoute = frontendUrl
    ? [{ path: (() => { try { return new URL(frontendUrl).pathname || "/"; } catch { return frontendUrl; } })(), title: String(project.name ?? projectId), authRequired: Boolean(project.hasLogin || project.login) }]
    : [];
  const capabilityList = Array.isArray(manifest.businessCapabilities) ? manifest.businessCapabilities : [];
  const capabilityFlags = asRecord(project.capabilities ?? manifest.capabilities);
  const projectLogin = asRecord(project.login);
  return {
    schemaVersion: "1.0",
    project: {
      id: String(project.id ?? projectId), name: String(project.name ?? projectId),
      techStack: Array.isArray(project.techStack) ? project.techStack.map(String) : [],
      packageManager: String(project.packageManager ?? "unknown"), framework: typeof project.framework === "string" ? project.framework : undefined,
      runtime: typeof project.runtime === "string" ? project.runtime : undefined
    },
    routing: {
      frontendRoutes: [
        ...rootRoute,
        ...frontendRoutes.flatMap((item: unknown) => { const route = asRecord(item); return typeof route.path === "string" ? [{ path: route.path, title: typeof route.title === "string" ? route.title : undefined, authRequired: route.authRequired === true }] : []; })
      ].filter((route, index, all) => all.findIndex((candidate) => candidate.path === route.path) === index),
      apiEndpoints: [
        ...apiEndpoints.flatMap((item: unknown) => { const endpoint = asRecord(item); return typeof endpoint.path === "string" ? [{ method: String(endpoint.method ?? "GET"), path: endpoint.path, operationId: typeof endpoint.operationId === "string" ? endpoint.operationId : undefined }] : []; }),
        ...manifestApiOperations.flatMap((item: unknown) => { const operation = asRecord(item); return typeof operation.pathTemplate === "string" ? [{ method: String(operation.method ?? "GET"), path: operation.pathTemplate, operationId: typeof operation.operationId === "string" ? operation.operationId : undefined }] : []; })
      ].filter((endpoint, index, all) => all.findIndex((candidate) => candidate.method === endpoint.method && candidate.path === endpoint.path && candidate.operationId === endpoint.operationId) === index)
    },
    testPaths: capabilityList.flatMap((item: unknown) => {
      const capability = asRecord(item);
      if (typeof capability.id !== "string" || typeof capability.name !== "string") return [];
      const prefixes = Array.isArray(capability.routePrefixes) ? capability.routePrefixes.filter((prefix): prefix is string => typeof prefix === "string") : [];
      return [{ id: capability.id, title: capability.name, entryUrl: prefixes[0] ?? frontendUrl, steps: [String(capability.purpose ?? "验证该业务能力的关键动作和预期结果")], risk: capability.risk === "high" ? "high" as const : capability.risk === "low" ? "low" as const : "medium" as const }];
    }),
    login: { method: projectLogin.method === "storage_state" ? "storage_state" as const : projectLogin.method === "env" ? "env" as const : project.hasLogin || project.login ? "form" as const : "none" as const, requiresCredentials: Boolean(project.hasLogin || project.login), credentialHints: Array.isArray(project.apiCredentialRequirementNames) ? project.apiCredentialRequirementNames.map(String) : undefined },
    dependencies: { knownIssues: [], commonProblems: [] },
    summary: `项目 ${String(project.name ?? projectId)}；技术栈 ${Array.isArray(project.techStack) ? project.techStack.join("、") : "未知"}；能力 ${Object.keys(capabilityFlags).filter((key) => capabilityFlags[key] === true).join("、") || "按运行时清单"}`,
    generatedAt: now()
  };
}

function adaptRunStatus(runId: string, raw: unknown): RunStatusContext {
  const value = asRecord(raw);
  if (value.schemaVersion === "1.0" && value.budget && value.activeInterrupts) return value as RunStatusContext;
  const input = asRecord(value.input);
  const state = String(value.state ?? value.status ?? "unknown");
  const progress = typeof value.progress === "number" ? Math.max(0, Math.min(1, value.progress)) : 0;
  return {
    schemaVersion: "1.0", runId, state, progress,
    currentNode: typeof value.currentNode === "string" ? value.currentNode : undefined,
    completedNodes: Array.isArray(value.completedNodes) ? value.completedNodes.map(String) : [], elapsedMs: Number(value.elapsedMs ?? 0),
    budget: { tokensUsed: Number(value.tokensUsed ?? 0), tokensBudget: Number(input.maxTotalTokens ?? 0), wallClockMs: Number(value.elapsedMs ?? 0), wallClockBudgetMs: Number(input.totalTimeoutMs ?? 0), llmCallsUsed: Number(value.llmCallsUsed ?? 0), llmCallsBudget: Number(input.maxCalls ?? 0) },
    activeInterrupts: Array.isArray(value.activeInterrupts) ? value.activeInterrupts.flatMap((item: unknown) => { const interrupt = asRecord(item); return typeof interrupt.interruptId === "string" && typeof interrupt.capability === "string" ? [{ interruptId: interrupt.interruptId, capability: interrupt.capability, reason: String(interrupt.reason ?? "需要确认"), requiresConfirmation: interrupt.requiresConfirmation !== false }] : []; }) : [],
    recentErrors: Array.isArray(value.recentErrors) ? value.recentErrors.flatMap((item: unknown) => { const error = asRecord(item); return typeof error.message === "string" ? [{ code: String(error.code ?? "runtime_error"), message: error.message.slice(0, 500), node: typeof error.node === "string" ? error.node : undefined, at: typeof error.at === "string" ? error.at : now() }] : []; }) : [],
    summary: `Run ${runId} 当前状态 ${state}，进度 ${Math.round(progress * 100)}%。`, generatedAt: now()
  };
}

function adaptEvidence(runId: string, raw: unknown): EvidenceContext {
  const value = asRecord(raw);
  if (value.schemaVersion === "1.0" && Array.isArray(value.artifacts)) return value as EvidenceContext;
  const bundle = asRecord(value.bundle);
  const result = asRecord(bundle.result ?? value.result);
  const artifacts = Array.isArray(result.artifactsV2) ? result.artifactsV2 : Array.isArray(result.artifacts) ? result.artifacts : [];
  const assertions = Array.isArray(result.assertions) ? result.assertions : [];
  const gate = asRecord(result.machineGate);
  return {
    schemaVersion: "1.0", runId,
    artifacts: artifacts.slice(0, 20).flatMap((item: unknown) => { const artifact = asRecord(item); const integrity = asRecord(artifact.integrity); return typeof artifact.id === "string" ? [{ id: artifact.id, kind: String(artifact.kind ?? "unknown"), origin: String(artifact.origin ?? "runtime"), sizeBytes: Number(integrity.sizeBytes ?? artifact.sizeBytes ?? 0), capturedAt: String(artifact.createdAt ?? artifact.capturedAt ?? now()), summary: String(artifact.title ?? artifact.summary ?? "运行证据"), integritySha256: typeof integrity.sha256 === "string" ? integrity.sha256 : undefined }] : []; }),
    assertions: assertions.slice(0, 30).flatMap((item: unknown) => { const assertion = asRecord(item); return typeof assertion.name === "string" ? [{ name: assertion.name, passed: assertion.passed === true, expected: typeof assertion.expected === "string" ? assertion.expected : undefined, actual: typeof assertion.actual === "string" ? assertion.actual : undefined, evidenceRefs: Array.isArray(assertion.evidenceRefs) ? assertion.evidenceRefs.map(String) : [] }] : []; }),
    machineGate: typeof gate.status === "string" ? { status: gate.status, reasons: Array.isArray(gate.reasons) ? gate.reasons.map(String) : [], evidenceComplete: gate.evidenceComplete === true } : undefined,
    summary: `运行 ${runId} 已采集 ${artifacts.length} 条证据、${assertions.length} 条断言。`, generatedAt: now()
  };
}

function adaptFailureHistory(projectId: string, raw: unknown): FailureHistoryContext {
  if (asRecord(raw).schemaVersion === "1.0") return raw as FailureHistoryContext;
  const rows = Array.isArray(raw) ? raw : [];
  const failures = rows.flatMap((item: unknown, index) => { const row = asRecord(item); return row.verdict && row.verdict !== "pass" ? [{ failureId: String(row.id ?? `failure_${index}`), runId: String(row.runId ?? row.id ?? "unknown"), scenarioId: typeof row.scenarioId === "string" ? row.scenarioId : undefined, failureType: "other" as const, title: String(row.summary ?? "运行失败"), description: String(row.summary ?? row.verdict), occurredAt: String(row.createdAt ?? now()), resolvedAt: undefined, resolutionStatus: "open" as const, affectedPaths: [] }] : []; });
  return { schemaVersion: "1.0", projectId, failures, statistics: { total: failures.length, resolved: 0, open: failures.length }, summary: `项目共有 ${failures.length} 条未通过运行记录。`, generatedAt: now() };
}

function adaptRepairHistory(projectId: string, raw: unknown): RepairHistoryContext {
  if (asRecord(raw).schemaVersion === "1.0") return raw as RepairHistoryContext;
  const rows = Array.isArray(raw) ? raw : [];
  const repairs = rows.flatMap((item: unknown) => { const row = asRecord(item); const validation = asRecord(row.validation); return typeof row.id === "string" ? [{ repairSessionId: row.id, runId: String(row.runId ?? "unknown"), repairType: row.failureClass === "product-bug" ? "code_patch" as const : "other" as const, description: String(row.summary ?? "修复会话"), filesChanged: Array.isArray(row.files) ? row.files.map((file) => String(asRecord(file).path ?? "")) : [], validationResult: validation.status === "passed" ? "passed" as const : validation.status === "failed" ? "failed" as const : "pending" as const, applied: row.status === "applied", createdAt: String(row.createdAt ?? now()), validatedAt: typeof validation.finishedAt === "string" ? validation.finishedAt : undefined }] : []; });
  return { schemaVersion: "1.0", projectId, repairs, statistics: { total: repairs.length, applied: repairs.filter((repair) => repair.applied).length, successRate: repairs.length ? repairs.filter((repair) => repair.validationResult === "passed").length / repairs.length : 0 }, summary: `项目共有 ${repairs.length} 条修复记录。`, generatedAt: now() };
}

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
export function initializeAgentSustainability(
  deps?: Partial<ContextLayerDependencies>,
  serviceOverrides?: Partial<ServiceLayer>
): void {
  if (initialized) return;
  const contextDeps: ContextLayerDependencies = {
    getProjectContext: deps?.getProjectContext ?? (serviceOverrides?.getProjectContextRaw ? async (id) => adaptProjectContext(id, await serviceOverrides.getProjectContextRaw!(id)) : async (id) => projectContext(id)),
    getRunStatus: deps?.getRunStatus ?? (serviceOverrides?.getRunStatusRaw ? async (id) => adaptRunStatus(id, await serviceOverrides.getRunStatusRaw!(id)) : async (id) => runStatus(id)),
    getEvidence: deps?.getEvidence ?? (serviceOverrides?.getEvidenceRaw ? async (id) => adaptEvidence(id, await serviceOverrides.getEvidenceRaw!(id)) : async (id) => evidence(id)),
    getFailureHistory: deps?.getFailureHistory ?? (serviceOverrides?.getFailureHistoryRaw ? async (id) => adaptFailureHistory(id, await serviceOverrides.getFailureHistoryRaw!(id)) : async (id) => failureHistory(id)),
    getRepairHistory: deps?.getRepairHistory ?? (serviceOverrides?.getRepairHistoryRaw ? async (id) => adaptRepairHistory(id, await serviceOverrides.getRepairHistoryRaw!(id)) : async (id) => repairHistory(id))
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
    getSchemaVersionsRaw: async () => ({ contracts: "1.0", agentModules: "1.0" }),
    ...serviceOverrides
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
