import type { EvidenceItem, OracleDefinition } from "./types.js";
import type { OracleSpecV2 } from "@ai-test-officer/contracts";
import { oracleSpecV2Schema } from "@ai-test-officer/contracts";
import { canonicalSha256 } from "./canonicalHash.js";
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

function v2Type(type: ScenarioOracle["type"]): OracleSpecV2["type"] {
  switch (type) {
    case "network_query": return "network";
    case "api_schema": return "api-schema";
    case "url_not_contains": return "url";
    case "console_no_error": return "custom";
    default: return "dom";
  }
}

function sourceFor(expectedFrom: OracleDefinition["expectedFrom"]): OracleSpecV2["source"]["kind"] {
  switch (expectedFrom) {
    case "historical_behavior": return "historical-behavior";
    case "llm_inferred": return "llm-inference";
    case "existing_test": return "runtime-observation";
    case "diff": return "formal-contract";
    default: return "formal-contract";
  }
}

/**
 * Projects the existing scenario Oracle definitions into the versioned
 * governance contract. The boolean comparison deliberately evaluates the
 * already-captured assertion result; the human-readable postcondition stays
 * in `description` for Workbench and generated test assets.
 */
export function buildScenarioOracleSpecsV2(input: {
  scenario: ExecutableScenario;
  evidence: EvidenceItem[];
  projectId: string;
  runId: string;
  attemptId?: string;
}): OracleSpecV2[] {
  const legacy = buildScenarioOracles(input.scenario, input.evidence);
  const scenarioOracleById = new Map(input.scenario.corePath.oracles.map((oracle) => [oracleId(oracle.id), oracle]));
  const now = new Date().toISOString();
  return legacy.map((oracle) => {
    const scenarioOracle = scenarioOracleById.get(oracle.id);
    const description = oracle.postconditions[0] ?? oracle.assertionName;
    const sourceKind = sourceFor(oracle.expectedFrom);
    const sourceId = `scenario:${input.scenario.id}:${oracle.id}`;
    return oracleSpecV2Schema.parse({
      schemaVersion: "2.0",
      id: oracle.id,
      projectId: input.projectId,
      coverageItemId: oracle.pathId,
      type: scenarioOracle ? v2Type(scenarioOracle.type) : "dom",
      description,
      preconditions: oracle.preconditions,
      observationWindow: { start: "after-action", timeoutMs: 20_000, pollIntervalMs: 500 },
      comparison: {
        operator: "equals",
        expected: true,
        actualPath: oracle.assertionName
      },
      source: {
        kind: sourceKind,
        id: sourceId,
        version: "scenario-v2",
        sha256: canonicalSha256({ sourceId, description, postconditions: oracle.postconditions })
      },
      decisionUse: sourceKind === "formal-contract" ? "release" : "review-only",
      conflictRefs: [],
      humanConfirmation: { status: "not-required" },
      lifecycle: { status: "active" },
      runEvidence: {
        runId: input.runId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        evidenceRefs: oracle.evidenceRefs,
        artifactIds: []
      },
      createdAt: now,
      updatedAt: now
    });
  });
}
