import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ToolGateway } from "../src/tool-gateway/toolGateway.js";
import { executeLlmCallWithTools } from "../src/llmToolCalling.js";
import type { CredentialRecord } from "../src/types.js";

export async function testToolGatewayUnifiedContracts() {
  const gateway = new ToolGateway({
    getProjectContextRaw: async () => ({}), getRunStatusRaw: async () => ({}), getEvidenceRaw: async () => ({}),
    getFailureHistoryRaw: async () => ({}), getRepairHistoryRaw: async () => ({}), queryProjectMemoryRaw: async () => [],
    queryExperienceMemoryRaw: async () => [], getSchemaVersionsRaw: async () => ({ contracts: "1.0" })
  });
  const capabilities = new Set(gateway.getRegistry().listTools().map((item) => item.capability));
  for (const capability of ["browser.observe", "browser.act", "api.request", "test.run", "assert.evaluate", "fixture.seed", "fixture.reset", "visual.compare", "artifact.read", "evidence.collect", "propose_write_action", "check_schema_version"]) {
    assert.equal(capabilities.has(capability as never), true, `registered model tool: ${capability}`);
  }
  const assertion = await gateway.execute({ callId: "assert-1", capability: "assert.evaluate", runId: "run-tool", toolVersion: "1.0.0", params: { actual: "hello world", expected: "world", operator: "contains" } });
  assert.equal(assertion.success, true);
  assert.equal(assertion.status, "completed");
  const denied = await gateway.execute({ callId: "assert-2", capability: "assert.evaluate", runId: "run-tool", toolVersion: "1.0.0", params: { actual: "x", expected: "y", operator: "equals" } });
  assert.equal(denied.success, true);
  assert.equal(denied.status, "failed");
  const needsApproval = await gateway.execute({ callId: "browser-act-1", capability: "browser.act", runId: "run-tool", toolVersion: "1.0.0", params: { runId: "run-tool", action: {} } });
  assert.equal(needsApproval.success, false);
  assert.equal(needsApproval.status, "needs-confirmation");
  const crossRun = await gateway.execute({ callId: "observe-1", capability: "browser.observe", runId: "run-tool", toolVersion: "1.0.0", params: { runId: "other-run" } });
  assert.equal(crossRun.errorCode, "tool_scope_violation");

  let writes = 0;
  const controlledGateway = new ToolGateway({
    getProjectContextRaw: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return {}; },
    getRunStatusRaw: async () => ({}), getEvidenceRaw: async () => ({}),
    getFailureHistoryRaw: async () => ({}), getRepairHistoryRaw: async () => ({}), queryProjectMemoryRaw: async () => [],
    queryExperienceMemoryRaw: async () => [], getSchemaVersionsRaw: async () => ({ contracts: "1.0" }),
    proposeWriteActionRaw: async () => { writes += 1; return { status: "completed" }; }
  });
  const timedOut = await controlledGateway.execute({ callId: "timeout-1", capability: "get_project_context", runId: "run-tool", toolVersion: "1.0.0", timeoutMs: 5, params: { projectId: "project" } });
  assert.equal(timedOut.errorCode, "tool_timeout");
  const controller = new AbortController();
  const cancelledPromise = controlledGateway.execute({ callId: "cancel-1", capability: "get_project_context", runId: "run-tool", toolVersion: "1.0.0", signal: controller.signal, params: { projectId: "project" } });
  controller.abort();
  assert.equal((await cancelledPromise).errorCode, "tool_cancelled");
  const firstWrite = await controlledGateway.execute({ callId: "write-1", capability: "propose_write_action", runId: "run-tool", toolVersion: "1.0.0", idempotencyKey: "write-idempotency", params: { runId: "run-tool", action: "safe", reason: "test" } });
  const replayWrite = await controlledGateway.execute({ callId: "write-2", capability: "propose_write_action", runId: "run-tool", toolVersion: "1.0.0", idempotencyKey: "write-idempotency", params: { runId: "run-tool", action: "safe", reason: "test" } });
  assert.equal(firstWrite.success, true);
  assert.equal(replayWrite.cacheHit, true);
  assert.equal(writes, 1);
}

export async function testNativeToolCallingLoop() {
  const originalFetch = globalThis.fetch;
  const nativeToolRunId = `native-tool-run-${randomUUID()}`;
  const nativeBrowserRunId = `native-browser-run-${randomUUID()}`;
  const gateway = new ToolGateway({
    getProjectContextRaw: async () => ({}), getRunStatusRaw: async () => ({}), getEvidenceRaw: async () => ({}),
    getFailureHistoryRaw: async () => ({}), getRepairHistoryRaw: async () => ({}), queryProjectMemoryRaw: async () => [],
    queryExperienceMemoryRaw: async () => [], getSchemaVersionsRaw: async () => ({ contracts: "1.0" })
  });
  // Install the test gateway as the process-wide execution authority.
  const { getToolGateway } = await import("../src/tool-gateway/toolGateway.js");
  getToolGateway({
    getProjectContextRaw: async () => ({}), getRunStatusRaw: async () => ({}), getEvidenceRaw: async () => ({}),
    getFailureHistoryRaw: async () => ({}), getRepairHistoryRaw: async () => ({}), queryProjectMemoryRaw: async () => [],
    queryExperienceMemoryRaw: async () => [], getSchemaVersionsRaw: async () => ({ contracts: "1.0" }),
    observePageRaw: async () => ({ status: "completed", url: "https://test.local", title: "Observed" })
  });
  const credential = {
    id: "native-tool-credential", name: "native", provider: "openai", baseUrl: "https://provider.invalid/v1",
    model: "gpt-tool-test", apiKeyEncrypted: "unused", tags: [], isDefault: false, createdAt: new Date().toISOString()
  } as CredentialRecord;
  let requestCount = 0;
  globalThis.fetch = (async (_url, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(Array.isArray(body.tools), true);
    if (requestCount === 1) return new Response(JSON.stringify({ id: "chat-tool-1", model: "gpt-tool-test", choices: [{ message: { content: null, tool_calls: [{ id: "call-assert", type: "function", function: { name: "assert.evaluate", arguments: JSON.stringify({ actual: "hello", expected: "hello", operator: "equals" }) } }] }, finish_reason: "tool_calls" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages.some((message) => message.role === "tool"), true);
    return new Response(JSON.stringify({ id: "chat-tool-2", model: "gpt-tool-test", choices: [{ message: { content: JSON.stringify({ ok: true }), tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await executeLlmCallWithTools({
      credential, apiKey: "test-only", prompt: "validate hello", system: "use tools", maxTokens: 128,
      transportPreference: "non-stream", tools: [{ name: "assert.evaluate", inputSchema: { type: "object", properties: { actual: {}, expected: {}, operator: { type: "string" } }, required: ["actual", "operator"], additionalProperties: false } }],
      context: { purpose: "assistant", runId: nativeToolRunId, experimentId: "native-tool-test" }
    });
    assert.equal(result.text.includes("ok"), true);
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0]?.success, true);
    assert.equal(result.rounds, 1);
    assert.equal(requestCount, 2);

    // The same provider-neutral loop can dispatch a browser observation; the
    // model never receives a browser object and the gateway owns execution.
    requestCount = 0;
    globalThis.fetch = (async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (requestCount === 1) return new Response(JSON.stringify({ id: "browser-tool-1", model: "gpt-tool-test", choices: [{ message: { content: null, tool_calls: [{ id: "call-observe", type: "function", function: { name: "browser.observe", arguments: JSON.stringify({ runId: nativeBrowserRunId }) } }] }, finish_reason: "tool_calls" }] }), { status: 200, headers: { "content-type": "application/json" } });
      const messages = body.messages as Array<Record<string, unknown>>;
      assert.equal(messages.some((message) => message.role === "tool" && String(message.content).includes("Observed")), true);
      return new Response(JSON.stringify({ id: "browser-tool-2", model: "gpt-tool-test", choices: [{ message: { content: "observation accepted", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const browserObservation = await executeLlmCallWithTools({
      credential, apiKey: "test-only", prompt: "observe the page", system: "use browser tools", maxTokens: 128,
      transportPreference: "non-stream", tools: [{ name: "browser.observe", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false } }],
      context: { purpose: "browser-action", runId: nativeBrowserRunId, experimentId: "native-browser-tool-test" }
    });
    assert.equal(browserObservation.toolResults[0]?.success, true);
    assert.equal(browserObservation.text, "observation accepted");
    assert.equal(requestCount, 2);

    requestCount = 0;
    globalThis.fetch = (async () => {
      requestCount += 1;
      return new Response(JSON.stringify({ id: "write-tool-1", model: "gpt-tool-test", choices: [{ message: { content: null, tool_calls: [{ id: "call-write", type: "function", function: { name: "browser.act", arguments: JSON.stringify({ runId: nativeBrowserRunId, action: {} }) } }] }, finish_reason: "tool_calls" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const blockedWrite = await executeLlmCallWithTools({
      credential, apiKey: "test-only", prompt: "click the page", system: "write tools require approval", maxTokens: 128,
      transportPreference: "non-stream", tools: [{ name: "browser.act", inputSchema: { type: "object", properties: { runId: { type: "string" }, action: { type: "object" } }, required: ["runId", "action"], additionalProperties: false } }],
      context: { purpose: "browser-action", runId: nativeBrowserRunId, experimentId: "native-write-tool-test" }
    });
    assert.equal(blockedWrite.blocked, true);
    assert.equal(blockedWrite.toolResults[0]?.status, "needs-confirmation");
    assert.equal(requestCount, 1, "approval interrupt stops the tool loop before a second model turn");
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all([
      rm(path.resolve(process.cwd(), "..", "reports", "llm-budgets", `${nativeToolRunId}.json`), { force: true }),
      rm(path.resolve(process.cwd(), "..", "reports", "llm-budgets", `${nativeBrowserRunId}.json`), { force: true })
    ]);
  }
}
