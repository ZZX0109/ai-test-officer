import { randomUUID } from "node:crypto";
import type { ArtifactV2, MachineGate } from "@ai-test-officer/contracts";
import {
  deriveGateEligible,
  validateProofBundle,
  type ProofBundleInput,
  type ProofVerdict
} from "./proofBundleValidator.js";
import {
  allGateReasonsProven,
  buildGateReasonProofs,
  type GateReasonProof
} from "./gateReasonValidator.js";
import type { EvidenceItem } from "../types.js";

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

export interface MachineGateDraft {
  status: MachineGate["status"];
  reasons: string[];
  reasonDetails: MachineGate["reasonDetails"];
  assertionFailures: string[];
}

export interface VerifiedMachineGate extends MachineGateDraft {
  evidenceComplete: boolean;
  proofBundleId: string;
  proofValidationVersion: string;
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
    proofBundleId: `proof_${input.runId}_${randomUUID()}`,
    proofValidationVersion: PROOF_VALIDATION_VERSION
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
 * Compatibility-read guard. A machine gate that was produced before the Proof
 * Bundle Service existed has no `proofBundleId`. Such a record must never be
 * trusted as a formal pass — it is downgraded to `needs-human-review` so the
 * chain cannot silently assert a verified release on unverifiable evidence.
 */
export function applyLegacyUnverified(gate: MachineGate | undefined): MachineGate | undefined {
  if (!gate) return gate;
  if (gate.proofBundleId) return gate;
  if (gate.status !== "pass") return gate;
  return {
    ...gate,
    status: "needs-human-review",
    reasons: [...gate.reasons, "legacy_unverified"],
    evidenceComplete: false
  };
}

export { deriveGateEligible };
