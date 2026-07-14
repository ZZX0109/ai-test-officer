import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { BenchmarkRunRecord, BenchmarkVerdict } from "./benchmark.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const apiUrl = (process.env.AGENT_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const token = process.env.AGENT_API_TOKEN ?? "dev-local-token";
type Lane = "test-command" | "rules-deterministic" | "llm-plan-deterministic-judge" | "rules-plan-llm-judge" | "full-llm";
type Case = { id: string; split: "development" | "blind"; projectId: string; scenarioId: string; category: string; requirement: string; diff: string; risk: string; faultProfile?: string };
type Model = { id: string; credentialIdEnv: string; provider: string; model: string };
const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);

function selectedModels(models: Model[]) {
  const requested = (process.env.BENCHMARK_MODEL_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!requested.length) return models;
  const byId = new Map(models.map((model) => [model.id, model]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`benchmark_model_not_declared:${unknown.join(",")}`);
  return requested.map((id) => byId.get(id)!);
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  if (process.env.AGENT_BEARER_TOKEN) headers.set("authorization", `Bearer ${process.env.AGENT_BEARER_TOKEN}`); else headers.set("x-agent-token", token);
  const response = await fetch(`${apiUrl}${route}`, { ...init, headers });
  if (!response.ok) throw new Error(`benchmark_api_${response.status}:${await response.text()}`);
  return response.json() as Promise<T>;
}

function verdict(value?: string): BenchmarkVerdict {
  if (value === "pass") return "pass";
  if (value === "fail") return "fail";
  return "needs_review";
}

async function preflight(models: Model[]) {
  const failures: string[] = [];
  const credentials = new Map<string, string>();
  for (const model of models) {
    const credentialId = process.env[model.credentialIdEnv];
    if (!credentialId) { failures.push(`${model.id}:credential_env_missing`); continue; }
    credentials.set(model.id, credentialId);
    try {
      const result = await request<{ ok?: boolean; status?: string }>(`/api/credentials/${credentialId}/test`, { method: "POST", body: "{}" });
      if (!(result.ok ?? result.status === "passed")) failures.push(`${model.id}:credential_preflight_failed`);
    } catch { failures.push(`${model.id}:credential_preflight_failed`); }
  }
  return { failures, credentials };
}

async function executeCase(input: { item: Case; projectId: string; appUrl?: string; lane: Lane; model?: Model; credentialId?: string; repetition: number; experimentId: string; promptVersion: string }): Promise<BenchmarkRunRecord> {
  const startedAt = new Date().toISOString();
  const key = `benchmark:${input.experimentId}:${input.item.id}:${input.lane}:${input.model?.id ?? "none"}:${input.repetition}`;
  const plannerMode = input.lane === "llm-plan-deterministic-judge" || input.lane === "full-llm" ? "llm" : "deterministic";
  const judgeMode = input.lane === "rules-plan-llm-judge" || input.lane === "full-llm" ? "llm-assisted" : "deterministic";
  let run = (await request<{ run: { id: string; state: string; version: number; gateStatus?: string } }>("/v1/runs", {
    method: "POST",
    body: JSON.stringify({ organizationId: "benchmark", projectId: input.appUrl ? undefined : input.projectId, actor: "benchmark-runner", idempotencyKey: key, input: { appUrl: input.appUrl ? `${input.appUrl}/?faultProfile=${encodeURIComponent(input.item.faultProfile ?? "")}` : undefined, scenarioId: input.item.scenarioId, requirement: input.item.requirement, diff: input.item.diff, plannerMode, judgeMode, modelProfileId: input.credentialId, experimentId: input.experimentId, repetition: input.repetition, promptVersion: input.promptVersion, faultProfile: input.item.faultProfile, executionMode: "trusted-local", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false } } })
  })).run;
  // A rejected LLM plan deliberately blocks the run.  It is an experiment result,
  // not a transport failure: preserve it and do not issue invalid approval events.
  if (!terminalRunStates.has(run.state)) {
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/plan-approval`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:plan` }) })).run;
  }
  if (!terminalRunStates.has(run.state)) {
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:permission` }) })).run;
  }
  while (!terminalRunStates.has(run.state)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}`)).run;
  }
  const report = (await request<{ report: Record<string, any> }>(`/v1/runs/${run.id}/report`)).report;
  const artifacts = (await request<{ artifacts: Array<Record<string, any>> }>(`/v1/runs/${run.id}/artifacts`)).artifacts;
  const judgeCall = report.judgeReport?.llmCall;
  const plannerCall = report.plannerCall;
  const usageItems = [plannerCall?.usage, judgeCall?.usage].filter(Boolean) as Array<Record<string, number | undefined>>;
  const usage = usageItems.length ? {
    promptTokens: usageItems.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
    completionTokens: usageItems.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
    totalTokens: usageItems.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
    // Poe-compatible providers do not expose reliable pricing.  Unknown must stay
    // unknown rather than becoming a misleading zero-dollar experiment.
    estimatedCostUsd: usageItems.every((item) => typeof item.estimatedCostUsd === "number")
      ? usageItems.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
      : undefined
  } : undefined;
  const final = verdict(run.gateStatus);
  const durationMs = Date.now() - new Date(startedAt).getTime();
  const plannerRejected = plannerMode === "llm" && report.planProvenance?.compilationStatus === "rejected";
  const llmFailed = plannerRejected || (judgeMode === "llm-assisted" && judgeCall && report.judgeReport?.llmStatus !== "passed");
  const hasRuntimeArtifacts = artifacts.some((artifact) => artifact.origin === "runtime-captured");
  return {
    benchmarkId: input.item.id, runId: run.id, experimentId: input.experimentId, split: input.item.split, lane: input.lane, modelProfileId: input.model?.id, repetition: input.repetition,
    status: "completed", startedAt, finishedAt: new Date().toISOString(), requirementCovered: Boolean(report.riskCoverageMatrix?.length), executionSucceeded: hasRuntimeArtifacts, retryCount: Math.max(0, (report.attempts?.length ?? 1) - 1), planExecutable: report.planProvenance?.compilationStatus !== "rejected", planSource: plannerMode,
    deterministic: { verdict: final, evidenceRefs: report.judgeRecommendation?.evidenceRefs ?? report.evidence?.filter((item: any) => item.type === "assertion").map((item: any) => item.id) ?? [], status: "passed", durationMs },
    llm: plannerMode === "llm" || judgeMode === "llm-assisted" ? { verdict: final, evidenceRefs: report.judgeRecommendation?.evidenceRefs ?? [], failureClass: report.failureAttributions?.[0]?.failureClass, status: llmFailed ? "failed" : "passed", fallback: report.judgeReport?.executionMode === "fallback_baseline", usage, durationMs } : undefined,
    evidence: (report.evidence ?? []).map((item: any) => ({ id: item.id, type: item.type })), attribution: { failureClass: report.failureAttributions?.[0]?.failureClass, suspectFiles: report.failureAttributions?.flatMap((entry: any) => entry.topSuspects?.map((suspect: any) => suspect.filePath) ?? []) ?? [], evidenceRefs: report.failureAttributions?.flatMap((entry: any) => entry.evidenceRefs ?? []) ?? [] },
    executionOrigin: "agent-run", gateEligible: artifacts.length > 0 && artifacts.every((artifact) => artifact.origin === "runtime-captured" || artifact.origin === "fixture") && artifacts.some((artifact) => artifact.origin === "runtime-captured"), evidenceQuality: report.evidenceQuality ? { groundedPassedRate: report.evidenceQuality.summary.groundedPassedRate, runtimeArtifactRate: report.evidenceQuality.summary.runtimeArtifactRate, crossAttemptViolations: report.evidenceQuality.summary.crossAttemptViolations } : undefined, agentVersion: "0.3.0", configHash: createHash("sha256").update(JSON.stringify({ item: input.item, lane: input.lane, model: input.model, promptVersion: input.promptVersion })).digest("hex"), targetVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(), artifactsV2: artifacts.map((artifact) => ({ id: artifact.id, type: artifact.kind, origin: artifact.origin, sha256: artifact.integrity.sha256, integrityStatus: "verified" }))
  };
}

export async function runBenchmarkExperiment() {
  if (process.env.BENCHMARK_LABELS_ROOT) throw new Error("benchmark_runner_must_not_receive_label_mount");
  const config = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "experiment.json"), "utf8")) as { repetitions: number; promptVersion: string; models: Model[]; acceptance: Record<string, number> };
  const llmEnabled = process.env.BENCHMARK_SKIP_LLM !== "1";
  const requestedModels = llmEnabled ? selectedModels(config.models) : [];
  const includeBlind = process.env.BENCHMARK_ENABLE_BLIND === "1";
  const includeExtended = process.env.BENCHMARK_EXTENDED === "1";
  const development = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Case[];
  const extended = includeExtended ? JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "extended-cases.json"), "utf8")) as Case[] : [];
  const blind = includeBlind ? JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8")) as Case[] : [];
  const catalogCases = [...development, ...extended, ...blind];
  const requestedCaseIds = (process.env.BENCHMARK_CASE_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const unknownCaseIds = requestedCaseIds.filter((id) => !catalogCases.some((item) => item.id === id));
  if (unknownCaseIds.length) throw new Error(`benchmark_case_not_declared:${unknownCaseIds.join(",")}`);
  const cases = requestedCaseIds.length ? catalogCases.filter((item) => requestedCaseIds.includes(item.id)) : catalogCases;
  const missingChangeContext = cases.filter((item) => !item.diff?.trim()).map((item) => item.id);
  if (missingChangeContext.length) throw new Error(`benchmark_case_diff_missing:${missingChangeContext.join(",")}`);
  const mapping = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<{ logicalProjectId: string; executionProjectId: string; targetUrl?: string }> };
  const projectMap = new Map(mapping.mappings.map((item) => [item.logicalProjectId, item]));
  const experimentId = process.env.BENCHMARK_EXPERIMENT_ID ?? `experiment_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const directory = path.join(rootDir, "reports", "benchmarks", "experiments", experimentId);
  const runsDir = path.join(directory, "runs");
  await mkdir(runsDir, { recursive: true });
  const check = await preflight(requestedModels);
  const runnableModels = requestedModels.filter((model) => check.credentials.has(model.id));
  const allowPartialModels = process.env.BENCHMARK_ALLOW_PARTIAL_MODELS === "1";
  const requestedPlannedRuns = cases.length * (2 + requestedModels.length * config.repetitions * 3);
  const plannedRuns = cases.length * (2 + runnableModels.length * config.repetitions * 3);
  const hardBlocked = llmEnabled && (!runnableModels.length || (check.failures.length > 0 && !allowPartialModels));
  const manifest = { experimentId, createdAt: new Date().toISOString(), split: includeBlind ? "development+blind" : "development", suites: ["core", ...(includeExtended ? ["extended"] : []), ...(includeBlind ? ["blind"] : [])], caseCount: cases.length, plannedRuns, requestedPlannedRuns, repetitions: config.repetitions, promptVersion: config.promptVersion, llmEnabled, models: runnableModels.map((model) => ({ id: model.id, provider: model.provider, model: model.model })), unavailableModels: requestedModels.filter((model) => !check.credentials.has(model.id)).map((model) => ({ id: model.id, provider: model.provider, model: model.model })), status: hardBlocked ? "blocked" : "running", blockers: check.failures, partial: check.failures.length > 0 };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify({ experimentId, status: manifest.status, completedRuns: 0, plannedRuns, blockers: check.failures }, null, 2));
  if (hardBlocked) throw new Error(`benchmark_preflight_blocked:${check.failures.join(",")}`);
  let completedRuns = 0;
  const updateProgress = async () => {
    await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify({ experimentId, status: "awaiting_agent_runs", completedRuns, plannedRuns, requestedPlannedRuns, blockers: check.failures, partial: check.failures.length > 0 }, null, 2));
  };
  for (const item of cases) {
    const target = projectMap.get(item.projectId);
    const projectId = target?.executionProjectId ?? item.projectId;
    const rules = await executeCase({ item, projectId, appUrl: process.env.BENCHMARK_CONTAINER_TARGETS === "1" ? target?.targetUrl : undefined, lane: "rules-deterministic", repetition: 1, experimentId, promptVersion: config.promptVersion });
    await writeFile(path.join(runsDir, `${item.id}.rules-deterministic.none.1.json`), JSON.stringify(rules, null, 2)); completedRuns += 1; await updateProgress();
    const testCommand = await executeCase({ item, projectId, appUrl: process.env.BENCHMARK_CONTAINER_TARGETS === "1" ? target?.targetUrl : undefined, lane: "test-command", repetition: 1, experimentId, promptVersion: config.promptVersion });
    await writeFile(path.join(runsDir, `${item.id}.test-command.none.1.json`), JSON.stringify(testCommand, null, 2)); completedRuns += 1; await updateProgress();
    for (const model of runnableModels) for (let repetition = 1; repetition <= config.repetitions; repetition += 1) for (const lane of ["llm-plan-deterministic-judge", "rules-plan-llm-judge", "full-llm"] as Lane[]) {
      const record = await executeCase({ item, projectId, appUrl: process.env.BENCHMARK_CONTAINER_TARGETS === "1" ? target?.targetUrl : undefined, lane, model, credentialId: check.credentials.get(model.id), repetition, experimentId, promptVersion: config.promptVersion });
      await writeFile(path.join(runsDir, `${item.id}.${lane}.${model.id}.${repetition}.json`), JSON.stringify(record, null, 2)); completedRuns += 1;
      await updateProgress();
    }
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, status: "awaiting_evaluation", completedRuns, finishedAt: new Date().toISOString() }, null, 2));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify({ experimentId, status: "awaiting_evaluation", completedRuns, plannedRuns, requestedPlannedRuns, blockers: check.failures, partial: check.failures.length > 0 }, null, 2));
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) runBenchmarkExperiment().catch((error) => { console.error(error); process.exitCode = 2; });
