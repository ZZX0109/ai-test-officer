import { pathToFileURL } from "node:url";
import { PROOF_VALIDATION_VERSION, type VerifiedMachineGate } from "../src/proof/proofBundleService.js";
import {
  assertAttemptBinding,
  assertVerifiedMachineGate,
  buildProofBundleCanonicalSha256,
  validatePersistedCredibility,
  CredibilityError,
  type AttemptBindingContext
} from "../src/proof/proofBundleIntegrity.js";

function verifiedGate(overrides: Partial<VerifiedMachineGate> = {}): VerifiedMachineGate {
  return {
    status: "pass",
    reasons: [],
    reasonDetails: [],
    assertionFailures: [],
    evidenceComplete: true,
    proofBundleId: "proof_run_1_abc",
    proofValidationVersion: PROOF_VALIDATION_VERSION,
    ...overrides
  };
}

function expectThrow(fn: () => void, code: string) {
  try {
    fn();
    throw new Error(`expected CredibilityError(${code}) but nothing was thrown`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected CredibilityError")) throw error;
    if (!(error instanceof CredibilityError) || error.code !== code) {
      throw new Error(
        `expected CredibilityError(code="${code}") but got: ${
          error instanceof CredibilityError ? `code="${error.code}"` : (error as Error).message
        }`
      );
    }
  }
}

export function testProofBundleIntegrity() {
  // --- assertAttemptBinding -------------------------------------------------
  const ctx: AttemptBindingContext = { runId: "run_1", validAttemptIds: ["run_1_attempt_1", "run_1_attempt_2"] };

  // same-run, known attempt — allowed
  assertAttemptBinding(ctx, { kind: "proof_node", refId: "n1", attemptId: "run_1_attempt_1", runId: "run_1" });

  // sibling attempt inside the same run — MUST be rejected (cross-attempt injection)
  expectThrow(
    () => assertAttemptBinding(ctx, { kind: "conclusion", refId: "c1", attemptId: "run_1_attempt_9", runId: "run_1" }),
    "cross_attempt_injection"
  );

  // attempt that belongs to a different run — MUST be rejected
  expectThrow(
    () => assertAttemptBinding(ctx, { kind: "proof_edge", refId: "e1", attemptId: "run_2_attempt_1", runId: "run_1" }),
    "cross_attempt_injection"
  );

  // wrong runId on the record — MUST be rejected
  expectThrow(
    () => assertAttemptBinding(ctx, { kind: "proof_node", refId: "n2", attemptId: "run_1_attempt_1", runId: "run_2" }),
    "cross_attempt_injection"
  );

  // missing attemptId — MUST be rejected
  expectThrow(
    () => assertAttemptBinding(ctx, { kind: "proof_node", refId: "n3" }),
    "missing_attempt_id"
  );

  // --- assertVerifiedMachineGate -------------------------------------------
  assertVerifiedMachineGate(verifiedGate()); // minted gate passes

  expectThrow(() => assertVerifiedMachineGate({ ...verifiedGate(), proofBundleId: "" }), "unverified_machine_gate");
  expectThrow(() => assertVerifiedMachineGate({ ...verifiedGate(), proofBundleId: undefined } as unknown as VerifiedMachineGate), "unverified_machine_gate");
  expectThrow(
    () => assertVerifiedMachineGate({ ...verifiedGate(), proofValidationVersion: "0.0.1" }),
    "proof_version_mismatch"
  );

  // --- validatePersistedCredibility ----------------------------------------
  const gate = verifiedGate();
  const verdict = { artifactIntegrityVerified: true, evidenceGrounded: true, evidenceComplete: true };
  if (validatePersistedCredibility(gate, verdict).length !== 0) {
    throw new Error("expected no credibility issues for a consistent gate+verdict");
  }
  const issues = validatePersistedCredibility(gate, { ...verdict, evidenceComplete: false });
  if (!issues.includes("evidenceComplete_mismatch")) {
    throw new Error(`expected evidenceComplete_mismatch, got: ${JSON.stringify(issues)}`);
  }
  const issuesVersion = validatePersistedCredibility({ ...verifiedGate(), proofValidationVersion: "0.0.1" }, verdict);
  if (!issuesVersion.includes("proof_version_mismatch")) {
    throw new Error(`expected proof_version_mismatch, got: ${JSON.stringify(issuesVersion)}`);
  }
  const issuesMissing = validatePersistedCredibility({ ...verifiedGate(), proofBundleId: "" }, verdict);
  if (!issuesMissing.includes("missing_proofBundleId")) {
    throw new Error(`expected missing_proofBundleId, got: ${JSON.stringify(issuesMissing)}`);
  }

  // --- buildProofBundleCanonicalSha256 -------------------------------------
  const base = {
    runId: "run_1",
    attemptId: "run_1_attempt_1",
    status: "pass",
    reasons: ["a", "b"],
    reasonDetails: [],
    assertionFailures: [],
    evidenceComplete: true,
    artifactIntegrityVerified: true,
    evidenceGrounded: true,
    gateEligible: true,
    proofValidationVersion: PROOF_VALIDATION_VERSION
  };
  const h1 = buildProofBundleCanonicalSha256(base);
  const h2 = buildProofBundleCanonicalSha256({ ...base, reasons: ["b", "a"] }); // order-independent
  const h3 = buildProofBundleCanonicalSha256({ ...base, evidenceComplete: false });
  if (h1 !== h2) throw new Error("canonical sha must be order-independent for reasons");
  if (h1 === h3) throw new Error("canonical sha must change when a credibility field changes");

  console.log("proof bundle integrity tests passed");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  testProofBundleIntegrity();
}
