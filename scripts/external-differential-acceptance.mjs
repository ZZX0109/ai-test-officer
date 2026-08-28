// Submit and collect one real Base/Head DifferentialRun per locked external
// project. This script is deliberately a client of the Agent API: the Agent
// remains the only execution engine and the output is written outside the
// repository for the independent evaluator.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const agentUrl = process.env.ATO_AGENT_URL ?? "http://127.0.0.1:4317";
const token = process.env.ATO_AGENT_TOKEN ?? "dev-local-token";
const outputRoot = process.env.EXTERNAL_DIFFERENTIAL_REPORTS_ROOT?.trim();
const pollMs = Number(process.env.EXTERNAL_DIFFERENTIAL_POLL_MS ?? 5_000);
const timeoutMs = Number(process.env.EXTERNAL_DIFFERENTIAL_TIMEOUT_MS ?? 45 * 60_000);
const registryProjectIds = process.env.EXTERNAL_DIFFERENTIAL_PROJECT_REGISTRY_IDS
  ? JSON.parse(process.env.EXTERNAL_DIFFERENTIAL_PROJECT_REGISTRY_IDS)
  : {};

if (!outputRoot) throw new Error("EXTERNAL_DIFFERENTIAL_REPORTS_ROOT is required and must be outside the repository");
const resolvedOutputRoot = path.resolve(outputRoot);
const relativeOutput = path.relative(rootDir, resolvedOutputRoot);
if (!relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) throw new Error("EXTERNAL_DIFFERENTIAL_REPORTS_ROOT must be outside the repository");

const lock = JSON.parse(await readFile(path.join(rootDir, "acceptance-projects.lock.json"), "utf8"));
const attempt = process.env.EXTERNAL_DIFFERENTIAL_ATTEMPT?.trim() || "1";

function safeName(value) { return value.replace(/[^a-zA-Z0-9_-]+/g, "-"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function revisionFor(project, side) {
  const key = `EXTERNAL_DIFFERENTIAL_${side.toUpperCase()}_${safeName(project.id).toUpperCase().replaceAll("-", "_")}`;
  return process.env[key] ?? (side === "base" ? project.revision : undefined);
}
function registryProjectId(project) {
  const mapped = registryProjectIds[project.id];
  return typeof mapped === "string" && mapped.trim() ? mapped.trim() : project.id;
}
async function api(pathname, options = {}) {
  const response = await fetch(`${agentUrl}${pathname}`, {
    ...options,
    headers: { "x-agent-token": token, "Content-Type": "application/json", ...(options.headers ?? {}) }
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`external_differential_api_${response.status}:${JSON.stringify(body).slice(0, 500)}`);
  return body;
}
function requestFor(project, baseRevision, headRevision, registeredProjectId) {
  const now = new Date().toISOString();
  const plan = { schemaVersion: "external-differential-plan.v1", projectId: registeredProjectId, coverageItem: "locked-external-acceptance" };
  const dataContractId = `tdc_external_${safeName(registeredProjectId)}`;
  const oracleId = `oracle_external_${safeName(registeredProjectId)}`;
  const contract = {
    schemaVersion: "1.0", id: dataContractId, projectId: registeredProjectId,
    coverageItemIds: ["locked-external-acceptance"],
    dataSources: [{ id: "external-observation", kind: "http-snapshot", readOnly: true }],
    credentialRefs: [], namespace: { strategy: "run-child-seed", prefix: "ato" },
    randomSeed: 20260826, testTime: now, roles: [],
    stages: ["prepare", "namespace", "migrate", "seed", "snapshot", "execute", "cleanup", "rollback", "verify-clean"].map((stage) => ({ stage, required: stage !== "rollback" })),
    createdAt: now, updatedAt: now
  };
  const oracle = {
    schemaVersion: "2.0", id: oracleId, projectId: registeredProjectId, coverageItemId: "locked-external-acceptance",
    type: "custom", description: "External project differential command completes", preconditions: [],
    observationWindow: { start: "after-action", timeoutMs: 20_000, pollIntervalMs: 500 },
    comparison: { operator: "equals", expected: true },
    source: { kind: "formal-contract", id: `acceptance-lock:${project.id}`, version: "1.0", sha256: sha256(JSON.stringify(project)) },
    decisionUse: "release", conflictRefs: [], humanConfirmation: { status: "not-required" },
    lifecycle: { status: "active" },
    runEvidence: { runId: `external-source-manifest:${project.id}`, evidenceRefs: [`acceptance-lock:${project.id}`], artifactIds: [] },
    createdAt: now, updatedAt: now
  };
  return {
    schemaVersion: "1.0", organizationId: "local", projectId: registeredProjectId,
    baseRevision, headRevision, plan, dataContractId, dataContract: contract,
    oracleSpecIds: [oracleId], oracleSpecs: [oracle],
    environmentHash: sha256(JSON.stringify({ projectId: project.id, plan, contract })),
    randomSeed: contract.randomSeed, testTime: now,
    idempotencyKey: `external-differential:${project.id}:${baseRevision}:${headRevision}:attempt-${attempt}`
  };
}
async function waitForDifferential(id) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await api(`/v1/differential-runs/${encodeURIComponent(id)}`);
    const run = body.differentialRun ?? body;
    if (["completed", "blocked", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`external_differential_timeout:${id}`);
}

await mkdir(resolvedOutputRoot, { recursive: true });
for (const project of lock.projects) {
  const baseRevision = revisionFor(project, "base");
  const headRevision = revisionFor(project, "head");
  const registeredProjectId = registryProjectId(project);
  if (!baseRevision || !headRevision) throw new Error(`base_and_head_revisions_required:${project.id}`);
  const createdBody = await api("/v1/differential-runs", { method: "POST", body: JSON.stringify(requestFor(project, baseRevision, headRevision, registeredProjectId)) });
  const created = createdBody.differentialRun ?? createdBody;
  const result = await waitForDifferential(created.id);
  await writeFile(path.join(resolvedOutputRoot, `${project.id}.json`), JSON.stringify({
    schemaVersion: "external-differential-acceptance.v1",
    projectId: project.id, registryProjectId: registeredProjectId, repository: project.repository, framework: project.framework,
    baseRevision, headRevision, differentialRunId: result.id,
    pairManifest: result.pairManifest, base: result.base, head: result.head,
    collectedAt: new Date().toISOString()
  }, null, 2));
  console.log(`${project.id}: ${result.status} classification=${result.pairManifest?.classification ?? "inconclusive"}`);
}
