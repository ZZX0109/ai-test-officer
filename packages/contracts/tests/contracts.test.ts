import assert from "node:assert/strict";
import {
  artifactGateEligibility,
  artifactV2Schema,
  defaultResourceBudget,
  normalizeLegacyGateStatus,
  projectManifestSchema,
  transitionRunState,
  validateEvidenceArtifactLinks,
  resolveFinalStatus
  ,createRunRequestSchema
  ,planProvenanceSchema
} from "../src/index.js";

const artifact = artifactV2Schema.parse({
  schemaVersion: "2.0",
  id: "artifact-1",
  runId: "run-1",
  scenarioId: "scenario-1",
  stepId: "step-1",
  attemptId: "attempt-1",
  attempt: 1,
  kind: "screenshot",
  origin: "runtime-captured",
  storageUri: "s3://bucket/run-1/step-1.png",
  sequence: 1,
  monotonicOffsetMs: 12,
  integrity: {
    sha256: "a".repeat(64),
    sizeBytes: 10,
    mediaType: "image/png",
    capturedAt: "2026-07-14T00:00:00.000Z",
    collector: { name: "playwright", version: "1.0.0" }
  }
});
assert.equal(artifactGateEligibility(artifact).eligible, true);
assert.equal(artifactGateEligibility({ ...artifact, origin: "simulated" }).eligible, false);
assert.equal(artifactGateEligibility({ ...artifact, origin: "user-uploaded" }).eligible, false);
assert.deepEqual(validateEvidenceArtifactLinks({
  schemaVersion: "2.0",
  id: "evidence-1",
  runId: "other-run",
  scenarioId: artifact.scenarioId,
  attemptId: artifact.attemptId,
  attempt: artifact.attempt,
  capturedAt: "2026-07-14T00:00:00.000Z",
  artifactIds: [artifact.id],
  summary: "invalid immutable link"
}, [artifact]), { valid: false, errors: [`${artifact.id}:run_mismatch`] });
assert.equal(normalizeLegacyGateStatus("hold_for_review"), "needs-human-review");
assert.equal(transitionRunState("awaiting-plan-approval", "plan_approved"), "awaiting-permission");
assert.equal(transitionRunState("planning", "plan_generated"), "awaiting-plan-approval");
assert.equal(resolveFinalStatus({
  machineGate: { status: "pass", reasons: [], assertionFailures: [], evidenceComplete: true },
  judgeRecommendation: { status: "needs-human-review", summary: "uncertain", evidenceRefs: [] }
}), "needs-human-review");
assert.equal(resolveFinalStatus({
  machineGate: { status: "fail", reasons: ["assertion"], assertionFailures: ["amount"], evidenceComplete: true },
  judgeRecommendation: { status: "pass", summary: "wrong", evidenceRefs: [] },
  humanDecision: { status: "approved", actor: "reviewer", reason: "override", decidedAt: "2026-07-14T00:00:00.000Z" }
}), "fail");
assert.equal(defaultResourceBudget.maxAttempts, 2);
assert.throws(() => projectManifestSchema.parse({ schemaVersion: "1.0", projectId: "demo", workspaceRoot: ".", commandAllowlist: ["npm"], commands: { start: { executable: "npm && rm", args: [] } } }));
assert.throws(() => createRunRequestSchema.parse({ idempotencyKey: "llm-without-model", projectId: "demo", input: { plannerMode: "llm" } }));
assert.throws(() => planProvenanceSchema.parse({ source: "llm", promptVersion: "v1", model: "model", llmCallId: "call", compilationStatus: "validated", fallbackReason: "silent fallback" }));
console.log("contracts tests passed");
