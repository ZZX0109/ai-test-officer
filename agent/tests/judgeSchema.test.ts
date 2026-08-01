import assert from "node:assert/strict";
import { buildFailureAttributions } from "../src/failureAttribution.js";
import { buildLayeredJudgeReport } from "../src/judgeEngine.js";
import type { EvidenceItem, ImpactAnalysis } from "../src/types.js";

export function testJudgeSchema() {
  const evidence: EvidenceItem[] = [{
    id: "ev_network_1",
    runId: "judge_schema",
    type: "network",
    title: "Network failed",
    timestamp: new Date().toISOString(),
    payload: { status: 503, url: "http://localhost:6172/api/tasks?status=error" }
  }];
  const result = {
    steps: [{ stepId: "core", title: "Core", status: "failed" as const, action: "simulate_error", details: "failed" }],
    assertions: [{
      name: "接口失败后展示错误态",
      passed: false,
      expected: "页面展示任务接口失败",
      actual: "空白",
      fact: {
        kind: "text.contains" as const,
        target: "[data-testid='error-state']",
        operator: "contains" as const,
        expected: "任务接口失败",
        actual: "空白",
        severity: "high" as const,
        evidenceRefs: ["ev_network_1"],
        failureClass: "product_bug" as const
      }
    }],
    network: [{ method: "GET", url: "http://localhost:6172/api/tasks?status=error", status: 503 }],
    console: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 1, flaky: false, verdict: "hold_for_review" as const, reason: "self test" },
    conflictPacket: { status: "not_triggered" as const, reason: "self test", evidenceRefs: ["ev_network_1"] },
    verdict: "hold_for_review" as const
  };
  const report = buildLayeredJudgeReport({ requirement: "接口失败要展示错误态", diff: "/api/tasks", result, evidence });
  assert.equal(report.releaseJudge.findings.every((finding) => finding.evidenceRefs.length > 0), true);
  assert.equal(
    report.planJudge.findings.some((finding) => finding.id.startsWith("plan_gap_")),
    false,
    "A run without an explicit plan must not inherit unrelated fixed-fixture paths."
  );
  const projectWide = buildLayeredJudgeReport({ requirement: "对上传项目进行全面灰度测试", diff: "", result, evidence });
  assert.equal(projectWide.planJudge.findings.some((finding) => finding.id === "plan_context_missing"), false);
  const changeScoped = buildLayeredJudgeReport({ requirement: "验证本次代码变更和提交", diff: "", result, evidence });
  assert.equal(changeScoped.planJudge.findings.some((finding) => finding.id === "plan_context_missing"), true);
  const attributions = buildFailureAttributions({
    assertions: result.assertions,
    steps: result.steps,
    network: result.network,
    console: result.console,
    evidence,
    sourceContexts: [],
    diff: "diff --git a/app-under-test/server/mockServer.ts b/app-under-test/server/mockServer.ts\n@@ -40,6 +40,8 @@\n+app.get(\"/api/tasks\", handler);\n+if (status === \"error\") return 503;\n",
    impactAnalysis: {
      id: "impact",
      createdAt: new Date().toISOString(),
      affectedPages: [],
      affectedApis: [{
        id: "api",
        kind: "api",
        target: "/api/tasks",
        reason: "API changed",
        sourceContextIds: [],
        confidence: "high"
      }],
      affectedComponents: [{
        id: "component",
        kind: "component",
        target: "app-under-test/server/mockServer.ts",
        reason: "diff changed mock server",
        sourceContextIds: [],
        confidence: "high"
      }],
      recommendedScenarios: [],
      uncoveredRisks: []
    } satisfies ImpactAnalysis
  });
  assert.equal(attributions[0].failureClass, "environment_issue");
  assert.ok(attributions[0].evidenceRefs.includes("ev_network_1"));
  assert.equal(attributions[0].changeRefs?.[0]?.file, "app-under-test/server/mockServer.ts");
  assert.equal(attributions[0].changeRefs?.[0]?.lineStart, 40);
  assert.equal(attributions[0].changeRefs?.[0]?.lineEnd, 41);
  assert.ok(attributions[0].changeRefs?.[0]?.matchedSignals?.includes("/api/tasks"));
  assert.ok(attributions[0].changeRefs?.[0]?.diagnosticSignals?.some((signal) => signal.kind === "network_endpoint" && signal.value === "/api/tasks"));
  assert.ok(attributions[0].changeRefs?.[0]?.diagnosticSignals?.some((signal) => signal.kind === "network_status" && signal.value === "503"));
  assert.ok(attributions[0].changeRefs?.[0]?.addedLines?.some((line) => line.text.includes("/api/tasks")));
  assert.equal(attributions[0].topSuspects?.[0]?.filePath, "app-under-test/server/mockServer.ts");
  assert.equal(attributions[0].topSuspects?.[0]?.lineStart, 40);
  assert.ok(attributions[0].topSuspects?.[0]?.evidenceRefs.includes("ev_network_1"));
  assert.match(attributions[0].topSuspects?.[0]?.suggestedFix ?? "", /接口|API|network/i);

  const endpointOnlyAttributions = buildFailureAttributions({
    assertions: result.assertions,
    steps: result.steps,
    network: result.network,
    console: result.console,
    evidence,
    sourceContexts: [],
    diff: "diff --git a/src/apiClient.ts b/src/apiClient.ts\n@@ -1,2 +1,4 @@\n+const url = \"/api/tasks?status=error\";\n+return { status: 503 };\n",
    impactAnalysis: {
      id: "impact_endpoint",
      createdAt: new Date().toISOString(),
      affectedPages: [],
      affectedApis: [{
        id: "api",
        kind: "api",
        target: "/api/tasks",
        reason: "API changed",
        sourceContextIds: [],
        confidence: "high"
      }],
      affectedComponents: [],
      recommendedScenarios: [],
      uncoveredRisks: []
    } satisfies ImpactAnalysis
  });
  const endpointRef = endpointOnlyAttributions[0].changeRefs?.[0];
  assert.equal(endpointRef?.file, "src/apiClient.ts");
  assert.equal(endpointRef?.confidence, "high");
  assert.match(endpointRef?.reason ?? "", /failed network endpoint \/api\/tasks/);
  assert.ok(endpointRef?.diagnosticSignals?.some((signal) => signal.kind === "query_param" && signal.value === "status=error"));
  assert.equal(endpointOnlyAttributions[0].topSuspects?.[0]?.filePath, "src/apiClient.ts");
  assert.ok(endpointOnlyAttributions[0].topSuspects?.[0]?.evidenceRefs.includes("ev_network_1"));

  const consoleStackAttributions = buildFailureAttributions({
    assertions: result.assertions,
    steps: result.steps,
    network: [],
    console: [{
      type: "error",
      text: "TypeError: Cannot read properties of undefined (reading 'filterTasks')\n    at TaskFilter (http://localhost:6173/src/components/TaskFilter.tsx:42:13)"
    }],
    evidence,
    sourceContexts: [],
    diff: "diff --git a/src/components/TaskFilter.tsx b/src/components/TaskFilter.tsx\n@@ -40,6 +40,7 @@\n+const visibleTasks = filterTasks(tasks, selectedStatus);\n",
    impactAnalysis: {
      id: "impact_console_stack",
      createdAt: new Date().toISOString(),
      affectedPages: [],
      affectedApis: [],
      affectedComponents: [],
      recommendedScenarios: [],
      uncoveredRisks: []
    } satisfies ImpactAnalysis
  });
  const consoleRef = consoleStackAttributions[0].changeRefs?.[0];
  assert.equal(consoleStackAttributions[0].failureClass, "product_bug");
  assert.equal(consoleRef?.file, "src/components/TaskFilter.tsx");
  assert.equal(consoleRef?.confidence, "high");
  assert.match(consoleRef?.reason ?? "", /console stack frame/);
  assert.ok(consoleRef?.diagnosticSignals?.some((signal) => signal.kind === "console_stack" && signal.value === "src/components/TaskFilter.tsx"));
  assert.ok(consoleRef?.diagnosticSignals?.some((signal) => signal.kind === "console_message" && signal.value === "filterTasks"));
  assert.equal(consoleStackAttributions[0].topSuspects?.[0]?.filePath, "src/components/TaskFilter.tsx");
  assert.ok(consoleStackAttributions[0].topSuspects?.[0]?.evidenceRefs.includes("ev_network_1"));
}
