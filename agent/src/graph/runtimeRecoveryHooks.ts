import { randomUUID } from "node:crypto";
import {
  recoveryActionResultSchema,
  type AgentGraphNode,
  type AgentInterrupt,
  type RecoveryDecision
} from "@ai-test-officer/contracts";
import type { AgentGraphState } from "@ai-test-officer/agent-orchestration";
import { appendSystemRunEvent, runEventStore } from "../runEventStore.js";
import { getProjectRuntimeStatusWithRecovery, startProject } from "../projectAdapter.js";
import { runSmokeFirstDiscovery } from "../smokeFirstDiscovery.js";
import { readCoverageItems, isCoverageTerminal } from "../coverageStore.js";
import { persistRepairPlan } from "../repairPlan.js";
import { persistAgentObservation, persistRecoveryAction, persistRecoveryDecision } from "../recoveryStore.js";
import { chooseLlmRecoveryDecision } from "../llmRecoveryDecision.js";
import {
  buildDiscoveryEvidence,
  credentialInterruptMeta,
  deterministicRecoveryDecision,
  discoveryState,
  recoveryEvidenceRefs
} from "./runtimeRecovery.js";

type NodeOperation = (state: AgentGraphState) => Promise<Record<string, unknown>>;
type WrapNode = (name: AgentGraphNode, operation: NodeOperation) => (state: AgentGraphState) => Promise<Record<string, unknown>>;

export function createRuntimeRecoveryHooks(input: { node: WrapNode }) {
  const { node } = input;
  return {
    intake: node("intake", async (state) => {
      const run = await runEventStore.get(state.runId);
      return { requirement: typeof run?.input.requirement === "string" ? run.input.requirement : state.requirement };
    }),
    diagnoseRuntime: node("diagnose-runtime", async (state) => {
      const run = await runEventStore.get(state.runId);
      const projectId = state.projectId;
      const runtime = projectId ? await getProjectRuntimeStatusWithRecovery(projectId) : undefined;
      const discovery = state.coverageMap?.discovery;
      const summary = discovery && typeof discovery === "object"
        ? String((discovery as Record<string, unknown>).reason ?? "Discovery 未完成")
        : runtime?.message ?? "缺少运行时观测。";
      const observation = {
        schemaVersion: "1.0" as const,
        id: `observation_${randomUUID()}`,
        runId: state.runId,
        stage: "recovery" as const,
        status: runtime?.status === "running" ? "degraded" as const : "failed" as const,
        ...(typeof run?.input.appUrl === "string" ? { requestedUrl: run.input.appUrl } : {}),
        summary,
        evidenceRefs: recoveryEvidenceRefs(state),
        retryable: true,
        userActionRequired: /login|sign in|登录|credential|凭据|401|403/i.test(summary),
        createdAt: new Date().toISOString()
      };
      await persistAgentObservation(observation);
      return { observation: { ...observation, runtime, discovery }, recoveryResult: undefined };
    }),
    chooseRecovery: node("choose-recovery", async (state) => {
      const baseline = deterministicRecoveryDecision(state);
      const run = await runEventStore.get(state.runId);
      const decision = await chooseLlmRecoveryDecision({
        baseline,
        credentialId: typeof run?.input.modelProfileId === "string" ? run.input.modelProfileId : undefined,
        projectId: state.projectId,
        failureClass: typeof state.failure?.failureClass === "string" ? state.failure.failureClass : undefined,
        observation: state.observation
      });
      await persistRecoveryDecision(decision);
      return { recoveryDecision: decision, recoveryAttempts: { ...(state.recoveryAttempts ?? {}) } };
    }),
    recover: async (state: AgentGraphState) => {
      const decision = state.recoveryDecision ?? deterministicRecoveryDecision(state);
      const answer = (state as AgentGraphState & { interruptAnswer?: Record<string, unknown> }).interruptAnswer;
      if (decision.action === "request-credentials" && !answer) {
        const meta = await credentialInterruptMeta(state.projectId);
        const pending: AgentInterrupt = {
          id: `interrupt_${randomUUID()}`,
          runId: state.runId,
          kind: "credential",
          status: "pending",
          title: "需要测试账号",
          detail: meta.hasSavedCredential
            ? `已保存测试账号${meta.usernameMasked ? `（${meta.usernameMasked}）` : ""}。授权后系统仅在当前沙盒会话中注入登录，不会显示或写入报告。`
            : (decision.userQuestion ?? "当前页面需要登录凭据后才能继续 Discovery。请填写测试账号和密码，或暂不登录。"),
          requestedCapabilities: ["credential"],
          payload: { action: "provide-credentials" },
          owner: "user",
          context: {
            recoveryDecision: decision,
            hasSavedCredential: meta.hasSavedCredential,
            ...(meta.usernameMasked ? { usernameMasked: meta.usernameMasked } : {})
          },
          options: meta.hasSavedCredential
            ? [{ value: "approved", label: "使用已保存账号继续" }, { value: "dismiss", label: "暂不登录" }]
            : [{ value: "approved", label: "保存账号并继续" }, { value: "dismiss", label: "暂不登录" }],
          evidenceRefs: decision.evidenceRefs,
          createdAt: new Date().toISOString()
        };
        return { recoveryDecision: decision, recoveryInterrupt: pending };
      }
      if (decision.action === "request-credentials" && answer?.approved !== true) {
        return {
          recoveryDecision: decision,
          recoveryResult: recoveryActionResultSchema.parse({
            schemaVersion: "1.0", actionId: `action_${randomUUID()}`, runId: state.runId,
            action: decision.action, status: "blocked", evidenceRefs: decision.evidenceRefs,
            nextState: "blocked", userMessage: "用户未确认测试账号配置。", startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
          })
        };
      }
      const decisionForExecution: RecoveryDecision = decision.action === "request-credentials"
        ? { ...decision, id: `recovery_${randomUUID()}`, action: "retry-discovery", reason: "测试账号已确认，重新执行页面 Discovery。", expectedState: "重新进入可执行测试阶段", userQuestion: undefined }
        : decision;
      if (decisionForExecution.id !== decision.id) await persistRecoveryDecision(decisionForExecution);
      const attempts = { ...(state.recoveryAttempts ?? {}), [decisionForExecution.action]: (state.recoveryAttempts?.[decisionForExecution.action] ?? 0) + 1 };
      const startedAt = new Date().toISOString();
      let status: "completed" | "failed" | "blocked" = "completed";
      let message = "恢复动作已完成。";
      let discoveryUpdate: Record<string, unknown> | undefined;
      if (decisionForExecution.action === "retry-runtime" && state.projectId) {
        const runtime = await startProject(state.projectId, { runId: state.runId, attemptId: typeof state.execution?.attemptId === "string" ? state.execution.attemptId : undefined });
        status = runtime.status === "running" ? "completed" : "failed";
        message = runtime.message;
      } else if (decisionForExecution.action === "retry-discovery" && state.projectId) {
        const scan = await runSmokeFirstDiscovery({ projectId: state.projectId, goal: state.requirement ?? "重新扫描页面", smokeAttempts: 2, discoveryAttempts: 2 });
        const discovered = discoveryState(scan);
        discoveryUpdate = { ...discovered, evidence: buildDiscoveryEvidence(scan, state.runId) };
        status = discovered.status === "ready" ? "completed" : "failed";
        message = scan.message;
      } else if (decisionForExecution.action === "retry-path") {
        status = "completed";
        message = "已创建新的路径 Attempt，准备重新执行。";
      } else if (decisionForExecution.action === "repair-harness" || decisionForExecution.action === "repair-product") {
        status = "blocked";
        message = "该恢复动作需要进入修复工作区并由用户确认。";
      } else if (decisionForExecution.action === "blocked") {
        status = "blocked";
        message = decision.userQuestion ?? "没有可执行的恢复动作。";
      }
      const result = recoveryActionResultSchema.parse({
        schemaVersion: "1.0", actionId: `action_${randomUUID()}`, runId: state.runId,
        action: decisionForExecution.action, status, evidenceRefs: decisionForExecution.evidenceRefs,
        nextState: status === "completed" ? "verify-recovery" : "blocked",
        ...(status !== "completed" ? { errorCode: "recovery_failed", userMessage: message } : {}),
        startedAt, completedAt: new Date().toISOString()
      });
      await persistRecoveryAction(result, decision.id);
      return {
        recoveryDecision: decisionForExecution,
        recoveryAttempts: attempts,
        recoveryResult: result,
        ...(discoveryUpdate ? { coverageMap: { ...(state.coverageMap ?? {}), discovery: discoveryUpdate }, discoveryTerminal: false } : {})
      };
    },
    verifyRecovery: node("verify-recovery", async (state) => {
      const result = state.recoveryResult;
      if (!result) return { recoveryResult: undefined };
      return {
        observation: {
          ...(state.observation ?? {}),
          stage: "recovery",
          status: result.status === "completed" ? "ready" : "failed",
          summary: result.userMessage ?? result.nextState,
          evidenceRefs: result.evidenceRefs
        }
      };
    }),
    retryPath: node("retry-path", async (state) => {
      const run = await runEventStore.get(state.runId);
      if (!run || run.state !== "judging") {
        return {
          recoveryResult: recoveryActionResultSchema.parse({
            schemaVersion: "1.0", actionId: `action_${randomUUID()}`, runId: state.runId,
            action: "retry-path", status: "blocked", evidenceRefs: state.recoveryDecision?.evidenceRefs ?? [],
            nextState: "blocked", errorCode: "retry_path_not_available",
            userMessage: "当前运行没有处于可重试的判定阶段；原始证据保持不变。",
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
          })
        };
      }
      const retried = await appendSystemRunEvent(state.runId, "run_retrying", {
        recoveryActionId: state.recoveryResult?.actionId,
        previousAttemptId: state.currentAttemptId,
        reason: state.recoveryDecision?.reason ?? "retry_failed_path"
      });
      const { enqueueRun } = await import("../runOrchestrator.js");
      const schedule = setTimeout(() => void enqueueRun(retried.id, retried.version).catch(() => undefined), 0);
      schedule.unref?.();
      return {
        currentAttemptId: `attempt_${randomUUID()}`,
        recoveryResult: state.recoveryResult,
        observation: {
          ...(state.observation ?? {}), stage: "recovery", status: "ready",
          summary: "已创建新的执行 Attempt 并重新投递 Worker；原失败 Attempt 保持可追溯。"
        }
      };
    }),
    continuePaths: node("continue-paths", async (state) => {
      const coverage = await readCoverageItems(state.runId).catch(() => []);
      const pending = coverage.filter((item) => !isCoverageTerminal(item)).length;
      const continuationPasses = state.continuationPasses ?? 0;
      return {
        remainingPathCount: pending,
        continuationPasses: pending > 0 ? continuationPasses + 1 : continuationPasses,
        observation: {
          ...(state.observation ?? {}), stage: "recovery", status: "ready",
          summary: pending
            ? `父 Run 将继续投递 ${pending} 条独立待执行路径（第 ${continuationPasses + 1} 次恢复继续）。`
            : "没有独立待执行路径；已保留失败路径与其证据。"
        }
      };
    })
  };
}
