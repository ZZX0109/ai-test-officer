import { createHash } from "node:crypto";
import type {
  ProjectManifest,
  TestDataContractV1,
  TestDataPhaseReceiptV1,
  TestDataStageV1
} from "@ai-test-officer/contracts";
import { testDataContractV1Schema, testDataPhaseReceiptV1Schema } from "@ai-test-officer/contracts";

const LIFECYCLE: TestDataStageV1["stage"][] = [
  "prepare",
  "namespace",
  "migrate",
  "seed",
  "snapshot",
  "execute",
  "cleanup",
  "rollback",
  "verify-clean"
];

export interface TestDataStageContext {
  contract: TestDataContractV1;
  runId: string;
  childRunId: string;
  namespace: string;
  randomSeed: number;
  testTime: string;
  credentialRefs: string[];
  signal?: AbortSignal;
}

export interface TestDataStageResult {
  status?: "passed" | "failed" | "blocked" | "skipped";
  evidenceRefs?: string[];
  artifactIds?: string[];
  error?: string;
}

export interface TestDataLifecycleAdapter {
  runStage(stage: TestDataStageV1, context: TestDataStageContext): Promise<TestDataStageResult>;
}

export interface TestDataLifecycleResult {
  status: "passed" | "failed" | "blocked";
  namespace: string;
  receipts: TestDataPhaseReceiptV1[];
  orphaned: boolean;
  reason?: string;
}

function namespaceFor(contract: TestDataContractV1, runId: string, childRunId: string) {
  const digest = createHash("sha256")
    .update(`${contract.projectId}:${contract.id}:${runId}:${childRunId}:${contract.randomSeed}`)
    .digest("hex")
    .slice(0, 20);
  return `${contract.namespace.prefix}_${digest}`;
}

function stageConfig(contract: TestDataContractV1, stage: TestDataStageV1["stage"]): TestDataStageV1 {
  return contract.stages.find((item) => item.stage === stage) ?? { stage, required: stage !== "rollback" };
}

async function runStage(
  stage: TestDataStageV1,
  context: TestDataStageContext,
  adapter: TestDataLifecycleAdapter,
  options: { ignoreAbort?: boolean } = {}
): Promise<TestDataPhaseReceiptV1> {
  const startedAt = new Date().toISOString();
  let result: TestDataStageResult;
  try {
    if (context.signal?.aborted && !options.ignoreAbort) throw new Error("test_data_aborted");
    result = await adapter.runStage(stage, context);
  } catch (error: unknown) {
    result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const status = result.status ?? "passed";
  return testDataPhaseReceiptV1Schema.parse({
    schemaVersion: "1.0",
    id: `tdr_${context.childRunId}_${stage.stage}_${Date.now()}`,
    contractId: context.contract.id,
    projectId: context.contract.projectId,
    runId: context.runId,
    childRunId: context.childRunId,
    stage: stage.stage,
    status,
    namespace: context.namespace,
    credentialRefs: context.credentialRefs,
    evidenceRefs: result.evidenceRefs ?? [],
    artifactIds: result.artifactIds ?? [],
    error: result.error,
    startedAt,
    finishedAt: new Date().toISOString()
  });
}

/**
 * Executes the data lifecycle with cleanup in a finally block. A cleanup or
 * verify-clean failure is never downgraded to a product failure because it
 * can leave data behind and therefore blocks trustworthy evidence.
 */
export async function executeTestDataLifecycle(input: {
  contract: TestDataContractV1;
  runId: string;
  childRunId: string;
  adapter: TestDataLifecycleAdapter;
  signal?: AbortSignal;
}): Promise<TestDataLifecycleResult> {
  const contract = testDataContractV1Schema.parse(input.contract);
  const namespace = namespaceFor(contract, input.runId, input.childRunId);
  const context: TestDataStageContext = {
    contract,
    runId: input.runId,
    childRunId: input.childRunId,
    namespace,
    randomSeed: contract.randomSeed,
    testTime: contract.testTime,
    credentialRefs: [...contract.credentialRefs],
    signal: input.signal
  };
  const receipts: TestDataPhaseReceiptV1[] = [];
  let failedStage: string | undefined;
  let orphaned = false;

  try {
    for (const stageName of LIFECYCLE.slice(0, 6)) {
      const stage = stageConfig(contract, stageName);
      const receipt = await runStage(stage, context, input.adapter);
      receipts.push(receipt);
      if (receipt.status === "failed" || receipt.status === "blocked" || (receipt.status === "skipped" && stage.required)) {
        failedStage = stageName;
        break;
      }
    }
  } finally {
    for (const stageName of ["cleanup", "rollback", "verify-clean"] as const) {
      // Cleanup is a compensating action and must still be attempted after an
      // AbortSignal, otherwise cancellation itself could strand the namespace.
      const receipt = await runStage(stageConfig(contract, stageName), context, input.adapter, { ignoreAbort: true });
      receipts.push(receipt);
      if (receipt.status === "failed" || receipt.status === "blocked" || (receipt.status === "skipped" && stageConfig(contract, stageName).required)) orphaned = true;
    }
  }

  const lifecycleFailure = receipts.find((receipt) => receipt.status === "failed" || receipt.status === "blocked");
  return {
    status: orphaned ? "blocked" : lifecycleFailure ? (failedStage ? "failed" : "blocked") : "passed",
    namespace,
    receipts,
    orphaned,
    reason: orphaned
      ? "test_data_cleanup_or_verify_failed"
      : lifecycleFailure && failedStage
        ? `test_data_stage_failed:${failedStage}`
        : undefined
  };
}

/** Re-run cleanup for sessions recovered after a process crash. */
export async function recoverOrphanedTestData(input: {
  contract: TestDataContractV1;
  runId: string;
  childRunId: string;
  adapter: TestDataLifecycleAdapter;
}): Promise<TestDataLifecycleResult> {
  const contract = testDataContractV1Schema.parse(input.contract);
  const context: TestDataStageContext = {
    contract,
    runId: input.runId,
    childRunId: input.childRunId,
    namespace: namespaceFor(contract, input.runId, input.childRunId),
    randomSeed: contract.randomSeed,
    testTime: contract.testTime,
    credentialRefs: [...contract.credentialRefs]
  };
  const receipts: TestDataPhaseReceiptV1[] = [];
  const cleanup = await runStage(stageConfig(contract, "cleanup"), context, input.adapter);
  receipts.push(cleanup);
  const verify = await runStage(stageConfig(contract, "verify-clean"), context, input.adapter);
  receipts.push(verify);
  const blocked = [cleanup, verify].some((receipt) => receipt.status !== "passed");
  return {
    status: blocked ? "blocked" : "passed",
    namespace: context.namespace,
    receipts,
    orphaned: blocked,
    reason: blocked ? "orphaned_data_requires_human_follow_up" : undefined
  };
}

export function buildTestDataContractFromManifest(input: {
  manifest: ProjectManifest;
  coverageItemIds: string[];
  randomSeed: number;
  testTime?: string;
  credentialRefByEnv?: Record<string, string>;
}): TestDataContractV1 {
  const now = new Date().toISOString();
  const manifest = input.manifest;
  const credentialRef = (connectionEnv: string | undefined) => connectionEnv
    ? input.credentialRefByEnv?.[connectionEnv] ?? `credential:${connectionEnv}`
    : undefined;
  return testDataContractV1Schema.parse({
    schemaVersion: "1.0",
    id: `tdc_${manifest.projectId}_${input.randomSeed}`,
    projectId: manifest.projectId,
    coverageItemIds: input.coverageItemIds,
    dataSources: manifest.dataSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      credentialRef: credentialRef(source.connectionEnv),
      readOnly: source.readOnly
    })),
    credentialRefs: manifest.dataSources
      .map((source) => source.connectionEnv)
      .filter((value): value is string => Boolean(value))
      .map((value) => credentialRef(value)!),
    namespace: { strategy: "run-child-seed", prefix: "ato" },
    randomSeed: input.randomSeed,
    testTime: input.testTime ?? now,
    roles: [],
    stages: LIFECYCLE.map((stage) => ({
      stage,
      commandRef: stage === "migrate" && manifest.commands.migrate
        ? "migrate"
        : stage === "seed" && manifest.commands.seed
          ? "seed"
          : stage === "cleanup" && manifest.commands.cleanup
            ? "cleanup"
            : undefined,
      required: stage !== "rollback"
    })),
    createdAt: now,
    updatedAt: now
  });
}
