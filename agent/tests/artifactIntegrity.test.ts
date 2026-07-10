import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArtifactIntegrityReport, writeArtifactIntegrityReport } from "../src/artifactIntegrity.js";
import { buildLayeredJudgeReport } from "../src/judgeEngine.js";
import type { VisualRunResult } from "../src/types.js";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function baseRunResult(): VisualRunResult {
  const startedAt = new Date().toISOString();
  return {
    id: "artifact_integrity_test",
    startedAt,
    finishedAt: startedAt,
    verdict: "continue",
    summary: "ok",
    steps: [
      {
        stepId: "step_1",
        title: "capture screenshot",
        status: "passed",
        action: "screenshot",
        screenshot: "/artifacts/screenshots/artifact_integrity_test/page.png",
        details: "captured"
      }
    ],
    network: [],
    console: [],
    assertions: [],
    evidence: [
      {
        id: "ev_screenshot",
        runId: "artifact_integrity_test",
        type: "screenshot",
        title: "page",
        timestamp: startedAt,
        file: "/artifacts/screenshots/artifact_integrity_test/page.png",
        payload: {}
      },
      {
        id: "ev_missing",
        runId: "artifact_integrity_test",
        type: "trace",
        title: "missing trace",
        timestamp: startedAt,
        file: "/artifacts/traces/artifact_integrity_test_missing.zip",
        payload: {}
      },
      {
        id: "ev_escape",
        runId: "artifact_integrity_test",
        type: "dom",
        title: "bad path",
        timestamp: startedAt,
        payload: { file: "/artifacts/../config/local-secrets.json" }
      }
    ],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
    reflectionNote: "ok",
    conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
    failureAttributions: [],
    judgeReport: buildLayeredJudgeReport({
      requirement: "ok",
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
    }),
    reportFile: "/artifacts/runs/artifact_integrity_test/report.json",
    htmlReportFile: "/artifacts/runs/artifact_integrity_test/report.html",
    runBundleFile: "/artifacts/runs/artifact_integrity_test/run_bundle.json",
    artifactIntegrityReportFile: "/artifacts/runs/artifact_integrity_test/artifact_integrity.json"
  };
}

export async function testArtifactIntegrity() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "artifact-integrity-"));
  const reportsDir = path.join(tempRoot, "reports");
  try {
    await mkdir(path.join(reportsDir, "screenshots", "artifact_integrity_test"), { recursive: true });
    await mkdir(path.join(reportsDir, "runs", "artifact_integrity_test"), { recursive: true });
    await writeFile(path.join(reportsDir, "screenshots", "artifact_integrity_test", "page.png"), "fake image");
    await writeFile(path.join(reportsDir, "runs", "artifact_integrity_test", "report.html"), "<html>ok</html>");
    await writeFile(path.join(reportsDir, "runs", "artifact_integrity_test", "report.json"), "{}");
    await writeFile(path.join(reportsDir, "runs", "artifact_integrity_test", "run_bundle.json"), "{}");

    const result = baseRunResult();
    const report = await buildArtifactIntegrityReport({ result, reportsDir, generatedAt: "2026-01-01T00:00:00.000Z" });
    const screenshot = report.items.find((item) => item.artifactUri.endsWith("/page.png"));
    assert.equal(screenshot?.status, "present");
    assert.equal(screenshot?.sha256, sha256("fake image"));
    assert.equal(report.items.find((item) => item.artifactUri.includes("missing"))?.status, "missing");
    assert.equal(report.items.find((item) => item.artifactUri.includes("../config"))?.status, "path_escape");
    assert.equal(report.items.find((item) => item.artifactUri.endsWith("/run_bundle.json"))?.status, "self_reference");
    assert.equal(report.items.find((item) => item.artifactUri.endsWith("/report.html"))?.status, "self_reference");
    assert.equal(report.summary.hashed >= 1, true);

    const outputFile = path.join(reportsDir, "runs", "artifact_integrity_test", "artifact_integrity.json");
    const written = await writeArtifactIntegrityReport({ result, reportsDir, outputFile });
    const raw = JSON.parse(await readFile(outputFile, "utf8")) as typeof written;
    assert.equal(raw.id, written.id);
    assert.equal(raw.summary.pathEscapes, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
