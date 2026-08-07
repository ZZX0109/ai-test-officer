/**
 * Agent Context Layer — 数据脱敏与权限过滤
 *
 * 所有通过 Context Layer 输出的数据必须经过脱敏处理。
 * Secret/PII 信息在输出前被自动替换。
 */

import { createHash } from "node:crypto";

export interface RedactionRule {
  pattern: RegExp;
  replacement: string | ((match: string) => string);
  reason: string;
}

const SECRET_PATTERNS: RedactionRule[] = [
  { pattern: /(?:api[_-]?key|apikey|secret|token|password|credential)\s*[:=]\s*["']?[\w.\-+/=]{16,}["']?/gi, replacement: (m) => `${m.split(/[:=]/)[0]}=[REDACTED_SECRET]`, reason: "credential_secret" },
  { pattern: /Bearer\s+[\w.\-+/=]{16,}/gi, replacement: "Bearer [REDACTED_TOKEN]", reason: "auth_token" },
  { pattern: /Authorization:\s*[\w.\-+/=]{16,}/gi, replacement: "Authorization: [REDACTED]", reason: "auth_header" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: "[REDACTED_API_KEY]", reason: "openai_key_pattern" },
  { pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^@\s]+@/gi, replacement: (m) => m.replace(/\/\/[^@]+@/, "//[REDACTED]@"), reason: "db_connection_string" },
];

const PII_PATTERNS: RedactionRule[] = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: "[REDACTED_EMAIL]", reason: "email_pii" },
  { pattern: /(?:phone|mobile|tel)[\s:=]+[+\d\-()\s]{7,}/gi, replacement: (m) => `${m.split(/[:=]/)[0]}=[REDACTED_PHONE]`, reason: "phone_pii" },
  { pattern: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/g, replacement: "[REDACTED_SSN]", reason: "ssn_pii" },
];

const PATH_REDACTION_RULES: RedactionRule[] = [
  { pattern: /\/Users\/[^/\s]+/g, replacement: "/Users/[REDACTED_USER]", reason: "user_home_path" },
];

export interface RedactionResult {
  text: string;
  redactions: Array<{ field: string; reason: string }>;
}

export function redactSecrets(text: string): RedactionResult {
  let result = text;
  const redactions: Array<{ field: string; reason: string }> = [];

  for (const rule of SECRET_PATTERNS) {
    const before = result;
    result = typeof rule.replacement === "function"
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement);
    if (result !== before) {
      redactions.push({ field: rule.reason, reason: "secret_redacted" });
    }
  }

  return { text: result, redactions };
}

export function redactPII(text: string): RedactionResult {
  let result = text;
  const redactions: Array<{ field: string; reason: string }> = [];

  for (const rule of PII_PATTERNS) {
    const before = result;
    result = typeof rule.replacement === "function"
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement);
    if (result !== before) {
      redactions.push({ field: rule.reason, reason: "pii_redacted" });
    }
  }

  return { text: result, redactions };
}

export function redactPaths(text: string): RedactionResult {
  let result = text;
  const redactions: Array<{ field: string; reason: string }> = [];

  for (const rule of PATH_REDACTION_RULES) {
    const before = result;
    result = typeof rule.replacement === "function"
      ? result.replace(rule.pattern, rule.replacement)
      : result.replace(rule.pattern, rule.replacement);
    if (result !== before) {
      redactions.push({ field: rule.reason, reason: "path_redacted" });
    }
  }

  return { text: result, redactions };
}

export function redactAll(text: string): RedactionResult {
  let current = text;
  const allRedactions: Array<{ field: string; reason: string }> = [];

  for (const redact of [redactSecrets, redactPII, redactPaths]) {
    const result = redact(current);
    current = result.text;
    allRedactions.push(...result.redactions);
  }

  const uniqueRedactions = allRedactions.filter(
    (item, index, self) => self.findIndex((t) => t.field === item.field) === index
  );

  return { text: current, redactions: uniqueRedactions };
}

export function hashSensitive(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export function truncateByTokenBudget(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(text);
  if (estimatedTokens <= maxTokens) return text;

  const ratio = maxTokens / estimatedTokens;
  const targetLength = Math.floor(text.length * ratio * 0.9);
  return text.slice(0, targetLength) + "\n\n[Context truncated: token budget exceeded]";
}
