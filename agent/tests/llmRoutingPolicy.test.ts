import assert from "node:assert/strict";
import { routeJudge, routePlanner } from "../src/llmRoutingPolicy.js";

export function testLlmRoutingPolicy() {
  const intake = {
    scenarioCandidates: [{ id: "one", title: "one", source: "requirement", riskLevel: "low", reason: "match", executable: true, mappedScenarioId: "task_create_success", requiredCapabilities: [] }],
    changedAreas: [], risks: [], sources: [], recommendedTrigger: "commit", id: "i", createdAt: new Date().toISOString()
  } as never;
  const highConfidence = { recommendedScenarios: [{ scenarioId: "task_create_success", score: 80, confidence: "high" }, { scenarioId: "other", score: 50, confidence: "medium" }], uncoveredRisks: [] } as never;
  assert.equal(routePlanner({ requirement: "create a task with a valid title", intake, impactAnalysis: highConfidence }).route, "deterministic");
  assert.equal(routePlanner({ requirement: "create something appropriate", intake, impactAnalysis: highConfidence }).route, "llm");
  assert.equal(routePlanner({ requirement: "x", intake, impactAnalysis: { ...highConfidence, recommendedScenarios: [{ scenarioId: "a", score: 60, confidence: "high" }, { scenarioId: "b", score: 55, confidence: "high" }] } as never }).route, "llm");

  const judge = { planJudge: { verdict: "pass" }, evidenceJudge: { verdict: "pass" }, releaseJudge: { verdict: "pass" } } as never;
  assert.equal(routeJudge({ baseline: judge, conflictStatus: "not_triggered", failedAssertionCount: 0, insufficientEvidenceCount: 0 }).route, "deterministic");
  assert.equal(routeJudge({ baseline: judge, conflictStatus: "needs_user_review", failedAssertionCount: 0, insufficientEvidenceCount: 0 }).route, "llm");
}
