import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { Pool } from "pg";
import {
  artifactV2Schema,
  commandSpecSchema,
  repairExportSchema,
  repairFileChangeSchema,
  repairSessionSchema,
  repairValidationSchema,
  type ArtifactV2,
  type RepairExport,
  type RepairFileChange,
  type RepairSession
} from "@ai-test-officer/contracts";
import { AttemptClock, commitCapturedFile } from "@ai-test-officer/playwright-runtime";
import { buildOciInvocation, runAllowlistedCommand } from "@ai-test-officer/execution-worker";
import type { ArtifactIntegrityReport, LayeredJudgeReport, ProjectConfig, RunBundle, VisualRunResult } from "./types.js";
import { appendSystemRunEvent, runEventStore } from "./runEventStore.js";
import { appendEvidence, writeRunBundle } from "./evidenceStore.js";
import { buildProofGraph, writeProofArtifacts } from "./proofGraph.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "./proof/proofBundleService.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { prepareSandboxDependencyCache } from "./projectAdapter.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const repairsRoot = path.join(rootDir, "reports", "repairs");
const ignoredDirectories = new Set([
  ".git", ".next", ".nuxt", ".cache", ".turbo", "node_modules", "vendor",
  "dist", "build", "coverage", "reports", "__pycache__", ".venv", "venv"
]);
const forbiddenNames = /(^|\/)(\.env(?:\.|$)|\.git(?:\/|$)|id_rsa$|id_ed25519$|.*\.(?:pem|p12|pfx|key|crt))|(^|\/)(node_modules|vendor)(\/|$)/i;
const binaryExtensions = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mov|sqlite3?|db)$/i;
const highRiskPaths = /(^|\/)(migrations?|auth|payments?|billing|infra|deploy|terraform|\.github)(\/|$)|(^|\/)(dockerfile|package\.json)$/i;
const dependencyDescriptorPaths = /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.yarnrc\.yml|requirements\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.lockfile)$/i;
const maxEditableBytes = 1024 * 1024;
let postgresPool: Pool | undefined;

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

function sessionDir(id: string) {
  return path.join(repairsRoot, id);
}

function sessionFile(id: string) {
  return path.join(sessionDir(id), "session.json");
}

function workspaceDir(id: string) {
  return path.join(sessionDir(id), "workspace", "project");
}

function sourceSnapshotDir(id: string) {
  return path.join(sessionDir(id), "source");
}

function normalizeRelative(input: string) {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("repair_path_escape");
  }
  return normalized;
}

function normalizeEditableRelative(input: string) {
  const normalized = normalizeRelative(input);
  if (forbiddenNames.test(normalized) || binaryExtensions.test(normalized)) throw new Error("repair_path_forbidden");
  return normalized;
}

function resolveInside(root: string, relative: string) {
  const safeRelative = normalizeRelative(relative);
  const resolved = path.resolve(root, safeRelative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("repair_path_escape");
  return { relative: safeRelative, resolved };
}

function sha256(input: Uint8Array | string) {
  return createHash("sha256").update(input).digest("hex");
}

async function fileSha256(filePath: string) {
  return sha256(await readFile(filePath));
}

async function constrainRepairValidationCommand(
  command: ReturnType<typeof commandSpecSchema.parse>,
  workspaceRoot: string
) {
  if (
    command.executable !== "pnpm"
    || command.args[0] !== "run"
    || command.args[1] !== "test"
  ) return command;
  try {
    const packageJson = JSON.parse(await readFile(path.join(workspaceRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const testScript = packageJson.scripts?.test;
    if (typeof testScript === "string" && /\bturbo\s+run\s+test\b/.test(testScript)) {
      return commandSpecSchema.parse({
        ...command,
        args: ["exec", "turbo", "run", "test", "--concurrency=1", "--", "--runInBand"]
      });
    }
  } catch {
    // The original allowlisted command remains the safe fallback when a
    // package manifest cannot be read or does not describe a Turbo workspace.
  }
  return command;
}

async function walk(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    return [];
  }
  const output: string[] = [];
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await walk(root, child));
    else if (entry.isFile() && !forbiddenNames.test(child)) output.push(child);
  }
  return output.sort();
}

async function copyTree(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  for (const relative of await walk(source)) {
    const from = resolveInside(source, relative).resolved;
    const to = resolveInside(destination, relative).resolved;
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, await readFile(from));
  }
}

async function treeDigest(root: string) {
  const hash = createHash("sha256");
  for (const relative of await walk(root)) {
    const file = resolveInside(root, relative).resolved;
    hash.update(relative);
    hash.update("\0");
    hash.update(await fileSha256(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function lines(value: string) {
  return value ? value.replace(/\r\n/g, "\n").split("\n") : [];
}

function riskForPath(relative: string): Pick<RepairFileChange, "risk" | "riskReasons" | "editable"> {
  if (forbiddenNames.test(relative) || binaryExtensions.test(relative)) {
    return { risk: "forbidden", riskReasons: ["secret_binary_or_dependency_path"], editable: false };
  }
  if (highRiskPaths.test(relative)) {
    return { risk: "high", riskReasons: ["security_data_or_delivery_sensitive"], editable: true };
  }
  if (/\.(?:json|ya?ml|toml|lock)$/i.test(relative)) {
    return { risk: "medium", riskReasons: ["configuration_or_lockfile"], editable: true };
  }
  return { risk: "low", riskReasons: [], editable: true };
}

async function scanChanges(session: RepairSession) {
  const sourceRoot = sourceSnapshotDir(session.id);
  const workspaceRoot = workspaceDir(session.id);
  const paths = Array.from(new Set([...await walk(sourceRoot), ...await walk(workspaceRoot)])).sort();
  const changes: RepairFileChange[] = [];
  for (const relative of paths) {
    const source = resolveInside(sourceRoot, relative).resolved;
    const patched = resolveInside(workspaceRoot, relative).resolved;
    const sourceExists = await exists(source);
    const patchedExists = await exists(patched);
    const before = sourceExists ? await readFile(source) : undefined;
    const after = patchedExists ? await readFile(patched) : undefined;
    if (before && after && before.equals(after)) continue;
    if (!before && !after) continue;
    if ((before?.byteLength ?? after?.byteLength ?? 0) > maxEditableBytes) throw new Error(`repair_file_too_large:${relative}`);
    const beforeLines = before ? lines(before.toString("utf8")) : [];
    const afterLines = after ? lines(after.toString("utf8")) : [];
    changes.push(repairFileChangeSchema.parse({
      path: relative,
      status: !sourceExists ? "added" : !patchedExists ? "deleted" : "modified",
      baseSha256: before ? sha256(before) : undefined,
      patchedSha256: after ? sha256(after) : undefined,
      additions: afterLines.length,
      deletions: beforeLines.length,
      ...riskForPath(relative),
      version: session.files.find((item) => item.path === relative)?.version ?? 0
    }));
  }
  if (changes.length > session.maxFiles) throw new Error("repair_file_budget_exceeded");
  if (changes.reduce((sum, item) => sum + item.additions + item.deletions, 0) > session.maxChangedLines) {
    throw new Error("repair_line_budget_exceeded");
  }
  return changes;
}

async function persistSession(input: RepairSession) {
  const session = repairSessionSchema.parse(input);
  const database = pool();
  if (database) {
    await database.query(
      `INSERT INTO repair_sessions_v1 (id, run_id, project_id, status, session_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, session_json=EXCLUDED.session_json, updated_at=EXCLUDED.updated_at`,
      [session.id, session.runId, session.projectId, session.status, JSON.stringify(session), session.createdAt, session.updatedAt]
    );
  }
  await mkdir(sessionDir(session.id), { recursive: true });
  await writeFile(sessionFile(session.id), JSON.stringify(session, null, 2));
  return session;
}

export async function readRepairSession(id: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ session_json: unknown }>("SELECT session_json FROM repair_sessions_v1 WHERE id=$1", [id]);
    const parsed = repairSessionSchema.safeParse(result.rows[0]?.session_json);
    if (parsed.success) return parsed.data;
  }
  try {
    return repairSessionSchema.parse(JSON.parse(await readFile(sessionFile(id), "utf8")));
  } catch {
    return undefined;
  }
}

export async function updateRepairSessionSummary(id: string, input: {
  summary: string;
  status?: RepairSession["status"];
  failureClass?: RepairSession["failureClass"];
}) {
  const session = await readRepairSession(id);
  if (!session) throw new Error("repair_session_not_found");
  return persistSession({
    ...session,
    summary: input.summary,
    status: input.status ?? session.status,
    failureClass: input.failureClass ?? session.failureClass,
    updatedAt: new Date().toISOString()
  });
}

export async function listRepairSessions(runId: string) {
  const database = pool();
  if (database) {
    const result = await database.query<{ session_json: unknown }>(
      "SELECT session_json FROM repair_sessions_v1 WHERE run_id=$1 ORDER BY created_at DESC",
      [runId]
    );
    return result.rows.flatMap((row) => {
      const parsed = repairSessionSchema.safeParse(row.session_json);
      return parsed.success ? [parsed.data] : [];
    });
  }
  try {
    const entries = await opendir(repairsRoot);
    const sessions: RepairSession[] = [];
    for await (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const session = await readRepairSession(entry.name);
      if (session?.runId === runId) sessions.push(session);
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function createRepairSession(input: {
  runId: string;
  project: ProjectConfig;
  summary?: string;
  failureClass?: RepairSession["failureClass"];
}) {
  if (process.env.REPAIR_SANDBOX_ENABLED === "false") throw new Error("repair_sandbox_disabled");
  const sourceRoot = path.resolve(input.project.projectPath);
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("repair_source_invalid");
  const id = `repair_${randomUUID()}`;
  await mkdir(sessionDir(id), { recursive: true });
  await copyTree(sourceRoot, sourceSnapshotDir(id));
  await copyTree(sourceRoot, workspaceDir(id));
  const timestamp = new Date().toISOString();
  return persistSession({
    schemaVersion: "1.0",
    id,
    runId: input.runId,
    projectId: input.project.id,
    status: "editing",
    baseSourceSha256: await treeDigest(sourceRoot),
    workspaceRoot: workspaceDir(id),
    summary: input.summary ?? "等待 AI 或用户在沙盒副本中提出修复。",
    failureClass: input.failureClass ?? "unknown",
    files: [],
    iteration: 0,
    maxFiles: 20,
    maxChangedLines: 2000,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export async function readRepairFile(id: string, requestedPath: string) {
  const session = await readRepairSession(id);
  if (!session) throw new Error("repair_session_not_found");
  const relative = normalizeEditableRelative(requestedPath);
  const source = resolveInside(sourceSnapshotDir(id), relative).resolved;
  const patched = resolveInside(workspaceDir(id), relative).resolved;
  const original = await exists(source) ? await readFile(source, "utf8") : "";
  const content = await exists(patched) ? await readFile(patched, "utf8") : "";
  if (Buffer.byteLength(original) > maxEditableBytes || Buffer.byteLength(content) > maxEditableBytes) throw new Error("repair_file_too_large");
  return {
    path: relative,
    original,
    content,
    baseSha256: original ? sha256(original) : undefined,
    patchedSha256: content ? sha256(content) : undefined,
    version: session.files.find((item) => item.path === relative)?.version ?? 0,
    ...riskForPath(relative)
  };
}

export async function writeRepairFile(input: { id: string; path: string; content: string; expectedVersion: number }) {
  const session = await readRepairSession(input.id);
  if (!session) throw new Error("repair_session_not_found");
  if (!["editing", "ready-for-review", "failed"].includes(session.status)) throw new Error("repair_session_not_editable");
  const relative = normalizeEditableRelative(input.path);
  const risk = riskForPath(relative);
  if (!risk.editable || risk.risk === "forbidden") throw new Error("repair_path_forbidden");
  if (Buffer.byteLength(input.content, "utf8") > maxEditableBytes) throw new Error("repair_file_too_large");
  const currentVersion = session.files.find((item) => item.path === relative)?.version ?? 0;
  if (input.expectedVersion !== currentVersion) throw new Error(`repair_version_conflict:${currentVersion}`);
  const target = resolveInside(workspaceDir(input.id), relative).resolved;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.content);
  const files = (await scanChanges(session)).map((item) => item.path === relative ? { ...item, version: currentVersion + 1 } : item);
  return persistSession({ ...session, status: "editing", files, updatedAt: new Date().toISOString() });
}

function hunk(pathname: string, original: string, modified: string, status: RepairFileChange["status"]) {
  const before = lines(original);
  const after = lines(modified);
  const oldPath = status === "added" ? "/dev/null" : `a/${pathname}`;
  const newPath = status === "deleted" ? "/dev/null" : `b/${pathname}`;
  return [
    `diff --git a/${pathname} b/${pathname}`,
    status === "added" ? "new file mode 100644" : status === "deleted" ? "deleted file mode 100644" : "",
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
    ""
  ].filter((line, index) => line || index > 1).join("\n");
}

export async function buildRepairPatch(id: string) {
  const session = await readRepairSession(id);
  if (!session) throw new Error("repair_session_not_found");
  const files = await scanChanges(session);
  const chunks: string[] = [];
  for (const file of files) {
    const sourcePath = resolveInside(sourceSnapshotDir(id), file.path).resolved;
    const patchedPath = resolveInside(workspaceDir(id), file.path).resolved;
    chunks.push(hunk(
      file.path,
      await exists(sourcePath) ? await readFile(sourcePath, "utf8") : "",
      await exists(patchedPath) ? await readFile(patchedPath, "utf8") : "",
      file.status
    ));
  }
  return { session: await persistSession({ ...session, files, updatedAt: new Date().toISOString() }), patch: chunks.join("\n") };
}

async function createArtifact(input: {
  session: RepairSession;
  filePath: string;
  kind: ArtifactV2["kind"];
  mediaType: string;
  artifactId: string;
  identity?: { runId: string; scenarioId: string; attemptId: string; attempt: number; stepId: string };
  origin?: ArtifactV2["origin"];
}) {
  const artifact = await commitCapturedFile({
    temporaryPath: input.filePath,
    finalPath: input.filePath,
    id: input.artifactId,
    identity: input.identity ? {
      runId: input.identity.runId,
      scenarioId: input.identity.scenarioId,
      attemptId: input.identity.attemptId,
      attempt: input.identity.attempt
    } : {
        runId: input.session.runId,
        scenarioId: `repair-${input.session.id}`,
        attemptId: `repair-attempt-${input.session.iteration + 1}`,
        attempt: input.session.iteration + 1
      },
    stepId: input.identity?.stepId ?? "repair-workspace",
    kind: input.kind,
    origin: input.origin ?? "agent-generated",
    mediaType: input.mediaType,
    storageUri: `/artifacts/repairs/${input.session.id}/${path.basename(input.filePath)}`,
    clock: new AttemptClock(),
    collectorVersion: "0.3.0"
  });
  const database = pool();
  if (database) {
    await database.query(
      "INSERT INTO artifacts_v1 (id,run_id,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload",
      [artifact.id, artifact.runId, JSON.stringify(artifact)]
    );
  }
  return artifact;
}

export async function exportRepairSession(id: string, format: "patch" | "zip"): Promise<{ export: RepairExport; artifact: ArtifactV2 }> {
  const { session, patch } = await buildRepairPatch(id);
  if (!session.files.length) throw new Error("repair_has_no_changes");
  const exportId = `repair_export_${randomUUID()}`;
  const baseName = format === "patch" ? "changes.patch" : "changed-files.zip";
  const output = path.join(sessionDir(id), baseName);
  if (format === "patch") {
    await writeFile(output, patch);
  } else {
    const entries: Record<string, Uint8Array> = {
      "repair-manifest.json": strToU8(JSON.stringify({
        schemaVersion: "1.0",
        repairSessionId: session.id,
        runId: session.runId,
        projectId: session.projectId,
        baseSourceSha256: session.baseSourceSha256,
        files: session.files
      }, null, 2)),
      "changes.patch": strToU8(patch)
    };
    for (const file of session.files) {
      if (file.status === "deleted") continue;
      entries[`files/${file.path}`] = new Uint8Array(await readFile(resolveInside(workspaceDir(id), file.path).resolved));
    }
    await writeFile(output, zipSync(entries, { level: 6 }));
  }
  const artifact = artifactV2Schema.parse(await createArtifact({
    session,
    filePath: output,
    kind: format === "patch" ? "source-patch" : "changed-files-archive",
    mediaType: format === "patch" ? "text/x-diff" : "application/zip",
    artifactId: `artifact_${randomUUID()}`
  }));
  const result = repairExportSchema.parse({
    id: exportId,
    repairSessionId: session.id,
    format,
    artifactId: artifact.id,
    downloadUrl: artifact.storageUri,
    sha256: artifact.integrity.sha256,
    sizeBytes: artifact.integrity.sizeBytes,
    createdAt: new Date().toISOString()
  });
  await persistSession({ ...session, status: "exported", updatedAt: new Date().toISOString() });
  const database = pool();
  if (database) {
    await database.query(
      "INSERT INTO repair_exports_v1 (id, repair_session_id, export_json, created_at) VALUES ($1,$2,$3::jsonb,$4)",
      [result.id, result.repairSessionId, JSON.stringify(result), result.createdAt]
    );
  }
  return { export: result, artifact };
}

async function createValidationRun(session: RepairSession, project: ProjectConfig) {
  const requestedRunId = `run_repair_validation_${randomUUID()}`;
  const payload = {
    runKind: "validation",
    parentRunId: session.runId,
    repairSessionId: session.id,
    projectId: project.id,
    organizationId: "local",
    validationOnly: true
  };
  let created = await runEventStore.create({
    runId: requestedRunId,
    actor: "repair-validator",
    idempotencyKey: `${session.id}:validation:${session.iteration + 1}:create`,
    payload
  });
  if (["completed", "failed", "blocked", "cancelled"].includes(created.state)) {
    created = await runEventStore.create({
      runId: requestedRunId,
      actor: "repair-validator",
      idempotencyKey: `${session.id}:validation:${session.iteration + 1}:${requestedRunId}`,
      payload
    });
  }
  // Repeated validation requests are idempotent. The event store may return
  // the projection created by an earlier request, whose runId intentionally
  // differs from this request's freshly generated candidate.
  const runId = created.id;
  await appendSystemRunEvent(runId, "plan_generated", { plan: { sessionName: `Repair validation ${session.id}`, risks: [], levels: [] } });
  await appendSystemRunEvent(runId, "plan_approved");
  await appendSystemRunEvent(runId, "permission_granted");
  await appendSystemRunEvent(runId, "run_preparing");
  await appendSystemRunEvent(runId, "run_started");
  return runId;
}

function validationJudgeReport(
  passed: boolean,
  evidenceId: string,
  summary: string
): LayeredJudgeReport {
  const layer = (name: "plan" | "evidence" | "release") => ({
    layer: name,
    title: `Repair validation ${name}`,
    verdict: passed ? "pass" as const : "fail" as const,
    summary,
    findings: passed ? [] : [{
      id: `repair_validation_${name}_failed`,
      severity: "high" as const,
      failureClass: "product_bug" as const,
      title: "Repair validation command failed",
      reasoning: summary,
      evidenceRefs: [evidenceId]
    }]
  });
  return {
    source: "deterministic_judge",
    executionMode: "deterministic",
    llmStatus: "not_configured",
    policyVersion: "repair-validation-policy-v1",
    createdAt: new Date().toISOString(),
    planJudge: layer("plan"),
    evidenceJudge: layer("evidence"),
    releaseJudge: layer("release")
  };
}

async function persistRepairValidationRun(input: {
  session: RepairSession;
  project: ProjectConfig;
  childRunId: string;
  validationId: string;
  artifact: ArtifactV2;
  passed: boolean;
  failureReason?: string;
  startedAt: string;
  finishedAt: string;
}) {
  const scenarioId = `repair-validation-${input.session.id}`;
  const attemptId = `${input.childRunId}_attempt_1`;
  const stepId = "run-repair-validation";
  const summary = input.passed
    ? "Sandbox repair validation command passed."
    : `Sandbox repair validation failed: ${input.failureReason ?? "test_failed"}`;
  const evidence = await appendEvidence(input.childRunId, {
    type: "operation",
    title: "Repair validation command output",
    scenarioId,
    attemptId,
    attempt: 1,
    sequence: input.artifact.sequence + 1,
    stepId,
    file: input.artifact.storageUri,
    artifactIds: [input.artifact.id],
    payload: {
      repairSessionId: input.session.id,
      validationId: input.validationId,
      exitStatus: input.passed ? "passed" : "failed"
    }
  });
  const machineGateDraft: MachineGateDraft = {
    status: input.passed ? "pass" as const : "fail" as const,
    reasons: input.passed ? [] : [input.failureReason ?? "repair_validation_failed"],
    reasonDetails: input.passed ? [] : [{
      code: input.failureReason ?? "repair_validation_failed",
      summary,
      evidenceRefs: [evidence.id]
    }],
    assertionFailures: input.passed ? [] : ["repair_validation"]
  };
  const judgeRecommendation = {
    status: input.passed ? "pass" as const : "fail" as const,
    summary,
    evidenceRefs: [evidence.id]
  };
  const judgeReport = validationJudgeReport(input.passed, evidence.id, summary);
  // Proof credibility is minted solely by the Proof Bundle Service.
  const artifactIntegrity: ArtifactIntegrityReport = {
    id: `${input.childRunId}_artifact_integrity`,
    runId: input.childRunId,
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: { total: 1, present: 1, missing: 0, unreadable: 0, pathEscapes: 0, selfReferences: 0, hashMismatches: 0, hashed: 1 },
    items: [{ id: input.artifact.id, artifactUri: input.artifact.storageUri, kind: "operation", evidenceId: evidence.id, status: "present", sha256: input.artifact.integrity.sha256, sizeBytes: input.artifact.integrity.sizeBytes }]
  };
  const { machineGate, verdict: proofVerdict, issues, gateEligible } = finalizeProofBundle({
    draft: machineGateDraft,
    runId: input.childRunId,
    evidence: [evidence],
    artifactsV2: [input.artifact],
    artifactIntegrity,
    requiredArtifactKinds: [input.artifact.kind],
    machineGate: machineGateDraft,
    judgeReport,
    gateEligibleFacts: { executionSucceeded: true, requirementCovered: true }
  });
  const result: VisualRunResult = {
    id: input.childRunId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    verdict: input.passed ? "continue" : "stop_and_fix",
    summary,
    steps: [{
      stepId,
      title: "Run repair validation in OCI sandbox",
      status: input.passed ? "passed" : "failed",
      action: "command_check",
      details: summary
    }],
    network: [],
    console: [],
    assertions: [{
      name: "Repair validation command exits successfully",
      passed: input.passed,
      expected: "exit code 0",
      actual: input.passed ? "exit code 0" : input.failureReason ?? "non-zero exit",
      fact: {
        kind: "state.equals",
        target: "repair_validation_exit",
        operator: "equals",
        expected: "0",
        actual: input.passed ? "0" : "non-zero",
        severity: "high",
        evidenceRefs: [evidence.id],
        failureClass: input.passed ? undefined : "product_bug"
      }
    }],
    evidence: [evidence],
    loopEvents: [],
    oracles: [{
      id: "repair-validation-command-oracle",
      pathId: stepId,
      assertionName: "Repair validation command exits successfully",
      expectedFrom: "existing_test",
      preconditions: ["Patch applied only to sandbox workspace."],
      action: "Run manifest-declared test command in rootless OCI.",
      postconditions: ["Command exits with code 0."],
      requiresHumanConfirmation: false,
      evidenceRefs: [evidence.id]
    }],
    riskCoverageMatrix: [{
      riskId: "repair_regression",
      riskTitle: "Repair regression validation",
      covered: true,
      passed: input.passed,
      pathIds: [stepId],
      evidenceRefs: [evidence.id],
      notes: summary
    }],
    aggregatedVerdict: {
      runCount: 1,
      failedAssertionCount: input.passed ? 0 : 1,
      flaky: false,
      verdict: input.passed ? "continue" : "stop_and_fix",
      reason: summary
    },
    reflectionNote: "Validation child run preserves the original failed run.",
    conflictPacket: {
      status: "not_triggered",
      reason: "Deterministic command result.",
      evidenceRefs: [evidence.id]
    },
    failureAttributions: [],
    attempts: [{
      id: attemptId,
      runId: input.childRunId,
      scenarioId,
      attempt: 1,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: input.passed ? "passed" : "failed",
      artifactIds: [input.artifact.id]
    }],
    artifactsV2: [input.artifact],
    gateStatus: machineGate.status,
    machineGate,
    judgeRecommendation,
    finalStatus: machineGate.status,
    outcomeSummary: {
      schemaVersion: "2.0",
      schedulingCompleted: true,
      executionStarted: true,
      executionSucceeded: true,
      requirementCovered: true,
      requirementPassed: input.passed,
      ...proofCredibility(proofVerdict, machineGate, gateEligible),
      machineGate,
      judgeRecommendation,
      finalStatus: machineGate.status
    },
    judgeReport,
    reportFile: `/artifacts/repairs/${input.session.id}/validation-${input.validationId}.log`,
    runBundleFile: `/artifacts/runs/${input.childRunId}/run_bundle.json`
  };
  const proof = buildProofGraph(result);
  result.conclusions = proof.conclusions;
  result.proofNodes = proof.proofNodes;
  result.proofEdges = proof.proofEdges;
  const bundle: RunBundle = {
    runId: input.childRunId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    input: {
      runId: input.childRunId,
      projectId: input.project.id,
      scenarioId,
      permissionProfile: {
        observe: true,
        browserControl: false,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    },
    result: result as RunBundle["result"],
    evidence: result.evidence,
    artifactsV2: result.artifactsV2,
    attempts: result.attempts,
    loopEvents: result.loopEvents,
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix,
    conflictPacket: result.conflictPacket,
    failureAttributions: result.failureAttributions,
    conclusions: result.conclusions,
    proofNodes: result.proofNodes,
    proofEdges: result.proofEdges,
    judgeReport
  };
  const manifest = await writeProofArtifacts(bundle);
  result.evidenceManifest = manifest;
  bundle.evidenceManifest = manifest;
  bundle.result.evidenceManifest = manifest;
  await writeRunBundle(bundle);
  await persistExecutionResult(input.childRunId, result, { verdict: proofVerdict, gateEligible });
  return { result, verdict: proofVerdict, issues, gateEligible };
}

export async function validateRepairSession(id: string, project: ProjectConfig) {
  const session = await readRepairSession(id);
  if (!session) throw new Error("repair_session_not_found");
  const files = await scanChanges(session);
  if (!files.length) throw new Error("repair_has_no_changes");
  if (files.some((item) => item.risk === "forbidden")) throw new Error("repair_contains_forbidden_change");
  const configuredFullCommand = project.testCommandSpec ?? project.manifest?.commands.test;
  if (!configuredFullCommand || !project.manifest?.execution.image) {
    const timestamp = new Date().toISOString();
    const validation = repairValidationSchema.parse({
      id: `repair_validation_${randomUUID()}`,
      repairSessionId: id,
      status: "blocked",
      commands: configuredFullCommand ? [commandSpecSchema.parse(configuredFullCommand)] : [],
      artifactIds: [],
      summary: "项目没有声明可在 OCI 沙盒执行的测试命令。",
      startedAt: timestamp,
      finishedAt: timestamp
    });
    return persistSession({ ...session, status: "blocked", files, validation, updatedAt: timestamp });
  }
  const fullCommand = await constrainRepairValidationCommand(
    commandSpecSchema.parse(configuredFullCommand),
    workspaceDir(id)
  );
  const dependencyDescriptorsChanged = files.some((item) => dependencyDescriptorPaths.test(item.path));
  if (dependencyDescriptorsChanged) {
    const timestamp = new Date().toISOString();
    const validation = repairValidationSchema.parse({
      id: `repair_validation_${randomUUID()}`,
      repairSessionId: id,
      status: "blocked",
      commands: [commandSpecSchema.parse(fullCommand)],
      artifactIds: [],
      summary: "修复包含依赖清单或锁文件变更，需要单独授权联网安装后才能验证；系统没有复用旧依赖冒充验证成功。",
      startedAt: timestamp,
      finishedAt: timestamp
    });
    return persistSession({ ...session, status: "blocked", files, validation, updatedAt: timestamp });
  }
  const dependencyCache = await prepareSandboxDependencyCache(project, workspaceDir(id), {
    dependencyDescriptorRoot: path.resolve(project.projectPath),
    workspaceNamespace: `repair-validation-${id}`
  });
  const installCommand = project.installCommandSpec ?? project.manifest.commands.install;
  if (installCommand && !dependencyCache?.prepared) {
    const timestamp = new Date().toISOString();
    const validation = repairValidationSchema.parse({
      id: `repair_validation_${randomUUID()}`,
      repairSessionId: id,
      status: "blocked",
      commands: [commandSpecSchema.parse(fullCommand)],
      artifactIds: [],
      summary: "项目依赖缓存尚未准备完成。请先完成一次项目沙盒启动，系统会复用同一份依赖缓存进行修复验证。",
      startedAt: timestamp,
      finishedAt: timestamp
    });
    return persistSession({ ...session, status: "blocked", files, validation, updatedAt: timestamp });
  }
  const startedAt = new Date().toISOString();
  const childRunId = await createValidationRun(session, project);
  const validationId = `repair_validation_${randomUUID()}`;
  const validationCandidates = [
    {
      stage: "targeted",
      command: project.manifest.commands.targetedTest ?? fullCommand
    },
    {
      stage: "related",
      command: project.manifest.commands.relatedTest ?? project.manifest.commands.targetedTest ?? fullCommand
    },
    {
      stage: "full-regression",
      command: fullCommand
    }
  ] as const;
  const commandKey = (command: typeof fullCommand) => JSON.stringify(commandSpecSchema.parse(command));
  const validationCommands = validationCandidates.filter((candidate, index, all) =>
    all.findIndex((item) => commandKey(item.command) === commandKey(candidate.command)) === index
  );
  await persistSession({
    ...session,
    status: "validating",
    files,
    validation: repairValidationSchema.parse({
      id: validationId,
      repairSessionId: id,
      status: "running",
      childRunId,
      commands: validationCommands.map((item) => item.command),
      artifactIds: [],
      summary: "正在 OCI 沙盒中运行定向与回归验证。",
      startedAt
    }),
    updatedAt: startedAt
  });
  const stageResults: Array<{
    stage: string;
    command: typeof fullCommand;
    exitCode: number | null;
    failureReason?: string;
    stdout: string;
    stderr: string;
  }> = [];
  for (const item of validationCommands) {
    const invocation = buildOciInvocation({
      engine: project.manifest.execution.engine,
      image: project.manifest.execution.image,
      manifest: project.manifest,
      repositoryRoot: workspaceDir(id),
      command: item.command,
      prepareCommand: project.installCommandSpec ?? project.manifest.commands.install,
      dependencyCache
    });
    const result = await runAllowlistedCommand({
      command: {
        executable: invocation.executable,
        args: invocation.args,
        timeoutMs: item.command.timeoutMs ?? 600_000
      },
      cwd: rootDir,
      env: {},
      allowedExecutables: [project.manifest.execution.engine],
      maxLogBytes: project.manifest.budget.maxLogBytes
    });
    stageResults.push({
      stage: item.stage,
      command: item.command,
      exitCode: result.exitCode,
      failureReason: result.failureReason,
      stdout: result.stdout,
      stderr: result.stderr
    });
  }
  const logPath = path.join(sessionDir(id), `validation-${validationId}.log`);
  await writeFile(logPath, JSON.stringify({
    stages: stageResults
  }, null, 2));
  const artifact = await createArtifact({
    session,
    filePath: logPath,
    kind: "repair-validation-log",
    mediaType: "application/json",
    artifactId: `artifact_${randomUUID()}`,
    identity: {
      runId: childRunId,
      scenarioId: `repair-validation-${session.id}`,
      attemptId: `${childRunId}_attempt_1`,
      attempt: 1,
      stepId: "run-repair-validation"
    },
    origin: "runtime-captured"
  });
  const stagePassed = (candidate: (typeof validationCandidates)[number]) =>
    stageResults.find((item) => commandKey(item.command) === commandKey(candidate.command))?.exitCode === 0;
  const targetedPassed = stagePassed(validationCandidates[0]);
  const relatedPassed = stagePassed(validationCandidates[1]);
  const regressionPassed = relatedPassed && stagePassed(validationCandidates[2]);
  const passed = targetedPassed && regressionPassed;
  const failureReason = stageResults.find((item) => item.exitCode !== 0)?.failureReason;
  const finishedAt = new Date().toISOString();
  const { result: validationResult, verdict: validationVerdict, issues: validationIssues, gateEligible: validationGateEligible } = await persistRepairValidationRun({
    session,
    project,
    childRunId,
    validationId,
    artifact,
    passed,
    failureReason,
    startedAt,
    finishedAt
  });
  await appendSystemRunEvent(childRunId, "evidence_collecting", { artifactIds: [artifact.id] });
  const machineGate = validationResult.machineGate!;
  await appendSystemRunEvent(childRunId, "run_judging", { machineGate });
  const outcomeSummary = {
    schemaVersion: "2.0" as const,
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: true,
    requirementCovered: true,
    requirementPassed: passed,
    ...proofCredibility(validationVerdict, validationResult.machineGate!, validationGateEligible),
    proofValidationIssues: validationIssues,
    machineGate,
    finalStatus: passed ? "pass" as const : "fail" as const
  };
  await appendSystemRunEvent(childRunId, passed ? "run_completed" : "run_failed", {
    machineGate,
    finalStatus: passed ? "pass" : "fail",
    outcomeSummary
  });
  const validation = repairValidationSchema.parse({
    id: validationId,
    repairSessionId: id,
    status: passed ? "passed" : "failed",
    childRunId,
    commands: validationCommands.map((item) => item.command),
    targetedPassed,
    regressionPassed,
    artifactIds: [artifact.id],
    summary: passed
      ? "定向测试、相关模块测试和完整回归均通过，可以进入人工 Diff 审查。"
      : `沙盒验证失败：${failureReason ?? "test_failed"}`,
    startedAt,
    finishedAt
  });
  return persistSession({
    ...session,
    status: passed ? "ready-for-review" : "failed",
    files,
    validation,
    iteration: Math.min(2, session.iteration + 1),
    updatedAt: finishedAt
  });
}

export async function applyRepairSession(id: string, project: ProjectConfig, options?: { confirmHighRisk?: boolean }) {
  if (process.env.REPAIR_HOST_APPLY_ENABLED !== "true") throw new Error("repair_host_apply_disabled");
  const session = await readRepairSession(id);
  if (!session) throw new Error("repair_session_not_found");
  if (session.validation?.status !== "passed") throw new Error("repair_validation_required");
  const sourceRoot = path.resolve(project.projectPath);
  if (await treeDigest(sourceRoot) !== session.baseSourceSha256) throw new Error("source_changed");
  const files = await scanChanges(session);
  if (files.some((item) => item.risk === "forbidden")) throw new Error("repair_contains_forbidden_change");
  if (files.some((item) => item.risk === "high") && !options?.confirmHighRisk) {
    throw new Error("repair_high_risk_confirmation_required");
  }
  if (await exists(path.join(sourceRoot, ".git"))) {
    const { patch } = await buildRepairPatch(id);
    const patchPath = path.join(sessionDir(id), "apply.patch");
    await writeFile(patchPath, patch);
    const check = await runAllowlistedCommand({
      command: { executable: "git", args: ["apply", "--check", patchPath], timeoutMs: 30_000 },
      cwd: sourceRoot,
      env: {},
      allowedExecutables: ["git"],
      maxLogBytes: 2 * 1024 * 1024
    });
    if (check.exitCode !== 0) throw new Error(`repair_git_apply_check_failed:${check.stderr || check.stdout}`);
    const applied = await runAllowlistedCommand({
      command: { executable: "git", args: ["apply", patchPath], timeoutMs: 30_000 },
      cwd: sourceRoot,
      env: {},
      allowedExecutables: ["git"],
      maxLogBytes: 2 * 1024 * 1024
    });
    if (applied.exitCode !== 0) throw new Error(`repair_git_apply_failed:${applied.stderr || applied.stdout}`);
    return persistSession({ ...session, status: "applied", files, updatedAt: new Date().toISOString() });
  }
  const backups = new Map<string, Buffer | undefined>();
  try {
    for (const file of files) {
      const destination = resolveInside(sourceRoot, file.path).resolved;
      backups.set(file.path, await exists(destination) ? await readFile(destination) : undefined);
      if (file.status === "deleted") {
        if (await exists(destination)) await unlink(destination);
        continue;
      }
      const patched = resolveInside(workspaceDir(id), file.path).resolved;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(patched));
    }
  } catch (error) {
    for (const [relative, backup] of backups) {
      const destination = resolveInside(sourceRoot, relative).resolved;
      if (backup) {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, backup);
      } else {
        await rm(destination, { force: true });
      }
    }
    throw error;
  }
  return persistSession({ ...session, status: "applied", files, updatedAt: new Date().toISOString() });
}
