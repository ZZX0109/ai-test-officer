const KNOWLEDGE_STATEMENT_LIMIT = 2_000;

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function compactKnowledgeStatement(value: unknown, limit = KNOWLEDGE_STATEMENT_LIMIT) {
  const text = compactWhitespace(typeof value === "string" ? value : JSON.stringify(value ?? ""));
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 24))}… [内容已截断]`;
}

export function compactAssistantContext(value: unknown, limit: number) {
  const compact = compactKnowledgeStatement(value, limit);
  return compact
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|afk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Some OpenAI-compatible JSON-object providers preserve the requested top
 * level fields but use `summary`/`evidence` inside reasoningSummary. Normalize
 * those harmless aliases before strict Zod validation; knowledge citations,
 * capabilities and actions remain untouched and are still validated later.
 */
export function normalizeAssistantOutputShape(value: unknown) {
  const output = record(value);
  if (!output) return value;
  const reasoning = record(output.reasoningSummary);
  if (!reasoning) return value;
  const evidence = Array.isArray(reasoning.evidence)
    ? reasoning.evidence.map((item) => compactAssistantContext(item, 300)).filter(Boolean).slice(0, 6)
    : [];
  const suggestedAction = stringValue(output.suggestedAction) ?? "none";
  const requiresConfirmation = output.requiresConfirmation === true;
  const intent = stringValue(output.intent);
  const phase = stringValue(reasoning.phase)
    ?? (requiresConfirmation ? "waiting-user" : intent === "failure-question" ? "diagnosing" : "completed");
  return {
    ...output,
    reasoningSummary: {
      phase,
      observations: Array.isArray(reasoning.observations) ? reasoning.observations : evidence,
      assessment: stringValue(reasoning.assessment)
        ?? stringValue(reasoning.summary)
        ?? stringValue(output.reply)
        ?? "当前没有可展示的补充判断。",
      nextStep: stringValue(reasoning.nextStep)
        ?? (suggestedAction === "none" ? "保留当前机器结论并继续既定流程。" : "等待确认后执行建议操作。"),
      userAction: stringValue(reasoning.userAction)
        ?? (requiresConfirmation ? "请确认是否执行建议操作。" : "无需操作。"),
      confidence: stringValue(reasoning.confidence) ?? "medium"
    }
  };
}
