import { Queue, Worker, type Job } from "bullmq";
import { createHash } from "node:crypto";
import { resolveFinalStatus, type JudgeRecommendation, type MachineGate } from "@ai-test-officer/contracts";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { runVisualGrayTest } from "./testRunner.js";
import type { RunRequest } from "./types.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { acquireExecutionLease } from "./executionLease.js";
import { agentOrchestrationMode, resumeAgentGraphInBackground, startAgentGraphForRun } from "./agentGraphService.js";
import { readCoverageItems, updateCoverageDisposition } from "./coverageStore.js";
import { getScenario } from "./scenarios.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { compileTrustedScenarioPlan } from "./compiledPlanContract.js";
import { runStructuredCoveragePath } from "./structuredCoverageRunner.js";

const queueName = process.env.RUN_QUEUE_NAME ?? "ai-test-officer-runs";
const activeControllers = new Map<string, AbortController>();
let queue: Queue | undefined;
let worker: Worker | undefined;
const inProcessJobs = new Set<string>();

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

function machineGateFromResult(result: Awaited<ReturnType<typeof runVisualGrayTest>>): MachineGate {
  if (result.machineGate) return result.machineGate;
  const status = result.gateStatus ?? "needs-human-review";
  return {
    status,
    reasons: result.artifactIntegrity?.items.filter((item) => !["present", "self_reference"].includes(item.status)).map((item) => `${item.id}:${item.status}`) ?? [],
    reasonDetails: (result.artifactIntegrity?.items ?? [])
      .filter((item) => !["present", "self_reference"].includes(item.status) && item.evidenceId)
      .map((item) => ({
        code: item.status,
        summary: `${item.id}:${item.status}`,
        evidenceRefs: [item.evidenceId!]
      })),
    assertionFailures: result.assertions.filter((item) => !item.passed).map((item) => item.name),
    evidenceComplete: status !== "blocked" && status !== "needs-human-review"
  };
}

function recommendationFromResult(result: Awaited<ReturnType<typeof runVisualGrayTest>>): JudgeRecommendation {
  if (result.judgeRecommendation) return result.judgeRecommendation;
  const judge = result.judgeReport.releaseJudge;
  return {
    status: judge.verdict === "needs_review" ? "needs-human-review" : judge.verdict,
    summary: judge.summary,
    evidenceRefs: Array.from(new Set(judge.findings.flatMap((finding) => finding.evidenceRefs)))
  };
}

export function buildQueuedRunRequest(projection: RunProjection, signal: AbortSignal): RunRequest {
  const input = projection.input as Record<string, unknown>;
  // In active mode the worker is a deterministic executor. Selective LLM
  // judging belongs to the durable graph node so a worker retry cannot create
  // duplicate model calls or independently change the run conclusion.
  const graphOwnsJudge = agentOrchestrationMode(
    typeof projection.input.projectId === "string" ? projection.input.projectId : undefined
  ) === "active";
  return {
    runId: projection.id,
    appUrl: typeof input.appUrl === "string" ? input.appUrl : undefined,
    projectId: typeof input.projectId === "string" ? input.projectId : undefined,
    scenarioId: projection.selectedScenarioId ?? (typeof input.scenarioId === "string" ? input.scenarioId : undefined),
    requirement: typeof input.requirement === "string" ? input.requirement : undefined,
    diff: typeof input.diff === "string" ? input.diff : undefined,
    plan: projection.plan,
    compiledPlan: projection.compiledPlan,
    credentialId: typeof input.modelProfileId === "string" ? input.modelProfileId : undefined,
    judgeMode: graphOwnsJudge
      ? "deterministic"
      : input.judgeMode === "llm-assisted" || input.judgeMode === "adaptive" ? input.judgeMode : "deterministic",
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

async function dispatchParentCoverageRun(projection: RunProjection) {
  const items = await readCoverageItems(projection.id);
  const executable = items.filter((item) => item.disposition === "pending" && item.scenarioId);
  if (!executable.length) {
    return items.length
      ? {
          childRunIds: items.map((item) => item.childRunId).filter((id): id is string => Boolean(id)),
          pending: false,
          aggregateNow: true
        }
      : undefined;
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
    if (agentOrchestrationMode(
      typeof ready.input.projectId === "string" ? ready.input.projectId : undefined
    ) === "active" && !terminalRunStates.has(ready.state)) {
      // Establish the child checkpoint before its worker result can arrive.
      // Otherwise the worker would resume a graph thread that does not exist
      // and the child would remain stuck in collecting forever.
      await startAgentGraphForRun(ready);
    }
    await updateCoverageDisposition({
      runId: projection.id,
      coverageItemId: item.id,
      disposition: "pending",
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

async function aggregateParentCoverageRun(runId: string) {
  const parent = await runEventStore.get(runId);
  if (!parent || terminalRunStates.has(parent.state)) return parent;
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
      disposition: child.state === "blocked" || child.state === "cancelled" ? "blocked" : "executed",
      reason: child.gateStatus ?? child.state,
      childRunId: child.id
    });
  }));
  const childRunIds = projections.map((item) => item!.id);
  const current = await runEventStore.get(runId);
  if (current?.state === "running") {
    await appendSystemRunEvent(runId, "evidence_collecting", { childRunIds, aggregate: true });
    void resumeAgentGraphInBackground(runId, { execution: { childRunIds, aggregate: true } }).catch(() => undefined);
  }
  return runEventStore.get(runId);
}

async function scheduleParentAggregation(runId: string) {
  const connection = redisConnection();
  if (connection) {
    queue ??= new Queue(queueName, { connection });
    await queue.add(
      "aggregate-parent",
      { runId },
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
      await aggregateParentCoverageRun(runId);
    } catch (error) {
      if (error instanceof Error && error.message === "child_runs_pending" && Date.now() < deadline) {
        setTimeout(() => void poll(), 250).unref();
        return;
      }
      const current = await runEventStore.get(runId);
      if (current?.state === "running") {
        await appendSystemRunEvent(runId, "evidence_collecting", {
          finalStatus: "blocked",
          error: error instanceof Error ? error.message : "parent_aggregation_failed"
        });
        void resumeAgentGraphInBackground(runId, {
          execution: {
            finalStatus: "blocked",
            error: error instanceof Error ? error.message : "parent_aggregation_failed"
          }
        }).catch(() => undefined);
      }
    }
  };
  setTimeout(() => void poll(), 250).unref();
}

export async function executeQueuedRun(runId: string, options?: { terminalizeInWorker?: boolean }) {
  const initialProjection = await runEventStore.get(runId);
  const graphOwnsFinalization = agentOrchestrationMode(
    typeof initialProjection?.input.projectId === "string" ? initialProjection.input.projectId : undefined
  ) === "active" && !options?.terminalizeInWorker;
  const lease = await acquireExecutionLease(runId);
  if (!lease) return runEventStore.get(runId);
  const heartbeat = setInterval(() => void lease.heartbeat().then((active) => { if (!active) activeControllers.get(runId)?.abort(); }).catch(() => activeControllers.get(runId)?.abort()), Math.max(1_000, Number(process.env.EXECUTION_LEASE_TTL_MS ?? 30_000) / 3));
  const projection = await runEventStore.get(runId);
  if (!projection || ["cancelled", "completed", "failed", "blocked", "paused"].includes(projection.state)) { clearInterval(heartbeat); await lease.release(); return projection; }
  if (projection.state === "queued") await appendSystemRunEvent(runId, "run_preparing");
  const beforeStart = await runEventStore.get(runId);
  if (beforeStart?.state === "preparing") await appendSystemRunEvent(runId, "run_started");
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  try {
    if (projection.runKind === "parent") {
      const dispatch = await dispatchParentCoverageRun(projection);
      if (dispatch?.pending) {
        await scheduleParentAggregation(runId);
        return runEventStore.get(runId);
      }
      if (dispatch?.aggregateNow) {
        await appendSystemRunEvent(runId, "evidence_collecting", {
          childRunIds: dispatch.childRunIds,
          aggregate: true
        });
        void resumeAgentGraphInBackground(runId, {
          execution: { childRunIds: dispatch.childRunIds, aggregate: true }
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
        await appendSystemRunEvent(runId, "evidence_collecting", { resultRunId: result.id });
        if (graphOwnsFinalization) {
          void resumeAgentGraphInBackground(runId, {
            execution: {
              resultRunId: result.id,
              executionSucceeded: result.outcomeSummary?.executionSucceeded === true
            }
          }).catch(() => undefined);
          return runEventStore.get(runId);
        }
        const machineGate = machineGateFromResult(result);
        const judgeRecommendation = recommendationFromResult(result);
        await appendSystemRunEvent(runId, "run_judging", {
          resultRunId: result.id,
          machineGate,
          judgeRecommendation
        });
        const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
        const payload = {
          resultRunId: result.id,
          machineGate,
          judgeRecommendation,
          finalStatus,
          outcomeSummary: result.outcomeSummary
        };
        return finalStatus === "pass"
          ? appendSystemRunEvent(runId, "run_completed", payload)
          : finalStatus === "fail"
            ? appendSystemRunEvent(runId, "run_failed", payload)
            : finalStatus === "blocked"
              ? appendSystemRunEvent(runId, "run_blocked", payload)
              : appendSystemRunEvent(runId, "human_review_requested", payload);
      }
    }
    const queuedRequest = buildQueuedRunRequest(projection, controller.signal);
    const requestedScenarioId = typeof projection.input.scenarioId === "string" ? projection.input.scenarioId : undefined;
    if (requestedScenarioId && queuedRequest.scenarioId !== requestedScenarioId) {
      if (graphOwnsFinalization) {
        await appendSystemRunEvent(runId, "evidence_collecting", {
          error: "scenario_handoff_missing",
          requestedScenarioId,
          projectedScenarioId: projection.selectedScenarioId
        });
        void resumeAgentGraphInBackground(runId, { execution: { finalStatus: "blocked", error: "scenario_handoff_missing" } }).catch(() => undefined);
        return runEventStore.get(runId);
      }
      const terminal = await appendSystemRunEvent(runId, "run_blocked", {
        finalStatus: "blocked",
        error: "scenario_handoff_missing",
        requestedScenarioId,
        projectedScenarioId: projection.selectedScenarioId
      });
      return terminal;
    }
    if (!queuedRequest.scenarioId) {
      if (graphOwnsFinalization) {
        await appendSystemRunEvent(runId, "evidence_collecting", { error: "scenario_handoff_missing" });
        void resumeAgentGraphInBackground(runId, { execution: { finalStatus: "blocked", error: "scenario_handoff_missing" } }).catch(() => undefined);
        return runEventStore.get(runId);
      }
      const terminal = await appendSystemRunEvent(runId, "run_blocked", { finalStatus: "blocked", error: "scenario_handoff_missing" });
      return terminal;
    }
    const result = await runVisualGrayTest(queuedRequest);
    await persistExecutionResult(runId, result);
    await appendSystemRunEvent(runId, "evidence_collecting", { resultRunId: result.id });
    if (graphOwnsFinalization) {
      void resumeAgentGraphInBackground(runId, {
        execution: {
          resultRunId: result.id,
          executionSucceeded: true
        }
      }).catch(() => undefined);
      return runEventStore.get(runId);
    }
    const machineGate = machineGateFromResult(result);
    const judgeRecommendation = recommendationFromResult(result);
    await appendSystemRunEvent(runId, "run_judging", { resultRunId: result.id, machineGate, judgeRecommendation });
    const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
    const payload = { resultRunId: result.id, machineGate, judgeRecommendation, finalStatus, outcomeSummary: result.outcomeSummary };
    const terminal = finalStatus === "pass"
      ? await appendSystemRunEvent(runId, "run_completed", payload)
      : finalStatus === "fail"
        ? await appendSystemRunEvent(runId, "run_failed", payload)
        : finalStatus === "blocked"
          ? await appendSystemRunEvent(runId, "run_blocked", payload)
          : await appendSystemRunEvent(runId, "human_review_requested", payload);
    return terminal;
  } catch (error) {
    const current = await runEventStore.get(runId);
    if (current?.state === "paused" || current?.state === "cancelled") return current;
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /runtime_unavailable|permission|environment|command_not_found|health|port|dependency/.test(message);
    const finalStatus = blocked ? "blocked" : "fail";
    if (graphOwnsFinalization) {
      const latest = await runEventStore.get(runId);
      if (latest?.state === "running") {
        await appendSystemRunEvent(runId, "evidence_collecting", { error: message, finalStatus });
      }
      void resumeAgentGraphInBackground(runId, { execution: { finalStatus, error: message } }).catch(() => undefined);
      return runEventStore.get(runId);
    }
    const terminal = await appendSystemRunEvent(runId, blocked ? "run_blocked" : "run_failed", {
      finalStatus: blocked ? "blocked" : "fail",
      error: message
    });
    return terminal;
  } finally {
    activeControllers.delete(runId);
    clearInterval(heartbeat);
    await lease.release();
  }
}

async function processJob(job: Job<{ runId: string }>) {
  if (job.name === "aggregate-parent") return aggregateParentCoverageRun(job.data.runId);
  return executeQueuedRun(job.data.runId);
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
  queueMicrotask(() => void executeQueuedRun(runId).finally(() => inProcessJobs.delete(runId)));
}

export function interruptRun(runId: string) {
  activeControllers.get(runId)?.abort();
}

export async function closeRunOrchestrator() {
  await worker?.close();
  await queue?.close();
}
