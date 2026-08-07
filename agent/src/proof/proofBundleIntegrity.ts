import type { MachineGate } from "@ai-test-officer/contracts";
import type { ProofVerdict } from "./proofBundleValidator.js";
import { PROOF_VALIDATION_VERSION, type VerifiedMachineGate } from "./proofBundleService.js";
import { canonicalSha256 } from "../canonicalHash.js";

/**
 * P0.2 credibility + attempt-binding guards.
 *
 * These are the *read/assertion-side* companions to `proofBundleService`
 * (the only module allowed to mint a `VerifiedMachineGate`). They let any
 * consumer prove that a gate was actually minted by the service (not a
 * self-asserted literal) and that a proof record is bound to an attempt that
 * genuinely belongs to the target run — closing the cross-Attempt injection
 * gap that the `(attempt_id, run_id)` foreign key alone cannot catch for
 * sibling attempts inside the same run.
 */

export class CredibilityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CredibilityError";
  }
}

export interface CanonicalInput {
  runId: string;
  attemptId?: string;
  scenarioId?: string;
  status: string;
  reasons: string[];
  reasonDetails: unknown[];
  assertionFailures: string[];
  evidenceComplete: boolean;
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
  gateEligible: boolean;
  proofValidationVersion: string;
}

/**
 * Deterministic hash over the credibility-bearing fields of a gate. Used to
 * detect tampering of a *persisted* gate versus the values derived at mint
 * time. Stable across processes (no randomness, key-sorted canonical JSON).
 */
export function buildProofBundleCanonicalSha256(input: CanonicalInput): string {
  return canonicalSha256({
    runId: input.runId,
    attemptId: input.attemptId ?? null,
    scenarioId: input.scenarioId ?? null,
    status: input.status,
    reasons: [...input.reasons].sort(),
    reasonDetails: input.reasonDetails,
    assertionFailures: [...input.assertionFailures].sort(),
    evidenceComplete: input.evidenceComplete,
    artifactIntegrityVerified: input.artifactIntegrityVerified,
    evidenceGrounded: input.evidenceGrounded,
    gateEligible: input.gateEligible,
    proofValidationVersion: input.proofValidationVersion
  });
}

/**
 * Assertion guard: a `MachineGate` is only trustworthy if it carries a
 * `proofBundleId` minted by `finalizeProofBundle()` and a current validation
 * version. A literal built anywhere else (which the static gate already
 * forbids *assigning* credibility to) also fails this *assertion* guard.
 */
export function assertVerifiedMachineGate(gate: MachineGate | VerifiedMachineGate): asserts gate is VerifiedMachineGate {
  const verified = gate as VerifiedMachineGate;
  if (typeof verified.proofBundleId !== "string" || verified.proofBundleId.length === 0) {
    throw new CredibilityError(
      "unverified_machine_gate",
      "MachineGate.proofBundleId is missing — it was not minted by finalizeProofBundle()."
    );
  }
  if (verified.proofValidationVersion !== PROOF_VALIDATION_VERSION) {
    throw new CredibilityError(
      "proof_version_mismatch",
      `MachineGate.proofValidationVersion ${String(verified.proofValidationVersion)} != ${PROOF_VALIDATION_VERSION}.`
    );
  }
  if (typeof verified.evidenceComplete !== "boolean") {
    throw new CredibilityError("evidence_complete_missing", "MachineGate.evidenceComplete is not a boolean.");
  }
}

/**
 * Synchronous, structural check of a *persisted* verified gate versus the
 * verdict it was derived from. Returns a list of issue codes (empty == consistent).
 *
 * The gate itself only carries `evidenceComplete` / `proofBundleId` /
 * `proofValidationVersion`; `evidenceGrounded` / `artifactIntegrityVerified`
 * are verdict-level facts that a persisted gate may optionally mirror. We cross
 * check the gate's own fields unconditionally, and the verdict-level fields
 * only when the gate actually carries them.
 */
export function validatePersistedCredibility(
  gate: VerifiedMachineGate,
  verdict: Pick<ProofVerdict, "artifactIntegrityVerified" | "evidenceGrounded" | "evidenceComplete">
): string[] {
  const issues: string[] = [];
  if (gate.evidenceComplete !== verdict.evidenceComplete) issues.push("evidenceComplete_mismatch");
  if (gate.proofValidationVersion !== PROOF_VALIDATION_VERSION) issues.push("proof_version_mismatch");
  if (typeof gate.proofBundleId !== "string" || gate.proofBundleId.length === 0) issues.push("missing_proofBundleId");
  const mirrored = gate as unknown as Record<string, unknown>;
  if (typeof mirrored.evidenceGrounded === "boolean" && mirrored.evidenceGrounded !== verdict.evidenceGrounded)
    issues.push("evidenceGrounded_mismatch");
  if (
    typeof mirrored.artifactIntegrityVerified === "boolean" &&
    mirrored.artifactIntegrityVerified !== verdict.artifactIntegrityVerified
  )
    issues.push("artifactIntegrityVerified_mismatch");
  return issues;
}

export interface PersistedProofBundleRecord {
  id: string;
  runId: string;
  attemptId: string | null;
  scenarioId: string | null;
  status: string;
  reasons: unknown;
  reasonDetails: unknown;
  assertionFailures: unknown;
  evidenceComplete: boolean;
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
  gateEligible: boolean;
  proofBundleId: string;
  proofValidationVersion: string;
  canonicalSha256: string;
}

/**
 * Full, tamper-evident verification of a persisted proof bundle record against
 * the gate it was minted from. This is the production gate used by the
 * persistence layer: it re-reads the authoritative row from `proof_bundles_v1`,
 * confirms the `proofBundleId` matches, that `run_id` / `scenario_id` /
 * `attempt_id` are consistent with the gate, that the persisted canonical hash
 * still recomputes to the same value, and that every evidence item bound to the
 * gate actually belongs to the same attempt.
 *
 * `loadRecord` is injected so the check is unit-testable without a live
 * database; production passes the ledger read function.
 */
export async function verifyPersistedProofBundle(input: {
  runId: string;
  gate: VerifiedMachineGate;
  verdict: Pick<ProofVerdict, "artifactIntegrityVerified" | "evidenceGrounded" | "evidenceComplete">;
  evidenceAttemptIds: string[];
  loadRecord: (proofBundleId: string) => Promise<PersistedProofBundleRecord | undefined>;
}): Promise<string[]> {
  const issues = validatePersistedCredibility(input.gate, input.verdict);
  const record = await input.loadRecord(input.gate.proofBundleId);
  if (!record) {
    issues.push("proof_record_missing");
    return issues;
  }
  if (record.proofBundleId !== input.gate.proofBundleId) issues.push("proof_bundle_id_mismatch");
  if (record.runId !== input.runId) issues.push("run_id_mismatch");
  if (record.attemptId && input.gate.attemptId && record.attemptId !== input.gate.attemptId)
    issues.push("attempt_id_mismatch");
  if (record.scenarioId && input.gate.scenarioId && record.scenarioId !== input.gate.scenarioId)
    issues.push("scenario_id_mismatch");
  if (record.evidenceComplete !== input.gate.evidenceComplete) issues.push("evidenceComplete_record_mismatch");
  const recomputed = buildProofBundleCanonicalSha256({
    runId: record.runId,
    attemptId: record.attemptId ?? undefined,
    scenarioId: record.scenarioId ?? undefined,
    status: record.status,
    reasons: (record.reasons as string[]) ?? [],
    reasonDetails: (record.reasonDetails as unknown[]) ?? [],
    assertionFailures: (record.assertionFailures as string[]) ?? [],
    evidenceComplete: record.evidenceComplete,
    artifactIntegrityVerified: record.artifactIntegrityVerified,
    evidenceGrounded: record.evidenceGrounded,
    gateEligible: record.gateEligible,
    proofValidationVersion: record.proofValidationVersion
  });
  if (recomputed !== record.canonicalSha256) issues.push("canonical_hash_mismatch");
  // Every evidence item bound to the gate must belong to the same attempt.
  const distinctAttempts = new Set(input.evidenceAttemptIds);
  if (record.attemptId && distinctAttempts.size > 0 && !distinctAttempts.has(record.attemptId)) {
    issues.push("evidence_attempt_binding_mismatch");
  }
  return issues;
}

export interface AttemptBindingContext {
  runId: string;
  validAttemptIds: string[];
}

export interface AttemptBoundRecord {
  kind: string;
  refId: string;
  attemptId?: string;
  runId?: string;
}

/**
 * Transactional guard used at the persistence boundary. A proof record may only
 * be written against an attempt that is actually part of the target run. This
 * prevents an Attempt (or a re-run / shadow) from injecting
 * evidence/conclusions into a sibling or wrong Attempt — the gap the
 * `(attempt_id, run_id)` foreign key cannot catch, because a sibling attempt in
 * the same run is a *valid* foreign key.
 *
 * Throws `CredibilityError` with code `cross_attempt_injection` (or
 * `missing_attempt_id`). Callers wrap this inside a DB transaction so a
 * violation rolls back the entire persist.
 */
export function assertAttemptBinding(ctx: AttemptBindingContext, record: AttemptBoundRecord): void {
  if (record.runId && record.runId !== ctx.runId) {
    throw new CredibilityError(
      "cross_attempt_injection",
      `record ${record.kind}:${record.refId} carries runId ${record.runId} but the persistence target is run ${ctx.runId}.`
    );
  }
  if (!record.attemptId) {
    throw new CredibilityError(
      "missing_attempt_id",
      `record ${record.kind}:${record.refId} has no attemptId and cannot be bound to a run.`
    );
  }
  if (!ctx.validAttemptIds.includes(record.attemptId)) {
    throw new CredibilityError(
      "cross_attempt_injection",
      `record ${record.kind}:${record.refId} references attempt ${record.attemptId} which is not part of run ${ctx.runId} (valid: ${ctx.validAttemptIds.join(",") || "none"}).`
    );
  }
}
