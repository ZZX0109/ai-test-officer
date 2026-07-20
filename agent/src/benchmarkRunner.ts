import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { commandSpecSchema } from "@ai-test-officer/contracts";
import type { BenchmarkRunRecord, BenchmarkVerdict } from "./benchmark.js";
import { getProject, toTargetProjectConfig } from "./projectAdapter.js";
import { redactText } from "./redaction.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const apiUrl = (process.env.AGENT_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const token = process.env.AGENT_API_TOKEN ?? "dev-local-token";
type Lane = "test-command" | "rules-deterministic" | "llm-plan-deterministic-judge" | "rules-plan-llm-judge" | "full-llm";
type Case = { id: string; split: "development" | "blind"; projectId: string; scenarioId?: string; requirement: string; diff: string; risk: string; fixtureVariantId?: string };
type Model = { id: string; credentialIdEnv: string; provider: string; model: string };
type ExecutionMapping = { logicalProjectId: string; executionProjectId: string; targetUrl?: string; targetKind?: string };
type FixtureVariantBinding = { fixtureVariantId: string; logicalProjectId: string; executionProjectId: string };
const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);

const scenarioByBenchmarkId: Record<string, string> = {
  "todo-create-valid": "task_create_success",
  "todo-filter-completed": "task_filter_completed",
  "todo-search-keyword": "task_search_keyword",
  "todo-empty-title": "task_create_required_fields",
  "todo-viewer-permission": "todo_visitor_permission",
  "todo-api-failure": "task_api_failure",
  "order-filter-pending": "order_filter_pending",
  "order-approve-pending": "order_approval_transition",
  "order-reject-approved": "order_approval_transition",
  "order-missing-order": "order_api_failure",
  "order-viewer-permission": "order_viewer_permission",
  "order-api-failure": "order_api_failure",
  "todo-requirement-diff": "task_create_required_fields",
  "todo-visual-regression": "visual_regression_basic",
  "todo-pagination-contract": "generic_table_sort_filter_pagination",
  "order-requirement-diff": "order_approval_transition",
  "order-visual-regression": "order_visual_regression",
  "order-openapi-contract": "order_openapi_contract",
  "blind-001": "order_approval_transition",
  "blind-002": "task_api_failure",
  "blind-003": "task_search_keyword",
  "blind-004": "order_viewer_permission",
  "blind-005": "task_filter_completed",
  "blind-006": "task_state_transition"
};

function benchmarkScenario(item: Case) {
  return item.scenarioId ?? scenarioByBenchmarkId[item.id];
}

export function validateBenchmarkProjectMappings(input: {
  development: Array<Pick<Case, "id" | "projectId">>;
  extended: Array<Pick<Case, "id" | "projectId">>;
  blind: Array<Pick<Case, "id" | "projectId">>;
  mappings: ExecutionMapping[];
}) {
  const byLogicalProject = new Map<string, ExecutionMapping>();
  for (const mapping of input.mappings) {
    if (byLogicalProject.has(mapping.logicalProjectId)) throw new Error(`benchmark_mapping_duplicate:${mapping.logicalProjectId}`);
    byLogicalProject.set(mapping.logicalProjectId, mapping);
  }
  const expected = new Map([
    ["todo_lite", { executionProjectId: "local_demo_app", host: "todo-lite", targetKind: "app-under-test" }],
    ["order_portal_lite", { executionProjectId: "order_portal_lite", host: "order-portal-lite", targetKind: "independent-fixture" }],
    ["customer_portal_lite", { executionProjectId: "customer_portal_lite", host: "customer-portal-lite", targetKind: "independent-fixture" }]
  ]);
  for (const [logicalProjectId, requirement] of expected) {
    const mapping = byLogicalProject.get(logicalProjectId);
    if (!mapping || mapping.executionProjectId !== requirement.executionProjectId || mapping.targetKind !== requirement.targetKind || !mapping.targetUrl?.includes(requirement.host)) {
      throw new Error(`benchmark_mapping_invalid:${logicalProjectId}`);
    }
  }
  const assertSuite = (suite: string, cases: Array<Pick<Case, "id" | "projectId">>, allowedProjectIds: string[]) => {
    for (const item of cases) {
      if (!allowedProjectIds.includes(item.projectId)) throw new Error(`benchmark_mapping_suite_project_invalid:${suite}:${item.id}:${item.projectId}`);
      if (!byLogicalProject.has(item.projectId)) throw new Error(`benchmark_mapping_missing:${suite}:${item.projectId}`);
    }
  };
  assertSuite("development", input.development, ["todo_lite", "order_portal_lite"]);
  assertSuite("extended", input.extended, ["customer_portal_lite"]);
  assertSuite("blind", input.blind, ["todo_lite", "order_portal_lite"]);
  return byLogicalProject;
}

/** Opaque fixture IDs are public execution inputs, but their failure semantics stay evaluator-owned. */
export function validateBenchmarkFixtureBindings(input: {
  cases: Array<Pick<Case, "id" | "projectId" | "fixtureVariantId">>;
  mappings: Map<string, ExecutionMapping>;
  variants: FixtureVariantBinding[];
}) {
  const variants = new Map<string, FixtureVariantBinding>();
  for (const variant of input.variants) {
    if (variants.has(variant.fixtureVariantId)) throw new Error(`benchmark_fixture_variant_duplicate:${variant.fixtureVariantId}`);
    variants.set(variant.fixtureVariantId, variant);
  }
  for (const item of input.cases) {
    if (!item.fixtureVariantId) continue;
    const binding = variants.get(item.fixtureVariantId);
    if (!binding) throw new Error(`benchmark_fixture_variant_missing:${item.id}:${item.fixtureVariantId}`);
    const mapping = input.mappings.get(item.projectId);
    if (!mapping || binding.logicalProjectId !== item.projectId || binding.executionProjectId !== mapping.executionProjectId) {
      throw new Error(`benchmark_fixture_variant_project_mismatch:${item.id}:${item.fixtureVariantId}`);
    }
  }
}

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
  const response = await fetch(`${apiUrl}${route}`, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`benchmark_api_${response.status}:${await response.text()}`);
  return response.json() as Promise<T>;
}

function verdict(value?: string): BenchmarkVerdict {
  if (value === "pass") return "pass";
  if (value === "fail") return "fail";
  return "needs_review";
}

function finalStatus(value?: string): BenchmarkRunRecord["finalStatus"] {
  if (value === "pass" || value === "fail" || value === "blocked" || value === "needs-human-review") return value;
  return undefined;
}

export function assessPlannerOutcome(plannerMode: "deterministic" | "llm", provenance?: {
  source?: string;
  compilationStatus?: string;
  model?: string;
  llmCallId?: string;
}) {
  const planExecutable = plannerMode === "llm"
    ? provenance?.source === "llm"
      && provenance.compilationStatus === "validated"
      && Boolean(provenance.model)
      && Boolean(provenance.llmCallId)
    : provenance?.compilationStatus !== "rejected";
  return { planExecutable, plannerFailed: plannerMode === "llm" && !planExecutable };
}

/** Keep scheduling, execution, coverage and formal-gate facts separate in every lane. */
export function deriveBenchmarkExecutionSignals(report: Record<string, any>, artifacts: Array<Record<string, any>>) {
  const riskCoverage = Array.isArray(report.riskCoverageMatrix) ? report.riskCoverageMatrix : [];
  const requirementCovered = riskCoverage.length > 0 && riskCoverage.every((risk: any) => risk?.covered === true);
  const requirementPassed = requirementCovered && riskCoverage.every((risk: any) => risk?.passed === true);
  const hasRuntimeArtifacts = artifacts.some((artifact) => artifact.origin === "runtime-captured");
  const hasExecutedAssertion = Array.isArray(report.assertions) && report.assertions.length > 0;
  const metadataIntegrityVerified = Boolean(report.artifactIntegrity?.items?.length)
    && report.artifactIntegrity.items.every((item: any) => item.status === "present" || item.status === "self_reference");
  const artifactsAreFormal = artifacts.length > 0
    && artifacts.every((artifact) => (artifact.origin === "runtime-captured" || artifact.origin === "fixture")
      && artifact.integrity?.sha256
      && artifact.integrity?.sizeBytes !== undefined);
  const evidenceGrounded = Array.isArray(report.evidenceQuality?.assertions)
    && report.evidenceQuality.assertions.length > 0
    && report.evidenceQuality.assertions.every((item: any) => item.status === "grounded")
    && report.evidenceQuality?.summary?.crossAttemptViolations === 0;
  const artifactIntegrityVerified = metadataIntegrityVerified && artifactsAreFormal;
  const executionStarted = Boolean(report.attempts?.length || hasRuntimeArtifacts);
  const executionSucceeded = executionStarted && hasRuntimeArtifacts && hasExecutedAssertion && !report.executionError;
  return {
    executionStarted,
    requirementCovered,
    requirementPassed,
    executionSucceeded,
    artifactIntegrityVerified,
    evidenceGrounded,
    gateEligible: executionSucceeded && requirementCovered && artifactIntegrityVerified && evidenceGrounded
  };
}

async function executeTestCommandCase(input: { item: Case; projectId: string; experimentId: string; artifactRoot: string; promptVersion: string; repetition: number }): Promise<BenchmarkRunRecord> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const project = await getProject(input.projectId);
  if (!project) throw new Error(`benchmark_project_not_found:${input.projectId}`);
  const target = toTargetProjectConfig(project);
  const command = commandSpecSchema.parse(project.testCommandSpec ?? project.manifest?.commands.test);
  if (project.manifest && !project.manifest.commandAllowlist.includes(command.executable)) throw new Error(`benchmark_test_command_not_allowed:${command.executable}`);
  const runId = `baseline_${randomUUID()}`;
  const attemptId = `${runId}_attempt_1`;
  const scenarioId = "test-command-baseline";
  const timeoutMs = command.timeoutMs ?? Math.min(project.timeoutMs ?? 120_000, 1_200_000);
  const output = await new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; launchError?: string }>((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: target.rootDir,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...Object.fromEntries(Object.entries(project.env ?? {}).filter(([, value]) => value !== "[REDACTED]")) }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: unknown) => redactText(`${current}${String(chunk)}`).slice(-5 * 1024 * 1024);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (result: { exitCode: number | null; timedOut: boolean; launchError?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* process already exited */ }
      }
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => finish({ exitCode: null, timedOut: false, launchError: error.message }));
    child.once("exit", (code) => finish({ exitCode: code, timedOut: false }));
  });
  const finishedAt = new Date().toISOString();
  const log = JSON.stringify({ schemaVersion: "ai-test-officer.command-baseline.v1", runId, experimentId: input.experimentId, benchmarkId: input.item.id, command: { executable: command.executable, args: command.args }, startedAt, finishedAt, timeoutMs, exitCode: output.exitCode, timedOut: output.timedOut, launchError: output.launchError, stdout: output.stdout, stderr: output.stderr }, null, 2);
  await mkdir(input.artifactRoot, { recursive: true });
  const artifactId = `${runId}_command_log`;
  const artifactFile = path.join(input.artifactRoot, `${input.item.id}.${runId}.json`);
  const temporaryFile = `${artifactFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, log, { mode: 0o600 });
  const sha256 = createHash("sha256").update(log).digest("hex");
  await rename(temporaryFile, artifactFile);
  const evidenceId = `${runId}_command_result`;
  const commandCompleted = output.exitCode === 0 && !output.timedOut && !output.launchError;
  // A test command has no requirement-to-oracle chain or browser evidence. It
  // is a useful baseline, but must never satisfy the formal quality gate.
  const baselineBlocked = output.timedOut || Boolean(output.launchError);
  const verdict: BenchmarkVerdict = "needs_review";
  const durationMs = Date.now() - startedMs;
  return {
    benchmarkId: input.item.id,
    runId,
    experimentId: input.experimentId,
    split: input.item.split,
    lane: "test-command",
    repetition: input.repetition,
    status: "completed",
    startedAt,
    finishedAt,
    outcomeSchemaVersion: "2.0",
    executionStarted: true,
    requirementCovered: false,
    requirementPassed: false,
    executionSucceeded: !output.launchError && !output.timedOut,
    retryCount: 0,
    planExecutable: true,
    planSource: "deterministic",
    finalStatus: baselineBlocked ? "blocked" : "needs-human-review",
    planProvenance: { source: "deterministic", promptVersion: input.promptVersion, compilationStatus: "not-required" },
    attempts: [{ id: attemptId, runId, scenarioId, attempt: 1, status: commandCompleted ? "passed" : "failed" }],
    deterministic: { verdict, evidenceRefs: [evidenceId], status: "passed", durationMs },
    evidence: [{ id: evidenceId, type: "operation-log" }],
    attribution: { failureClass: baselineBlocked ? "environment_issue" : "insufficient_evidence", evidenceRefs: [evidenceId], suspectFiles: [] },
    executionOrigin: "command-baseline",
    gateEligible: false,
    artifactIntegrityVerified: false,
    evidenceQuality: { groundedPassedRate: 0, runtimeArtifactRate: 0, crossAttemptViolations: 0 },
    agentVersion: "0.3.0",
    configHash: createHash("sha256").update(JSON.stringify({ item: input.item, lane: "test-command", command, promptVersion: input.promptVersion })).digest("hex"),
    targetVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    artifactsV2: [{ id: artifactId, type: "operation-log", origin: "runtime-captured", sha256, integrityStatus: "verified", runId, scenarioId, stepId: "execute-test-command", attemptId, attempt: 1, capturedAt: finishedAt, sizeBytes: Buffer.byteLength(log), mediaType: "application/json", storageUri: `benchmark://experiments/${input.experimentId}/command-artifacts/${path.basename(artifactFile)}` }]
  };
}

async function preflight(models: Model[]) {
  const failures: string[] = [];
  const credentials = new Map<string, string>();
  const listed = await request<{ credentials: Array<{ id: string; provider: string; model: string }> }>("/api/credentials").catch(() => ({ credentials: [] }));
  const credentialsById = new Map(listed.credentials.map((credential) => [credential.id, credential]));
  for (const model of models) {
    const credentialId = process.env[model.credentialIdEnv];
    if (!credentialId) { failures.push(`${model.id}:credential_env_missing`); continue; }
    const credential = credentialsById.get(credentialId);
    if (!credential) { failures.push(`${model.id}:credential_not_found`); continue; }
    if (credential.provider !== model.provider || credential.model !== model.model) {
      failures.push(`${model.id}:credential_profile_mismatch`);
      continue;
    }
    try {
      const result = await request<{ ok?: boolean; status?: string; structuredOutput?: boolean }>(`/api/credentials/${credentialId}/test`, { method: "POST", body: JSON.stringify({ mode: "structured" }) });
      if (!(result.ok ?? result.status === "passed") || result.structuredOutput !== true) failures.push(`${model.id}:structured_output_preflight_failed`);
      else credentials.set(model.id, credentialId);
    } catch { failures.push(`${model.id}:credential_preflight_failed`); }
  }
  return { failures, credentials };
}

async function executeCase(input: { item: Case; projectId: string; appUrl?: string; lane: Lane; model?: Model; credentialId?: string; repetition: number; experimentId: string; promptVersion: string }): Promise<BenchmarkRunRecord> {
  const startedAt = new Date().toISOString();
  const key = `benchmark:${input.experimentId}:${input.item.id}:${input.lane}:${input.model?.id ?? "none"}:${input.repetition}`;
  const plannerMode = input.lane === "llm-plan-deterministic-judge" || input.lane === "full-llm" ? "llm" : "deterministic";
  // Judge lanes remain LLM-assisted, but the runtime only invokes the model when
  // deterministic evidence actually conflicts. Normal, fully-grounded passes do
  // not spend model budget or become provider-failure samples.
  const judgeMode = input.lane === "rules-plan-llm-judge" || input.lane === "full-llm" ? "adaptive" : "deterministic";
  let run = (await request<{ run: { id: string; state: string; version: number; gateStatus?: string; selectedScenarioId?: string } }>("/v1/runs", {
    method: "POST",
    body: JSON.stringify({ organizationId: "benchmark", projectId: input.projectId, actor: "benchmark-runner", idempotencyKey: key, input: { appUrl: input.appUrl ? `${input.appUrl}/?fixtureVariantId=${encodeURIComponent(input.item.fixtureVariantId ?? "")}` : undefined, scenarioId: benchmarkScenario(input.item), requirement: input.item.requirement, diff: input.item.diff, plannerMode, judgeMode, modelProfileId: input.credentialId, experimentId: input.experimentId, repetition: input.repetition, promptVersion: input.promptVersion, cachePolicy: "bypass", llmBudget: { maxPlannerCalls: 2, maxJudgeCalls: 2, maxTotalTokens: 12000, plannerMaxOutputTokens: 2500, judgeMaxOutputTokens: 2000, requestTimeoutMs: 30000, totalTimeoutMs: 90000 }, fixtureVariantId: input.item.fixtureVariantId, executionMode: "trusted-local", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false } } })
  })).run;
  // A rejected LLM plan deliberately blocks the run.  It is an experiment result,
  // not a transport failure: preserve it and do not issue invalid approval events.
  if (!terminalRunStates.has(run.state)) {
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/plan-approval`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:plan` }) })).run;
  }
  if (!terminalRunStates.has(run.state)) {
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:permission` }) })).run;
  }
  const runDeadline = Date.now() + Number(process.env.BENCHMARK_RUN_TIMEOUT_MS ?? 20 * 60_000);
  while (!terminalRunStates.has(run.state)) {
    if (Date.now() >= runDeadline) throw new Error(`benchmark_run_timeout:${run.id}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}`)).run;
  }
  const projection = run;
  const requestedScenarioId = benchmarkScenario(input.item);
  const report = (await request<{ report: Record<string, any> }>(`/v1/runs/${run.id}/report`)).report;
  const artifacts = (await request<{ artifacts: Array<Record<string, any>> }>(`/v1/runs/${run.id}/artifacts`)).artifacts;
  const judgeCall = report.judgeReport?.llmCall;
  const judgeCalls = Array.isArray(report.judgeReport?.llmCalls) && report.judgeReport.llmCalls.length ? report.judgeReport.llmCalls : judgeCall ? [judgeCall] : [];
  const plannerCall = report.plannerCall;
  const plannerCalls = Array.isArray(report.plannerCalls) && report.plannerCalls.length ? report.plannerCalls : plannerCall ? [plannerCall] : [];
  const usageItems = [...plannerCalls.map((call: any) => call.usage), ...judgeCalls.map((call: any) => call.usage)].filter(Boolean) as Array<Record<string, number | undefined>>;
  const usage = usageItems.length ? {
    promptTokens: usageItems.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
    completionTokens: usageItems.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
    totalTokens: usageItems.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
    // OpenAI-compatible providers do not expose reliable pricing. Unknown must stay
    // unknown rather than becoming a misleading zero-dollar experiment.
    estimatedCostUsd: usageItems.every((item) => typeof item.estimatedCostUsd === "number")
      ? usageItems.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0)
      : undefined
  } : undefined;
  const final = verdict(run.gateStatus);
  const deterministicVerdict = verdict(report.judgeReport?.releaseJudge?.verdict ?? report.machineGate?.status ?? run.gateStatus);
  const modelRecommendation = report.judgeReport?.modelRecommendation;
  const judgeRoutedToLlm = report.judgeRouting?.route === "llm";
  const llmVerdict = judgeRoutedToLlm ? verdict(modelRecommendation?.verdict) : deterministicVerdict;
  const deterministicEvidenceRefs = report.judgeReport?.releaseJudge?.findings?.flatMap((finding: any) => finding.evidenceRefs ?? [])
    ?? report.evidence?.filter((item: any) => item.type === "assertion").map((item: any) => item.id)
    ?? [];
  const durationMs = Date.now() - new Date(startedAt).getTime();
  const plannerOutcome = assessPlannerOutcome(plannerMode, report.planProvenance);
  const llmFailed = plannerOutcome.plannerFailed || (plannerMode === "llm" && !plannerCall) || (judgeRoutedToLlm && (!judgeCall || report.judgeReport?.llmStatus !== "passed" || report.judgeReport?.executionMode === "fallback_baseline"));
  const execution = deriveBenchmarkExecutionSignals(report, artifacts);
  return {
    benchmarkId: input.item.id, runId: run.id, experimentId: input.experimentId, split: input.item.split, lane: input.lane, modelProfileId: input.model?.id, repetition: input.repetition,
    status: "completed", startedAt, finishedAt: new Date().toISOString(), outcomeSchemaVersion: "2.0", executionStarted: execution.executionStarted, requirementCovered: execution.requirementCovered, requirementPassed: execution.requirementPassed, executionSucceeded: execution.executionSucceeded, retryCount: Math.max(0, (report.attempts?.length ?? 1) - 1), planExecutable: plannerOutcome.planExecutable, planSource: plannerMode,
    requestedScenarioId, projectedScenarioId: projection.selectedScenarioId,
    executedScenarioId: report.attempts?.[0]?.scenarioId ?? artifacts[0]?.scenarioId,
    selectedScenarioId: report.attempts?.[0]?.scenarioId ?? artifacts[0]?.scenarioId, failedStepId: report.executionError?.stepId, executionErrorCode: report.executionError?.code, finalStatus: finalStatus(run.gateStatus),
    planProvenance: report.planProvenance,
    attempts: (report.attempts ?? []).map((attempt: any) => ({ id: attempt.id, runId: attempt.runId, scenarioId: attempt.scenarioId, attempt: attempt.attempt, status: attempt.status })),
    llmCalls: [...plannerCalls.map((call: any) => ({ id: call.id, runId: call.runId, experimentId: call.experimentId, purpose: "planning" as const, provider: call.provider, model: call.model, requestId: call.requestId, status: call.status, errorCode: call.errorCode, durationMs: call.durationMs, usage: call.usage, transportMode: call.transportMode, fallbackReason: call.fallbackReason, transportAttempts: call.transportAttempts })), ...judgeCalls.map((call: any) => ({ id: call.id, runId: call.runId, experimentId: call.experimentId, purpose: "judging" as const, provider: call.provider, model: call.model, requestId: call.requestId, status: call.status, errorCode: call.errorCode, durationMs: call.durationMs, usage: call.usage, transportMode: call.transportMode, fallbackReason: call.fallbackReason, transportAttempts: call.transportAttempts }))],
    deterministic: { verdict: deterministicVerdict, evidenceRefs: deterministicEvidenceRefs, status: "passed", durationMs },
    llm: plannerMode === "llm" || judgeMode === "adaptive" ? { verdict: llmVerdict, evidenceRefs: judgeRoutedToLlm ? modelRecommendation?.evidenceRefs ?? [] : deterministicEvidenceRefs, failureClass: judgeRoutedToLlm ? modelRecommendation?.failureClass : report.failureAttributions?.[0]?.failureClass, status: llmFailed ? "failed" : "passed", fallback: judgeRoutedToLlm && report.judgeReport?.executionMode === "fallback_baseline", usage, durationMs } : undefined,
    evidence: (report.evidence ?? []).map((item: any) => ({ id: item.id, type: item.type })), attribution: { failureClass: report.failureAttributions?.[0]?.failureClass, suspectFiles: report.failureAttributions?.flatMap((entry: any) => entry.topSuspects?.map((suspect: any) => suspect.filePath) ?? []) ?? [], evidenceRefs: report.failureAttributions?.flatMap((entry: any) => entry.evidenceRefs ?? []) ?? [] },
    executionOrigin: "agent-run", gateEligible: execution.gateEligible, artifactIntegrityVerified: execution.artifactIntegrityVerified, evidenceGrounded: execution.evidenceGrounded, evidenceQuality: report.evidenceQuality ? { groundedPassedRate: report.evidenceQuality.summary.groundedPassedRate, runtimeArtifactRate: report.evidenceQuality.summary.runtimeArtifactRate, crossAttemptViolations: report.evidenceQuality.summary.crossAttemptViolations } : undefined, agentVersion: "0.3.0", configHash: createHash("sha256").update(JSON.stringify({ item: input.item, lane: input.lane, model: input.model, promptVersion: input.promptVersion })).digest("hex"), targetVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(), artifactsV2: artifacts.map((artifact) => ({ id: artifact.id, type: artifact.kind, origin: artifact.origin, sha256: artifact.integrity.sha256, integrityStatus: "verified", runId: artifact.runId, scenarioId: artifact.scenarioId, stepId: artifact.stepId, attemptId: artifact.attemptId, attempt: artifact.attempt, capturedAt: artifact.integrity.capturedAt, sizeBytes: artifact.integrity.sizeBytes, mediaType: artifact.integrity.mediaType, storageUri: artifact.storageUri }))
  };
}

export async function runBenchmarkExperiment() {
  if (process.env.BENCHMARK_LABELS_ROOT) throw new Error("benchmark_runner_must_not_receive_label_mount");
  const config = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "experiment.json"), "utf8")) as { repetitions: number; promptVersion: string; models: Model[]; acceptance: Record<string, number> };
  const repetitions = Number(process.env.BENCHMARK_REPETITIONS ?? config.repetitions);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > config.repetitions) {
    throw new Error(`benchmark_repetitions_invalid:${process.env.BENCHMARK_REPETITIONS ?? config.repetitions}`);
  }
  const llmEnabled = process.env.BENCHMARK_SKIP_LLM !== "1";
  const requestedModels = llmEnabled ? selectedModels(config.models) : [];
  const requestedSplit = process.env.BENCHMARK_SPLIT ?? (process.env.BENCHMARK_ENABLE_BLIND === "1" ? "development+blind" : "development");
  if (!['development', 'blind', 'development+blind'].includes(requestedSplit)) {
    throw new Error(`benchmark_split_invalid:${requestedSplit}`);
  }
  const includeDevelopment = requestedSplit !== "blind";
  const includeBlind = requestedSplit !== "development";
  const includeExtended = process.env.BENCHMARK_EXTENDED === "1";
  const development = includeDevelopment ? JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Case[] : [];
  const extended = includeDevelopment && includeExtended ? JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "extended-cases.json"), "utf8")) as Case[] : [];
  const blind = includeBlind ? JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8")) as Case[] : [];
  let developmentGate: { experimentId: string; readyForBlind: boolean } | undefined;
  if (requestedSplit === "blind") {
    const developmentExperimentId = process.env.BENCHMARK_DEVELOPMENT_EXPERIMENT_ID;
    if (!developmentExperimentId) throw new Error("benchmark_blind_requires_development_experiment");
    const evaluation = JSON.parse(await readFile(path.join(rootDir, "reports", "benchmarks", "experiments", developmentExperimentId, "evaluation.json"), "utf8")) as {
      experimentId: string;
      evaluations?: Array<{ split?: string; acceptance?: { readyForBlind?: boolean } }>;
    };
    const readyForBlind = evaluation.evaluations?.find((item) => item.split === "development")?.acceptance?.readyForBlind === true;
    developmentGate = { experimentId: developmentExperimentId, readyForBlind };
    if (!readyForBlind) throw new Error(`benchmark_blind_development_gate_failed:${developmentExperimentId}`);
  }
  const catalogCases = [...development, ...extended, ...blind];
  const requestedCaseIds = (process.env.BENCHMARK_CASE_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const unknownCaseIds = requestedCaseIds.filter((id) => !catalogCases.some((item) => item.id === id));
  if (unknownCaseIds.length) throw new Error(`benchmark_case_not_declared:${unknownCaseIds.join(",")}`);
  const cases = requestedCaseIds.length ? catalogCases.filter((item) => requestedCaseIds.includes(item.id)) : catalogCases;
  const missingChangeContext = cases.filter((item) => !item.diff?.trim()).map((item) => item.id);
  if (missingChangeContext.length) throw new Error(`benchmark_case_diff_missing:${missingChangeContext.join(",")}`);
  const mapping = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: ExecutionMapping[] };
  const projectMap = validateBenchmarkProjectMappings({ development, extended, blind, mappings: mapping.mappings });
  const fixtureManifest = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "fixture-variants.json"), "utf8")) as { variants: FixtureVariantBinding[] };
  validateBenchmarkFixtureBindings({ cases: [...development, ...extended, ...blind], mappings: projectMap, variants: fixtureManifest.variants });
  const experimentId = process.env.BENCHMARK_EXPERIMENT_ID ?? `experiment_${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const directory = path.join(rootDir, "reports", "benchmarks", "experiments", experimentId);
  const runsDir = path.join(directory, "runs");
  await mkdir(runsDir, { recursive: true });
  const check = await preflight(requestedModels);
  const runnableModels = requestedModels.filter((model) => check.credentials.has(model.id));
  const allowPartialModels = process.env.BENCHMARK_ALLOW_PARTIAL_MODELS === "1";
  const requestedPlannedRuns = cases.length * repetitions * (2 + requestedModels.length * 3);
  const plannedRuns = cases.length * repetitions * (2 + runnableModels.length * 3);
  const hardBlocked = llmEnabled && (!runnableModels.length || (check.failures.length > 0 && !allowPartialModels));
  const manifest = { experimentId, createdAt: new Date().toISOString(), split: requestedSplit, suites: [...(includeDevelopment ? ["core"] : []), ...(includeExtended ? ["extended"] : []), ...(includeBlind ? ["blind"] : [])], caseCount: cases.length, caseIds: cases.map((item) => item.id), plannedRuns, requestedPlannedRuns, repetitions, promptVersion: config.promptVersion, llmEnabled, models: runnableModels.map((model) => ({ id: model.id, provider: model.provider, model: model.model })), unavailableModels: requestedModels.filter((model) => !check.credentials.has(model.id)).map((model) => ({ id: model.id, provider: model.provider, model: model.model })), developmentGate, status: hardBlocked ? "blocked" : "running", blockers: check.failures, partial: check.failures.length > 0 };
  const existingManifestFile = path.join(directory, "manifest.json");
  let existingManifest: any;
  try { existingManifest = JSON.parse(await readFile(existingManifestFile, "utf8")); } catch { /* first run */ }
  if (existingManifest) {
    if (process.env.BENCHMARK_RESUME !== "1") throw new Error(`benchmark_experiment_already_exists:${experimentId}`);
    const sameDefinition = existingManifest.plannedRuns === manifest.plannedRuns
      && existingManifest.promptVersion === manifest.promptVersion
      && JSON.stringify(existingManifest.models?.map((item: any) => item.id) ?? []) === JSON.stringify(manifest.models.map((item) => item.id))
      && (existingManifest.caseIds ? JSON.stringify(existingManifest.caseIds) === JSON.stringify(manifest.caseIds) : existingManifest.caseCount === manifest.caseCount);
    if (!sameDefinition) throw new Error(`benchmark_resume_definition_mismatch:${experimentId}`);
  }
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
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const rules = await executeCase({ item, projectId, appUrl: process.env.BENCHMARK_CONTAINER_TARGETS === "1" ? target?.targetUrl : undefined, lane: "rules-deterministic", repetition, experimentId, promptVersion: config.promptVersion });
      await writeFile(path.join(runsDir, `${item.id}.rules-deterministic.none.${repetition}.json`), JSON.stringify(rules, null, 2)); completedRuns += 1; await updateProgress();
      const testCommand = await executeTestCommandCase({ item, projectId, experimentId, artifactRoot: path.join(directory, "command-artifacts"), promptVersion: config.promptVersion, repetition });
      await writeFile(path.join(runsDir, `${item.id}.test-command.none.${repetition}.json`), JSON.stringify(testCommand, null, 2)); completedRuns += 1; await updateProgress();
    }
    for (const model of runnableModels) for (let repetition = 1; repetition <= repetitions; repetition += 1) for (const lane of ["llm-plan-deterministic-judge", "rules-plan-llm-judge", "full-llm"] as Lane[]) {
      const record = await executeCase({ item, projectId, appUrl: process.env.BENCHMARK_CONTAINER_TARGETS === "1" ? target?.targetUrl : undefined, lane, model, credentialId: check.credentials.get(model.id), repetition, experimentId, promptVersion: config.promptVersion });
      await writeFile(path.join(runsDir, `${item.id}.${lane}.${model.id}.${repetition}.json`), JSON.stringify(record, null, 2)); completedRuns += 1;
      await updateProgress();
    }
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, status: "awaiting_evaluation", completedRuns, finishedAt: new Date().toISOString() }, null, 2));
  await writeFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), JSON.stringify({ experimentId, status: "awaiting_evaluation", completedRuns, plannedRuns, requestedPlannedRuns, blockers: check.failures, partial: check.failures.length > 0 }, null, 2));
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) runBenchmarkExperiment().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 2;
});
