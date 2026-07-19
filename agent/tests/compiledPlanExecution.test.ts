import assert from "node:assert/strict";
import type { CompiledPlan } from "@ai-test-officer/contracts";
import type { Page } from "playwright";
import { buildQueuedRunRequest } from "../src/runOrchestrator.js";
import { assertCompiledPlanBinding, executeCompiledAction, targetFrontendUrl } from "../src/testRunner.js";
import { getScenario } from "../src/scenarios.js";

function filterPlan(): CompiledPlan {
  return {
    scenarioId: "task_filter_completed",
    steps: [
      { id: "open", pathId: "open_task_page", action: { action: "navigate", path: "/" } },
      { id: "click", pathId: "completed_filter_path", action: { action: "click", selectorRef: "triggerButtonName" } },
      { id: "query", pathId: "completed_filter_path", action: { action: "assert", oracleId: "completed_filter_query" } },
      { id: "dom", pathId: "completed_filter_path", action: { action: "assert", oracleId: "completed_filter_dom" } },
      { id: "regression", pathId: "all_filter_regression", action: { action: "click", selectorRef: "regressionTriggerButtonName" } }
    ],
    requiredOracleIds: ["completed_filter_query", "completed_filter_dom"],
    requiredEvidenceKinds: ["screenshot", "dom", "network", "console", "trace"]
  };
}

export async function testCompiledPlanExecution() {
  const scenario = getScenario("task_filter_completed");
  const compiledPlan = filterPlan();
  assert.equal(assertCompiledPlanBinding(compiledPlan, scenario).steps.length, 5);
  assert.throws(
    () => assertCompiledPlanBinding({
      ...compiledPlan,
      steps: compiledPlan.steps.map((step) => step.id === "click"
        ? { id: step.id, action: { action: "click" as const, selectorRef: "attackerCss" } }
        : step)
    }, scenario),
    /compiled_plan_unknown_selector/
  );

  const events: string[] = [];
  const locator = {
    click: async () => { events.push("click"); },
    fill: async (value: string) => { events.push(`fill:${value}`); },
    selectOption: async (value: string) => { events.push(`select:${value}`); },
    setInputFiles: async (file: string) => { events.push(`upload:${file}`); }
  };
  const page = {
    goto: async (url: string) => { events.push(`goto:${url}`); },
    getByRole: () => locator,
    getByLabel: () => locator,
    locator: () => locator,
    waitForTimeout: async (duration: number) => { events.push(`wait:${duration}`); }
  } as unknown as Page;
  const evaluated: string[] = [];
  const context = {
    page,
    scenario,
    targetFrontendUrl: "http://127.0.0.1:4173/base",
    evaluateOracle: async (oracle: { id: string }) => { evaluated.push(oracle.id); },
    resolveFixture: async () => "/tmp/fixture"
  };
  for (const step of compiledPlan.steps) await executeCompiledAction(step.action, step.id, context);
  assert.deepEqual(events, ["goto:http://127.0.0.1:4173/", "click", "click"]);
  assert.deepEqual(evaluated, ["completed_filter_query", "completed_filter_dom"]);

  const createScenario = getScenario("task_create_success");
  const createContext = { ...context, scenario: createScenario };
  await executeCompiledAction({ action: "fill", selectorRef: "inputLabel", valueRef: "input" }, "fill", createContext);
  await executeCompiledAction({ action: "select", selectorRef: "selectLabel", valueRef: "selectValue" }, "select", createContext);
  await executeCompiledAction({ action: "wait", durationMs: 25 }, "wait", createContext);
  assert.deepEqual(events.slice(-3), ["fill:合规检查任务", `select:${createScenario.corePath.selectValue}`, "wait:25"]);
  assert.throws(
    () => assertCompiledPlanBinding({
      scenarioId: createScenario.id,
      steps: [
        { id: "open", action: { action: "navigate", path: "/" } },
        { id: "bad", action: { action: "fill", selectorRef: "selectLabel", valueRef: "selectValue" } },
        ...createScenario.corePath.oracles.map((oracle) => ({ id: `assert-${oracle.id}`, action: { action: "assert" as const, oracleId: oracle.id } }))
      ],
      requiredOracleIds: createScenario.corePath.oracles.map((oracle) => oracle.id),
      requiredEvidenceKinds: ["screenshot", "dom", "trace"]
    }, createScenario),
    /compiled_plan_fill_selector_not_actionable/
  );
  assert.throws(
    () => assertCompiledPlanBinding({
      scenarioId: createScenario.id,
      steps: [
        { id: "open", action: { action: "navigate", path: "/" } },
        { id: "bad", action: { action: "select", selectorRef: "inputLabel", valueRef: "input" } },
        ...createScenario.corePath.oracles.map((oracle) => ({ id: `assert-${oracle.id}`, action: { action: "assert" as const, oracleId: oracle.id } }))
      ],
      requiredOracleIds: createScenario.corePath.oracles.map((oracle) => oracle.id),
      requiredEvidenceKinds: ["screenshot", "dom", "trace"]
    }, createScenario),
    /compiled_plan_select_selector_not_actionable/
  );
  await assert.rejects(
    () => executeCompiledAction({ action: "navigate", path: "//attacker.example/path" }, "escape", context),
    /compiled_plan_cross_origin_navigation/
  );

  const queued = buildQueuedRunRequest({
    id: "run-test",
    state: "queued",
    version: 4,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: { appUrl: "http://127.0.0.1:4173", plannerMode: "llm" },
    selectedScenarioId: scenario.id,
    compiledPlan
  }, new AbortController().signal);
  assert.equal(queued.compiledPlan, compiledPlan, "worker must pass the persisted compiled plan to the browser runner");
  assert.equal(targetFrontendUrl("http://127.0.0.1:4173/base?existing=1", "fxv_d10a7e1c4b298f63"), "http://127.0.0.1:4173/base?existing=1&fixtureVariantId=fxv_d10a7e1c4b298f63");
}
