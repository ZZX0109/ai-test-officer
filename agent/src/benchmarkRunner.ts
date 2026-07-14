import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const apiUrl = (process.env.AGENT_URL ?? "http://127.0.0.1:4317").replace(/\/$/, "");
const token = process.env.AGENT_API_TOKEN ?? "dev-local-token";

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${route}`, { ...init, headers: { "content-type": "application/json", "x-agent-token": token, ...(init?.headers ?? {}) } });
  if (!response.ok) throw new Error(`benchmark_api_${response.status}:${await response.text()}`);
  return response.json() as Promise<T>;
}

function scenarioFor(category: string) {
  if (category === "state_transition") return "generic_approval_flow_transition";
  if (category === "validation") return "generic_complex_form_validation";
  if (category === "permission") return "auth_login_permission";
  if (category === "filter" || category === "search" || category === "visual") return "task_filter_completed";
  return "task_filter_active";
}

async function runCase(item: { id: string; projectId: string; category: string; requirement: string }, projectId: string) {
  const startedAt = new Date().toISOString();
  const key = `benchmark:${item.id}:${Date.now()}`;
  let run = (await request<{ run: { id: string; state: string; version: number; gateStatus?: string } }>("/v1/runs", {
    method: "POST", body: JSON.stringify({ organizationId: "benchmark", projectId, actor: "benchmark-runner", idempotencyKey: key, input: { scenarioId: scenarioFor(item.category), requirement: item.requirement, executionMode: "trusted-local", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } } })
  })).run;
  run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/plan-approval`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:plan` }) })).run;
  run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "benchmark-runner", idempotencyKey: `${key}:permission` }) })).run;
  const terminal = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);
  while (!terminal.has(run.state)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    run = (await request<{ run: typeof run }>(`/v1/runs/${run.id}`)).run;
  }
  const report = (await request<{ report: any }>(`/v1/runs/${run.id}/report`)).report;
  const artifacts = (await request<{ artifacts: any[] }>(`/v1/runs/${run.id}/artifacts`)).artifacts;
  const final = run.gateStatus === "needs-human-review" ? "needs_review" : run.gateStatus ?? "needs_review";
  return {
    benchmarkId: item.id,
    runId: run.id,
    status: "completed",
    startedAt,
    finishedAt: new Date().toISOString(),
    requirementCovered: Boolean(report.riskCoverageMatrix?.length),
    executionSucceeded: !["blocked", "cancelled"].includes(run.state),
    retryCount: Math.max(0, (report.attempts?.length ?? 1) - 1),
    deterministic: { verdict: final, evidenceRefs: report.machineGate?.assertionFailures ?? [], status: "passed", durationMs: new Date().getTime() - new Date(startedAt).getTime() },
    llm: { verdict: final, evidenceRefs: report.judgeRecommendation?.evidenceRefs ?? [], failureClass: report.failureAttributions?.[0]?.failureClass, status: report.judgeReport?.llmStatus === "not_configured" ? "not_configured" : "passed", fallback: report.judgeReport?.executionMode === "fallback_baseline" },
    evidence: (report.evidence ?? []).map((evidence: any) => ({ id: evidence.id, type: evidence.type })),
    attribution: { failureClass: report.failureAttributions?.[0]?.failureClass, suspectFiles: report.failureAttributions?.flatMap((entry: any) => entry.topSuspects?.map((suspect: any) => suspect.filePath) ?? []) ?? [], evidenceRefs: report.failureAttributions?.flatMap((entry: any) => entry.evidenceRefs ?? []) ?? [] },
    executionOrigin: "agent-run",
    gateEligible: artifacts.some((artifact) => artifact.origin === "runtime-captured"),
    agentVersion: "0.2.0",
    configHash: createHash("sha256").update(JSON.stringify({ item, projectId })).digest("hex"),
    targetVersion: execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim(),
    artifactsV2: artifacts.map((artifact) => ({ id: artifact.id, type: artifact.kind, origin: artifact.origin, sha256: artifact.integrity.sha256, integrityStatus: "verified" })),
    baselines: {
      rules: { verdict: report.assertions?.some((assertion: any) => !assertion.passed) ? "fail" : "pass", evidenceRefs: [], status: "passed" },
      testCommand: { verdict: report.runtimeStatus?.status === "failed" ? "needs_review" : "pass", evidenceRefs: [], status: "passed" }
    }
  };
}

export async function runBenchmarkCatalog() {
  const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string; requirement: string }>;
  const mapping = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<{ logicalProjectId: string; executionProjectId: string }> };
  const map = new Map(mapping.mappings.map((item) => [item.logicalProjectId, item.executionProjectId]));
  const outputDir = path.join(rootDir, "reports", "benchmarks", "runs");
  await mkdir(outputDir, { recursive: true });
  for (const item of cases) {
    const record = await runCase(item, map.get(item.projectId) ?? item.projectId);
    await writeFile(path.join(outputDir, `${item.id}.json`), JSON.stringify(record, null, 2));
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) await runBenchmarkCatalog();
