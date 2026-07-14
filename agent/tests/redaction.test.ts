import assert from "node:assert/strict";
import { redactRecord, redactText } from "../src/redaction.js";

export function testRedactionPreservesUsageTelemetry() {
  const record = redactRecord({
    apiKey: "secret-key",
    accessToken: "secret-token",
    promptTokens: 101,
    completionTokens: 22,
    totalTokens: 123,
    estimatedCostUsd: 0.0123,
    credentialId: "cred_public_identifier"
  });
  assert.equal(record.apiKey, "[REDACTED]");
  assert.equal(record.accessToken, "[REDACTED]");
  assert.equal(record.promptTokens, 101);
  assert.equal(record.completionTokens, 22);
  assert.equal(record.totalTokens, 123);
  assert.equal(record.estimatedCostUsd, 0.0123);
  assert.equal(record.credentialId, "cred_public_identifier");
  assert.equal(redactText("access_token=leak promptTokens=123"), "access_token=[REDACTED] promptTokens=123");
}
