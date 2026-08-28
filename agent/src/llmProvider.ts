import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatabasePool } from "./databaseRuntime.js";
import { llmCallSchema, type LlmBudget, type LlmCall } from "@ai-test-officer/contracts";
import type { CredentialRecord } from "./types.js";
import { publishLlmLifecycle } from "./llmLifecycle.js";
import { getLlmTransportAdapter, type LlmConversationMessage, type LlmTransportToolDefinition, type NormalizedLlmStreamEvent, parseLlmStream } from "./llmTransport.js";
import { emitTrajectory } from "./trajectoryEmitter.js";
import { listRunKnowledge } from "./knowledge-boundary/store.js";
import { estimateModelUsageCost } from "./modelPriceCatalog.js";
import { finalizeLlmBudget, reserveLlmBudget, type LlmBudgetReservation } from "./llmBudgetLedger.js";
import { redactText, redactValue } from "./redaction.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export interface LlmCallContext {
  purpose: "planning" | "browser-action" | "judging" | "triage" | "repairing" | "assistant";
  budgetScopeId?: string;
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
const PROVIDER_ADAPTER_VERSION = "responses-2.1.0";

/**
 * A single process can own several Graph runs at once.  Without a provider
 * gate those runs dispatch their ReAct decisions concurrently and a local
 * SophNet gateway responds with 429 even though each individual run is within
 * budget.  This is transport coordination, not a semantic fallback: calls
 * remain the same calls and their result/decision is unchanged.
 */
type ProviderGate = {
  tail: Promise<void>;
  nextAllowedAt: number;
};
const providerGates = new Map<string, ProviderGate>();

function providerGateKey(input: ExecuteLlmCallInput) {
  return `${input.credential.provider}:${input.credential.baseUrl}:${input.credential.model}`;
}

async function acquireProviderSlot(input: ExecuteLlmCallInput): Promise<{ waitedMs: number; release: () => void }> {
  const current = providerGates.get(providerGateKey(input)) ?? {
    tail: Promise.resolve(),
    nextAllowedAt: 0
  };
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const predecessor = current.tail;
  current.tail = predecessor.then(() => turn);
  providerGates.set(providerGateKey(input), current);
  const queuedAt = Date.now();
  await predecessor;
  const minimumIntervalMs = Math.max(0, Number(process.env.LLM_PROVIDER_MIN_INTERVAL_MS ?? 120));
  const delayMs = Math.max(0, current.nextAllowedAt - Date.now());
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const waitedMs = Date.now() - queuedAt;
  current.nextAllowedAt = Date.now() + minimumIntervalMs;
  return { waitedMs, release };
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

// Truncated (~2 KB) preview of the request prompt / model response so the
// trajectory can show "what the model was asked / answered" the way DSH's agent
// turn view does, without persisting the full (potentially large, source-laden)
// messages into the run store. Mirrors the inputPreview/outputPreview fields
// on llmCallSchema.
function previewText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 2048 ? `${trimmed.slice(0, 2047)}…` : trimmed;
}

/** Full redacted model input for the trajectory Inspector. The provider still
 * receives the original bytes; only this persisted audit copy is redacted. */
function trajectoryText(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    return JSON.stringify(redactValue(JSON.parse(value)), null, 2);
  } catch {
    return redactText(value);
  }
}

async function persist(call: LlmCall) {
  const directory = path.join(rootDir, "reports", "llm-calls", call.experimentId ?? call.runId ?? "unassigned");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${call.id}.json`), JSON.stringify(call, null, 2));
  if (!process.env.DATABASE_URL) return;
  const pool = getDatabasePool();
  if (!pool) return;
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
  const result = await parseLlmStream(response, "responses");
  return {
    data: {
      id: result.id,
      model: result.model,
      status: result.status,
      output_text: result.text,
      usage: result.usage
        ? { input_tokens: result.usage.promptTokens, output_tokens: result.usage.completionTokens, total_tokens: result.usage.totalTokens }
        : undefined,
      output: result.toolCalls.map((call) => ({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments }))
    },
    telemetry: result.telemetry
  };
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
  tools?: LlmTransportToolDefinition[];
  messages?: LlmConversationMessage[];
  /** Caller-owned cancellation for the logical LLM request. */
  signal?: AbortSignal;
  onStreamEvent?: (event: NormalizedLlmStreamEvent) => void;
  budget?: LlmBudget;
  /** Semantic repair belongs to the original logical Planner/Judge call. */
  countLogicalCall?: boolean;
};

type ResponsesTransportMode = "stream" | "non-stream";

async function executeTransportAttempt(input: ExecuteLlmCallInput, timeoutMs: number, mode: ResponsesTransportMode) {
  const attemptStartedAt = new Date().toISOString();
  const attemptStarted = Date.now();
  let requestId: string | undefined;
  try {
    const adapter = getLlmTransportAdapter({
      credential: input.credential,
      apiKey: input.apiKey,
      prompt: input.prompt,
      system: input.system,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      mode,
      timeoutMs,
      signal: input.signal,
      jsonSchema: input.jsonSchema,
      tools: input.tools,
      messages: input.messages
    });
    const result = mode === "stream"
      ? await adapter.stream({ credential: input.credential, apiKey: input.apiKey, prompt: input.prompt, system: input.system, maxTokens: input.maxTokens, temperature: input.temperature, mode, timeoutMs, signal: input.signal, jsonSchema: input.jsonSchema, tools: input.tools, messages: input.messages }, input.onStreamEvent ?? (() => undefined))
      : await adapter.complete({ credential: input.credential, apiKey: input.apiKey, prompt: input.prompt, system: input.system, maxTokens: input.maxTokens, temperature: input.temperature, mode, timeoutMs, signal: input.signal, jsonSchema: input.jsonSchema, tools: input.tools, messages: input.messages }, input.onStreamEvent);
    requestId = result.id;
    return {
      data: result,
      toolCalls: result.toolCalls,
      telemetry: { attemptStartedAt, durationMs: Date.now() - attemptStarted, requestId, bytesReceived: result.telemetry.bytesReceived, eventTypes: result.telemetry.eventTypes, firstTokenAt: result.telemetry.firstTokenAt, mode }
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
        bytesReceived: streamTelemetry?.bytesReceived ?? 0,
        eventTypes: streamTelemetry?.eventTypes ?? [],
        mode
      }
    });
  }
}

async function executeLlmCallAttempt(input: ExecuteLlmCallInput): Promise<{ text: string; call: LlmCall; toolCalls?: Array<{ callId: string; name: string; arguments: string; index?: number }> }> {
  const id = `llm_${randomUUID()}`;
  const queuedAt = new Date().toISOString();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let budgetReservation: LlmBudgetReservation | undefined;
  if (input.context.runId) {
    budgetReservation = await reserveLlmBudget({
      runId: input.context.runId,
      purpose: input.context.purpose,
      scopeId: input.context.budgetScopeId,
      budget: input.budget,
      estimatedTokens: Math.ceil(Buffer.byteLength(`${input.system}\n${input.prompt}`, "utf8") / 3) + input.maxTokens,
      estimatedWallClockMs: input.timeoutMs ?? 30_000,
      estimatedCostUsd: null,
      countLogicalCall: input.countLogicalCall
    });
  }
  if (input.context.runId) {
    void emitTrajectory({
      runId: input.context.runId,
      type: "llm.request",
      actor: "llm-provider",
      status: "running",
      idempotencyKey: `${id}:request`,
      payload: {
        callId: id,
        purpose: input.context.purpose,
        provider: input.credential.provider,
        model: input.credential.model,
        systemPrompt: trajectoryText(input.system),
        prompt: trajectoryText(input.prompt),
        promptPreview: previewText(redactSummary(input.prompt)),
        options: { maxTokens: input.maxTokens, temperature: input.temperature },
        toolNames: input.tools?.map((tool) => tool.name) ?? [],
        tools: input.tools?.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.inputSchema })) ?? []
      }
    });
    publishLlmLifecycle({
      name: "llm.call.started",
      runId: input.context.runId,
      callId: id,
      at: startedAt,
      payload: {
        purpose: input.context.purpose,
        budgetScopeId: input.context.budgetScopeId,
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
  let streamEventIndex = 0;
  let currentAttempt = 0;
  const emitTransportEvent = (event: NormalizedLlmStreamEvent) => {
    input.onStreamEvent?.(event);
    if (!input.context.runId) return;
    if (event.type === "completed") {
      void emitTrajectory({
        runId: input.context.runId,
        type: "llm.response",
        actor: "llm-provider",
        status: "success",
        idempotencyKey: `${id}:response:${streamEventIndex}`,
        ...(event.usage ? { usage: {
          inputTokens: event.usage.promptTokens,
          outputTokens: event.usage.completionTokens,
          reasoningTokens: event.usage.reasoningTokens
        } } : {}),
        timing: { startedAt },
        payload: { callId: id, attempt: currentAttempt, text: event.text, usage: event.usage, toolCalls: event.toolCalls ?? [] }
      });
      return;
    }
    streamEventIndex += 1;
    void emitTrajectory({
      runId: input.context.runId,
      type: "llm.chunk",
      actor: "llm-provider",
      status: "running",
      idempotencyKey: `${id}:chunk:${streamEventIndex}`,
      payload: event.type === "tool_call_delta"
        ? { callId: id, attempt: currentAttempt, eventType: event.type, toolCallId: event.callId, toolName: event.name, argumentsDelta: event.argumentsDelta, index: event.index }
        : event.type === "reasoning_delta"
          ? { callId: id, attempt: currentAttempt, eventType: event.type, reasoningDelta: event.text }
          : { callId: id, attempt: currentAttempt, eventType: event.type, textDelta: event.text }
    });
  };
  const modes: ResponsesTransportMode[] = input.transportPreference === "non-stream"
    ? ["non-stream"]
    : input.transportPreference === "non-stream-retry"
      ? ["non-stream", "non-stream"]
      : input.transportPreference === "stream"
        ? ["stream"]
        : ["stream", "stream", "non-stream"];
  const maxAttempts = modes.length;
  let lastError: unknown;
  let providerQueueMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMs = (input.totalTimeoutMs ?? (input.timeoutMs ?? 30_000) * maxAttempts + 2_000) - (Date.now() - started);
    if (remainingMs <= 0) { lastError = new Error("provider_total_timeout"); break; }
    const providerSlot = await acquireProviderSlot(input);
    providerQueueMs += providerSlot.waitedMs;
    try {
      const mode = modes[attempt - 1];
      currentAttempt = attempt;
      const result = await executeTransportAttempt({ ...input, onStreamEvent: emitTransportEvent }, Math.min(input.timeoutMs ?? Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 30_000), remainingMs), mode);
      attempts.push({ attempt, mode, status: "passed", startedAt: result.telemetry.attemptStartedAt, durationMs: result.telemetry.durationMs, requestId: result.telemetry.requestId, bytesReceived: result.telemetry.bytesReceived, eventTypes: result.telemetry.eventTypes });
      const data = result.data as {
        id?: string;
        model?: string;
        text: string;
        toolCalls?: Array<{ callId: string; name: string; arguments: string; index?: number }>;
        usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; reasoningTokens?: number };
      };
      const promptTokens = data.usage?.promptTokens;
      const completionTokens = data.usage?.completionTokens;
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
      const text = data.text ?? "";
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
        inputPreview: previewText(redactSummary(input.prompt)),
        outputPreview: previewText(redactSummary(text)),
        requestId: result.telemetry.requestId ?? data.id,
        queuedAt,
        startedAt,
        firstTokenAt: result.telemetry.firstTokenAt,
        completedAt,
        durationMs,
        timing: {
          queueMs: providerQueueMs,
          firstTokenMs: result.telemetry.firstTokenAt ? Math.max(0, Date.parse(result.telemetry.firstTokenAt) - Date.parse(startedAt)) : undefined,
          generationMs: durationMs,
          totalMs: durationMs
        },
        status: "passed",
        transportMode: streamFailedBeforeFallback ? "non-stream-fallback" : usedFallback ? "non-stream" : "stream",
        fallbackReason: streamFailedBeforeFallback ? "stream_incomplete" : undefined,
        fallbackImpact: "none",
        finalStatusImpact: "none",
        transportAttempts: attempts,
        toolCalls: data.toolCalls ?? [],
        usage: {
          promptTokens,
          completionTokens,
          reasoningTokens: data.usage?.reasoningTokens,
          totalTokens: data.usage?.totalTokens ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
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
      return { text, call, toolCalls: data.toolCalls ?? [] };
    } catch (error) {
      lastError = error;
      const errorCode = input.signal?.aborted ? "llm_cancelled" : error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
      const telemetry: TransportTelemetry = error && typeof error === "object" && "transportTelemetry" in error
        ? (error as { transportTelemetry?: TransportTelemetry }).transportTelemetry ?? {}
        : {};
      const mode = modes[attempt - 1];
      attempts.push({ attempt, mode, status: "failed", startedAt: telemetry.attemptStartedAt ?? new Date().toISOString(), durationMs: telemetry.durationMs ?? 0, requestId: telemetry.requestId, errorCode, bytesReceived: telemetry.bytesReceived ?? 0, eventTypes: telemetry.eventTypes ?? [] });
      const retriable = !input.signal?.aborted && input.transportPreference !== "stream" && /provider_http_(408|429|502|503|504)|provider_(responses_)?(incomplete|empty|empty_response|invalid_json|invalid_event|body_missing|stream_.*)|TimeoutError|AbortError|fetch_failed|operation_was_aborted_due_to_timeout/i.test(errorCode);
      if (!retriable || attempt === maxAttempts) break;
      const baseDelay = attempt === 1 ? 250 : 1_000;
      if (input.context.runId) {
        void emitTrajectory({
          runId: input.context.runId,
          type: "llm.retry",
          actor: "llm-provider",
          status: "running",
          idempotencyKey: `${id}:retry:${attempt}`,
          payload: { callId: id, attempt, nextAttempt: attempt + 1, mode, errorCode, retryDelayMs: baseDelay }
        });
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
    } finally {
      providerSlot.release();
    }
  }
  const errorCode = input.signal?.aborted ? "llm_cancelled" : lastError instanceof Error ? lastError.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160) : "provider_error";
  const usedFallback = attempts.some((item) => item.mode === "non-stream");
  const streamFailedBeforeFallback = usedFallback && attempts.some((item) => item.mode === "stream" && item.status === "failed");
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const failureClass = /provider_http_401/.test(errorCode) ? "authentication"
    : /provider_http_403/.test(errorCode) ? "authorization"
      : /model|access/.test(errorCode) ? "model-access"
        : /budget|token/.test(errorCode) ? "budget"
          : /timeout|cancel|fetch|incomplete|empty|http_(408|429|5)/.test(errorCode) ? "transport"
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
    inputPreview: previewText(redactSummary(input.prompt)),
    queuedAt,
    startedAt,
    completedAt,
    durationMs,
    timing: { queueMs: providerQueueMs, generationMs: durationMs, totalMs: durationMs },
    status: "failed",
    transportMode: streamFailedBeforeFallback ? "non-stream-fallback" : usedFallback ? "non-stream" : "stream",
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
    void emitTrajectory({
      runId: input.context.runId,
      type: "llm.response",
      actor: "llm-provider",
      status: "error",
      idempotencyKey: `${id}:response:error`,
      timing: { startedAt, completedAt },
      payload: { callId: id, attempt: currentAttempt, text: "", errorCode, toolCalls: [] }
    });
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
    const pool = getDatabasePool();
    if (!pool) return [];
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
    }
  }
}
