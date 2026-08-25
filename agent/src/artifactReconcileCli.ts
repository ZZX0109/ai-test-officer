import { reconcileConfiguredArtifactStore } from "./artifactObjectReconciliation.js";

const apply = process.argv.includes("--apply");
const result = await reconcileConfiguredArtifactStore({ apply });
if (!result.enabled) {
  console.error("artifact_reconciliation_blocked:ARTIFACT_S3_BUCKET and DATABASE_URL are required");
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    scannedObjects: result.scannedObjects,
    missingArtifacts: result.missingReferences.map((item) => item.artifactId),
    orphanObjectKeys: result.orphanObjectKeys,
    stalePartialObjectKeys: result.stalePartialObjectKeys,
    updatedArtifacts: result.updatedArtifacts,
    deletedObjects: result.deletedObjects
  }, null, 2));
}
