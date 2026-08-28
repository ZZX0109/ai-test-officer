import { randomUUID } from "node:crypto";
import type {
  DifferentialClassification,
  DifferentialRunRequestV1,
  DifferentialRunV1,
  DifferentialSideV1,
  OracleDecisionV2
} from "@ai-test-officer/contracts";
import {
  differentialRunRequestV1Schema,
  differentialRunV1Schema,
  pairManifestV1Schema
} from "@ai-test-officer/contracts";
import { canonicalSha256 } from "./canonicalHash.js";
import { runEventStore, type RunEventStore } from "./runEventStore.js";
import { getReliabilityAssetStore, recordReliabilityMutation, type ReliabilityAssetStore } from "./reliabilityAssetStore.js";

export interface DifferentialClassificationInput {
  baseGateStatus?: string;
  headGateStatus?: string;
  baseFailureSignature?: string;
  headFailureSignature?: string;
  baseOracleDecisions?: OracleDecisionV2[];
  headOracleDecisions?: OracleDecisionV2[];
  baseEnvironmentHash?: string;
  headEnvironmentHash?: string;
  repetitionsStable?: boolean;
  visualDifferenceOnly?: boolean;
}

export interface DifferentialClassificationResult {
  classification: DifferentialClassification;
  reasons: string[];
}

export interface DifferentialSideExecutionResult {
  state: string;
  gateStatus?: string;
  oracleDecisions?: OracleDecisionV2[];
  artifactIds?: string[];
  evidenceRefs?: string[];
  failureSignature?: string;
  environmentHash?: string;
  repetitionsStable?: boolean;
  visualDifferenceOnly?: boolean;
}

function passed(status?: string) { return status === "pass" || status === "passed"; }
function failed(status?: string) { return status === "fail" || status === "failed"; }
function terminal(status?: string) {
  return passed(status) || failed(status) || status === "blocked" || status === "needs-human-review";
}

function terminalRunState(state?: string) {
  return state === "completed" || state === "failed" || state === "blocked" || state === "cancelled";
}

function parentGateStatus(classification: DifferentialClassification) {
  if (classification === "expected-change" || classification === "fixed-by-change") return "pass" as const;
  if (classification === "introduced-regression") return "fail" as const;
  return "needs-human-review" as const;
}

async function finalizeParentRun(input: {
  runStore: RunEventStore;
  parentRunId: string;
  blocked: boolean;
  payload: Record<string, unknown>;
}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parent = await input.runStore.get(input.parentRunId);
    if (!parent || terminalRunState(parent.state)) return parent;
    try {
      return await input.runStore.append({
        runId: input.parentRunId,
        type: input.blocked ? "parent_aggregate_blocked" : "parent_aggregate_completed",
        expectedVersion: parent.version,
        actor: "differential-executor",
        idempotencyKey: `${input.parentRunId}:parent-aggregate:${parent.version + 1}`,
        payload: input.payload
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("parent_aggregate_finalize_failed");
}

async function ensureParentAggregate(input: {
  differential: DifferentialRunV1;
  runStore: RunEventStore;
}) {
  if (!["completed", "blocked", "failed"].includes(input.differential.status)) return;
  const blocked = input.differential.status === "blocked" || input.differential.status === "failed";
  return finalizeParentRun({
    runStore: input.runStore,
    parentRunId: input.differential.id,
    blocked,
    payload: {
      baseRunId: input.differential.base.runId,
      headRunId: input.differential.head.runId,
      pairManifestId: input.differential.pairManifest.id,
      artifactIds: [...new Set([...input.differential.base.artifactIds, ...input.differential.head.artifactIds])],
      evidenceRefs: input.differential.pairManifest.evidenceRefs,
      classification: input.differential.pairManifest.classification ?? "inconclusive",
      finalStatus: blocked ? "blocked" : parentGateStatus(input.differential.pairManifest.classification ?? "inconclusive"),
      reasons: input.differential.pairManifest.classificationReasons
    }
  });
}

function failedOracleIds(decisions: OracleDecisionV2[] = []) {
  return decisions.filter((item) => item.status === "fail").map((item) => item.oracleId).sort().join(",");
}

function oracleGuardedGateStatus(status: string | undefined, decisions: OracleDecisionV2[] = []) {
  if (decisions.some((decision) => decision.status === "blocked")) return "blocked";
  if (decisions.some((decision) => decision.status === "needs-human-review" || !decision.differentialEligible)) {
    return "needs-human-review";
  }
  return status;
}

/**
 * Classifies only evidence-backed outcomes. In particular, a screenshot-only
 * difference and a pair with non-comparable environments never becomes a
 * regression claim.
 */
export function classifyDifferential(input: DifferentialClassificationInput): DifferentialClassificationResult {
  const reasons: string[] = [];
  if (input.baseEnvironmentHash && input.headEnvironmentHash && input.baseEnvironmentHash !== input.headEnvironmentHash) {
    return { classification: "environment-difference", reasons: ["base_head_environment_hash_mismatch"] };
  }
  if (input.repetitionsStable === false) return { classification: "flaky", reasons: ["repeated_outcomes_not_stable"] };
  if (input.visualDifferenceOnly) return { classification: "inconclusive", reasons: ["visual_difference_without_structured_oracle"] };
  if (!terminal(input.baseGateStatus) || !terminal(input.headGateStatus)) {
    return { classification: "inconclusive", reasons: ["base_or_head_run_not_terminal"] };
  }

  if (passed(input.baseGateStatus) && failed(input.headGateStatus)) {
    return { classification: "introduced-regression", reasons: ["base_passed_head_failed", ...reasons] };
  }
  if (failed(input.baseGateStatus) && passed(input.headGateStatus)) {
    return { classification: "fixed-by-change", reasons: ["base_failed_head_passed", ...reasons] };
  }
  if (passed(input.baseGateStatus) && passed(input.headGateStatus)) {
    return { classification: "expected-change", reasons: ["both_sides_passed"] };
  }
  if (failed(input.baseGateStatus) && failed(input.headGateStatus)) {
    const baseFailures = input.baseFailureSignature ?? failedOracleIds(input.baseOracleDecisions);
    const headFailures = input.headFailureSignature ?? failedOracleIds(input.headOracleDecisions);
    if (baseFailures && baseFailures === headFailures) {
      return { classification: "pre-existing-defect", reasons: ["same_failure_on_base_and_head"] };
    }
    return { classification: "inconclusive", reasons: ["different_or_unavailable_failure_signatures"] };
  }
  return { classification: "inconclusive", reasons: ["gate_status_not_comparable"] };
}

function side(input: {
  revision: string;
  runId: string;
}): DifferentialSideV1 {
  return { revision: input.revision, runId: input.runId, state: "draft", oracleDecisions: [], artifactIds: [], evidenceRefs: [] };
}

export async function createDifferentialRun(input: {
  request: DifferentialRunRequestV1;
  runStore?: RunEventStore;
  store?: ReliabilityAssetStore;
  actor?: string;
}): Promise<DifferentialRunV1> {
  const request = differentialRunRequestV1Schema.parse(input.request);
  const store = input.store ?? getReliabilityAssetStore();
  const runs = input.runStore ?? runEventStore;
  const existing = await store.findDifferentialByIdempotencyKey(request.idempotencyKey);
  if (existing) return existing;
  const derivedPlanHash = request.plan === undefined ? undefined : canonicalSha256(request.plan);
  if (request.planHash && derivedPlanHash && request.planHash !== derivedPlanHash) {
    throw new Error("plan_hash_mismatch");
  }
  const planHash = request.planHash ?? derivedPlanHash;
  if (!planHash) throw new Error("plan_hash_missing");
  if (request.dataContract) await store.putDataContract(request.dataContract);
  for (const oracle of request.oracleSpecs) await store.putOracle(oracle);
  const dataContract = await store.getDataContract(request.dataContractId);
  if (!dataContract) throw new Error("test_data_contract_not_found");
  if (dataContract.projectId !== request.projectId) throw new Error("test_data_contract_project_mismatch");
  const oracleSpecs = await Promise.all(request.oracleSpecIds.map((id) => store.getOracle(id)));
  if (oracleSpecs.some((spec) => !spec)) throw new Error("oracle_spec_not_found");
  if (oracleSpecs.some((spec) => spec!.projectId !== request.projectId)) throw new Error("oracle_spec_project_mismatch");

  const id = request.id ?? `diff_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const baseRunId = `${id}_base`;
  const headRunId = `${id}_head`;
  const parent = await runs.create({
    runId: id,
    actor: input.actor ?? "api-user",
    idempotencyKey: `${request.idempotencyKey}:parent`,
    payload: {
      organizationId: request.organizationId,
      projectId: request.projectId,
      differentialRunId: id,
      runKind: "parent",
      baseRevision: request.baseRevision,
      headRevision: request.headRevision,
      dataContractId: request.dataContractId,
      planHash,
      plan: request.plan,
      oracleSpecIds: request.oracleSpecIds,
      environmentHash: request.environmentHash,
      randomSeed: request.randomSeed,
      testTime: request.testTime,
      ociImage: request.ociImage,
      browserVersion: request.browserVersion
    }
  });
  const base = await runs.create({
    runId: baseRunId,
    actor: input.actor ?? "api-user",
    idempotencyKey: `${request.idempotencyKey}:base`,
    payload: {
      organizationId: request.organizationId,
      projectId: request.projectId,
      differentialRunId: id,
      differentialSide: "base",
      runKind: "path",
      parentRunId: id,
      coverageItemId: `${id}:base`,
      revision: request.baseRevision,
      dataContractId: request.dataContractId,
      planHash,
      plan: request.plan,
      oracleSpecIds: request.oracleSpecIds,
      environmentHash: request.environmentHash,
      randomSeed: request.randomSeed,
      testTime: request.testTime,
      ociImage: request.ociImage,
      browserVersion: request.browserVersion
    }
  });
  const head = await runs.create({
    runId: headRunId,
    actor: input.actor ?? "api-user",
    idempotencyKey: `${request.idempotencyKey}:head`,
    payload: {
      organizationId: request.organizationId,
      projectId: request.projectId,
      differentialRunId: id,
      differentialSide: "head",
      runKind: "path",
      parentRunId: id,
      coverageItemId: `${id}:head`,
      revision: request.headRevision,
      dataContractId: request.dataContractId,
      planHash,
      plan: request.plan,
      oracleSpecIds: request.oracleSpecIds,
      environmentHash: request.environmentHash,
      randomSeed: request.randomSeed,
      testTime: request.testTime,
      ociImage: request.ociImage,
      browserVersion: request.browserVersion
    }
  });
  const now = new Date().toISOString();
  const manifest = pairManifestV1Schema.parse({
    schemaVersion: "1.0",
    id: `${id}:manifest`,
    projectId: request.projectId,
    baseRevision: request.baseRevision,
    headRevision: request.headRevision,
    baseRunId,
    headRunId,
    dataContractId: request.dataContractId,
    environmentHash: request.environmentHash,
    planHash,
    dataHash: canonicalSha256(dataContract),
    ociImage: request.ociImage,
    browserVersion: request.browserVersion,
    randomSeed: request.randomSeed,
    testTime: request.testTime,
    oracleSpecIds: request.oracleSpecIds,
    evidenceRefs: [],
    createdAt: now
  });
  const value = differentialRunV1Schema.parse({
    schemaVersion: "1.0",
    id,
    organizationId: request.organizationId,
    projectId: request.projectId,
    status: "queued",
    idempotencyKey: request.idempotencyKey,
    base: { ...side({ revision: request.baseRevision, runId: baseRunId }), state: base.state },
    head: { ...side({ revision: request.headRevision, runId: headRunId }), state: head.state },
    pairManifest: manifest,
    createdAt: now,
    updatedAt: now
  });
  await recordReliabilityMutation({
    store,
    kind: "differential-run",
    entityId: id,
    value,
    operation: "created",
    projectId: request.projectId,
    sourceRunId: id,
    evidenceTitle: "Differential run created",
    evidencePayload: {
      differentialRunId: id,
      baseRevision: request.baseRevision,
      headRevision: request.headRevision,
      baseRunId,
      headRunId,
      planHash,
      dataContractId: request.dataContractId
    }
  });
  return value;
}

export async function refreshDifferentialRun(input: {
  id: string;
  runStore?: RunEventStore;
  store?: ReliabilityAssetStore;
  classification?: DifferentialClassificationInput | DifferentialClassificationResult;
}) {
  const store = input.store ?? getReliabilityAssetStore();
  const runs = input.runStore ?? runEventStore;
  const current = await store.getDifferentialRun(input.id);
  if (!current) throw new Error("differential_run_not_found");
  const base = await runs.get(current.base.runId);
  const head = await runs.get(current.head.runId);
  const baseSide = {
    ...current.base,
    state: base?.state ?? current.base.state,
    gateStatus: oracleGuardedGateStatus(base?.gateStatus ?? current.base.gateStatus, current.base.oracleDecisions)
  };
  const headSide = {
    ...current.head,
    state: head?.state ?? current.head.state,
    gateStatus: oracleGuardedGateStatus(head?.gateStatus ?? current.head.gateStatus, current.head.oracleDecisions)
  };
  const decision = input.classification && "classification" in input.classification
    ? input.classification
    : classifyDifferential(input.classification ?? {
      baseGateStatus: baseSide.gateStatus,
      headGateStatus: headSide.gateStatus,
      baseFailureSignature: baseSide.failureSignature,
      headFailureSignature: headSide.failureSignature,
      baseOracleDecisions: baseSide.oracleDecisions,
      headOracleDecisions: headSide.oracleDecisions,
      baseEnvironmentHash: baseSide.environmentHash,
      headEnvironmentHash: headSide.environmentHash,
      repetitionsStable: [baseSide.repetitionsStable, headSide.repetitionsStable].includes(false) ? false : undefined,
      visualDifferenceOnly: Boolean(baseSide.visualDifferenceOnly || headSide.visualDifferenceOnly)
    });
  const bothSidesTerminal = terminalRunState(baseSide.state) && terminalRunState(headSide.state);
  const next = differentialRunV1Schema.parse({
    ...current,
    status: bothSidesTerminal ? "completed" : current.status === "queued" ? "queued" : "running",
    base: baseSide,
    head: headSide,
    pairManifest: {
      ...current.pairManifest,
      environmentHash: baseSide.environmentHash && baseSide.environmentHash === headSide.environmentHash
        ? baseSide.environmentHash
        : current.pairManifest.environmentHash,
      classification: decision.classification,
      classificationReasons: decision.reasons
    },
    updatedAt: new Date().toISOString()
  });
  if (next.status !== current.status
    || next.pairManifest.classification !== current.pairManifest.classification
    || next.base.state !== current.base.state
    || next.head.state !== current.head.state
    || next.base.gateStatus !== current.base.gateStatus
    || next.head.gateStatus !== current.head.gateStatus) {
    await recordReliabilityMutation({
      store,
      kind: "differential-run",
      entityId: next.id,
      value: next,
      operation: "updated",
      projectId: next.projectId,
      sourceRunId: next.id,
      evidenceTitle: "Differential run state refreshed",
      evidencePayload: { differentialRunId: next.id, status: next.status, classification: next.pairManifest.classification }
    });
  }
  // The DifferentialRun projection and the parent Run use separate durable
  // stores in local mode. A GET can therefore observe the final projection in
  // the short interval before the aggregate event commits. Reconcile here so
  // every terminal response also exposes a terminal parent Run.
  await ensureParentAggregate({ differential: next, runStore: runs });
  return next;
}

/**
 * Converts an executor/process failure into a terminal, non-pass result. The
 * API launches the default executor asynchronously, so this recovery path is
 * needed for failures that happen before the pair coordinator can settle both
 * sides (for example, a worker process disappearing immediately after
 * creation).
 */
export async function blockDifferentialRun(input: {
  id: string;
  reason: string;
  store?: ReliabilityAssetStore;
  runStore?: RunEventStore;
}) {
  const store = input.store ?? getReliabilityAssetStore();
  const runs = input.runStore ?? runEventStore;
  const current = await store.getDifferentialRun(input.id);
  if (!current) throw new Error("differential_run_not_found");
  if (["completed", "blocked", "failed"].includes(current.status)) {
    await ensureParentAggregate({ differential: current, runStore: runs });
    return current;
  }
  const reasons = [...new Set([...current.pairManifest.classificationReasons, input.reason])];
  const next = differentialRunV1Schema.parse({
    ...current,
    status: "blocked",
    pairManifest: {
      ...current.pairManifest,
      classification: "inconclusive",
      classificationReasons: reasons
    },
    updatedAt: new Date().toISOString()
  });
  const evidence = await recordReliabilityMutation({
    store,
    kind: "differential-run",
    entityId: next.id,
    value: next,
    operation: "blocked",
    projectId: next.projectId,
    sourceRunId: next.id,
    evidenceTitle: "Differential run blocked by executor failure",
    evidencePayload: { reason: input.reason }
  });
  await finalizeParentRun({
    runStore: runs,
    parentRunId: current.id,
    blocked: true,
    payload: {
      baseRunId: current.base.runId,
      headRunId: current.head.runId,
      pairManifestId: current.pairManifest.id,
      evidenceRefs: [evidence.id],
      artifactIds: [...new Set([...current.base.artifactIds, ...current.head.artifactIds])],
      classification: "inconclusive",
      finalStatus: "blocked",
      reason: input.reason
    }
  });
  return next;
}

/**
 * Runs both revisions through an injected executor while keeping their
 * durable Run identities separate. The executor is the existing Graph/Worker
 * boundary; this service only coordinates the pair and classifies evidence.
 * That keeps DifferentialRunV1 from becoming a second execution engine.
 */
export async function executeDifferentialRun(input: {
  id: string;
  execute: (side: {
    side: "base" | "head";
    revision: string;
    runId: string;
    projectId: string;
    dataContractId: string;
    planHash: string;
    environmentHash: string;
    randomSeed: number;
    testTime: string;
    oracleSpecIds: string[];
  }) => Promise<DifferentialSideExecutionResult>;
  store?: ReliabilityAssetStore;
  runStore?: RunEventStore;
  /** Local trusted runtimes share ports; the default executor therefore runs
   * those revisions one after another. OCI callers may opt into parallelism. */
  parallel?: boolean;
}): Promise<DifferentialRunV1> {
  const store = input.store ?? getReliabilityAssetStore();
  const runs = input.runStore ?? runEventStore;
  const current = await store.getDifferentialRun(input.id);
  if (!current) throw new Error("differential_run_not_found");
  if (["completed", "blocked", "failed"].includes(current.status)) return current;
  const running = differentialRunV1Schema.parse({
    ...current,
    status: "running",
    updatedAt: new Date().toISOString()
  });
  await recordReliabilityMutation({
    store,
    kind: "differential-run",
    entityId: running.id,
    value: running,
    operation: "updated",
    projectId: running.projectId,
    sourceRunId: running.id,
    evidenceTitle: "Differential run execution started",
    evidencePayload: { baseRunId: current.base.runId, headRunId: current.head.runId, revisions: { base: current.base.revision, head: current.head.revision } }
  });

  const executeSide = (side: "base" | "head") => input.execute({
    side,
    revision: current[side].revision,
    runId: current[side].runId,
    projectId: current.projectId,
    dataContractId: current.pairManifest.dataContractId,
    planHash: current.pairManifest.planHash,
    environmentHash: current.pairManifest.environmentHash,
    randomSeed: current.pairManifest.randomSeed,
    testTime: current.pairManifest.testTime,
    oracleSpecIds: current.pairManifest.oracleSpecIds
  });
  const settle = async (side: "base" | "head") => {
    try {
      return { status: "fulfilled" as const, value: await executeSide(side) };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  };
  const [baseSettled, headSettled] = input.parallel
    ? await Promise.all([settle("base"), settle("head")])
    : [await settle("base"), await settle("head")];
  const rejected = (settled: PromiseSettledResult<DifferentialSideExecutionResult>) => settled.status === "rejected";
  const sideResult = (side: "base" | "head", settled: PromiseSettledResult<DifferentialSideExecutionResult>): DifferentialSideV1 => {
    if (settled.status === "fulfilled") {
      const oracleDecisions = settled.value.oracleDecisions ?? [];
      return {
        ...current[side],
        state: settled.value.state,
        gateStatus: oracleGuardedGateStatus(settled.value.gateStatus, oracleDecisions),
        environmentHash: settled.value.environmentHash,
        failureSignature: settled.value.failureSignature,
        repetitionsStable: settled.value.repetitionsStable,
        visualDifferenceOnly: settled.value.visualDifferenceOnly,
        oracleDecisions,
        artifactIds: settled.value.artifactIds ?? [],
        evidenceRefs: settled.value.evidenceRefs ?? []
      };
    }
    return {
      ...current[side],
      state: "failed",
      gateStatus: "blocked",
      oracleDecisions: [],
      artifactIds: [],
      evidenceRefs: []
    };
  };
  const base = sideResult("base", baseSettled);
  const head = sideResult("head", headSettled);
  const actualEnvironmentHash = base.environmentHash && base.environmentHash === head.environmentHash
    ? base.environmentHash
    : running.pairManifest.environmentHash;
  const decision = classifyDifferential({
    baseGateStatus: base.gateStatus,
    headGateStatus: head.gateStatus,
    baseFailureSignature: base.failureSignature,
    headFailureSignature: head.failureSignature,
    baseOracleDecisions: base.oracleDecisions,
    headOracleDecisions: head.oracleDecisions,
    baseEnvironmentHash: baseSettled.status === "fulfilled" ? baseSettled.value.environmentHash ?? current.pairManifest.environmentHash : undefined,
    headEnvironmentHash: headSettled.status === "fulfilled" ? headSettled.value.environmentHash ?? current.pairManifest.environmentHash : undefined,
    repetitionsStable: baseSettled.status === "fulfilled" && headSettled.status === "fulfilled"
      ? [baseSettled.value.repetitionsStable, headSettled.value.repetitionsStable].includes(false) ? false : undefined
      : undefined,
    visualDifferenceOnly: baseSettled.status === "fulfilled" && headSettled.status === "fulfilled"
      ? Boolean(baseSettled.value.visualDifferenceOnly || headSettled.value.visualDifferenceOnly)
      : false
  });
  const reasons = [
    ...decision.reasons,
    ...(rejected(baseSettled) ? ["base_executor_failed"] : []),
    ...(rejected(headSettled) ? ["head_executor_failed"] : [])
  ];
  const finalStatus = rejected(baseSettled) || rejected(headSettled) ? "blocked" : "completed";
  const next = differentialRunV1Schema.parse({
    ...running,
    status: finalStatus,
    base,
    head,
    pairManifest: {
      ...running.pairManifest,
      environmentHash: actualEnvironmentHash,
      classification: decision.classification,
      classificationReasons: reasons,
      evidenceRefs: [...new Set([...base.evidenceRefs, ...head.evidenceRefs])]
    },
    updatedAt: new Date().toISOString()
  });
  const evidence = await recordReliabilityMutation({
    store,
    kind: "differential-run",
    entityId: next.id,
    value: next,
    operation: finalStatus === "blocked" ? "blocked" : "updated",
    projectId: next.projectId,
    sourceRunId: next.id,
    evidenceTitle: "Differential run classification completed",
    evidencePayload: {
      classification: decision.classification,
      reasons,
      base: { runId: base.runId, gateStatus: base.gateStatus, evidenceRefs: base.evidenceRefs, artifactIds: base.artifactIds },
      head: { runId: head.runId, gateStatus: head.gateStatus, evidenceRefs: head.evidenceRefs, artifactIds: head.artifactIds }
    }
  });
  const completed = next;
  await finalizeParentRun({
    runStore: runs,
    parentRunId: current.id,
    blocked: finalStatus === "blocked",
    payload: {
      baseRunId: base.runId,
      headRunId: head.runId,
      pairManifestId: completed.pairManifest.id,
      evidenceRefs: completed.pairManifest.evidenceRefs,
      artifactIds: [...new Set([...base.artifactIds, ...head.artifactIds])],
      classification: decision.classification,
      finalStatus: finalStatus === "blocked" ? "blocked" : parentGateStatus(decision.classification),
      reasons
    }
  });
  return completed;
}
