import { createReadStream } from "node:fs";
import path from "node:path";
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ArtifactV2 } from "@ai-test-officer/contracts";
import { resolveArtifactPath } from "./artifactIntegrity.js";
import { pauseAfterCommittedRunEvent } from "./faultInjection.js";
import { runEventStore } from "./runEventStore.js";

async function pauseAfterArtifactStoreCheckpoint(artifact: ArtifactV2, eventType: string) {
  // This is a disposable-acceptance-only breakpoint. Avoid even reading the
  // Run projection unless the explicit process-side guard is present; normal
  // object mirroring remains independent from the Event Store read path.
  if (process.env.FAULT_INJECTION_ENABLED !== "1") return;
  const run = await runEventStore.get(artifact.runId);
  if (run) await pauseAfterCommittedRunEvent({ run, eventType });
}

export async function mirrorArtifactsToConfiguredStore(artifacts: ArtifactV2[], reportsDir: string): Promise<ArtifactV2[]> {
  const bucket = process.env.ARTIFACT_S3_BUCKET;
  if (!bucket) return artifacts;
  const client = new S3Client({
    region: process.env.ARTIFACT_S3_REGION ?? "us-east-1",
    endpoint: process.env.ARTIFACT_S3_ENDPOINT,
    forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === "1"
  });
  const prefix = (process.env.ARTIFACT_S3_PREFIX ?? "ai-test-officer").replace(/^\/+|\/+$/g, "");
  const mirrored: ArtifactV2[] = [];
  for (const artifact of artifacts) {
    const resolved = resolveArtifactPath(artifact.storageUri, reportsDir);
    if (!resolved.ok) throw new Error(`artifact_object_store_source_invalid:${artifact.id}:${resolved.reason}`);
    const key = [prefix, artifact.runId, artifact.scenarioId, artifact.attemptId, path.basename(resolved.filePath)].filter(Boolean).join("/");
    const temporaryKey = `${prefix}/.partial/${artifact.id}-${Date.now()}`;
    let temporaryUploaded = false;
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: temporaryKey,
        Body: createReadStream(resolved.filePath),
        ContentType: artifact.integrity.mediaType,
        Metadata: { sha256: artifact.integrity.sha256, artifactid: artifact.id, origin: artifact.origin }
      }));
      temporaryUploaded = true;
      // The temporary upload exists but has not been integrity-checked. A
      // hard-kill here must leave no ledger entry and reconciliation may only
      // remove the stale partial object after its grace window.
      await pauseAfterArtifactStoreCheckpoint(artifact, "artifact_temporary_object_uploaded");
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: temporaryKey }));
      if (head.ContentLength !== artifact.integrity.sizeBytes || head.Metadata?.sha256 !== artifact.integrity.sha256) {
        throw new Error(`artifact_object_store_integrity_mismatch:${artifact.id}`);
      }
      // The temporary object is verified but has not been promoted to the
      // immutable replica namespace yet.
      await pauseAfterArtifactStoreCheckpoint(artifact, "artifact_temporary_object_verified");
      await client.send(new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: `${bucket}/${temporaryKey}`, MetadataDirective: "COPY" }));
      const committed = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (committed.ContentLength !== artifact.integrity.sizeBytes || committed.Metadata?.sha256 !== artifact.integrity.sha256) {
        throw new Error(`artifact_object_store_commit_mismatch:${artifact.id}`);
      }
      // The final object is now immutable and verified, but its replica URI
      // has not reached the PostgreSQL Artifact ledger. Keep this exact crash
      // boundary injectable so reconciliation proves that an unreferenced
      // object cannot become trusted evidence after a Worker hard kill.
      await pauseAfterArtifactStoreCheckpoint(artifact, "artifact_object_committed");
      mirrored.push({
        ...artifact,
        objectStoreState: "committed",
        replicaUris: Array.from(new Set([...(artifact.replicaUris ?? []), `s3://${bucket}/${key}`]))
      });
    } finally {
      if (temporaryUploaded) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey })).catch(() => undefined);
    }
  }
  return mirrored;
}
