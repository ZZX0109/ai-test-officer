import { artifactGateEligibility, type ArtifactV2, type GateStatus } from "@ai-test-officer/contracts";
import type { ArtifactGateAssessment, LayeredJudgeReport } from "./types.js";

export function assessArtifactGate(input: {
  artifacts: ArtifactV2[];
  requiredKinds: ArtifactV2["kind"][];
  coreArtifactIds?: string[];
  captureFailure?: boolean;
}): ArtifactGateAssessment {
  const eligibleArtifactIds: string[] = [];
  const rejectedArtifactIds: string[] = [];
  const reasons: string[] = [];
  const coreIds = new Set(input.coreArtifactIds ?? input.artifacts.map((artifact) => artifact.id));

  for (const artifact of input.artifacts) {
    const eligibility = artifactGateEligibility(artifact);
    if (eligibility.eligible) eligibleArtifactIds.push(artifact.id);
    else {
      rejectedArtifactIds.push(artifact.id);
      reasons.push(`${artifact.id}:${eligibility.reason}`);
    }
    if (coreIds.has(artifact.id) && artifact.origin === "fixture") {
      rejectedArtifactIds.push(artifact.id);
      reasons.push(`${artifact.id}:fixture_cannot_replace_runtime_output`);
    }
  }

  const eligible = input.artifacts.filter((artifact) => eligibleArtifactIds.includes(artifact.id) && !rejectedArtifactIds.includes(artifact.id));
  const missingKinds = input.requiredKinds.filter((kind) => !eligible.some((artifact) => artifact.kind === kind));
  let status: GateStatus = "pass";
  if (input.captureFailure || missingKinds.length > 0) {
    status = "blocked";
    if (missingKinds.length) reasons.push(`missing_required:${missingKinds.join(",")}`);
  } else if (rejectedArtifactIds.length > 0) {
    status = "needs-human-review";
  }
  return {
    status,
    eligibleArtifactIds: Array.from(new Set(eligibleArtifactIds.filter((id) => !rejectedArtifactIds.includes(id)))),
    rejectedArtifactIds: Array.from(new Set(rejectedArtifactIds)),
    missingKinds,
    reasons: Array.from(new Set(reasons))
  };
}

export function enforceMachineGate(input: {
  report: LayeredJudgeReport;
  status: GateStatus;
  assessment: ArtifactGateAssessment;
  evidenceRefs?: string[];
}): LayeredJudgeReport {
  if (input.status === "pass") return input.report;
  const verdict = input.status === "fail" ? "fail" : "needs_review";
  const policyFinding = {
    id: "artifact_v2_gate",
    severity: input.status === "fail" ? "high" as const : "medium" as const,
    failureClass: input.status === "blocked" ? "environment_issue" as const : "insufficient_evidence" as const,
    title: input.status === "blocked" ? "正式证据采集被阻塞" : input.status === "fail" ? "确定性断言失败" : "证据或重试需要人工复核",
    reasoning: input.assessment.reasons.join("; ") || `machine_gate=${input.status}`,
    evidenceRefs: input.evidenceRefs ?? []
  };
  return {
    ...input.report,
    releaseJudge: {
      ...input.report.releaseJudge,
      verdict,
      summary: `${input.report.releaseJudge.summary} Machine gate: ${input.status}.`,
      findings: [...input.report.releaseJudge.findings.filter((finding) => finding.id !== policyFinding.id), policyFinding]
    }
  };
}
