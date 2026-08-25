import assert from "node:assert/strict";
import { coverageItemSchema, type CompiledPlan } from "@ai-test-officer/contracts";
import type { Page } from "playwright";
import type { GrayPlan } from "../src/types.js";
import {
  blockUndispatchableCoverageItems,
  buildDynamicPathPlan,
  buildQueuedRunRequest,
  classifyParentCoverageDispatch
} from "../src/runOrchestrator.js";
import { createDynamicBrowserCoverageItems } from "../src/coverageStore.js";
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
  const dynamicPlan = {
    sessionName: "full scan",
    risks: [
      { id: "risk-a", level: "high", title: "A", evidence: "source", pathIds: ["flow-a"], coverageDisposition: "required" },
      { id: "risk-b", level: "medium", title: "B", evidence: "source", pathIds: ["flow-b"], coverageDisposition: "required" }
    ],
    levels: [{
      id: "core",
      title: "Core",
      description: "paths",
      paths: [
        { id: "flow-a", title: "A", riskReason: "a", expectedFrom: "requirement", steps: ["observe"], retry: 1 },
        { id: "flow-b", title: "B", riskReason: "b", expectedFrom: "requirement", steps: ["observe"], retry: 1 }
      ]
    }]
  } as GrayPlan;
  const childPlan = buildDynamicPathPlan(dynamicPlan, "flow-b");
  assert.deepEqual(childPlan.levels.flatMap((level) => level.paths).map((path) => path.id), ["flow-b"]);
  assert.deepEqual(childPlan.risks.map((risk) => risk.id), ["risk-b"]);

  // A full scan may discover hundreds of runtime-bindable paths. Dispatch must
  // preserve all of them; it is the queue's job to bound concurrency, not the
  // compiler's job to truncate the inventory. Every non-dispatchable pending
  // item is returned with a concrete blocked reason instead of being dropped.
  const fullScanItems = createDynamicBrowserCoverageItems({
    runId: "run_full_scan_200",
    paths: Array.from({ length: 200 }, (_, index) => ({
      id: `page_${index + 1}`,
      title: `Page ${index + 1}`,
      status: "auto-bindable" as const,
      surface: "page" as const
    }))
  });
  const fullScanDispatch = classifyParentCoverageDispatch({ items: fullScanItems, dynamicParent: true });
  assert.equal(fullScanDispatch.executable.length, 200, "all 200 runtime paths must receive child-run dispatch");
  assert.equal(fullScanDispatch.undispatchable.length, 0);

  const boundWithoutExecutor = coverageItemSchema.parse({
    ...fullScanItems[0],
    id: "coverage_bound_without_executor",
    flowId: "api:missing-executor",
    surface: "api",
    scenarioId: undefined,
    binding: {
      compilerVersion: "runtime-binding-v1",
      status: "bound",
      actionPathIds: ["api:missing-executor"],
      oracleIds: ["api:missing-executor:oracle"],
      requiredCapabilities: ["targetNetwork"]
    }
  });
  const failClosedDispatch = classifyParentCoverageDispatch({
    items: [...fullScanItems.slice(0, 1), boundWithoutExecutor],
    dynamicParent: true
  });
  assert.deepEqual(
    failClosedDispatch.undispatchable.map(({ item, reason }) => [item.id, reason]),
    [["coverage_bound_without_executor", "coverage_bound_path_not_dispatchable"]]
  );
  const normalizedCoverage = blockUndispatchableCoverageItems({
    items: [...fullScanItems.slice(0, 1), boundWithoutExecutor],
    undispatchable: failClosedDispatch.undispatchable
  });
  const normalizedGap = normalizedCoverage.find((item) => item.id === "coverage_bound_without_executor");
  assert.equal(normalizedGap?.disposition, "blocked");
  assert.equal(normalizedGap?.binding?.status, "coverage-gap");
  assert.equal(normalizedGap?.dispositionReason, "coverage_bound_path_not_dispatchable");

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
  assert.equal(queued.runId, "run-test", "worker evidence must use the control-plane run id");
  assert.equal(queued.compiledPlan, compiledPlan, "worker must pass the persisted compiled plan to the browser runner");
  assert.equal(targetFrontendUrl("http://127.0.0.1:4173/base?existing=1", "fxv_d10a7e1c4b298f63"), "http://127.0.0.1:4173/base?existing=1&fixtureVariantId=fxv_d10a7e1c4b298f63");
}
