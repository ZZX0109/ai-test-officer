/**
 * Machine-readable provider capability matrix used by deployment checks and
 * operator documentation. The transport adapter remains the source of truth
 * for wire compatibility; this module makes the decision visible without
 * exposing credentials or making a network request.
 */

export type LlmCapabilityTransport = "chat-completions" | "responses" | "anthropic";

export interface LlmCapabilityMatrixEntry {
  id: "chat-completions" | "codex-responses" | "anthropic-messages";
  label: string;
  providers: string[];
  transport: LlmCapabilityTransport;
  streaming: "sse";
  nativeToolCalling: string;
  structuredOutput: string;
  fallback: string;
  caveat?: string;
}

export const LLM_CAPABILITY_MATRIX: readonly LlmCapabilityMatrixEntry[] = [
  {
    id: "chat-completions",
    label: "OpenAI-compatible Chat Completions",
    providers: ["openai", "openai-compatible", "openrouter", "custom"],
    transport: "chat-completions",
    streaming: "sse",
    nativeToolCalling: "tool_calls.function",
    structuredOutput: "response_format.json_schema (SophNet falls back to json_object)",
    fallback: "stream → stream retry → non-stream",
    caveat: "上游必须正确发送 data: JSON 与 [DONE]；自定义网关的工具字段以兼容 OpenAI 为准。"
  },
  {
    id: "codex-responses",
    label: "Codex Responses",
    providers: ["openai", "openai-compatible"],
    transport: "responses",
    streaming: "sse",
    nativeToolCalling: "function_call / function_call_output",
    structuredOutput: "text.format.json_schema",
    fallback: "stream → stream retry → non-stream",
    caveat: "仅当模型名包含 codex 时选择 Responses 端点；其他 openai-compatible 模型仍走 Chat。"
  },
  {
    id: "anthropic-messages",
    label: "Anthropic Messages",
    providers: ["anthropic"],
    transport: "anthropic",
    streaming: "sse",
    nativeToolCalling: "tool_use / tool_result",
    structuredOutput: "由调用方 Zod/JSON Schema 校验",
    fallback: "stream → stream retry → non-stream",
    caveat: "使用 x-api-key 与 anthropic-version 请求头；system 独立于 messages。"
  }
] as const;

export function resolveLlmCapability(provider: string, model: string, baseUrl = "") {
  if (provider === "anthropic") return LLM_CAPABILITY_MATRIX[2];
  if ((provider === "openai-compatible" || provider === "openai") && /codex/i.test(model)) return LLM_CAPABILITY_MATRIX[1];
  const entry = LLM_CAPABILITY_MATRIX[0];
  return baseUrl && /sophnet/i.test(baseUrl)
    ? { ...entry, caveat: `${entry.caveat} SophNet 结构化输出使用 json_object。` }
    : entry;
}
