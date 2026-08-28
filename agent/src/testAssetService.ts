import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ApplyTestAssetRequestV1,
  CreateTestAssetRequestV1,
  OracleSpecV2,
  TestAssetFileV1,
  TestAssetV1,
  TestAssetValidationV1,
  ValidateTestAssetRequestV1
} from "@ai-test-officer/contracts";
import {
  createTestAssetRequestV1Schema,
  oracleSpecV2Schema,
  testAssetFileV1Schema,
  testAssetV1Schema,
  testAssetValidationV1Schema,
  validateTestAssetRequestV1Schema
} from "@ai-test-officer/contracts";
import { readEvidence } from "./evidenceStore.js";
import { canonicalSha256 } from "./canonicalHash.js";
import { getReliabilityAssetStore, recordReliabilityMutation, type ReliabilityAssetStore } from "./reliabilityAssetStore.js";
import { runEventStore, type RunEventStore } from "./runEventStore.js";
import { getWriteSafetyLayer } from "./write-safety/index.js";

const execFileAsync = promisify(execFile);
const SAFE_TEST_PATH = /^(?:tests?|e2e|__tests__)\/(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+\.(?:spec|test)\.ts$/;
const FORBIDDEN_SOURCE = /(?:\b(?:import|require)\b[^\n]*(?:child_process|node:fs|node:net|node:http)|\bprocess\.env(?:\.(?:AWS|DATABASE|API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)|\s*\[[^\]]*(?:AWS|DATABASE|API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[^\]]*\]))/i;

function fileSha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "generated-test";
}

function expectedText(spec: OracleSpecV2) {
  const value = spec.comparison.expected;
  return typeof value === "string" ? value : spec.description;
}

export function generateTestAssetFiles(input: {
  format: "playwright-ts" | "api-ts";
  sourceRunId: string;
  oracleSpecs: OracleSpecV2[];
}): TestAssetFileV1[] {
  const title = `AI Test Officer ${input.sourceRunId}`;
  if (input.format === "api-ts") {
    const operations = input.oracleSpecs.map((spec) => {
      const endpoint = spec.comparison.actualPath ?? "/";
      return `  test(${JSON.stringify(spec.description)}, async ({ request }) => {\n    const response = await request.get(${JSON.stringify(endpoint)});\n    expect(response.ok()).toBeTruthy();\n    expect(await response.text()).toContain(${JSON.stringify(expectedText(spec))});\n  });`;
    }).join("\n\n");
    const content = `import { test, expect } from "playwright/test";\n\ntest.describe(${JSON.stringify(title)}, () => {\n${operations}\n});\n`;
    return [testAssetFileV1Schema.parse({ path: `tests/api/${safeName(input.sourceRunId)}.spec.ts`, content, sha256: fileSha256(content), language: "api-ts" })];
  }

  const assertions = input.oracleSpecs.map((spec) =>
    `  await expect(page.locator("body"), ${JSON.stringify(spec.description)}).toContainText(${JSON.stringify(expectedText(spec))});`
  ).join("\n");
  const content = `import { test, expect } from "playwright/test";\n\ntest(${JSON.stringify(title)}, async ({ page }) => {\n  await page.goto(process.env.PLAYWRIGHT_BASE_URL ?? process.env.ATO_APP_URL ?? "http://127.0.0.1:6173");\n${assertions}\n});\n`;
  return [testAssetFileV1Schema.parse({ path: `tests/e2e/${safeName(input.sourceRunId)}.spec.ts`, content, sha256: fileSha256(content), language: "playwright-ts" })];
}

export function validateTestAssetFiles(files: TestAssetFileV1[]) {
  for (const file of files) {
    if (!SAFE_TEST_PATH.test(file.path) || path.isAbsolute(file.path) || file.path.includes("..")) throw new Error("asset_path_forbidden");
    if (FORBIDDEN_SOURCE.test(file.content)) throw new Error("asset_dependency_forbidden");
    if (fileSha256(file.content) !== file.sha256) throw new Error(`asset_file_hash_mismatch:${file.path}`);
  }
}

/**
 * A lexical `path.resolve(root, relative)` check is not sufficient for a
 * checkout: an existing symlink in `tests/` could redirect a safe-looking
 * generated file outside the repository. Walk existing path components and
 * reject symlinks before any branch is changed or file is written.
 */
async function assertNoSymlink(repositoryRoot: string, relativePath: string) {
  let current = path.resolve(repositoryRoot);
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`asset_path_symlink_forbidden:${relativePath}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

async function git(root: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

export async function repositorySnapshotHash(repositoryRoot: string) {
  const [head, index, worktreeDiff, untracked] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    git(repositoryRoot, ["ls-files", "-s"]),
    git(repositoryRoot, ["diff", "--binary", "HEAD"]),
    git(repositoryRoot, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const untrackedFiles = await Promise.all(untracked.split("\n").filter(Boolean).map(async (relative) => {
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute !== repositoryRoot && !absolute.startsWith(`${repositoryRoot}${path.sep}`)) {
      return { relative, status: "path-escape" };
    }
    try {
      return { relative, sha256: fileSha256(await readFile(absolute)) };
    } catch {
      return { relative, status: "missing" };
    }
  }));
  return canonicalSha256({ head, index, worktreeDiff, untrackedFiles });
}

export async function inspectTestAssetTarget(input: {
  asset: TestAssetV1;
  repositoryRoot?: string;
}) {
  validateTestAssetFiles(input.asset.files);
  const repositoryRoot = path.resolve(input.repositoryRoot ?? input.asset.sourceRepositoryRoot);
  await Promise.all(input.asset.files.map((file) => assertNoSymlink(repositoryRoot, file.path)));
  const status = await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const repositorySha256 = await repositorySnapshotHash(repositoryRoot);
  const patch = (await Promise.all(input.asset.files.map(async (file) => {
    const destination = path.resolve(repositoryRoot, file.path);
    const before = await readFile(destination, "utf8").catch(() => undefined);
    const afterLines = file.content.split("\n").map((line) => `+${line}`).join("\n");
    if (before === undefined) {
      return `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@\n${afterLines}`;
    }
    const beforeLines = before.split("\n").map((line) => `-${line}`).join("\n");
    return `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@\n${beforeLines}\n${afterLines}`;
  }))).join("\n");
  return { repositoryRoot, clean: status.length === 0, status, repositorySha256, patch, patchSha256: fileSha256(patch) };
}

async function resolveOracleSpecs(input: CreateTestAssetRequestV1, store: ReliabilityAssetStore) {
  const supplied = input.oracleSpecs.map((item) => oracleSpecV2Schema.parse(item));
  const resolved = supplied.length > 0
    ? supplied
    : (await Promise.all(input.oracleSpecIds.map((id) => store.getOracle(id))));
  if (resolved.some((item) => !item)) throw new Error("oracle_spec_not_found");
  const specs = resolved.filter((item): item is OracleSpecV2 => Boolean(item));
  const requestedIds = new Set(input.oracleSpecIds);
  if (specs.some((spec) => !requestedIds.has(spec.id))) throw new Error("oracle_spec_id_mismatch");
  if (specs.some((spec) => spec.projectId !== input.projectId)) throw new Error("oracle_spec_project_mismatch");
  if (specs.length !== requestedIds.size) throw new Error("oracle_spec_not_found");
  return specs;
}

export async function createTestAsset(input: {
  request: CreateTestAssetRequestV1;
  runStore?: RunEventStore;
  store?: ReliabilityAssetStore;
}): Promise<TestAssetV1> {
  const request = createTestAssetRequestV1Schema.parse(input.request);
  const runs = input.runStore ?? runEventStore;
  const store = input.store ?? getReliabilityAssetStore();
  const run = await runs.get(request.sourceRunId);
  if (!run
    || run.input.projectId !== request.projectId
    || run.gateStatus !== "pass"
    || run.outcomeSummary?.gateEligible !== true
    || run.outcomeSummary?.proofValidationIssues?.length) throw new Error("source_run_not_trusted");
  const oracleSpecs = await resolveOracleSpecs(request, store);
  const sourceEvidence = await readEvidence(request.sourceRunId);
  const sourceEvidenceIds = new Set(sourceEvidence.map((item) => item.id));
  if (request.evidenceRefs.some((evidenceRef) => !sourceEvidenceIds.has(evidenceRef))) {
    throw new Error("source_evidence_not_found");
  }
  for (const oracle of oracleSpecs) await store.putOracle(oracle);
  const files = request.files.length > 0
    ? request.files.map((file) => testAssetFileV1Schema.parse(file))
    : generateTestAssetFiles({ format: request.format, sourceRunId: request.sourceRunId, oracleSpecs });
  validateTestAssetFiles(files);
  const actualRepositoryHash = await repositorySnapshotHash(request.repositoryRoot);
  if (actualRepositoryHash !== request.repositorySha256) {
    throw new Error(`repository_source_hash_mismatch:expected=${request.repositorySha256}:actual=${actualRepositoryHash}`);
  }
  const now = new Date().toISOString();
  const asset = testAssetV1Schema.parse({
    schemaVersion: "1.0",
    id: `asset_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    projectId: request.projectId,
    sourceRunId: request.sourceRunId,
    coverageItemIds: request.coverageItemIds,
    oracleSpecIds: oracleSpecs.map((spec) => spec.id),
    evidenceRefs: request.evidenceRefs,
    files,
    status: "candidate",
    sourceRepositoryRoot: path.resolve(request.repositoryRoot),
    sourceRepositorySha256: actualRepositoryHash,
    createdAt: now,
    updatedAt: now
  });
  await recordReliabilityMutation({
    store,
    kind: "test-asset",
    entityId: asset.id,
    value: asset,
    operation: "created",
    projectId: asset.projectId,
    sourceRunId: asset.sourceRunId,
    evidenceTitle: "Test asset candidate generated",
    evidencePayload: {
      assetId: asset.id,
      sourceRunId: request.sourceRunId,
      coverageItemIds: asset.coverageItemIds,
      oracleSpecIds: asset.oracleSpecIds,
      filePaths: files.map((file) => file.path),
      sourceRepositorySha256: actualRepositoryHash
    }
  });
  return asset;
}

export async function validateTestAsset(input: {
  id: string;
  request: ValidateTestAssetRequestV1;
  store?: ReliabilityAssetStore;
  runStore?: RunEventStore;
  repetitionResults?: Array<{ runId: string; passed: boolean; cleanEnvironment: boolean; evidenceRefs?: string[] }>;
  failureClassOverride?: TestAssetValidationV1["failureClass"];
}) {
  const request = validateTestAssetRequestV1Schema.parse(input.request);
  const store = input.store ?? getReliabilityAssetStore();
  const asset = await store.getTestAsset(input.id);
  if (!asset) throw new Error("test_asset_not_found");
  validateTestAssetFiles(asset.files);
  const runs = input.runStore
    ? await Promise.all(request.runIds.map((runId) => input.runStore!.get(runId)))
    : [];
  const passedRunCount = input.repetitionResults
    ? input.repetitionResults.filter((item) => item.passed && item.cleanEnvironment).length
    : runs.filter((run) => run?.gateStatus === "pass").length;
  const uniqueRunIds = new Set(request.runIds).size === request.runIds.length;
  const repetitionsPassed = request.repetitions === 3
    && request.runIds.length === 3
    && uniqueRunIds
    && Boolean(input.runStore || input.repetitionResults)
    && passedRunCount === 3;
  const passed = repetitionsPassed
    && request.mutationTotal > 0
    && request.mutationKilled <= request.mutationTotal
    && request.mutationKilled === request.mutationTotal
    && request.securityPassed;
  const validation = testAssetValidationV1Schema.parse({
    schemaVersion: "1.0",
    id: `asset_validation_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    assetId: asset.id,
    status: passed ? "passed" : request.securityPassed ? "failed" : "blocked",
    repetitions: request.repetitions,
    passedRepetitions: repetitionsPassed ? 3 : Math.min(request.repetitions, passedRunCount),
    mutationTotal: request.mutationTotal,
    mutationKilled: request.mutationKilled,
    securityPassed: request.securityPassed,
    failureClass: passed ? undefined : input.failureClassOverride ?? (request.securityPassed ? "generated-test" : "infrastructure"),
    runIds: request.runIds,
    evidenceRefs: request.evidenceRefs,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  });
  const next = testAssetV1Schema.parse({
    ...asset,
    status: passed ? "ready-for-review" : validation.status === "blocked" ? "blocked" : "failed",
    validation,
    updatedAt: new Date().toISOString()
  });
  await recordReliabilityMutation({
    store,
    kind: "test-asset",
    entityId: next.id,
    value: next,
    operation: validation.status === "blocked" ? "blocked" : validation.status === "failed" ? "failed" : "validated",
    projectId: next.projectId,
    sourceRunId: next.sourceRunId,
    evidenceTitle: "Test asset validation completed",
    evidencePayload: {
      assetId: asset.id,
      validationId: validation.id,
      repetitions: validation.repetitions,
      mutationKilled: validation.mutationKilled,
      mutationTotal: validation.mutationTotal,
      securityPassed: validation.securityPassed,
      status: validation.status
    }
  });
  return next;
}

export interface TestAssetValidationExecutor {
  runCleanRepetition(input: { asset: TestAssetV1; repetition: number }): Promise<{
    runId: string;
    passed: boolean;
    cleanEnvironment: boolean;
    evidenceRefs?: string[];
  }>;
  runMutation(input: { asset: TestAssetV1; mutation: number }): Promise<{ killed: boolean; evidenceRefs?: string[] }>;
  securityScan(input: { asset: TestAssetV1 }): Promise<{ passed: boolean; evidenceRefs?: string[] }>;
}

/** Executes the validation protocol instead of accepting an attested count.
 * The executor is supplied by the existing project/Graph runner so this
 * module does not create a second test execution engine. */
export async function validateTestAssetWithExecutor(input: {
  id: string;
  executor: TestAssetValidationExecutor;
  store?: ReliabilityAssetStore;
  runStore?: RunEventStore;
  mutations?: number[];
}) {
  const store = input.store ?? getReliabilityAssetStore();
  const asset = await store.getTestAsset(input.id);
  if (!asset) throw new Error("test_asset_not_found");
  const repetitions: Array<{ runId: string; passed: boolean; cleanEnvironment: boolean; evidenceRefs?: string[] }> = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    repetitions.push(await input.executor.runCleanRepetition({ asset, repetition }));
  }
  const mutationIds = input.mutations ?? [0];
  const mutations = await Promise.all(mutationIds.map(async (mutation) => input.executor.runMutation({ asset, mutation })));
  const security = await input.executor.securityScan({ asset });
  const evidenceRefs = [
    ...repetitions.flatMap((item) => item.evidenceRefs ?? []),
    ...mutations.flatMap((item) => item.evidenceRefs ?? []),
    ...(security.evidenceRefs ?? [])
  ];
  return validateTestAsset({
    id: input.id,
    store,
    runStore: input.runStore,
    repetitionResults: repetitions,
    failureClassOverride: repetitions.some((item) => !item.cleanEnvironment) ? "environment" : undefined,
    request: {
      schemaVersion: "1.0",
      repetitions: 3,
      mutationTotal: mutations.length,
      mutationKilled: mutations.filter((item) => item.killed).length,
      securityPassed: security.passed,
      runIds: repetitions.map((item) => item.runId),
      mutationIds: mutationIds,
      evidenceRefs
    }
  });
}

export async function applyTestAsset(input: {
  id: string;
  request: ApplyTestAssetRequestV1;
  store?: ReliabilityAssetStore;
}) {
  const request = input.request;
  const store = input.store ?? getReliabilityAssetStore();
  const asset = await store.getTestAsset(input.id);
  if (!asset) throw new Error("test_asset_not_found");
  if (asset.status !== "ready-for-review") throw new Error("test_asset_validation_required");
  validateTestAssetFiles(asset.files);
  if (asset.sourceRepositorySha256 !== request.expectedRepositorySha256) throw new Error("source_changed");
  const target = await inspectTestAssetTarget({ asset });
  if (!target.clean) throw new Error(`target_worktree_dirty:${target.status.slice(0, 500)}`);
  if (target.repositorySha256 !== request.expectedRepositorySha256) throw new Error("source_changed");

  const branch = `codex/ai-test-assets-${safeName(asset.sourceRunId)}`;
  try {
    await git(asset.sourceRepositoryRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    throw new Error("asset_branch_exists");
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "asset_branch_exists") throw error;
  }
  const originalBranch = await git(asset.sourceRepositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD");
  const originalHead = await git(asset.sourceRepositoryRoot, ["rev-parse", "HEAD"]);
  const originalDetached = originalBranch === "HEAD";
  let branchCreated = false;
  const writtenFiles: Array<{ destination: string; before?: string }> = [];
  const action = getWriteSafetyLayer().resolveProposal({
    actionId: `asset_apply_${asset.id}`,
    proposedBy: "user",
    capability: "apply_test_asset",
    params: {
      estimatedAffectedRows: asset.files.length,
      repositoryRoot: asset.sourceRepositoryRoot,
      capabilityGrantId: request.capabilityGrantId
    },
    reason: "User-confirmed application of a validated generated test asset",
    sourceClaimIds: asset.evidenceRefs,
    riskLevel: "high",
    requiresConfirmation: true,
    idempotencyKey: `asset-apply:${asset.id}`,
    runId: asset.sourceRunId,
    projectId: asset.projectId,
    proposedAt: new Date().toISOString()
  });
  const policy = await getWriteSafetyLayer().policyCheck(action);
  if (!policy.allowed) throw new Error("asset_apply_policy_denied");
  const workflow = await getWriteSafetyLayer().createApprovalWorkflow(action);
  if (workflow.status === "pending") await getWriteSafetyLayer().approveWorkflow(workflow.workflowId, request.confirmedBy, "Explicit test asset apply confirmation");
  const execution = await getWriteSafetyLayer().executeApproved(action, async () => {
    try {
      await git(asset.sourceRepositoryRoot, ["switch", "-c", branch]);
      branchCreated = true;
      for (const file of asset.files) {
        const destination = path.resolve(asset.sourceRepositoryRoot, file.path);
        const relative = path.relative(asset.sourceRepositoryRoot, destination);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("asset_path_forbidden");
        await assertNoSymlink(asset.sourceRepositoryRoot, file.path);
        const before = await readFile(destination, "utf8").catch(() => undefined);
        writtenFiles.push({ destination, before });
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, file.content, "utf8");
      }
      const changed = await git(asset.sourceRepositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (!changed) throw new Error("asset_write_not_visible");
      const afterRepositorySha256 = await repositorySnapshotHash(asset.sourceRepositoryRoot);
      if (afterRepositorySha256 === request.expectedRepositorySha256) throw new Error("asset_write_not_visible");
      return {
        executionId: `asset_execution_${asset.id}`,
        actionId: action.actionId,
        status: "executed" as const,
        beforeState: { branch: originalBranch, repositorySha256: request.expectedRepositorySha256 },
        afterState: { branch, changedFiles: asset.files.map((file) => file.path), repositorySha256: afterRepositorySha256 },
        affectedTables: asset.files.map((file) => file.path),
        affectedRows: asset.files.length,
        durationMs: 0,
        executedAt: new Date().toISOString(),
        executorId: "test-asset-service"
      };
    } catch (error) {
      try {
        for (const written of writtenFiles.reverse()) {
          if (written.before === undefined) await rm(written.destination, { force: true }).catch(() => undefined);
          else await writeFile(written.destination, written.before, "utf8").catch(() => undefined);
        }
        if (branchCreated) {
          await git(asset.sourceRepositoryRoot, originalDetached ? ["switch", "--detach", originalHead] : ["switch", originalBranch]);
        }
        const restoredHead = await git(asset.sourceRepositoryRoot, ["rev-parse", "HEAD"]);
        if (restoredHead !== originalHead) throw new Error("asset_apply_restore_head_mismatch");
        const restoredHash = await repositorySnapshotHash(asset.sourceRepositoryRoot);
        if (restoredHash !== request.expectedRepositorySha256) throw new Error("asset_apply_restore_worktree_mismatch");
        if (branchCreated) await git(asset.sourceRepositoryRoot, ["branch", "-D", branch]).catch(() => undefined);
      } catch (restoreError) {
        throw new Error(`asset_apply_restore_failed:${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      throw error;
    }
  });
  if (execution.status !== "executed") throw new Error(execution.error?.message ?? "asset_apply_failed");
  const next = testAssetV1Schema.parse({
    ...asset,
    status: "applied",
    targetBranch: branch,
    patchSha256: target.patchSha256,
    updatedAt: new Date().toISOString()
  });
  await recordReliabilityMutation({
    store,
    kind: "test-asset",
    entityId: next.id,
    value: next,
    operation: "applied",
    projectId: next.projectId,
    sourceRunId: next.sourceRunId,
    evidenceTitle: "Validated test asset applied to new branch",
    evidencePayload: {
      assetId: asset.id,
      branch,
      changedFiles: asset.files.map((file) => file.path),
      capabilityGrantId: request.capabilityGrantId,
      confirmedBy: request.confirmedBy,
      commitCreated: false,
      pushed: false
    }
  });
  return { asset: next, branch, changedFiles: asset.files.map((file) => file.path), committed: false, pushed: false };
}
