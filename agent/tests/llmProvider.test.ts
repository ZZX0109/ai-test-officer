import assert from "node:assert/strict";
import { executeLlmCall, parseResponsesStream } from "../src/llmProvider.js";
import { parseLlmStream } from "../src/llmTransport.js";
import type { CredentialRecord } from "../src/types.js";

function stream(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "req-test" }
  });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-json" }
  });
}

function trackedReaderStream(events: unknown[]) {
  const chunks = events.map((event) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  let index = 0;
  let cancelCalls = 0;
  const response = {
    body: {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined },
        cancel: async () => {
          cancelCalls += 1;
        }
      })
    }
  } as unknown as Response;
  return { response, cancelCalls: () => cancelCalls };
}

const completedEvents = [
  { type: "response.output_text.delta", delta: '{"ok":true}' },
  { type: "response.completed", response: { id: "response-1", model: "gpt-5.1-codex", usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } }
];

export async function testLlmProviderResponsesTransport() {
  const parsed = await parseResponsesStream(stream(completedEvents));
  assert.equal(parsed.data.output_text, '{"ok":true}');
  assert.deepEqual(parsed.telemetry.eventTypes, ["response.output_text.delta", "response.completed"]);
  await assert.rejects(() => parseResponsesStream(stream([{ type: "response.failed", response: { error: { code: "upstream" } } }])), /provider_responses_failed/);
  await assert.rejects(() => parseResponsesStream(stream([{ type: "response.output_text.delta", delta: "{" }])), /provider_responses_incomplete/);
  await assert.rejects(
    () => parseResponsesStream(stream([{
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
    }])),
    /provider_responses_output_truncated/
  );
  await assert.rejects(
    () => parseResponsesStream(stream([{
      type: "response.incomplete",
      response: { status: "incomplete", incomplete_details: { reason: "content_filter" } }
    }])),
    /provider_responses_incomplete:content_filter/
  );
  await assert.rejects(
    () => parseResponsesStream(stream([{
      type: "response.failed",
      response: { status: "failed", error: { code: "rate_limit_exceeded" } }
    }])),
    /provider_responses_failed:rate_limit_exceeded/
  );

  const completedReader = trackedReaderStream(completedEvents);
  await parseResponsesStream(completedReader.response);
  assert.equal(completedReader.cancelCalls(), 1);
  const failedReader = trackedReaderStream([{
    type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
  }]);
  await assert.rejects(
    () => parseResponsesStream(failedReader.response),
    /provider_responses_output_truncated/
  );
  assert.equal(failedReader.cancelCalls(), 1);

  const credential = {
    id: "credential-test", name: "test", provider: "openai-compatible", baseUrl: "https://provider.invalid/v1",
    model: "gpt-5.1-codex", apiKeyEncrypted: "unused", tags: [], isDefault: false, createdAt: new Date().toISOString()
  } as CredentialRecord;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests < 3 ? stream([{ type: "response.output_text.delta", delta: "{" }]) : jsonResponse({ id: "response-fallback", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } });
  }) as typeof fetch;
  try {
    const result = await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, context: { purpose: "judging", experimentId: "provider-unit-test" } });
    assert.equal(result.call.status, "passed");
    assert.deepEqual(result.call.transportAttempts?.map((item) => item.status), ["failed", "failed", "passed"]);
    assert.deepEqual(result.call.transportAttempts?.map((item) => item.mode), ["stream", "stream", "non-stream"]);
    assert.equal(result.call.transportMode, "non-stream-fallback");
    assert.equal(result.call.fallbackReason, "stream_incomplete");
    assert.equal(requests, 3);

    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return stream([{ type: "response.output_item.done" }]);
      if (requests === 2) throw new Error("The_operation_was_aborted_due_to_timeout");
      return jsonResponse({ id: "response-timeout-fallback", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } });
    }) as typeof fetch;
    const timeoutFallback = await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, context: { purpose: "judging", experimentId: "provider-unit-test" } });
    assert.equal(timeoutFallback.call.status, "passed");
    assert.deepEqual(timeoutFallback.call.transportAttempts?.map((item) => item.mode), ["stream", "stream", "non-stream"]);
    assert.equal(requests, 3);

    requests = 0;
    globalThis.fetch = (async () => { requests += 1; return jsonResponse({ id: "response-direct", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }); }) as typeof fetch;
    const direct = await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, transportPreference: "non-stream", context: { purpose: "planning", experimentId: "provider-unit-test" } });
    assert.equal(direct.call.transportMode, "non-stream");
    assert.deepEqual(direct.call.transportAttempts?.map((item) => item.mode), ["non-stream"]);
    assert.equal(requests, 1);

    // A successful call bound to a Run must stay successful after lifecycle
    // telemetry is emitted. This catches regressions where a retry-only event
    // references variables that exist only in the failure branch and turns a
    // real browser-action call into a false provider failure.
    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return jsonResponse({ id: "response-run-bound", model: "gpt-5.1-codex", output_text: '{"status":"act"}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    }) as typeof fetch;
    const runBound = await executeLlmCall({
      credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000,
      transportPreference: "non-stream", context: { purpose: "browser-action", runId: `run-bound-${Date.now()}`, experimentId: "provider-unit-test" }
    });
    assert.equal(runBound.call.status, "passed");
    assert.equal(requests, 1);

    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) throw new Error("The_operation_was_aborted_due_to_timeout");
      return jsonResponse({ id: "response-non-stream-retry", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    }) as typeof fetch;
    const nonStreamRetry = await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, transportPreference: "non-stream-retry", context: { purpose: "judging", experimentId: "provider-unit-test" } });
    assert.equal(nonStreamRetry.call.status, "passed");
    assert.deepEqual(nonStreamRetry.call.transportAttempts?.map((item) => item.mode), ["non-stream", "non-stream"]);
    assert.equal(requests, 2);

    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return jsonResponse({
        id: "response-truncated",
        model: "gpt-5.1-codex",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "{\"reply\":",
        usage: { input_tokens: 2, output_tokens: 64, total_tokens: 66 }
      });
    }) as typeof fetch;
    await assert.rejects(
      () => executeLlmCall({
        credential,
        apiKey: "test-only",
        prompt: "{}",
        system: "json",
        maxTokens: 64,
        timeoutMs: 2_000,
        totalTimeoutMs: 8_000,
        transportPreference: "non-stream",
        context: { purpose: "assistant", experimentId: "provider-unit-test" }
      }),
      /provider_responses_output_truncated/
    );
    assert.equal(requests, 1);

    requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) return jsonResponse({ error: "busy" }, 503);
      return jsonResponse({ id: "response-503-retry", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    }) as typeof fetch;
    const serviceRetry = await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, transportPreference: "non-stream-retry", context: { purpose: "judging", experimentId: "provider-unit-test" } });
    assert.equal(serviceRetry.call.status, "passed");
    assert.deepEqual(serviceRetry.call.transportAttempts?.map((item) => item.errorCode ?? item.status), ["provider_http_503", "passed"]);
    assert.equal(requests, 2);

    let structuredRequest: Record<string, any> | undefined;
    globalThis.fetch = (async (_url, init) => {
      structuredRequest = JSON.parse(String(init?.body));
      return jsonResponse({ id: "response-schema", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    }) as typeof fetch;
    await executeLlmCall({
      credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000,
      transportPreference: "non-stream", jsonSchema: { name: "test_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      context: { purpose: "judging", experimentId: "provider-unit-test" }
    });
    assert.equal(structuredRequest?.text?.format?.type, "json_schema");
    assert.equal(structuredRequest?.text?.format?.name, "test_schema");

    const sophNetCredential = {
      ...credential,
      id: "credential-sophnet",
      baseUrl: "https://api.sophnet.com/v1"
    } as CredentialRecord;
    globalThis.fetch = (async (_url, init) => {
      structuredRequest = JSON.parse(String(init?.body));
      return jsonResponse({ id: "response-sophnet", model: "gpt-5.1-codex", output_text: '{"ok":true}', usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
    }) as typeof fetch;
    await executeLlmCall({
      credential: sophNetCredential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000,
      transportPreference: "non-stream", jsonSchema: { name: "test_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      context: { purpose: "assistant", experimentId: "provider-unit-test" }
    });
    assert.equal(structuredRequest?.text?.format?.type, "json_object");
    assert.equal(structuredRequest?.text?.format?.name, undefined);

    requests = 0;
    globalThis.fetch = (async () => { requests += 1; return stream([{ type: "response.output_text.delta", delta: "{" }]); }) as typeof fetch;
    await assert.rejects(async () => {
      try {
        await executeLlmCall({ credential, apiKey: "test-only", prompt: "{}", system: "json", maxTokens: 64, timeoutMs: 2_000, totalTimeoutMs: 8_000, context: { purpose: "judging", experimentId: "provider-unit-test" } });
      } catch (error) {
        const call = error && typeof error === "object" && "llmCall" in error ? (error as any).llmCall : undefined;
        assert.equal(call?.transportAttempts?.length, 3);
        throw error;
      }
    }, /provider_responses_invalid_json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function testLlmProviderChatAndAnthropicStreaming() {
  const originalFetch = globalThis.fetch;
  const credential = {
    id: "credential-chat-stream", name: "chat", provider: "openai", baseUrl: "https://provider.invalid/v1",
    model: "gpt-test", apiKeyEncrypted: "unused", tags: [], isDefault: false, createdAt: new Date().toISOString()
  } as CredentialRecord;
  const events = [
    { id: "chat-1", choices: [{ delta: { content: "你" }, finish_reason: null }] },
    { id: "chat-1", choices: [{ delta: { content: "好" }, finish_reason: null }] },
    { id: "chat-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
  ];
  let requestBody: Record<string, unknown> | undefined;
  const emitted: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return stream([...events, "[DONE]"]);
  }) as typeof fetch;
  try {
    const result = await executeLlmCall({
      credential, apiKey: "test-only", prompt: "say hi", system: "respond", maxTokens: 64,
      transportPreference: "stream", onStreamEvent: (event) => { if (event.type === "text_delta") emitted.push(event.text); },
      context: { purpose: "assistant", experimentId: "chat-stream-test" }
    });
    assert.equal(requestBody?.stream, true);
    assert.deepEqual(requestBody?.stream_options, { include_usage: true });
    assert.equal(result.text, "你好");
    assert.deepEqual(emitted, ["你", "好"]);
    assert.equal(result.call.usage.totalTokens, 5);

    // `auto` is the production default: ordinary Chat Completions must start
    // as SSE and only fall back when the provider rejects/incompletes it.
    requestBody = undefined;
    const defaultStream = await executeLlmCall({
      credential, apiKey: "test-only", prompt: "say hi", system: "respond", maxTokens: 64,
      context: { purpose: "assistant", experimentId: "chat-stream-default-test" }
    });
    assert.equal(requestBody?.stream, true);
    assert.equal(defaultStream.text, "你好");

    // Stream and non-stream transports must expose the same normalized final
    // result, including native tool calls. This is the contract the caller
    // consumes; provider framing is an implementation detail.
    const consistencyStream = [
      { id: "same-result", choices: [{ delta: { content: "ok", tool_calls: [{ index: 0, id: "same-call", function: { name: "assert.evaluate", arguments: '{"actual":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "true}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }
    ];
    const consistencyJson = {
      id: "same-result", model: "gpt-test",
      choices: [{ message: { content: "ok", tool_calls: [{ id: "same-call", type: "function", function: { name: "assert.evaluate", arguments: '{"actual":true}' } }] } }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
    };
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.stream ? stream([...consistencyStream, "[DONE]"]) : jsonResponse(consistencyJson);
    }) as typeof fetch;
    const streamedFinal = await executeLlmCall({
      credential, apiKey: "test-only", prompt: "call a tool", system: "respond", maxTokens: 64,
      transportPreference: "stream", tools: [{ name: "assert.evaluate", inputSchema: { type: "object" } }],
      context: { purpose: "assistant", experimentId: "stream-final-consistency" }
    });
    const nonStreamFinal = await executeLlmCall({
      credential, apiKey: "test-only", prompt: "call a tool", system: "respond", maxTokens: 64,
      transportPreference: "non-stream", tools: [{ name: "assert.evaluate", inputSchema: { type: "object" } }],
      context: { purpose: "assistant", experimentId: "non-stream-final-consistency" }
    });
    assert.deepEqual(
      { text: streamedFinal.text, toolCalls: streamedFinal.toolCalls },
      { text: nonStreamFinal.text, toolCalls: nonStreamFinal.toolCalls }
    );

    const chatToolEvents = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "assert.evaluate", arguments: '{"actual":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1,"operator":"truthy"}' } }] } }] }
    ];
    const parsedChatTools = await parseLlmStream(stream([...chatToolEvents, "[DONE]"]), "chat-completions");
    assert.equal(parsedChatTools.toolCalls[0]?.name, "assert.evaluate");
    assert.equal(parsedChatTools.toolCalls[0]?.arguments, '{"actual":1,"operator":"truthy"}');

    const anthropicEvents = [
      { type: "message_start", message: { id: "msg-1", model: "claude-test" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 2, output_tokens: 1 } },
      { type: "message_stop" }
    ];
    const parsed = await parseLlmStream(stream(anthropicEvents), "anthropic");
    assert.equal(parsed.text, "hello");
    assert.equal(parsed.usage?.totalTokens, 3);
    const parsedAnthropicTool = await parseLlmStream(stream([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "anthropic-call", name: "assert.evaluate", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"actual":true}' } },
      { type: "message_stop" }
    ]), "anthropic");
    assert.equal(parsedAnthropicTool.toolCalls[0]?.callId, "anthropic-call");
    const parsedResponsesTool = await parseLlmStream(stream([
      { type: "response.output_item.added", item: { type: "function_call", id: "resp-item", call_id: "resp-call", name: "assert.evaluate", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "resp-item", delta: '{"actual":true}' },
      { type: "response.completed", response: { id: "resp-1", model: "gpt-codex", status: "completed" } }
    ]), "responses");
    assert.equal(parsedResponsesTool.toolCalls[0]?.callId, "resp-call");
    assert.equal(parsedResponsesTool.toolCalls[0]?.arguments, '{"actual":true}');
    const parsedResponsesDoneTool = await parseLlmStream(stream([
      { type: "response.output_item.done", item: { type: "function_call", id: "resp-done-item", call_id: "resp-done-call", name: "assert.evaluate", arguments: '{"actual":true}' } },
      { type: "response.completed", response: { id: "resp-done", model: "gpt-codex", status: "completed" } }
    ]), "responses");
    assert.equal(parsedResponsesDoneTool.toolCalls[0]?.callId, "resp-done-call");
    assert.equal(parsedResponsesDoneTool.toolCalls[0]?.arguments, '{"actual":true}');

    const cancellation = new AbortController();
    let cancellationRequests = 0;
    globalThis.fetch = (async (_url, init) => {
      cancellationRequests += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
      });
    }) as typeof fetch;
    const pendingCancellation = executeLlmCall({
      credential, apiKey: "test-only", prompt: "cancel", system: "respond", maxTokens: 64,
      signal: cancellation.signal, context: { purpose: "assistant", experimentId: "llm-cancellation" }
    });
    setTimeout(() => cancellation.abort(), 5);
    await assert.rejects(pendingCancellation, /llm_cancelled/);
    assert.equal(cancellationRequests, 1, "caller cancellation must not trigger provider retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
