import type { AssertionResult } from "./types.js";

export type RetryReason = "browser_start" | "transient_network" | "selector_temporarily_missing" | "timeout";

export function classifyRetry(input: { assertions: AssertionResult[]; attempt: number; maxAttempts: number }) {
  if (input.attempt >= input.maxAttempts) return { retryable: false, reason: "attempt_budget_exhausted" } as const;
  const failed = input.assertions.filter((assertion) => !assertion.passed);
  if (!failed.length) return { retryable: false, reason: "no_failure" } as const;
  if (failed.some((assertion) => assertion.fact?.failureClass === "product_bug")) {
    return { retryable: false, reason: "deterministic_business_assertion" } as const;
  }
  const text = failed.map((assertion) => `${assertion.name} ${assertion.actual}`).join(" ").toLowerCase();
  if (/permission|unauthorized|forbidden|金额|amount|状态错误|wrong state/.test(text)) {
    return { retryable: false, reason: "non_retryable_business_or_permission_failure" } as const;
  }
  if (/selector|locator|not visible|detached/.test(text)) return { retryable: true, reason: "selector_temporarily_missing" as RetryReason };
  if (/network|econnreset|socket|503|502/.test(text)) return { retryable: true, reason: "transient_network" as RetryReason };
  if (/timeout|timed out|waiting/.test(text)) return { retryable: true, reason: "timeout" as RetryReason };
  return { retryable: false, reason: "failure_not_allowlisted" } as const;
}
