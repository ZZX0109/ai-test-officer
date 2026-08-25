import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { buildParentCoverageChildSpecs, classifyParentCoverageDispatch } from "../src/runOrchestrator.js";
import { createDynamicBrowserCoverageItems } from "../src/coverageStore.js";

const repositoryRoot = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const concurrencyLevels = [1, 10, 50];
const pathLevels = [10, 50, 200];

async function exerciseInventory(concurrency: number, pathCount: number) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: concurrency }, (_, runIndex) => {
    const items = createDynamicBrowserCoverageItems({
      runId: `capacity_${concurrency}_${pathCount}_${runIndex}`,
      paths: Array.from({ length: pathCount }, (_, pathIndex) => ({
        id: `page_${pathIndex + 1}`,
        title: `Page ${pathIndex + 1}`,
        status: "auto-bindable" as const,
        surface: "page" as const
      }))
    });
    const dispatch = classifyParentCoverageDispatch({ items, dynamicParent: true });
    const accounted = dispatch.executable.length + dispatch.undispatchable.length;
    const childSpecs = buildParentCoverageChildSpecs({
      parentRunId: `capacity_${concurrency}_${pathCount}_${runIndex}`,
      parentLlmBudget: {},
      items: dispatch.executable,
      dynamicParent: true
    });
    assert.equal(items.length, pathCount);
    assert.equal(accounted, pathCount, "every pending path must be accounted for before dispatch");
    assert.equal(dispatch.undispatchable.length, 0);
    assert.equal(childSpecs.length, pathCount, "every executable path must receive a child-run specification");
    assert.equal(new Set(childSpecs.map((spec) => spec.childRunId)).size, pathCount, "child-run identities must be unique per path");
    assert.equal(childSpecs.every((spec) => spec.dynamicBrowserPath && spec.llmBudget.maxBrowserActionCalls === 6), true, "dynamic paths must carry an explicit browser budget");
    assert.equal(new Set(items.map((item) => item.id)).size, pathCount);
    assert.equal(new Set(items.map((item) => JSON.stringify(item.budget))).size, 1, "each path receives an explicit budget envelope");
    return { pathCount, executable: dispatch.executable.length, undispatchable: dispatch.undispatchable.length, childRunSpecs: childSpecs.length };
  }));
  return {
    concurrency,
    pathCount,
    runs: results.length,
    executablePaths: results.reduce((sum, item) => sum + item.executable, 0),
    childRunSpecs: results.reduce((sum, item) => sum + item.childRunSpecs, 0),
    undispatchablePaths: results.reduce((sum, item) => sum + item.undispatchable, 0),
    silentDropRate: 0,
    childRunSpecCoverageRate: 1,
    elapsedMs: Number((performance.now() - started).toFixed(3))
  };
}

export async function testCapacityMatrix() {
  const matrix = [];
  for (const concurrency of concurrencyLevels) {
    for (const pathCount of pathLevels) matrix.push(await exerciseInventory(concurrency, pathCount));
  }
  const report = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    status: "control-plane-only",
    provenance: "real CoverageItem creation and parent dispatch classification; no Docker, PostgreSQL, Redis, MinIO, Worker or browser load",
    matrix,
    limitation: "This report proves inventory accounting and dispatch topology only. It is not a production capacity or latency SLO result."
  };
  const reportDir = path.join(repositoryRoot, "reports", "capacity-control-plane");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(matrix.every((item) => item.silentDropRate === 0 && item.undispatchablePaths === 0), true);
}
