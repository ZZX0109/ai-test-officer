import type { Locator, Page } from "playwright";
import { compiledPlanSchema, type ActionDsl, type CompiledPlan } from "@ai-test-officer/contracts";
import { assertCompiledPlanSemanticContract } from "../compiledPlanContract.js";
import { navigateToUsablePage } from "../executionRuntime.js";
import { getScenario, type ScenarioOracle } from "../scenarios.js";
import { type StructuredAction, type StructuredActionResult } from "../structuredActionExecutors.js";

function scenarioSelectorRefs(scenario: ReturnType<typeof getScenario>) {
  return new Set([
    ...Object.keys(scenario.corePath).filter((key) => /ButtonName|Label|Locator/.test(key)),
    ...(scenario.regressionPath?.triggerButtonName ? ["regressionTriggerButtonName"] : [])
  ]);
}

function scenarioValueRefs(scenario: ReturnType<typeof getScenario>) {
  const refs = new Set(Object.keys(scenario.corePath).filter((key) =>
    /^(input|selectValue)$/.test(key) && typeof scenario.corePath[key as keyof typeof scenario.corePath] === "string"
  ));
  if (["login_as_test_user", "login_invalid_user"].includes(scenario.corePath.action)) {
    refs.add("projectLoginUsername");
    refs.add("projectLoginPassword");
  }
  return refs;
}

/** Runtime validation is intentional: persisted plans and internal callers must not bypass the compiler boundary. */
export function assertCompiledPlanBinding(compiledPlan: CompiledPlan, scenario: ReturnType<typeof getScenario>) {
  const parsed = compiledPlanSchema.parse(compiledPlan);
  if (parsed.scenarioId !== scenario.id) throw new Error(`compiled_plan_scenario_mismatch:${parsed.scenarioId}:${scenario.id}`);
  const selectors = scenarioSelectorRefs(scenario);
  const values = scenarioValueRefs(scenario);
  const oracleIds = new Set(scenario.corePath.oracles.map((oracle) => oracle.id));
  const allowedPathIds = new Set([scenario.smoke.pathId, scenario.corePath.pathId, ...(scenario.regressionPath ? [scenario.regressionPath.stepId] : [])]);
  const fixtureRefs = new Set(scenario.corePath.action === "file_upload_validate" ? ["scenarioFixture"] : []);
  const capturableKinds = new Set(["screenshot", "dom", "network", "console", "trace", "video", "operation-log"]);
  for (const kind of parsed.requiredEvidenceKinds) {
    if (!capturableKinds.has(kind)) throw new Error(`compiled_plan_unsupported_evidence_kind:${kind}`);
  }
  const containsBrowserAction = parsed.steps.some((step) =>
    ["navigate", "click", "fill", "select", "upload", "assert", "wait"].includes(step.action.action)
  );
  if (containsBrowserAction && parsed.steps[0]?.action.action !== "navigate") {
    throw new Error("compiled_plan_browser_path_must_start_with_navigate");
  }
  const asserted = new Set<string>();
  for (const step of parsed.steps) {
    if (step.pathId && !allowedPathIds.has(step.pathId)) throw new Error(`compiled_plan_unknown_path:${step.pathId}`);
    const action = step.action;
    if ("selectorRef" in action && !selectors.has(action.selectorRef)) throw new Error(`compiled_plan_unknown_selector:${action.selectorRef}`);
    if (action.action === "click" && !(action.selectorRef.endsWith("ButtonName") || action.selectorRef === "regressionTriggerButtonName")) throw new Error(`compiled_plan_click_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "fill"
      && !["inputLabel", "usernameLabel", "passwordLabel", "usernameLocator", "passwordLocator"].includes(action.selectorRef)) {
      throw new Error(`compiled_plan_fill_selector_not_actionable:${action.selectorRef}`);
    }
    if (action.action === "select" && action.selectorRef !== "selectLabel") throw new Error(`compiled_plan_select_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "upload" && !action.selectorRef.endsWith("Label")) throw new Error(`compiled_plan_upload_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "fill" && !values.has(action.valueRef)) throw new Error(`compiled_plan_unknown_value:${action.valueRef}`);
    if (action.action === "select" && (action.valueRef !== "selectValue" || !values.has(action.valueRef))) throw new Error(`compiled_plan_unknown_select_value:${action.valueRef}`);
    if (action.action === "upload" && !fixtureRefs.has(action.fixtureRef)) throw new Error(`compiled_plan_unknown_fixture:${action.fixtureRef}`);
    if (action.action === "assert") {
      if (!oracleIds.has(action.oracleId)) throw new Error(`compiled_plan_unknown_oracle:${action.oracleId}`);
      if (step.pathId && step.pathId !== scenario.corePath.pathId) throw new Error(`compiled_plan_assert_outside_core_path:${step.pathId}`);
      asserted.add(action.oracleId);
    }
    if (action.action === "click" && action.selectorRef === "regressionTriggerButtonName" && step.pathId !== scenario.regressionPath?.stepId) throw new Error(`compiled_plan_regression_selector_wrong_path:${step.pathId ?? "missing"}`);
  }
  const clickKeys = parsed.steps.filter((step) => step.action.action === "click").map((step) => `${step.pathId ?? scenario.corePath.pathId}:${step.action.action === "click" ? step.action.selectorRef : ""}`);
  if (new Set(clickKeys).size !== clickKeys.length) throw new Error("compiled_plan_duplicate_click");
  for (const required of parsed.requiredOracleIds) {
    if (!oracleIds.has(required)) throw new Error(`compiled_plan_unknown_required_oracle:${required}`);
    if (!asserted.has(required)) throw new Error(`compiled_plan_oracle_not_executed:${required}`);
  }
  return assertCompiledPlanSemanticContract(parsed, scenario);
}

function resolveApprovedLocator(page: Page, scenario: ReturnType<typeof getScenario>, selectorRef: string): Locator {
  if (!scenarioSelectorRefs(scenario).has(selectorRef)) throw new Error(`compiled_plan_unknown_selector:${selectorRef}`);
  const selector = selectorRef === "regressionTriggerButtonName"
    ? scenario.regressionPath?.triggerButtonName
    : scenario.corePath[selectorRef as keyof typeof scenario.corePath];
  if (typeof selector !== "string" || !selector) throw new Error(`compiled_plan_empty_selector:${selectorRef}`);
  if (selectorRef.endsWith("ButtonName")) return page.getByRole("button", { name: selector, exact: true });
  if (selectorRef.endsWith("Label")) return page.getByLabel(selector);
  if (selectorRef.endsWith("Locator")) return page.locator(selector);
  throw new Error(`compiled_plan_unsupported_selector:${selectorRef}`);
}

export interface CompiledActionExecutionContext {
  page: Page;
  scenario: ReturnType<typeof getScenario>;
  targetFrontendUrl: string;
  evaluateOracle: (oracle: ScenarioOracle, stepId: string) => Promise<unknown>;
  resolveFixture: (fixtureRef: string) => Promise<string>;
  resolveValue?: (valueRef: string) => Promise<string>;
  executeStructured?: (action: StructuredAction, stepId: string) => Promise<StructuredActionResult>;
  onNavigation?: (event: { status: "started" | "succeeded" | "failed"; url: string; httpStatus?: number; error?: string }) => void;
}

/** Execute one already-bound DSL action without accepting raw selectors, URLs, values, or commands. */
export async function executeCompiledAction(action: ActionDsl, stepId: string, context: CompiledActionExecutionContext) {
  const { page, scenario } = context;
  if (action.action === "navigate") {
    const base = new URL(context.targetFrontendUrl);
    const destination = new URL(action.path, base);
    if (destination.origin !== base.origin) throw new Error("compiled_plan_cross_origin_navigation");
    if (!destination.search && base.search) destination.search = base.search;
    await navigateToUsablePage(page, destination.toString(), context.onNavigation);
    return;
  }
  if (action.action === "click") {
    await resolveApprovedLocator(page, scenario, action.selectorRef).click();
    return;
  }
  if (action.action === "fill") {
    if (!scenarioValueRefs(scenario).has(action.valueRef)) throw new Error(`compiled_plan_unknown_value:${action.valueRef}`);
    const value = action.valueRef.startsWith("projectLogin")
      ? await context.resolveValue?.(action.valueRef)
      : scenario.corePath[action.valueRef as keyof typeof scenario.corePath];
    if (typeof value !== "string") throw new Error(`compiled_plan_empty_value:${action.valueRef}`);
    await resolveApprovedLocator(page, scenario, action.selectorRef).fill(value);
    return;
  }
  if (action.action === "select") {
    if (action.selectorRef !== "selectLabel" || action.valueRef !== "selectValue") throw new Error("compiled_plan_select_binding_invalid");
    const value = scenario.corePath[action.valueRef as keyof typeof scenario.corePath];
    if (typeof value !== "string") throw new Error(`compiled_plan_empty_value:${action.valueRef}`);
    await resolveApprovedLocator(page, scenario, action.selectorRef).selectOption(value);
    return;
  }
  if (action.action === "upload") {
    await resolveApprovedLocator(page, scenario, action.selectorRef).setInputFiles(await context.resolveFixture(action.fixtureRef));
    return;
  }
  if (action.action === "assert") {
    const oracle = scenario.corePath.oracles.find((item) => item.id === action.oracleId);
    if (!oracle) throw new Error(`compiled_plan_unknown_oracle:${action.oracleId}`);
    await context.evaluateOracle(oracle, stepId);
    return;
  }
  if (action.action === "wait") {
    await page.waitForTimeout(action.durationMs);
    return;
  }
  if (!context.executeStructured) throw new Error(`compiled_plan_structured_action_executor_missing:${action.action}`);
  return context.executeStructured(action, stepId);
}
