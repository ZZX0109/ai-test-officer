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
      "INSERT INTO llm_calls_v1 (id, run_id, experiment_id, purpose, provider, model, request_id, status, duration_ms, usage, error_code, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING",
      [call.id, call.runId ?? null, call.experimentId ?? null, call.purpose, call.provider, call.model, call.requestId ?? null, call.status, call.durationMs, call.usage, call.errorCode ?? null, call.startedAt]
    );
  } finally {
    await pool.end();
  }
}

async function parseResponsesStream(response: Response) {
  let completed: Record<string, any> | undefined;
  let text = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_responses_body_missing");
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string) => {
    if (!line.startsWith("data: ")) return;
    try {
      const event = JSON.parse(line.slice(6)) as Record<string, any>;
      if (event.type === "response.output_text.delta") text += typeof event.delta === "string" ? event.delta : "";
      if (event.type === "response.completed") completed = event.response;
    } catch { /* ignore keep-alive and malformed provider lines */ }
  };
  while (!completed) {
    const next = await reader.read();
    buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (next.done) break;
  }
  if (!completed && buffer) consume(buffer);
  if (!completed) throw new Error("provider_responses_incomplete");
  return { ...completed, output_text: text };
}

export async function executeLlmCall(input: {
  credential: CredentialRecord;
  apiKey: string;
  prompt: string;
  system: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
  context: LlmCallContext;
}) {
  const id = `llm_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const anthropic = input.credential.provider === "anthropic";
    // Codex profiles exposed by some OpenAI-compatible gateways only support
    // the Responses API. Keep the adapter narrow so ordinary compatible
    // models continue using chat completions.
    const responsesApi = !anthropic && input.credential.provider === "openai-compatible" && /codex/i.test(input.credential.model);
    const response = await fetch(`${input.credential.baseUrl}${anthropic ? "/messages" : responsesApi ? "/responses" : "/chat/completions"}`, {
      method: "POST",
      headers: anthropic
        ? { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
        : { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMs ?? Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 30_000)),
      body: JSON.stringify(anthropic ? {
        model: input.credential.model,
        max_tokens: input.maxTokens,
        temperature: input.temperature ?? 0,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }]
      } : responsesApi ? {
        model: input.credential.model,
        instructions: input.system,
        input: `${input.prompt}\nReturn a JSON object.`,
        max_output_tokens: input.maxTokens,
        stream: true,
        text: { format: { type: "json_object" } }
      } : {
        model: input.credential.model,
        temperature: input.temperature ?? 0,
        response_format: { type: "json_object" },
        max_tokens: input.maxTokens,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }]
      })
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const data = (responsesApi ? await parseResponsesStream(response) : await response.json()) as {
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
    const call = llmCallSchema.parse({
      id,
      ...input.context,
      provider: input.credential.provider,
      model: data.model ?? input.credential.model,
      requestId: response.headers.get("x-request-id") ?? data.id,
      startedAt,
      durationMs: Date.now() - started,
      status: "passed",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: data.usage?.total_tokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
        estimatedCostUsd: usageCost(input.credential.provider, data.model ?? input.credential.model, promptTokens, completionTokens)
      }
    });
    await persist(call);
    return {
      text: anthropic
        ? data.content?.find((item) => item.type === "text")?.text ?? ""
        : responsesApi
          ? data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text" || item.type === "text")?.text ?? ""
          : data.choices?.[0]?.message?.content ?? "",
      call
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
    const call = llmCallSchema.parse({ id, ...input.context, provider: input.credential.provider, model: input.credential.model, startedAt, durationMs: Date.now() - started, status: "failed", usage: {}, errorCode });
    await persist(call);
    throw Object.assign(new Error(errorCode), { llmCall: call });
  }
}
