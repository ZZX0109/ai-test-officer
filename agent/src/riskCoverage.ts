import type { EvidenceItem, RiskCoverageItem, VisualRunResult } from "./types.js";
import type { ExecutableScenario, ScenarioOracle } from "./scenarios.js";

function evidenceFor(evidence: EvidenceItem[], title: string) {
  return evidence.filter((item) => item.title.includes(title)).map((item) => item.id);
}

function riskIdFor(oracle: ScenarioOracle) {
  if (oracle.type === "network_query") return "risk_core_request";
  if (oracle.type === "error_text") return "risk_error_recovery";
  if (oracle.type === "empty_state") return "risk_empty_state";
  return "risk_visible_oracle";
}

function riskTitleFor(oracle: ScenarioOracle) {
  if (oracle.type === "network_query") return "核心请求参数风险";
  if (oracle.type === "error_text") return "异常恢复风险";
  if (oracle.type === "empty_state") return "空状态展示风险";
  return "页面可见结果风险";
}

export function buildRiskCoverageMatrix(
  result: Pick<VisualRunResult, "assertions">,
  evidence: EvidenceItem[],
  scenario: ExecutableScenario
): RiskCoverageItem[] {
  const items = scenario.corePath.oracles.map((oracle) => {
    const assertion = result.assertions.find((item) => item.name === oracle.name);
    return {
      riskId: riskIdFor(oracle),
      riskTitle: riskTitleFor(oracle),
      covered: Boolean(assertion),
      passed: Boolean(assertion?.passed),
      pathIds: [scenario.corePath.pathId],
      evidenceRefs: evidenceFor(evidence, oracle.name),
      notes: assertion
        ? assertion.passed
          ? `${oracle.name} 已覆盖且通过。`
          : `${oracle.name} 已覆盖但失败。`
        : `${oracle.name} 未产生断言证据。`
    };
  });

  const pageAssertion = result.assertions.find((item) => item.name === scenario.smoke.assertionName);
  const regressionAssertion = scenario.regressionPath
    ? result.assertions.find((item) => item.name.startsWith(scenario.regressionPath!.title))
    : undefined;
  const regressionEvidence = scenario.regressionPath
    ? evidence.filter((item) => item.pathId === scenario.regressionPath!.stepId && item.type === "assertion").map((item) => item.id)
    : [];
  return [
    {
      riskId: "risk_smoke",
      riskTitle: "页面基础可用性风险",
      covered: Boolean(pageAssertion),
      passed: Boolean(pageAssertion?.passed),
      pathIds: [scenario.smoke.pathId],
      evidenceRefs: evidenceFor(evidence, scenario.smoke.assertionName),
      notes: pageAssertion?.passed ? "Smoke 路径通过。" : "Smoke 路径未通过或缺少证据。"
    },
    ...items,
    ...(scenario.regressionPath && regressionAssertion ? [{
      riskId: "risk_regression",
      riskTitle: "回归路径稳定性风险",
      covered: Boolean(regressionAssertion),
      passed: Boolean(regressionAssertion?.passed),
      pathIds: [scenario.regressionPath.stepId],
      evidenceRefs: regressionEvidence,
      notes: regressionAssertion?.passed ? "回归路径执行后页面与运行信号保持稳定。" : "回归路径未通过或缺少结构化断言。"
    }] : [])
  ];
}
