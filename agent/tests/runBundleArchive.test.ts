import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLayeredJudgeReport } from "../src/judgeEngine.js";
import { buildRunBundleArchive } from "../src/runBundleArchive.js";
import { readRunHistoryFromAuditStore, recordRunBundleInAuditStore } from "../src/sqliteAuditStore.js";
import type { RunBundle } from "../src/types.js";

function testBundle(runId: string): RunBundle {
  const now = new Date().toISOString();
  const judgeReport = buildLayeredJudgeReport({
    requirement: "archive",
    diff: "",
    result: {
      steps: [],
      assertions: [],
      network: [],
      console: [],
      riskCoverageMatrix: [],
      aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
      conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
      verdict: "continue"
    },
    evidence: []
  });
  return {
    runId,
    startedAt: now,
    finishedAt: now,
    input: {
      appUrl: "http://localhost:3000",
      permissionProfile: {
        observe: true,
        browserControl: true,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    },
    result: {
      id: runId,
      startedAt: now,
      finishedAt: now,
      verdict: "continue",
      summary: "ok",
      steps: [],
      network: [],
      console: [],
      assertions: [],
      aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
      reflectionNote: "ok",
      conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
      failureAttributions: [],
      judgeReport,
      reportFile: `/artifacts/runs/${runId}/report.json`,
      htmlReportFile: `/artifacts/runs/${runId}/report.html`,
      runBundleFile: `/artifacts/runs/${runId}/run_bundle.json`,
      artifactIntegrityReportFile: `/artifacts/runs/${runId}/artifact_integrity.json`
    },
    evidence: [],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
    judgeReport,
    artifactIntegrity: {
      id: `artifact_integrity_${runId}`,
      runId,
      generatedAt: now,
      artifactRoot: "/artifacts",
      summary: { total: 7, present: 4, missing: 1, unreadable: 0, pathEscapes: 1, selfReferences: 3, hashed: 1 },
      items: [
        { id: "bundle", artifactUri: `/artifacts/runs/${runId}/run_bundle.json`, kind: "run_bundle", status: "self_reference" },
        { id: "report", artifactUri: `/artifacts/runs/${runId}/report.html`, kind: "report", status: "self_reference" },
        { id: "integrity", artifactUri: `/artifacts/runs/${runId}/artifact_integrity.json`, kind: "report", status: "self_reference" },
        { id: "screenshot", artifactUri: `/artifacts/screenshots/${runId}/page.png`, kind: "screenshot", status: "present" },
        { id: "trace", artifactUri: `/artifacts/traces/${runId}.zip`, kind: "trace", status: "present" },
        { id: "missing", artifactUri: `/artifacts/videos/${runId}.webm`, kind: "video", status: "missing" },
        { id: "escape", artifactUri: "/artifacts/../config/local-secrets.json", kind: "dom", status: "path_escape" }
      ]
    }
  };
}

export async function testRunBundleArchive() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "run-bundle-archive-"));
  const reportsDir = path.join(tempRoot, "reports");
  const runId = "run_archive";
  try {
    await mkdir(path.join(reportsDir, "runs", runId), { recursive: true });
    await mkdir(path.join(reportsDir, "screenshots", runId), { recursive: true });
    await mkdir(path.join(reportsDir, "traces"), { recursive: true });
    await writeFile(path.join(reportsDir, "runs", runId, "run_bundle.json"), "{}");
    await writeFile(
      path.join(reportsDir, "runs", runId, "report.html"),
      `<html><body><img src="/artifacts/screenshots/${runId}/page.png" alt="page" /></body></html>`
    );
    await writeFile(path.join(reportsDir, "runs", runId, "artifact_integrity.json"), "{}");
    await writeFile(path.join(reportsDir, "screenshots", runId, "page.png"), "image");
    await writeFile(path.join(reportsDir, "traces", `${runId}.zip`), "0123456789abcdef");

    const outputFile = path.join(reportsDir, "run-bundle.zip");
    const manifestFile = path.join(reportsDir, "run-bundle-download-manifest.json");
    const archive = await buildRunBundleArchive({
      bundle: testBundle(runId),
      outputFile,
      manifestFile,
      reportsDir,
      maxInlineBytes: 8,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    const zipBytes = await readFile(outputFile);
    const zipText = zipBytes.toString("utf8");
    assert.equal(zipBytes.subarray(0, 2).toString(), "PK");
    assert.equal(zipText.includes(`src="../../screenshots/${runId}/page.png"`), true);
    assert.equal(zipText.includes(`src="/artifacts/screenshots/${runId}/page.png"`), false);
    assert.equal(JSON.parse(await readFile(manifestFile, "utf8")).runId, runId);
    assert.equal(archive.manifest.entries.find((entry) => entry.artifactUri.endsWith("/page.png"))?.status, "included");
    assert.equal(archive.manifest.entries.find((entry) => entry.artifactUri.endsWith(`${runId}.zip`))?.status, "reference_only");
    assert.equal(archive.manifest.entries.find((entry) => entry.artifactUri.endsWith(".webm"))?.status, "missing");
    assert.equal(archive.manifest.entries.find((entry) => entry.artifactUri.includes("../config"))?.status, "path_escape");
    assert.equal(archive.manifest.entries.some((entry) => entry.archivePath === "manifest.json"), false);

    const projectOnlyRunId = "run_project_only_sqlite_contract";
    const projectOnlyBundle = testBundle(projectOnlyRunId);
    projectOnlyBundle.input = {
      projectId: "external_sqlite_contract",
      scenarioId: "generic_table_sort_filter_pagination",
      permissionProfile: projectOnlyBundle.input.permissionProfile
    };
    projectOnlyBundle.project = {
      id: "external_sqlite_contract",
      name: "External SQLite Contract",
      projectPath: "/tmp/external-sqlite-contract",
      allowExternalProjectPath: true,
      frontendUrl: "http://127.0.0.1:49152",
      backendUrl: "http://127.0.0.1:49152/health",
      healthCheckUrl: "http://127.0.0.1:49152/health",
      login: { method: "none" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    projectOnlyBundle.runtimeStatus = {
      projectId: "external_sqlite_contract",
      status: "running",
      frontendUrl: "http://127.0.0.1:49152",
      healthCheckUrl: "http://127.0.0.1:49152/health",
      message: "running"
    };
    projectOnlyBundle.result.runtimeStatus = projectOnlyBundle.runtimeStatus;
    recordRunBundleInAuditStore(projectOnlyBundle, `/artifacts/runs/${projectOnlyRunId}/run_bundle.json`);
    const historyRow = readRunHistoryFromAuditStore().find((entry) => entry.runId === projectOnlyRunId);
    assert.equal(historyRow?.projectId, "external_sqlite_contract");
    assert.equal(historyRow?.appUrl, "http://127.0.0.1:49152");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
