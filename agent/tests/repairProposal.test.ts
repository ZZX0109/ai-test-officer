import assert from "node:assert/strict";
import { buildRepairProposals } from "../src/repairProposal.js";

export function testRepairProposals() {
  const proposals = buildRepairProposals({
    assertions: [{ name: "locator timeout", passed: false, expected: "visible", actual: "locator timeout", fact: { kind: "element.visible", target: "button", operator: "exists", expected: "visible", actual: "timeout", severity: "medium", evidenceRefs: ["ev-1"], failureClass: "test_script_issue" } }, { name: "runtime unavailable", passed: false, expected: "healthy", actual: "health timeout", fact: { kind: "environment.error", target: "health", operator: "exists", expected: "healthy", actual: "timeout", severity: "high", evidenceRefs: ["ev-2"], failureClass: "environment_issue" } }],
    steps: [], evidence: [{ id: "ev-1", runId: "run", type: "assertion", title: "locator", timestamp: new Date().toISOString(), payload: {} }], failureAttributions: []
  });
  assert.ok(proposals.some((proposal) => proposal.kind === "selector_recovery"));
  assert.ok(proposals.some((proposal) => proposal.kind === "wait_strategy_adjustment"));
  assert.ok(proposals.some((proposal) => proposal.kind === "evidence_completion"));
  const environment = proposals.find((proposal) => proposal.kind === "environment_diagnosis");
  assert.equal(environment?.outcome, "blocked");
  assert.ok(environment?.safeguards.some((guard) => guard.includes("不能把产品 verdict 变为 pass")));
}
