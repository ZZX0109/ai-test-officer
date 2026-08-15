import { Queue, Worker, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { acceptsExecutionResult, appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { runVisualGrayTest } from "./testRunner.js";
import type { RunRequest } from "./types.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { acquireExecutionLease } from "./executionLease.js";
import { getAgentGraphProjection, resumeAgentGraph, startAgentGraphForRun } from "./agentGraphService.js";
import { readCoverageItems, updateCoverageDisposition } from "./coverageStore.js";
import { getScenario, hasScenario } from "./scenarios.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { compileTrustedScenarioPlan } from "./compiledPlanContract.js";
import { runStructuredCoveragePath } from "./structuredCoverageRunner.js";
import { pathExecutionResultSchema } from "@ai-test-officer/contracts";

const queueName = process.env.RUN_QUEUE_NAME ?? "ai-test-officer-runs";
const activeControllers = new Map<string, AbortController>();
let queue: Queue | undefined;
let worker: Worker | undefined;
const inProcessJobs = new Set<string>();

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
    appUrl: typeof input.appUrl === "string" ? input.appUrl : undefined,
    projectId: typeof input.projectId === "string" ? input.projectId : undefined,
    executionProfile: input.executionProfile === "benchmark" ? "benchmark" : "interactive",
    scenarioId: projection.selectedScenarioId ?? (typeof input.scenarioId === "string" ? input.scenarioId : undefined),
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
  const items = await readCoverageItems(projection.id);
  const executable = items.filter((item) =>
    item.disposition === "pending"
    && (Boolean(item.structuredPlan) || (Boolean(item.scenarioId) && hasScenario(item.scenarioId!)))
  );
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
  for (const item of executable) {
    const structuredPlan = item.structuredPlan;
    const scenario = structuredPlan ? undefined : getScenario(item.scenarioId!);
    const scenarioId = structuredPlan?.scenarioId ?? scenario!.id;
    const childRunId = `run_${createHash("sha256").update(`${projection.id}:${item.id}`).digest("hex").slice(0, 28)}`;
    const child = await runEventStore.create({
      runId: childRunId,
      actor: "agent-graph:coverage-dispatch",
      idempotencyKey: `${projection.id}:${item.id}:create-path-run`,
      payload: {
        ...projection.input,
        runKind: "path",
        parentRunId: projection.id,
        coverageItemId: item.id,
        scenarioId,
        coverageScenarioIds: [],
        plannerMode: "deterministic",
        judgeMode: projection.input.judgeMode ?? "deterministic"
      }
    });
    let ready = child;
    if (ready.state === "planning") {
      ready = await appendSystemRunEvent(childRunId, "plan_generated", {
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
        scenarioId,
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
    if (!terminalRunStates.has(ready.state)) {
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
  await Promise.all(children.map(({ runId, projection: child }) =>
    terminalRunStates.has(child.state) ? Promise.resolve() : enqueueRun(runId, child.version)
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
      execution: {
        childRunIds,
        aggregate: true,
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
    await queue.add(
      "aggregate-parent",
      { runId, version: executionGeneration },
      {
        jobId: `${runId}-aggregate`,
        delay: 500,
        // A parent may legitimately own long-running job paths. Keep the
        // aggregation watchdog aligned with the default 20 minute run budget
        // instead of expiring after roughly two minutes.
        attempts: Math.max(2, Number(process.env.PARENT_AGGREGATION_ATTEMPTS ?? 1_200)),
        backoff: { type: "fixed", delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: 500
      }
    );
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
          execution: {
            pathResult: pathExecutionResultSchema.parse({
              runId,
              attemptId,
              executionGeneration: generation,
              status: "blocked",
              executionSucceeded: false,
              error: errorCode
            }),
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
          projectId,
          coverageItem: item,
          requirement: typeof projection.input.requirement === "string" ? projection.input.requirement : undefined,
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
    const result = await runVisualGrayTest(queuedRequest);
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

async function processJob(job: Job<{ runId: string; version?: number }>) {
  if (job.name === "aggregate-parent") return aggregateParentCoverageRun(job.data.runId, job.data.version);
  return executeQueuedRun(job.data.runId, { expectedVersion: job.data.version });
}

export async function startRunWorker() {
  const connection = redisConnection();
  if (!connection || worker) return;
  worker = new Worker(queueName, processJob, { connection, concurrency: Number(process.env.RUN_WORKER_CONCURRENCY ?? 2) });
}

export async function enqueueRun(runId: string, version: number) {
  const connection = redisConnection();
  if (connection) {
    queue ??= new Queue(queueName, { connection });
    // One version maps to one idempotent delivery. A resume intentionally has a
    // newer projection version and therefore needs a fresh job, while duplicate
    // control requests at the same version still collapse to one BullMQ job.
    // BullMQ rejects ':' in custom ids, so keep the version delimiter portable.
    await queue.add("execute", { runId, version }, { jobId: `${runId}-v${version}`, removeOnComplete: 500, removeOnFail: 500 });
    if (process.env.RUN_WORKER_IN_PROCESS !== "0") await startRunWorker();
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
  await worker?.close();
  await queue?.close();
}
