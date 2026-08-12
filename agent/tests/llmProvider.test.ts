import assert from "node:assert/strict";
import { executeLlmCall, parseResponsesStream } from "../src/llmProvider.js";
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
