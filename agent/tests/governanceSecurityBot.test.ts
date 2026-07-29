import assert from "node:assert/strict";
import { buildDeliveryFromRun } from "../src/botNotifier.js";
import { createProjectGrant, deleteProjectGrant, listProjectGrants } from "../src/projectAccess.js";
import { deletePatrolPlan, listPatrolPlans, patrolTrend, upsertPatrolPlan } from "../src/patrolScheduler.js";
import type { RunBundle } from "../src/types.js";

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function bundleForDelivery(): RunBundle {
  return {
    runId: "run_bot_governance_test",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    input: {
      appUrl: "http://127.0.0.1:6173",
      permissionProfile: {
        observe: true,
        browserControl: false,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    },
    result: {
      id: "run_bot_governance_test",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      verdict: "stop_and_fix",
      summary: "release blocked",
      steps: [],
      network: [],
      console: [],
      assertions: [],
      oracles: [],
      aggregatedVerdict: { runCount: 1, failedAssertionCount: 1, flaky: false, verdict: "stop_and_fix", reason: "failed" },
      reflectionNote: "failed",
      conflictPacket: { status: "not_triggered", reason: "none", evidenceRefs: [] },
      failureAttributions: [],
      judgeReport: {
        source: "deterministic_judge",
        executionMode: "deterministic",
        llmStatus: "not_configured",
        policyVersion: "test",
        createdAt: new Date().toISOString(),
        planJudge: { layer: "plan", title: "Plan", verdict: "pass", summary: "ok", findings: [] },
        evidenceJudge: { layer: "evidence", title: "Evidence", verdict: "fail", summary: "evidence failed", findings: [] },
        releaseJudge: {
          layer: "release",
          title: "Release",
          verdict: "fail",
          summary: "release should be blocked",
          findings: [{
            id: "finding_1",
            severity: "high",
            failureClass: "product_bug",
            title: "API contract failed",
            reasoning: "network evidence failed",
            evidenceRefs: ["ev_network_1"]
          }]
        }
      },
      reportFile: "/artifacts/runs/run_bot_governance_test/report.json",
      htmlReportFile: "/artifacts/runs/run_bot_governance_test/report.html",
      runBundleFile: "/artifacts/runs/run_bot_governance_test/run_bundle.json"
    },
    evidence: [{
      id: "ev_screen_1",
      runId: "run_bot_governance_test",
      type: "screenshot",
      title: "Failure screenshot",
      timestamp: new Date().toISOString(),
      payload: {}
    }],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    conflictPacket: { status: "not_triggered", reason: "none", evidenceRefs: [] },
    failureAttributions: [{
      id: "attr_1",
      rank: 1,
      failureClass: "product_bug",
      title: "API contract failed",
      reasoning: "network endpoint maps to changed API file",
      suggestedFix: "检查 API handler 和 OpenAPI schema。",
      reproductionSteps: ["open page"],
      evidenceRefs: ["ev_network_1"],
      sourceContextIds: ["src_diff_1"],
      confidence: "high",
      topSuspects: [{
        filePath: "src/api/tasks.ts",
        lineStart: 42,
        apiEndpoint: "/api/tasks",
        openApiOperationId: "listTasks",
        reason: "failed endpoint maps to changed file",
        confidence: "high",
        evidenceRefs: ["ev_network_1"],
        sourceContextIds: ["src_diff_1"],
        suggestedFix: "恢复 /api/tasks response contract。"
      }]
    }],
    judgeReport: {
      source: "deterministic_judge",
      executionMode: "deterministic",
      llmStatus: "not_configured",
      policyVersion: "test",
      createdAt: new Date().toISOString(),
      planJudge: { layer: "plan", title: "Plan", verdict: "pass", summary: "ok", findings: [] },
      evidenceJudge: { layer: "evidence", title: "Evidence", verdict: "fail", summary: "evidence failed", findings: [] },
      releaseJudge: {
        layer: "release",
        title: "Release",
        verdict: "fail",
        summary: "release should be blocked",
        findings: [{
          id: "finding_1",
          severity: "high",
          failureClass: "product_bug",
          title: "API contract failed",
          reasoning: "network evidence failed",
          evidenceRefs: ["ev_network_1"]
        }]
      }
    }
  } as RunBundle;
}

export async function testGovernanceSecurityBot() {
  const projectId = `project_grant_${Date.now()}`;
  const grant = await createProjectGrant({ projectId, subject: "qa-oncall", role: "owner" });
  assert.equal(grant.tokenKind, "project_admin");
  assert.equal(grant.scopes.includes("manage_project"), true);
  assert.equal((await listProjectGrants(projectId)).some((item) => item.id === grant.id), true);
  assert.equal(await deleteProjectGrant(projectId, grant.id), true);

  const planId = `patrol_plan_${Date.now()}`;
  const plan = await upsertPatrolPlan({
    id: planId,
    title: "Production governance patrol",
    appUrl: "http://127.0.0.1:6173",
    scenarioId: "task_filter_completed",
    intervalMs: 10_000,
    cron: "*/5 * * * *",
    notify: ["qa-oncall"],
    retryPolicy: { maxRetries: 2, backoffMs: 10 },
    escalationPolicy: { failureThreshold: 2, riskTrendThreshold: "regressed", notify: ["lead"] },
    permissionProfile: {
      observe: true,
      browserControl: false,
      workspaceControl: false,
      ideTerminalControl: false,
      systemControl: false
    },
    status: "stopped"
  });
  assert.equal(plan.retryPolicy?.maxRetries, 2);
  assert.equal((await listPatrolPlans()).some((item) => item.id === planId && item.cron === "*/5 * * * *"), true);
  const trend = await patrolTrend({ projectId: "no_runs_for_governance_test", scenarioId: "task_filter_completed" });
  assert.equal(trend.riskTrend, "first_run");
  assert.equal(await deletePatrolPlan(planId), true);

  await withEnv({ BOT_WEBHOOK_URL: undefined, GITHUB_TOKEN: undefined }, async () => {
    const simulated = await buildDeliveryFromRun({
      bundle: bundleForDelivery(),
      provider: "simulated",
      includeScreenshots: true,
      recipients: ["qa-oncall"]
    });
    assert.equal(simulated.status, "simulated");
    assert.equal(simulated.blockedRelease, true);
    assert.deepEqual(simulated.screenshotRefs, ["ev_screen_1"]);
    assert.equal(simulated.topSuspects?.[0]?.title, "src/api/tasks.ts");

    const explicitSlack = await buildDeliveryFromRun({
      bundle: bundleForDelivery(),
      provider: "slack"
    });
    assert.equal(explicitSlack.status, "failed");
    assert.match(explicitSlack.error ?? "", /BOT_WEBHOOK_URL/);

    const github = await buildDeliveryFromRun({
      bundle: bundleForDelivery(),
      provider: "github_pr_comment",
      githubPrUrl: "https://github.com/acme/web/pull/1"
    });
    assert.equal(github.status, "failed");
    assert.match(github.error ?? "", /GITHUB_TOKEN/);
  });
}
