import type { ExecutableTestPlan, GrayPlan, ImpactAnalysis, PlanStep } from "./types.js";
import { getScenario, listExecutableScenarios, type ExecutableScenario, type ScenarioOracleType } from "./scenarios.js";

const selectorPriority: PlanStep["selectorStrategy"]["priority"] = ["role", "text", "testId", "css"];

function locatorTestId(locator?: string) {
  return locator?.match(/data-testid=['"]([^'"]+)/)?.[1];
}

function scenarioLocator(scenario: ExecutableScenario) {
  return scenario.corePath.targetLocator ??
    scenario.corePath.statusLocator ??
    scenario.corePath.validationLocator ??
    scenario.corePath.emptyStateLocator ??
    scenario.corePath.errorLocator;
}

function scenarioExpectedText(scenario: ExecutableScenario) {
  return scenario.corePath.expectedTextIncludes ??
    scenario.corePath.expectedStatusText ??
    scenario.corePath.expectedValidationText ??
    scenario.corePath.expectedEmptyText ??
    scenario.corePath.expectedErrorText;
}

function selectorStrategyForScenario(scenario: ExecutableScenario): PlanStep["selectorStrategy"] {
  const locator = scenarioLocator(scenario);
  return {
    priority: [...selectorPriority],
    role: scenario.corePath.triggerButtonName ?? scenario.corePath.submitButtonName ?? scenario.corePath.retryButtonName,
    text: scenarioExpectedText(scenario),
    testId: locatorTestId(locator),
    css: locator
  };
}

function requiredEvidenceForOracle(type: ScenarioOracleType): PlanStep["evidenceRequirements"][number][] {
  if (type === "network_query") return ["network"];
  if (type === "console_no_error") return ["console"];
  if (type === "api_schema") return ["network", "dom"];
  return ["dom"];
}

function requiredEvidenceForScenario(scenario: ExecutableScenario): PlanStep["evidenceRequirements"] {
  return Array.from(new Set([
    "screenshot" as const,
    ...scenario.corePath.oracles.flatMap((oracle) => requiredEvidenceForOracle(oracle.type))
  ]));
}

function expectedBrowserActionsForScenario(scenario: ExecutableScenario) {
  return [
    scenario.smoke.title,
    scenario.corePath.title,
    ...(scenario.regressionPath ? [scenario.regressionPath.title] : [])
  ];
}

function planStepForScenario(
  scenarioId: string,
  plan: GrayPlan,
  compileSource?: PlanStep["compileSource"]
): PlanStep {
  const scenario = getScenario(scenarioId);
  const effectiveCompileSource = compileSource ?? (scenario.genericTemplate ? "generic_template" : "registry");
  return {
    id: `plan_step_${scenario.id}`,
    scenarioId: scenario.id,
    compileSource: effectiveCompileSource,
    humanReviewRequired: effectiveCompileSource === "harness_gap",
    capabilityKind: scenario.capabilityKind ?? "domain_specific",
    title: scenario.corePath.title,
    preconditions: ["Project health check passed", scenario.smoke.expected],
    browserActions: expectedBrowserActionsForScenario(scenario),
    selectorStrategy: selectorStrategyForScenario(scenario),
    assertions: scenario.corePath.oracles.map((oracle) => oracle.name),
    evidenceRequirements: requiredEvidenceForScenario(scenario),
    failurePolicy: {
      allowedFailureClasses: ["product_bug", "test_script_issue", "environment_issue", "insufficient_evidence", "unknown"],
      stopOnFailure: false
    },
    retryPolicy: {
      maxRetries: 1,
      timeoutMs: scenario.corePath.waitMs ?? 15_000
    }
  };
}

function assertSelectorPriority(step: PlanStep) {
  const priority = step.selectorStrategy.priority;
  if (new Set(priority).size !== priority.length) {
    throw new Error(`PlanStep ${step.id} selector priority contains duplicate entries.`);
  }
  const missing = selectorPriority.filter((kind) => !priority.includes(kind));
  if (missing.length) {
    throw new Error(`PlanStep ${step.id} selector priority is missing ${missing.join(", ")}.`);
  }
  const order = selectorPriority.map((kind) => priority.indexOf(kind));
  if (order.some((index, itemIndex) => itemIndex > 0 && index < order[itemIndex - 1])) {
    throw new Error(`PlanStep ${step.id} selector priority must prefer role, text, testId, then css.`);
  }
}

function assertSelectorMatchesScenario(step: PlanStep, scenario: ExecutableScenario) {
  assertSelectorPriority(step);
  const expected = selectorStrategyForScenario(scenario);
  const mismatches = (["role", "text", "testId", "css"] as const).filter((kind) => {
    const expectedValue = expected[kind];
    return Boolean(expectedValue) && step.selectorStrategy[kind] !== expectedValue;
  });
  if (mismatches.length) {
    throw new Error(`PlanStep ${step.id} selector strategy does not match scenario ${scenario.id}: ${mismatches.join(", ")}`);
  }
  const selectorValues = [
    step.selectorStrategy.role,
    step.selectorStrategy.text,
    step.selectorStrategy.testId,
    step.selectorStrategy.css
  ].filter(Boolean);
  if (selectorValues.length === 0) {
    throw new Error(`PlanStep ${step.id} does not declare an executable selector strategy.`);
  }
}

function planSearchText(plan: GrayPlan, impactAnalysis?: ImpactAnalysis) {
  return [
    plan.sessionName,
    ...plan.risks.flatMap((risk) => [risk.title, risk.evidence]),
    ...plan.levels.flatMap((level) => [
      level.title,
      level.description,
      ...level.paths.flatMap((path) => [path.title, path.riskReason, ...path.steps])
    ]),
    ...(impactAnalysis?.affectedApis.map((item) => item.target) ?? []),
    ...(impactAnalysis?.affectedComponents.map((item) => item.target) ?? []),
    ...(impactAnalysis?.uncoveredRisks.flatMap((item) => [item.title, item.reason, ...item.requiredCapabilities]) ?? [])
  ].join("\n").toLowerCase();
}

function genericTemplateMatches(plan: GrayPlan, impactAnalysis?: ImpactAnalysis) {
  const text = planSearchText(plan, impactAnalysis);
  return listExecutableScenarios()
    .filter((scenario) => scenario.genericTemplate)
    .filter((scenario) => {
      const terms = [
        scenario.capabilityKind ?? "",
        scenario.title,
        scenario.summary ?? "",
        ...(scenario.matcher?.keywords ?? []),
        ...(scenario.matcher?.capabilities ?? [])
      ].filter(Boolean);
      return terms.some((term) => text.includes(term.toLowerCase()));
    })
    .map((scenario) => scenario.id);
}

function draftRefForPath(title: string) {
  return `draft_${title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "scenario"}`;
}

export function buildExecutablePlan(input: {
  plan: GrayPlan;
  selectedScenarioId?: string;
  impactAnalysis?: ImpactAnalysis;
  source: "scenario_registry" | "llm_validated" | "fallback";
}): ExecutableTestPlan {
  const registryScenarioIds = Array.from(new Set([
    input.selectedScenarioId,
    ...(input.impactAnalysis?.recommendedScenarios.map((item) => item.scenarioId) ?? [])
  ].filter(Boolean) as string[]));
  const genericScenarioIds = genericTemplateMatches(input.plan, input.impactAnalysis)
    .filter((scenarioId) => !registryScenarioIds.includes(scenarioId));
  const scenarioIds = [...registryScenarioIds, ...genericScenarioIds];
  const steps = scenarioIds.map((scenarioId) => planStepForScenario(
    scenarioId,
    input.plan,
    genericScenarioIds.includes(scenarioId) ? "generic_template" : undefined
  ));
  const rejectedSteps = steps.length
    ? []
    : input.plan.levels.flatMap((level) => level.paths.map((path) => ({
      title: path.title,
      reason: "No matching scenarioId or generic capability template in registry; moved to harness backlog.",
      compileSource: "harness_gap" as const,
      humanReviewRequired: true,
      draftScenarioRef: draftRefForPath(path.title),
      draftReviewStatus: "draft" as const,
      selectorProbeStatus: "not_run" as const
    })));
  return {
    id: `plan_${Date.now()}`,
    createdAt: new Date().toISOString(),
    source: genericScenarioIds.length ? "plan_compiler_v2" : input.source,
    status: steps.length ? "valid" : "needs_harness",
    plan: input.plan,
    steps,
    rejectedSteps
  };
}

export function assertExecutablePlan(plan: ExecutableTestPlan) {
  if (plan.status !== "valid" || plan.steps.length === 0) {
    throw new Error("Executable plan has no valid scenario-bound steps.");
  }
  for (const step of plan.steps) {
    if (!step.scenarioId || !step.assertions.length || !step.evidenceRequirements.length) {
      throw new Error(`PlanStep ${step.id} is not executable.`);
    }
    if (!step.compileSource) {
      throw new Error(`PlanStep ${step.id} is missing compileSource.`);
    }
    if (step.compileSource === "harness_gap" && !step.humanReviewRequired) {
      throw new Error(`PlanStep ${step.id} harness gap steps must require human review.`);
    }
    const scenario = getScenario(step.scenarioId);
    if ((scenario.capabilityKind ?? "domain_specific") !== (step.capabilityKind ?? "domain_specific")) {
      throw new Error(`PlanStep ${step.id} capabilityKind does not match scenario ${scenario.id}.`);
    }
    const oracleNames = scenario.corePath.oracles.map((oracle) => oracle.name);
    const missingRequiredAssertions = oracleNames.filter((name) => !step.assertions.includes(name));
    if (missingRequiredAssertions.length) {
      throw new Error(`PlanStep ${step.id} is missing required scenario assertions for ${scenario.id}: ${missingRequiredAssertions.join(", ")}`);
    }
    const missingAssertions = step.assertions.filter((name) => !oracleNames.includes(name));
    if (missingAssertions.length) {
      throw new Error(`PlanStep ${step.id} references assertions not declared by scenario ${scenario.id}: ${missingAssertions.join(", ")}`);
    }
    assertSelectorMatchesScenario(step, scenario);
    const missingActions = expectedBrowserActionsForScenario(scenario).filter((action) => !step.browserActions.includes(action));
    if (missingActions.length) {
      throw new Error(`PlanStep ${step.id} does not include required scenario actions for ${scenario.id}: ${missingActions.join(", ")}`);
    }
    const missingEvidence = requiredEvidenceForScenario(scenario).filter((kind) => !step.evidenceRequirements.includes(kind));
    if (missingEvidence.length) {
      throw new Error(`PlanStep ${step.id} does not request evidence required by scenario ${scenario.id}: ${missingEvidence.join(", ")}`);
    }
  }
  return plan;
}
