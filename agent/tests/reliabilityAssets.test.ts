import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  oracleSpecV2Schema,
  testDataContractV1Schema,
  type TestDataContractV1
} from "@ai-test-officer/contracts";
import { evaluateOracleSpec, evaluateOracleSet } from "../src/oracleGovernance.js";
import { classifyDifferential, createDifferentialRun, executeDifferentialRun } from "../src/differentialRunService.js";
import { rankCoverageItems } from "../src/adaptivePathStrategy.js";
import { executeTestDataLifecycle, recoverOrphanedTestData } from "../src/testDataContract.js";
import { FileReliabilityAssetStore } from "../src/reliabilityAssetStore.js";
import { createTestAsset, applyTestAsset, repositorySnapshotHash, validateTestAsset } from "../src/testAssetService.js";
import { FileWriteSafetyStore } from "../src/write-safety/writeSafety.js";
import { getWriteSafetyLayer } from "../src/write-safety/index.js";
import { appendEvidence, setReportsDir } from "../src/evidenceStore.js";
import type { RunEventStore, RunProjection } from "../src/runEventStore.js";

const execFileAsync = promisify(execFile);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function oracle(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return oracleSpecV2Schema.parse({
    schemaVersion: "2.0",
    id: "oracle-trusted",
    projectId: "project-1",
    coverageItemId: "coverage-1",
    type: "dom",
    description: "页面包含已完成状态",
    preconditions: ["页面可访问"],
    observationWindow: { start: "after-action", timeoutMs: 1000, pollIntervalMs: 100 },
    comparison: { operator: "contains", expected: "completed" },
    source: { kind: "formal-contract", id: "contract-1", version: "1.0", sha256: "a".repeat(64) },
    decisionUse: "release",
    conflictRefs: [],
    humanConfirmation: { status: "not-required" },
    lifecycle: { status: "active" },
    runEvidence: { runId: "run-1", evidenceRefs: ["evidence-1"], artifactIds: ["artifact-1"] },
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

function makeRun(id: string): RunProjection {
  const now = new Date().toISOString();
  return { id, state: "completed", version: 1, createdAt: now, updatedAt: now, input: { projectId: "project-1", organizationId: "local" }, runKind: "parent", gateStatus: "pass", outcomeSummary: { schemaVersion: "2.0", schedulingCompleted: true, executionStarted: true, executionSucceeded: true, requirementCovered: true, requirementPassed: true, artifactIntegrityVerified: true, evidenceGrounded: true, gateEligible: true, finalStatus: "pass" } };
}

function fakeRunStore(run: RunProjection): RunEventStore {
  return {
    create: async () => run,
    append: async () => run,
    get: async () => run,
    events: async () => []
  };
}

function aggregateRunStore(id: string) {
  const now = new Date().toISOString();
  let parent: RunProjection = {
    id,
    state: "planning",
    version: 1,
    createdAt: now,
    updatedAt: now,
    input: { projectId: "project-1", organizationId: "local" },
    runKind: "parent"
  };
  const eventTypes: string[] = [];
  const store: RunEventStore = {
    create: async () => parent,
    append: async (input) => {
      eventTypes.push(input.type);
      parent = {
        ...parent,
        state: input.type === "parent_aggregate_completed" ? "completed" : input.type === "parent_aggregate_blocked" ? "blocked" : parent.state,
        gateStatus: input.type === "parent_aggregate_blocked" ? "blocked" : input.payload.finalStatus as RunProjection["gateStatus"],
        version: parent.version + 1,
        updatedAt: new Date().toISOString()
      };
      return parent;
    },
    get: async (runId) => runId === id ? parent : undefined,
    events: async () => []
  };
  return { store, get parent() { return parent; }, eventTypes };
}

function dataContract(): TestDataContractV1 {
  const now = new Date().toISOString();
  return testDataContractV1Schema.parse({
    schemaVersion: "1.0",
    id: "tdc-project-1",
    projectId: "project-1",
    coverageItemIds: ["coverage-1"],
    dataSources: [{ id: "db", kind: "sqlite", readOnly: false }],
    credentialRefs: ["credential-db"],
    namespace: { strategy: "run-child-seed", prefix: "ato" },
    randomSeed: 42,
    testTime: now,
    roles: [{ id: "operator", permissions: ["read"] }],
    stages: ["prepare", "namespace", "migrate", "seed", "snapshot", "execute", "cleanup", "rollback", "verify-clean"].map((stage) => ({ stage, required: stage !== "rollback" })),
    createdAt: now,
    updatedAt: now
  });
}

export async function testReliabilityAssets() {
  const trusted = oracle();
  assert.equal(evaluateOracleSpec(trusted, { actual: "completed", differential: false }).status, "pass");
  assert.equal(evaluateOracleSpec(oracle({ source: { ...trusted.source, kind: "llm-inference" }, decisionUse: "review-only" }), { actual: "completed" }).status, "needs-human-review");
  assert.equal(evaluateOracleSpec(oracle({ conflictRefs: ["oracle-conflict"] }), { actual: "completed" }).status, "blocked");
  assert.equal(evaluateOracleSpec(oracle({ lifecycle: { status: "expired" } }), { actual: "completed" }).status, "blocked");
  const oracleSet = evaluateOracleSet([trusted], { [trusted.id]: "wrong" });
  assert.equal(oracleSet.status, "fail");

  assert.deepEqual(classifyDifferential({ baseGateStatus: "pass", headGateStatus: "fail" }).classification, "introduced-regression");
  assert.deepEqual(classifyDifferential({ baseGateStatus: "fail", headGateStatus: "pass" }).classification, "fixed-by-change");
  assert.deepEqual(classifyDifferential({ baseGateStatus: "fail", headGateStatus: "fail", baseFailureSignature: "same", headFailureSignature: "same" }).classification, "pre-existing-defect");
  assert.deepEqual(classifyDifferential({ baseGateStatus: "pass", headGateStatus: "fail", baseEnvironmentHash: "a", headEnvironmentHash: "b" }).classification, "environment-difference");
  assert.deepEqual(classifyDifferential({ baseGateStatus: "pass", headGateStatus: "pass", visualDifferenceOnly: true }).classification, "inconclusive");

  const ranked = rankCoverageItems({
    items: [{ schemaVersion: "1.0", id: "low", runId: "r", flowId: "f", module: "m", surface: "page", risk: "low", disposition: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { schemaVersion: "1.0", id: "high", runId: "r", flowId: "f", module: "m", surface: "page", risk: "high", disposition: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
  });
  assert.equal(ranked.items[0]?.id, "high");
  assert.equal(ranked.items.length, 2);

  const data = dataContract();
  const stages: string[] = [];
  const lifecycle = await executeTestDataLifecycle({ contract: data, runId: "run-1", childRunId: "child-1", adapter: { runStage: async (stage) => { stages.push(stage.stage); return { status: "passed", evidenceRefs: [`e-${stage.stage}`] }; } } });
  assert.equal(lifecycle.status, "passed");
  assert.equal(lifecycle.orphaned, false);
  assert.equal(stages.includes("cleanup"), true);
  assert.notEqual(lifecycle.namespace, (await executeTestDataLifecycle({ contract: data, runId: "run-1", childRunId: "child-2", adapter: { runStage: async () => ({ status: "passed" }) } })).namespace);
  const recovered = await recoverOrphanedTestData({ contract: data, runId: "run-1", childRunId: "child-crashed", adapter: { runStage: async (stage) => stage.stage === "cleanup" ? { status: "failed" } : { status: "passed" } } });
  assert.equal(recovered.status, "blocked");

  const root = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-assets-"));
  const reports = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-asset-reports-"));
  try {
    const concurrentStateFile = path.join(reports, "concurrent-load", "state.json");
    await mkdir(path.dirname(concurrentStateFile), { recursive: true });
    await writeFile(concurrentStateFile, JSON.stringify({
      oracles: [trusted],
      dataContracts: [data],
      dataReceipts: [],
      differentialRuns: [],
      testAssets: [],
      reliabilityEvidence: []
    }));
    const concurrentStore = new FileReliabilityAssetStore(concurrentStateFile);
    const [loadedOracle, loadedContracts] = await Promise.all([
      concurrentStore.getOracle(trusted.id),
      concurrentStore.listDataContracts(data.projectId)
    ]);
    assert.equal(loadedOracle?.id, trusted.id);
    assert.equal(loadedContracts[0]?.id, data.id);

    await execFileAsync("git", ["-C", root, "init", "-q"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(path.join(root, "README.md"), "asset target\n");
    await execFileAsync("git", ["-C", root, "add", "README.md"]);
    await execFileAsync("git", ["-C", root, "commit", "-qm", "initial"]);
    const repositorySha256 = await repositorySnapshotHash(root);
    const store = new FileReliabilityAssetStore(path.join(reports, "state.json"));
    await store.putOracle(trusted);
    setReportsDir(reports);
    const sourceEvidence = await appendEvidence("run-1", { type: "operation", title: "trusted source evidence", payload: {} });
    const differential = await createDifferentialRun({
      store,
      runStore: fakeRunStore(makeRun("diff-parent")),
      request: {
        schemaVersion: "1.0",
        organizationId: "local",
        projectId: "project-1",
        baseRevision: "base-commit",
        headRevision: "head-commit",
        planHash: "b".repeat(64),
        dataContractId: data.id,
        dataContract: data,
        oracleSpecIds: [trusted.id],
        oracleSpecs: [trusted],
        environmentHash: "c".repeat(64),
        randomSeed: data.randomSeed,
        testTime: data.testTime,
        idempotencyKey: "diff-idempotency-1"
      }
    });
    const executedDifferential = await executeDifferentialRun({
      id: differential.id,
      store,
      execute: async (side) => ({
        state: "completed",
        gateStatus: "pass",
        environmentHash: "d".repeat(64),
        evidenceRefs: [`${side.side}-evidence`],
        artifactIds: [`${side.side}-artifact`]
      })
    });
    assert.equal(executedDifferential.status, "completed");
    assert.equal(executedDifferential.pairManifest.classification, "expected-change");
    assert.equal(executedDifferential.pairManifest.environmentHash, "d".repeat(64));
    assert.equal(executedDifferential.pairManifest.dataContractId, data.id);
    const aggregate = aggregateRunStore("diff-parent-aggregate");
    const aggregateDifferential = await createDifferentialRun({
      store,
      runStore: aggregate.store,
      request: {
        schemaVersion: "1.0",
        id: "diff-parent-aggregate",
        organizationId: "local",
        projectId: "project-1",
        baseRevision: "base-aggregate",
        headRevision: "head-aggregate",
        planHash: "b".repeat(64),
        dataContractId: data.id,
        oracleSpecIds: [trusted.id],
        environmentHash: "c".repeat(64),
        randomSeed: data.randomSeed,
        testTime: data.testTime,
        idempotencyKey: "diff-parent-aggregate-idempotency"
      }
    });
    await executeDifferentialRun({
      id: aggregateDifferential.id,
      store,
      runStore: aggregate.store,
      execute: async () => ({ state: "completed", gateStatus: "pass", environmentHash: "c".repeat(64), evidenceRefs: ["e"], artifactIds: ["a"] })
    });
    assert.equal(aggregate.parent.state, "completed");
    assert.equal(aggregate.eventTypes.includes("parent_aggregate_completed"), true);
    await assert.rejects(
      () => createDifferentialRun({
        store,
        runStore: fakeRunStore(makeRun("diff-parent-hash-mismatch")),
        request: {
          schemaVersion: "1.0",
          organizationId: "local",
          projectId: "project-1",
          baseRevision: "base-commit-2",
          headRevision: "head-commit-2",
          plan: { action: "different" },
          planHash: "b".repeat(64),
          dataContractId: data.id,
          oracleSpecIds: [trusted.id],
          environmentHash: "c".repeat(64),
          randomSeed: data.randomSeed,
          testTime: data.testTime,
          idempotencyKey: "diff-idempotency-hash-mismatch"
        }
      }),
      /plan_hash_mismatch/
    );
    const asset = await createTestAsset({
      store,
      runStore: fakeRunStore(makeRun("run-1")),
      request: { projectId: "project-1", sourceRunId: "run-1", coverageItemIds: ["coverage-1"], oracleSpecIds: [trusted.id], oracleSpecs: [trusted], evidenceRefs: [sourceEvidence.id], files: [], format: "playwright-ts", repositoryRoot: root, repositorySha256 }
    });
    assert.equal(asset.status, "candidate");
    assert.equal((await store.readReliabilityEvidence("run-1")).some((item) => item.payload.assetId === asset.id), true);
    const persistedAfterCreate = JSON.parse(await readFile(path.join(reports, "state.json"), "utf8")) as { reliabilityOutbox?: Array<{ entityId: string; operation: string }> };
    assert.equal(persistedAfterCreate.reliabilityOutbox?.some((item) => item.entityId === asset.id && item.operation === "created"), true);
    const validated = await validateTestAsset({ id: asset.id, store, runStore: fakeRunStore(makeRun("r1")), request: { repetitions: 3, mutationTotal: 1, mutationKilled: 1, securityPassed: true, runIds: ["r1", "r2", "r3"], evidenceRefs: ["validation-evidence"] } });
    assert.equal(validated.status, "ready-for-review");
    getWriteSafetyLayer({ store: new FileWriteSafetyStore(path.join(reports, "write-safety.json")) });
    const applied = await applyTestAsset({ id: asset.id, store, request: { capabilityGrantId: "grant-1", confirmedBy: "reviewer-1", expectedRepositorySha256: repositorySha256 } });
    assert.equal(applied.committed, false);
    assert.equal(applied.pushed, false);
    assert.match(applied.branch, /^codex\/ai-test-assets-run-1$/);

    // A detached checkout is a supported review starting point. Force a
    // failure after the temporary branch has been created and the first file
    // has been written; the service must restore both the detached HEAD and
    // the original worktree, and must remove only its temporary branch.
    const detachedRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-detached-assets-"));
    try {
      await execFileAsync("git", ["-C", detachedRoot, "init", "-q"]);
      await execFileAsync("git", ["-C", detachedRoot, "config", "user.email", "test@example.com"]);
      await execFileAsync("git", ["-C", detachedRoot, "config", "user.name", "Test"]);
      await mkdir(path.join(detachedRoot, "tests"), { recursive: true });
      await writeFile(path.join(detachedRoot, "tests", "keep.txt"), "keep\n");
      // This regular file makes the second generated destination fail only
      // after the first destination has succeeded.
      await writeFile(path.join(detachedRoot, "tests", "conflict"), "not-a-directory\n");
      await execFileAsync("git", ["-C", detachedRoot, "add", "-A"]);
      await execFileAsync("git", ["-C", detachedRoot, "commit", "-qm", "detached initial"]);
      const detachedHead = (await execFileAsync("git", ["-C", detachedRoot, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", detachedRoot, "switch", "--detach", detachedHead]);
      const detachedHash = await repositorySnapshotHash(detachedRoot);
      const detachedEvidence = await appendEvidence("run-detached", { type: "operation", title: "trusted detached source evidence", payload: {} });
      const detachedAsset = await createTestAsset({
        store,
        runStore: fakeRunStore(makeRun("run-detached")),
        request: {
          projectId: "project-1",
          sourceRunId: "run-detached",
          coverageItemIds: ["coverage-1"],
          oracleSpecIds: [trusted.id],
          oracleSpecs: [trusted],
          evidenceRefs: [detachedEvidence.id],
          files: [
            { path: "tests/recovery-first.spec.ts", content: "first\n", sha256: sha256("first\n"), language: "playwright-ts" },
            { path: "tests/conflict/recovery-second.spec.ts", content: "second\n", sha256: sha256("second\n"), language: "playwright-ts" }
          ],
          format: "playwright-ts",
          repositoryRoot: detachedRoot,
          repositorySha256: detachedHash
        }
      });
      await validateTestAsset({ id: detachedAsset.id, store, runStore: fakeRunStore(makeRun("validation-detached")), request: { repetitions: 3, mutationTotal: 1, mutationKilled: 1, securityPassed: true, runIds: ["d1", "d2", "d3"], evidenceRefs: [detachedEvidence.id] } });
      await assert.rejects(
        () => applyTestAsset({ id: detachedAsset.id, store, request: { capabilityGrantId: "grant-detached", confirmedBy: "reviewer-1", expectedRepositorySha256: detachedHash } }),
        /ENOTDIR|asset_apply_restore_failed|not a directory/
      );
      await assert.rejects(() => execFileAsync("git", ["-C", detachedRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]));
      assert.equal((await execFileAsync("git", ["-C", detachedRoot, "rev-parse", "HEAD"])).stdout.trim(), detachedHead);
      assert.equal(await repositorySnapshotHash(detachedRoot), detachedHash);
      await assert.rejects(() => execFileAsync("git", ["-C", detachedRoot, "rev-parse", "--verify", "refs/heads/codex/ai-test-assets-run-detached"]));
    } finally {
      await rm(detachedRoot, { recursive: true, force: true });
    }
  } finally {
    setReportsDir();
    await rm(root, { recursive: true, force: true });
    await rm(reports, { recursive: true, force: true });
  }
  console.log("reliability assets tests passed");
}
