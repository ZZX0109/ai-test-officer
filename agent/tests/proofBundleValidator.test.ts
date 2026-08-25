import assert from "node:assert/strict";
import { runOutcomeSummaryV2Schema } from "@ai-test-officer/contracts";
import type { ArtifactV2, MachineGate } from "@ai-test-officer/contracts";
import { deriveGateEligible, validateProofBundle } from "../src/proof/proofBundleValidator.js";
import { buildProofBundleId, finalizeProofBundle } from "../src/proof/proofBundleService.js";
import type { ArtifactIntegrityReport, EvidenceItem } from "../src/types.js";

function makeEvidence(id: string, type: EvidenceItem["type"] = "operation"): EvidenceItem {
  return { id, runId: "run_1", type, title: id, timestamp: new Date().toISOString(), payload: {} };
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

  // A PASS must carry at least one explicit claim/oracle/conclusion linkage;
  // arbitrary non-empty evidence is not enough to establish grounding.
  const passWithoutClaim = validateProofBundle({
    evidence: [makeEvidence("ev_unbound")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    machineGate: makeMachineGate()
  });
  assert.equal(passWithoutClaim.evidenceGrounded, false);
  assert.ok(passWithoutClaim.issues.includes("pass_claim_missing"));

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

  // Object-store publication can fail after child paths have run. The parent
  // must be blocked (not stranded in collecting), while its environmental
  // reasons remain grounded in the local console observation. It is still
  // ineligible because no formal object-store Artifact v2 was committed.
  const objectStoreBlocked = validateProofBundle({
    evidence: [makeEvidence("ev_minio", "console")],
    machineGate: makeMachineGate({
      status: "blocked",
      reasons: ["environment_unavailable", "artifact_object_store_unavailable"],
      reasonDetails: [
        { code: "environment_unavailable", summary: "MinIO unavailable", evidenceRefs: ["ev_minio"] },
        { code: "artifact_object_store_unavailable", summary: "MinIO unavailable", evidenceRefs: ["ev_minio"] }
      ]
    })
  });
  assert.equal(objectStoreBlocked.evidenceGrounded, true);
  assert.equal(objectStoreBlocked.evidenceComplete, false);
  assert.equal(objectStoreBlocked.issues.some((issue) => issue.includes("lacks evidence linkage")), false);

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

  // Run reports are intentionally self-referential: report.json and the
  // integrity manifest are written after runtime artifacts are captured and
  // therefore cannot be hashed without a circular dependency. They must be
  // visible in the report but never invalidate an otherwise verified bundle.
  const reportReferences = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport({ selfReferences: 5 }),
    requiredArtifactKinds: ["screenshot"]
  });
  assert.equal(reportReferences.artifactIntegrityVerified, true);
  assert.equal(reportReferences.evidenceComplete, true);

  // Proof identity must remain stable after report generation adds those
  // benign self-reference entries to the integrity report.
  const proofInput = {
    draft: { status: "pass" as const, reasons: [], reasonDetails: [], assertionFailures: [] },
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    requiredArtifactKinds: ["screenshot"]
  };
  const beforeReports = buildProofBundleId({ ...proofInput, artifactIntegrity: makeIntegrityReport() });
  const afterReports = buildProofBundleId({ ...proofInput, artifactIntegrity: makeIntegrityReport({ selfReferences: 5 }) });
  assert.equal(beforeReports, afterReports);

  // deriveGateEligible mirrors the runOutcomeSummaryV2 invariant.
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: true, evidenceGrounded: true }, { executionSucceeded: true, requirementCovered: true }), true);
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: false, evidenceGrounded: true }, { executionSucceeded: true, requirementCovered: true }), false);
  assert.equal(deriveGateEligible({ artifactIntegrityVerified: true, evidenceGrounded: true }, { executionSucceeded: false, requirementCovered: true }), false);

  const identityMismatch = finalizeProofBundle({
    draft: { status: "pass", reasons: [], reasonDetails: [{ code: "proof", summary: "verified", evidenceRefs: ["ev_1"] }], assertionFailures: [] },
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [{ ...makeArtifact("screenshot"), runId: "other-run" }],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    gateEligibleFacts: { executionSucceeded: true, requirementCovered: true }
  });
  assert.equal(identityMismatch.machineGate.status, "blocked");
  assert.ok(identityMismatch.verdict.issues.includes("artifact_run_mismatch:artifact_screenshot"));

  const notExecuted = finalizeProofBundle({
    draft: { status: "pass", reasons: [], reasonDetails: [{ code: "proof", summary: "verified", evidenceRefs: ["ev_1"] }], assertionFailures: [] },
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    gateEligibleFacts: { executionSucceeded: false, requirementCovered: false }
  });
  assert.equal(notExecuted.machineGate.status, "blocked");

  // A screenshot from the right Run but the wrong Attempt is still injected
  // evidence; the minting boundary must reject it just like a cross-Run item.
  const attemptMismatch = finalizeProofBundle({
    draft: { status: "pass", reasons: [], reasonDetails: [{ code: "proof", summary: "verified", evidenceRefs: ["ev_1"] }], assertionFailures: [] },
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [{ ...makeArtifact("screenshot"), attemptId: "attempt_2" }],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    gateEligibleFacts: { executionSucceeded: true, requirementCovered: true }
  });
  assert.equal(attemptMismatch.machineGate.status, "blocked");
  assert.ok(attemptMismatch.verdict.issues.includes("artifact_attempt_mismatch:artifact_screenshot"));

  // Fixture-only evidence without a manifest is not runtime proof.
  const fixtureOnly = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot", "fixture")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"]
  });
  assert.equal(fixtureOnly.evidenceComplete, false);
  assert.ok(fixtureOnly.issues.some((issue) => issue.includes("screenshot")));

  // Evidence records cannot point at an artifact that is absent from the
  // persisted bundle; a dangling screenshot reference is a credibility error.
  const danglingArtifact = validateProofBundle({
    evidence: [{ ...makeEvidence("ev_1"), artifactIds: ["artifact_missing"] }],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"]
  });
  assert.equal(danglingArtifact.evidenceComplete, false);
  assert.ok(danglingArtifact.issues.includes("evidence artifact ref not found in bundle: ev_1:artifact_missing"));

  // An Oracle with no evidence refs was planned but never observed.
  const oracleNotExecuted = validateProofBundle({
    evidence: [makeEvidence("ev_1")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    oracles: [{
      id: "oracle_unexecuted",
      pathId: "path_1",
      assertionName: "business state",
      expectedFrom: "requirement",
      preconditions: [],
      action: "click",
      postconditions: ["state changed"],
      requiresHumanConfirmation: false,
      evidenceRefs: []
    }]
  });
  assert.equal(oracleNotExecuted.evidenceComplete, false);
  assert.ok(oracleNotExecuted.issues.includes("oracle not executed: oracle_unexecuted"));

  // A full screenshot cannot turn a failed business assertion into a pass.
  const businessFailure = finalizeProofBundle({
    draft: {
      status: "fail",
      reasons: ["assertion_failed"],
      reasonDetails: [{ code: "assertion_failed", summary: "订单状态错误", evidenceRefs: ["ev_1"] }],
      assertionFailures: ["order status"]
    },
    runId: "run_1",
    scenarioId: "scenario_1",
    attemptId: "attempt_1",
    evidence: [makeEvidence("ev_1", "assertion")],
    artifactsV2: [makeArtifact("screenshot")],
    artifactIntegrity: makeIntegrityReport(),
    requiredArtifactKinds: ["screenshot"],
    gateEligibleFacts: { executionSucceeded: true, requirementCovered: true }
  });
  assert.equal(businessFailure.machineGate.status, "fail");
  assert.equal(businessFailure.verdict.evidenceComplete, true);

  // An LLM/Judge pass is advisory and cannot override a failed Machine Gate.
  const judgePassMachineFail = runOutcomeSummaryV2Schema.safeParse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: true,
    requirementCovered: true,
    requirementPassed: true,
    artifactIntegrityVerified: true,
    evidenceGrounded: true,
    gateEligible: true,
    machineGate: { status: "fail", reasons: [], reasonDetails: [], assertionFailures: ["business"], evidenceComplete: true },
    judgeRecommendation: { status: "pass", summary: "advisory only", evidenceRefs: ["ev_1"] },
    finalStatus: "pass"
  });
  assert.equal(judgePassMachineFail.success, false);
}
