import assert from "node:assert/strict";
import { classifyRetry } from "../src/retryPolicy.js";

export function testRetryPolicy() {
  const product = classifyRetry({ attempt: 1, maxAttempts: 2, assertions: [{ name: "amount", passed: false, expected: "100", actual: "99", fact: { kind: "state.equals", target: "amount", operator: "equals", expected: "100", actual: "99", severity: "high", evidenceRefs: [], failureClass: "product_bug" } }] });
  assert.equal(product.retryable, false);
  const selector = classifyRetry({ attempt: 1, maxAttempts: 2, assertions: [{ name: "locator timeout", passed: false, expected: "visible", actual: "locator timeout", fact: { kind: "element.visible", target: "button", operator: "exists", expected: "visible", actual: "timeout", severity: "medium", evidenceRefs: [], failureClass: "test_script_issue" } }] });
  assert.equal(selector.retryable, true);
  assert.equal(classifyRetry({ attempt: 2, maxAttempts: 2, assertions: selector.retryable ? [{ name: "timeout", passed: false, expected: "ok", actual: "timeout" }] : [] }).retryable, false);
}
