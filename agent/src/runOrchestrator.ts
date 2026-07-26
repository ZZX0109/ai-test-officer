import { Queue, Worker, type Job } from "bullmq";
import { resolveFinalStatus, type JudgeRecommendation, type MachineGate } from "@ai-test-officer/contracts";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { runVisualGrayTest } from "./testRunner.js";
import type { RunRequest } from "./types.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { acquireExecutionLease } from "./executionLease.js";

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
    judgeMode: input.judgeMode === "llm-assisted" || input.judgeMode === "adaptive" ? input.judgeMode : "deterministic",
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

export async function executeQueuedRun(runId: string) {
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
    const queuedRequest = buildQueuedRunRequest(projection, controller.signal);
    const requestedScenarioId = typeof projection.input.scenarioId === "string" ? projection.input.scenarioId : undefined;
    if (requestedScenarioId && queuedRequest.scenarioId !== requestedScenarioId) {
      return appendSystemRunEvent(runId, "run_blocked", {
        finalStatus: "blocked",
        error: "scenario_handoff_missing",
        requestedScenarioId,
        projectedScenarioId: projection.selectedScenarioId
      });
    }
    if (!queuedRequest.scenarioId) {
      return appendSystemRunEvent(runId, "run_blocked", { finalStatus: "blocked", error: "scenario_handoff_missing" });
    }
    const result = await runVisualGrayTest(queuedRequest);
    await persistExecutionResult(runId, result);
    await appendSystemRunEvent(runId, "evidence_collecting", { resultRunId: result.id });
    const machineGate = machineGateFromResult(result);
    const judgeRecommendation = recommendationFromResult(result);
    await appendSystemRunEvent(runId, "run_judging", { resultRunId: result.id, machineGate, judgeRecommendation });
    const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
    const payload = { resultRunId: result.id, machineGate, judgeRecommendation, finalStatus, outcomeSummary: result.outcomeSummary };
    if (finalStatus === "pass") return appendSystemRunEvent(runId, "run_completed", payload);
    if (finalStatus === "fail") return appendSystemRunEvent(runId, "run_failed", payload);
    if (finalStatus === "blocked") return appendSystemRunEvent(runId, "run_blocked", payload);
    return appendSystemRunEvent(runId, "human_review_requested", payload);
  } catch (error) {
    const current = await runEventStore.get(runId);
    if (current?.state === "paused" || current?.state === "cancelled") return current;
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /runtime_unavailable|permission|environment|command_not_found|health|port|dependency/.test(message);
    return appendSystemRunEvent(runId, blocked ? "run_blocked" : "run_failed", {
      finalStatus: blocked ? "blocked" : "fail",
      error: message
    });
  } finally {
    activeControllers.delete(runId);
    clearInterval(heartbeat);
    await lease.release();
  }
}

async function processJob(job: Job<{ runId: string }>) {
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
