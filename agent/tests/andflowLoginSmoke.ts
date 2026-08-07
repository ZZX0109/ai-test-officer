import { runVisualGrayTest } from "../src/testRunner.js";

const result = await runVisualGrayTest({
  projectId: "andflow_current",
  scenarioId: "discovered_andflow_current_form_validation",
  permissionProfile: {
    observe: true,
    browserControl: true,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  },
  keepProjectRunning: true
});

console.log(JSON.stringify({
  finalStatus: result.finalStatus,
  runtimeStatus: result.runtimeStatus,
  steps: result.steps.map((step) => ({ id: step.id, status: step.status, error: step.error })),
  assertions: result.assertions.map((assertion) => ({ name: assertion.name, passed: assertion.passed, actual: assertion.actual })),
  artifactCount: result.artifactsV2?.length ?? 0,
  evidenceCount: result.evidence?.length ?? 0
}, null, 2));
