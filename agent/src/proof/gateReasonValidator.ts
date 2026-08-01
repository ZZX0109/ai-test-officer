import { artifactGateEligibility, type ArtifactV2, type MachineGate } from "@ai-test-officer/contracts";
import type { EvidenceItem } from "../types.js";

/**
 * Gate reason minimal-evidence registry (P0 credibility).
 *
 * Every machine-gate *reason* must be backed by at least one piece of evidence
 * whose type (or whose committed artifact kind) belongs to the reason's policy.
 * A reason that cannot produce a minimal proof is not allowed to support a
 * confident verdict (pass/fail/blocked) — it fails closed to needs-human-review.
 *
 * Codes not present in this registry are not actively enforced beyond the
 * generic "evidence must resolve" check, so existing producers that attach
 * resolving evidence refs keep working unchanged.
 */
export interface GateReasonPolicy {
  requiredEvidence: string[];
}

export const GATE_REASON_POLICIES: Record<string, GateReasonPolicy> = {
  assertion_failed: { requiredEvidence: ["assertion", "screenshot", "dom"] },
  environment_unavailable: { requiredEvidence: ["command-log", "health-check", "network", "console"] },
  api_contract_failed: { requiredEvidence: ["network", "assertion", "operation"] },
  artifact_integrity_failed: { requiredEvidence: ["operation-log", "report", "operation"] },
  permission_denied: { requiredEvidence: ["screenshot", "dom", "network", "console"] }
};

export type GateReasonProofStatus = "verified" | "missing" | "invalid";

export interface GateReasonProof {
  reasonId: string;
  code: string;
  assertionIds: string[];
  evidenceIds: string[];
  artifactIds: string[];
  proofStatus: GateReasonProofStatus;
}

function evidenceSatisfiesPolicy(
  evidenceRefs: string[],
  policy: GateReasonPolicy,
  evidenceById: Map<string, EvidenceItem>,
  artifactsById: Map<string, ArtifactV2>
): boolean {
  for (const ref of evidenceRefs) {
    const evidence = evidenceById.get(ref);
    if (!evidence) return false; // dangling — cannot satisfy anything
    if (policy.requiredEvidence.includes(evidence.type)) return true;
    for (const artifactId of evidence.artifactIds ?? []) {
      const artifact = artifactsById.get(artifactId);
      if (artifact && artifactGateEligibility(artifact).eligible && policy.requiredEvidence.includes(artifact.kind)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Produce a minimal-evidence proof for every structured gate reason
 * (`reasonDetails`). Only structured reasons carry the evidence references that
 * the policy can validate; free-text rollup `reasons` (e.g. parent aggregates)
 * are summary labels and are intentionally not subject to fail-closed, since
 * their credibility is derived from the children they roll up rather than from
 * their own evidence references.
 */
export function buildGateReasonProofs(
  machineGate: Pick<MachineGate, "reasons" | "reasonDetails">,
  evidenceById: Map<string, EvidenceItem>,
  artifactsById: Map<string, ArtifactV2>
): GateReasonProof[] {
  const proofs: GateReasonProof[] = [];

  for (const detail of machineGate.reasonDetails) {
    const code = detail.code;
    const allResolve = detail.evidenceRefs.every((ref) => evidenceById.has(ref));
    const policy = GATE_REASON_POLICIES[code];
    let proofStatus: GateReasonProofStatus;
    if (!allResolve) {
      proofStatus = "missing";
    } else if (!policy || evidenceSatisfiesPolicy(detail.evidenceRefs, policy, evidenceById, artifactsById)) {
      proofStatus = "verified";
    } else {
      proofStatus = "invalid";
    }
    proofs.push({
      reasonId: `${code}:${detail.summary}`,
      code,
      assertionIds: [],
      evidenceIds: detail.evidenceRefs,
      artifactIds: detail.evidenceRefs.flatMap((ref) => evidenceById.get(ref)?.artifactIds ?? []),
      proofStatus
    });
  }

  return proofs;
}

/** True when every gate reason carries a verified minimal-evidence proof. */
export function allGateReasonsProven(proofs: GateReasonProof[]): boolean {
  return proofs.every((proof) => proof.proofStatus === "verified");
}
