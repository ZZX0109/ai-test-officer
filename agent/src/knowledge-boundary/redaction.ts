import type { KnowledgeBoundaryOutput } from "@ai-test-officer/contracts";

const secretPatterns: Array<[RegExp, string | ((substring: string) => string)]> = [
  [/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, "Bearer [REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(?:password|passwd|secret|token|api[_-]?key|connection[_-]?string)\s*[:=]\s*["']?[^"'\s,;]+/gi, (match) => {
    const separator = match.includes("=") ? "=" : ":";
    return `${match.split(separator)[0]}${separator}[REDACTED]`;
  }],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, "[REDACTED_CONNECTION_STRING]"]
];

export const forbiddenModelPath = /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|id_rsa$|id_ed25519$|[^/]*\.(?:pem|p12|pfx|key))|(^|\/)(?:node_modules|vendor)(\/|$)/i;

export function redactForModel(value: string) {
  return secretPatterns.reduce((current, [pattern, replacement]) => (
    typeof replacement === "string"
      ? current.replace(pattern, replacement)
      : current.replace(pattern, replacement)
  ), value);
}

export function sanitizeKnowledgeContext<T extends {
  claims: Array<{ statement: string; sensitive?: boolean }>;
  unknowns: Array<{ question: string; reason: string }>;
}>(context: T): T {
  return {
    ...context,
    claims: context.claims.map((claim) => {
      const statement = redactForModel(claim.statement);
      return {
        ...claim,
        statement,
        sensitive: claim.sensitive === true || statement !== claim.statement
      };
    }),
    unknowns: context.unknowns.map((item) => ({
      ...item,
      question: redactForModel(item.question),
      reason: redactForModel(item.reason)
    }))
  };
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactForModel(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /password|passwd|secret|token|api[_-]?key|authorization|connection[_-]?string/i.test(key)
          ? "[REDACTED]"
          : redactUnknown(item)
      ])
    );
  }
  return value;
}

export function sanitizeKnowledgeBoundaryOutput(output: KnowledgeBoundaryOutput): KnowledgeBoundaryOutput {
  return {
    ...output,
    inferences: output.inferences.map((item) => ({
      ...item,
      statement: redactForModel(item.statement)
    })),
    assumptions: output.assumptions.map((item) => ({
      ...item,
      statement: redactForModel(item.statement)
    })),
    unknowns: output.unknowns.map(redactForModel),
    blockingQuestions: output.blockingQuestions.map(redactForModel),
    toolRequests: output.toolRequests.map((item) => ({
      ...item,
      input: redactUnknown(item.input) as Record<string, unknown>,
      reason: redactForModel(item.reason)
    })),
    proposedActions: output.proposedActions.map((item) => ({
      ...item,
      reason: redactForModel(item.reason)
    }))
  };
}

export function assertModelSafePath(relativePath: string) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized
    || normalized.includes("\0")
    || normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error("knowledge_path_escape");
  }
  if (forbiddenModelPath.test(normalized)) throw new Error("knowledge_path_forbidden");
  return normalized;
}
