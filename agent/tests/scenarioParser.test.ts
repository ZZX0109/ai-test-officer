import assert from "node:assert/strict";
import { getScenario, listScenarios, matchScenariosForContext } from "../src/scenarios.js";

export function testScenarioParser() {
  const scenarios = listScenarios();
  assert.ok(scenarios.length >= 18, `expected at least 18 scenarios, got ${scenarios.length}`);
  for (const id of [
    "auth_login_failure",
    "auth_permission_intercept",
    "task_edit_title",
    "task_api_failure",
    "visual_regression_basic"
  ]) {
    assert.equal(getScenario(id).id, id);
  }
  assert.equal(getScenario("visual_regression_basic").corePath.oracles.some((oracle) => oracle.type === "console_no_error"), true);
  for (const id of ["order_approval_transition", "task_api_failure", "task_search_keyword", "task_state_transition"]) {
    const scenario = getScenario(id);
    assert.ok(scenario.compiledPlanContract, `${id} should receive a deterministic compiled plan contract`);
    assert.equal(scenario.compiledPlanContract?.requiredSteps[0]?.action.action, "navigate");
    assert.deepEqual(
      scenario.compiledPlanContract?.requiredSteps.filter((step) => step.action.action === "assert").map((step) => step.action.action === "assert" ? step.action.oracleId : ""),
      scenario.corePath.oracles.map((oracle) => oracle.id)
    );
  }
  const contractGaps = scenarios.filter((scenario) => !getScenario(scenario.id).compiledPlanContract).map((scenario) => scenario.id);
  assert.deepEqual(contractGaps, ["investment_agent_workflow_auth_portfolio_research"], "only the cross-page external workflow may remain outside the bounded browser DSL");
  const genericCapabilities = new Map(
    scenarios
      .filter((scenario) => scenario.genericTemplate)
      .map((scenario) => [scenario.id, scenario.capabilityKind])
  );
  assert.deepEqual(
    Array.from(genericCapabilities.keys()).sort(),
    [
      "generic_approval_flow_transition",
      "generic_api_failure",
      "generic_complex_form_validation",
      "generic_file_upload_validation",
      "generic_openapi_schema_contract",
      "generic_role_permission_matrix",
      "generic_table_sort_filter_pagination",
      "generic_visual_regression_basic"
    ].sort()
  );
  assert.equal(genericCapabilities.get("generic_table_sort_filter_pagination"), "table");
  assert.equal(genericCapabilities.get("generic_complex_form_validation"), "complex_form");
  assert.equal(genericCapabilities.get("generic_file_upload_validation"), "file_upload");
  assert.equal(genericCapabilities.get("generic_approval_flow_transition"), "approval_flow");
  assert.equal(genericCapabilities.get("generic_openapi_schema_contract"), "openapi_contract");
  assert.equal(genericCapabilities.get("generic_role_permission_matrix"), "role_permission_matrix");
  assert.equal(genericCapabilities.get("generic_api_failure"), "network_failure");
  assert.equal(genericCapabilities.get("generic_visual_regression_basic"), "visual_regression");
  assert.throws(() => getScenario("unknown_scenario_id"), /Unknown scenarioId/);
  assert.equal(
    matchScenariosForContext({
      requirement: "需要覆盖接口失败和 network failure 的失败定位",
      diff: "/api/tasks returns 503",
      bugTicket: "后端错误"
    })[0]?.scenario.id,
    "task_api_failure"
  );
  assert.equal(
    matchScenariosForContext({
      projectId: "order_portal_lite",
      requirement: "Pending filter only shows pending orders",
      diff: "return api.get('/api/orders?status=pending');"
    })[0]?.scenario.id,
    "order_filter_pending"
  );
  assert.equal(
    matchScenariosForContext({
      projectId: "todo_lite",
      requirement: "Unauthenticated visitors must see login required",
      diff: "if (!session.user) return permissionState('login_required');"
    })[0]?.scenario.id,
    "todo_visitor_permission"
  );
}
