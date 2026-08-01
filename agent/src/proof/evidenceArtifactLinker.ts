import type { ArtifactV2 } from "@ai-test-officer/contracts";
import type { EvidenceItem } from "../types.js";

const DIRECT_ARTIFACT_KINDS = new Set<ArtifactV2["kind"]>([
  "screenshot",
  "dom",
  "network",
  "console",
  "trace",
  "video"
]);

/**
 * Finalize direct Evidence -> Artifact links after attempt collectors commit.
 * Association is deliberately restricted to the same run/scenario/attempt so
 * retry artifacts can never prove a previous attempt.
 */
export function linkCommittedAttemptArtifacts(
  evidence: EvidenceItem[],
  artifacts: ArtifactV2[]
): EvidenceItem[] {
  return evidence.map((item) => {
    if (!DIRECT_ARTIFACT_KINDS.has(item.type as ArtifactV2["kind"])) return item;

    const sameAttempt = artifacts.filter((artifact) =>
      artifact.kind === item.type
      && artifact.runId === item.runId
      && artifact.scenarioId === item.scenarioId
      && artifact.attemptId === item.attemptId
      && artifact.attempt === item.attempt
    );
    if (sameAttempt.length === 0) return item;

    const sameStep = item.stepId
      ? sameAttempt.filter((artifact) => artifact.stepId === item.stepId)
      : [];
    const candidates = sameStep.length > 0 ? sameStep : sameAttempt;
    const artifactIds = Array.from(new Set([
      ...(item.artifactIds ?? []),
      ...candidates.map((artifact) => artifact.id)
    ]));
    return { ...item, artifactIds };
  });
}
