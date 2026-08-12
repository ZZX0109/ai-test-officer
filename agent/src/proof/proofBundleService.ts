import type { ArtifactV2, MachineGate } from "@ai-test-officer/contracts";
import {
  deriveGateEligible,
  validateProofBundle,
  type MachineGateDraft,
  type ProofBundleInput,
  type ProofVerdict
} from "./proofBundleValidator.js";
import {
  allGateReasonsProven,
  buildGateReasonProofs,
  type GateReasonProof
} from "./gateReasonValidator.js";
import { canonicalSha256 } from "../canonicalHash.js";
import type { EvidenceItem } from "../types.js";

export type { MachineGateDraft } from "./proofBundleValidator.js";

/**
 * Proof Bundle Service — the ONLY module allowed to mint a `VerifiedMachineGate`.
 *
 * Per the P0 credibility plan, business/execution code may only emit a
 * `MachineGateDraft` (status + reasons, no credibility flags). The final
 * `evidenceComplete` / `proofBundleId` / `proofValidationVersion` are stamped
 * here, after the validator recomputes them from the persisted bundle — never
 * from a self-asserted literal. Every gate reason is also checked against its
 * minimal-evidence policy; a reason that cannot prove itself fails closed to
 * `needs-human-review`.
 */

// 1.1.0 intentionally excludes report self-references from proof identity.
// Reports and manifests are generated after the runtime artifacts they
// describe, so including them creates a self-referential identity that changes
// during ordinary report generation. They remain visible in the integrity
// report, but cannot alter a proof minted from the same browser attempt.
export const PROOF_VALIDATION_VERSION = "1.1.0";

export interface VerifiedMachineGate extends MachineGateDraft {
  evidenceComplete: boolean;
  proofBundleId: string;
  proofValidationVersion: string;
  /** The attempt that actually produced this gate (stable, so it can be bound). */
  attemptId?: string;
  /** The scenario the gate was minted for (run-level gates may omit it). */
  scenarioId?: string;
}

export interface FinalizeProofBundleInput extends ProofBundleInput {
  draft: MachineGateDraft;
  runId: string;
  scenarioId?: string;
  attemptId?: string;
  /** when provided, gateEligible is derived from the computed verdict and folded into issues. */
  gateEligibleFacts?: { executionSucceeded: boolean; requirementCovered: boolean };
}

export interface FinalizeProofBundleResult {
  machineGate: VerifiedMachineGate;
  verdict: ProofVerdict;
  issues: string[];
  gateReasonProofs: GateReasonProof[];
  /** gate eligibility derived from the computed verdict + supplied execution facts. */
  gateEligible: boolean;
}

/**
 * Build the idempotent, deterministic proof bundle id.
 *
 * The id is a pure function of (runId, scenarioId, attemptId, input hash,
 * validation version). Re-running the same attempt with identical evidence and
 * verdict therefore yields the *same* id, which makes the credibility ledger
 * insert idempotent. The ledger is append-only: a later mint with different
 * facts for the same attempt is a credibility conflict, never an overwrite.
 */
export function buildProofBundleId(input: FinalizeProofBundleInput): string {
  const artifactProjection = (input.artifactsV2 ?? [])
    .map((item) => ({
      id: item.id,
      scenarioId: item.scenarioId,
      attemptId: item.attemptId,
      kind: item.kind,
      origin: item.origin,
      sha256: item.integrity.sha256,
      sizeBytes: item.integrity.sizeBytes,
      mediaType: item.integrity.mediaType
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const integrityProjection = input.artifactIntegrity
    ? {
        missing: input.artifactIntegrity.summary.missing,
        unreadable: input.artifactIntegrity.summary.unreadable,
        pathEscapes: input.artifactIntegrity.summary.pathEscapes,
        hashMismatches: input.artifactIntegrity.summary.hashMismatches
      }
    : undefined;
  const inputHash = canonicalSha256({
    status: input.draft.status,
    reasons: [...(input.draft.reasons ?? [])].sort(),
    reasonDetails: input.draft.reasonDetails ?? [],
    assertionFailures: [...(input.draft.assertionFailures ?? [])].sort(),
    evidenceIds: (input.evidence ?? []).map((item) => item.id).sort(),
    artifacts: artifactProjection,
    // `artifact_integrity.json`, reports and the run bundle are expected
    // self-references. Only the security-relevant counters belong in the
    // immutable proof identity; report-only item lists are intentionally not
    // included because they are written after the proof is minted.
    artifactIntegrity: integrityProjection,
    judgeReportSummary: input.judgeReport
      ? {
          releaseVerdict: input.judgeReport.releaseJudge?.verdict,
          evidenceRefs: input.judgeReport.releaseJudge?.findings.flatMap((item) => item.evidenceRefs)
        }
      : undefined
  });
  const scenario = input.scenarioId ?? "run";
  const attempt = input.attemptId ?? "run";
  return `proof_${input.runId}_${scenario}_${attempt}_${inputHash}`;
}

export function finalizeProofBundle(input: FinalizeProofBundleInput): FinalizeProofBundleResult {
  const evidenceById = new Map<string, EvidenceItem>((input.evidence ?? []).map((item) => [item.id, item]));
  const artifactsById = new Map<string, ArtifactV2>((input.artifactsV2 ?? []).map((item) => [item.id, item]));

  const verdict = validateProofBundle(input);
  const gateReasonProofs = buildGateReasonProofs(input.draft, evidenceById, artifactsById);

  const issues = [...verdict.issues];
  let status = input.draft.status;
  if (!allGateReasonsProven(gateReasonProofs) && status !== "needs-human-review") {
    // A reason without a minimal evidence proof must not support a confident
    // verdict. Product failures become "not asserted"; environment blocks
    // become "needs review"; passes become "needs review".
    status = "needs-human-review";
    issues.push("gate_reason_proof_missing");
  }

  const machineGate: VerifiedMachineGate = {
    ...input.draft,
    status,
    evidenceComplete: verdict.evidenceComplete,
    proofBundleId: buildProofBundleId(input),
    proofValidationVersion: PROOF_VALIDATION_VERSION,
    attemptId: input.attemptId,
    scenarioId: input.scenarioId
  };

  // Gate eligibility is a *computed* fact: execution must have succeeded and the
  // requirement must be covered, on top of verified integrity + grounded evidence.
  // Callers that do not supply the facts fail closed to ineligible by default.
  const gateEligible = input.gateEligibleFacts
    ? deriveGateEligible(verdict, input.gateEligibleFacts)
    : false;

  return { machineGate, verdict, issues, gateReasonProofs, gateEligible };
}

/**
 * Single, audited projection of the verified proof result onto the
 * credibility scalar fields that the rest of the system consumes
 * (`outcomeSummary`, persisted `RunBundle`, API responses).
 *
 * Business/execution code MUST call this helper (or `finalizeProofBundle`
 * directly) instead of assigning the credibility booleans itself. Every
 * assignment to a credibility flag therefore lives in this module, and the
 * static gate in `scripts/check-evidence-complete-assignment.mjs` fails CI on
 * any assignment outside `agent/src/proof/`.
 */
export function proofCredibility(
  verdict: Pick<ProofVerdict, "artifactIntegrityVerified" | "evidenceGrounded" | "evidenceComplete">,
  machineGate: VerifiedMachineGate | MachineGate,
  gateEligible: boolean
): {
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
  evidenceComplete: boolean;
  gateEligible: boolean;
  machineGate: VerifiedMachineGate | MachineGate;
} {
  return {
    artifactIntegrityVerified: verdict.artifactIntegrityVerified,
    evidenceGrounded: verdict.evidenceGrounded,
    evidenceComplete: machineGate.evidenceComplete,
    gateEligible,
    machineGate
  };
}

/**
 * Audited adapter for the execution-persistence boundary. Keeping this object
 * construction next to the verifier prevents callers from minting or
 * reshaping credibility fields in business code.
 */
export function proofPersistence(
  finalized: Pick<FinalizeProofBundleResult, "verdict" | "gateEligible">
): { verdict: ProofVerdict; gateEligible: boolean } {
  return { verdict: finalized.verdict, gateEligible: finalized.gateEligible };
}

/**
 * Audited projection used when a verified phase (for example the shared
 * browser phase of a mixed parent run) is represented as a contributor to a
 * later aggregate. Keeping these credibility field assignments in the proof
 * boundary prevents aggregation code from manually asserting them.
 */
export function proofContributorCredibility(input: {
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
}): {
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
} {
  return {
    artifactIntegrityVerified: input.artifactIntegrityVerified,
    evidenceGrounded: input.evidenceGrounded
  };
}

export { deriveGateEligible };
