import type { EvidenceItem, OracleDefinition } from "./types.js";
import type { ExecutableScenario, ScenarioOracle } from "./scenarios.js";

function oracleId(value: string) {
  return `oracle_${value.replace(/[^a-z0-9_]+/gi, "_").toLowerCase()}`;
}

function evidenceForAssertion(evidence: EvidenceItem[], assertionName: string) {
  return evidence
    .filter((item) => item.type === "assertion" && item.title === assertionName)
    .map((item) => item.id);
}

function postcondition(oracle: ScenarioOracle) {
  if (oracle.type === "network_query") {
    return `请求 ${oracle.networkUrlIncludes ?? ""} 包含 ${oracle.expectedQueryFragment ?? ""}`;
  }
  if (oracle.expectedTextIncludes) {
    return `页面文本包含 ${oracle.expectedTextIncludes}`;
  }
  if (oracle.expectedStatusText) {
    return `匹配节点文本均包含 ${oracle.expectedStatusText}`;
  }
  return oracle.expected;
}

export function buildScenarioOracles(scenario: ExecutableScenario, evidence: EvidenceItem[]): OracleDefinition[] {
  return [
    {
      id: oracleId(scenario.smoke.pathId),
      pathId: scenario.smoke.pathId,
      assertionName: scenario.smoke.assertionName,
      expectedFrom: "requirement",
      preconditions: ["本地应用地址可访问"],
      action: scenario.smoke.title,
      postconditions: [scenario.smoke.expected],
      requiresHumanConfirmation: false,
      evidenceRefs: evidenceForAssertion(evidence, scenario.smoke.assertionName)
    },
    ...scenario.corePath.oracles.map((oracle) => ({
      id: oracleId(oracle.id),
      pathId: scenario.corePath.pathId,
      assertionName: oracle.name,
      expectedFrom: "requirement" as const,
      preconditions: ["Smoke 路径已通过，页面处于可操作状态"],
      action: scenario.corePath.title,
      postconditions: [postcondition(oracle)],
      requiresHumanConfirmation: false,
      evidenceRefs: evidenceForAssertion(evidence, oracle.name)
    }))
  ];
}
