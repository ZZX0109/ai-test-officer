import assert from "node:assert/strict";
import { appendEvidence, readEvidence, readLatestRunId, readRunBundle, writeRunBundle } from "./evidenceStore.js";
import { buildLayeredJudgeReport } from "./judgeEngine.js";
import { renderMarkdownReport } from "./reportRenderer.js";
import { getScenario, listScenarios, matchScenariosForContext } from "./scenarios.js";
import { readFindingsFromAuditStore, readJudgeSummaryFromAuditStore } from "./sqliteAuditStore.js";
import type { EvidenceItem, RunBundle, VisualRunResult } from "./types.js";

function assertScenarioRegistry() {
  const ids = new Set(listScenarios().map((scenario) => scenario.id));
  for (const id of [
    "task_filter_completed",
    "auth_login_permission",
    "task_create_success",
    "task_state_transition"
  ]) {
    assert.ok(ids.has(id), `scenario registry should include ${id}`);
  }
  assert.equal(getScenario("auth_login_permission").corePath.action, "login_as_test_user");
  assert.equal(getScenario("task_create_success").corePath.action, "fill_and_submit");
  assert.equal(getScenario("task_state_transition").corePath.action, "change_task_status");
  assert.equal(
    matchScenariosForContext({
      requirement: "登录权限、表单提交、复杂列表状态变更都必须验收。",
      diff: "state transition and form submit changed",
      bugTicket: "权限流程偶现未登录也可操作"
    })[0]?.scenario.id,
    "auth_login_permission"
  );
}

function buildJudgeInput(evidence: EvidenceItem[]) {
  return {
    steps: [{
      stepId: "core_path",
      title: "执行核心路径",
      status: "failed" as const,
      action: "assert",
      details: "core failed"
    }],
    assertions: [{
      name: "缺少结构化 fact 的失败断言",
      passed: false,
      expected: "符合 oracle",
      actual: "自然语言里出现 status=completed，也不能被 Judge 正则猜成产品 bug"
    }],
    network: [],
    console: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: {
      runCount: 1,
      failedAssertionCount: 1,
      flaky: false,
      verdict: "hold_for_review" as const,
      reason: "self test"
    },
    conflictPacket: {
      status: "not_triggered" as const,
      reason: "self test",
      evidenceRefs: evidence.map((item) => item.id)
    },
    verdict: "hold_for_review" as const
  };
}

function assertStructuredJudgeOnly() {
  const evidence: EvidenceItem[] = [{
    id: "self_assertion",
    runId: "self",
    type: "assertion",
    title: "缺少结构化 fact 的失败断言",
    timestamp: new Date().toISOString(),
    payload: {}
  }];
  const report = buildLayeredJudgeReport({
    requirement: "必须展示 completed",
    diff: "status=completed",
    result: buildJudgeInput(evidence),
    evidence
  });
  const finding = report.evidenceJudge.findings[0];
  assert.equal(finding.failureClass, "insufficient_evidence");
  assert.match(finding.reasoning, /缺少结构化 AssertionFact/);
}

async function assertSqliteBackedEvidenceStore() {
  const runId = `selftest_${Date.now()}`;
  const evidence = await appendEvidence(runId, {
    type: "assertion",
    title: "self assertion",
    payload: {
      apiKey: "sk-secret-value",
      nested: { token: "Bearer abc123" }
    }
  });
  assert.equal(evidence.payload.apiKey, "[REDACTED]");

  const storedEvidence = await readEvidence(runId);
  assert.equal(storedEvidence.length, 1);
  assert.equal(storedEvidence[0].title, "self assertion");
  assert.equal(storedEvidence[0].payload.apiKey, "[REDACTED]");

  const startedAt = new Date().toISOString();
  const judgeReport = buildLayeredJudgeReport({
    requirement: "self test requirement",
    diff: "self test diff",
    result: {
      steps: [{
        stepId: "self_step",
        title: "Self step",
        status: "passed",
        action: "noop",
        details: "passed"
      }],
      assertions: [{
        name: "self assertion passed",
        passed: true,
        expected: "pass",
        actual: "pass"
      }],
      network: [],
      console: [],
      riskCoverageMatrix: [],
      aggregatedVerdict: {
        runCount: 1,
        failedAssertionCount: 0,
        flaky: false,
        verdict: "continue",
        reason: "self test"
      },
      conflictPacket: {
        status: "not_triggered",
        reason: "self test",
        evidenceRefs: storedEvidence.map((item) => item.id)
      },
      verdict: "continue"
    },
    evidence: storedEvidence
  });
  const result: VisualRunResult = {
    id: runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: "continue",
    summary: "self test passed",
    steps: [{
      stepId: "self_step",
      title: "Self step",
      status: "passed",
      action: "noop",
      details: "passed"
    }],
    network: [],
    console: [],
    assertions: [{
      name: "self assertion passed",
      passed: true,
      expected: "pass",
      actual: "pass"
    }],
    evidence: storedEvidence,
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: {
      runCount: 1,
      failedAssertionCount: 0,
      flaky: false,
      verdict: "continue",
      reason: "self test"
    },
    reflectionNote: "self test",
    conflictPacket: {
      status: "not_triggered",
      reason: "self test",
      evidenceRefs: storedEvidence.map((item) => item.id)
    },
    failureAttributions: [],
    judgeReport,
    reportFile: `/artifacts/runs/${runId}/report.json`,
    runBundleFile: `/artifacts/runs/${runId}/run_bundle.json`
  };
  const bundle: RunBundle = {
    runId,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    input: {
      appUrl: "http://localhost:6173",
      scenarioId: "task_filter_completed",
      permissionProfile: {
        observe: true,
        browserControl: true,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    },
    result,
    evidence: storedEvidence,
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    conflictPacket: result.conflictPacket,
    judgeReport
  };
  await writeRunBundle(bundle);
  assert.equal((await readRunBundle(runId)).runId, runId);
  assert.equal(await readLatestRunId(), runId);
  assert.equal(readJudgeSummaryFromAuditStore(runId).length, 3);
  assert.ok(readFindingsFromAuditStore(runId).length >= 1);

  const markdown = renderMarkdownReport(result);
  assert.equal(markdown.includes("sk-secret-value"), false);
  assert.equal(markdown.includes("Bearer abc123"), false);
}

async function main() {
  assertScenarioRegistry();
  assertStructuredJudgeOnly();
  await assertSqliteBackedEvidenceStore();
  console.log("AI Test Officer self tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
