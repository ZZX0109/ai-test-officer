import assert from "node:assert/strict";
import type { ArtifactV2 } from "@ai-test-officer/contracts";
import { linkCommittedAttemptArtifacts } from "../src/proof/evidenceArtifactLinker.js";
import type { EvidenceItem } from "../src/types.js";

function artifact(id: string, attemptId: string, attempt: number): ArtifactV2 {
  return {
    schemaVersion: "2.0",
    id,
    runId: "run-link",
    scenarioId: "scenario-link",
    attemptId,
    attempt,
    stepId: "attempt-finalize",
    kind: "network",
    origin: "runtime-captured",
    storageUri: `/artifacts/${id}.json`,
    replicaUris: [],
    sequence: attempt,
    monotonicOffsetMs: 10,
    integrity: {
      sha256: "a".repeat(64),
      sizeBytes: 10,
      mediaType: "application/json",
      capturedAt: "2026-07-31T00:00:00.000Z",
      collector: { name: "test", version: "1" }
    }
  };
}

function evidence(attemptId: string, attempt: number): EvidenceItem {
  return {
    id: `evidence-${attemptId}`,
    runId: "run-link",
    scenarioId: "scenario-link",
    attemptId,
    attempt,
    type: "network",
    title: "request",
    timestamp: "2026-07-31T00:00:00.000Z",
    payload: {}
  };
}

export function testEvidenceArtifactLinker() {
  const linked = linkCommittedAttemptArtifacts(
    [evidence("attempt-1", 1)],
    [artifact("network-1", "attempt-1", 1), artifact("network-2", "attempt-2", 2)]
  );
  assert.deepEqual(linked[0]?.artifactIds, ["network-1"]);

  const existing = evidence("attempt-1", 1);
  existing.artifactIds = ["existing"];
  assert.deepEqual(
    linkCommittedAttemptArtifacts([existing], [artifact("network-1", "attempt-1", 1)])[0]?.artifactIds,
    ["existing", "network-1"]
  );
}
