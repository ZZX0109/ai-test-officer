import type { CredentialRecord } from "./types.js";

export type LlmTransportMode = "stream" | "non-stream";

export interface LlmTransportToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface NormalizedToolCall {
  callId: string;
  name: string;
  arguments: string;
  index?: number;
}

export interface LlmConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: NormalizedToolCall[];
  toolCallId?: string;
}

export type NormalizedLlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; callId?: string; name?: string; argumentsDelta?: string; index?: number }
  | { type: "completed"; text: string; usage?: NormalizedUsage; toolCalls?: NormalizedToolCall[] };

export interface NormalizedUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface NormalizedLlmResponse {
  id?: string;
  model?: string;
  status?: "completed" | "failed" | "incomplete" | string;
  text: string;
  usage?: NormalizedUsage;
  toolCalls: NormalizedToolCall[];
  telemetry: {
    bytesReceived: number;
    eventTypes: string[];
    firstTokenAt?: string;
  };
}

export interface LlmTransportInput {
  credential: CredentialRecord;
  apiKey: string;
  prompt: string;
  system: string;
  maxTokens: number;
  temperature?: number;
  mode: LlmTransportMode;
  timeoutMs: number;
  signal?: AbortSignal;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  tools?: LlmTransportToolDefinition[];
  messages?: LlmConversationMessage[];
}

export interface LlmTransportAdapter {
  provider: string;
  kind: "chat-completions" | "responses" | "anthropic";
  supportsStreaming: boolean;
  supportsToolCalling: boolean;
  complete(input: LlmTransportInput, onEvent?: (event: NormalizedLlmStreamEvent) => void): Promise<NormalizedLlmResponse>;
  stream(input: LlmTransportInput, onEvent: (event: NormalizedLlmStreamEvent) => void): Promise<NormalizedLlmResponse>;
}

function appendEndpoint(baseUrl: string, endpoint: string) {
  return `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
}

function usageFrom(value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const promptTokens = numberFrom(data.prompt_tokens) ?? numberFrom(data.input_tokens);
  const completionTokens = numberFrom(data.completion_tokens) ?? numberFrom(data.output_tokens);
  const reasoningTokens = numberFrom(data.reasoning_tokens)
    ?? numberFrom((data.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens)
    ?? numberFrom((data.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
  const totalTokens = numberFrom(data.total_tokens)
    ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
  if ([promptTokens, completionTokens, reasoningTokens, totalTokens].every((item) => item === undefined)) return undefined;
  return { promptTokens, completionTokens, reasoningTokens, totalTokens };
}

function numberFrom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFrom(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function textFromContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => stringFrom(item.text) ?? stringFrom(item.content) ?? "")
    .join("");
}

function toolDefinitions(input: LlmTransportInput, kind: LlmTransportAdapter["kind"]) {
  if (!input.tools?.length) return undefined;
  if (kind === "anthropic") {
    return input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  }
  if (kind === "responses") {
    return input.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema }));
  }
  return input.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

function responseFormat(input: LlmTransportInput) {
  // Some OpenAI-compatible gateways reject the native schema envelope. The
  // caller still validates the response with its Zod schema after transport.
  if (/api\.sophnet\.com/i.test(input.credential.baseUrl)) return { type: "json_object" };
  return input.jsonSchema
    ? { type: "json_schema", name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema }
    : { type: "json_object" };
}

function chatResponseFormat(input: LlmTransportInput) {
  if (!input.jsonSchema) return { type: "json_object" };
  return /api\.sophnet\.com/i.test(input.credential.baseUrl)
    ? { type: "json_object" }
    : { type: "json_schema", json_schema: { name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema } };
}

function adapterKind(input: LlmTransportInput): LlmTransportAdapter["kind"] {
  if (input.credential.provider === "anthropic") return "anthropic";
  if ((input.credential.provider === "openai-compatible" || input.credential.provider === "openai") && /codex/i.test(input.credential.model)) return "responses";
  return "chat-completions";
}

function requestBody(input: LlmTransportInput, kind: LlmTransportAdapter["kind"]) {
  const conversation = input.messages?.length ? input.messages : [{ role: "user" as const, content: input.prompt }];
  if (kind === "anthropic") {
    return {
      model: input.credential.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature ?? 0,
      system: input.system,
      messages: conversation.map((message) => message.role === "tool"
        ? { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] }
        : message.role === "assistant" && message.toolCalls?.length
          ? { role: "assistant", content: [...(message.content ? [{ type: "text", text: message.content }] : []), ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.callId, name: call.name, input: safeJsonObject(call.arguments) }))] }
          : { role: message.role, content: message.content }),
      ...(input.mode === "stream" ? { stream: true } : {}),
      ...(toolDefinitions(input, kind) ? { tools: toolDefinitions(input, kind) } : {})
    };
  }
  if (kind === "responses") {
    const simpleUserPrompt = conversation.length === 1 && conversation[0]?.role === "user" && !conversation[0].toolCalls
      ? `${conversation[0].content}\nReturn a JSON object.`
      : undefined;
    return {
      model: input.credential.model,
      instructions: input.system,
      // SophNet's Responses-compatible gateway accepts the legacy plain-text
      // input form for a single user turn. Keep structured message items for
      // tool-call continuations, but use the compatible form for the normal
      // planner/judge/browser-action request.
      input: simpleUserPrompt ?? conversation.flatMap((message): unknown[] => message.role === "tool"
        ? [{ type: "function_call_output", call_id: message.toolCallId ?? "", output: message.content }]
        : message.role === "assistant" && message.toolCalls?.length
          ? message.toolCalls.map((call) => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }))
          : [{ role: message.role, content: [{ type: "input_text", text: message.content }] }]),
      max_output_tokens: input.maxTokens,
      stream: input.mode === "stream",
      text: { format: responseFormat(input) },
      ...(toolDefinitions(input, kind) ? { tools: toolDefinitions(input, kind) } : {}),
      ...(/api\.sophnet\.com/i.test(input.credential.baseUrl) ? { reasoning: { effort: "low" } } : {})
    };
  }
  return {
    model: input.credential.model,
    temperature: input.temperature ?? 0,
    max_tokens: input.maxTokens,
    messages: [{ role: "system", content: input.system }, ...conversation.map((message) => message.role === "tool"
      ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
      : message.role === "assistant" && message.toolCalls?.length
        ? { role: "assistant", content: message.content || null, tool_calls: message.toolCalls.map((call) => ({ id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments } })) }
        : { role: message.role, content: message.content })],
    ...(input.mode === "stream" ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(input.jsonSchema ? { response_format: chatResponseFormat(input) } : {}),
    ...(toolDefinitions(input, kind) ? { tools: toolDefinitions(input, kind), tool_choice: "auto" } : {})
  };
}

function safeJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function responseEndpoint(input: LlmTransportInput, kind: LlmTransportAdapter["kind"]) {
  return appendEndpoint(input.credential.baseUrl, kind === "anthropic" ? "messages" : kind === "responses" ? "responses" : "chat/completions");
}

function responseHeaders(input: LlmTransportInput, kind: LlmTransportAdapter["kind"]): Record<string, string> {
  return kind === "anthropic"
    ? { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01", accept: input.mode === "stream" ? "text/event-stream" : "application/json" }
    : { "content-type": "application/json", authorization: `Bearer ${input.apiKey}`, accept: input.mode === "stream" ? "text/event-stream" : "application/json" };
}

function requestSignal(input: LlmTransportInput) {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  if (!input.signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([input.signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason ?? new Error("llm_cancelled"));
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", () => controller.abort(timeout.reason), { once: true });
  return controller.signal;
}

function parseCompletePayload(payload: Record<string, unknown>, kind: LlmTransportAdapter["kind"]): NormalizedLlmResponse {
  if (kind === "anthropic") {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .filter((item) => item.type === "text")
      .map((item) => stringFrom(item.text) ?? "")
      .join("");
    const toolCalls = content
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && item.type === "tool_use"))
      .map((item, index) => ({ callId: stringFrom(item.id) ?? `tool_call_${index}`, name: stringFrom(item.name) ?? "", arguments: JSON.stringify(item.input ?? {}), index }));
    return { id: stringFrom(payload.id), model: stringFrom(payload.model), status: stringFrom(payload.stop_reason) === "max_tokens" ? "incomplete" : "completed", text, toolCalls, usage: usageFrom(payload.usage), telemetry: { bytesReceived: 0, eventTypes: ["json_response"] } };
  }
  if (kind === "responses") {
    const output = Array.isArray(payload.output) ? payload.output : [];
    const text = stringFrom(payload.output_text) ?? output
      .flatMap((item) => item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as unknown[] : [])
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .filter((item) => item.type === "output_text" || item.type === "text")
      .map((item) => stringFrom(item.text) ?? "")
      .join("");
    const toolCalls = output
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && (item.type === "function_call" || item.type === "tool_call")))
      .map((item, index) => ({ callId: stringFrom(item.call_id) ?? stringFrom(item.id) ?? `tool_call_${index}`, name: stringFrom(item.name) ?? "", arguments: stringFrom(item.arguments) ?? "{}", index }));
    return { id: stringFrom(payload.id), model: stringFrom(payload.model), status: stringFrom(payload.status) ?? "completed", text, toolCalls, usage: usageFrom(payload.usage), telemetry: { bytesReceived: 0, eventTypes: ["json_response"] } };
  }
  const choice = Array.isArray(payload.choices) && payload.choices[0] && typeof payload.choices[0] === "object" ? payload.choices[0] as Record<string, unknown> : undefined;
  const message = choice?.message && typeof choice.message === "object" ? choice.message as Record<string, unknown> : undefined;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item, index) => {
      const fn = item.function && typeof item.function === "object" ? item.function as Record<string, unknown> : {};
      return { callId: stringFrom(item.id) ?? `tool_call_${index}`, name: stringFrom(fn.name) ?? "", arguments: stringFrom(fn.arguments) ?? "{}", index };
    }) : [];
  return { id: stringFrom(payload.id), model: stringFrom(payload.model), status: "completed", text: textFromContent(message?.content) ?? "", toolCalls, usage: usageFrom(payload.usage), telemetry: { bytesReceived: 0, eventTypes: ["json_response"] } };
}

function sseError(kind: "responses" | "chat-completions" | "anthropic", payload: Record<string, unknown>, fallback: "failed" | "incomplete") {
  const error = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : undefined;
  const code = stringFrom(error?.code) ?? stringFrom(error?.type);
  if (fallback === "failed" || payload.status === "failed") return new Error(`provider_${kind === "responses" ? "responses_" : ""}failed${code ? `:${code.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120)}` : ""}`);
  const reason = payload.incomplete_details && typeof payload.incomplete_details === "object" ? stringFrom((payload.incomplete_details as Record<string, unknown>).reason) : undefined;
  return new Error(reason === "max_output_tokens" ? "provider_responses_output_truncated" : `provider_${kind === "responses" ? "responses_" : ""}incomplete${reason ? `:${reason.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120)}` : ""}`);
}

export async function parseLlmStream(
  response: Response,
  kind: LlmTransportAdapter["kind"],
  onEvent?: (event: NormalizedLlmStreamEvent) => void
): Promise<NormalizedLlmResponse> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(kind === "responses" ? "provider_responses_body_missing" : "provider_stream_body_missing");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesReceived = 0;
  let invalidEvents = 0;
  let text = "";
  let firstTokenAt: string | undefined;
  let completedPayload: Record<string, unknown> | undefined;
  let finished = false;
  let finishError: Error | undefined;
  let finalUsage: NormalizedUsage | undefined;
  const eventTypes = new Set<string>();
  const toolCallMap = new Map<string, NormalizedToolCall>();
  const toolIndexMap = new Map<number, string>();
  const responseItemMap = new Map<string, string>();
  const emit = (event: NormalizedLlmStreamEvent) => {
    if ((event.type === "text_delta" || event.type === "reasoning_delta") && event.text && !firstTokenAt) firstTokenAt = new Date().toISOString();
    onEvent?.(event);
  };
  const consumePayload = (raw: string) => {
    if (!raw.trim() || raw.trim() === "[DONE]") { finished = true; return; }
    let parsedPayload: unknown;
    try { parsedPayload = JSON.parse(raw) as unknown; } catch { invalidEvents += 1; return; }
    if (parsedPayload === "[DONE]") { finished = true; return; }
    if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) { invalidEvents += 1; return; }
    const payload = parsedPayload as Record<string, unknown>;
    const eventType = stringFrom(payload.type);
    if (eventType) eventTypes.add(eventType);
    if (payload.error && typeof payload.error === "object" && !payload.choices && !payload.response) {
      finishError = sseError(kind === "responses" ? "responses" : kind, payload, "failed");
      finished = true;
      return;
    }
    if (kind === "responses") {
      if (eventType === "response.output_text.delta") {
        const delta = stringFrom(payload.delta) ?? "";
        text += delta;
        emit({ type: "text_delta", text: delta });
      } else if (eventType === "response.reasoning_summary_text.delta" || eventType === "response.reasoning_text.delta") {
        const delta = stringFrom(payload.delta) ?? "";
        emit({ type: "reasoning_delta", text: delta });
      } else if (eventType === "response.function_call_arguments.delta") {
        const callId = stringFrom(payload.call_id) ?? (stringFrom(payload.item_id) ? responseItemMap.get(stringFrom(payload.item_id)!) ?? stringFrom(payload.item_id) : undefined);
        const delta = stringFrom(payload.delta) ?? "";
        const existing = callId ? toolCallMap.get(callId) : undefined;
        if (callId) toolCallMap.set(callId, { callId, name: existing?.name ?? "", arguments: `${existing?.arguments ?? ""}${delta}` });
        emit({ type: "tool_call_delta", callId, name: existing?.name, argumentsDelta: delta });
      } else if (eventType === "response.function_call_arguments.done") {
        const callId = stringFrom(payload.call_id) ?? (stringFrom(payload.item_id) ? responseItemMap.get(stringFrom(payload.item_id)!) ?? stringFrom(payload.item_id) : undefined);
        const args = stringFrom(payload.arguments) ?? "";
        if (callId) {
          const existing = toolCallMap.get(callId);
          toolCallMap.set(callId, { callId, name: existing?.name ?? "", arguments: args, index: existing?.index });
          emit({ type: "tool_call_delta", callId, name: existing?.name, argumentsDelta: args, index: existing?.index });
        }
      } else if ((eventType === "response.output_item.added" || eventType === "response.output_item.done") && payload.item && typeof payload.item === "object") {
        const item = payload.item as Record<string, unknown>;
        if (item.type === "function_call") {
          const callId = stringFrom(item.call_id) ?? stringFrom(item.id) ?? `tool_call_${toolCallMap.size}`;
          if (stringFrom(item.id)) responseItemMap.set(stringFrom(item.id)!, callId);
          const existing = toolCallMap.get(callId);
          const name = stringFrom(item.name) ?? existing?.name ?? "";
          const argumentsValue = stringFrom(item.arguments) ?? existing?.arguments ?? "";
          toolCallMap.set(callId, { callId, name, arguments: argumentsValue, index: existing?.index ?? toolCallMap.size });
          emit({ type: "tool_call_delta", callId, name, index: existing?.index ?? toolCallMap.size - 1 });
        }
      } else if (eventType === "response.completed") {
        completedPayload = payload.response && typeof payload.response === "object" ? payload.response as Record<string, unknown> : payload;
        finished = true;
      } else if (eventType === "response.failed") {
        finishError = sseError("responses", (payload.response && typeof payload.response === "object" ? payload.response as Record<string, unknown> : payload), "failed");
        finished = true;
      } else if (eventType === "response.incomplete") {
        finishError = sseError("responses", (payload.response && typeof payload.response === "object" ? payload.response as Record<string, unknown> : payload), "incomplete");
        finished = true;
      }
      return;
    }
    if (kind === "anthropic") {
      if (eventType === "content_block_delta" && payload.delta && typeof payload.delta === "object") {
        const delta = payload.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          const value = stringFrom(delta.text) ?? "";
          text += value;
          emit({ type: "text_delta", text: value });
        } else if (delta.type === "input_json_delta") {
          const value = stringFrom(delta.partial_json) ?? "";
          const index = numberFrom(payload.index) ?? 0;
          const callId = toolIndexMap.get(index) ?? `tool_call_${index}`;
          const existing = toolCallMap.get(callId);
          toolCallMap.set(callId, { callId, name: existing?.name ?? "", arguments: `${existing?.arguments ?? ""}${value}`, index });
          emit({ type: "tool_call_delta", callId, argumentsDelta: value, index });
        }
      } else if (eventType === "content_block_start" && payload.content_block && typeof payload.content_block === "object") {
        const block = payload.content_block as Record<string, unknown>;
        if (block.type === "tool_use") {
          const index = numberFrom(payload.index) ?? toolCallMap.size;
          const callId = stringFrom(block.id) ?? `tool_call_${index}`;
          toolIndexMap.set(index, callId);
          toolCallMap.set(callId, { callId, name: stringFrom(block.name) ?? "", arguments: "", index });
          emit({ type: "tool_call_delta", callId, name: stringFrom(block.name), index });
        }
      } else if (eventType === "message_delta" && payload.delta && typeof payload.delta === "object") {
        const delta = payload.delta as Record<string, unknown>;
        finalUsage = usageFrom(payload.usage) ?? finalUsage;
        if (delta.stop_reason === "max_tokens") finishError = new Error("provider_responses_output_truncated");
      } else if (eventType === "message_stop") {
        finished = true;
      }
      return;
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    if (payload.usage) finalUsage = usageFrom(payload.usage) ?? finalUsage;
    const choice = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : undefined;
    const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta as Record<string, unknown> : undefined;
    const value = textFromContent(delta?.content) ?? "";
    if (value) {
      text += value;
      emit({ type: "text_delta", text: value });
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const item of delta.tool_calls) {
        if (!item || typeof item !== "object") continue;
        const call = item as Record<string, unknown>;
        const index = numberFrom(call.index) ?? 0;
        const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : {};
        const callId = stringFrom(call.id) ?? toolIndexMap.get(index) ?? `tool_call_${index}`;
        const existing = toolCallMap.get(callId) ?? toolCallMap.get(`tool_call_${index}`);
        const normalized = {
          callId,
          name: `${existing?.name ?? ""}${stringFrom(fn.name) ?? ""}`,
          arguments: `${existing?.arguments ?? ""}${stringFrom(fn.arguments) ?? ""}`,
          index
        };
        toolCallMap.delete(`tool_call_${index}`);
        toolCallMap.set(callId, normalized);
        toolIndexMap.set(index, callId);
        emit({ type: "tool_call_delta", callId, name: stringFrom(fn.name), argumentsDelta: stringFrom(fn.arguments), index });
      }
    }
    // Chat Completions normally sends a final usage chunk followed by
    // [DONE]; do not stop at finish_reason or that usage would be lost.
    // Usage can arrive in a final Chat Completions chunk. It is retained in
    // the normalized result, while the terminal event is emitted exactly once
    // after the stream has been fully consumed.
  };
  try {
    while (!finished) {
      const next = await reader.read();
      bytesReceived += next.value?.byteLength ?? 0;
      buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) consumePayload(line.slice(5).trimStart());
      }
      if (next.done) break;
    }
    if (buffer.startsWith("data:")) consumePayload(buffer.slice(5).trimStart());
    if (finishError) throw finishError;
    if (!finished) throw new Error(bytesReceived === 0 ? (kind === "responses" ? "provider_responses_empty" : "provider_stream_empty") : invalidEvents > 0 ? (kind === "responses" ? "provider_responses_invalid_event" : "provider_stream_invalid_event") : (kind === "responses" ? "provider_responses_incomplete" : "provider_stream_incomplete"));
    if (completedPayload) {
      const complete = parseCompletePayload({ ...completedPayload, output_text: text || completedPayload.output_text }, kind);
      const mergedTools = complete.toolCalls.length ? complete.toolCalls : [...toolCallMap.values()];
      const result = { ...complete, text: text || complete.text, toolCalls: mergedTools, telemetry: { ...complete.telemetry, bytesReceived, eventTypes: [...eventTypes], firstTokenAt } };
      emit({ type: "completed", text: result.text, usage: result.usage, toolCalls: result.toolCalls });
      return result;
    }
    const result: NormalizedLlmResponse = { text, usage: finalUsage, toolCalls: [...toolCallMap.values()], telemetry: { bytesReceived, eventTypes: [...eventTypes], firstTokenAt } };
    emit({ type: "completed", text, toolCalls: result.toolCalls });
    return result;
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("provider_stream_failed"), { streamTelemetry: { bytesReceived, eventTypes: [...eventTypes] } });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function makeAdapter(input: LlmTransportInput): LlmTransportAdapter {
  const kind = adapterKind(input);
  return {
    provider: input.credential.provider,
    kind,
    supportsStreaming: true,
    supportsToolCalling: true,
    complete: (transportInput, onEvent) => executeAdapterRequest(transportInput, kind, "non-stream", onEvent),
    stream: (transportInput, onEvent) => executeAdapterRequest(transportInput, kind, "stream", onEvent)
  };
}

async function executeAdapterRequest(input: LlmTransportInput, kind: LlmTransportAdapter["kind"], mode: LlmTransportMode, onEvent?: (event: NormalizedLlmStreamEvent) => void) {
  const response = await fetch(responseEndpoint(input, kind), {
    method: "POST",
    headers: responseHeaders({ ...input, mode }, kind),
    signal: requestSignal(input),
    body: JSON.stringify(requestBody({ ...input, mode }, kind))
  });
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  if (mode === "stream") {
    const result = await parseLlmStream(response, kind, onEvent);
    return { ...result, id: result.id ?? requestId };
  }
  const body = await response.text();
  const bytesReceived = Buffer.byteLength(body, "utf8");
  if (!body.trim()) throw new Error(kind === "responses" ? "provider_responses_empty" : "provider_empty_response");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body) as Record<string, unknown>; } catch { throw new Error(kind === "responses" ? "provider_responses_invalid_json" : "provider_invalid_json"); }
  if (payload.status === "failed" || payload.error && typeof payload.error === "object" && !payload.choices && !payload.output) throw sseError(kind, payload, "failed");
  if (payload.status === "incomplete") throw sseError(kind, payload, "incomplete");
  const result = parseCompletePayload(payload, kind);
  result.id ??= requestId;
  result.telemetry.bytesReceived = bytesReceived;
  onEvent?.({ type: "completed", text: result.text, usage: result.usage, toolCalls: result.toolCalls });
  return result;
}

export function getLlmTransportAdapter(input: LlmTransportInput): LlmTransportAdapter {
  return makeAdapter(input);
}
