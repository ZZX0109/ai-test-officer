import assert from "node:assert/strict";
import type { LlmCall } from "@ai-test-officer/contracts";
import { modelExecutionEvidenceSatisfied } from "../src/graph/browserExecutionProof.js";

function call(input: { purpose: LlmCall["purpose"]; status: LlmCall["status"] }) {
  // The gate only consumes the durable purpose/status fields. Keeping this
  // fixture minimal prevents an acceptance test from duplicating provider
  // transport details that are already covered by llmProvider tests.
  return input as LlmCall;
}

/**
 * Acceptance contract for the visible official demo. A green product result
 * must be backed by an actual browser-model decision, an executed browser
 * action, and the before/after evidence artifacts collected by the broker.
 */
export function testModelDrivenDemoAcceptance() {
  assert.equal(modelExecutionEvidenceSatisfied({
    required: true,
    calls: [call({ purpose: "planning", status: "passed" })],
    completedBrowserActionCount: 1,
    requiredArtifactKindsPresent: true
  }).satisfied, false, "a planning call must not be presented as a model-driven browser test");

  assert.equal(modelExecutionEvidenceSatisfied({
    required: true,
    calls: [call({ purpose: "browser-action", status: "passed" })],
    completedBrowserActionCount: 0,
    requiredArtifactKindsPresent: true
  }).satisfied, false, "a model decision without an executed browser action must block the demo");

  assert.equal(modelExecutionEvidenceSatisfied({
    required: true,
    calls: [call({ purpose: "browser-action", status: "passed" })],
    completedBrowserActionCount: 1,
    requiredArtifactKindsPresent: false
  }).satisfied, false, "a browser action without screenshot/operation evidence must block the demo");

  const verified = modelExecutionEvidenceSatisfied({
    required: true,
    calls: [call({ purpose: "browser-action", status: "passed" })],
    completedBrowserActionCount: 1,
    requiredArtifactKindsPresent: true
  });
  assert.equal(verified.satisfied, true);
  assert.equal(verified.successfulBrowserActionCallCount, 1);
}
