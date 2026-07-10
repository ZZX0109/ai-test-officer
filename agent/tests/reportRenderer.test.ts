import assert from "node:assert/strict";
import { renderHtmlReport, renderMarkdownReport } from "../src/reportRenderer.js";
import { buildLayeredJudgeReport } from "../src/judgeEngine.js";
import type { VisualRunResult } from "../src/types.js";

export function testReportRendererRedaction() {
  const startedAt = new Date().toISOString();
  const result: VisualRunResult = {
    id: "report_renderer_test",
    startedAt,
    finishedAt: startedAt,
    verdict: "continue",
    summary: "token should not leak",
    steps: [{
      stepId: "secret_step",
      title: "调用 webhook",
      status: "failed",
      action: "network_probe",
      details: "POST https://hooks.example.com/secret-token?key=raw-webhook-key with Authorization=Bearer raw-bearer-token"
    }],
    network: [],
    console: [],
    assertions: [{
      name: "secret assertion",
      passed: false,
      expected: "cookie=session-cookie-secret",
      actual: "access_token=raw-access-token"
    }],
    evidence: [],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
    reflectionNote: "webhook https://hooks.example.com/secret-token must be redacted",
    conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
    failureAttributions: [],
    judgeReport: buildLayeredJudgeReport({
      requirement: "no leak",
      diff: "token=abc",
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
    reportFile: "/artifacts/runs/report_renderer_test/report.json",
    runBundleFile: "/artifacts/runs/report_renderer_test/run_bundle.json"
  };
  const markdown = renderMarkdownReport(result);
  const html = renderHtmlReport(result);
  for (const output of [markdown, html]) {
    assert.equal(output.includes("secret-token"), false);
    assert.equal(output.includes("raw-webhook-key"), false);
    assert.equal(output.includes("raw-bearer-token"), false);
    assert.equal(output.includes("session-cookie-secret"), false);
    assert.equal(output.includes("raw-access-token"), false);
  }
  assert.equal(markdown.includes("token=abc"), false);
  assert.equal(html.includes("token=abc"), false);
  assert.match(markdown, /\[REDACTED_WEBHOOK_URL\]/);
  assert.match(html, /\[REDACTED_WEBHOOK_URL\]/);
  assert.equal(markdown.includes("## Artifact Integrity"), true);
}
