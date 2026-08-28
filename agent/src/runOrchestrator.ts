import { Queue, Worker, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { acceptsExecutionResult, appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { runVisualGrayTest } from "./testRunner.js";
import type { GrayPlan, RunRequest } from "./types.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { acquireExecutionLease, listExpiredExecutionLeaseRunIds } from "./executionLease.js";
import { listStalledJudgingRunIds, recoverStalledJudgingRun } from "./durableGateLeaseRecovery.js";
import { listStalledApprovedPlanRunIds, recoverStalledApprovedPlanRun } from "./approvalResumeRecovery.js";
import { getAgentGraphProjection, resumeAgentGraph, startAgentGraphForRun, startAgentGraphInBackground } from "./agentGraphService.js";
import { readCoverageItems, saveCoverageItems, updateCoverageDisposition } from "./coverageStore.js";
import { getScenario, hasScenario } from "./scenarios.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { compileTrustedScenarioPlan } from "./compiledPlanContract.js";
import { runStructuredCoveragePath } from "./structuredCoverageRunner.js";
import { llmBudgetSchema, pathExecutionResultSchema, type CoverageItem, type LlmBudget } from "@ai-test-officer/contracts";
import { publishPendingOutbox, recordOutboxJob, type OutboxJob } from "./outboxStore.js";
import { reconcileConfiguredArtifactStore } from "./artifactObjectReconciliation.js";
import { appendEvidence } from "./evidenceStore.js";
import { rankCoverageItems } from "./adaptivePathStrategy.js";

const queueName = process.env.RUN_QUEUE_NAME ?? "ai-test-officer-runs";
const activeControllers = new Map<string, AbortController>();
let queue: Queue | undefined;
let worker: Worker | undefined;
let outboxTimer: NodeJS.Timeout | undefined;
let artifactReconciliationTimer: NodeJS.Timeout | undefined;
let leaseRecoveryTimer: NodeJS.Timeout | undefined;
const inProcessJobs = new Set<string>();

export function buildDynamicPathPlan(plan: GrayPlan, flowId: string): GrayPlan {
  const levels = plan.levels
    .map((level) => ({ ...level, paths: level.paths.filter((path) => path.id === flowId) }))
    .filter((level) => level.paths.length > 0);
  const risks = plan.risks.filter((risk) => risk.pathIds?.includes(flowId));
  return {
    ...plan,
    levels,
    risks: risks.length > 0 ? risks : plan.risks.map((risk) => ({ ...risk, pathIds: [flowId] }))
  };
}

function dynamicCoverageInventoryItem(item: Awaited<ReturnType<typeof readCoverageItems>>[number]) {
  return {
    id: item.flowId,
    title: item.module,
    status: "auto-bindable" as const,
    kind: "page" as const,
    target: item.route ?? item.module,
    sourceNodeIds: [],
    sourceCount: 1,
    surfaces: ["page" as const],
    requiredEvidenceKinds: item.requiredEvidenceKinds,
    preconditions: item.preconditions
  };
}

async function resumeGraphAndQueueIfNeeded(runId: string, value: Record<string, unknown>) {
  try {
    const execution = value.execution && typeof value.execution === "object"
      ? value.execution as Record<string, unknown>
      : undefined;
    const currentBeforeResume = await runEventStore.get(runId);
    // `beginEvidenceCollection` moves the durable Run to collecting.  Repeat
    // the worker generation/attempt check at the single Graph-resume entry so
    // every caller (including exception and parent aggregation paths) is
    // fail-closed.  A stale BullMQ delivery must never satisfy the newer
    // execution-result interrupt just because it happened to finish later.
    if (!acceptsExecutionResult(currentBeforeResume, execution)) return;
    await resumeAgentGraph(runId, value);
    const projection = await getAgentGraphProjection(runId);
    if (projection?.pendingInterrupt?.kind !== "execution-result") return;
    const current = await runEventStore.get(runId);
    if (!current || ["completed", "failed", "blocked", "cancelled", "paused"].includes(current.state)) return;
    // A recovery loop can legitimately return to execute and wait for a new
    // worker result. Re-enqueue the newer durable version; without this, the
    // first worker would leave the graph paused forever after a runtime retry.
    if (redisConnection()) {
      await enqueueRun(runId, current.version);
    } else if (inProcessJobs.has(runId)) {
      // A worker can resume the graph from inside its own execution. In the
      // in-process (no Redis) mode the current job still owns the idempotency
      // lock at this point, so enqueueRun would silently drop the follow-up.
      // Defer until the current worker's finally block releases the lock. A
      // single timer is not sufficient: it can fire before that finally block,
      // so poll briefly until the lock is actually gone.
      const enqueueAfterRelease = () => {
        if (inProcessJobs.has(runId)) {
          setTimeout(enqueueAfterRelease, 10);
          return;
        }
        void enqueueRun(runId, current.version).catch(() => undefined);
      };
      setTimeout(enqueueAfterRelease, 0);
    } else {
      await enqueueRun(runId, current.version);
    }
  } catch {
    // The graph projection/error event is the source of truth; the worker must
    // still release its lease even if a recovery resume cannot be scheduled.
  }
}

function redisConnection() {
  if (!process.env.REDIS_URL) return undefined;
  const url = new URL(process.env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
    ...(url.protocol === "rediss:" ? { tls: {} } : {})
  };
}

export function buildQueuedRunRequest(projection: RunProjection, signal: AbortSignal): RunRequest {
  const input = projection.input as Record<string, unknown>;
  // In active mode the worker is a deterministic executor. Selective LLM
  // judging belongs to the durable graph node so a worker retry cannot create
  // duplicate model calls or independently change the run conclusion.
  return {
    runId: projection.id,
    attemptId: projection.activeExecutionAttemptId,
    appUrl: typeof input.appUrl === "string" ? input.appUrl : undefined,
    projectId: typeof input.projectId === "string" ? input.projectId : undefined,
    executionProfile: input.executionProfile === "benchmark" ? "benchmark" : "interactive",
    scenarioId: projection.selectedScenarioId ?? (typeof input.scenarioId === "string" ? input.scenarioId : undefined),
    dataContractId: typeof input.dataContractId === "string" ? input.dataContractId : undefined,
    requirement: typeof input.requirement === "string" ? input.requirement : undefined,
    diff: typeof input.diff === "string" ? input.diff : undefined,
    plan: projection.plan,
    compiledPlan: projection.compiledPlan,
    credentialId: typeof input.modelProfileId === "string" ? input.modelProfileId : undefined,
    // Selective judging is a Graph node. Worker retries must never produce a
    // second model call or independently alter a formal conclusion.
    judgeMode: "deterministic",
    llmBudget: input.llmBudget as RunRequest["llmBudget"],
    priorLlmTokens: projection.plannerCalls?.reduce((sum, call) => sum + (call.usage.totalTokens ?? 0), 0) ?? projection.plannerCall?.usage.totalTokens ?? 0,
    experimentId: typeof input.experimentId === "string" ? input.experimentId : undefined,
    repetition: typeof input.repetition === "number" ? input.repetition : undefined,
    planProvenance: projection.planProvenance,
    impactAnalysis: projection.impactAnalysis,
    fixtureVariantId: typeof input.fixtureVariantId === "string" ? input.fixtureVariantId : undefined,
    permissionProfile: (input.permissionProfile as RunRequest["permissionProfile"] | undefined) ?? {
      observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false
    },
    signal
  };
}

const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);

/**
 * A hard Worker crash cannot run finally/release its Lease, and BullMQ alone
 * cannot change the durable Run state. Convert only an expired *active*
 * execution back to queued through an append-only event. That transaction
 * writes a fresh versioned Outbox row, while the reducer clears the old
 * generation/attempt so late output from the dead Worker remains fenced off.
 */
export async function recoverExpiredExecutionLeases(limit = 25) {
  const recovered: string[] = [];
  for (const runId of await listExpiredExecutionLeaseRunIds(limit)) {
    const current = await runEventStore.get(runId);
    if (!current) continue;
    if (current.state === "judging") {
      try {
        // `run_judging` is already an Event Store commit. Re-running the
        // Worker at this point could repeat a browser/API side effect merely
        // because the process died before its graph checkpoint advanced.
        if (await recoverStalledJudgingRun(runId, "worker_lease_expired_after_gate_commit")) recovered.push(runId);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("run_version_conflict:")) continue;
      }
      continue;
    }
    if (!["preparing", "running"].includes(current.state)) continue;
    try {
      const retried = await appendSystemRunEvent(runId, "run_retrying", {
        reason: "worker_lease_expired",
        previousAttemptId: current.activeExecutionAttemptId,
        previousExecutionGeneration: current.executionGeneration
      });
      await enqueueRun(runId, retried.version);
      recovered.push(runId);
    } catch (error) {
      // Competing API/Worker recoverers race through the same Event Store.
      // The loser observes a version conflict and must leave the already
      // queued replacement alone; other errors are retried on the next tick.
      if (error instanceof Error && error.message.startsWith("run_version_conflict:")) continue;
    }
  }
  return recovered;
}

/**
 * A Graph continuation can be alive after the Worker Job has released its
 * Lease. Recover an abandoned `judging` checkpoint from its already committed
 * Gate; never enqueue it, because enqueueing would re-run the underlying path.
 */
export async function recoverStalledJudgingRuns(limit = 25) {
  const recovered: string[] = [];
  const configuredGraceMs = Number(process.env.JUDGING_RECOVERY_GRACE_MS ?? 120_000);
  const minimumAgeMs = Number.isFinite(configuredGraceMs)
    ? Math.max(1_000, configuredGraceMs)
    : 120_000;
  for (const runId of await listStalledJudgingRunIds({ minimumAgeMs, limit })) {
    try {
      if (await recoverStalledJudgingRun(runId, "stalled_judging_checkpoint_after_gate_commit")) recovered.push(runId);
    } catch (error) {
      // A Graph continuation or another API instance may reach a terminal
      // event concurrently. Version conflicts mean that stronger durable
      // transition won, so a retry would be incorrect.
      if (error instanceof Error && error.message.startsWith("run_version_conflict:")) continue;
    }
  }
  return recovered;
}

/**
 * A plan approval is an Event Store fact, while its Graph continuation is a
 * separate process step. Resume only an abandoned, already-approved planning
 * interrupt; do not invent approvals or bypass the next permission boundary.
 */
export async function recoverStalledApprovedPlanResumes(limit = 25) {
  const recovered: string[] = [];
  const configuredGraceMs = Number(process.env.PLAN_APPROVAL_RESUME_RECOVERY_GRACE_MS ?? 120_000);
  const minimumAgeMs = Number.isFinite(configuredGraceMs)
    ? Math.max(1_000, configuredGraceMs)
    : 120_000;
  for (const runId of await listStalledApprovedPlanRunIds({ minimumAgeMs, limit })) {
    try {
      if (await recoverStalledApprovedPlanRun(runId, minimumAgeMs)) recovered.push(runId);
    } catch {
      // The claim expires after the grace period. Keep the original human
      // decision durable and let a later scan retry a transient Graph failure.
    }
  }
  return recovered;
}

export interface ParentCoverageDispatchClassification {
  executable: CoverageItem[];
  undispatchable: Array<{ item: CoverageItem; reason: string }>;
}

export interface ParentCoverageChildSpec {
  item: CoverageItem;
  childRunId: string;
  dynamicBrowserPath: boolean;
  scenarioId?: string;
  llmBudget: LlmBudget;
}

function undispatchableCoverageReason(item: CoverageItem) {
  const binding = item.binding;
  if (!binding) return "runtime_binding_missing";
  if (binding.status === "bound") return "coverage_bound_path_not_dispatchable";
  if (binding.status === "needs-input") return binding.reason ?? "runtime_binding_needs_input";
  if (binding.status === "blocked-by-capability") return binding.reason ?? "runtime_binding_blocked_by_capability";
  if (binding.status === "coverage-gap") return binding.reason ?? "runtime_binding_coverage_gap";
  return binding.reason ?? "runtime_binding_not_completed";
}

/**
 * Partition every pending CoverageItem before any child run is created. There
 * is deliberately no batch-size limit: concurrency belongs to the queue, not
 * to coverage discovery. A path without a current executor is reported as an
 * explicit blocked disposition instead of being omitted from the parent Run.
 */
export function classifyParentCoverageDispatch(input: {
  items: CoverageItem[];
  dynamicParent: boolean;
}): ParentCoverageDispatchClassification {
  const executable: CoverageItem[] = [];
  const undispatchable: Array<{ item: CoverageItem; reason: string }> = [];
  for (const item of input.items) {
    if (item.disposition !== "pending") continue;
    const staticExecutor = Boolean(item.structuredPlan) || (Boolean(item.scenarioId) && hasScenario(item.scenarioId!));
    const dynamicBrowserExecutor = input.dynamicParent
      && item.surface === "page"
      && !item.structuredPlan
      && !(item.scenarioId && hasScenario(item.scenarioId));
    if (staticExecutor || dynamicBrowserExecutor) executable.push(item);
    else undispatchable.push({ item, reason: undispatchableCoverageReason(item) });
  }
  return { executable, undispatchable };
}

/**
 * Compile the executable side of a parent coverage inventory into stable
 * child-run identities and per-path budget envelopes before any side effect is
 * attempted. The dispatcher and scale tests share this function so a test
 * cannot accidentally prove a different child identity or budget policy than
 * production uses.
 */
export function buildParentCoverageChildSpecs(input: {
  parentRunId: string;
  parentLlmBudget?: unknown;
  items: CoverageItem[];
  dynamicParent: boolean;
}): ParentCoverageChildSpec[] {
  const parentLlmBudget = llmBudgetSchema.safeParse(input.parentLlmBudget ?? {});
  return input.items.map((item) => {
    const structuredPlan = item.structuredPlan;
    const dynamicBrowserPath = input.dynamicParent
      && item.surface === "page"
      && !structuredPlan
      && !(item.scenarioId && hasScenario(item.scenarioId));
    const scenario = structuredPlan || dynamicBrowserPath ? undefined : getScenario(item.scenarioId!);
    const scenarioId = structuredPlan?.scenarioId ?? scenario?.id;
    const childRunId = `run_${createHash("sha256").update(`${input.parentRunId}:${item.id}`).digest("hex").slice(0, 28)}`;
    return {
      item,
      childRunId,
      dynamicBrowserPath,
      ...(scenarioId ? { scenarioId } : {}),
      llmBudget: llmBudgetSchema.parse({
        ...(parentLlmBudget.success ? parentLlmBudget.data : {}),
        maxBrowserActionCalls: item.budget?.maxBrowserActionCalls ?? 6,
        maxTotalTokens: item.budget?.maxTotalTokens ?? 30_000,
        totalTimeoutMs: item.budget?.totalTimeoutMs ?? 120_000
      })
    };
  });
}

/** Persistable resolution for pending paths that have no executor this Run can use. */
export function blockUndispatchableCoverageItems(input: {
  items: CoverageItem[];
  undispatchable: ParentCoverageDispatchClassification["undispatchable"];
}) {
  const blockedById = new Map(input.undispatchable.map(({ item, reason }) => [item.id, reason]));
  return input.items.map((item) => {
    const reason = blockedById.get(item.id);
    if (!reason) return item;
    return {
      ...item,
      // A `bound` contract without an executable adapter is internally
      // inconsistent. Downgrade it before persisting the blocked result so
      // the invariant remains true: every still-bound CoverageItem has a
      // dispatchable child-run path.
      binding: item.binding?.status === "bound"
        ? { ...item.binding, status: "coverage-gap" as const, reason, boundAt: undefined }
        : item.binding,
      disposition: "blocked" as const,
      dispositionReason: reason,
      updatedAt: new Date().toISOString()
    };
  });
}

/**
 * A worker may finish after a Graph recovery has already moved the durable Run
 * to a new queued attempt or terminal state. Never let that stale worker write
 * an evidence/finalization transition into the newer state machine generation.
 */
async function beginEvidenceCollection(
  runId: string,
  payload: Record<string, unknown>,
  expectedWorkerAttemptId?: string
) {
  const current = await runEventStore.get(runId);
  if (current?.state !== "running") return false;
  if (expectedWorkerAttemptId && current.activeExecutionAttemptId !== expectedWorkerAttemptId) return false;
  await appendSystemRunEvent(runId, "evidence_collecting", {
    ...payload,
    ...(expectedWorkerAttemptId ? { workerAttemptId: expectedWorkerAttemptId } : {})
  });
  return true;
}

async function dispatchParentCoverageRun(projection: RunProjection) {
  const discoveredItems = await readCoverageItems(projection.id);
  const ranking = projection.input.judgeMode === "adaptive"
    ? rankCoverageItems({ items: discoveredItems })
    : { items: discoveredItems, decisions: [] };
  const items = ranking.items;
  if (ranking.decisions.length > 0) {
    await appendEvidence(projection.id, {
      type: "operation",
      title: "Adaptive coverage priority computed",
      payload: {
        formula: "risk × uncertainty × expectedInformationGain ÷ cost",
        decisions: ranking.decisions,
        coverageItemIds: items.map((item) => item.id)
      }
    });
  }
  const dynamicParent = projection.planProvenance?.source === "dynamic-browser-agent";
  const dispatch = classifyParentCoverageDispatch({ items, dynamicParent });
  if (dispatch.undispatchable.length) {
    await saveCoverageItems(projection.id, blockUndispatchableCoverageItems({
      items,
      undispatchable: dispatch.undispatchable
    }));
  }
  const executable = dispatch.executable;
  if (!executable.length) {
    const childRunIds = items.map((item) => item.childRunId).filter((id): id is string => Boolean(id));
    // A parent without path children has no execution evidence to aggregate.
    // Never fall through to the legacy direct-run path: that makes a broken
    // coverage compiler look like a successful single-scenario parent run.
    return childRunIds.length
      ? { childRunIds, pending: false, aggregateNow: true }
      : { childRunIds: [], pending: false, aggregateNow: false, missingChildren: true };
  }
  const children: Array<{ item: (typeof executable)[number]; runId: string; projection: RunProjection }> = [];
  const childSpecs = buildParentCoverageChildSpecs({
    parentRunId: projection.id,
    parentLlmBudget: projection.input.llmBudget,
    items: executable,
    dynamicParent
  });
  for (const spec of childSpecs) {
    const { item, childRunId, dynamicBrowserPath, scenarioId, llmBudget } = spec;
    const structuredPlan = item.structuredPlan;
    const scenario = structuredPlan || dynamicBrowserPath ? undefined : getScenario(item.scenarioId!);
    const child = await runEventStore.create({
      runId: childRunId,
      actor: "agent-graph:coverage-dispatch",
      idempotencyKey: `${projection.id}:${item.id}:create-path-run`,
      payload: {
        ...projection.input,
        runKind: "path",
        parentRunId: projection.id,
        rootRunId: typeof projection.input.rootRunId === "string" ? projection.input.rootRunId : projection.id,
        coverageItemId: item.id,
        ...(scenarioId ? { scenarioId } : {}),
        coverageScenarioIds: [],
        plannerMode: "deterministic",
        judgeMode: projection.input.judgeMode ?? "deterministic",
        ...(dynamicBrowserPath ? {
          dynamicBrowser: true,
          coverageInventory: [dynamicCoverageInventoryItem(item)]
        } : {}),
        // A parent budget is an envelope, not a license for every child to
        // consume the full envelope. Each path gets an explicit bounded slice
        // persisted with its child run, so retries and late deliveries cannot
        // silently borrow another path's model budget.
        llmBudget
      }
    });
    let ready = child;
    if (ready.state === "planning") {
      if (dynamicBrowserPath && !projection.plan) throw new Error("dynamic_parent_plan_missing");
      ready = await appendSystemRunEvent(childRunId, "plan_generated", dynamicBrowserPath
        ? {
          plan: buildDynamicPathPlan(projection.plan!, item.flowId),
          provenance: projection.planProvenance ?? {
            source: "dynamic-browser-agent",
            promptVersion: String(projection.input.promptVersion ?? "plan-v1"),
            compilationStatus: "validated"
          },
          impactAnalysis: projection.impactAnalysis,
          plannerRouting: projection.plannerRouting
        }
        : {
        plan: structuredPlan ? {
          sessionName: item.module,
          risks: [{
            id: item.id,
            level: item.risk === "critical" ? "high" : item.risk,
            title: item.module,
            evidence: "Manifest-bound structured operation with a deterministic oracle.",
            pathIds: [item.flowId],
            coverageDisposition: "required"
          }],
          levels: [{
            id: "core_path",
            title: "Structured core path",
            description: "Execute the allow-listed API, data, job or command operation.",
            paths: [{
              id: item.flowId,
              title: item.module,
              riskReason: "The declared manifest capability requires an evidence-backed result.",
              expectedFrom: "requirement",
              retry: 0,
              steps: structuredPlan.steps.map((step) => step.action.action)
            }]
          }]
        } : buildScenarioGrayPlan(scenario!),
        compiledPlan: structuredPlan ?? compileTrustedScenarioPlan(scenario!),
        ...(scenarioId ? { scenarioId } : {}),
        provenance: {
          source: "deterministic",
          promptVersion: String(projection.input.promptVersion ?? "plan-v1"),
          compilationStatus: "validated"
        },
        impactAnalysis: projection.impactAnalysis
      });
    }
    if (ready.state === "awaiting-plan-approval") ready = await appendSystemRunEvent(childRunId, "plan_approved");
    if (ready.state === "awaiting-permission") ready = await appendSystemRunEvent(childRunId, "permission_granted");
    if (dynamicBrowserPath && !terminalRunStates.has(ready.state)) {
      // This child owns its own Browser Execution subgraph. It inherits the
      // parent's already-approved capability and therefore does not create a
      // second Worker job for the same browser path.
      if (ready.state === "queued") ready = await appendSystemRunEvent(childRunId, "run_preparing", { delegatedFrom: projection.id });
      if (ready.state === "preparing") ready = await appendSystemRunEvent(childRunId, "run_started", {
        workerAttemptId: `graph:${childRunId}`,
        executionGeneration: ready.version,
        delegatedFrom: projection.id
      });
      startAgentGraphInBackground(ready);
    } else if (!terminalRunStates.has(ready.state)) {
      // Establish the child checkpoint before its worker result can arrive.
      // Otherwise the worker would resume a graph thread that does not exist
      // and the child would remain stuck in collecting forever.
      await startAgentGraphForRun(ready);
    }
    await updateCoverageDisposition({
      runId: projection.id,
      coverageItemId: item.id,
      disposition: "executing",
      reason: "path_run_queued",
      childRunId
    });
    children.push({ item, runId: childRunId, projection: ready });
  }
  await Promise.all(children.map(({ runId, projection: child, item }) =>
    terminalRunStates.has(child.state)
      || (dynamicParent && item.surface === "page" && !item.structuredPlan && !(item.scenarioId && hasScenario(item.scenarioId)))
      ? Promise.resolve()
      : enqueueRun(runId, child.version)
  ));
  return { childRunIds: children.map((item) => item.runId), pending: true };
}

async function aggregateParentCoverageRun(runId: string, expectedGeneration?: number) {
  const parent = await runEventStore.get(runId);
  if (!parent || terminalRunStates.has(parent.state)) return parent;
  if (expectedGeneration !== undefined && parent.executionGeneration !== expectedGeneration) return parent;
  const coverage = await readCoverageItems(runId);
  const children = coverage.filter((item) => item.childRunId);
  if (!children.length) throw new Error("parent_coverage_children_missing");
  const projections = await Promise.all(children.map((item) => runEventStore.get(item.childRunId!)));
  if (projections.some((item) => !item || !terminalRunStates.has(item.state))) {
    throw new Error("child_runs_pending");
  }
  const dynamicBrowserChildren = parent.planProvenance?.source === "dynamic-browser-agent";
  await Promise.all(children.map(async (item, index) => {
    const child = projections[index]!;
    await updateCoverageDisposition({
      runId,
      coverageItemId: item.id,
      disposition: child.state === "blocked" || child.state === "cancelled"
        ? "blocked"
        : child.gateStatus === "fail" || child.state === "failed"
          ? "failed"
          : "executed",
      reason: child.gateStatus ?? child.state,
      childRunId: child.id
    });
  }));
  const childRunIds = projections.map((item) => item!.id);
  const current = await runEventStore.get(runId);
  if (current?.state === "running") {
    // A late aggregation job may race a retry or timeout.  Only the currently
    // running parent generation may enter evidence collection; otherwise an
    // old child result could mutate a newly queued parent attempt.
    if (!await beginEvidenceCollection(runId, { childRunIds, aggregate: true })) return runEventStore.get(runId);
    void resumeGraphAndQueueIfNeeded(runId, {
      ...(dynamicBrowserChildren ? { approved: true } : {}),
      execution: {
        childRunIds,
        aggregate: true,
        dynamicBrowserChildren,
        workerAttemptId: current.activeExecutionAttemptId,
        executionGeneration: current.executionGeneration
      }
    });
  }
  return runEventStore.get(runId);
}

async function scheduleParentAggregation(runId: string, executionGeneration?: number) {
  const connection = redisConnection();
  if (connection) {
    queue ??= new Queue(queueName, { connection });
    await recordOutboxJob({
      topic: "parent.aggregate",
      aggregateId: runId,
      idempotencyKey: `parent:${runId}:aggregate`,
      payload: { runId, version: executionGeneration, jobId: `${runId}-aggregate` }
    });
    await publishOutboxToQueue();
    return;
  }
  const deadline = Date.now() + Number(process.env.PARENT_AGGREGATION_TIMEOUT_MS ?? 20 * 60_000);
  const poll = async () => {
    try {
      await aggregateParentCoverageRun(runId, executionGeneration);
    } catch (error) {
      if (error instanceof Error && error.message === "child_runs_pending" && Date.now() < deadline) {
        setTimeout(() => void poll(), 250).unref();
        return;
      }
      const current = await runEventStore.get(runId);
      if (current?.state === "running") {
        const errorCode = error instanceof Error ? error.message : "parent_aggregation_failed";
        const attemptId = current.activeExecutionAttemptId;
        const generation = current.executionGeneration ?? executionGeneration;
        if (!attemptId || generation === undefined) {
          // No durable Worker ownership means there is no execution result we
          // are allowed to publish. Leave the parent running for its Graph
          // watchdog instead of manufacturing a Run-level conclusion here.
          return;
        }
        if (!await beginEvidenceCollection(runId, {
          error: errorCode,
          pathStatus: "blocked"
        }, attemptId)) return;
        void resumeGraphAndQueueIfNeeded(runId, {
          ...(current.planProvenance?.source === "dynamic-browser-agent" ? { approved: true } : {}),
          execution: {
            pathResult: pathExecutionResultSchema.parse({
              runId,
              attemptId,
              executionGeneration: generation,
              status: "blocked",
              executionSucceeded: false,
              error: errorCode
            }),
            ...(current.planProvenance?.source === "dynamic-browser-agent" ? { dynamicBrowserChildren: true } : {}),
            workerAttemptId: attemptId,
            executionGeneration: generation
          }
        }).catch(() => undefined);
      }
    }
  };
  setTimeout(() => void poll(), 250).unref();
}

export async function executeQueuedRun(runId: string, options?: { expectedVersion?: number }) {
  const initialProjection = await runEventStore.get(runId);
  // Dynamic browser path children are owned by their own LangGraph thread.
  // If a stale/duplicate queue delivery exists, acknowledge it without
  // acquiring a Worker lease or starting a second browser session.
  if (initialProjection?.runKind === "path" && initialProjection.input.dynamicBrowser === true) {
    return initialProjection;
  }
  if (options?.expectedVersion !== undefined && initialProjection?.version !== options.expectedVersion) {
    return initialProjection;
  }
  const lease = await acquireExecutionLease(runId);
  if (!lease) return runEventStore.get(runId);
  const heartbeat = setInterval(() => void lease.heartbeat().then((active) => { if (!active) activeControllers.get(runId)?.abort(); }).catch(() => activeControllers.get(runId)?.abort()), Math.max(1_000, Number(process.env.EXECUTION_LEASE_TTL_MS ?? 30_000) / 3));
  const projection = await runEventStore.get(runId);
  if (options?.expectedVersion !== undefined && projection?.version !== options.expectedVersion) {
    clearInterval(heartbeat);
    await lease.release();
    return projection;
  }
  if (!projection || ["cancelled", "completed", "failed", "blocked", "paused"].includes(projection.state)) { clearInterval(heartbeat); await lease.release(); return projection; }
  // `/v1/runs` normally starts the Graph before a worker can receive a job.
  // Demo/CLI callers may enqueue a durable Run directly, however. Bootstrap
  // the same Graph thread once in that case so the worker's evidence event can
  // resume the authoritative execution node instead of leaving the run in
  // collecting forever.
  if (!(await getAgentGraphProjection(runId))) {
    await startAgentGraphForRun(projection);
  }
  if (projection.state === "queued") await appendSystemRunEvent(runId, "run_preparing");
  const beforeStart = await runEventStore.get(runId);
  if (beforeStart?.state === "preparing") {
    await appendSystemRunEvent(runId, "run_started", {
      workerAttemptId: lease.attemptId,
      executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? beforeStart.version
    });
  }
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  try {
    if (projection.runKind === "parent") {
      const dispatch = await dispatchParentCoverageRun(projection);
      if (dispatch?.missingChildren) throw new Error("parent_coverage_children_missing");
      if (dispatch?.pending) {
        await scheduleParentAggregation(runId, options?.expectedVersion ?? initialProjection?.version);
        return runEventStore.get(runId);
      }
      if (dispatch?.aggregateNow) {
        if (!await beginEvidenceCollection(runId, {
          childRunIds: dispatch.childRunIds,
          aggregate: true
        }, lease.attemptId)) return runEventStore.get(runId);
        void resumeGraphAndQueueIfNeeded(runId, {
          execution: {
            childRunIds: dispatch.childRunIds,
            aggregate: true,
            workerAttemptId: lease.attemptId,
            executionGeneration: options?.expectedVersion ?? initialProjection?.version
          }
        }).catch(() => undefined);
        return runEventStore.get(runId);
      }
    }
    if (projection.runKind === "path" && projection.parentRunId && projection.coverageItemId) {
      const coverage = await readCoverageItems(projection.parentRunId);
      const item = coverage.find((candidate) => candidate.id === projection.coverageItemId);
      if (item?.structuredPlan) {
        const projectId = typeof projection.input.projectId === "string" ? projection.input.projectId : undefined;
        if (!projectId) throw new Error("structured_coverage_project_missing");
        const result = await runStructuredCoveragePath({
          runId,
          attemptId: lease.attemptId,
          projectId,
          coverageItem: item,
          requirement: typeof projection.input.requirement === "string" ? projection.input.requirement : undefined,
          dataContractId: typeof projection.input.dataContractId === "string" ? projection.input.dataContractId : undefined,
          signal: controller.signal
        });
        if (!await beginEvidenceCollection(runId, { resultRunId: result.id }, lease.attemptId)) return runEventStore.get(runId);
        void resumeGraphAndQueueIfNeeded(runId, {
          execution: {
            pathResult: pathExecutionResultSchema.parse({
              runId,
              attemptId: lease.attemptId,
              executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? 0,
              status: result.outcomeSummary?.executionSucceeded === true ? "executed" : "failed",
              resultRunId: result.id,
              executionSucceeded: result.outcomeSummary?.executionSucceeded === true
            }),
            resultRunId: result.id,
            workerAttemptId: lease.attemptId,
            executionGeneration: options?.expectedVersion ?? initialProjection?.version
          }
        }).catch(() => undefined);
        return runEventStore.get(runId);
      }
    }
    const queuedRequest = buildQueuedRunRequest(projection, controller.signal);
    const requestedScenarioId = typeof projection.input.scenarioId === "string" ? projection.input.scenarioId : undefined;
    if (requestedScenarioId && queuedRequest.scenarioId !== requestedScenarioId) {
      if (!await beginEvidenceCollection(runId, {
        error: "scenario_handoff_missing",
        requestedScenarioId,
        projectedScenarioId: projection.selectedScenarioId
      }, lease.attemptId)) return runEventStore.get(runId);
      void resumeGraphAndQueueIfNeeded(runId, { execution: {
        pathResult: pathExecutionResultSchema.parse({
          runId,
          attemptId: lease.attemptId,
          executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? 0,
          status: "blocked",
          executionSucceeded: false,
          error: "scenario_handoff_missing"
        }),
        workerAttemptId: lease.attemptId,
        executionGeneration: options?.expectedVersion ?? initialProjection?.version
      } });
      return runEventStore.get(runId);
    }
    if (!queuedRequest.scenarioId) {
      if (!await beginEvidenceCollection(runId, { error: "scenario_handoff_missing" }, lease.attemptId)) return runEventStore.get(runId);
      void resumeGraphAndQueueIfNeeded(runId, { execution: {
        pathResult: pathExecutionResultSchema.parse({
          runId,
          attemptId: lease.attemptId,
          executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? 0,
          status: "blocked",
          executionSucceeded: false,
          error: "scenario_handoff_missing"
        }),
        workerAttemptId: lease.attemptId,
        executionGeneration: options?.expectedVersion ?? initialProjection?.version
      } });
      return runEventStore.get(runId);
    }
    const result = await runVisualGrayTest({ ...queuedRequest, attemptId: lease.attemptId });
    await persistExecutionResult(runId, result);
    if (!await beginEvidenceCollection(runId, { resultRunId: result.id }, lease.attemptId)) return runEventStore.get(runId);
    void resumeGraphAndQueueIfNeeded(runId, {
      execution: {
        pathResult: pathExecutionResultSchema.parse({
          runId,
          attemptId: lease.attemptId,
          executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? 0,
          status: "executed",
          resultRunId: result.id,
          executionSucceeded: true
        }),
        resultRunId: result.id,
        workerAttemptId: lease.attemptId,
        executionGeneration: options?.expectedVersion ?? initialProjection?.version
      }
    }).catch(() => undefined);
    return runEventStore.get(runId);
  } catch (error) {
    const current = await runEventStore.get(runId);
    if (current?.state === "paused" || current?.state === "cancelled") return current;
    const message = error instanceof Error ? error.message : String(error);
    // A failure to atomically publish an Artifact v2 is infrastructure, not a
    // product assertion failure. Preserve local diagnostic output but block the
    // formal result so Graph can report an actionable object-store issue rather
    // than opening a target-project repair session.
    const blocked = /runtime_unavailable|permission|environment|command_not_found|health|port|dependency|artifact[_-]?object|object[ _-]?store|minio|\bs3\b|econnrefused|fetch failed/i.test(message);
    const pathStatus = blocked ? "blocked" : "failed";
    const latest = await runEventStore.get(runId);
    const accepted = latest?.state === "running"
      ? await beginEvidenceCollection(runId, { error: message, pathStatus }, lease.attemptId)
      : false;
    if (!accepted) return runEventStore.get(runId);
    void resumeGraphAndQueueIfNeeded(runId, { execution: {
      pathResult: pathExecutionResultSchema.parse({
        runId,
        attemptId: lease.attemptId,
        executionGeneration: options?.expectedVersion ?? initialProjection?.version ?? 0,
        status: pathStatus,
        executionSucceeded: false,
        error: message
      }),
      workerAttemptId: lease.attemptId,
      executionGeneration: options?.expectedVersion ?? initialProjection?.version
    } });
    return runEventStore.get(runId);
  } finally {
    activeControllers.delete(runId);
    clearInterval(heartbeat);
    await lease.release();
  }
}

async function processJob(job: Job<{ runId: string; version?: number } | Record<string, unknown>>) {
  if (job.name === "reliability-asset-event") {
    // Reliability events are already durably applied to the Asset/Evidence
    // transaction. Consuming this job acknowledges delivery without creating
    // a second state store; external subscribers can use the same topic.
    return;
  }
  if (typeof job.data.runId !== "string") throw new Error("outbox_run_id_missing");
  const runPayload = job.data as { runId: string; version?: number };
  if (job.name === "aggregate-parent") return aggregateParentCoverageRun(runPayload.runId, runPayload.version);
  return executeQueuedRun(runPayload.runId, { expectedVersion: runPayload.version });
}

async function publishOutboxToQueue() {
  const connection = redisConnection();
  if (!connection) return 0;
  queue ??= new Queue(queueName, { connection });
  return publishPendingOutbox({
    publish: async (job: OutboxJob) => {
      if (job.topic === "run.execute") {
        await queue!.add("execute", job.payload, {
          jobId: (job.payload as { jobId: string }).jobId,
          removeOnComplete: 500,
          removeOnFail: 500
        });
        return;
      }
      if (job.topic === "reliability.asset") {
        const payload = job.payload as { eventId: string };
        await queue!.add("reliability-asset-event", job.payload, {
          jobId: payload.eventId,
          removeOnComplete: 500,
          removeOnFail: 500
        });
        return;
      }
      const payload = job.payload as { jobId: string };
      await queue!.add("aggregate-parent", job.payload, {
        jobId: payload.jobId,
        delay: 500,
        // A parent may legitimately own long-running job paths. Keep the
        // aggregation watchdog aligned with the default 20 minute run budget.
        attempts: Math.max(2, Number(process.env.PARENT_AGGREGATION_ATTEMPTS ?? 1_200)),
        backoff: { type: "fixed", delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: 500
      });
    }
  });
}

export async function startRunWorker(options?: { forceWorker?: boolean }) {
  const connection = redisConnection();
  if (!connection) return;
  queue ??= new Queue(queueName, { connection });
  if (!outboxTimer) {
    await publishOutboxToQueue();
    outboxTimer = setInterval(() => void publishOutboxToQueue().catch(() => undefined), Math.max(1_000, Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5_000)));
    outboxTimer.unref();
  }
  if (!artifactReconciliationTimer && process.env.ARTIFACT_S3_BUCKET) {
    const reconcile = () => reconcileConfiguredArtifactStore({ apply: true }).catch(() => undefined);
    // Reconciliation is independent from job delivery: an S3 outage cannot
    // stop Run dispatch, but a stale replica must be marked before a later
    // report/Gate read can use it as evidence.
    await reconcile();
    artifactReconciliationTimer = setInterval(reconcile, Math.max(60_000, Number(process.env.ARTIFACT_RECONCILE_INTERVAL_MS ?? 15 * 60_000)));
    artifactReconciliationTimer.unref();
  }
  if (!leaseRecoveryTimer && process.env.DATABASE_URL) {
    const recover = () => {
      void recoverExpiredExecutionLeases().catch(() => undefined);
      void recoverStalledJudgingRuns().catch(() => undefined);
      void recoverStalledApprovedPlanResumes().catch(() => undefined);
    };
    // Both API and external Worker processes may own this timer. The
    // append-only version check makes the scan safe in multi-instance mode;
    // a restarted process can recover an abandoned lease without a manual
    // requeue operation.
    leaseRecoveryTimer = setInterval(
      recover,
      Math.max(1_000, Number(process.env.EXECUTION_LEASE_RECOVERY_INTERVAL_MS ?? Math.max(1_000, Number(process.env.EXECUTION_LEASE_TTL_MS ?? 30_000) / 3)))
    );
    leaseRecoveryTimer.unref();
    recover();
  }
  if (worker || (process.env.RUN_WORKER_IN_PROCESS === "0" && !options?.forceWorker)) return;
  worker = new Worker(queueName, processJob, { connection, concurrency: Number(process.env.RUN_WORKER_CONCURRENCY ?? 2) });
}

export async function enqueueRun(runId: string, version: number) {
  const connection = redisConnection();
  if (connection) {
    queue ??= new Queue(queueName, { connection });
    // The event store writes the matching outbox row in the same PostgreSQL
    // transaction as permission/resume/retry events. This call is the fast
    // path; the poller repairs a crash between the event commit and Redis.
    await recordOutboxJob({
      topic: "run.execute",
      aggregateId: runId,
      idempotencyKey: `run:${runId}:execute:v${version}`,
      payload: { runId, version, jobId: `${runId}-v${version}` }
    });
    await startRunWorker();
    await publishOutboxToQueue();
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required in production");
  if (inProcessJobs.has(runId)) return;
  inProcessJobs.add(runId);
  queueMicrotask(() => void executeQueuedRun(runId, { expectedVersion: version }).finally(() => inProcessJobs.delete(runId)));
}

export function interruptRun(runId: string) {
  activeControllers.get(runId)?.abort();
}

export async function closeRunOrchestrator() {
  if (outboxTimer) clearInterval(outboxTimer);
  outboxTimer = undefined;
  if (artifactReconciliationTimer) clearInterval(artifactReconciliationTimer);
  artifactReconciliationTimer = undefined;
  if (leaseRecoveryTimer) clearInterval(leaseRecoveryTimer);
  leaseRecoveryTimer = undefined;
  await worker?.close();
  await queue?.close();
}
