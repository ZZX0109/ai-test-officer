import assert from "node:assert/strict";
import { generatePlan } from "../src/llmPlanner.js";

export async function testLlmPlannerFailClosed() {
  await assert.rejects(() => generatePlan({ requirement: "test", diff: "", credentialId: "credential-that-does-not-exist", requireLlm: true }), /llm_not_configured/);
}
