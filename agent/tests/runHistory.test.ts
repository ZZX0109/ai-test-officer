import assert from "node:assert/strict";
import { buildLayeredJudgeReport } from "../src/judgeEngine.js";
import { writeRunBundle } from "../src/evidenceStore.js";
import { buildHistoryComparison, listRunHistory, type RunHistoryEntry } from "../src/runHistory.js";
import { auditStoreStatus, readSourceContextsFromAuditStore } from "../src/sqliteAuditStore.js";
import type { RunBundle, SourceReadEnvelope } from "../src/types.js";

function entry(input: Partial<RunHistoryEntry>): Omit<RunHistoryEntry, "comparison"> {
  return {
    runId: input.runId ?? "run",
    timestamp: input.timestamp ?? new Date().toISOString(),
    verdict: input.verdict ?? "continue",
    failedAssertionCount: input.failedAssertionCount ?? 0,
    appUrl: input.appUrl ?? "http://localhost:6173",
    scenarioId: input.scenarioId ?? "task_filter_completed",
    scenarioFingerprint: input.scenarioFingerprint ?? "fingerprint"
  };
}

const sharedSourceContext: SourceReadEnvelope = {
  id: "src_shared_requirement",
  kind: "requirement_doc",
  title: "Shared requirement",
  uri: "docs/shared-requirement.md",
  status: "connected",
  summary: "Same source should be retained for every run.",
  permissionState: "not_required",
  isSimulated: false,
  readAt: "2026-01-01T00:00:00.000Z",
  trustLevel: "high",
  contentHash: "shared"
};

function bundle(runId: string, failedAssertionCount: number, sourceContexts: SourceReadEnvelope[] = []): RunBundle {
  const now = new Date().toISOString();
  const assertions = Array.from({ length: failedAssertionCount }, (_item, index) => ({
    name: `assertion_${index}`,
    passed: false,
    expected: "pass",
    actual: "fail"
  }));
  const judgeReport = buildLayeredJudgeReport({
    requirement: "history",
    diff: "",
    result: {
      steps: [],
      assertions,
      network: [],
      console: [],
      riskCoverageMatrix: [],
      aggregatedVerdict: { runCount: 1, failedAssertionCount, flaky: false, verdict: failedAssertionCount ? "hold_for_review" : "continue", reason: "history" },
      conflictPacket: { status: "not_triggered", reason: "history", evidenceRefs: [] },
      verdict: failedAssertionCount ? "hold_for_review" : "continue"
    },
    evidence: []
  });
  return {
    runId,
    startedAt: now,
    finishedAt: now,
    input: {
      appUrl: "http://localhost:6173/history-sqlite",
      scenarioId: "task_filter_completed",
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
      scenarioFingerprint: "history_sqlite_fingerprint",
      verdict: failedAssertionCount ? "hold_for_review" : "continue",
      summary: "history",
      steps: [],
      network: [],
      console: [],
      assertions,
      aggregatedVerdict: { runCount: 1, failedAssertionCount, flaky: false, verdict: failedAssertionCount ? "hold_for_review" : "continue", reason: "history" },
      reflectionNote: "history",
      conflictPacket: { status: "not_triggered", reason: "history", evidenceRefs: [] },
      failureAttributions: [],
      judgeReport,
      reportFile: `/artifacts/runs/${runId}/report.json`,
      runBundleFile: `/artifacts/runs/${runId}/run_bundle.json`
    },
    evidence: [],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    sourceContexts,
    conflictPacket: { status: "not_triggered", reason: "history", evidenceRefs: [] },
    judgeReport
  };
}

export async function testRunHistoryComparison() {
  const first = buildHistoryComparison(undefined, entry({ runId: "run_1", failedAssertionCount: 0 }));
  assert.equal(first.riskTrend, "first_run");
  assert.equal(first.judgeDecisionChanged, false);

  const previous = entry({ runId: "run_1", verdict: "continue", failedAssertionCount: 0 });
  const regressed = buildHistoryComparison(previous, entry({ runId: "run_2", verdict: "hold_for_review", failedAssertionCount: 2 }));
  assert.equal(regressed.previousRunId, "run_1");
  assert.equal(regressed.riskTrend, "regressed");
  assert.equal(regressed.failureDelta, 2);
  assert.equal(regressed.judgeDecisionChanged, true);

  const improved = buildHistoryComparison(
    entry({ runId: "run_2", verdict: "hold_for_review", failedAssertionCount: 2 }),
    entry({ runId: "run_3", verdict: "continue", failedAssertionCount: 0 })
  );
  assert.equal(improved.riskTrend, "improved");
  assert.equal(improved.failureDelta, -2);
  assert.equal(improved.judgeDecisionChanged, true);

  const stable = buildHistoryComparison(
    entry({ runId: "run_3", verdict: "continue", failedAssertionCount: 0 }),
    entry({ runId: "run_4", verdict: "continue", failedAssertionCount: 0 })
  );
  assert.equal(stable.riskTrend, "stable");
  assert.equal(stable.failureDelta, 0);
  assert.equal(stable.judgeDecisionChanged, false);

  const runId = `run_history_sqlite_${Date.now()}`;
  await writeRunBundle(bundle(runId, 2));
  const history = await listRunHistory();
  const row = history.find((item) => item.runId === runId);
  assert.equal(row?.failedAssertionCount, 2);
  assert.equal(row?.scenarioFingerprint, "history_sqlite_fingerprint");
  assert.equal(row?.appUrl, "http://localhost:6173/history-sqlite");

  const firstSourceRunId = `run_source_a_${Date.now()}`;
  const secondSourceRunId = `run_source_b_${Date.now()}`;
  await writeRunBundle(bundle(firstSourceRunId, 0, [sharedSourceContext]));
  await writeRunBundle(bundle(secondSourceRunId, 0, [sharedSourceContext]));
  const firstSources = readSourceContextsFromAuditStore(firstSourceRunId);
  const secondSources = readSourceContextsFromAuditStore(secondSourceRunId);
  assert.equal(firstSources.length, 1);
  assert.equal(secondSources.length, 1);
  assert.equal(firstSources[0]?.id, sharedSourceContext.id);
  assert.equal(secondSources[0]?.id, sharedSourceContext.id);
  assert.equal(firstSources[0]?.runId, firstSourceRunId);
  assert.equal(secondSources[0]?.runId, secondSourceRunId);

  const auditStatus = auditStoreStatus();
  assert.equal(auditStatus.schemaVersion, 4);
  assert.equal(auditStatus.userVersion, auditStatus.schemaVersion);
  assert.equal(auditStatus.schemaVersionMatches, true);
  assert.equal(auditStatus.migrationComplete, true);
  assert.deepEqual(auditStatus.missingMigrations, []);
  assert.equal(auditStatus.integrityOk, true);
  assert.equal(auditStatus.integrityCheck, "ok");
  assert.deepEqual(
    auditStatus.migrations.map((migration) => migration.version),
    auditStatus.expectedMigrationVersions
  );
}
