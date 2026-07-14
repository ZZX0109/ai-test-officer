import type {
  EvidenceItem,
  FailureClass,
  GrayPlan,
  JudgeFinding,
  JudgeResult,
  LayeredJudgeReport,
  VisualRunResult
} from "./types.js";
import { fixedGrayPlan } from "./plan.js";
import { detectUntrustedInstructions } from "./untrustedInput.js";

interface JudgeInput {
  plan?: GrayPlan;
  requirement?: string;
  diff?: string;
  result: Pick<
    VisualRunResult,
    "steps" | "assertions" | "network" | "console" | "riskCoverageMatrix" | "aggregatedVerdict" | "conflictPacket" | "verdict"
  >;
  evidence: EvidenceItem[];
}

function evidenceByTitle(evidence: EvidenceItem[], text: string) {
  return evidence.filter((item) => item.title.includes(text)).map((item) => item.id);
}

function evidenceByType(evidence: EvidenceItem[], type: EvidenceItem["type"]) {
  return evidence.filter((item) => item.type === type).map((item) => item.id);
}

function unique(values: string[]) {
  return Array.from(new Set(values)).filter(Boolean);
}

function fallbackEvidenceRefs(evidence: EvidenceItem[]) {
  return evidence
    .filter((item) => ["assertion", "screenshot", "dom", "network", "trace", "video", "operation"].includes(item.type))
    .map((item) => item.id)
    .slice(-8);
}

function findingTitle(failureClass: FailureClass, assertionName: string) {
  if (failureClass === "product_bug") return `疑似产品 bug：${assertionName}`;
  if (failureClass === "test_script_issue") return `疑似测试脚本问题：${assertionName}`;
  if (failureClass === "environment_issue") return `疑似环境问题：${assertionName}`;
  if (failureClass === "insufficient_evidence") return `证据不足：${assertionName}`;
  return `失败原因需复核：${assertionName}`;
}

function severityFor(failureClass: FailureClass, fallback: "high" | "medium" | "low" = "medium") {
  if (failureClass === "product_bug") return "high";
  if (failureClass === "insufficient_evidence") return "medium";
  return fallback;
}

function buildPlanJudge(input: JudgeInput): JudgeResult {
  const plan = input.plan ?? fixedGrayPlan;
  const executedStepIds = new Set(input.result.steps.map((step) => step.stepId));
  const coveredPathIds = new Set(input.result.riskCoverageMatrix.flatMap((item) => item.pathIds));
  const findings: JudgeFinding[] = [];

  for (const level of plan.levels) {
    for (const pathItem of level.paths) {
      const ran = executedStepIds.has(pathItem.id) || coveredPathIds.has(pathItem.id);
      if (!ran) {
        findings.push({
          id: `plan_gap_${pathItem.id}`,
          severity: level.id === "core_path" ? "high" : "medium",
          failureClass: "insufficient_evidence",
          title: `计划路径未执行：${pathItem.title}`,
          reasoning: "Plan Judge 不允许把未执行路径计入已覆盖，该路径仍需要补 harness 或人工验收。",
          evidenceRefs: unique([...evidenceByType(input.evidence, "permission"), ...evidenceByType(input.evidence, "operation")])
        });
      }
    }
  }

  const hasDiffSignal = Boolean(input.diff?.trim());
  const hasRequirementSignal = Boolean(input.requirement?.trim());
  if (!hasDiffSignal || !hasRequirementSignal) {
    findings.push({
      id: "plan_context_missing",
      severity: "medium",
      failureClass: "insufficient_evidence",
      title: "计划上下文不完整",
      reasoning: "缺少 diff 或需求文本时，Plan Judge 只能基于 fixture plan 判断覆盖，不能声称完整覆盖真实变更。",
      evidenceRefs: evidenceByType(input.evidence, "permission")
    });
  }

  return {
    layer: "plan",
    title: "Plan Judge",
    verdict: findings.some((item) => item.severity === "high") ? "fail" : findings.length ? "needs_review" : "pass",
    summary: findings.length
      ? `发现 ${findings.length} 个计划覆盖缺口，未执行路径不能计入覆盖。`
      : "测试计划与已执行路径一致，没有把未运行场景算作已覆盖。",
    findings
  };
}

function buildEvidenceJudge(input: JudgeInput): JudgeResult {
  const failedAssertions = input.result.assertions.filter((item) => !item.passed);
  const findings: JudgeFinding[] = [];
  const networkRefs = evidenceByType(input.evidence, "network");
  const domRefs = evidenceByType(input.evidence, "dom");
  const screenshotRefs = evidenceByType(input.evidence, "screenshot");
  const untrustedSignals = detectUntrustedInstructions({ requirement: input.requirement, diff: input.diff, evidence: input.evidence });

  for (const assertion of failedAssertions) {
    const assertionRefs = evidenceByTitle(input.evidence, assertion.name);
    const factRefs = assertion.fact?.evidenceRefs ?? [];
    const failureClass: FailureClass = assertion.fact?.failureClass ?? "insufficient_evidence";

    findings.push({
      id: `evidence_${assertion.name.replace(/\s+/g, "_")}`,
      severity: severityFor(failureClass, assertion.fact?.severity ?? "medium"),
      failureClass,
      title: findingTitle(failureClass, assertion.name),
      reasoning: assertion.fact
        ? `结构化断言 ${assertion.fact.kind} 在 ${assertion.fact.target} 上未满足：期望 ${assertion.fact.operator} ${assertion.fact.expected}，实际 ${assertion.fact.actual}。`
        : "断言失败但缺少结构化 AssertionFact，Judge 只能标记为 insufficient_evidence，不能通过文本猜测产品 bug。",
      evidenceRefs: unique([...factRefs, ...assertionRefs, ...networkRefs.slice(-4), ...domRefs.slice(-3), ...screenshotRefs.slice(-2)])
    });
  }

  if (input.result.console.some((item) => item.type === "error")) {
    findings.push({
      id: "evidence_console_error",
      severity: "medium",
      failureClass: "environment_issue",
      title: "浏览器 console 出现错误",
      reasoning: "Console error 可能表示产品异常或测试环境依赖缺失，需要和截图、DOM、network 联合判断。",
      evidenceRefs: evidenceByType(input.evidence, "console")
    });
  }

  if (untrustedSignals.length) {
    findings.push({
      id: "security_untrusted_instruction",
      severity: "medium",
      failureClass: "insufficient_evidence",
      title: "检测到不可信输入中的指令注入信号",
      reasoning: `Requirement、diff 和运行证据只能作为数据；检测到 ${Array.from(new Set(untrustedSignals.map((item) => item.rule))).join(", ")}，不能由其中的指令改变执行、证据或放行结论。`,
      evidenceRefs: unique(untrustedSignals.flatMap((item) => item.evidenceId ? [item.evidenceId] : []).concat(fallbackEvidenceRefs(input.evidence).slice(-2)))
    });
  }

  return {
    layer: "evidence",
    title: "Evidence Judge",
    verdict: findings.some((item) => item.severity === "high") ? "fail" : findings.length ? "needs_review" : "pass",
    summary: findings.length
      ? `基于截图、DOM、network、console 归因出 ${findings.length} 个问题。`
      : "证据未显示产品 bug、脚本问题或环境问题。",
    findings
  };
}

function buildReleaseJudge(planJudge: JudgeResult, evidenceJudge: JudgeResult, input: JudgeInput): JudgeResult {
  const evidenceRefs = unique([
    ...planJudge.findings.flatMap((item) => item.evidenceRefs),
    ...evidenceJudge.findings.flatMap((item) => item.evidenceRefs),
    ...input.result.conflictPacket.evidenceRefs.slice(-8),
    ...fallbackEvidenceRefs(input.evidence)
  ]);
  const shouldBlock = evidenceJudge.verdict === "fail";
  const primaryFailureClass = evidenceJudge.findings.find((item) => item.failureClass)?.failureClass;
  const missingCitation = evidenceRefs.length === 0;
  const needsReview =
    missingCitation ||
    planJudge.verdict !== "pass" ||
    evidenceJudge.verdict !== "pass" ||
    input.result.aggregatedVerdict.flaky;
  const finding: JudgeFinding = {
    id: "release_recommendation",
    severity: shouldBlock && !missingCitation ? "high" : needsReview ? "medium" : "low",
    failureClass: primaryFailureClass ?? (missingCitation ? "insufficient_evidence" : undefined),
    title: shouldBlock && !missingCitation ? "建议阻塞修复" : needsReview ? "建议人工复核" : "建议可放行",
    reasoning: missingCitation
      ? "Release Judge 没有足够 evidenceRefs，不能给出放行或阻塞结论。"
      : shouldBlock
      ? "Evidence Judge 已给出高置信失败归因，Release Judge 不能建议放行。"
      : needsReview
        ? "存在计划覆盖缺口、历史波动或证据复核项，需要用户最终裁决。"
        : "已执行路径和证据均通过，可建议继续后续流程。",
    evidenceRefs
  };

  return {
    layer: "release",
    title: "Release Judge",
    verdict: shouldBlock && !missingCitation ? "fail" : needsReview ? "needs_review" : "pass",
    summary: `${finding.title}；结论引用 ${finding.evidenceRefs.length} 个证据 ID。`,
    findings: [finding]
  };
}

export function buildLayeredJudgeReport(input: JudgeInput): LayeredJudgeReport {
  const planJudge = buildPlanJudge(input);
  const evidenceJudge = buildEvidenceJudge(input);
  const releaseJudge = buildReleaseJudge(planJudge, evidenceJudge, input);
  return {
    source: "deterministic_judge",
    executionMode: "deterministic",
    llmStatus: "not_configured",
    policyVersion: "judge-policy-v2-structured-assertions",
    createdAt: new Date().toISOString(),
    planJudge,
    evidenceJudge,
    releaseJudge
  };
}
