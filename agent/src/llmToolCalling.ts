import { randomUUID } from "node:crypto";
import { emitTrajectory } from "./trajectoryEmitter.js";
import { executeLlmCall as invokeLlmTransport, type ExecuteLlmCallInput } from "./llmProvider.js";
import { getToolGateway, type ToolCapability, type ToolResult } from "./tool-gateway/toolGateway.js";
import type { LlmConversationMessage, LlmTransportToolDefinition, NormalizedToolCall, NormalizedLlmStreamEvent } from "./llmTransport.js";

export interface NativeToolLoopInput extends ExecuteLlmCallInput {
  tools: LlmTransportToolDefinition[];
  maxToolRounds?: number;
  /** Per-tool execution deadline enforced by ToolGateway. */
  toolTimeoutMs?: number;
  approveToolCall?: (call: NormalizedToolCall, capability: ToolCapability) => boolean | Promise<boolean>;
}

export interface NativeToolLoopResult {
  text: string;
  call: Awaited<ReturnType<typeof invokeLlmTransport>>["call"];
  calls: Awaited<ReturnType<typeof invokeLlmTransport>>["call"][];
  toolResults: ToolResult[];
  rounds: number;
  blocked: boolean;
}

function parseArguments(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return undefined;
  }
}

function isToolCapability(value: string, gateway: ReturnType<typeof getToolGateway>): value is ToolCapability {
  return Boolean(gateway.getRegistry().getDefinition(value));
}

function toToolDefinition(definition: ReturnType<ReturnType<typeof getToolGateway>["listToolDefinitions"]>[number]): LlmTransportToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, descriptor] of Object.entries(definition.inputSchema)) {
    const raw = String(descriptor);
    const optional = raw.endsWith("?");
    const type = raw.replace(/\?$/, "");
    properties[key] = type === "number" ? { type: "number" } : type === "boolean" ? { type: "boolean" } : type === "object" ? { type: "object", additionalProperties: true } : type === "unknown" ? {} : { type: "string" };
    if (!optional) required.push(key);
  }
  return { name: definition.capability, description: `${definition.toolName} (${definition.riskLevel} risk)`, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export function listNativeToolDefinitions(capabilities?: string[]) {
  let gateway: ReturnType<typeof getToolGateway>;
  try { gateway = getToolGateway(); } catch { return []; }
  const allowed = capabilities ? new Set(capabilities) : undefined;
  return gateway.listToolDefinitions()
    .filter((definition) => !definition.isDeprecated && (!allowed || allowed.has(definition.capability)))
    .map(toToolDefinition);
}

function appendToolMessages(messages: LlmConversationMessage[], assistantText: string, calls: NormalizedToolCall[], results: ToolResult[]) {
  const next = [...messages, { role: "assistant" as const, content: assistantText, toolCalls: calls }];
  for (const result of results) {
    next.push({ role: "tool", toolCallId: result.callId, content: JSON.stringify({
      success: result.success,
      status: result.status,
      data: result.data,
      errorCode: result.errorCode,
      error: result.error,
      evidenceRefs: result.evidenceRefs
    }) });
  }
  return next;
}

/**
 * Provider-neutral native tool loop. The model can propose a tool, but only
 * ToolGateway is allowed to execute it. Write tools stop on an approval
 * interrupt and return a structured result to the caller.
 */
export async function executeLlmCallWithTools(input: NativeToolLoopInput): Promise<NativeToolLoopResult> {
  const maxRounds = Math.min(8, Math.max(0, input.maxToolRounds ?? 4));
  const gateway = getToolGateway();
  const calls: NativeToolLoopResult["calls"] = [];
  const toolResults: ToolResult[] = [];
  let messages = [...(input.messages ?? [{ role: "user" as const, content: input.prompt }])];
  let lastText = "";
  let lastCall: NativeToolLoopResult["call"] | undefined;
  let round = 0;
  for (;;) {
    const response = await invokeLlmTransport({
      ...input,
      messages,
      tools: input.tools,
      countLogicalCall: calls.length === 0 ? input.countLogicalCall : false,
      // Tool loops must preserve a failed stream's non-stream fallback, so
      // automatic transport selection is explicit here.
      transportPreference: input.transportPreference ?? "auto"
    });
    calls.push(response.call);
    lastCall = response.call;
    lastText = response.text;
    const proposed = response.toolCalls ?? [];
    if (!proposed.length) return { text: lastText, call: lastCall, calls, toolResults, rounds: round, blocked: false };
    if (round >= maxRounds) {
      throw Object.assign(new Error("native_tool_round_limit_exceeded"), { llmCall: lastCall, llmCalls: calls, toolResults });
    }
    round += 1;
    const roundResults: ToolResult[] = [];
    for (const proposedCall of proposed) {
      const capability = proposedCall.name;
      const traceId = input.context.runId ? `llm-tool:${input.context.runId}:${proposedCall.callId}` : `llm-tool:${randomUUID()}`;
      void emitTrajectory({
        runId: input.context.runId ?? "unassigned",
        type: "tool.call",
        actor: "llm-provider",
        traceId,
        idempotencyKey: `native-tool:${proposedCall.callId}:proposed`,
        payload: { callId: proposedCall.callId, toolName: capability, round, arguments: proposedCall.arguments, source: "native-tool-call" }
      });
      const parsed = parseArguments(proposedCall.arguments);
      const allowed = input.tools.some((tool) => tool.name === capability);
      if (!parsed || !allowed || !isToolCapability(capability, gateway)) {
        const errorCode = !parsed ? "invalid_tool_arguments" : !allowed ? "native_tool_not_allowed" : "unknown_capability";
        const invalid: ToolResult = {
          callId: proposedCall.callId,
          success: false,
          status: "failed",
          nextState: "blocked",
          errorCode,
          error: { code: errorCode, message: !parsed ? "Native tool arguments must be a JSON object." : !allowed ? `Tool ${capability} is not allowed for this call.` : `Tool ${capability} is not registered.` },
          cacheHit: false,
          durationMs: 0
        };
        roundResults.push(invalid);
        toolResults.push(invalid);
        return { text: lastText, call: lastCall, calls, toolResults, rounds: round, blocked: true };
      }
      const definition = gateway.getRegistry().getDefinition(capability);
      const approved = definition?.approvalRequired ? await input.approveToolCall?.(proposedCall, capability) === true : true;
      const result = await gateway.execute({
        callId: proposedCall.callId,
        capability,
        params: parsed,
        runId: input.context.runId ?? "unassigned",
        traceId,
        toolVersion: definition?.version ?? "1.0.0",
        approved,
        idempotencyKey: `native-tool:${proposedCall.callId}`,
        timeoutMs: input.toolTimeoutMs,
        signal: input.signal
      });
      roundResults.push(result);
      if (result.status === "needs-confirmation") {
        toolResults.push(...roundResults);
        return { text: lastText, call: lastCall, calls, toolResults, rounds: round, blocked: true };
      }
    }
    toolResults.push(...roundResults);
    messages = appendToolMessages(messages, lastText, proposed, roundResults);
  }
}

export type { NormalizedLlmStreamEvent };
