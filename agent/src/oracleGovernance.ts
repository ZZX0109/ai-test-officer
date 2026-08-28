import type {
  GateStatus,
  OracleDecisionV2,
  OracleSpecV2,
  OracleSourceV2
} from "@ai-test-officer/contracts";
import { oracleDecisionV2Schema, oracleSpecV2Schema } from "@ai-test-officer/contracts";
import { canonicalSha256 } from "./canonicalHash.js";

export interface OracleEvaluationContext {
  actual?: unknown;
  now?: Date;
  differential?: boolean;
  evidenceRefs?: string[];
}

function compare(actual: unknown, expected: unknown, operator: OracleSpecV2["comparison"]["operator"]): boolean {
  switch (operator) {
    case "equals":
    case "snapshot-equals":
      return canonicalSha256(actual) === canonicalSha256(expected);
    case "not-equals":
      return canonicalSha256(actual) !== canonicalSha256(expected);
    case "contains":
      return typeof actual === "string" && actual.includes(String(expected));
    case "all-contains":
      return Array.isArray(actual) && actual.every((item) => String(item).includes(String(expected)));
    case "status-in":
      return Array.isArray(expected) && expected.some((item) => canonicalSha256(item) === canonicalSha256(actual));
    case "json-schema":
      return actual !== undefined && actual !== null;
    case "changed":
      return canonicalSha256(actual) !== canonicalSha256(expected);
  }
}

function sourceAllowsRelease(source: OracleSourceV2, confirmation: OracleSpecV2["humanConfirmation"]): boolean {
  if (source.kind === "user-confirmed-acceptance") return confirmation.status === "confirmed";
  return source.kind === "formal-contract";
}

function isExpired(spec: OracleSpecV2, now: Date): boolean {
  return spec.lifecycle.status !== "active"
    || (spec.lifecycle.expiresAt !== undefined && new Date(spec.lifecycle.expiresAt).getTime() <= now.getTime());
}

function blockedDecision(spec: OracleSpecV2, reasons: string[], context: OracleEvaluationContext): OracleDecisionV2 {
  return oracleDecisionV2Schema.parse({
    schemaVersion: "2.0",
    oracleId: spec.id,
    status: "blocked",
    releaseEligible: false,
    differentialEligible: false,
    reasons,
    actual: context.actual,
    expected: spec.comparison.expected,
    evidenceRefs: context.evidenceRefs ?? spec.runEvidence.evidenceRefs,
    evaluatedAt: (context.now ?? new Date()).toISOString()
  });
}

/**
 * Single policy chokepoint for every V2 Oracle. A matching value is not enough
 * to produce a release pass: provenance, freshness, conflicts and evidence are
 * checked first, and LLM/history sources remain human-review-only.
 */
export function evaluateOracleSpec(raw: OracleSpecV2, context: OracleEvaluationContext = {}): OracleDecisionV2 {
  const spec = oracleSpecV2Schema.parse(raw);
  const now = context.now ?? new Date();
  const evidenceRefs = context.evidenceRefs ?? spec.runEvidence.evidenceRefs;
  const reasons: string[] = [];

  if (isExpired(spec, now)) reasons.push("oracle_expired_or_reconfirmation_required");
  if (spec.conflictRefs.length > 0) reasons.push("oracle_conflict");
  if (spec.humanConfirmation.status === "rejected") reasons.push("oracle_human_confirmation_rejected");
  if (evidenceRefs.length === 0) reasons.push("oracle_evidence_missing");
  if (context.actual === undefined) reasons.push("oracle_actual_missing");
  if (reasons.length > 0) return blockedDecision(spec, reasons, { ...context, now, evidenceRefs });

  const matches = compare(context.actual, spec.comparison.expected, spec.comparison.operator);
  const differentialEligible = spec.source.kind === "base-behavior"
    ? Boolean(context.differential)
    : spec.source.kind === "formal-contract" || spec.source.kind === "user-confirmed-acceptance";
  const releaseEligible = spec.decisionUse === "release"
    && sourceAllowsRelease(spec.source, spec.humanConfirmation)
    && differentialEligible;

  if (spec.source.kind === "llm-inference" || spec.source.kind === "historical-behavior" || spec.source.kind === "legacy") {
    reasons.push("source_is_advisory_only");
  }
  if (spec.decisionUse === "review-only") reasons.push("oracle_is_review_only");
  if (spec.decisionUse === "advisory") reasons.push("oracle_is_advisory_only");
  if (!differentialEligible) reasons.push("oracle_not_eligible_for_this_context");

  const status: GateStatus = !matches
    ? "fail"
    : reasons.length > 0
      ? "needs-human-review"
      : "pass";
  return oracleDecisionV2Schema.parse({
    schemaVersion: "2.0",
    oracleId: spec.id,
    status,
    releaseEligible,
    differentialEligible,
    reasons,
    actual: context.actual,
    expected: spec.comparison.expected,
    evidenceRefs,
    evaluatedAt: now.toISOString()
  });
}

export function evaluateOracleSet(
  specs: OracleSpecV2[],
  actualByOracleId: Record<string, unknown>,
  context: Omit<OracleEvaluationContext, "actual"> = {}
) {
  const decisions = specs.map((spec) => evaluateOracleSpec(spec, {
    ...context,
    actual: actualByOracleId[spec.id]
  }));
  const hasBlocked = decisions.some((decision) => decision.status === "blocked");
  const hasFailure = decisions.some((decision) => decision.status === "fail");
  const hasReview = decisions.some((decision) => decision.status === "needs-human-review");
  return {
    decisions,
    status: (hasBlocked ? "blocked" : hasFailure ? "fail" : hasReview ? "needs-human-review" : "pass") as GateStatus,
    releaseEligible: decisions.length > 0 && decisions.every((decision) => decision.releaseEligible && decision.status === "pass"),
    differentialEligible: decisions.length > 0 && decisions.every((decision) => decision.differentialEligible)
  };
}

export function legacyOracleAsReviewOnly(input: {
  id: string;
  projectId: string;
  coverageItemId: string;
  description: string;
  expected: unknown;
  runId: string;
  evidenceRefs?: string[];
}): OracleSpecV2 {
  const now = new Date().toISOString();
  const sourceId = `legacy:${input.id}`;
  return oracleSpecV2Schema.parse({
    schemaVersion: "2.0",
    id: input.id,
    projectId: input.projectId,
    coverageItemId: input.coverageItemId,
    type: "custom",
    description: input.description,
    preconditions: [],
    observationWindow: { start: "after-action", timeoutMs: 20_000, pollIntervalMs: 500 },
    comparison: { operator: "equals", expected: input.expected },
    source: { kind: "legacy", id: sourceId, version: "legacy", sha256: canonicalSha256(sourceId) },
    decisionUse: "review-only",
    conflictRefs: [],
    humanConfirmation: { status: "not-required" },
    lifecycle: { status: "active" },
    runEvidence: { runId: input.runId, evidenceRefs: input.evidenceRefs ?? [], artifactIds: [] },
    createdAt: now,
    updatedAt: now
  });
}
