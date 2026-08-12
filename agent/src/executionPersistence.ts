import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { MachineGate } from "@ai-test-officer/contracts";
import type { VisualRunResult } from "./types.js";
import {
  assertAttemptBinding,
  buildProofBundleCanonicalSha256,
  CredibilityError,
  verifyPersistedProofBundle,
  type AttemptBindingContext,
  type PersistedProofBundleRecord
} from "./proof/proofBundleIntegrity.js";
import { validateProofBundle, type ProofBundleInput, type ProofVerdict } from "./proof/proofBundleValidator.js";
import type { VerifiedMachineGate } from "./proof/proofBundleService.js";

let pool: Pool | undefined;
function database() { return process.env.DATABASE_URL ? pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) : undefined; }

/** Read a single persisted proof bundle row by its proof bundle id. */
export async function readProofBundleRecord(proofBundleId: string): Promise<PersistedProofBundleRecord | undefined> {
  const db = database();
  if (!db) return undefined;
  try {
    const result = await db.query(
      `SELECT jsonb_build_object(
           'id', id, 'runId', run_id, 'attemptId', attempt_id, 'scenarioId', scenario_id,
           'status', status, 'reasons', reasons, 'reasonDetails', reason_details,
           'assertionFailures', assertion_failures, 'evidenceComplete', evidence_complete,
           'artifactIntegrityVerified', artifact_integrity_verified, 'evidenceGrounded', evidence_grounded,
           'gateEligible', gate_eligible, 'proofBundleId', proof_bundle_id,
           'proofValidationVersion', proof_validation_version, 'canonicalSha256', canonical_sha256
         ) AS payload FROM proof_bundles_v1 WHERE proof_bundle_id = $1`,
      [proofBundleId]
    );
    return result.rows[0]?.payload as PersistedProofBundleRecord | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-verify a gate that already carries a `proofBundleId` against the
 * authoritative ledger row before it is trusted / returned to a caller. A
 * tampered or inconsistent gate (canonical hash mismatch, wrong run / attempt /
 * scenario binding, evidence not bound to the attempt) is downgraded to
 * `needs-human-review` so it can never be used to declare a run "pass".
 *
 * When the ledger row does not exist (offline / file-only mode, or the row is
 * legitimately not yet written on the same pass that minted it — the graph
 * re-reads the bundle before `persistExecutionResult` writes the row) we trust
 * the gate; the persistence boundary already fails closed
 * (`proof_persistence_failed`) when a DB-backed write cannot complete.
 */
export async function revalidatePersistedMachineGate(
  runId: string,
  gate: VerifiedMachineGate,
  proofInput: ProofBundleInput
): Promise<MachineGate> {
  const verdict = validateProofBundle(proofInput);
  const evidenceAttemptIds = (proofInput.evidence ?? [])
    .map((evidence) => evidence.attemptId)
    .filter((attemptId): attemptId is string => Boolean(attemptId));
  const record = await readProofBundleRecord(gate.proofBundleId);
  if (!record) return gate;
  const issues = await verifyPersistedProofBundle({
    runId,
    gate,
    verdict,
    evidenceAttemptIds,
    loadRecord: readProofBundleRecord
  });
  if (issues.length === 0) return gate;
  return {
    ...gate,
    status: "needs-human-review",
    reasons: [...(gate.reasons ?? []), `proof_bundle_revalidation_failed:${issues.join("|")}`],
    reasonDetails: [
      ...(gate.reasonDetails ?? []),
      {
        code: "proof_revalidation_failed",
        summary: `Proof bundle ${gate.proofBundleId} failed re-validation: ${issues.join(", ")}`,
        evidenceRefs: []
      }
    ]
  };
}

/** Project a persisted run result onto the input the Proof Bundle validator expects. */
function buildProofInputFromResult(result: VisualRunResult): ProofBundleInput {
  return {
    evidence: result.evidence,
    artifactsV2: result.artifactsV2,
    artifactIntegrity: result.artifactIntegrity,
    machineGate: result.machineGate,
    judgeReport: result.judgeReport,
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix
  };
}

export async function persistExecutionResult(
  controlRunId: string,
  result: VisualRunResult,
  verified?: { verdict: ProofVerdict; gateEligible: boolean }
) {
  const db = database();
  if (!db) return;
  const client = await db.connect();
  const validAttemptIds = (result.attempts ?? []).map((attempt) => attempt.id);
  const binding: AttemptBindingContext = { runId: controlRunId, validAttemptIds };
  try {
    await client.query("BEGIN");
    for (const attempt of result.attempts ?? []) {
      await client.query("INSERT INTO attempts_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [attempt.id, controlRunId, attempt]);
    }
    for (const artifact of result.artifactsV2 ?? []) {
      await client.query("INSERT INTO artifacts_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [artifact.id, controlRunId, artifact]);
    }
    for (const evidence of result.evidence) {
      await client.query("INSERT INTO evidence_v1 (id,run_id,payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload", [evidence.id, controlRunId, evidence]);
    }
    for (const item of result.coverageItems ?? []) {
      await client.query(
        "INSERT INTO coverage_items_v1 (id,run_id,flow_id,disposition,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET disposition=EXCLUDED.disposition,payload=EXCLUDED.payload",
        [item.id, controlRunId, item.flowId, item.disposition, item]
      );
    }
    for (const conclusion of result.conclusions ?? []) {
      assertAttemptBinding(binding, { kind: "conclusion", refId: conclusion.conclusionId, attemptId: conclusion.attemptId, runId: controlRunId });
      await client.query(
        "INSERT INTO conclusions_v1 (id,run_id,scenario_id,attempt_id,claim_type,proof_status,canonical_sha256,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
        [conclusion.conclusionId, controlRunId, conclusion.scenarioId, conclusion.attemptId, conclusion.claimType, conclusion.proofStatus, conclusion.canonicalSha256, conclusion]
      );
    }
    for (const node of result.proofNodes ?? []) {
      assertAttemptBinding(binding, { kind: "proof_node", refId: node.id, attemptId: node.attemptId, runId: controlRunId });
      await client.query(
        `INSERT INTO proof_nodes_v1
         (id,run_id,scenario_id,attempt_id,node_type,canonical_sha256,payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id,run_id,scenario_id,attempt_id) DO NOTHING`,
        [node.id, controlRunId, node.scenarioId, node.attemptId, node.nodeType, node.canonicalSha256, node]
      );
      if (node.nodeType === "assertion" || node.nodeType === "oracle") {
        const table = node.nodeType === "assertion" ? "assertions_v1" : "oracles_v1";
        await client.query(
          `INSERT INTO ${table}
           (id,run_id,scenario_id,attempt_id,canonical_sha256,payload)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id,run_id,scenario_id,attempt_id) DO NOTHING`,
          [node.id, controlRunId, node.scenarioId, node.attemptId, node.canonicalSha256, node.payload]
        );
      }
    }
    for (const edge of result.proofEdges ?? []) {
      assertAttemptBinding(binding, { kind: "proof_edge", refId: edge.id, attemptId: edge.attemptId, runId: controlRunId });
      await client.query(
        "INSERT INTO proof_edges_v1 (id,run_id,scenario_id,attempt_id,from_type,from_id,to_type,to_id,canonical_sha256,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING",
        [edge.id, controlRunId, edge.scenarioId, edge.attemptId, edge.fromType, edge.fromId, edge.toType, edge.toId, edge.canonicalSha256, edge]
      );
    }
    if (result.evidenceManifest) {
      await client.query(
        "INSERT INTO run_evidence_manifests_v1 (run_id,evidence_set_root,integrity_status,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (run_id) DO UPDATE SET evidence_set_root=EXCLUDED.evidence_set_root,integrity_status=EXCLUDED.integrity_status,payload=EXCLUDED.payload",
        [controlRunId, result.evidenceManifest.evidenceSetRoot, result.evidenceManifest.integrityStatus, result.evidenceManifest]
      );
    }
    await client.query("INSERT INTO judge_results_v1 (id,run_id,payload) VALUES ($1,$2,$3)", [`judge_${randomUUID()}`, controlRunId, result.judgeReport]);

    // Authoritative credibility ledger. Only a gate minted by
    // finalizeProofBundle() (it carries proofBundleId) is eligible. The row is
    // bound to the attempt that actually produced the gate — not just the
    // run's first attempt — so sibling attempts cannot be conflated.
    const candidateGate = result.machineGate as (VerifiedMachineGate & MachineGate) | undefined;
    if (candidateGate?.proofBundleId) {
      // The attempt that produced the gate is taken from the verified gate
      // itself (finalizeProofBundle stamps attemptId), falling back to the
      // attempt referenced by the first proof conclusion, then the run's first
      // attempt. We never blindly use validAttemptIds[0].
      const gateAttemptId =
        candidateGate.attemptId
        ?? (result.conclusions ?? [])[0]?.attemptId
        ?? (result.attempts ?? [])[0]?.id
        ?? null;
      const scenarioId = candidateGate.scenarioId ?? null;
      // P0-#4 — credibility booleans come from the *verified* ProofVerdict, never
      // from a type-cast on the gate itself. A plain MachineGate has no such
      // fields; reading them off it via `as unknown as` silently coerced them to
      // false (or trusted a self-asserted literal). Callers that already hold the
      // finalizeProofBundle() verdict pass it via `verified`; otherwise we
      // recompute it from the persisted result so the ledger stores real facts.
      const credibilityVerdict = verified?.verdict
        ?? validateProofBundle(buildProofInputFromResult(result));
      const artifactIntegrityVerified = credibilityVerdict.artifactIntegrityVerified;
      const evidenceGrounded = credibilityVerdict.evidenceGrounded;
      const gateEligible = verified?.gateEligible
        ?? (credibilityVerdict.artifactIntegrityVerified && credibilityVerdict.evidenceGrounded);
      // P0-14 — an attempt-scoped gate must name its attempt. A NULL attempt is
      // only legal when the run genuinely produced no attempt to bind to (a
      // run-level aggregate), and that has to be declared so the ledger's CHECK
      // can reject an unbound gate instead of letting it look like an aggregate.
      const aggregateAttempt = gateAttemptId === null;
      if (aggregateAttempt && (result.attempts ?? []).length > 0) {
        throw new CredibilityError(
          "proof_attempt_unbound",
          `run ${controlRunId} minted a verified gate without an attempt id while ${(result.attempts ?? []).length} attempts exist; refusing to record an unbindable credibility row`
        );
      }
      const canonical = buildProofBundleCanonicalSha256({
        runId: controlRunId,
        attemptId: gateAttemptId ?? undefined,
        scenarioId: scenarioId ?? undefined,
        status: candidateGate.status,
        reasons: candidateGate.reasons ?? [],
        reasonDetails: candidateGate.reasonDetails ?? [],
        assertionFailures: candidateGate.assertionFailures ?? [],
        evidenceComplete: candidateGate.evidenceComplete,
        artifactIntegrityVerified,
        evidenceGrounded,
        gateEligible,
        proofValidationVersion: candidateGate.proofValidationVersion ?? ""
      });
      try {
        // The ledger is immutable and has one record per exact run/attempt.
        // Replaying the same worker event is harmless only if it remints the
        // exact same gate. A different Proof Bundle ID or canonical hash for
        // that attempt is an internal credibility conflict, not a product
        // failure and must never be silently converted into a repair request.
        const existing = await client.query<{
          id: string;
          proof_bundle_id: string;
          canonical_sha256: string;
        }>(
          `SELECT id, proof_bundle_id, canonical_sha256
             FROM proof_bundles_v1
            WHERE run_id = $1
              AND attempt_id IS NOT DISTINCT FROM $2
              AND aggregate_attempt = $3
            LIMIT 1`,
          [controlRunId, gateAttemptId, aggregateAttempt]
        );
        const matchesExisting = (row: { id: string; proof_bundle_id: string; canonical_sha256: string }) =>
          row.id === candidateGate.proofBundleId
          && row.proof_bundle_id === candidateGate.proofBundleId
          && row.canonical_sha256 === canonical;
        if (existing.rows[0]) {
          if (!matchesExisting(existing.rows[0])) {
            throw new CredibilityError(
              "proof_bundle_attempt_conflict",
              `run ${controlRunId} attempt ${gateAttemptId ?? "aggregate"} already has an immutable proof bundle with different facts`
            );
          }
        } else {
          const inserted = await client.query(
          `INSERT INTO proof_bundles_v1
           (id,run_id,attempt_id,aggregate_attempt,scenario_id,status,reasons,reason_details,assertion_failures,evidence_complete,artifact_integrity_verified,evidence_grounded,gate_eligible,proof_bundle_id,proof_validation_version,canonical_sha256,payload)
           VALUES ($1,$2,$3,$17,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING
           RETURNING id, proof_bundle_id, canonical_sha256`,
          [
            candidateGate.proofBundleId, controlRunId, gateAttemptId, scenarioId, candidateGate.status,
            JSON.stringify(candidateGate.reasons ?? []), JSON.stringify(candidateGate.reasonDetails ?? []), JSON.stringify(candidateGate.assertionFailures ?? []),
            candidateGate.evidenceComplete, artifactIntegrityVerified, evidenceGrounded, gateEligible,
            candidateGate.proofBundleId, candidateGate.proofValidationVersion ?? "", canonical, JSON.stringify(candidateGate),
            aggregateAttempt
          ]
        );
          // A simultaneous replay may have inserted the authoritative row
          // between the lookup and our INSERT. Treat only an exact match as
          // idempotent; otherwise fail closed with an actionable internal
          // credibility error.
          if (inserted.rowCount === 0) {
            const raced = await client.query<{
              id: string;
              proof_bundle_id: string;
              canonical_sha256: string;
            }>(
              `SELECT id, proof_bundle_id, canonical_sha256
                 FROM proof_bundles_v1
                WHERE run_id = $1
                  AND attempt_id IS NOT DISTINCT FROM $2
                  AND aggregate_attempt = $3
                LIMIT 1`,
              [controlRunId, gateAttemptId, aggregateAttempt]
            );
            if (!raced.rows[0] || !matchesExisting(raced.rows[0])) {
              throw new CredibilityError(
                "proof_bundle_attempt_conflict",
                `run ${controlRunId} attempt ${gateAttemptId ?? "aggregate"} has a conflicting immutable proof bundle`
              );
            }
          }
        }
      } catch (ledgerError) {
        // In production the credibility ledger is the source of truth for
        // "this run was verified". A run whose proof bundle cannot be persisted
        // must NOT be allowed to enter `pass`: we surface proof_persistence_failed
        // and roll back the whole persist. Only non-production (local dev) is
        // allowed to degrade to a best-effort file record.
        const strict = process.env.NODE_ENV === "production" || process.env.PROOF_LEDGER_STRICT === "true";
        if (ledgerError instanceof CredibilityError || strict) {
          throw new CredibilityError(
            ledgerError instanceof CredibilityError ? ledgerError.code : "proof_persistence_failed",
            `proof bundle ledger write failed for run ${controlRunId}: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`
          );
        }
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
