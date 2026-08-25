import { artifactGateEligibility } from "@ai-test-officer/contracts";
import type { ArtifactV2, MachineGate } from "@ai-test-officer/contracts";
import type {
  ArtifactIntegrityReport,
  EvidenceItem,
  LayeredJudgeReport,
  OracleDefinition,
  RiskCoverageItem
} from "../types.js";

/**
 * The draft a producer may emit. Business/execution code is only ever allowed
 * to assert the *status* and the *reasons* behind it — never the credibility
 * booleans (`evidenceComplete` / `proofBundleId` / `proofValidationVersion`).
 * Those are stamped exclusively by `finalizeProofBundle` in this module after
 * the validator recomputes them from the persisted bundle.
 */
export interface MachineGateDraft {
  status: MachineGate["status"];
  reasons: string[];
  reasonDetails: MachineGate["reasonDetails"];
  assertionFailures: string[];
}

/**
 * Unified Proof Bundle validator (P0 credibility).
 *
 * The run outcome schema (runOutcomeSummaryV2Schema) only checks that the
 * caller-supplied booleans are *mutually consistent* — it cannot know whether
 * `artifactIntegrityVerified` / `evidenceGrounded` / `evidenceComplete` are
 * actually true. Several producers hard-coded them to `true`, which let a run
 * claim "evidence complete / integrity verified" without any verification.
 *
 * This validator turns those flags from *inputs* into *computed facts* derived
 * from the bundle itself. It is the single source of truth for proof
 * credibility and deliberately returns `false` whenever the underlying
 * verification data is absent rather than trusting a self-asserted flag.
 */
export interface ProofBundleInput {
  evidence?: EvidenceItem[];
  artifactsV2?: ArtifactV2[];
  artifactIntegrity?: ArtifactIntegrityReport;
  /** artifact kinds the run was required to capture for its verdict to be credible. */
  requiredArtifactKinds?: ArtifactV2["kind"][];
  /** The same reasons/status that live on `draft`, surfaced for reason-linkage checks. */
  machineGate?: MachineGateDraft;
  judgeReport?: LayeredJudgeReport;
  oracles?: OracleDefinition[];
  riskCoverageMatrix?: RiskCoverageItem[];
  /** Optional run/scenario/attempt identity enforced at the minting boundary. */
  expectedBinding?: {
    runId: string;
    scenarioId?: string;
    attemptId?: string;
  };
}

export interface GateReasonEvidence {
  code: string;
  summary: string;
  /** evidence ids that both back this reason and actually exist in the bundle. */
  evidenceRefs: string[];
}

export interface ProofVerdict {
  artifactIntegrityVerified: boolean;
  evidenceGrounded: boolean;
  evidenceComplete: boolean;
  /** resolved evidence ids that genuinely back the run's claims — the minimal evidence set. */
  minimalEvidenceSet: string[];
  /** every machine-gate reason mapped to the evidence that supports it. */
  gateReasonEvidence: GateReasonEvidence[];
  /** human-readable credibility problems; empty means the bundle is internally consistent. */
  issues: string[];
}

/** Integrity summary counters that, when non-zero, mean integrity was NOT verified. */
const INTEGRITY_PROBLEM_KEYS = [
  "missing",
  "unreadable",
  "pathEscapes",
  "hashMismatches"
] as const satisfies readonly (keyof ArtifactIntegrityReport["summary"])[];

export function validateProofBundle(input: ProofBundleInput): ProofVerdict {
  const issues: string[] = [];
  const evidence = input.evidence ?? [];
  const evidenceIds = new Set(evidence.map((item) => item.id));

  // A clean hash is not enough: an intact artifact from a sibling Run or
  // Attempt is still invalid evidence. Enforce the identity at the same
  // validator boundary that computes the credibility booleans.
  if (input.expectedBinding) {
    for (const artifact of input.artifactsV2 ?? []) {
      if (artifact.runId !== input.expectedBinding.runId) issues.push(`artifact_run_mismatch:${artifact.id}`);
      if (input.expectedBinding.scenarioId && artifact.scenarioId !== input.expectedBinding.scenarioId) issues.push(`artifact_scenario_mismatch:${artifact.id}`);
      if (input.expectedBinding.attemptId && artifact.attemptId !== input.expectedBinding.attemptId) issues.push(`artifact_attempt_mismatch:${artifact.id}`);
    }
    for (const item of evidence) {
      if (item.runId !== input.expectedBinding.runId) issues.push(`evidence_run_mismatch:${item.id}`);
      if (input.expectedBinding.scenarioId && item.scenarioId && item.scenarioId !== input.expectedBinding.scenarioId) issues.push(`evidence_scenario_mismatch:${item.id}`);
      if (input.expectedBinding.attemptId && item.attemptId && item.attemptId !== input.expectedBinding.attemptId) issues.push(`evidence_attempt_mismatch:${item.id}`);
    }
  }

  // 1. Artifact integrity — only "verified" when a report exists AND is clean.
  let artifactIntegrityVerified = false;
  if (input.artifactIntegrity) {
    const summary = input.artifactIntegrity.summary;
    const problems = INTEGRITY_PROBLEM_KEYS.filter((key) => (summary[key] ?? 0) > 0);
    artifactIntegrityVerified = problems.length === 0;
    if (!artifactIntegrityVerified) {
      issues.push(`artifact integrity not verified: ${problems.join(",")} > 0`);
    }
  } else {
    issues.push("artifact integrity report missing");
  }

  // 2. Collect every evidence id referenced by a claim that must be backed.
  const referenced = new Set<string>();
  const addRefs = (refs?: string[]) => {
    for (const ref of refs ?? []) referenced.add(ref);
  };
  for (const detail of input.machineGate?.reasonDetails ?? []) addRefs(detail.evidenceRefs);
  if (input.judgeReport) {
    const layers = [input.judgeReport.planJudge, input.judgeReport.evidenceJudge, input.judgeReport.releaseJudge];
    for (const layer of layers) for (const finding of layer.findings ?? []) addRefs(finding.evidenceRefs);
    addRefs(input.judgeReport.modelRecommendation?.evidenceRefs);
  }
  for (const oracle of input.oracles ?? []) addRefs(oracle.evidenceRefs);
  for (const item of input.riskCoverageMatrix ?? []) addRefs(item.evidenceRefs);

  // 3. Grounding — every referenced id must resolve to a real evidence item.
  const unresolved = [...referenced].filter((id) => !evidenceIds.has(id));
  for (const id of unresolved) issues.push(`evidence ref not found in bundle: ${id}`);
  const minimalEvidenceSet = [...referenced].filter((id) => evidenceIds.has(id));
  // Evidence is not credible merely because its top-level record exists. Any
  // artifact link carried by that record must resolve to the same persisted
  // Artifact v2 set; otherwise a stale/synthetic screenshot can masquerade as
  // runtime proof. Keep this check at the minting boundary so every producer
  // gets the same fail-closed behavior.
  const artifactIds = new Set((input.artifactsV2 ?? []).map((artifact) => artifact.id));
  const missingArtifactRefs = (evidence).flatMap((item) => (item.artifactIds ?? [])
    .filter((artifactId) => !artifactIds.has(artifactId))
    .map((artifactId) => `${item.id}:${artifactId}`));
  for (const ref of missingArtifactRefs) issues.push(`evidence artifact ref not found in bundle: ${ref}`);

  // Oracle definitions are executable claims, not plan metadata. A non-empty
  // oracle list with no evidence refs means the oracle was never observed and
  // must not contribute to a credible pass.
  const unexecutedOracles = (input.oracles ?? []).filter((oracle) => oracle.evidenceRefs.length === 0);
  for (const oracle of unexecutedOracles) issues.push(`oracle not executed: ${oracle.id}`);

  const hasClaims = referenced.size > 0;
  const passWithoutClaim = input.machineGate?.status === "pass" && !hasClaims;
  if (passWithoutClaim) issues.push("pass_claim_missing");
  const evidenceGrounded = unresolved.length === 0
    && !passWithoutClaim
    && (hasClaims ? minimalEvidenceSet.length > 0 : evidence.length > 0);

  // 4. Gate reasons -> minimal evidence set; flag reasons with no evidence linkage (P0.4).
  const gateReasonEvidence: GateReasonEvidence[] = (input.machineGate?.reasonDetails ?? []).map((detail) => ({
    code: detail.code,
    summary: detail.summary,
    evidenceRefs: detail.evidenceRefs.filter((id) => evidenceIds.has(id))
  }));
  const linkedReasons = new Set<string>();
  for (const item of gateReasonEvidence) {
    linkedReasons.add(item.code);
    linkedReasons.add(`${item.code}:${item.summary}`);
  }
  for (const reason of input.machineGate?.reasons ?? []) {
    if (!linkedReasons.has(reason) && !linkedReasons.has(reason.split(":")[0])) {
      issues.push(`gate reason lacks evidence linkage: ${reason}`);
    }
  }

  // 5. Completeness — required artifact kinds present among eligible artifacts + integrity verified.
  const artifacts = input.artifactsV2 ?? [];
  let evidenceComplete = artifactIntegrityVerified && missingArtifactRefs.length === 0 && unexecutedOracles.length === 0;
  if (input.requiredArtifactKinds && input.requiredArtifactKinds.length > 0) {
    const eligibleKinds = new Set(
      artifacts.filter((artifact) => artifactGateEligibility(artifact).eligible).map((artifact) => artifact.kind)
    );
    const missing = input.requiredArtifactKinds.filter((kind) => !eligibleKinds.has(kind));
    if (missing.length > 0) {
      issues.push(`missing required artifact kinds: ${missing.join(",")}`);
      evidenceComplete = false;
    }
  } else if (artifacts.length === 0 && evidence.length === 0) {
    issues.push("no artifacts or evidence captured");
    evidenceComplete = false;
  }

  return {
    artifactIntegrityVerified,
    evidenceGrounded,
    evidenceComplete,
    minimalEvidenceSet: Array.from(new Set(minimalEvidenceSet)),
    gateReasonEvidence,
    issues
  };
}

/**
 * Mirrors the runOutcomeSummaryV2Schema invariant: gate eligibility requires a
 * completed execution, coverage, verified integrity and grounded evidence. The
 * difference is that the two proof flags now come from validateProofBundle
 * (computed) instead of being self-asserted by the caller.
 */
export function deriveGateEligible(
  verdict: Pick<ProofVerdict, "artifactIntegrityVerified" | "evidenceGrounded">,
  facts: { executionSucceeded: boolean; requirementCovered: boolean }
): boolean {
  return facts.executionSucceeded && facts.requirementCovered && verdict.artifactIntegrityVerified && verdict.evidenceGrounded;
}
