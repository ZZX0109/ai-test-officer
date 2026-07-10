import assert from "node:assert/strict";
import { buildExecutablePlan, assertExecutablePlan } from "../src/executablePlan.js";
import { buildImpactAnalysis } from "../src/impactAnalysis.js";
import { buildScenarioGrayPlan } from "../src/plan.js";
import { getScenario } from "../src/scenarios.js";
import type { ConnectorContext, ExecutableTestPlan, GrayPlan } from "../src/types.js";

function clonePlan(plan: ExecutableTestPlan): ExecutableTestPlan {
  return JSON.parse(JSON.stringify(plan)) as ExecutableTestPlan;
}

export function testPlanStepSchema() {
  const source = {
    id: "source_test_diff",
    kind: "git_diff" as const,
    title: "Test diff",
    status: "connected" as const,
    summary: "TaskFilter and /api/tasks changed",
    permissionState: "not_required" as const,
    isSimulated: false,
    readAt: new Date().toISOString(),
    trustLevel: "high" as const
  };
  const context: ConnectorContext = {
    requirement: "登录、接口失败和任务列表筛选都要验收",
    diff: "diff --git a/app-under-test/src/main.tsx b/app-under-test/src/main.tsx\n+ /api/tasks status=error",
    bugTicket: "接口失败需要明确归因",
    sourceContexts: [source],
    sources: [{ kind: "git_diff", title: "Test diff", status: "connected", summary: source.summary }]
  };
  const impact = buildImpactAnalysis(context);
  assert.ok(impact.affectedApis.some((item) => item.target === "/api/tasks"));
  const plan = buildExecutablePlan({
    plan: buildScenarioGrayPlan(getScenario("task_api_failure")),
    selectedScenarioId: "task_api_failure",
    impactAnalysis: impact,
    source: "scenario_registry"
  });
  assertExecutablePlan(plan);
  assert.equal(plan.steps[0].scenarioId, "task_api_failure");
  assert.ok(plan.steps[0].evidenceRequirements.includes("network"));

  const missingOracle = clonePlan(plan);
  missingOracle.steps[0].assertions = missingOracle.steps[0].assertions.slice(0, 1);
  assert.throws(
    () => assertExecutablePlan(missingOracle),
    /missing required scenario assertions/,
    "PlanStep cannot omit an oracle declared by the scenario registry"
  );

  const wrongSelector = clonePlan(plan);
  wrongSelector.steps[0].selectorStrategy.css = "[data-testid='wrong-error-state']";
  assert.throws(
    () => assertExecutablePlan(wrongSelector),
    /selector strategy does not match scenario/,
    "PlanStep selector strategy must stay bound to the scenario selector contract"
  );

  const weakSelectorPriority = clonePlan(plan);
  weakSelectorPriority.steps[0].selectorStrategy.priority = ["css", "role", "text", "testId"];
  assert.throws(
    () => assertExecutablePlan(weakSelectorPriority),
    /selector priority must prefer role, text, testId, then css/,
    "PlanStep selector priority must prefer user-facing locators before CSS"
  );

  const missingNetworkEvidence = clonePlan(plan);
  missingNetworkEvidence.steps[0].evidenceRequirements = missingNetworkEvidence.steps[0].evidenceRequirements.filter((kind) => kind !== "network");
  assert.throws(
    () => assertExecutablePlan(missingNetworkEvidence),
    /does not request evidence required by scenario/,
    "PlanStep with network oracle must request network evidence"
  );

  const missingScenarioAction = clonePlan(plan);
  missingScenarioAction.steps[0].browserActions = missingScenarioAction.steps[0].browserActions.slice(0, 1);
  assert.throws(
    () => assertExecutablePlan(missingScenarioAction),
    /does not include required scenario actions/,
    "PlanStep must carry the full scenario action chain"
  );

  const genericAiPlan: GrayPlan = {
    sessionName: "AI exploratory plan for customer portal table pagination",
    risks: [{
      id: "risk_table",
      level: "medium",
      title: "表格排序筛选分页组合风险",
      evidence: "需求提到 table sort filter pagination 需要验证"
    }],
    levels: [{
      id: "core_path",
      title: "Core path",
      description: "验证 table sort filter pagination",
      paths: [{
        id: "path_table",
        title: "验证客户表格分页筛选",
        riskReason: "table pagination filter 组合容易丢失查询参数",
        expectedFrom: "llm_inferred",
        steps: ["打开客户门户", "sort table", "filter table", "pagination next"],
        retry: 1
      }]
    }]
  };
  const genericPlan = buildExecutablePlan({
    plan: genericAiPlan,
    source: "llm_validated"
  });
  assertExecutablePlan(genericPlan);
  assert.equal(genericPlan.source, "plan_compiler_v2");
  assert.equal(genericPlan.steps[0].scenarioId, "generic_table_sort_filter_pagination");
  assert.equal(genericPlan.steps[0].compileSource, "generic_template");
  assert.equal(genericPlan.steps[0].humanReviewRequired, false);
  assert.equal(genericPlan.steps[0].capabilityKind, "table");

  const wrongCapability = clonePlan(genericPlan);
  wrongCapability.steps[0].capabilityKind = "complex_form";
  assert.throws(
    () => assertExecutablePlan(wrongCapability),
    /capabilityKind does not match scenario/,
    "Generic PlanStep capabilityKind must remain tied to the scenario template"
  );

  const unknownAiPlan: GrayPlan = {
    sessionName: "AI exploratory plan for unmodeled settlement ledger",
    risks: [{
      id: "risk_unmodeled",
      level: "high",
      title: "结算账本跨时区一致性风险",
      evidence: "当前 registry 没有结算账本能力模板"
    }],
    levels: [{
      id: "edge_case",
      title: "Edge case",
      description: "unmodeled settlement ledger",
      paths: [{
        id: "path_unmodeled",
        title: "验证结算账本跨时区对账",
        riskReason: "缺少 ledger harness",
        expectedFrom: "llm_inferred",
        steps: ["打开账本", "切换时区", "核对余额"],
        retry: 0
      }]
    }]
  };
  const harnessGapPlan = buildExecutablePlan({
    plan: unknownAiPlan,
    source: "llm_validated"
  });
  assert.equal(harnessGapPlan.status, "needs_harness");
  assert.equal(harnessGapPlan.steps.length, 0);
  assert.equal(harnessGapPlan.rejectedSteps[0].compileSource, "harness_gap");
  assert.equal(harnessGapPlan.rejectedSteps[0].humanReviewRequired, true);
  assert.match(harnessGapPlan.rejectedSteps[0].draftScenarioRef ?? "", /^draft_/);
}
