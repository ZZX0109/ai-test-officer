import { randomUUID } from "node:crypto";
import type { AgentGraphState } from "@ai-test-officer/agent-orchestration";
import type { AgentInterrupt, RepairDecisionAnswer } from "@ai-test-officer/contracts";
import { appendEvidence, readEvidence } from "../evidenceStore.js";
import { getProject } from "../projectAdapter.js";
import { createRepairSession, validateRepairSession } from "../repairWorkspace.js";
import { proposeCodeRepair } from "../llmCodeRepair.js";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "../runEventStore.js";
import { persistRepairPlan } from "../repairPlan.js";
import type { EvidenceItem, RepairDecision, RepairOwner } from "../types.js";

function buildRepairOptions(owner: RepairOwner) {
  switch (owner) {
    case "user":
      return [
        { value: "provide-credentials", label: "配置登录凭据", description: "在凭据管理中配置测试账号后重新执行 Discovery。" },
        { value: "repair", label: "由系统修复", description: "授权系统在沙盒中复现并生成修复方案。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    case "environment":
      return [
        { value: "recover-sandbox", label: "恢复测试环境", description: "确认 Docker / APP_URL / 端口映射后恢复沙盒。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    case "developer":
      return [
        { value: "create-session", label: "创建修复工作区", description: "进入修复工作区对源码进行修改。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    default:
      return [
        { value: "repair", label: "授权 AI 生成沙盒补丁", description: "AI 会根据当前证据在隔离副本中生成补丁，并在修改后执行验证；不会写入原项目。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
  }
}

export async function collectFailureEvidenceRefs(runId: string, resultRunId?: string): Promise<string[]> {
  const seen = new Set<string>();
  const preferred: string[] = [];
  const fallback: string[] = [];
  const sources = resultRunId && resultRunId !== runId ? [resultRunId, runId] : [runId];
  for (const source of sources) {
    let items: EvidenceItem[];
    try {
      items = await readEvidence(source);
    } catch {
      continue;
    }
    for (const item of [...items].reverse()) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const bucket = /screenshot|console|network|assertion|dom|error/i.test(String(item.type))
        ? preferred
        : fallback;
      bucket.push(item.id);
    }
  }
  return [...preferred, ...fallback].slice(0, 8);
}

function ownerLabel(owner: RepairOwner): string {
  if (owner === "user") return "用户";
  if (owner === "environment") return "环境";
  if (owner === "developer") return "开发者";
  return "系统";
}

function buildRepairInterrupt(
  state: AgentGraphState,
  repairDecision: RepairDecision,
  failureClass: string | undefined,
  run: RunProjection | undefined,
  reason?: "sandbox-write-required"
): AgentInterrupt {
  const reasons = (state.failure?.reasons as string[] | undefined) ?? [];
  const options = buildRepairOptions(repairDecision.owner);
  const sandboxBlocked = reason === "sandbox-write-required";
  const evidenceRefs = Array.isArray(state.failure?.evidenceRefs)
    ? (state.failure.evidenceRefs as string[]).filter((id) => typeof id === "string" && id.length > 0)
    : [];
  return {
    id: `interrupt_${randomUUID()}`,
    runId: state.runId,
    kind: "repair-decision",
    status: "pending",
    title: `需要${ownerLabel(repairDecision.owner)}决策：${failureClass ?? "测试失败"}`,
    detail: sandboxBlocked
      ? `${repairDecision.userMessage}\n\n需要沙盒写入权限才能自动修复，请在权限配置中放行后重试。`
      : repairDecision.userMessage,
    requestedCapabilities: [],
    owner: repairDecision.owner,
    context: {
      failureClass,
      problem: repairDecision.userMessage,
      diagnosis: reasons,
      suggestedApproach: repairDecision.steps.join("\n"),
      validation: repairDecision.validation,
      sandboxBlocked
    },
    options,
    diagnoses: reasons,
    evidenceRefs,
    attemptId: typeof state.failure?.attemptId === "string" ? (state.failure.attemptId as string) : undefined,
    scenarioId: run?.selectedScenarioId,
    payload: {
      problem: repairDecision.userMessage,
      diagnosis: reasons,
      suggestedApproach: repairDecision.steps.join("\n"),
      options: options.map((option) => option.value),
      owner: repairDecision.owner,
      runId: state.runId,
      failureClass,
      evidenceRefs,
      sandboxBlocked
    },
    createdAt: new Date().toISOString()
  };
}

async function performAgentAutoRepair(
  state: AgentGraphState,
  failureClass: string | undefined,
  run: RunProjection | undefined
): Promise<Record<string, unknown>> {
  if (!state.projectId) return {};
  const project = await getProject(state.projectId);
  if (!project) return {};
  const repair = await createRepairSession({
    runId: state.runId,
    project,
    summary: `Graph triage: ${String(failureClass ?? "unknown")}`,
    failureClass: failureClass === "product-bug" ? "product-bug"
      : failureClass === "test-script" ? "test-script"
        : failureClass === "environment" ? "environment"
          : "unknown"
  });
  try {
    const freshRun = run ?? await runEventStore.get(state.runId);
    if (!freshRun) return { repairSessionId: repair.id };
    const proposed = await proposeCodeRepair({
      sessionId: repair.id,
      run: freshRun,
      project,
      credentialId: typeof freshRun.input.modelProfileId === "string" ? freshRun.input.modelProfileId : undefined
    });
    if (proposed.files.length > 0) await validateRepairSession(repair.id, project);
  } catch {
    // The original machine result remains authoritative when proposal or
    // sandbox validation fails; the session stays available for inspection.
  }
  return { repairSessionId: repair.id };
}

async function applyRepairDecision(
  state: AgentGraphState,
  repairDecision: RepairDecision,
  failureClass: string | undefined,
  answer: RepairDecisionAnswer,
  run: RunProjection | undefined
): Promise<Record<string, unknown>> {
  if (answer.decision === "repair" || answer.decision === "create-session") {
    return performAgentAutoRepair(state, failureClass, run);
  }
  await appendSystemRunEvent(state.runId, "repair_decision_recorded", {
    decision: answer.decision,
    message: answer.message,
    repairPlanId: answer.repairPlanId
  }).catch(() => undefined);
  return {};
}

export async function repairOperation(
  state: AgentGraphState,
  resume?: RepairDecisionAnswer
): Promise<Record<string, unknown>> {
  const repairDecision = state.failure?.repairDecision as RepairDecision | undefined;
  const failureClass = state.failure?.failureClass as string | undefined;
  if (!repairDecision) return {};
  const run = await runEventStore.get(state.runId);
  if (failureClass) {
    await persistRepairPlan({
      runId: state.runId,
      projectId: typeof state.projectId === "string" ? state.projectId : undefined,
      attributionId: `triage_${failureClass}`,
      failureType: failureClass,
      problem: ((state.failure?.reasons as string[] | undefined) ?? []).join("; ") || `run ${state.runId} failed`,
      decision: repairDecision,
      scenarioId: run?.selectedScenarioId,
      policyVersion: "repair-policy-v1",
      idempotencyKey: `triage:${state.runId}:${failureClass}`
    }).catch(() => undefined);
  }
  if (resume) return applyRepairDecision(state, repairDecision, failureClass, resume, run);
  if (!state.projectId || !state.permissionProfile.sandboxWrite) {
    return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run, "sandbox-write-required") };
  }
  return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run) };
}
