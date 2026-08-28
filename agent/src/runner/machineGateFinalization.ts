import {
  resolveFinalStatus,
  runOutcomeSummaryV2Schema,
  type ArtifactV2,
  type JudgeRecommendation
} from "@ai-test-officer/contracts";
import type { ArtifactIntegrityReport, EvidenceItem, VisualRunResult } from "../types.js";
import { artifactKindToIntegrityKind } from "../artifactIntegrity.js";
import { assessArtifactGate, enforceMachineGate } from "../evidencePolicy.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "../proof/proofBundleService.js";

type GateAssessment = ReturnType<typeof assessArtifactGate>;
type EvidenceQuality = ReturnType<typeof import("../evidenceQuality.js").buildEvidenceQualityReport>;
type RiskCoverageMatrix = ReturnType<typeof import("../riskCoverage.js").buildRiskCoverageMatrix>;
type Attempt = NonNullable<VisualRunResult["attempts"]>[number];
type ExecutionError = NonNullable<VisualRunResult["executionError"]>;
type JudgeInput = Parameters<typeof enforceMachineGate>[0]["report"];

export function finalizeMachineGate(input: {
  id: string;
  scenarioId: string;
  attemptId: string;
  artifacts: ArtifactV2[];
  requiredKinds: ArtifactV2["kind"][];
  evidence: EvidenceItem[];
  assertions: VisualRunResult["assertions"];
  attempts: Attempt[];
  executionError?: ExecutionError;
  failed: boolean;
  evidenceQuality: EvidenceQuality;
  riskCoverageMatrix: RiskCoverageMatrix;
  network: VisualRunResult["network"];
  judgeReport: JudgeInput;
  /** V2 Oracle governance is an additional fail-closed gate. */
  oracleStatus?: "pass" | "fail" | "blocked" | "needs-human-review";
  oracleReasons?: string[];
}) {
  const qualityReasons = input.evidenceQuality.assertions
    .filter((item) => item.passed && item.status !== "grounded")
    .flatMap((item) => [`assertion_evidence_incomplete:${item.assertionName}`, ...item.reasons.map((reason) => `${item.assertionName}:${reason}`)]);
  // A non-empty coverage matrix is not enough: every required oracle must
  // have been executed. Otherwise a scheduling-complete run could be shown as
  // a pass even though the requirement was never exercised.
  const uncoveredRequirementRisks = input.riskCoverageMatrix
    .filter((item) => !item.covered)
    .map((item) => `requirement_not_covered:${item.riskId}`);
  const environmentFailures = input.network.filter((item) => {
    const candidate = item as unknown as Record<string, unknown>;
    return (typeof candidate.status === "number" && candidate.status >= 500)
      || candidate.failed === true || Boolean(candidate.error);
  });
  const environmentReasons = environmentFailures.slice(0, 3).map((item) => {
    const candidate = item as unknown as Record<string, unknown>;
    const method = typeof candidate.method === "string" ? candidate.method : "request";
    const url = typeof candidate.url === "string" ? candidate.url : "unknown-url";
    const status = typeof candidate.status === "number" ? candidate.status : "network-error";
    return `environment_network_failure:${method}:${url}:${status}`;
  });
  const artifactGate = assessArtifactGate({ artifacts: input.artifacts, requiredKinds: input.requiredKinds });
  const machineGateStatus = artifactGate.status !== "pass"
    ? artifactGate.status
    : input.executionError?.failureClass === "environment_issue"
      ? "blocked" as const
      : environmentFailures.length > 0
        ? "blocked" as const
        : input.oracleStatus === "blocked"
          ? "blocked" as const
          : input.executionError
            ? "needs-human-review" as const
            : input.oracleStatus === "fail" || input.failed
              ? "fail" as const
              : input.oracleStatus === "needs-human-review"
                ? "needs-human-review" as const
                : qualityReasons.length || uncoveredRequirementRisks.length
                  ? "needs-human-review" as const
                  : input.attempts.length > 1
                    ? "needs-human-review" as const
                    : "pass" as const;
  const machineGateEvidenceRefs = input.evidence
    .filter((item) => item.type === "assertion" || item.artifactIds?.some((id) =>
      artifactGate.rejectedArtifactIds.includes(id) || artifactGate.eligibleArtifactIds.includes(id)
    ))
    .map((item) => item.id)
    .slice(-20);
  const judgeReport = enforceMachineGate({
    report: input.judgeReport,
    status: machineGateStatus,
    assessment: artifactGate,
    evidenceRefs: machineGateEvidenceRefs.length ? machineGateEvidenceRefs : input.evidence.slice(-5).map((item) => item.id)
  });
  const machineGateDraft: MachineGateDraft = {
    status: machineGateStatus,
    reasons: [
      ...artifactGate.reasons,
      ...(input.executionError ? [`execution_error:${input.executionError.code}:${input.executionError.stepId ?? "unknown"}`] : []),
      ...environmentReasons,
      ...qualityReasons,
      ...uncoveredRequirementRisks,
      ...(input.oracleReasons ?? []).map((reason) => `oracle:${reason}`)
    ],
    reasonDetails: [
      ...artifactGate.reasons,
      ...(input.executionError ? [`execution_error:${input.executionError.code}:${input.executionError.stepId ?? "unknown"}`] : []),
      ...environmentReasons,
      ...qualityReasons,
      ...uncoveredRequirementRisks,
      ...(input.oracleReasons ?? []).map((reason) => `oracle:${reason}`)
    ].map((reason) => ({
      code: reason.split(":")[0] || "machine_gate_reason",
      summary: reason,
      evidenceRefs: reason.startsWith("environment_network_failure:")
        ? input.evidence.filter((item) => item.type === "network" || item.type === "console").slice(-6).map((item) => item.id)
        : machineGateEvidenceRefs.length
          ? machineGateEvidenceRefs
          : input.evidence.slice(-5).map((item) => item.id)
    })).filter((item) => item.evidenceRefs.length > 0),
    assertionFailures: input.assertions.filter((item) => !item.passed).map((item) => item.name)
  };
  // Proof credibility (evidenceComplete / artifactIntegrityVerified /
  // evidenceGrounded / gateEligible) is recomputed by the Proof Bundle Service
  // from the actually-committed artifacts + evidence. A clean integrity report
  // is derived from the gate assessment and the committed artifact digests.
  const artifactIntegrityReport: ArtifactIntegrityReport = {
    id: `${input.id}_artifact_integrity`,
    runId: input.id,
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: {
      total: input.artifacts.length,
      present: artifactGate.status === "pass" ? input.artifacts.length : 0,
      missing: 0,
      unreadable: 0,
      pathEscapes: 0,
      selfReferences: 0,
      hashMismatches: artifactGate.status === "pass" ? 0 : input.artifacts.length,
      hashed: input.artifacts.length
    },
    items: input.artifacts.map((artifact) => ({
      id: artifact.id,
      artifactUri: artifact.storageUri,
      kind: artifactKindToIntegrityKind(artifact.kind),
      status: artifactGate.status === "pass" ? "present" : "hash_mismatch",
      sha256: artifact.integrity.sha256,
      sizeBytes: artifact.integrity.sizeBytes
    }))
  };
  const requirementCovered = input.riskCoverageMatrix.length > 0 && input.riskCoverageMatrix.every((item) => item.covered);
  const requirementPassed = requirementCovered && input.riskCoverageMatrix.every((item) => item.passed);
  const executionSucceeded = !input.executionError && input.attempts.length > 0;
  const { machineGate, verdict, issues, gateEligible } = finalizeProofBundle({
    draft: machineGateDraft,
    runId: input.id,
    scenarioId: input.scenarioId,
    attemptId: input.attemptId,
    evidence: input.evidence,
    artifactsV2: input.artifacts,
    artifactIntegrity: artifactIntegrityReport,
    requiredArtifactKinds: input.requiredKinds,
    machineGate: machineGateDraft,
    judgeReport,
    gateEligibleFacts: { executionSucceeded, requirementCovered }
  });
  const judgeRecommendation: JudgeRecommendation = {
    status: judgeReport.releaseJudge.verdict === "needs_review" ? "needs-human-review" : judgeReport.releaseJudge.verdict,
    summary: judgeReport.releaseJudge.summary,
    evidenceRefs: Array.from(new Set(judgeReport.releaseJudge.findings.flatMap((finding) => finding.evidenceRefs)))
  };
  const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: input.attempts.length > 0,
    executionSucceeded,
    requirementCovered,
    requirementPassed,
    ...proofCredibility(verdict, machineGate, gateEligible),
    proofValidationIssues: issues,
    machineGate,
    judgeRecommendation,
    finalStatus
  });
  return {
    artifactGate,
    artifactIntegrityReport,
    finalStatus,
    gateEligible,
    judgeRecommendation,
    judgeReport,
    machineGate,
    outcomeSummary,
    verdict
  };
}
