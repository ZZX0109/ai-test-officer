/**
 * Write Safety Layer
 *
 * LLM Action Proposal → Policy Check → Permission Approval → Execution → Database Update
 *
 * 含 action schema、风险等级、人工审批节点、操作日志。
 */

import type {
  WriteAction,
  PolicyCheckResult,
  ApprovalWorkflow,
  WriteExecutionResult,
  WriteOperationLog,
  RiskLevel
} from "@ai-test-officer/contracts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Policy Engine ───────────────────────────────────────────────

export interface PolicyRule {
  ruleId: string;
  description: string;
  capabilityPattern: RegExp;
  minRiskLevel: RiskLevel;
  requireParamsValidation: boolean;
  requiredApprovals: number;
  maxAffectedRows: number;
  validateParams?: (params: Record<string, unknown>) => string[];
}

export interface WriteSafetyStore {
  loadWorkflows(): Promise<ApprovalWorkflow[]>;
  saveWorkflow(workflow: ApprovalWorkflow): Promise<void>;
  appendLog(log: WriteOperationLog): Promise<void>;
  findLogByIdempotencyKey(idempotencyKey: string): Promise<WriteOperationLog | undefined>;
}

class MemoryWriteSafetyStore implements WriteSafetyStore {
  private workflows = new Map<string, ApprovalWorkflow>();
  private logs: WriteOperationLog[] = [];
  async loadWorkflows() { return [...this.workflows.values()]; }
  async saveWorkflow(workflow: ApprovalWorkflow) { this.workflows.set(workflow.workflowId, workflow); }
  async appendLog(log: WriteOperationLog) { this.logs.push(log); }
  async findLogByIdempotencyKey(idempotencyKey: string) { return this.logs.find((log) => log.traceId === idempotencyKey); }
}

interface WriteSafetyState { workflows: ApprovalWorkflow[]; logs: WriteOperationLog[]; }

/** Durable local fallback. Production deployments can replace this with a DB-backed store. */
export class FileWriteSafetyStore implements WriteSafetyStore {
  private loaded = false;
  private state: WriteSafetyState = { workflows: [], logs: [] };
  private writeChain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as WriteSafetyState;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async flush() {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writeChain;
  }
  async loadWorkflows() { await this.ensureLoaded(); return this.state.workflows.map((item) => ({ ...item, decisions: [...item.decisions] })); }
  async saveWorkflow(workflow: ApprovalWorkflow) { await this.ensureLoaded(); this.state.workflows = this.state.workflows.filter((item) => item.workflowId !== workflow.workflowId); this.state.workflows.push(workflow); await this.flush(); }
  async appendLog(log: WriteOperationLog) { await this.ensureLoaded(); if (!this.state.logs.some((item) => item.logId === log.logId)) this.state.logs.push(log); await this.flush(); }
  async findLogByIdempotencyKey(idempotencyKey: string) { await this.ensureLoaded(); return this.state.logs.find((log) => log.traceId === idempotencyKey); }
}

const DEFAULT_POLICY_RULES: PolicyRule[] = [
  {
    ruleId: "high-risk-requires-approval",
    description: "High and critical risk write actions require human approval",
    capabilityPattern: /.*/,
    minRiskLevel: "high",
    requireParamsValidation: true,
    requiredApprovals: 1,
    maxAffectedRows: 100
  },
  {
    ruleId: "critical-requires-dual-approval",
    description: "Critical risk actions require dual human approval",
    capabilityPattern: /.*/,
    minRiskLevel: "critical",
    requireParamsValidation: true,
    requiredApprovals: 2,
    maxAffectedRows: 10
  },
  {
    ruleId: "medium-risk-params-validation",
    description: "Medium risk actions require params validation",
    capabilityPattern: /.*/,
    minRiskLevel: "medium",
    requireParamsValidation: true,
    requiredApprovals: 0,
    maxAffectedRows: 1_000
  },
  {
    ruleId: "low-risk-auto-approve",
    description: "Low risk actions auto-approved with logging",
    capabilityPattern: /.*/,
    minRiskLevel: "low",
    requireParamsValidation: false,
    requiredApprovals: 0,
    maxAffectedRows: 10_000
  }
];

// ─── Risk Assessment ─────────────────────────────────────────────

const RISK_KEYWORDS = {
  critical: ["drop", "truncate", "format", "delete_all", "destroy", "purge"],
  high: ["delete", "remove", "update_all", "bulk_update", "schema_change", "migrate"],
  medium: ["update", "insert_bulk", "upsert", "rename"],
  low: ["insert", "create", "save", "write", "append"]
};

function assessActionRisk(action: WriteAction): RiskLevel {
  const capability = action.capability.toLowerCase();
  for (const keyword of RISK_KEYWORDS.critical) {
    if (capability.includes(keyword)) return "critical";
  }
  for (const keyword of RISK_KEYWORDS.high) {
    if (capability.includes(keyword)) return "high";
  }
  for (const keyword of RISK_KEYWORDS.medium) {
    if (capability.includes(keyword)) return "medium";
  }
  return "low";
}

// ─── Write Safety Layer ──────────────────────────────────────────

export interface WriteSafetyConfig {
  policyRules?: PolicyRule[];
  requireApprovalForRiskAbove?: RiskLevel;
  approvalTimeoutMs?: number;
  store?: WriteSafetyStore;
}

export class WriteSafetyLayer {
  private rules: PolicyRule[];
  private pendingApprovals = new Map<string, ApprovalWorkflow>();
  private operationLogs: WriteOperationLog[] = [];
  private config: WriteSafetyConfig;
  private readonly store: WriteSafetyStore;
  private loaded = false;

  constructor(config?: WriteSafetyConfig) {
    this.config = config ?? {};
    this.rules = this.config.policyRules ?? DEFAULT_POLICY_RULES;
    this.store = this.config.store ?? new MemoryWriteSafetyStore();
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    for (const workflow of await this.store.loadWorkflows()) this.pendingApprovals.set(workflow.workflowId, workflow);
  }

  // ─── Step 1: 接收 LLM Action Proposal ───────────────────────

  resolveProposal(action: WriteAction): WriteAction {
    // 计算或覆盖风险等级
    const assessedRisk = assessActionRisk(action);
    const finalRisk = compareRiskLevel(assessedRisk, action.riskLevel) > 0
      ? assessedRisk
      : action.riskLevel;

    return {
      ...action,
      riskLevel: finalRisk
    };
  }

  // ─── Step 2: Policy Check ────────────────────────────────────

  async policyCheck(action: WriteAction): Promise<PolicyCheckResult> {
    await this.ensureLoaded();
    const applicableRules = this.rules.filter(
      (rule) => rule.capabilityPattern.test(action.capability)
    );

    // Pick the rule that matches the proposed risk, rather than always using
    // the critical catch-all rule. This keeps low/medium actions deterministic
    // while preserving the stricter rule for high/critical writes.
    const matchingRules = applicableRules.filter((rule) => compareRiskLevel(action.riskLevel, rule.minRiskLevel) >= 0);
    const highestRule = matchingRules.sort((a, b) => compareRiskLevel(b.minRiskLevel, a.minRiskLevel))[0];
    if (!highestRule) {
      return {
        allowed: true,
        policyId: "default-allow",
        matchedRules: []
      };
    }

    const riskCompare = compareRiskLevel(action.riskLevel, highestRule.minRiskLevel);

    if (riskCompare >= 0) {
      const violations: PolicyRule[] = [];
      const paramsBytes = Buffer.byteLength(JSON.stringify(action.params));
      if (paramsBytes > 64 * 1024) violations.push(highestRule);
      if (highestRule.requireParamsValidation) {
        const invalidKeys = Object.keys(action.params).filter((key) => key === "__proto__" || key === "constructor" || key === "prototype");
        const customIssues = highestRule.validateParams?.(action.params) ?? [];
        if (invalidKeys.length > 0 || customIssues.length > 0) violations.push(highestRule);
      }
      const estimatedRows = action.params.estimatedAffectedRows ?? action.params.affectedRows;
      if (estimatedRows !== undefined && (typeof estimatedRows !== "number" || !Number.isInteger(estimatedRows) || estimatedRows < 0 || estimatedRows > highestRule.maxAffectedRows)) {
        violations.push(highestRule);
      }

      if (violations.length > 0) {
        return {
          allowed: false,
          policyId: highestRule.ruleId,
          violatedRules: violations.map((r) => ({
            ruleId: r.ruleId,
            description: r.description,
            remedy: `Reduce risk level or add required approvals`
          })),
          appealable: true
        };
      }

      return {
        allowed: true,
        policyId: highestRule.ruleId,
        matchedRules: [highestRule.ruleId]
      };
    }

    return {
      allowed: true,
      policyId: highestRule.ruleId,
      matchedRules: [highestRule.ruleId]
    };
  }

  // ─── Step 3: Permission Approval ────────────────────────────

  async createApprovalWorkflow(action: WriteAction): Promise<ApprovalWorkflow> {
    await this.ensureLoaded();
    const existing = this.pendingApprovals.get(`wf_${action.actionId}`);
    if (existing) return existing;
    const workflowId = `wf_${action.actionId}`;
    const matching = this.rules
      .filter((rule) => rule.capabilityPattern.test(action.capability) && compareRiskLevel(action.riskLevel, rule.minRiskLevel) >= 0)
      .sort((a, b) => compareRiskLevel(b.minRiskLevel, a.minRiskLevel))[0];
    const requiredApprovals = matching?.requiredApprovals ?? this.getRequiredApprovals(action.riskLevel);

    const nodes = requiredApprovals > 0
      ? [
          {
            nodeId: `${workflowId}_human_1`,
            nodeType: "human_single" as const,
            requiredRoles: ["test_engineer"],
            timeoutMs: this.config.approvalTimeoutMs ?? 300_000,
            escalationPolicy: "hold" as const
          },
          ...(requiredApprovals > 1
            ? [{
                nodeId: `${workflowId}_human_2`,
                nodeType: "human_single" as const,
                requiredRoles: ["admin"],
                timeoutMs: this.config.approvalTimeoutMs ?? 300_000,
                escalationPolicy: "hold" as const
              }]
            : [])
        ]
      : [{
          nodeId: `${workflowId}_auto`,
          nodeType: "auto" as const,
          requiredRoles: [],
          timeoutMs: 1_000,
          escalationPolicy: "auto_approve" as const
        }];

    const now = new Date().toISOString();
    const workflow: ApprovalWorkflow = {
      workflowId,
      actionId: action.actionId,
      riskLevel: action.riskLevel,
      nodes,
      currentNodeIndex: 0,
      status: requiredApprovals > 0 ? "pending" : "approved",
      decisions: requiredApprovals === 0
        ? [{
            nodeId: nodes[0].nodeId,
            decidedBy: "system",
            decision: "approved",
            reason: "Auto-approved: low risk",
            decidedAt: now
          }]
        : [],
      createdAt: now,
      expiresAt: new Date(Date.now() + 3600_000).toISOString()
    };

    this.pendingApprovals.set(workflowId, workflow);
    await this.store.saveWorkflow(workflow);
    return workflow;
  }

  // ─── Step 4: Execution ──────────────────────────────────────

  async executeApproved(
    action: WriteAction,
    executor: (action: WriteAction) => Promise<WriteExecutionResult>
  ): Promise<WriteExecutionResult> {
    await this.ensureLoaded();
    const existing = await this.store.findLogByIdempotencyKey(action.idempotencyKey);
    if (existing?.executionResult) return existing.executionResult;
    const workflow = this.pendingApprovals.get(`wf_${action.actionId}`);
    if (!workflow || workflow.status !== "approved") {
      return {
        executionId: `exec_${action.actionId}`,
        actionId: action.actionId,
        status: "rejected",
        affectedTables: [], affectedRows: 0, durationMs: 0,
        error: { code: "approval_required", message: "A write action must have an approved workflow.", rollbackPerformed: false },
        executedAt: new Date().toISOString(), executorId: "write-safety"
      };
    }
    if (new Date(workflow.expiresAt).getTime() <= Date.now()) {
      workflow.status = "expired";
      this.pendingApprovals.set(workflow.workflowId, workflow);
      await this.store.saveWorkflow(workflow);
      return {
        executionId: `exec_${action.actionId}`,
        actionId: action.actionId,
        status: "rejected",
        affectedTables: [], affectedRows: 0, durationMs: 0,
        error: { code: "approval_expired", message: "The approval workflow has expired.", rollbackPerformed: false },
        executedAt: new Date().toISOString(), executorId: "write-safety"
      };
    }
    const log: WriteOperationLog = {
      logId: `log_${action.actionId}`,
      actionId: action.actionId,
      runId: action.runId,
      traceId: action.idempotencyKey, // 用 idempotencyKey 作为简化的 traceId
      actor: action.proposedBy,
      capability: action.capability,
      paramsDigest: createHash("sha256")
        .update(JSON.stringify(action.params))
        .digest("hex")
        .slice(0, 16),
      riskLevel: action.riskLevel,
      policyCheck: {
        allowed: true,
        policyId: "approved",
        matchedRules: []
      },
      finalStatus: "approved",
      createdAt: action.proposedAt,
      updatedAt: new Date().toISOString()
    };

    try {
      let result = await executor(action);
      log.executionResult = result;
      const rule = this.rules
        .filter((candidate) => candidate.capabilityPattern.test(action.capability) && compareRiskLevel(action.riskLevel, candidate.minRiskLevel) >= 0)
        .sort((a, b) => compareRiskLevel(b.minRiskLevel, a.minRiskLevel))[0];
      if (rule && result.affectedRows > rule.maxAffectedRows) {
        result = {
          ...result,
          status: "failed",
          error: { code: "affected_rows_limit_exceeded", message: `Affected rows ${result.affectedRows} exceed policy limit ${rule.maxAffectedRows}.`, rollbackPerformed: false }
        };
        log.executionResult = result;
      }
      log.finalStatus = result.status === "executed" ? "executed" : "failed";
      log.updatedAt = result.executedAt;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.executionResult = {
        executionId: `exec_${action.actionId}`,
        actionId: action.actionId,
        status: "failed",
        affectedTables: [],
        affectedRows: 0,
        durationMs: 0,
        error: { code: "execution_error", message, rollbackPerformed: false },
        executedAt: new Date().toISOString(),
        executorId: "system"
      };
      log.finalStatus = "failed";
      log.updatedAt = new Date().toISOString();
    }

    this.operationLogs.push(log);
    await this.store.appendLog(log);
    return log.executionResult!;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private getRequiredApprovals(riskLevel: RiskLevel): number {
    switch (riskLevel) {
      case "critical": return 2;
      case "high": return 1;
      case "medium": return 0;
      case "low": return 0;
    }
  }

  getOperationLogs(runId?: string): WriteOperationLog[] {
    if (!runId) return [...this.operationLogs];
    return this.operationLogs.filter((log) => log.runId === runId);
  }

  getPendingApprovals(): ApprovalWorkflow[] {
    return Array.from(this.pendingApprovals.values()).filter(
      (w) => w.status === "pending"
    );
  }

  getWorkflow(workflowId: string): ApprovalWorkflow | undefined {
    return this.pendingApprovals.get(workflowId);
  }

  async approveWorkflow(workflowId: string, decidedBy: string, reason?: string): Promise<ApprovalWorkflow> {
    await this.ensureLoaded();
    const workflow = this.pendingApprovals.get(workflowId);
    if (!workflow) throw new Error("approval_workflow_not_found");
    if (workflow.status !== "pending") return workflow;
    if (new Date(workflow.expiresAt).getTime() <= Date.now()) {
      workflow.status = "expired";
      await this.store.saveWorkflow(workflow);
      return workflow;
    }
    const node = workflow.nodes[workflow.currentNodeIndex];
    workflow.decisions.push({ nodeId: node.nodeId, decidedBy, decision: "approved", reason, decidedAt: new Date().toISOString() });
    workflow.currentNodeIndex += 1;
    if (workflow.currentNodeIndex >= workflow.nodes.length) workflow.status = "approved";
    this.pendingApprovals.set(workflowId, workflow);
    await this.store.saveWorkflow(workflow);
    return workflow;
  }
}

// ─── Utility ──────────────────────────────────────────────────

function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  const order: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3
  };
  return order[a] - order[b];
}

let instance: WriteSafetyLayer | null = null;

export function getWriteSafetyLayer(config?: WriteSafetyConfig): WriteSafetyLayer {
  if (config) {
    instance = new WriteSafetyLayer(config);
  }
  if (!instance) {
    const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
    instance = new WriteSafetyLayer({ store: new FileWriteSafetyStore(path.join(rootDir, "reports", "write-safety", "state.json")) });
  }
  return instance;
}
