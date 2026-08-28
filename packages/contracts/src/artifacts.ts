import { z } from "zod";

export const artifactOriginSchema = z.enum([
  "runtime-captured",
  "fixture",
  "simulated",
  "user-uploaded",
  "agent-generated",
  "legacy-unverified"
]);
export type ArtifactOrigin = z.infer<typeof artifactOriginSchema>;

export const artifactKindV2Schema = z.enum([
  "screenshot",
  "dom",
  "network",
  "console",
  "trace",
  "video",
  "download",
  "operation-log",
  "report",
  "attachment",
  "source-patch",
  "changed-files-archive",
  "repair-validation-log"
]);

export const artifactIntegrityV2Schema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  capturedAt: z.string().datetime(),
  collector: z.object({ name: z.string().min(1), version: z.string().min(1) })
});

export const evidenceLocatorSchema = z.object({
  pageUrl: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  selector: z.string().optional(),
  testId: z.string().optional(),
  role: z.string().optional(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative()
  }).optional(),
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  afterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestId: z.string().optional(),
  method: z.string().optional(),
  statusCode: z.number().int().optional(),
  operationId: z.string().optional(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  sourceLocation: z.string().optional(),
  executable: z.string().optional(),
  argsSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  commandConfigSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  exitCode: z.number().int().optional(),
  dataSnapshotId: z.string().optional(),
  assertionSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  timeRange: z.object({ from: z.string().datetime(), to: z.string().datetime() }).optional()
}).default({});
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;

export const artifactV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1),
  attempt: z.number().int().positive(),
  kind: artifactKindV2Schema,
  origin: artifactOriginSchema,
  storageUri: z.string().min(1),
  replicaUris: z.array(z.string().min(1)).default([]),
  // A configured object store is authoritative for production Artifact v2
  // replicas.  The field stays optional for pre-object-store and local-only
  // bundles, while a reconciler can explicitly mark a once-committed replica
  // as missing so it is never used to support a pass again.
  objectStoreState: z.enum(["committed", "missing", "uncommitted"]).optional(),
  sequence: z.number().int().nonnegative(),
  monotonicOffsetMs: z.number().nonnegative(),
  integrity: artifactIntegrityV2Schema,
  locator: evidenceLocatorSchema.optional(),
  fixtureManifestSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).superRefine((artifact, context) => {
  if (artifact.origin === "fixture" && !artifact.fixtureManifestSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixtureManifestSha256"], message: "Fixture artifacts require a manifest digest." });
  }
});
export type ArtifactV2 = z.infer<typeof artifactV2Schema>;

export const evidenceV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  runId: z.string().min(1),
  scenarioId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  attemptId: z.string().min(1),
  attempt: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  artifactIds: z.array(z.string().min(1)),
  summary: z.string().min(1),
  locator: evidenceLocatorSchema.optional(),
  canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});
export type EvidenceV2 = z.infer<typeof evidenceV2Schema>;
