import type { ArtifactV2 } from "@ai-test-officer/contracts";
import type { AssertionEvidenceQuality, EvidenceItem, EvidenceQualityReport, VisualRunResult } from "./types.js";

function requiredKinds(assertion: VisualRunResult["assertions"][number]): ArtifactV2["kind"][] {
  if (assertion.fact?.kind === "network.url_contains") return ["network", "screenshot"];
  if (assertion.fact?.kind === "console.no_error" || assertion.fact?.kind === "console.error") return ["console", "trace"];
  return ["dom", "screenshot"];
}

function assertionEvidence(assertion: VisualRunResult["assertions"][number], evidence: EvidenceItem[]) {
  const explicit = new Set(assertion.fact?.evidenceRefs ?? []);
  return evidence.filter((item) => explicit.has(item.id) || (item.type === "assertion" && item.title === assertion.name));
}

export function buildEvidenceQualityReport(input: {
  assertions: VisualRunResult["assertions"];
  evidence: EvidenceItem[];
  artifacts: ArtifactV2[];
  generatedAt?: string;
}): EvidenceQualityReport {
  const assertions: AssertionEvidenceQuality[] = input.assertions.map((assertion) => {
    const assertionRefs = assertionEvidence(assertion, input.evidence);
    const attempt = assertionRefs.find((item) => item.attempt !== undefined)?.attempt;
    const required = requiredKinds(assertion);
    const sameAttempt = input.artifacts.filter((artifact) => attempt === undefined || artifact.attempt === attempt);
    const collected = Array.from(new Set(sameAttempt.map((artifact) => artifact.kind)));
    const artifactIds = sameAttempt.filter((artifact) => required.includes(artifact.kind)).map((artifact) => artifact.id);
    const reasons: string[] = [];
    if (!assertionRefs.length) reasons.push("assertion_evidence_missing");
    if (attempt === undefined) reasons.push("assertion_attempt_missing");
    const missingKinds = required.filter((kind) => !collected.includes(kind));
    if (missingKinds.length) reasons.push(`missing_artifact_kinds:${missingKinds.join(",")}`);
    const nonRuntime = sameAttempt.filter((artifact) => required.includes(artifact.kind) && artifact.origin !== "runtime-captured");
    if (nonRuntime.length) reasons.push(`non_runtime_artifact:${nonRuntime.map((artifact) => artifact.id).join(",")}`);
    return {
      assertionName: assertion.name,
      passed: assertion.passed,
      attempt,
      requiredKinds: required,
      collectedKinds: collected,
      artifactIds,
      evidenceRefs: assertionRefs.map((item) => item.id),
      status: reasons.length ? "insufficient" : "grounded",
      reasons
    };
  });
  const passed = assertions.filter((item) => item.passed);
  const grounded = passed.filter((item) => item.status === "grounded");
  const requiredArtifacts = assertions.flatMap((item) => item.artifactIds);
  const uniqueRequired = Array.from(new Set(requiredArtifacts));
  const runtime = input.artifacts.filter((item) => uniqueRequired.includes(item.id) && item.origin === "runtime-captured");
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    assertions,
    summary: {
      totalAssertions: assertions.length,
      passedAssertions: passed.length,
      groundedPassedAssertions: grounded.length,
      groundedPassedRate: passed.length ? grounded.length / passed.length : 1,
      runtimeArtifactRate: uniqueRequired.length ? runtime.length / uniqueRequired.length : 0,
      crossAttemptViolations: assertions.filter((item) => item.reasons.includes("assertion_attempt_missing")).length
    }
  };
}
