const KNOWLEDGE_STATEMENT_LIMIT = 2_000;

type AssistantGraphProjection = {
  schemaVersion?: string;
  runId?: string;
  threadId?: string;
  mode?: string;
  status?: string;
  currentNode?: string;
  completedNodes?: string[];
  progress?: number;
  pendingInterrupt?: unknown;
  interruptOwner?: string;
  lastError?: { code?: string; message?: string; node?: string };
  tokenUsage?: number;
  repairSessionId?: string;
  recoveryDecision?: unknown;
  recoveryResult?: unknown;
  currentCoverageItemId?: string;
  currentAttemptId?: string;
  browserAgentRequired?: boolean;
  browserLoopComplete?: boolean;
  continuationPasses?: number;
  remainingPathCount?: number;
  updatedAt?: string;
};

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

/**
 * Keep interactive assistant prompts focused on durable run state. The full
 * Graph projection can duplicate large DOM observations and browser payloads
 * that are already represented by resultFacts. Those duplicates previously
 * made ordinary chat fail budget preflight before reaching the provider.
 */
export function compactAssistantGraphProjection(graph: AssistantGraphProjection | undefined) {
  if (!graph) return undefined;
  return {
    schemaVersion: graph.schemaVersion,
    runId: graph.runId,
    threadId: graph.threadId,
    mode: graph.mode,
    status: graph.status,
    currentNode: graph.currentNode,
    completedNodes: graph.completedNodes?.slice(-12) ?? [],
    progress: graph.progress,
    pendingInterrupt: graph.pendingInterrupt,
    interruptOwner: graph.interruptOwner,
    lastError: graph.lastError ? {
      code: compactAssistantContext(graph.lastError.code, 160),
      message: compactAssistantContext(graph.lastError.message, 500),
      node: graph.lastError.node
    } : undefined,
    tokenUsage: graph.tokenUsage,
    repairSessionId: graph.repairSessionId,
    recoveryDecision: graph.recoveryDecision,
    recoveryResult: graph.recoveryResult,
    currentCoverageItemId: graph.currentCoverageItemId,
    currentAttemptId: graph.currentAttemptId,
    browserAgentRequired: graph.browserAgentRequired,
    browserLoopComplete: graph.browserLoopComplete,
    continuationPasses: graph.continuationPasses,
    remainingPathCount: graph.remainingPathCount,
    updatedAt: graph.updatedAt
  };
}

const inlineAssistantClaimId = /\s*\[(?:saved-run-result|machine-gate|run-state|user-message|project-record|browser-page-observations|browser-recent-operations)\]/gi;
const assistantCoverageReference = /coverage_(?:blocked|failed|excluded):[^;；\s。.!！?？]+/gi;

/** The Workbench renders provenance separately; internal claim IDs do not
 * belong in the plain-language reply itself. */
export function stripAssistantInlineClaimIds(value: string) {
  return value.replace(inlineAssistantClaimId, "").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * A provider occasionally echoes an internal coverage ID from the supplied
 * facts. It is still a grounded fact, not a reason to discard an otherwise
 * useful answer. Replace it before the safety boundary so the user sees the
 * consequence instead of the storage identifier.
 */
export function humanizeAssistantCoverageRefs(value: string) {
  const blocked = value.match(/coverage_blocked:[^;；\s。.!！?？]+/gi) ?? [];
  const failed = value.match(/coverage_failed:[^;；\s。.!！?？]+/gi) ?? [];
  const excluded = value.match(/coverage_excluded:[^;；\s。.!！?？]+/gi) ?? [];
  if (!blocked.length && !failed.length && !excluded.length) return value;
  const summary = [
    failed.length ? `${failed.length} 条路径验证失败` : undefined,
    blocked.length ? `${blocked.length} 条路径缺少可执行入口、操作条件或验证条件` : undefined,
    excluded.length ? `${excluded.length} 条路径不适用于本次运行` : undefined
  ].filter(Boolean).join("；");
  let inserted = false;
  return value
    .replace(assistantCoverageReference, () => {
      if (inserted) return "";
      inserted = true;
      return summary;
    })
    .replace(/[；;]\s*[；;]+/g, "；")
    .replace(/[；;]\s*(?=[。.!！?？]|$)/g, "");
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
