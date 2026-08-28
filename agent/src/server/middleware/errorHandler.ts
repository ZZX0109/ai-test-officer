import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { redactText, redactValue } from "../../redaction.js";

/**
 * Centralized Express error-handling middleware.
 *
 * Maps domain errors to HTTP status codes while redacting sensitive content
 * from both the response body and server logs. This is the terminal error
 * handler: it MUST be registered last (after all routes and routers).
 *
 * Rules (preserve exactly when moving logic here):
 * - ZodError -> 400 with flattened details
 * - CORS / organization / project forbidden -> 403
 * - repair conflicts / source_changed / version conflict -> 409
 * - repair path escape / forbidden change -> 403
 * - everything else -> 500 (message redacted)
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  if (error instanceof Error && error.message === "CORS origin not allowed") {
    res.status(403).json({ error: "CORS origin not allowed" });
    return;
  }
  if (error instanceof Error && error.message === "organization_forbidden") {
    res.status(403).json({ error: "organization_forbidden" });
    return;
  }
  if (error instanceof Error && error.message === "project_forbidden") {
    res.status(403).json({ error: "project_forbidden" });
    return;
  }
  if (error instanceof Error && error.message === "project_not_found_or_forbidden") {
    res.status(404).json({ error: "project_not_found_or_forbidden" });
    return;
  }
  if (error instanceof Error && error.message === "project_scope_forbidden") {
    res.status(403).json({ error: "project_scope_forbidden" });
    return;
  }
  // The Workbench may finish a run while a queued viewport refresh is still
  // in flight. That is an expected lifecycle race, not an application crash;
  // return a retryable conflict instead of logging it as an unhandled error.
  if (error instanceof Error && error.message === "browser_session_not_active") {
    res.status(409).json({ error: "browser_session_not_active" });
    return;
  }
  if (error instanceof Error && (
    error.message === "repair_host_apply_disabled"
    || error.message === "repair_high_risk_confirmation_required"
    || error.message === "repair_validation_required"
    || error.message === "source_changed"
    || error.message.startsWith("repair_version_conflict:")
    || error.message.startsWith("target_worktree_dirty:")
    || error.message === "test_asset_validation_required"
    || error.message === "asset_branch_exists"
    || error.message === "source_run_not_trusted"
    || error.message === "test_data_contract_not_found"
    || error.message === "test_data_contract_project_mismatch"
    || error.message === "oracle_spec_not_found"
    || error.message === "oracle_spec_project_mismatch"
    || error.message.startsWith("repository_source_hash_mismatch")
    || error.message === "asset_write_not_visible"
  )) {
    res.status(409).json({ error: redactText(error.message) });
    return;
  }
  if (error instanceof Error && (
    error.message === "repair_path_escape"
    || error.message === "repair_path_forbidden"
    || error.message === "repair_contains_forbidden_change"
    || error.message === "asset_path_forbidden"
    || error.message === "asset_dependency_forbidden"
    || error.message === "asset_apply_policy_denied"
    || error.message === "asset_repository_root_forbidden"
  )) {
    res.status(403).json({ error: redactText(error.message) });
    return;
  }
  if (error instanceof Error && (
    error.message.startsWith("knowledge_tool_not_allowed")
    || error.message.startsWith("knowledge_tool_requires_capability_interrupt")
    || error.message.startsWith("knowledge_capability_not_allowed")
    || error.message.startsWith("knowledge_action_requires_interrupt")
    || error.message.startsWith("knowledge_path_")
  )) {
    res.status(403).json({ error: redactText(error.message) });
    return;
  }
  if (error instanceof Error && (
    error.message.startsWith("knowledge_source_cross_")
    || error.message.startsWith("knowledge_boundary_")
    || error.message.startsWith("knowledge_claim_")
    || error.message.startsWith("knowledge_unknown_")
    || error.message.startsWith("knowledge_expired_")
    || error.message.startsWith("knowledge_unverified_")
  )) {
    res.status(409).json({ error: redactText(error.message) });
    return;
  }
  const safeError = error instanceof Error
    ? { name: error.name, message: redactText(error.message), stack: error.stack ? redactText(error.stack) : undefined }
    : redactValue(error);
  console.error("Unhandled agent error", safeError);
  res.status(500).json({ error: error instanceof Error ? redactText(error.message) : "Internal server error" });
}
