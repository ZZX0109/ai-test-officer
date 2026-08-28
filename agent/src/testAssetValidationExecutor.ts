import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  CommandSpec,
  RunEventType,
  TestAssetV1,
  TestAssetFileV1
} from "@ai-test-officer/contracts";
import {
  appendEvidence,
  getReportsDir
} from "./evidenceStore.js";
import {
  executeProjectCommand,
  getProject,
  safeProjectPath,
  startProject,
  stopProject,
  testProjectConnection
} from "./projectAdapter.js";
import { runEventStore, type RunEventStore } from "./runEventStore.js";
import {
  validateTestAssetFiles,
  type TestAssetValidationExecutor
} from "./testAssetService.js";

const GENERATED_ROOT = ".ato-test-asset-validation";
const IMPOSSIBLE_EXPECTATION = "__ATO_MUTATION_UNREACHABLE__";

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "asset";
}

function validationRunId(asset: TestAssetV1, kind: "repeat" | "mutation", index: number) {
  return `asset_validation_${safeName(asset.id)}_${kind}_${index}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
}

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function appendValidationEvent(
  store: RunEventStore,
  runId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {}
) {
  const current = await store.get(runId);
  if (!current) throw new Error("asset_validation_run_not_found");
  return store.append({
    runId,
    type,
    expectedVersion: current.version,
    actor: "test-asset-validation",
    idempotencyKey: `${runId}:${type}:${current.version + 1}`,
    payload
  });
}

async function createValidationRun(input: {
  asset: TestAssetV1;
  runId: string;
  store: RunEventStore;
  kind: "repeat" | "mutation";
  index: number;
}) {
  await input.store.create({
    runId: input.runId,
    actor: "test-asset-validation",
    idempotencyKey: `${input.asset.id}:${input.kind}:${input.index}`,
    payload: {
      organizationId: "local",
      projectId: input.asset.projectId,
      runKind: "validation",
      parentRunId: input.asset.sourceRunId,
      coverageItemId: input.asset.coverageItemIds[0],
      testAssetId: input.asset.id,
      validationKind: input.kind,
      validationIndex: input.index,
      sourceRunId: input.asset.sourceRunId
    }
  });
  await appendValidationEvent(input.store, input.runId, "plan_generated", {
    provenance: { source: "test-asset-validation", compilationStatus: "validated", promptVersion: "asset-validation-v1" }
  });
  await appendValidationEvent(input.store, input.runId, "plan_approved", { source: "validation-protocol" });
  await appendValidationEvent(input.store, input.runId, "permission_granted", { source: "validation-protocol" });
  await appendValidationEvent(input.store, input.runId, "run_preparing");
  const started = await appendValidationEvent(input.store, input.runId, "run_started", {
    workerAttemptId: `${input.runId}_attempt_1`,
    executionGeneration: 5
  });
  return started;
}

function replaceMutationExpectation(content: string) {
  const patterns = [
    /(\.toContainText\()(["'`])(?:\\.|(?!\2).)*\2(\))/s,
    /(\.toContain\()(["'`])(?:\\.|(?!\2).)*\2(\))/s
  ];
  for (const pattern of patterns) {
    const mutated = content.replace(pattern, `$1${JSON.stringify(IMPOSSIBLE_EXPECTATION)}$3`);
    if (mutated !== content) return mutated;
  }
  return undefined;
}

function mutationFiles(files: TestAssetFileV1[]) {
  let changed = false;
  return files.map((file) => {
    if (changed) return file;
    const content = replaceMutationExpectation(file.content);
    if (!content) return file;
    changed = true;
    return { ...file, content, sha256: sha256(content) };
  });
}

function commandWithAssetPaths(project: Awaited<ReturnType<typeof getProject>>, paths: string[]): CommandSpec {
  const configured = project?.manifest?.commands.targetedTest;
  const fallback = configured
    ?? (project?.manifest?.commandAllowlist.includes("npx") !== false
      ? { executable: "npx", args: ["playwright", "test"] }
      : project?.manifest?.commandAllowlist.includes("npm")
        ? { executable: "npm", args: ["exec", "--", "playwright", "test"] }
        : project?.manifest?.commands.test ?? project?.testCommandSpec);
  if (!fallback) throw new Error("test_asset_validation_command_missing");
  const replacement = (value: string) => value.replaceAll("{assetPath}", paths[0] ?? "");
  if (fallback.args.some((arg) => arg.includes("{assetPath}"))) {
    return { ...fallback, args: fallback.args.flatMap((arg) => arg.includes("{assetPath}") ? paths.map(replacement) : [arg]) };
  }
  const packageManager = new Set(["npm", "pnpm", "yarn", "bun"]);
  return {
    ...fallback,
    args: [...fallback.args, ...(packageManager.has(fallback.executable) ? ["--"] : []), ...paths]
  };
}

async function writeValidationFiles(input: {
  repositoryRoot: string;
  asset: TestAssetV1;
  files: TestAssetFileV1[];
  kind: "repeat" | "mutation";
  index: number;
}) {
  const directory = await mkdtemp(path.join(input.repositoryRoot, `${GENERATED_ROOT}-${safeName(input.asset.id)}-`));
  const paths: string[] = [];
  try {
    for (const file of input.files) {
      const destination = path.resolve(directory, file.path);
      const relative = path.relative(directory, destination);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("asset_validation_path_escape");
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.content, { encoding: "utf8", mode: 0o600 });
      paths.push(path.relative(input.repositoryRoot, destination).replaceAll(path.sep, "/"));
    }
    return { directory, paths };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function runProjectCommand(input: {
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  repositoryRoot: string;
  asset: TestAssetV1;
  files: TestAssetFileV1[];
  kind: "repeat" | "mutation";
  index: number;
  runId: string;
}) {
  const temporary = await writeValidationFiles({ ...input, repositoryRoot: input.repositoryRoot });
  let startedByExecutor = false;
  let result: Awaited<ReturnType<typeof executeProjectCommand>> | undefined;
  let environmentClean = true;
  try {
    const connection = await testProjectConnection(input.project, { useActiveRuntime: false });
    if (!connection.ok) {
      const runtime = await startProject(input.project.id, {
        runId: input.runId,
        attemptId: `${input.runId}_attempt_1`,
        skipLifecycle: true
      });
      if (runtime.status !== "running") {
        throw new Error(`asset_validation_runtime_unavailable:${runtime.failureReason ?? runtime.message}:${JSON.stringify({
          connection: {
            ok: connection.ok,
            reason: connection.reason,
            frontend: connection.frontend,
            backend: connection.backend,
            health: connection.health,
            processHealth: connection.processHealth
          },
          runtime: {
            status: runtime.status,
            failureReason: runtime.failureReason,
            message: runtime.message,
            frontendUrl: runtime.frontendUrl,
            backendUrl: runtime.backendUrl,
            healthCheckUrl: runtime.healthCheckUrl
          }
        })}`);
      }
      startedByExecutor = true;
    }
    const allowedEnvironment = new Set(input.project.manifest?.environmentAllowlist ?? []);
    const extraEnv = Object.fromEntries(
      ["ATO_APP_URL", "PLAYWRIGHT_BASE_URL", "BASE_URL"]
        .filter((name) => !input.project.manifest || allowedEnvironment.has(name))
        .map((name) => [name, input.project.frontendUrl])
    );
    const command = commandWithAssetPaths(input.project, temporary.paths);
    result = await executeProjectCommand({
      projectId: input.project.id,
      project: input.project,
      command,
      cwd: input.repositoryRoot,
      timeoutMs: command.timeoutMs ?? input.project.manifest?.budget.scenarioTimeoutMs ?? input.project.timeoutMs ?? 120_000,
      extraEnv
    });
  } catch (error: unknown) {
    environmentClean = false;
    result = { ok: false, failureReason: "unknown", stderr: error instanceof Error ? error.message : String(error), stdout: "" };
  } finally {
    if (startedByExecutor) {
      const stopped = await stopProject(input.project.id).catch(() => undefined);
      if (!stopped || stopped.status !== "stopped") environmentClean = false;
    }
    await rm(temporary.directory, { recursive: true, force: true });
  }
  return { result, environmentClean };
}

async function finishValidationRun(input: {
  store: RunEventStore;
  runId: string;
  asset: TestAssetV1;
  kind: "repeat" | "mutation";
  index: number;
  passed: boolean;
  cleanEnvironment: boolean;
  result?: { ok: boolean; failureReason?: string; stderr?: string; stdout?: string };
}) {
  const reportFile = path.join(getReportsDir(), "runs", input.runId, "asset-validation.json");
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, JSON.stringify({
    schemaVersion: "asset-validation-attempt.v1",
    assetId: input.asset.id,
    kind: input.kind,
    index: input.index,
    passed: input.passed,
    cleanEnvironment: input.cleanEnvironment,
    result: input.result
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  const evidence = await appendEvidence(input.runId, {
    type: "operation",
    title: `Test asset ${input.kind} ${input.index} ${input.passed ? "passed" : "failed"}`,
    file: `/artifacts/runs/${input.runId}/asset-validation.json`,
    payload: {
      assetId: input.asset.id,
      kind: input.kind,
      index: input.index,
      passed: input.passed,
      cleanEnvironment: input.cleanEnvironment,
      failureReason: input.result?.failureReason,
      error: input.result?.stderr?.slice(-1_600)
    }
  });
  await appendValidationEvent(input.store, input.runId, "evidence_collecting", { evidenceRefs: [evidence.id] });
  await appendValidationEvent(input.store, input.runId, "run_judging", { evidenceRefs: [evidence.id] });
  if (input.cleanEnvironment) {
    await appendValidationEvent(input.store, input.runId, "run_completed", {
      finalStatus: input.passed ? "pass" : "fail",
      executionStatus: "completed",
      evidenceRefs: [evidence.id]
    });
  } else {
    await appendValidationEvent(input.store, input.runId, "run_blocked", {
      finalStatus: "blocked",
      executionStatus: "infrastructure-failed",
      evidenceRefs: [evidence.id]
    });
  }
  return evidence.id;
}

async function runAttempt(input: {
  asset: TestAssetV1;
  store: RunEventStore;
  files: TestAssetFileV1[];
  kind: "repeat" | "mutation";
  index: number;
}) {
  const runId = validationRunId(input.asset, input.kind, input.index);
  await createValidationRun({ ...input, runId });
  const project = await getProject(input.asset.projectId);
  if (!project) {
    const evidenceRef = await finishValidationRun({ ...input, runId, passed: false, cleanEnvironment: false, result: { ok: false, failureReason: "project_not_found" } });
    return { runId, passed: false, cleanEnvironment: false, evidenceRefs: [evidenceRef] };
  }
  const repositoryRoot = safeProjectPath(project);
  if (path.resolve(repositoryRoot) !== path.resolve(input.asset.sourceRepositoryRoot)) {
    const evidenceRef = await finishValidationRun({ ...input, runId, passed: false, cleanEnvironment: false, result: { ok: false, failureReason: "asset_repository_root_mismatch" } });
    return { runId, passed: false, cleanEnvironment: false, evidenceRefs: [evidenceRef] };
  }
  const execution = await runProjectCommand({ ...input, project, repositoryRoot, runId });
  const passed = Boolean(execution.result?.ok);
  const evidenceRef = await finishValidationRun({
    ...input,
    runId,
    passed,
    cleanEnvironment: execution.environmentClean,
    result: execution.result
  });
  return { runId, passed, cleanEnvironment: execution.environmentClean, evidenceRefs: [evidenceRef] };
}

export function createDefaultTestAssetValidationExecutor(input: { runStore?: RunEventStore } = {}): TestAssetValidationExecutor {
  const store = input.runStore ?? runEventStore;
  return {
    async runCleanRepetition({ asset, repetition }) {
      return runAttempt({ asset, store, files: asset.files, kind: "repeat", index: repetition });
    },
    async runMutation({ asset, mutation }) {
      const mutated = mutationFiles(asset.files);
      const changed = mutated.some((file, index) => file.content !== asset.files[index]?.content);
      if (!changed) {
        const evidence = await appendEvidence(asset.sourceRunId, {
          type: "operation",
          title: "Test asset mutation has no safe assertion target",
          payload: { assetId: asset.id, mutation, killed: false }
        });
        return { killed: false, evidenceRefs: [evidence.id] };
      }
      const result = await runAttempt({ asset, store, files: mutated, kind: "mutation", index: mutation });
      return { killed: !result.passed, evidenceRefs: result.evidenceRefs };
    },
    async securityScan({ asset }) {
      try {
        validateTestAssetFiles(asset.files);
        for (const file of asset.files) {
          if (/\b(?:eval|Function)\s*\(|import\s*\(/.test(file.content)) throw new Error("asset_dynamic_code_forbidden");
          const imports = [...file.content.matchAll(/\b(?:from|import|require\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
          if (imports.some((specifier) => !["@playwright/test", "playwright/test"].includes(specifier) && !specifier.startsWith("./") && !specifier.startsWith("../"))) {
            throw new Error("asset_dependency_not_allowlisted");
          }
        }
        const evidence = await appendEvidence(asset.sourceRunId, {
          type: "operation",
          title: "Test asset security scan passed",
          payload: { assetId: asset.id, filePaths: asset.files.map((file) => file.path), dependencyPolicy: "playwright-and-local-only" }
        });
        return { passed: true, evidenceRefs: [evidence.id] };
      } catch (error: unknown) {
        const evidence = await appendEvidence(asset.sourceRunId, {
          type: "operation",
          title: "Test asset security scan blocked",
          payload: { assetId: asset.id, reason: error instanceof Error ? error.message : String(error) }
        });
        return { passed: false, evidenceRefs: [evidence.id] };
      }
    }
  };
}
