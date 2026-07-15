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

function usageCost(model: string, promptTokens?: number, completionTokens?: number) {
  const rates = model.startsWith("claude-sonnet-4-6")
    ? { input: 3, output: 15 }
    : model.startsWith("gpt-5.1")
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
    const response = await fetch(`${input.credential.baseUrl}${anthropic ? "/messages" : "/chat/completions"}`, {
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
      } : {
        model: input.credential.model,
        temperature: input.temperature ?? 0,
        response_format: { type: "json_object" },
        max_tokens: input.maxTokens,
        messages: [{ role: "system", content: input.system }, { role: "user", content: input.prompt }]
      })
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const data = await response.json() as {
      id?: string;
      model?: string;
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
        estimatedCostUsd: usageCost(data.model ?? input.credential.model, promptTokens, completionTokens)
      }
    });
    await persist(call);
    return {
      text: anthropic ? data.content?.find((item) => item.type === "text")?.text ?? "" : data.choices?.[0]?.message?.content ?? "",
      call
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
    const call = llmCallSchema.parse({ id, ...input.context, provider: input.credential.provider, model: input.credential.model, startedAt, durationMs: Date.now() - started, status: "failed", usage: {}, errorCode });
    await persist(call);
    throw Object.assign(new Error(errorCode), { llmCall: call });
  }
}
