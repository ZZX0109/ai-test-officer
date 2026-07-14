import type { EvidenceItem, FailureAttribution, RepairProposal, RunStepEvidence, VisualRunResult } from "./types.js";

function refs(evidence: EvidenceItem[]) {
  return evidence.filter((item) => ["assertion", "screenshot", "dom", "network", "console"].includes(item.type)).map((item) => item.id).slice(-12);
}

export function buildRepairProposals(input: { assertions: VisualRunResult["assertions"]; steps: RunStepEvidence[]; evidence: EvidenceItem[]; failureAttributions: FailureAttribution[] }): RepairProposal[] {
  const failed = input.assertions.filter((item) => !item.passed);
  if (!failed.length) return [];
  const originalFailure = failed.map((item) => `${item.name}: ${item.actual}`).join("; ");
  const classes = new Set(failed.map((item) => item.fact?.failureClass).filter(Boolean));
  const proposals: RepairProposal[] = [];
  const add = (proposal: Omit<RepairProposal, "id" | "beforeEvidenceRefs" | "afterEvidenceRefs">) => proposals.push({ id: `repair_${proposal.kind}_${proposals.length + 1}`, beforeEvidenceRefs: refs(input.evidence), afterEvidenceRefs: [], ...proposal });
  if (classes.has("test_script_issue")) add({ kind: "selector_recovery", status: "proposed", originalFailure, proposedChange: "重新探测 role/text/test-id locator，只有新 locator 与当前 DOM 同时匹配时才允许重放。", safeguards: ["不修改目标项目源码", "不把 selector 修复当作产品通过", "保留原始失败 evidence"], outcome: "pending" });
  if (/timeout|waiting|not visible/i.test(originalFailure) || input.steps.some((step) => /timeout|waiting/i.test(step.details))) add({ kind: "wait_strategy_adjustment", status: "proposed", originalFailure, proposedChange: "在受限预算内等待 network idle 或目标 locator 可见，再重放同一步。", safeguards: ["最多一次额外等待", "不扩大测试范围", "超时仍归类为环境或脚本问题"], outcome: "pending" });
  const missing = ["screenshot", "dom", "network", "console"].filter((type) => !input.evidence.some((item) => item.type === type));
  if (missing.length) add({ kind: "evidence_completion", status: "proposed", originalFailure, proposedChange: `补采集 ${missing.join(", ")} evidence，不重新解释原始断言。`, safeguards: ["只补证据，不覆盖原始 evidence", "缺失证据时 Judge 保留 needs_review"], outcome: "pending" });
  if (classes.has("environment_issue")) add({ kind: "environment_diagnosis", status: "proposed", originalFailure, proposedChange: "检查健康检查、端口、凭据和失败请求；只输出阻塞原因与修复建议。", safeguards: ["环境恢复不能把产品 verdict 变为 pass", "不修改目标项目源码", "必须引用 runtime/network evidence"], outcome: "blocked" });
  add({ kind: "bounded_retry", status: "proposed", originalFailure, proposedChange: "刷新页面后最多重放一次相同动作，并同时保留首轮和重放结果。", safeguards: ["retry budget=1", "首轮失败不会被删除", "重试成功不能静默覆盖原 verdict"], outcome: "pending" });
  return proposals;
}
