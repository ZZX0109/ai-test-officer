import { createHash } from "node:crypto";

/**
 * Deterministic, key-sorted JSON serialization.
 *
 * Unlike `JSON.stringify`, this produces a byte-stable representation: object
 * keys are sorted recursively and arrays keep order. Two value-equal inputs
 * always yield the same string, so it is safe to use as the seed for an
 * idempotency hash or a tamper-detection digest.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Key-sorted deep clone used by {@link canonicalJson}. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => [key, canonicalize(item)]);
  return Object.fromEntries(entries);
}

/** Stable SHA-256 over the canonical form of `value`. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
