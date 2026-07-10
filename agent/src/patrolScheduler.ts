import type { GrayPlan, PatrolJob, PatrolRunResult, PermissionProfile, TargetAppRuntime } from "./types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildDeliveryFromRun } from "./botNotifier.js";
import { readRunBundle } from "./evidenceStore.js";
import { runVisualGrayTest } from "./testRunner.js";
import { writePatrolRun } from "./patrolRunStore.js";
import { listRunHistory } from "./runHistory.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const patrolDir = path.join(rootDir, "reports", "patrol-runs");
const planFile = path.join(patrolDir, "plans.json");

interface RunPatrolInput {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  jobId?: string;
  scenarioId?: string;
  credentialId?: string;
  requirement?: string;
  diff?: string;
  plan?: GrayPlan;
  notify?: string[];
  permissionProfile?: PermissionProfile;
}

const timers = new Map<string, ReturnType<typeof setInterval>>();
const jobs = new Map<string, PatrolJob>();

const defaultJob: PatrolJob = {
  id: "core_path_daily",
  title: "核心路径定时巡检",
  appUrl: "http://localhost:6173",
  scenarioId: "task_filter_completed",
  intervalMs: 24 * 60 * 60 * 1000,
  notify: ["oncall"],
  permissionProfile: {
    observe: true,
    browserControl: false,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  },
  status: "stopped",
  retryPolicy: {
    maxRetries: 1,
    backoffMs: 1500
  },
  escalationPolicy: {
    failureThreshold: 2,
    riskTrendThreshold: "regressed",
    notify: ["qa-oncall"]
  },
  consecutiveFailures: 0
};

function loadPersistedJobs() {
  if (!existsSync(planFile)) return [defaultJob];
  try {
    const parsed = JSON.parse(readFileSync(planFile, "utf8")) as PatrolJob[];
    return parsed.length ? parsed : [defaultJob];
  } catch {
    return [defaultJob];
  }
}

async function persistJobs() {
  await mkdir(patrolDir, { recursive: true });
  await writeFile(planFile, JSON.stringify(Array.from(jobs.values()), null, 2));
}

for (const job of loadPersistedJobs()) {
  jobs.set(job.id, job);
}

function nextRunAt(intervalMs: number) {
  return new Date(Date.now() + intervalMs).toISOString();
}

export function listPatrolJobs() {
  return Array.from(jobs.values());
}

export async function listPatrolPlans() {
  try {
    const parsed = JSON.parse(await readFile(planFile, "utf8")) as PatrolJob[];
    return parsed.length ? parsed : listPatrolJobs();
  } catch {
    return listPatrolJobs();
  }
}

export async function runPatrolNow(input: RunPatrolInput) {
  const permissionProfile = input.permissionProfile ?? {
    observe: true,
    browserControl: false,
    workspaceControl: false,
    ideTerminalControl: false,
    systemControl: false
  };
  const job = input.jobId ? jobs.get(input.jobId) : undefined;
  const maxRetries = job?.retryPolicy?.maxRetries ?? 0;
  const backoffMs = job?.retryPolicy?.backoffMs ?? 0;
  let run: Awaited<ReturnType<typeof runVisualGrayTest>> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      run = await runVisualGrayTest({
    appUrl: input.appUrl,
    projectId: input.projectId,
    target: input.target,
    scenarioId: input.scenarioId,
    credentialId: input.credentialId,
    trigger: "patrol",
    requirement: input.requirement,
    diff: input.diff,
    plan: input.plan,
        permissionProfile
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  if (!run) throw lastError instanceof Error ? lastError : new Error("Patrol run failed.");
  const bundle = await readRunBundle(run.id);
  const delivery = await buildDeliveryFromRun({
    bundle,
    channel: "值班群",
    recipients: input.notify
  });
  const patrol: PatrolRunResult = {
    id: `patrol_run_${Date.now()}`,
    createdAt: new Date().toISOString(),
    jobId: input.jobId,
    appUrl: input.appUrl,
    projectId: input.projectId,
    target: input.target,
    scenarioId: input.scenarioId,
    notify: input.notify,
    permissionProfile,
    harnessGaps: [],
    run,
    delivery
  };
  const stored = await writePatrolRun(patrol);
  if (input.jobId) {
    const current = jobs.get(input.jobId);
    if (current) {
      const failed = run.verdict !== "continue";
      jobs.set(input.jobId, {
        ...current,
        lastRunId: run.id,
        lastDeliveryId: delivery.id,
        lastPatrolFile: stored.file,
        consecutiveFailures: failed ? (current.consecutiveFailures ?? 0) + 1 : 0,
        riskTrend: run.scenarioFingerprint ? "stable" : current.riskTrend,
        lastError: failed ? run.summary : undefined
      });
      await persistJobs();
    }
  }
  return {
    run,
    delivery,
    patrol: {
      ...patrol,
      patrolFile: stored.file
    }
  };
}

export function startPatrolJob(input: Partial<PatrolJob>) {
  const current = jobs.get(input.id ?? defaultJob.id) ?? defaultJob;
  const job: PatrolJob = {
    ...current,
    ...input,
    id: input.id ?? current.id,
    title: input.title ?? current.title,
    appUrl: input.appUrl ?? current.appUrl,
    projectId: input.projectId ?? current.projectId,
    target: input.target ?? current.target,
    scenarioId: input.scenarioId ?? current.scenarioId,
    intervalMs: Math.max(10_000, input.intervalMs ?? current.intervalMs),
    cron: input.cron ?? current.cron,
    notify: input.notify?.length ? input.notify : current.notify,
    permissionProfile: input.permissionProfile ?? current.permissionProfile,
    retryPolicy: input.retryPolicy ?? current.retryPolicy ?? { maxRetries: 1, backoffMs: 1500 },
    escalationPolicy: input.escalationPolicy ?? current.escalationPolicy ?? { failureThreshold: 2, riskTrendThreshold: "regressed", notify: current.notify },
    consecutiveFailures: current.consecutiveFailures ?? 0,
    riskTrend: current.riskTrend,
    status: "running",
    nextRunAt: nextRunAt(Math.max(10_000, input.intervalMs ?? current.intervalMs))
  };
  const previous = timers.get(job.id);
  if (previous) clearInterval(previous);
  const timer = setInterval(async () => {
    try {
      const result = await runPatrolNow({
        appUrl: job.appUrl,
        projectId: job.projectId,
        target: job.target,
        jobId: job.id,
        scenarioId: job.scenarioId,
        notify: job.notify,
        permissionProfile: job.permissionProfile
      });
      jobs.set(job.id, {
        ...job,
        status: "running",
        lastRunId: result.run.id,
        lastDeliveryId: result.delivery.id,
        lastPatrolFile: result.patrol.patrolFile,
        lastError: undefined,
        nextRunAt: nextRunAt(job.intervalMs)
      });
    } catch (error) {
      jobs.set(job.id, {
        ...job,
        status: "running",
        lastError: error instanceof Error ? error.message : "巡检失败",
        nextRunAt: nextRunAt(job.intervalMs)
      });
    }
  }, job.intervalMs);
  timer.unref();
  timers.set(job.id, timer);
  jobs.set(job.id, job);
  persistJobs().catch(() => undefined);
  return job;
}

export async function upsertPatrolPlan(input: Partial<PatrolJob>) {
  const current = jobs.get(input.id ?? defaultJob.id) ?? defaultJob;
  const job: PatrolJob = {
    ...current,
    ...input,
    id: input.id ?? current.id,
    title: input.title ?? current.title,
    scenarioId: input.scenarioId ?? current.scenarioId,
    intervalMs: Math.max(10_000, input.intervalMs ?? current.intervalMs),
    notify: input.notify?.length ? input.notify : current.notify,
    permissionProfile: input.permissionProfile ?? current.permissionProfile,
    status: input.status ?? current.status ?? "stopped"
  };
  jobs.set(job.id, job);
  await persistJobs();
  return job;
}

export async function deletePatrolPlan(id: string) {
  const timer = timers.get(id);
  if (timer) clearInterval(timer);
  timers.delete(id);
  const deleted = jobs.delete(id);
  if (!jobs.size) jobs.set(defaultJob.id, defaultJob);
  await persistJobs();
  return deleted;
}

export function stopPatrolJob(id = defaultJob.id) {
  const timer = timers.get(id);
  if (timer) clearInterval(timer);
  timers.delete(id);
  const current = jobs.get(id) ?? defaultJob;
  const stopped: PatrolJob = {
    ...current,
    status: "stopped",
    nextRunAt: undefined
  };
  jobs.set(id, stopped);
  persistJobs().catch(() => undefined);
  return stopped;
}

export async function patrolTrend(input: { projectId?: string; scenarioId?: string }) {
  const runs = (await listRunHistory()).filter((run) =>
    (!input.projectId || run.projectId === input.projectId) &&
    (!input.scenarioId || run.scenarioId === input.scenarioId)
  ).slice(-50);
  const latest = runs.at(-1);
  const failedRuns = runs.filter((run) => run.verdict !== "continue").length;
  const riskTrend = latest?.comparison?.riskTrend ?? (runs.length ? "stable" : "first_run");
  return {
    projectId: input.projectId,
    scenarioId: input.scenarioId,
    totalRuns: runs.length,
    failedRuns,
    latestRunId: latest?.runId,
    latestVerdict: latest?.verdict,
    riskTrend,
    riskIncreased: riskTrend === "regressed" || failedRuns > Math.max(1, runs.length / 2),
    summary: runs.length
      ? `最近 ${runs.length} 次运行，失败 ${failedRuns} 次，趋势=${riskTrend}。`
      : "暂无历史运行，风险趋势不可用。"
  };
}
