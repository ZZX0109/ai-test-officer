const sensitiveKeyPattern = /(authorization|cookie|set-cookie|api[-_]?key|token|password|passwd|secret|credential|private[-_]?key)/i;
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
      if (sensitiveKeyPattern.test(key)) {
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
      output[key] = sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactValue(nested);
    }
    return output;
  }
  return value;
}

export function redactRecord<T extends Record<string, unknown>>(value: T): T {
  return redactValue(value) as T;
}
