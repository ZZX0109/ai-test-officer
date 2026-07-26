import assert from "node:assert/strict";
import { buildExecutablePlan } from "../src/executablePlan.js";
import { buildScenarioGrayPlan } from "../src/plan.js";
import { getScenario } from "../src/scenarios.js";
import { assertRunRequestExecutablePlan, resolveBrowserHeadlessMode, shouldAutoStopProjectRuntime } from "../src/testRunner.js";

export function testRunnerLifecyclePolicy() {
  assert.equal(resolveBrowserHeadlessMode(undefined), true, "Workbench runs must not open a foreground browser by default");
  assert.equal(resolveBrowserHeadlessMode("1"), true);
  assert.equal(resolveBrowserHeadlessMode("0"), false, "a visible browser is reserved for explicit developer debugging");
  assert.equal(
    shouldAutoStopProjectRuntime({
      projectWasStartedByRunner: true,
      runtimeStatus: { status: "running" }
    }),
    true,
    "runner should stop a project it started"
  );
  assert.equal(
    shouldAutoStopProjectRuntime({
      projectWasStartedByRunner: true,
      keepProjectRunning: true,
      runtimeStatus: { status: "running" }
    }),
    false,
    "keepProjectRunning should preserve a runner-started project"
  );
  assert.equal(
    shouldAutoStopProjectRuntime({
      projectWasStartedByRunner: false,
      runtimeStatus: { status: "running" }
    }),
    false,
    "runner should not stop a project that was already healthy before the run"
  );
  assert.equal(
    shouldAutoStopProjectRuntime({
      projectWasStartedByRunner: true,
      runtimeStatus: { status: "failed" }
    }),
    false,
    "runner should not auto-stop a runtime that failed to start"
  );
}

export function testRunnerExecutablePlanBinding() {
  const plan = buildExecutablePlan({
    plan: buildScenarioGrayPlan(getScenario("task_filter_completed")),
    selectedScenarioId: "task_filter_completed",
    source: "scenario_registry"
  });
  assert.doesNotThrow(() => assertRunRequestExecutablePlan({
    scenarioId: "task_filter_completed",
    executablePlan: plan
  }));
  assert.throws(
    () => assertRunRequestExecutablePlan({ executablePlan: plan }),
    /must declare scenarioId/,
    "manual run requests with executablePlan must declare the scenario being executed"
  );
  assert.throws(
    () => assertRunRequestExecutablePlan({
      scenarioId: "task_filter_active",
      executablePlan: plan
    }),
    /is not present in executablePlan/,
    "runner must reject a run request whose scenarioId does not match the executable plan"
  );
}
