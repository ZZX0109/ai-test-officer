import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoDateSchema = z.string().datetime();

export const oracleTypeV2Schema = z.enum([
  "dom",
  "url",
  "network",
  "api-schema",
  "database",
  "background-task",
  "visual",
  "custom"
]);
export type OracleTypeV2 = z.infer<typeof oracleTypeV2Schema>;

export const oracleSourceV2Schema = z.object({
  kind: z.enum([
    "user-confirmed-acceptance",
    "formal-contract",
    "base-behavior",
    "runtime-observation",
    "historical-behavior",
    "llm-inference",
    "legacy"
  ]),
  id: z.string().min(1),
  version: z.string().min(1),
  sha256: sha256Schema
});
export type OracleSourceV2 = z.infer<typeof oracleSourceV2Schema>;

export const oracleSpecV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  coverageItemId: z.string().min(1),
  type: oracleTypeV2Schema,
  description: z.string().min(1).max(2_000),
  preconditions: z.array(z.string().min(1)).max(50).default([]),
  observationWindow: z.object({
    start: z.enum(["before-action", "after-action", "polling"]),
    timeoutMs: z.number().int().min(0).max(300_000).default(20_000),
    pollIntervalMs: z.number().int().min(0).max(30_000).default(500)
  }),
  comparison: z.object({
    operator: z.enum(["equals", "not-equals", "contains", "all-contains", "status-in", "json-schema", "snapshot-equals", "changed"]),
    expected: z.unknown(),
    actualPath: z.string().min(1).optional()
  }),
  source: oracleSourceV2Schema,
  decisionUse: z.enum(["release", "advisory", "review-only"]),
  conflictRefs: z.array(z.string().min(1)).max(50).default([]),
  humanConfirmation: z.object({
    status: z.enum(["not-required", "pending", "confirmed", "rejected"]),
    actor: z.string().min(1).optional(),
    confirmedAt: isoDateSchema.optional(),
    note: z.string().max(2_000).optional()
  }),
  lifecycle: z.object({
    status: z.enum(["active", "expired", "reconfirmation-required", "superseded"]),
    expiresAt: isoDateSchema.optional(),
    supersededBy: z.string().min(1).optional()
  }),
  runEvidence: z.object({
    runId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    artifactIds: z.array(z.string().min(1)).default([])
  }),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});
export type OracleSpecV2 = z.infer<typeof oracleSpecV2Schema>;

export const oracleDecisionV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  oracleId: z.string().min(1),
  status: z.enum(["pass", "fail", "blocked", "needs-human-review"]),
  releaseEligible: z.boolean(),
  differentialEligible: z.boolean(),
  reasons: z.array(z.string().min(1)).default([]),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  evaluatedAt: isoDateSchema
});
export type OracleDecisionV2 = z.infer<typeof oracleDecisionV2Schema>;

export const testDataSourceV1Schema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/),
  kind: z.enum(["postgres", "sqlite", "http-snapshot"]),
  credentialRef: z.string().min(1).optional(),
  readOnly: z.boolean().default(false)
});
export type TestDataSourceV1 = z.infer<typeof testDataSourceV1Schema>;

export const testDataStageV1Schema = z.object({
  stage: z.enum(["prepare", "namespace", "migrate", "seed", "snapshot", "execute", "cleanup", "rollback", "verify-clean"]),
  commandRef: z.string().min(1).optional(),
  required: z.boolean().default(true)
});
export type TestDataStageV1 = z.infer<typeof testDataStageV1Schema>;

export const testDataContractV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  coverageItemIds: z.array(z.string().min(1)).min(1),
  dataSources: z.array(testDataSourceV1Schema).min(1),
  credentialRefs: z.array(z.string().min(1)).default([]),
  namespace: z.object({
    strategy: z.literal("run-child-seed"),
    prefix: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/).default("ato")
  }),
  randomSeed: z.number().int().nonnegative(),
  testTime: isoDateSchema,
  roles: z.array(z.object({
    id: z.string().min(1),
    credentialRef: z.string().min(1).optional(),
    permissions: z.array(z.string().min(1)).default([])
  })).default([]),
  stages: z.array(testDataStageV1Schema).min(1),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});
export type TestDataContractV1 = z.infer<typeof testDataContractV1Schema>;

export const testDataPhaseReceiptV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  contractId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  childRunId: z.string().min(1),
  stage: testDataStageV1Schema.shape.stage,
  status: z.enum(["passed", "failed", "blocked", "skipped"]),
  namespace: z.string().min(1),
  credentialRefs: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  artifactIds: z.array(z.string().min(1)).default([]),
  error: z.string().max(2_000).optional(),
  startedAt: isoDateSchema,
  finishedAt: isoDateSchema
});
export type TestDataPhaseReceiptV1 = z.infer<typeof testDataPhaseReceiptV1Schema>;

export const differentialClassificationSchema = z.enum([
  "introduced-regression",
  "pre-existing-defect",
  "fixed-by-change",
  "expected-change",
  "flaky",
  "environment-difference",
  "inconclusive"
]);
export type DifferentialClassification = z.infer<typeof differentialClassificationSchema>;

export const differentialSideV1Schema = z.object({
  revision: z.string().min(1),
  runId: z.string().min(1),
  state: z.string().min(1),
  gateStatus: z.string().min(1).optional(),
  environmentHash: sha256Schema.optional(),
  failureSignature: z.string().min(1).optional(),
  repetitionsStable: z.boolean().optional(),
  visualDifferenceOnly: z.boolean().optional(),
  oracleDecisions: z.array(oracleDecisionV2Schema).default([]),
  artifactIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([])
});
export type DifferentialSideV1 = z.infer<typeof differentialSideV1Schema>;

export const pairManifestV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  baseRevision: z.string().min(1),
  headRevision: z.string().min(1),
  baseRunId: z.string().min(1),
  headRunId: z.string().min(1),
  dataContractId: z.string().min(1),
  environmentHash: sha256Schema,
  planHash: sha256Schema,
  dataHash: sha256Schema,
  ociImage: z.string().min(1).optional(),
  browserVersion: z.string().min(1).optional(),
  randomSeed: z.number().int().nonnegative(),
  testTime: isoDateSchema,
  oracleSpecIds: z.array(z.string().min(1)).min(1),
  classification: differentialClassificationSchema.optional(),
  classificationReasons: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  createdAt: isoDateSchema
});
export type PairManifestV1 = z.infer<typeof pairManifestV1Schema>;

export const differentialRunV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  organizationId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(["queued", "running", "completed", "blocked", "failed"]),
  idempotencyKey: z.string().min(1),
  base: differentialSideV1Schema,
  head: differentialSideV1Schema,
  pairManifest: pairManifestV1Schema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});
export type DifferentialRunV1 = z.infer<typeof differentialRunV1Schema>;

export const differentialRunRequestV1Schema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  id: z.string().min(1).optional(),
  organizationId: z.string().min(1).default("local"),
  projectId: z.string().min(1),
  baseRevision: z.string().min(1),
  headRevision: z.string().min(1),
  planHash: sha256Schema.optional(),
  plan: z.unknown().optional(),
  dataContractId: z.string().min(1),
  dataContract: testDataContractV1Schema.optional(),
  oracleSpecIds: z.array(z.string().min(1)).min(1),
  oracleSpecs: z.array(oracleSpecV2Schema).default([]),
  environmentHash: sha256Schema,
  ociImage: z.string().min(1).optional(),
  browserVersion: z.string().min(1).optional(),
  randomSeed: z.number().int().nonnegative(),
  testTime: isoDateSchema,
  idempotencyKey: z.string().min(1)
}).refine((value) => value.planHash !== undefined || value.plan !== undefined, {
  path: ["planHash"],
  message: "planHash_or_plan_required"
});
export type DifferentialRunRequestV1 = z.infer<typeof differentialRunRequestV1Schema>;

export const testAssetFileV1Schema = z.object({
  path: z.string().min(1),
  content: z.string(),
  sha256: sha256Schema,
  language: z.enum(["playwright-ts", "api-ts"])
});
export type TestAssetFileV1 = z.infer<typeof testAssetFileV1Schema>;

export const testAssetValidationV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  assetId: z.string().min(1),
  status: z.enum(["queued", "running", "passed", "failed", "blocked"]),
  repetitions: z.number().int().nonnegative(),
  passedRepetitions: z.number().int().nonnegative(),
  mutationTotal: z.number().int().nonnegative(),
  mutationKilled: z.number().int().nonnegative(),
  securityPassed: z.boolean(),
  failureClass: z.enum(["product-bug", "generated-test", "environment", "infrastructure", "unknown"]).optional(),
  runIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  createdAt: isoDateSchema,
  finishedAt: isoDateSchema.optional()
});
export type TestAssetValidationV1 = z.infer<typeof testAssetValidationV1Schema>;

export const testAssetV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceRunId: z.string().min(1),
  coverageItemIds: z.array(z.string().min(1)).min(1),
  oracleSpecIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  files: z.array(testAssetFileV1Schema).min(1),
  status: z.enum(["candidate", "validating", "ready-for-review", "applying", "applied", "rejected", "blocked", "failed"]),
  validation: testAssetValidationV1Schema.optional(),
  sourceRepositoryRoot: z.string().min(1),
  sourceRepositorySha256: sha256Schema,
  targetBranch: z.string().min(1).optional(),
  patchSha256: sha256Schema.optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});
export type TestAssetV1 = z.infer<typeof testAssetV1Schema>;

export const createTestAssetRequestV1Schema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  projectId: z.string().min(1),
  sourceRunId: z.string().min(1),
  coverageItemIds: z.array(z.string().min(1)).min(1),
  oracleSpecIds: z.array(z.string().min(1)).min(1),
  oracleSpecs: z.array(oracleSpecV2Schema).default([]),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  files: z.array(testAssetFileV1Schema).default([]),
  format: z.enum(["playwright-ts", "api-ts"]).default("playwright-ts"),
  repositoryRoot: z.string().min(1),
  repositorySha256: sha256Schema
});
export type CreateTestAssetRequestV1 = z.infer<typeof createTestAssetRequestV1Schema>;

export const validateTestAssetRequestV1Schema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  repetitions: z.literal(3).default(3),
  mutationTotal: z.number().int().nonnegative().default(0),
  mutationKilled: z.number().int().nonnegative().default(0),
  securityPassed: z.boolean().default(false),
  /** Mutation identities are selected by the validator.  The counts above
   * remain readable for backwards-compatible clients, but an executing
   * server must derive them from these identities rather than trust a caller
   * supplied score. */
  mutationIds: z.array(z.number().int().nonnegative()).max(100).default([0]),
  runIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).default([])
});
export type ValidateTestAssetRequestV1 = z.infer<typeof validateTestAssetRequestV1Schema>;

export const applyTestAssetRequestV1Schema = z.object({
  schemaVersion: z.literal("1.0").default("1.0"),
  capabilityGrantId: z.string().min(1),
  confirmedBy: z.string().min(1),
  expectedRepositorySha256: sha256Schema
});
export type ApplyTestAssetRequestV1 = z.infer<typeof applyTestAssetRequestV1Schema>;

export const reliabilityAssetContextV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  repositoryRoot: z.string().min(1),
  repositorySha256: sha256Schema,
  sourceRun: z.object({
    id: z.string().min(1),
    state: z.string().min(1),
    gateStatus: z.string().min(1).optional()
  }).optional(),
  dataContracts: z.array(z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    coverageItemIds: z.array(z.string().min(1)),
    dataSourceKinds: z.array(testDataSourceV1Schema.shape.kind),
    randomSeed: z.number().int().nonnegative(),
    testTime: isoDateSchema
  })),
  oracleSpecs: z.array(z.object({
    id: z.string().min(1),
    coverageItemId: z.string().min(1),
    type: oracleTypeV2Schema,
    description: z.string().min(1),
    source: oracleSourceV2Schema,
    decisionUse: z.enum(["release", "advisory", "review-only"]),
    lifecycleStatus: z.enum(["active", "expired", "reconfirmation-required", "superseded"])
  })),
  coverageItems: z.array(z.object({
    id: z.string().min(1),
    runId: z.string().min(1),
    flowId: z.string().min(1),
    module: z.string().min(1),
    surface: z.enum(["page", "api", "data", "background-task"]),
    risk: z.enum(["low", "medium", "high", "critical"]),
    disposition: z.string().min(1)
  })),
  evidenceRefs: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string().min(1),
    timestamp: isoDateSchema,
    artifactIds: z.array(z.string().min(1)).default([])
  })),
  environmentDefaults: z.object({
    environmentHash: sha256Schema,
    randomSeed: z.number().int().nonnegative(),
    testTime: isoDateSchema,
    ociImage: z.string().min(1).optional(),
    browserVersion: z.string().min(1).optional()
  })
});
export type ReliabilityAssetContextV1 = z.infer<typeof reliabilityAssetContextV1Schema>;

export const reliabilityAssetOutboxPayloadV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  eventId: z.string().min(1),
  entityKind: z.enum(["oracle", "data-contract", "data-receipt", "differential-run", "test-asset"]),
  entityId: z.string().min(1),
  operation: z.enum(["created", "updated", "validated", "applied", "blocked", "failed"]),
  projectId: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  assetVersion: z.number().int().positive(),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  occurredAt: isoDateSchema
});
export type ReliabilityAssetOutboxPayloadV1 = z.infer<typeof reliabilityAssetOutboxPayloadV1Schema>;

export const adaptivePathDecisionV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  coverageItemId: z.string().min(1),
  risk: z.number().nonnegative(),
  uncertainty: z.number().nonnegative(),
  expectedInformationGain: z.number().nonnegative(),
  cost: z.number().positive(),
  score: z.number().nonnegative(),
  rank: z.number().int().positive(),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  createdAt: isoDateSchema
});
export type AdaptivePathDecisionV1 = z.infer<typeof adaptivePathDecisionV1Schema>;
