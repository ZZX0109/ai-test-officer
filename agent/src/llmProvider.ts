import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { llmCallSchema, type LlmCall } from "@ai-test-officer/contracts";
import type { CredentialRecord } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export interface LlmCallContext {
  purpose: "planning" | "judging";
  runId?: string;
  experimentId?: string;
}

/**
 * Provider APIs report exact usage only after a response. Use a deliberately
 * conservative UTF-8 estimate before dispatch so a run cannot knowingly start
 * a call whose prompt plus maximum completion exceeds its token budget.
 */
export function reserveLlmOutputTokens(input: {
  prompt: string;
  system: string;
  usedTokens: number;
  maxTotalTokens: number;
  requestedOutputTokens: number;
  minimumOutputTokens?: number;
}) {
  const promptBytes = Buffer.byteLength(`${input.system}\n${input.prompt}`, "utf8");
  // UTF-8 bytes / 3 is intentionally stricter than the common ASCII heuristic
  // of characters / 4, while still leaving room for a compact second-stage
  // Judge after one successful Planner call.
  const estimatedPromptTokens = Math.ceil(promptBytes / 3);
  const availableOutputTokens = input.maxTotalTokens - input.usedTokens - estimatedPromptTokens;
  const minimumOutputTokens = input.minimumOutputTokens ?? 256;
  if (availableOutputTokens < minimumOutputTokens) {
    throw new Error("llm_budget_exceeded:preflight_total_tokens");
  }
  return {
    estimatedPromptTokens,
    maxOutputTokens: Math.min(input.requestedOutputTokens, availableOutputTokens)
  };
}

function usageCost(provider: CredentialRecord["provider"], model: string, promptTokens?: number, completionTokens?: number) {
  // Provider pricing is intentionally explicit. An OpenAI-compatible endpoint
  // is not necessarily billed at OpenAI rates (for example SophNet), so an
  // unknown provider must report token usage without inventing a dollar cost.
  const rates = provider === "anthropic" && model.startsWith("claude-sonnet-4-6")
    ? { input: 3, output: 15 }
    : provider === "openai" && model.startsWith("gpt-5.1")
      ? { input: 1.25, output: 10 }
      : undefined;
  return rates && (promptTokens !== undefined || completionTokens !== undefined)
    ? ((promptTokens ?? 0) * rates.input + (completionTokens ?? 0) * rates.output) / 1_000_000
    : undefined;
}

async function persist(call: LlmCall) {
  const directory = path.join(rootDir, "reports", "llm-calls", call.experimentId ?? call.runId ?? "unassigned");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${call.id}.json`), JSON.stringify(call, null, 2));
  if (!process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await pool.query(
      "INSERT INTO llm_calls_v1 (id, run_id, experiment_id, purpose, provider, model, request_id, status, duration_ms, usage, error_code, created_at, transport_attempts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING",
      [call.id, call.runId ?? null, call.experimentId ?? null, call.purpose, call.provider, call.model, call.requestId ?? null, call.status, call.durationMs, call.usage, call.errorCode ?? null, call.startedAt, JSON.stringify(call.transportAttempts ?? [])]
    );
  } finally {
    await pool.end();
  }
}

export async function parseResponsesStream(response: Response) {
  let completed: Record<string, any> | undefined;
  let text = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_responses_body_missing");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesReceived = 0;
  let invalidEvents = 0;
  const eventTypes = new Set<string>();
  const consume = (line: string) => {
    if (!line.startsWith("data: ")) return;
    try {
      const event = JSON.parse(line.slice(6)) as Record<string, any>;
      if (typeof event.type === "string") eventTypes.add(event.type);
      if (event.type === "response.output_text.delta") text += typeof event.delta === "string" ? event.delta : "";
      if (event.type === "response.completed") completed = event.response;
      if (event.type === "response.failed") throw new Error("provider_responses_failed");
      if (event.type === "response.incomplete") throw new Error("provider_responses_incomplete");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("provider_responses_")) throw error;
      invalidEvents += 1;
    }
  };
  while (!completed) {
    const next = await reader.read();
    bytesReceived += next.value?.byteLength ?? 0;
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (next.done) break;
  }
  if (!completed && buffer) consume(buffer);
  if (!completed) {
    const error = new Error(bytesReceived === 0 ? "provider_responses_empty" : invalidEvents > 0 ? "provider_responses_invalid_event" : "provider_responses_incomplete");
    throw Object.assign(error, { streamTelemetry: { bytesReceived, eventTypes: [...eventTypes] } });
  }
  await reader.cancel().catch(() => undefined);
  return { data: { ...completed, output_text: text }, telemetry: { bytesReceived, eventTypes: [...eventTypes] } };
}

async function parseResponsesJson(response: Response) {
  const body = await response.text();
  const bytesReceived = Buffer.byteLength(body, "utf8");
  if (!body.trim()) throw new Error("provider_responses_empty");
  let data: Record<string, any>;
  try {
    data = JSON.parse(body) as Record<string, any>;
  } catch {
    throw new Error("provider_responses_invalid_json");
  }
  return { data, telemetry: { bytesReceived, eventTypes: ["json_response"] } };
}

type ExecuteLlmCallInput = {
  credential: CredentialRecord;
  apiKey: string;
  prompt: string;
  system: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
  context: LlmCallContext;
  totalTimeoutMs?: number;
  transportPreference?: "auto" | "stream" | "non-stream" | "non-stream-retry";
  jsonSchema?: { name: string; schema: Record<string, unknown> };
};

type ResponsesTransportMode = "stream" | "non-stream";

async function executeTransportAttempt(input: ExecuteLlmCallInput, timeoutMs: number, mode: ResponsesTransportMode) {
  const attemptStartedAt = new Date().toISOString();
  const attemptStarted = Date.now();
  let requestId: string | undefined;
  let bytesReceived = 0;
  let eventTypes: string[] = [];
  try {
    const anthropic = input.credential.provider === "anthropic";
    const responsesApi = !anthropic && input.credential.provider === "openai-compatible" && /codex/i.test(input.credential.model);
    const response = await fetch(`${input.credential.baseUrl}${anthropic ? "/messages" : responsesApi ? "/responses" : "/chat/completions"}`, {
      method: "POST",
      headers: anthropic
        ? { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(anthropic ? {
        model: input.credential.model, max_tokens: input.maxTokens, temperature: input.temperature ?? 0,
        system: input.system, messages: [{ role: "user", content: input.prompt }]
      } : responsesApi ? {
        model: input.credential.model, instructions: input.system, input: `${input.prompt}\nReturn a JSON object.`,
        max_output_tokens: input.maxTokens,
        stream: mode === "stream",
        text: { format: input.jsonSchema
          ? { type: "json_schema", name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema }
          : { type: "json_object" } }
      } : {
        model: input.credential.model, temperature: input.temperature ?? 0, response_format: { type: "json_object" },
        max_tokens: input.maxTokens, messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }]
      })
    });
    requestId = response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const parsed = responsesApi
      ? mode === "stream" ? await parseResponsesStream(response) : await parseResponsesJson(response)
      : { data: await response.json(), telemetry: { bytesReceived: 0, eventTypes: ["json_response"] } };
    bytesReceived = parsed.telemetry.bytesReceived;
    eventTypes = parsed.telemetry.eventTypes;
    const data = parsed.data as Record<string, any>;
    requestId ??= data.id;
    return {
      data,
      telemetry: { attemptStartedAt, durationMs: Date.now() - attemptStarted, requestId, bytesReceived, eventTypes, mode }
    };
  } catch (error) {
    const streamTelemetry = error && typeof error === "object" && "streamTelemetry" in error
      ? (error as { streamTelemetry?: { bytesReceived?: number; eventTypes?: string[] } }).streamTelemetry
      : undefined;
    throw Object.assign(error instanceof Error ? error : new Error("provider_error"), {
      transportTelemetry: {
        attemptStartedAt,
        durationMs: Date.now() - attemptStarted,
        requestId,
        bytesReceived: streamTelemetry?.bytesReceived ?? bytesReceived,
        eventTypes: streamTelemetry?.eventTypes ?? eventTypes,
        mode
      }
    });
  }
}

async function executeLlmCallAttempt(input: ExecuteLlmCallInput): Promise<{ text: string; call: LlmCall }> {
  const id = `llm_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const attempts: NonNullable<LlmCall["transportAttempts"]> = [];
  const responsesApi = input.credential.provider === "openai-compatible" && /codex/i.test(input.credential.model);
  const modes: ResponsesTransportMode[] = responsesApi
    ? input.transportPreference === "non-stream"
      ? ["non-stream"]
      : input.transportPreference === "non-stream-retry"
        ? ["non-stream", "non-stream"]
      : input.transportPreference === "stream"
        ? ["stream"]
        : ["stream", "stream", "non-stream"]
    : ["stream"];
  const maxAttempts = modes.length;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = (input.totalTimeoutMs ?? (input.timeoutMs ?? 30_000) * maxAttempts + 2_000) - (Date.now() - started);
    if (remainingMs <= 0) { lastError = new Error("provider_total_timeout"); break; }
    try {
      const mode = modes[attempt - 1];
      const result = await executeTransportAttempt(input, Math.min(input.timeoutMs ?? Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 30_000), remainingMs), mode);
      attempts.push({ attempt, mode, status: "passed", startedAt: result.telemetry.attemptStartedAt, durationMs: result.telemetry.durationMs, requestId: result.telemetry.requestId, bytesReceived: result.telemetry.bytesReceived, eventTypes: result.telemetry.eventTypes });
      const data = result.data as {
      id?: string;
      model?: string;
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ type: string; text?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number };
      };
      const promptTokens = data.usage?.prompt_tokens ?? data.usage?.input_tokens;
      const completionTokens = data.usage?.completion_tokens ?? data.usage?.output_tokens;
      const usedFallback = attempts.some((item) => item.mode === "non-stream");
      const streamFailedBeforeFallback = usedFallback && attempts.some((item) => item.mode === "stream" && item.status === "failed");
      const call = llmCallSchema.parse({ id, ...input.context, provider: input.credential.provider, model: data.model ?? input.credential.model, requestId: result.telemetry.requestId ?? data.id, startedAt, durationMs: Date.now() - started, status: "passed", transportMode: usedFallback ? "non-stream-fallback" : "stream", fallbackReason: streamFailedBeforeFallback ? "stream_incomplete" : undefined, transportAttempts: attempts, usage: { promptTokens, completionTokens, totalTokens: data.usage?.total_tokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined), estimatedCostUsd: usageCost(input.credential.provider, data.model ?? input.credential.model, promptTokens, completionTokens) } });
      await persist(call);
      return { text: input.credential.provider === "anthropic"
        ? data.content?.find((item) => item.type === "text")?.text ?? ""
        : responsesApi
          ? data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text" || item.type === "text")?.text ?? ""
          : data.choices?.[0]?.message?.content ?? "", call };
    } catch (error) {
      lastError = error;
      const errorCode = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
      const telemetry = error && typeof error === "object" && "transportTelemetry" in error ? (error as any).transportTelemetry : {};
      const mode = modes[attempt - 1];
      attempts.push({ attempt, mode, status: "failed", startedAt: telemetry.attemptStartedAt ?? new Date().toISOString(), durationMs: telemetry.durationMs ?? 0, requestId: telemetry.requestId, errorCode, bytesReceived: telemetry.bytesReceived ?? 0, eventTypes: telemetry.eventTypes ?? [] });
      const retriable = responsesApi && input.transportPreference !== "stream" && /provider_responses_(incomplete|empty|invalid_event|body_missing)|TimeoutError|AbortError|fetch_failed|operation_was_aborted_due_to_timeout/i.test(errorCode);
      if (!retriable || attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 250 : 1_000));
    }
  }
  const errorCode = lastError instanceof Error ? lastError.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
  const usedFallback = attempts.some((item) => item.mode === "non-stream");
  const streamFailedBeforeFallback = usedFallback && attempts.some((item) => item.mode === "stream" && item.status === "failed");
  const call = llmCallSchema.parse({ id, ...input.context, provider: input.credential.provider, model: input.credential.model, startedAt, durationMs: Date.now() - started, status: "failed", transportMode: usedFallback ? "non-stream-fallback" : "stream", fallbackReason: streamFailedBeforeFallback ? "stream_incomplete" : undefined, usage: {}, errorCode, transportAttempts: attempts });
  await persist(call);
  throw Object.assign(new Error(errorCode), { llmCall: call });
}

export async function executeLlmCall(input: ExecuteLlmCallInput) {
  return executeLlmCallAttempt(input);
}
