/**
 * 写操作安全层合约
 *
 * LLM Action Proposal → Policy Check → Permission Approval → Execution → Database Update
 */

import { z } from "zod";

// ─── 风险等级 ────────────────────────────────────────────────────

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

// ─── Action Schema ───────────────────────────────────────────────

export const writeActionSchema = z.object({
  actionId: z.string().min(1),
  proposedBy: z.enum(["llm_planner", "llm_judge", "llm_repair", "user", "system"]),
  capability: z.string().min(1),
  params: z.record(z.unknown()),
  reason: z.string().min(1).max(2_000),
  sourceClaimIds: z.array(z.string().min(1)).max(20),
  riskLevel: riskLevelSchema,
  requiresConfirmation: z.boolean(),
  idempotencyKey: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().optional(),
  proposedAt: z.string().datetime()
});
export type WriteAction = z.infer<typeof writeActionSchema>;

// ─── Policy Check ────────────────────────────────────────────────

export const policyCheckResultSchema = z.discriminatedUnion("allowed", [
  z.object({
    allowed: z.literal(true),
    policyId: z.string(),
    matchedRules: z.array(z.string()),
    conditions: z.array(z.object({
      field: z.string(),
      constraint: z.string(),
      satisfied: z.boolean()
    })).optional()
  }),
  z.object({
    allowed: z.literal(false),
    policyId: z.string(),
    violatedRules: z.array(z.object({
      ruleId: z.string(),
      description: z.string(),
      remedy: z.string().optional()
    })),
    appealable: z.boolean().default(false)
  })
]);
export type PolicyCheckResult = z.infer<typeof policyCheckResultSchema>;

// ─── 权限审批 ────────────────────────────────────────────────────

export const approvalNodeSchema = z.object({
  nodeId: z.string().min(1),
  nodeType: z.enum(["auto", "human_single", "human_dual", "admin"]),
  requiredRoles: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(300_000),
  escalationPolicy: z.enum(["auto_reject", "auto_approve", "hold"]).default("hold")
});
export type ApprovalNode = z.infer<typeof approvalNodeSchema>;

export const approvalWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  actionId: z.string().min(1),
  riskLevel: riskLevelSchema,
  nodes: z.array(approvalNodeSchema).min(1),
  currentNodeIndex: z.number().int().nonnegative().default(0),
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
  decisions: z.array(z.object({
    nodeId: z.string(),
    decidedBy: z.string(),
    decision: z.enum(["approved", "rejected", "delegated"]),
    reason: z.string().max(1_000).optional(),
    decidedAt: z.string().datetime()
  })).default([]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});
export type ApprovalWorkflow = z.infer<typeof approvalWorkflowSchema>;

// ─── 执行结果 ────────────────────────────────────────────────────

export const writeExecutionResultSchema = z.object({
  executionId: z.string().min(1),
  actionId: z.string().min(1),
  status: z.enum(["executed", "rejected", "failed", "rolled_back"]),
  beforeState: z.record(z.unknown()).optional(),
  afterState: z.record(z.unknown()).optional(),
  affectedTables: z.array(z.string()),
  affectedRows: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    rollbackPerformed: z.boolean().default(false)
  }).optional(),
  executedAt: z.string().datetime(),
  executorId: z.string()
});
export type WriteExecutionResult = z.infer<typeof writeExecutionResultSchema>;

// ─── 操作审计日志 ────────────────────────────────────────────────

export const writeOperationLogSchema = z.object({
  logId: z.string().min(1),
  actionId: z.string().min(1),
  runId: z.string().min(1),
  traceId: z.string().optional(),
  actor: z.string().min(1),
  capability: z.string().min(1),
  paramsDigest: z.string().min(1),
  riskLevel: riskLevelSchema,
  policyCheck: policyCheckResultSchema,
  approvalWorkflow: approvalWorkflowSchema.optional(),
  executionResult: writeExecutionResultSchema.optional(),
  finalStatus: z.enum(["proposed", "policy_denied", "approval_pending", "approved", "executed", "failed", "rolled_back"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type WriteOperationLog = z.infer<typeof writeOperationLogSchema>;
