import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/**
 * Shadow-mode side-effect firewall.
 *
 * Shadow runs exist to *predict* what the graph would do so the prediction can
 * be compared against the legacy execution chain. A shadow run that writes a
 * run bundle, creates a repair session, calls a paid model or mutates a repair
 * plan corrupts the very baseline it is supposed to measure — and silently
 * inflates the acceptance statistics.
 *
 * Rather than sprinkling `if (mode === "shadow")` checks across a dozen nodes
 * (which is exactly how the previous leaks happened), every graph hook runs
 * inside an async scope declared once by the orchestration middleware. Each
 * side-effecting store then asks this module for permission. Adding a new node
 * therefore cannot introduce a new leak: the store refuses regardless of which
 * node calls it.
 */

export type GraphExecutionMode = "shadow" | "active";

export interface GraphExecutionScope {
  mode: GraphExecutionMode;
  runId: string;
  /** Side effects blocked during this scope, for the shadow diff report. */
  blocked: string[];
}

const storage = new AsyncLocalStorage<GraphExecutionScope>();

/** Operations that must never run in shadow mode. */
export type GuardedSideEffect =
  | "run-bundle-write"
  | "proof-bundle-write"
  | "repair-plan-write"
  | "repair-plan-status"
  | "repair-session-create"
  | "repair-session-validate"
  | "repair-proposal"
  | "llm-judge-call"
  | "run-event-append"
  | "notification-send"
  | "project-state-write"
  | "artifact-submit";

/**
 * Declares the execution scope for one graph node.
 *
 * The orchestration middleware calls this around *every* hook, so any store
 * reached transitively — however deep — sees the correct mode.
 */
export function withGraphExecutionScope<T>(
  scope: Pick<GraphExecutionScope, "mode" | "runId">,
  fn: () => Promise<T>
): Promise<T> {
  const existing = storage.getStore();
  // Nested nodes share the outermost scope so the blocked list stays complete.
  if (existing && existing.runId === scope.runId) return fn();
  return storage.run({ ...scope, blocked: [] }, fn);
}

export function currentGraphScope(): GraphExecutionScope | undefined {
  return storage.getStore();
}

/** True when the caller is executing inside a shadow graph run. */
export function isShadowExecution(): boolean {
  return storage.getStore()?.mode === "shadow";
}

/**
 * Records a blocked side effect and reports whether the caller must skip it.
 *
 * Returns `false` outside any graph scope: direct API calls, workers and CLI
 * paths are not shadow runs and must keep working unchanged.
 */
export function shouldBlockSideEffect(effect: GuardedSideEffect): boolean {
  const scope = storage.getStore();
  if (!scope || scope.mode !== "shadow") return false;
  if (!scope.blocked.includes(effect)) scope.blocked.push(effect);
  return true;
}

/**
 * Hard guard for effects that have no meaningful no-op result.
 *
 * Throwing (instead of silently skipping) surfaces a shadow leak during tests
 * rather than letting it corrupt production data.
 */
export function assertSideEffectAllowed(effect: GuardedSideEffect): void {
  if (shouldBlockSideEffect(effect)) {
    throw new Error(`graph_shadow_side_effect_blocked:${effect}`);
  }
}

/**
 * Runs `fn` only outside shadow mode; returns `fallback` when blocked.
 *
 * Use for effects whose absence the caller can tolerate (an event append, a
 * notification), keeping the shadow prediction itself intact.
 */
export async function guardSideEffect<T>(
  effect: GuardedSideEffect,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (shouldBlockSideEffect(effect)) return fallback;
  return fn();
}

/**
 * Isolated output root for shadow predictions.
 *
 * Shadow results never share a directory with real evidence so an operator (or
 * a retention job) can delete them without touching the audit trail.
 */
export function shadowResultDir(reportsDir: string, runId: string): string {
  return path.join(reportsDir, "_shadow", runId);
}

/**
 * Marker written onto historical shadow results that were produced before the
 * firewall existed and therefore may have leaked side effects. Results carrying
 * this marker must be excluded from acceptance statistics.
 */
export const SHADOW_INVALIDATED_MARKER = "shadow_invalidated_side_effects";
