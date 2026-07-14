// Keep security secrets out of persisted evidence without destroying ordinary
// telemetry such as promptTokens, completionTokens, totalTokens or apiVersion.
// The previous broad `token` match made real benchmark cost/accounting data
// unverifiable after report persistence.
const sensitiveKeyPattern = /(authorization|cookie|set-cookie|api[-_]?key|password|passwd|secret|private[-_]?key|token)$/i;
const safeTelemetryKeys = new Set(["prompttokens", "completiontokens", "totaltokens", "maxtokens"]);

function isSensitiveKey(key: string) {
  return !safeTelemetryKeys.has(key.replace(/[-_]/g, "").toLowerCase()) && sensitiveKeyPattern.test(key);
}
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const webhookUrlPattern = /\bhttps?:\/\/[^\s"'<>)]*(?:webhook|hooks?)[^\s"'<>)]*/gi;
const keyValuePattern = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|cookie|session|webhook[_-]?key|key)=([^&\s]+)/gi;

export function redactText(value: string) {
  return value
    .replaceAll(webhookUrlPattern, "[REDACTED_WEBHOOK_URL]")
    .replaceAll(bearerPattern, "Bearer [REDACTED]")
    .replaceAll(keyValuePattern, "$1=[REDACTED]");
}

export function redactUrl(value: string | undefined) {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveKey(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return redactText(parsed.toString());
  } catch {
    return redactText(value);
  }
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(nested);
    }
    return output;
  }
  return value;
}

export function redactRecord<T extends Record<string, unknown>>(value: T): T {
  return redactValue(value) as T;
}
