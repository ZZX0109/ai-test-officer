import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CommandSpec,
  OracleSpecV2,
  TestDataStageV1
} from "@ai-test-officer/contracts";
import { testDataPhaseReceiptV1Schema } from "@ai-test-officer/contracts";
import { AttemptClock, commitCapturedFile } from "@ai-test-officer/playwright-runtime";
import { canonicalSha256 } from "./canonicalHash.js";
import { appendEvidence, getReportsDir } from "./evidenceStore.js";
import { executeProjectCommand, getProject, safeProjectPath, startProjectConfig, stopProject } from "./projectAdapter.js";
import { runEventStore, type RunEventStore } from "./runEventStore.js";
import { getReliabilityAssetStore, type ReliabilityAssetStore } from "./reliabilityAssetStore.js";
import { evaluateOracleSet } from "./oracleGovernance.js";
import { executeTestDataLifecycle } from "./testDataContract.js";
import { executeDifferentialRun, type DifferentialClassificationResult, type DifferentialSideExecutionResult } from "./differentialRunService.js";

const execFileAsync = promisify(execFile);

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "diff";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function git(root: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

function projectTestCommand(project: NonNullable<Awaited<ReturnType<typeof getProject>>>): CommandSpec {
  const configured = project.manifest?.commands.targetedTest ?? project.manifest?.commands.test ?? project.testCommandSpec;
  if (configured) return configured;
  return { executable: "npx", args: ["playwright", "test"] };
}

function allowedEnvironment(project: NonNullable<Awaited<ReturnType<typeof getProject>>>, appUrl: string, namespace: string, runId: string) {
  const values = {
    ATO_APP_URL: appUrl,
    PLAYWRIGHT_BASE_URL: appUrl,
    BASE_URL: appUrl,
    ATO_TEST_DATA_NAMESPACE: namespace,
    ATO_TEST_DATA_RUN_ID: runId
  };
  const allowlist = new Set(project.manifest?.environmentAllowlist ?? []);
  return Object.fromEntries(Object.entries(values).filter(([name]) => !project.manifest || allowlist.has(name)));
}

function hasRuntimeCommand(project: NonNullable<Awaited<ReturnType<typeof getProject>>>) {
  return Boolean(project.manifest?.commands.start || project.startCommandSpec || project.startCommand?.trim() || project.processes?.length);
}

async function prepareWorktree(input: { repositoryRoot: string; revision: string; label: string }) {
  const gitRoot = await git(input.repositoryRoot, ["rev-parse", "--show-toplevel"]);
  const sourceRelative = path.relative(gitRoot, input.repositoryRoot);
  // Keep the temporary worktree under the project root. This lets an internal
  // trusted-local project pass the existing path policy while still keeping
  // Base/Head source trees separate; external projects remain subject to the
  // manifest's OCI requirement.
  const parent = await mkdtemp(path.join(input.repositoryRoot, `.ato-differential-${safeName(input.label)}-`));
  const worktree = path.join(parent, "repo");
  try {
    await git(gitRoot, ["worktree", "add", "--detach", worktree, input.revision]);
    return { gitRoot, parent, worktree, sourceRelative };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function removeWorktree(input: { gitRoot: string; parent: string; worktree: string }) {
  await git(input.gitRoot, ["worktree", "remove", "--force", input.worktree]).catch(() => undefined);
  await rm(input.parent, { recursive: true, force: true });
}

async function reuseLocalDependencies(input: { sourceRoot: string; projectRoot: string }) {
  const sourceCandidates = [
    path.join(input.sourceRoot, "node_modules"),
    path.resolve(input.sourceRoot, "..", "node_modules")
  ];
  const sourceDependencies = (await Promise.all(sourceCandidates.map(async (candidate) => {
    try {
      return (await readdir(candidate)).length > 2 ? candidate : undefined;
    } catch {
      return undefined;
    }
  }))).find(Boolean);
  if (!sourceDependencies) return;
  const targetDependencies = path.join(input.projectRoot, "node_modules");
  try {
    await access(sourceDependencies);
    await access(targetDependencies);
    return;
  } catch {
    // The revision worktree intentionally contains source files only. Reuse
    // the immutable dependency tree through a symlink for trusted-local
    // execution; OCI execution excludes it and uses the manifest cache/image.
  }
  try {
    await access(sourceDependencies);
    await symlink(sourceDependencies, targetDependencies, "dir");
  } catch {
    // The command will report a bounded dependency failure with evidence.
  }
}

async function appendSideEvent(store: RunEventStore, runId: string, type: Parameters<RunEventStore["append"]>[0]["type"], payload: Record<string, unknown> = {}) {
  const current = await store.get(runId);
  if (!current) throw new Error("differential_side_run_not_found");
  return store.append({
    runId,
    type,
    expectedVersion: current.version,
    actor: "differential-executor",
    idempotencyKey: `${runId}:${type}:${current.version + 1}`,
    payload
  });
}

async function prepareSideRun(store: RunEventStore, runId: string) {
  const current = await store.get(runId);
  if (!current) throw new Error("differential_side_run_not_found");
  if (current.state !== "planning") return current;
  await appendSideEvent(store, runId, "plan_generated", {
    provenance: { source: "differential-default-executor", compilationStatus: "validated", promptVersion: "differential-v1" }
  });
  await appendSideEvent(store, runId, "plan_approved", { source: "differential-request" });
  await appendSideEvent(store, runId, "permission_granted", { source: "differential-request" });
  await appendSideEvent(store, runId, "run_preparing");
  return appendSideEvent(store, runId, "run_started", {
    workerAttemptId: `${runId}_attempt_1`,
    executionGeneration: 5
  });
}

async function writeSideArtifact(input: {
  runId: string;
  side: "base" | "head";
  revision: string;
  payload: Record<string, unknown>;
}) {
  const clock = new AttemptClock();
  const directory = path.join(getReportsDir(), "runs", input.runId);
  const finalPath = path.join(directory, `differential-${input.side}.json`);
  const temporaryPath = `${finalPath}.partial`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, JSON.stringify({
    schemaVersion: "differential-side-execution.v1",
    side: input.side,
    revision: input.revision,
    ...input.payload
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  return commitCapturedFile({
    temporaryPath,
    finalPath,
    id: `${input.runId}_differential_${input.side}`,
    identity: { runId: input.runId, scenarioId: `differential-${input.side}`, attemptId: `${input.runId}_attempt_1`, attempt: 1 },
    stepId: "differential-execution",
    kind: "operation-log",
    mediaType: "application/json",
    storageUri: `/artifacts/runs/${input.runId}/${path.basename(finalPath)}`,
    clock,
    collectorVersion: "0.2.0"
  });
}

async function runDataStage(input: {
  stage: TestDataStageV1;
  namespace: string;
  runId: string;
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  repositoryRoot: string;
  command: CommandSpec;
  appUrl: string;
}) {
  const command = input.stage.commandRef === "migrate"
    ? input.project.manifest?.commands.migrate
    : input.stage.commandRef === "seed"
      ? input.project.manifest?.commands.seed
      : input.stage.commandRef === "cleanup"
        ? input.project.manifest?.commands.cleanup
        : input.stage.stage === "execute" ? input.command : undefined;
  if (!command) {
    return input.stage.commandRef || input.stage.stage === "execute"
      ? { status: "blocked" as const, error: `test_data_command_missing:${input.stage.commandRef ?? input.stage.stage}` }
      : { status: "passed" as const };
  }
  const result = await executeProjectCommand({
    projectId: input.project.id,
    project: input.project,
    command,
    cwd: input.repositoryRoot,
    timeoutMs: command.timeoutMs ?? input.project.manifest?.budget.scenarioTimeoutMs ?? input.project.timeoutMs ?? 120_000,
    extraEnv: allowedEnvironment(input.project, input.appUrl, input.namespace, input.runId)
  });
  if (result.ok) return { status: "passed" as const };
  // Keep the failure class and a bounded, already-redacted command tail in
  // the phase receipt. Without this, every external project collapsed to the
  // same `test_data_stage_failed:execute` signature and the differential
  // classifier had to return inconclusive even when both revisions had the
  // same reproducible defect.
  const reason = result.failureReason ?? "differential_command_failed";
  const diagnostic = [result.stderr, result.stdout]
    .filter((value) => Boolean(value?.trim()))
    .join("\n")
    .trim()
    .slice(-1_600);
  return {
    status: "failed" as const,
    error: `${reason}${diagnostic ? `: ${diagnostic}` : ""}`.slice(-2_000)
  };
}

async function executeSide(input: {
  side: "base" | "head";
  revision: string;
  runId: string;
  projectId: string;
  dataContractId: string;
  randomSeed: number;
  testTime: string;
  oracleSpecIds: string[];
  runStore: RunEventStore;
  assetStore: ReliabilityAssetStore;
}): Promise<DifferentialSideExecutionResult> {
  const project = await getProject(input.projectId);
  if (!project) throw new Error("differential_project_not_found");
  const repositoryRoot = safeProjectPath(project);
  const worktree = await prepareWorktree({ repositoryRoot, revision: input.revision, label: `${input.runId}-${input.side}` });
  const sideRoot = path.resolve(worktree.worktree, worktree.sourceRelative);
  if (project.manifest?.execution.mode !== "oci") await reuseLocalDependencies({ sourceRoot: repositoryRoot, projectRoot: sideRoot });
  const sideProject = {
    ...project,
    id: `${safeName(input.runId)}-${input.side}`,
    projectPath: sideRoot,
    allowExternalProjectPath: project.allowExternalProjectPath
  };
  const command = projectTestCommand(sideProject);
  const environmentHash = canonicalSha256({
    manifest: sideProject.manifest,
    command,
    ociImage: sideProject.manifest?.execution.image,
    browserVersion: "playwright-managed",
    randomSeed: input.randomSeed,
    testTime: input.testTime
  });
  let started = false;
  let testResult: { ok: boolean; failureReason?: string; stdout?: string; stderr?: string } | undefined;
  let lifecycle: Awaited<ReturnType<typeof executeTestDataLifecycle>> | undefined;
  let artifactIds: string[] = [];
  let evidenceRefs: string[] = [];
  try {
    await prepareSideRun(input.runStore, input.runId);
    if (hasRuntimeCommand(sideProject)) {
      const runtime = await startProjectConfig(sideProject, { runId: input.runId, attemptId: `${input.runId}_attempt_1`, skipLifecycle: true });
      if (runtime.status !== "running") throw new Error(`differential_runtime_unavailable:${runtime.failureReason ?? runtime.message}:${JSON.stringify({
        status: runtime.status,
        failureReason: runtime.failureReason,
        message: runtime.message,
        frontendUrl: runtime.frontendUrl,
        healthCheckUrl: runtime.healthCheckUrl,
        processes: runtime.processes,
        output: runtime.message?.match(/(?:stdout|stderr)=([\s\S]*)$/)?.[1]
      })}`);
      started = true;
    }
    const dataContract = await input.assetStore.getDataContract(input.dataContractId);
    if (!dataContract) throw new Error("differential_data_contract_not_found");
    lifecycle = await executeTestDataLifecycle({
      contract: dataContract,
      runId: input.runId,
      childRunId: input.runId,
      adapter: {
        runStage: (stage, context) => runDataStage({
          stage,
          namespace: context.namespace,
          runId: input.runId,
          project: sideProject,
          repositoryRoot: sideRoot,
          command,
          appUrl: sideProject.frontendUrl
        })
      }
    });
    const executeReceipt = lifecycle.receipts.find((receipt) => receipt.stage === "execute");
    const failureSignature = executeReceipt?.status === "failed"
      ? executeReceipt.error
        ? digest(executeReceipt.error)
        : "execute_failed"
      : undefined;
    testResult = {
      ok: lifecycle.status === "passed" && executeReceipt?.status === "passed",
      failureReason: lifecycle.reason,
      ...(failureSignature ? { failureSignature } : {})
    };
    const phaseEvidenceRefs = await Promise.all(lifecycle.receipts.map(async (receipt) => {
      const evidence = await appendEvidence(input.runId, {
        type: "operation",
        title: `Differential ${input.side} data stage ${receipt.stage}`,
        payload: { side: input.side, revision: input.revision, receipt }
      });
      return evidence.id;
    }));
    lifecycle = {
      ...lifecycle,
      receipts: lifecycle.receipts.map((receipt, index) => testDataPhaseReceiptV1Schema.parse({
        ...receipt,
        evidenceRefs: [...new Set([...receipt.evidenceRefs, phaseEvidenceRefs[index]])]
      }))
    };
    const artifact = await writeSideArtifact({
      runId: input.runId,
      side: input.side,
      revision: input.revision,
      payload: { command, environmentHash, lifecycle, testResult }
    });
    artifactIds = [artifact.id];
    lifecycle = {
      ...lifecycle,
      receipts: lifecycle.receipts.map((receipt) => testDataPhaseReceiptV1Schema.parse({
        ...receipt,
        artifactIds: [...new Set([...receipt.artifactIds, artifact.id])]
      }))
    };
    await input.assetStore.appendDataReceipts(lifecycle.receipts);
    const evidence = await appendEvidence(input.runId, {
      type: "operation",
      title: `Differential ${input.side} execution`,
      file: artifact.storageUri,
      artifactIds,
      payload: { revision: input.revision, environmentHash, lifecycleStatus: lifecycle.status, testResult, phaseEvidenceRefs }
    });
    evidenceRefs = [...phaseEvidenceRefs, evidence.id];
    const specs: OracleSpecV2[] = (await Promise.all(input.oracleSpecIds.map((id) => input.assetStore.getOracle(id)))).filter((item): item is OracleSpecV2 => Boolean(item));
    const supported = specs.length === input.oracleSpecIds.length
      && specs.every((spec) => spec.comparison.operator === "equals" && spec.comparison.expected === true);
    const oracleEvaluation = specs.length !== input.oracleSpecIds.length
      ? { status: "blocked" as const, decisions: [], releaseEligible: false, differentialEligible: false }
      : evaluateOracleSet(
        specs,
        Object.fromEntries(specs.map((spec) => [spec.id, supported ? testResult?.ok : undefined])),
        { differential: true, evidenceRefs }
      );
    await appendSideEvent(input.runStore, input.runId, "evidence_collecting", { evidenceRefs, artifactIds });
    await appendSideEvent(input.runStore, input.runId, "run_judging", { evidenceRefs, artifactIds });
    if (lifecycle.status === "blocked" || lifecycle.orphaned || oracleEvaluation.status === "blocked") {
      await appendSideEvent(input.runStore, input.runId, "run_blocked", { finalStatus: "blocked", evidenceRefs, artifactIds });
    } else {
      await appendSideEvent(input.runStore, input.runId, "run_completed", {
        finalStatus: oracleEvaluation.status,
        executionStatus: "completed",
        evidenceRefs,
        artifactIds
      });
    }
    const final = await input.runStore.get(input.runId);
    return {
      state: final?.state ?? "completed",
      gateStatus: lifecycle.status === "blocked" || lifecycle.orphaned ? "blocked" : oracleEvaluation.status,
      oracleDecisions: oracleEvaluation.decisions,
      artifactIds,
      evidenceRefs,
      failureSignature: "failureSignature" in (testResult ?? {})
        ? (testResult as { failureSignature?: string }).failureSignature
        : testResult?.failureReason,
      environmentHash,
      repetitionsStable: true,
      visualDifferenceOnly: false
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const evidence = await appendEvidence(input.runId, {
      type: "operation",
      title: `Differential ${input.side} execution blocked`,
      payload: { side: input.side, revision: input.revision, reason }
    }).catch(() => undefined);
    if (evidence) evidenceRefs = [...evidenceRefs, evidence.id];
    const current = await input.runStore.get(input.runId);
    if (current && ["planning", "awaiting-plan-approval", "awaiting-permission", "queued", "preparing", "running", "collecting", "judging"].includes(current.state)) {
      await appendSideEvent(input.runStore, input.runId, "run_blocked", {
        finalStatus: "blocked",
        executionStatus: "infrastructure-failed",
        evidenceRefs
      }).catch(() => undefined);
    }
    const final = await input.runStore.get(input.runId);
    return {
      state: final?.state ?? "blocked",
      gateStatus: "blocked",
      oracleDecisions: [],
      artifactIds,
      evidenceRefs,
      failureSignature: reason,
      environmentHash,
      repetitionsStable: false,
      visualDifferenceOnly: false
    };
  } finally {
    if (started) await stopProject(sideProject.id, sideProject).catch(() => undefined);
    await removeWorktree(worktree);
  }
}

export async function executeDifferentialRunWithDefaultExecutor(input: {
  id: string;
  runStore?: RunEventStore;
  assetStore?: ReliabilityAssetStore;
}): Promise<Awaited<ReturnType<typeof executeDifferentialRun>>> {
  const runStore = input.runStore ?? runEventStore;
  const assetStore = input.assetStore ?? getReliabilityAssetStore();
  return executeDifferentialRun({
    id: input.id,
    store: assetStore,
    runStore,
    parallel: false,
    execute: (side) => executeSide({ ...side, runStore, assetStore })
  });
}

export function classifyDefaultDifferentialFailure(error: unknown): DifferentialClassificationResult {
  return { classification: "environment-difference", reasons: [error instanceof Error ? digest(error.message) : "differential_executor_failed"] };
}
