import assert from "node:assert/strict";
import { artifactGateEligibility } from "@ai-test-officer/contracts";
import {
  buildArtifactObjectReconciliationPlan,
  reconcileConfiguredArtifactStore,
  type ArtifactObjectReference,
  type ArtifactObjectStoreAdapter
} from "../src/artifactObjectReconciliation.js";
import type { Pool } from "pg";

const now = new Date("2026-08-24T00:00:00.000Z");

function reference(id: string, key: string): ArtifactObjectReference {
  return {
    artifactId: id,
    runId: "run_reconcile",
    key,
    uri: `s3://artifacts/${key}`,
    sizeBytes: 12,
    sha256: "a".repeat(64),
    currentState: "committed"
  };
}

export function testArtifactObjectReconciliationPlan() {
  const plan = buildArtifactObjectReconciliationPlan({
    references: [
      reference("artifact_present", "ai-test-officer/run/scenario/attempt/present.png"),
      reference("artifact_missing", "ai-test-officer/run/scenario/attempt/missing.png")
    ],
    objects: [
      { key: "ai-test-officer/run/scenario/attempt/present.png", lastModified: new Date("2026-08-23T23:00:00.000Z") },
      { key: "ai-test-officer/orphan/old.png", lastModified: new Date("2026-08-22T00:00:00.000Z") },
      { key: "ai-test-officer/orphan/fresh.png", lastModified: new Date("2026-08-23T23:59:00.000Z") },
      { key: "ai-test-officer/.partial/old-upload", lastModified: new Date("2026-08-23T22:00:00.000Z") },
      { key: "ai-test-officer/.partial/fresh-upload", lastModified: new Date("2026-08-23T23:59:00.000Z") }
    ],
    prefix: "ai-test-officer",
    now
  });
  assert.deepEqual(plan.missingReferences.map((item) => item.artifactId), ["artifact_missing"]);
  assert.deepEqual(plan.committedReferences.map((item) => item.artifactId), ["artifact_present"]);
  assert.deepEqual(plan.orphanObjectKeys, ["ai-test-officer/orphan/old.png"], "fresh objects remain inside the metadata-commit grace period");
  assert.deepEqual(plan.stalePartialObjectKeys, ["ai-test-officer/.partial/old-upload"]);

  const missingArtifact = {
    schemaVersion: "2.0" as const,
    id: "artifact_missing",
    runId: "run_reconcile",
    scenarioId: "scenario",
    attemptId: "attempt",
    attempt: 1,
    kind: "screenshot" as const,
    origin: "runtime-captured" as const,
    storageUri: "/artifacts/runs/run_reconcile/missing.png",
    replicaUris: ["s3://artifacts/ai-test-officer/run/scenario/attempt/missing.png"],
    objectStoreState: "missing" as const,
    sequence: 1,
    monotonicOffsetMs: 0,
    integrity: { sha256: "a".repeat(64), sizeBytes: 12, mediaType: "image/png", capturedAt: now.toISOString() }
  };
  assert.equal(artifactGateEligibility(missingArtifact).eligible, false, "a reconciled missing replica must not support a Machine Gate");
}

class ReconciliationDatabase {
  readonly rows = [{
    id: "artifact_bad_digest",
    run_id: "run_reconcile",
    payload: {
      replicaUris: ["s3://artifacts/ai-test-officer/run/scenario/attempt/proof.png"],
      integrity: { sizeBytes: 12, sha256: "a".repeat(64) },
      objectStoreState: "committed"
    }
  }];
  readonly reconciliations: Array<{ artifactId: string; state: string; detail?: string }> = [];

  async query<T = unknown>(sql: string, params: unknown[] = []) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS artifact_reconciliation_v1")) return { rows: [] as T[], rowCount: 0 };
    if (sql.includes("SELECT id,run_id,payload FROM artifacts_v1")) return { rows: this.rows as T[], rowCount: this.rows.length };
    throw new Error(`unexpected_reconciliation_database_sql:${sql.slice(0, 48)}:${params.length}`);
  }

  async connect() {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("UPDATE artifacts_v1")) {
          const row = this.rows.find((item) => item.id === params[0]);
          if (row) row.payload.objectStoreState = String(params[1]);
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes("INSERT INTO artifact_reconciliation_v1")) {
          this.reconciliations.push({ artifactId: String(params[0]), state: String(params[3]), detail: typeof params[4] === "string" ? params[4] : undefined });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected_reconciliation_client_sql:${sql.slice(0, 48)}`);
      },
      release() {}
    };
  }
}

export async function testArtifactObjectReconciliationApply() {
  const database = new ReconciliationDatabase();
  const deleted: string[] = [];
  const store: ArtifactObjectStoreAdapter = {
    async listObjects() {
      return {
        objects: [
          { key: "ai-test-officer/run/scenario/attempt/proof.png", lastModified: new Date("2026-08-23T20:00:00.000Z") },
          { key: "ai-test-officer/orphan/old.png", lastModified: new Date("2026-08-22T00:00:00.000Z") },
          { key: "ai-test-officer/.partial/old", lastModified: new Date("2026-08-23T20:00:00.000Z") }
        ]
      };
    },
    async headObject() {
      return { sizeBytes: 12, sha256: "b".repeat(64) };
    },
    async deleteObject({ key }) {
      deleted.push(key);
    }
  };
  const result = await reconcileConfiguredArtifactStore({
    apply: true,
    database: database as unknown as Pool,
    bucket: "artifacts",
    prefix: "ai-test-officer",
    store,
    now
  });
  assert.deepEqual(result.missingReferences.map((item) => item.artifactId), ["artifact_bad_digest"]);
  assert.equal(database.rows[0]?.payload.objectStoreState, "missing");
  assert.deepEqual(database.reconciliations, [{ artifactId: "artifact_bad_digest", state: "missing", detail: "object_sha256_mismatch" }]);
  assert.deepEqual(deleted.sort(), ["ai-test-officer/.partial/old", "ai-test-officer/orphan/old.png"]);
  assert.equal(result.deletedObjects, 2);
}
