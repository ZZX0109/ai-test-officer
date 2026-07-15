import { runVisualGrayTest } from "../src/testRunner.js";

const result = await runVisualGrayTest({
  appUrl: process.env.COMPILED_PLAN_SMOKE_URL ?? "http://127.0.0.1:6173",
  scenarioId: "task_filter_completed",
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  },
  compiledPlan: {
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
  }
});

if (result.assertions.some((assertion) => !assertion.passed)) {
  throw new Error(`compiled_plan_smoke_assertion_failed:${result.id}`);
}
const executed = result.steps.map((step) => step.stepId);
for (const stepId of ["open", "click", "query", "dom", "regression"]) {
  if (!executed.includes(stepId)) throw new Error(`compiled_plan_smoke_step_missing:${stepId}`);
}
if (!result.artifactsV2?.some((artifact) => artifact.kind === "trace")) {
  throw new Error("compiled_plan_smoke_trace_missing");
}
if (result.artifactsV2.some((artifact) => !artifact.stepId)) {
  throw new Error("compiled_plan_smoke_artifact_step_link_missing");
}
if (!result.riskCoverageMatrix.find((item) => item.riskId === "risk_smoke")?.passed) {
  throw new Error("compiled_plan_smoke_risk_not_covered");
}
if (!result.riskCoverageMatrix.find((item) => item.riskId === "risk_regression")?.passed) {
  throw new Error("compiled_plan_regression_risk_not_covered");
}
console.log(JSON.stringify({ runId: result.id, finalStatus: result.finalStatus, executed, artifactKinds: result.artifactsV2.map((artifact) => artifact.kind) }, null, 2));
