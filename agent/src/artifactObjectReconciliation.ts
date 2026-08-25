import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";
import type { ArtifactV2 } from "@ai-test-officer/contracts";
import type { Pool } from "pg";
import { getDatabasePool } from "./databaseRuntime.js";

export type ArtifactObjectStoreState = NonNullable<ArtifactV2["objectStoreState"]>;

export interface ArtifactObjectReference {
  artifactId: string;
  runId: string;
  key: string;
  uri: string;
  sizeBytes: number;
  sha256: string;
  currentState?: ArtifactObjectStoreState;
}

export interface ObjectListing {
  key: string;
  sizeBytes?: number;
  lastModified?: Date;
}

export interface ArtifactObjectStoreAdapter {
  listObjects(input: { bucket: string; prefix: string; cursor?: string }): Promise<{ objects: ObjectListing[]; nextCursor?: string }>;
  headObject(input: { bucket: string; key: string }): Promise<{ sizeBytes?: number; sha256?: string } | undefined>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export interface ArtifactReconciliationPlan {
  missingReferences: ArtifactObjectReference[];
  committedReferences: ArtifactObjectReference[];
  orphanObjectKeys: string[];
  stalePartialObjectKeys: string[];
}

export interface ArtifactReconciliationResult extends ArtifactReconciliationPlan {
  enabled: boolean;
  applied: boolean;
  scannedObjects: number;
  updatedArtifacts: number;
  deletedObjects: number;
}

function normalizedPrefix(value = process.env.ARTIFACT_S3_PREFIX ?? "ai-test-officer") {
  return value.replace(/^\/+|\/+$/g, "");
}

function configuredBucket(value = process.env.ARTIFACT_S3_BUCKET) {
  return value?.trim() || undefined;
}

function parseS3Uri(uri: string) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  return match ? { bucket: match[1], key: match[2] } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function artifactReferencesFromRow(row: { id: string; run_id: string; payload: unknown }, bucket: string): ArtifactObjectReference[] {
  const payload = asRecord(row.payload);
  const replicaUris = Array.isArray(payload?.replicaUris) ? payload.replicaUris.filter((item): item is string => typeof item === "string") : [];
  const integrity = asRecord(payload?.integrity);
  const sizeBytes = typeof integrity?.sizeBytes === "number" ? integrity.sizeBytes : undefined;
  const sha256 = typeof integrity?.sha256 === "string" ? integrity.sha256 : undefined;
  if (sizeBytes === undefined || !sha256) return [];
  const currentState = payload?.objectStoreState === "committed" || payload?.objectStoreState === "missing" || payload?.objectStoreState === "uncommitted"
    ? payload.objectStoreState
    : undefined;
  return replicaUris.flatMap((uri) => {
    const parsed = parseS3Uri(uri);
    if (!parsed || parsed.bucket !== bucket) return [];
    return [{ artifactId: row.id, runId: row.run_id, key: parsed.key, uri, sizeBytes, sha256, currentState }];
  });
}

function olderThan(date: Date | undefined, cutoffMs: number, now: Date) {
  return Boolean(date && date.getTime() <= now.getTime() - cutoffMs);
}

/**
 * Calculate a conservative reconciliation plan.  An object that might still
 * be between the S3 commit and PostgreSQL metadata transaction is retained for
 * the configured grace period; only old, unreferenced objects are deletable.
 */
export function buildArtifactObjectReconciliationPlan(input: {
  references: ArtifactObjectReference[];
  objects: ObjectListing[];
  prefix: string;
  now?: Date;
  orphanGraceMs?: number;
  partialGraceMs?: number;
}): ArtifactReconciliationPlan {
  const now = input.now ?? new Date();
  const orphanGraceMs = input.orphanGraceMs ?? 24 * 60 * 60 * 1_000;
  const partialGraceMs = input.partialGraceMs ?? 60 * 60 * 1_000;
  const objectKeys = new Set(input.objects.map((object) => object.key));
  const referencedKeys = new Set(input.references.map((reference) => reference.key));
  const partialPrefix = `${input.prefix}/.partial/`;
  const missingReferences = input.references.filter((reference) => !objectKeys.has(reference.key));
  const committedReferences = input.references.filter((reference) => objectKeys.has(reference.key));
  const orphanObjectKeys: string[] = [];
  const stalePartialObjectKeys: string[] = [];
  for (const object of input.objects) {
    if (object.key.startsWith(partialPrefix)) {
      if (olderThan(object.lastModified, partialGraceMs, now)) stalePartialObjectKeys.push(object.key);
      continue;
    }
    if (!referencedKeys.has(object.key) && olderThan(object.lastModified, orphanGraceMs, now)) {
      orphanObjectKeys.push(object.key);
    }
  }
  return { missingReferences, committedReferences, orphanObjectKeys, stalePartialObjectKeys };
}

function s3Adapter(): ArtifactObjectStoreAdapter {
  const client = new S3Client({
    region: process.env.ARTIFACT_S3_REGION ?? "us-east-1",
    endpoint: process.env.ARTIFACT_S3_ENDPOINT,
    forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "1"
  });
  return {
    async listObjects(input) {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        ContinuationToken: input.cursor
      }));
      return {
        objects: (result.Contents ?? []).flatMap((item) => item.Key ? [{
          key: item.Key,
          sizeBytes: item.Size,
          lastModified: item.LastModified
        }] : []),
        nextCursor: result.IsTruncated ? result.NextContinuationToken : undefined
      };
    },
    async headObject(input) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));
        return { sizeBytes: result.ContentLength, sha256: result.Metadata?.sha256 };
      } catch (error) {
        const status = typeof error === "object" && error && "$metadata" in error
          ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
          : undefined;
        if (status === 404 || (error instanceof Error && /not.?found|nosuchkey/i.test(error.name))) return undefined;
        throw error;
      }
    },
    async deleteObject(input) {
      await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
    }
  };
}

async function ensureArtifactReconciliationSchema(database: Pool) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS artifact_reconciliation_v1 (
      artifact_id TEXT PRIMARY KEY REFERENCES artifacts_v1(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      object_uri TEXT NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS artifact_reconciliation_v1_run_idx
      ON artifact_reconciliation_v1 (run_id, state);
  `);
}

async function listAllObjects(store: ArtifactObjectStoreAdapter, bucket: string, prefix: string) {
  const objects: ObjectListing[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listObjects({ bucket, prefix, cursor });
    objects.push(...page.objects);
    cursor = page.nextCursor;
  } while (cursor);
  return objects;
}

function checkedState(reference: ArtifactObjectReference, head: { sizeBytes?: number; sha256?: string } | undefined) {
  if (!head) return { state: "missing" as const, detail: "object_not_found" };
  if (head.sizeBytes !== reference.sizeBytes) return { state: "missing" as const, detail: "object_size_mismatch" };
  if (head.sha256 !== reference.sha256) return { state: "missing" as const, detail: "object_sha256_mismatch" };
  return { state: "committed" as const, detail: undefined };
}

/**
 * Reconcile the PostgreSQL Artifact ledger with S3/MinIO.  Dry-run is the
 * default for the operator CLI.  The Worker opts in to `apply` after the
 * grace periods to automatically mark missing metadata and remove safe
 * orphans.  A missing object is a fail-closed fact, never a recreated pass.
 */
export async function reconcileConfiguredArtifactStore(input: {
  apply?: boolean;
  database?: Pool;
  bucket?: string;
  prefix?: string;
  store?: ArtifactObjectStoreAdapter;
  now?: Date;
  orphanGraceMs?: number;
  partialGraceMs?: number;
} = {}): Promise<ArtifactReconciliationResult> {
  const bucket = input.bucket ?? configuredBucket();
  const database = input.database ?? getDatabasePool();
  if (!bucket || !database) {
    return { enabled: false, applied: Boolean(input.apply), scannedObjects: 0, updatedArtifacts: 0, deletedObjects: 0, missingReferences: [], committedReferences: [], orphanObjectKeys: [], stalePartialObjectKeys: [] };
  }
  const prefix = normalizedPrefix(input.prefix);
  const store = input.store ?? s3Adapter();
  await ensureArtifactReconciliationSchema(database);
  const rows = await database.query<{ id: string; run_id: string; payload: unknown }>("SELECT id,run_id,payload FROM artifacts_v1");
  const references = rows.rows.flatMap((row) => artifactReferencesFromRow(row, bucket));
  const objects = await listAllObjects(store, bucket, prefix ? `${prefix}/` : "");
  const plan = buildArtifactObjectReconciliationPlan({
    references,
    objects,
    prefix,
    now: input.now,
    orphanGraceMs: input.orphanGraceMs,
    partialGraceMs: input.partialGraceMs
  });
  const presentKeys = new Set(plan.committedReferences.map((reference) => reference.key));
  const observations = await Promise.all(references.map(async (reference) => ({
    reference,
    check: presentKeys.has(reference.key) ? checkedState(reference, await store.headObject({ bucket, key: reference.key })) : { state: "missing" as const, detail: "object_not_found" }
  })));
  const missingReferences = observations.filter((item) => item.check.state === "missing").map((item) => item.reference);
  const committedReferences = observations.filter((item) => item.check.state === "committed").map((item) => item.reference);
  let updatedArtifacts = 0;
  let deletedObjects = 0;
  if (input.apply) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      for (const observation of observations) {
        const { reference, check } = observation;
        if (reference.currentState === check.state) continue;
        await client.query(
          `UPDATE artifacts_v1
             SET payload=jsonb_set(payload, '{objectStoreState}', to_jsonb($2::text), true)
           WHERE id=$1 AND run_id=$3`,
          [reference.artifactId, check.state, reference.runId]
        );
        await client.query(
          `INSERT INTO artifact_reconciliation_v1 (artifact_id,run_id,object_uri,state,detail,reconciled_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (artifact_id) DO UPDATE SET state=EXCLUDED.state,detail=EXCLUDED.detail,object_uri=EXCLUDED.object_uri,reconciled_at=EXCLUDED.reconciled_at`,
          [reference.artifactId, reference.runId, reference.uri, check.state, check.detail ?? null]
        );
        updatedArtifacts += 1;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    for (const key of [...plan.orphanObjectKeys, ...plan.stalePartialObjectKeys]) {
      await store.deleteObject({ bucket, key });
      deletedObjects += 1;
    }
  }
  return { enabled: true, applied: Boolean(input.apply), scannedObjects: objects.length, updatedArtifacts, deletedObjects, missingReferences, committedReferences, orphanObjectKeys: plan.orphanObjectKeys, stalePartialObjectKeys: plan.stalePartialObjectKeys };
}
