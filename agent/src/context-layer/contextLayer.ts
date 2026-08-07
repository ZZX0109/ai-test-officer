/**
 * Agent Context Layer — LLM 可访问的数据中间层
 *
 * 禁止 LLM 直接访问数据库。提供受控只读接口：
 *   get_project_context / get_run_status / get_evidence /
 *   get_failure_history / get_repair_history
 *
 * 含数据脱敏、权限过滤、上下文摘要。
 */

import type {
  ContextAccessPolicy,
  ContextLayerOutput,
  EvidenceContext,
  FailureHistoryContext,
  ProjectContext,
  RepairHistoryContext,
  RunStatusContext
} from "@ai-test-officer/contracts";
import { contextLayerOutputSchema } from "@ai-test-officer/contracts";
import { redactAll, estimateTokenCount, truncateByTokenBudget } from "./redaction.js";

// ─── 上下文摘要策略 ──────────────────────────────────────────────

const CONTEXT_STRATEGY = {
  maxProjectSummaryLength: 500,
  maxRunSummaryLength: 300,
  maxEvidenceSummaryLength: 500,
  maxFailureSummaryLength: 400,
  maxRepairSummaryLength: 400,
} as const;

function summarizeProject(ctx: ProjectContext): string {
  const parts: string[] = [];
  parts.push(`项目 ${ctx.project.name}（${ctx.project.techStack.join("、")}）`);
  parts.push(`路由 ${ctx.routing.frontendRoutes.length} 条，API ${ctx.routing.apiEndpoints.length} 个`);
  parts.push(`测试路径 ${ctx.testPaths.length} 条，登录方式 ${ctx.login.method}`);
  if (ctx.dependencies.knownIssues.length > 0) {
    parts.push(`已知依赖问题 ${ctx.dependencies.knownIssues.length} 个`);
  }
  return parts.join("；").slice(0, CONTEXT_STRATEGY.maxProjectSummaryLength);
}

function summarizeRun(ctx: RunStatusContext): string {
  const parts: string[] = [];
  parts.push(`Run ${ctx.runId} 状态 ${ctx.state}`);
  if (ctx.finalStatus) parts.push(`最终判定 ${ctx.finalStatus}`);
  parts.push(`进度 ${Math.round(ctx.progress * 100)}%`);
  if (ctx.activeInterrupts.length > 0) parts.push(`${ctx.activeInterrupts.length} 个待处理中断`);
  if (ctx.recentErrors.length > 0) parts.push(`最近错误: ${ctx.recentErrors[0].message}`);
  return parts.join("，").slice(0, CONTEXT_STRATEGY.maxRunSummaryLength);
}

function summarizeEvidence(ctx: EvidenceContext): string {
  const parts: string[] = [];
  parts.push(`证据 ${ctx.artifacts.length} 条`);
  parts.push(`断言 ${ctx.assertions.length} 条（通过 ${ctx.assertions.filter((a) => a.passed).length}）`);
  if (ctx.machineGate) parts.push(`门禁 ${ctx.machineGate.status}`);
  return parts.join("，").slice(0, CONTEXT_STRATEGY.maxEvidenceSummaryLength);
}

function summarizeFailure(ctx: FailureHistoryContext): string {
  const parts: string[] = [];
  parts.push(`历史失败 ${ctx.statistics.total} 次（已解决 ${ctx.statistics.resolved}，未解决 ${ctx.statistics.open}）`);
  if (ctx.statistics.mostFrequentType) parts.push(`最常见类型: ${ctx.statistics.mostFrequentType}`);
  return parts.join("，").slice(0, CONTEXT_STRATEGY.maxFailureSummaryLength);
}

function summarizeRepair(ctx: RepairHistoryContext): string {
  const parts: string[] = [];
  parts.push(`修复记录 ${ctx.statistics.total} 次（成功率 ${Math.round(ctx.statistics.successRate * 100)}%）`);
  if (ctx.statistics.mostFrequentRepairType) parts.push(`最常用策略: ${ctx.statistics.mostFrequentRepairType}`);
  return parts.join("，").slice(0, CONTEXT_STRATEGY.maxRepairSummaryLength);
}

// ─── 主 Context Layer ────────────────────────────────────────────

export interface ContextLayerDependencies {
  getProjectContext: (projectId: string) => Promise<ProjectContext>;
  getRunStatus: (runId: string) => Promise<RunStatusContext>;
  getEvidence: (runId: string) => Promise<EvidenceContext>;
  getFailureHistory: (projectId: string) => Promise<FailureHistoryContext>;
  getRepairHistory: (projectId: string) => Promise<RepairHistoryContext>;
}

export class ContextLayer {
  private deps: ContextLayerDependencies;

  constructor(deps: ContextLayerDependencies) {
    this.deps = deps;
  }

  /**
   * 根据策略生成 Context Layer 输出。LLM 只能通过此方法获取上下文数据。
   */
  async build(policy: ContextAccessPolicy): Promise<ContextLayerOutput> {
    const now = new Date().toISOString();
    if (Date.parse(policy.expiresAt) <= Date.now()) {
      throw new Error("context_policy_expired");
    }
    const allRedactions: Array<{ field: string; reason: string }> = [];
    const requestedNamespaces = policy.allowedNamespaces;

    // 收集原始数据
    let projectContext: ProjectContext | undefined;
    let runStatus: RunStatusContext | undefined;
    let evidence: EvidenceContext | undefined;
    let failureHistory: FailureHistoryContext | undefined;
    let repairHistory: RepairHistoryContext | undefined;

    // 如果没有任何 namespace，直接返回空结果
    if (requestedNamespaces.length === 0) {
      return {
        schemaVersion: "1.0",
        policy,
        requestedNamespaces: [],
        results: {},
        redactions: [],
        tokenEstimate: 0,
        generatedAt: now
      };
    }

    const projectId = policy.projectId;

    // 并行获取数据
    const fetchPromises: Array<Promise<void>> = [];

    if (requestedNamespaces.includes("project_context")) {
      fetchPromises.push(
        this.deps.getProjectContext(projectId).then((result) => { projectContext = result; })
      );
    }
    if (requestedNamespaces.includes("run_status") && policy.runId) {
      fetchPromises.push(this.deps.getRunStatus(policy.runId).then((result) => { runStatus = result; }));
    }
    if (requestedNamespaces.includes("evidence") && policy.runId) {
      fetchPromises.push(this.deps.getEvidence(policy.runId).then((result) => { evidence = result; }));
    }
    if (requestedNamespaces.includes("failure_history")) {
      fetchPromises.push(
        this.deps.getFailureHistory(projectId).then((result) => { failureHistory = result; })
      );
    }
    if (requestedNamespaces.includes("repair_history")) {
      fetchPromises.push(
        this.deps.getRepairHistory(projectId).then((result) => { repairHistory = result; })
      );
    }

    await Promise.all(fetchPromises);

    // 合并摘要
    if (projectContext) {
      projectContext.summary = summarizeProject(projectContext);
    }

    // 脱敏处理
    const results = {
      project_context: projectContext,
      run_status: runStatus,
      evidence,
      failure_history: failureHistory,
      repair_history: repairHistory
    };
    const resultRecord = results as Record<string, unknown>;

    // 对每个结果字段进行脱敏
    for (const [key, value] of Object.entries(results)) {
      if (!value) continue;
      const json = JSON.stringify(value);
      const redacted = redactAll(json);
      allRedactions.push(...redacted.redactions);
      try {
        const parsed = JSON.parse(redacted.text) as typeof value;
        resultRecord[key] = parsed;
      } catch {
        // Fail closed if redaction produced a non-JSON value. Returning the raw
        // object here would defeat the boundary and leak secrets to the model.
        resultRecord[key] = undefined;
      }
    }

    // 合并所有结果文本估算 token
    const allText = JSON.stringify(results);
    const tokenEstimate = estimateTokenCount(allText);

    // 如果超出预算，截断
    if (tokenEstimate > policy.maxContextTokens) {
      // 按优先级保留：project_context > evidence > failure > repair
      // 超出预算则截断低优先级字段
      if (estimateTokenCount(JSON.stringify(results)) > policy.maxContextTokens) {
        // 简化策略：截断文本化结果
        // Keep the contract-shaped result intact. Consumers use tokenEstimate to
        // decide whether to ask for a narrower namespace set; never emit malformed
        // partial objects that cannot be validated by the contracts package.
        void truncateByTokenBudget(allText, policy.maxContextTokens);
      }
    }

    return contextLayerOutputSchema.parse({
      schemaVersion: "1.0",
      policy,
      requestedNamespaces: [...requestedNamespaces],
      results,
      redactions: allRedactions,
      tokenEstimate,
      generatedAt: now
    });
  }

  /**
   * 简化的即时查询：只获取项目上下文
   */
  async getProjectContext(policy: Pick<ContextAccessPolicy, "projectId" | "subject" | "maxContextTokens">): Promise<ProjectContext> {
    const fullPolicy: ContextAccessPolicy = {
      schemaVersion: "1.0",
      policyId: `ctx_${Date.now()}`,
      subject: policy.subject,
      projectId: policy.projectId,
      allowedNamespaces: ["project_context"],
      maxContextTokens: policy.maxContextTokens ?? 8_000,
      redactSecrets: true,
      redactPII: true,
      allowRawPaths: false,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      issuedAt: new Date().toISOString()
    };
    const output = await this.build(fullPolicy);
    if (!output.results.project_context) {
      throw new Error("project_context_unavailable");
    }
    return output.results.project_context;
  }
}

// 单例
let instance: ContextLayer | null = null;

export function getContextLayer(deps?: ContextLayerDependencies): ContextLayer {
  if (deps) {
    instance = new ContextLayer(deps);
  }
  if (!instance) {
    throw new Error("ContextLayer not initialized. Call getContextLayer(deps) first.");
  }
  return instance;
}
