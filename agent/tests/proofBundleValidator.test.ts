import assert from "node:assert/strict";
import type { ArtifactV2, MachineGate } from "@ai-test-officer/contracts";
import { deriveGateEligible, validateProofBundle } from "../src/proof/proofBundleValidator.js";
import type { ArtifactIntegrityReport, EvidenceItem } from "../src/types.js";

function makeEvidence(id: string): EvidenceItem {
  return { id, runId: "run_1", type: "operation", title: id, timestamp: new Date().toISOString(), payload: {} };
}

function makeArtifact(kind: ArtifactV2["kind"], origin: ArtifactV2["origin"] = "runtime-captured"): ArtifactV2 {
  return {
    schemaVersion: "2.0",
    id: `artifact_${kind}`,
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    attempt: 1,
    kind,
    origin,
    storageUri: `/artifacts/${kind}`,
    replicaUris: [],
    sequence: 1,
    monotonicOffsetMs: 0,
    integrity: {
      sha256: "a".repeat(64),
      sizeBytes: 10,
      mediaType: "image/png",
      capturedAt: new Date().toISOString(),
      collector: { name: "test", version: "1.0" }
    }
  };
}

function makeIntegrityReport(overrides: Partial<ArtifactIntegrityReport["summary"]> = {}): ArtifactIntegrityReport {
  return {
    id: "integrity_1",
    runId: "run_1",
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: { total: 1, present: 1, missing: 0, unreadable: 0, pathEscapes: 0, selfReferences: 0, hashMismatches: 0, hashed: 1, ...overrides },
    items: []
  };
}

function makeMachineGate(partial: Partial<MachineGate> = {}): MachineGate {
  return { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [], evidenceComplete: true, ...partial };
}

export function testProofBundleValidator() {
  // The "hard-coded true" case: no integrity report and no evidence must NOT be
  // reported as verified/complete (this is what structuredCoverageRunner used to claim).
  const empty = validateProofBundle({});
  assert.equal(empty.artifactIntegrityVerified, false);
  assert.equal(empty.evidenceGrounded, false);
  assert.equal(empty.evidenceComplete, false);
  assert.ok(empty.issues.length > 0);

  // A genuinely complete bundle: clean integrity, real evidence, grounded refs, required kinds present.
  const complete = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    machineGate: makeMachineGate({ reasonDetails: [{ code: "oracle_failed", summary: "x", evidenceRefs: ["ev_1"] }] })
  });
  assert.equal(complete.artifactIntegrityVerified, true);
  assert.equal(complete.evidenceGrounded, true);
  assert.equal(complete.evidenceComplete, true);
  assert.deepEqual(complete.minimalEvidenceSet, ["ev_1"]);
  assert.deepEqual(complete.gateReasonEvidence, [{ code: "oracle_failed", summary: "x", evidenceRefs: ["ev_1"] }]);
  assert.deepEqual(complete.issues, []);

  // A claim referencing evidence that does not exist is not grounded.
  const dangling = validateProofBundle({
    evidence: [],
    artifactIntegrity: makeIntegrityReport(),
    machineGate: makeMachineGate({ reasonDetails: [{ code: "x", summary: "y", evidenceRefs: ["ghost"] }] })
  });
  assert.equal(dangling.evidenceGrounded, false);
  assert.ok(dangling.issues.some((issue) => issue.includes("ghost")));

  // A free-text gate reason with no evidence linkage is flagged (P0.4 detector).
  const unlinked = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactIntegrity: makeIntegrityReport(),
    machineGate: makeMachineGate({ reasons: ["missing_required:screenshot"] })
  });
  assert.ok(unlinked.issues.some((issue) => issue.includes("lacks evidence linkage")));

  // Missing a required artifact kind breaks completeness even with clean integrity.
  const missingKind = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot", "trace"]
  });
  assert.equal(missingKind.evidenceComplete, false);
  assert.ok(missingKind.issues.some((issue) => issue.includes("trace")));

  // A simulated (non-runtime) artifact cannot satisfy a required kind.
  const simulated = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot", "simulated")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"]
  });
  assert.equal(simulated.evidenceComplete, false);

  // Integrity problems (e.g. hash mismatch) mean integrity is not verified.
  const tampered = validateProofBundle({ artifactIntegrity: makeIntegrityReport({ hashMismatches: 1 }) });
  assert.equal(tampered.artifactIntegrityVerified, false);
  assert.ok(tampered.issues.some((issue) => issue.includes("hashMismatches")));

  // deriveGateEligible mirrors the runOutcomeSummaryV2 invariant.
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: true, evidenceGrounded: true }, { executionSucceeded: true, requirementCovered: true }), true);
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: false, evidenceGrounded: true }, { executionSucceeded: true, requirementCovered: true }), false);
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: true, evidenceGrounded: true }, { executionSucceeded: false, requirementCovered: true }), false);
}
