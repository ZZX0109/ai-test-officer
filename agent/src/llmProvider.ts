import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { llmCallSchema, type LlmBudget, type LlmCall } from "@ai-test-officer/contracts";
import type { CredentialRecord } from "./types.js";
import { publishLlmLifecycle } from "./llmLifecycle.js";
import { listRunKnowledge } from "./knowledge-boundary/store.js";
import { estimateModelUsageCost } from "./modelPriceCatalog.js";
import { finalizeLlmBudget, reserveLlmBudget, type LlmBudgetReservation } from "./llmBudgetLedger.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export interface LlmCallContext {
  purpose: "planning" | "judging" | "triage" | "repairing" | "assistant";
  runId?: string;
  experimentId?: string;
  modelProfileId?: string;
  promptTemplateId?: string;
  promptVersion?: string;
  actionDslVersion?: string;
  outputSchemaVersion?: string;
  graphVersion?: string;
  scenarioRegistrySha256?: string;
  projectDigest?: string;
  routeReason?: string;
  ruleCapable?: boolean;
  ruleBypassReason?: string;
  cachePolicy?: "use" | "bypass";
  knowledgeContextId?: string;
  boundaryPolicyVersion?: string;
  knowledgeValidationStatus?: "not-applicable" | "pending" | "verified" | "rejected" | "expired";
}

const LANGCHAIN_ADAPTER_VERSION = "agent-orchestration-0.1.0";
const PROVIDER_ADAPTER_VERSION = "responses-2.0.0";

interface ProviderResponseData {
  id?: string;
  model?: string;
  output_text?: string;
  usage?: {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  content?: Array<{ type?: string; text?: string }>;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  choices?: Array<{ message?: { content?: string } }>;
}

interface TransportTelemetry {
  attemptStartedAt?: string;
  durationMs?: number;
  requestId?: string;
  bytesReceived?: number;
  eventTypes?: string[];
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function redactSummary(value: string) {
  return value
    .replace(/(?:sk|api|key|token)[-_a-z0-9]{8,}/gi, "[REDACTED]")
    .replace(/authorization\s*:\s*\S+/gi, "authorization:[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
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

async function persist(call: LlmCall) {
  const directory = path.join(rootDir, "reports", "llm-calls", call.experimentId ?? call.runId ?? "unassigned");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${call.id}.json`), JSON.stringify(call, null, 2));
  if (!process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO llm_calls_v1 (id, run_id, experiment_id, purpose, provider, model, request_id, status, duration_ms, usage, error_code, created_at, transport_attempts, invocation_json, completed_at, prompt_sha256, graph_version, model_profile_id, price_catalog_version, final_status_impact) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ON CONFLICT (id) DO NOTHING",
        [call.id, call.runId ?? null, call.experimentId ?? null, call.purpose, call.provider, call.model, call.requestId ?? null, call.status, call.durationMs, call.usage, call.errorCode ?? null, call.startedAt, JSON.stringify(call.transportAttempts ?? []), call, call.completedAt ?? null, call.promptSha256 ?? null, call.graphVersion ?? null, call.modelProfileId ?? null, call.usage.priceCatalogVersion ?? null, call.finalStatusImpact]
      );
      await client.query(
        `INSERT INTO llm_invocations_v1
         (id,run_id,experiment_id,purpose,provider,requested_model,returned_model,status,prompt_sha256,price_catalog_version,final_status_impact,invocation_json,started_at,completed_at,knowledge_context_id,boundary_policy_version,knowledge_validation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [
          call.id,
          call.runId ?? null,
          call.experimentId ?? null,
          call.purpose,
          call.provider,
          call.requestedModel ?? call.model,
          call.returnedModel ?? null,
          call.status,
          call.promptSha256 ?? null,
          call.usage.priceCatalogVersion ?? null,
          call.finalStatusImpact,
          call,
          call.startedAt,
          call.completedAt ?? null,
          call.knowledgeContextId ?? null,
          call.boundaryPolicyVersion ?? null,
          call.knowledgeValidationStatus ?? "not-applicable"
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function persistCallAndSettleBudget(
  call: LlmCall,
  reservation: LlmBudgetReservation | undefined
) {
  try {
    await persist(call);
  } finally {
    // A telemetry/database write failure must not leave the entire reserved
    // budget stranded. The provider work has already happened, so always
    // settle actual usage even when invocation persistence needs recovery.
    if (reservation) {
      await finalizeLlmBudget(reservation, {
        tokens: call.usage.totalTokens,
        wallClockMs: call.durationMs,
        estimatedCostUsd: call.usage.estimatedCostUsd
      });
    }
  }
}

export async function parseResponsesStream(response: Response) {
  let completed: ProviderResponseData | undefined;
  let text = "";
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_responses_body_missing");
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesReceived = 0;
  let invalidEvents = 0;
  let firstTokenAt: string | undefined;
  const eventTypes = new Set<string>();
  const consume = (line: string) => {
    if (!line.startsWith("data: ")) return;
    try {
      const event = JSON.parse(line.slice(6)) as {
        type?: string;
        delta?: string;
        response?: ProviderResponseData;
      };
      if (typeof event.type === "string") eventTypes.add(event.type);
      if (event.type === "response.output_text.delta") {
        if (!firstTokenAt) firstTokenAt = new Date().toISOString();
        text += typeof event.delta === "string" ? event.delta : "";
      }
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
  return { data: { ...completed, output_text: text }, telemetry: { bytesReceived, eventTypes: [...eventTypes], firstTokenAt } };
}

async function parseResponsesJson(response: Response) {
  const body = await response.text();
  const bytesReceived = Buffer.byteLength(body, "utf8");
  if (!body.trim()) throw new Error("provider_responses_empty");
  let data: ProviderResponseData;
  try {
    data = JSON.parse(body) as ProviderResponseData;
  } catch {
    throw new Error("provider_responses_invalid_json");
  }
  return { data, telemetry: { bytesReceived, eventTypes: ["json_response"], firstTokenAt: undefined as string | undefined } };
}

export type ExecuteLlmCallInput = {
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
  budget?: LlmBudget;
  /** Semantic repair belongs to the original logical Planner/Judge call. */
  countLogicalCall?: boolean;
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
        : { data: await response.json(), telemetry: { bytesReceived: 0, eventTypes: ["json_response"], firstTokenAt: undefined as string | undefined } };
    bytesReceived = parsed.telemetry.bytesReceived;
    eventTypes = parsed.telemetry.eventTypes;
    const data = parsed.data as ProviderResponseData;
    requestId ??= data.id;
    return {
      data,
      telemetry: { attemptStartedAt, durationMs: Date.now() - attemptStarted, requestId, bytesReceived, eventTypes, firstTokenAt: parsed.telemetry.firstTokenAt, mode }
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
  const queuedAt = new Date().toISOString();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let budgetReservation: LlmBudgetReservation | undefined;
  if (input.context.runId) {
    budgetReservation = await reserveLlmBudget({
      runId: input.context.runId,
      purpose: input.context.purpose,
      budget: input.budget,
      estimatedTokens: Math.ceil(Buffer.byteLength(`${input.system}\n${input.prompt}`, "utf8") / 3) + input.maxTokens,
      estimatedWallClockMs: input.timeoutMs ?? 30_000,
      estimatedCostUsd: null,
      countLogicalCall: input.countLogicalCall
    });
  }
  if (input.context.runId) {
    publishLlmLifecycle({
      name: "llm.call.started",
      runId: input.context.runId,
      callId: id,
      at: startedAt,
      payload: {
        purpose: input.context.purpose,
        provider: input.credential.provider,
        requestedModel: input.credential.model,
        modelProfileId: input.context.modelProfileId,
        promptTemplateId: input.context.promptTemplateId,
        promptVersion: input.context.promptVersion,
        graphVersion: input.context.graphVersion,
        routeReason: input.context.routeReason,
        cachePolicy: input.context.cachePolicy ?? "use"
      }
    });
  }
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
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - started;
      const pricing = estimateModelUsageCost({
        provider: input.credential.provider,
        model: data.model ?? input.credential.model,
        promptTokens,
        completionTokens
      });
      const call = llmCallSchema.parse({
        id,
        ...input.context,
        provider: input.credential.provider,
        model: data.model ?? input.credential.model,
        requestedModel: input.credential.model,
        returnedModel: data.model ?? input.credential.model,
        langChainAdapterVersion: LANGCHAIN_ADAPTER_VERSION,
        providerAdapterVersion: PROVIDER_ADAPTER_VERSION,
        promptSha256: sha256(`${input.system}\n${input.prompt}`),
        inputSummarySha256: sha256(input.prompt),
        redactedInputSummary: redactSummary(input.prompt),
        requestId: result.telemetry.requestId ?? data.id,
        queuedAt,
        startedAt,
        firstTokenAt: result.telemetry.firstTokenAt,
        completedAt,
        durationMs,
        timing: {
          queueMs: 0,
          firstTokenMs: result.telemetry.firstTokenAt ? Math.max(0, Date.parse(result.telemetry.firstTokenAt) - Date.parse(startedAt)) : undefined,
          generationMs: durationMs,
          totalMs: durationMs
        },
        status: "passed",
        transportMode: usedFallback ? "non-stream-fallback" : "stream",
        fallbackReason: streamFailedBeforeFallback ? "stream_incomplete" : undefined,
        fallbackImpact: "none",
        finalStatusImpact: "none",
        transportAttempts: attempts,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: data.usage?.total_tokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
          estimatedCostUsd: pricing.cost,
          currency: "USD",
          priceCatalogVersion: pricing.catalogVersion
        }
      });
      await persistCallAndSettleBudget(call, budgetReservation);
      if (input.context.runId) {
        publishLlmLifecycle({
          name: "llm.call.completed",
          runId: input.context.runId,
          callId: id,
          at: completedAt,
          payload: { call }
        });
      }
      return { text: input.credential.provider === "anthropic"
        ? data.content?.find((item) => item.type === "text")?.text ?? ""
        : responsesApi
          ? data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text" || item.type === "text")?.text ?? ""
          : data.choices?.[0]?.message?.content ?? "", call };
    } catch (error) {
      lastError = error;
      const errorCode = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
      const telemetry: TransportTelemetry = error && typeof error === "object" && "transportTelemetry" in error
        ? (error as { transportTelemetry?: TransportTelemetry }).transportTelemetry ?? {}
        : {};
      const mode = modes[attempt - 1];
      attempts.push({ attempt, mode, status: "failed", startedAt: telemetry.attemptStartedAt ?? new Date().toISOString(), durationMs: telemetry.durationMs ?? 0, requestId: telemetry.requestId, errorCode, bytesReceived: telemetry.bytesReceived ?? 0, eventTypes: telemetry.eventTypes ?? [] });
      const retriable = responsesApi && input.transportPreference !== "stream" && /provider_http_(408|429|502|503|504)|provider_responses_(incomplete|empty|invalid_event|body_missing)|TimeoutError|AbortError|fetch_failed|operation_was_aborted_due_to_timeout/i.test(errorCode);
      if (!retriable || attempt === maxAttempts) break;
      const baseDelay = attempt === 1 ? 250 : 1_000;
      if (input.context.runId) {
        publishLlmLifecycle({
          name: "llm.call.retried",
          runId: input.context.runId,
          callId: id,
          at: new Date().toISOString(),
          payload: {
            attempt,
            nextAttempt: attempt + 1,
            mode,
            errorCode,
            retryDelayMs: baseDelay
          }
        });
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelay + Math.floor(Math.random() * Math.max(25, baseDelay * 0.2))));
    }
  }
  const errorCode = lastError instanceof Error ? lastError.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
  const usedFallback = attempts.some((item) => item.mode === "non-stream");
  const streamFailedBeforeFallback = usedFallback && attempts.some((item) => item.mode === "stream" && item.status === "failed");
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const failureClass = /provider_http_401/.test(errorCode) ? "authentication"
    : /provider_http_403/.test(errorCode) ? "authorization"
      : /model|access/.test(errorCode) ? "model-access"
        : /budget|token/.test(errorCode) ? "budget"
          : /timeout|fetch|incomplete|empty|http_(408|429|5)/.test(errorCode) ? "transport"
            : "provider";
  const fallbackImpact = input.context.purpose === "planning" ? "path-blocked"
    : input.context.purpose === "judging" ? "recommendation-unavailable"
      : input.context.purpose === "triage" || input.context.purpose === "repairing" ? "human-review-required"
        : "none";
  const finalStatusImpact = input.context.purpose === "planning" ? "blocked"
    : input.context.purpose === "judging" ? "advisory-only"
      : input.context.purpose === "triage" || input.context.purpose === "repairing" ? "forced-review"
        : "none";
  const call = llmCallSchema.parse({
    id,
    ...input.context,
    provider: input.credential.provider,
    model: input.credential.model,
    requestedModel: input.credential.model,
    langChainAdapterVersion: LANGCHAIN_ADAPTER_VERSION,
    providerAdapterVersion: PROVIDER_ADAPTER_VERSION,
    promptSha256: sha256(`${input.system}\n${input.prompt}`),
    inputSummarySha256: sha256(input.prompt),
    redactedInputSummary: redactSummary(input.prompt),
    queuedAt,
    startedAt,
    completedAt,
    durationMs,
    timing: { queueMs: 0, generationMs: durationMs, totalMs: durationMs },
    status: "failed",
    transportMode: usedFallback ? "non-stream-fallback" : "stream",
    fallbackReason: streamFailedBeforeFallback ? "stream_incomplete" : undefined,
    fallbackImpact,
    finalStatusImpact,
    usage: { estimatedCostUsd: null, currency: "USD" },
    errorCode,
    failureClass,
    transportAttempts: attempts
  });
  await persistCallAndSettleBudget(call, budgetReservation);
  if (input.context.runId) {
    publishLlmLifecycle({
      name: "llm.call.failed",
      runId: input.context.runId,
      callId: id,
      at: completedAt,
      payload: { call }
    });
  }
  throw Object.assign(new Error(errorCode), { llmCall: call });
}

export async function executeLlmCall(input: ExecuteLlmCallInput) {
  return executeLlmCallAttempt(input);
}

export async function listLlmCalls(runId: string): Promise<LlmCall[]> {
  const withKnowledgeLinks = async (calls: LlmCall[]) => {
    const decisions = (await listRunKnowledge(runId)).decisions;
    const byInvocation = new Map(
      decisions
        .filter((item) => item.invocationId)
        .map((item) => [item.invocationId!, item])
    );
    return calls.map((call) => {
      const decision = byInvocation.get(call.id);
      return decision ? llmCallSchema.parse({
        ...call,
        knowledgeContextId: decision.contextId,
        knowledgeDecisionId: decision.id,
        knowledgeToolExecutionIds: decision.toolExecutionIds,
        boundaryPolicyVersion: decision.policyVersion,
        knowledgeValidationStatus: decision.validationStatus
      }) : call;
    });
  };
  const directory = path.join(rootDir, "reports", "llm-calls", runId);
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const calls = await Promise.all(files.map(async (file) =>
      llmCallSchema.parse(JSON.parse(await readFile(path.join(directory, file), "utf8")))
    ));
    return (await withKnowledgeLinks(calls)).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  } catch {
    if (!process.env.DATABASE_URL) return [];
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      let rows: Array<{ invocation_json: unknown }>;
      try {
        rows = (await pool.query<{ invocation_json: unknown }>(
          "SELECT invocation_json FROM llm_invocations_v1 WHERE run_id=$1 ORDER BY started_at ASC",
          [runId]
        )).rows;
      } catch (error) {
        // During a rolling upgrade the API can start before the migration
        // reaches this table. Keep historical observability available.
        if (!(error && typeof error === "object" && "code" in error && error.code === "42P01")) throw error;
        rows = (await pool.query<{ invocation_json: unknown }>(
          "SELECT invocation_json FROM llm_calls_v1 WHERE run_id=$1 ORDER BY created_at ASC",
          [runId]
        )).rows;
      }
      return withKnowledgeLinks(rows.map((row) => llmCallSchema.parse(row.invocation_json)));
    } catch {
      return [];
    } finally {
      await pool.end();
    }
  }
}
