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

export const PROOF_VALIDATION_VERSION = "1.0.0";

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
 * insert idempotent (a shadow / retry cannot forge a second authoritative
 * record, and a re-mint overwrites rather than duplicates).
 */
function buildProofBundleId(input: FinalizeProofBundleInput): string {
  const inputHash = canonicalSha256({
    status: input.draft.status,
    reasons: [...(input.draft.reasons ?? [])].sort(),
    reasonDetails: input.draft.reasonDetails ?? [],
    assertionFailures: [...(input.draft.assertionFailures ?? [])].sort(),
    evidenceIds: (input.evidence ?? []).map((item) => item.id).sort(),
    artifactIds: (input.artifactsV2 ?? []).map((item) => item.id).sort(),
    artifactIntegrity: input.artifactIntegrity ? input.artifactIntegrity.items : undefined,
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

export { deriveGateEligible };
