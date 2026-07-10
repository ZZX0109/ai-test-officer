import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "./redaction.js";
import type { JudgeResult, VisualRunResult } from "./types.js";

function escapeHtml(value: string | undefined) {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function mdList(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- 无";
}

function evidenceRefs(refs: string[]) {
  return refs.length ? refs.map((ref) => `\`${ref}\``).join(", ") : "`无`";
}

function changeRefLabel(ref: NonNullable<VisualRunResult["failureAttributions"][number]["changeRefs"]>[number]) {
  const lineRange = ref.lineStart
    ? `:${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `-${ref.lineEnd}` : ""}`
    : "";
  const signals = ref.matchedSignals?.length ? ` signals=${ref.matchedSignals.join(",")}` : "";
  const diagnosticSignals = ref.diagnosticSignals?.length
    ? ` diagnostic=${ref.diagnosticSignals.map((signal) => `${signal.kind}:${signal.value}`).join(",")}`
    : "";
  return `${ref.file}${lineRange}${ref.hunk ? ` ${ref.hunk}` : ""} (${ref.confidence}${signals}${diagnosticSignals})`;
}

function judgeMarkdown(judge: JudgeResult) {
  return `## ${judge.title}

- Verdict: \`${judge.verdict}\`
- Summary: ${judge.summary}

${judge.findings.map((finding) => `- **${finding.title}** (${finding.severity}${finding.failureClass ? ` · ${finding.failureClass}` : ""})：${finding.reasoning} ${evidenceRefs(finding.evidenceRefs)}`).join("\n") || "- 无"}`;
}

function attributionMarkdown(result: VisualRunResult) {
  if (!result.failureAttributions.length) return "- 无";
  return result.failureAttributions.map((item) => [
    `- **#${item.rank} ${item.title}** (${item.failureClass} · ${item.confidence})`,
    `  - Reasoning: ${item.reasoning}`,
    `  - Suggested fix: ${item.suggestedFix}`,
    `  - Change refs: ${item.changeRefs?.map(changeRefLabel).join("; ") || "无"}`,
    `  - Evidence: ${evidenceRefs(item.evidenceRefs)}`
  ].join("\n")).join("\n");
}

function integrityMarkdown(result: VisualRunResult) {
  const report = result.artifactIntegrity;
  if (!report) return "- Artifact integrity: pending";
  const risky = report.items.filter((item) => ["missing", "unreadable", "path_escape"].includes(item.status));
  return [
    `- Report: ${result.artifactIntegrityReportFile ?? "pending"}`,
    `- Summary: total=${report.summary.total}, hashed=${report.summary.hashed}, missing=${report.summary.missing}, unreadable=${report.summary.unreadable}, pathEscapes=${report.summary.pathEscapes}, selfReferences=${report.summary.selfReferences}`,
    risky.length
      ? risky.map((item) => `- \`${item.status}\` ${item.artifactUri}${item.reason ? ` (${item.reason})` : ""}`).join("\n")
      : "- Risky artifacts: 无"
  ].join("\n");
}

export function renderMarkdownReport(result: VisualRunResult) {
  const releaseFinding = result.judgeReport.releaseJudge.findings[0];
  const failedAssertions = result.assertions.filter((item) => !item.passed);
  return redactText(`# AI 测试官证据审计报告：${result.judgeReport.releaseJudge.verdict}

- Run ID: \`${result.id}\`
- Started: ${result.startedAt}
- Finished: ${result.finishedAt}
- Verdict: \`${result.verdict}\`
- Release Judge: \`${result.judgeReport.releaseJudge.verdict}\`
- Judge mode: \`${result.judgeReport.executionMode}\`
- LLM status: \`${result.judgeReport.llmStatus}\`
- Policy: \`${result.judgeReport.policyVersion}\`
- LLM error: ${result.judgeReport.llmError ?? "无"}
- Why: ${releaseFinding?.reasoning ?? result.summary}
- Run bundle: ${result.runBundleFile}
- HTML report: ${result.htmlReportFile ?? "pending"}
- Artifact integrity: ${result.artifactIntegrityReportFile ?? "pending"}

## Risk Coverage

${result.riskCoverageMatrix.map((item) => `- \`${item.passed ? "pass" : item.covered ? "fail" : "warning"}\` ${item.riskTitle}: ${item.notes} ${evidenceRefs(item.evidenceRefs)}`).join("\n")}

## Evidence Timeline

${result.steps.map((step) => `- \`${step.status}\` ${step.title}: ${step.details}${step.screenshot ? ` (${step.screenshot})` : ""}`).join("\n")}

## Judge Report

${judgeMarkdown(result.judgeReport.planJudge)}

${judgeMarkdown(result.judgeReport.evidenceJudge)}

${judgeMarkdown(result.judgeReport.releaseJudge)}

## Failed Assertions

${failedAssertions.map((assertion) => `- **${assertion.name}**\n  - Expected: ${assertion.expected}\n  - Actual: ${assertion.actual}`).join("\n") || "- 无"}

## Failure Attribution

${attributionMarkdown(result)}

## Evidence Summary

${mdList(result.evidence.slice(-30).map((item) => `\`${item.id}\` ${item.type} ${item.title}${item.file ? ` ${item.file}` : ""}`))}

## Artifact Integrity

${integrityMarkdown(result)}

## Reproduce

- App URL: captured in \`run_bundle.json\`
- Scenario ID: captured in \`run_bundle.json\`
- Command: \`HEADLESS=1 npm run commit-check\`
`);
}

function verdictLabel(result: VisualRunResult) {
  const verdict = result.judgeReport.releaseJudge.verdict;
  if (verdict === "fail") return "阻塞修复";
  if (verdict === "needs_review") return "人工复核";
  return "可放行";
}

function judgeModeText(result: VisualRunResult) {
  if (result.judgeReport.executionMode === "llm_assisted") return "LLM-assisted Judge";
  if (result.judgeReport.executionMode === "fallback_baseline") return "Fallback baseline Judge";
  return "Deterministic Judge";
}

function renderJudgeCard(judge: JudgeResult) {
  return `<article class="judge-card ${escapeHtml(judge.verdict)}">
    <div>
      <h3>${escapeHtml(judge.title)}</h3>
      <span>${escapeHtml(judge.verdict)}</span>
    </div>
    <p>${escapeHtml(judge.summary)}</p>
    <ul>
      ${judge.findings.map((finding) => `<li>
        <strong>${escapeHtml(finding.title)}</strong>
        ${finding.failureClass ? `<code>${escapeHtml(finding.failureClass)}</code>` : ""}
        <p>${escapeHtml(finding.reasoning)}</p>
        <code>${escapeHtml(finding.evidenceRefs.join(", ") || "无 evidenceRefs")}</code>
      </li>`).join("") || "<li>无 findings</li>"}
    </ul>
  </article>`;
}

function renderArtifactIntegrity(result: VisualRunResult) {
  const report = result.artifactIntegrity;
  if (!report) {
    return `<li><strong>Artifact integrity</strong><p>Pending. The final run bundle will include <code>artifact_integrity.json</code>.</p></li>`;
  }
  const risky = report.items.filter((item) => ["missing", "unreadable", "path_escape"].includes(item.status));
  return `<li>
    <strong>Artifact integrity</strong>
    <p>total=${report.summary.total} · hashed=${report.summary.hashed} · missing=${report.summary.missing} · unreadable=${report.summary.unreadable} · pathEscapes=${report.summary.pathEscapes} · selfReferences=${report.summary.selfReferences}</p>
    <code>${escapeHtml(result.artifactIntegrityReportFile ?? "artifact_integrity.json")}</code>
    ${risky.length ? `<ul>${risky.slice(0, 6).map((item) => `<li><code>${escapeHtml(item.status)}</code> ${escapeHtml(item.artifactUri)}</li>`).join("")}</ul>` : "<p>No missing or unsafe artifact references.</p>"}
  </li>`;
}

export function renderHtmlReport(result: VisualRunResult) {
  const releaseFinding = result.judgeReport.releaseJudge.findings[0];
  const screenshots = result.steps.filter((step) => step.screenshot);
  const latestScreenshot = screenshots.at(-1)?.screenshot;
  const failedAssertions = result.assertions.filter((item) => !item.passed);
  return redactText(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI 测试官证据审计报告 ${escapeHtml(result.id)}</title>
  <style>
    :root { color: #171b18; background: #f4f5f2; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f5f2; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header, section { border: 1px solid #d9e0d8; border-radius: 8px; background: rgba(255,255,253,.94); padding: 18px; margin-bottom: 14px; box-shadow: 0 18px 44px rgba(22,27,23,.055); }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 10px; font-size: 28px; font-weight: 680; letter-spacing: 0; }
    h2 { margin-bottom: 14px; font-size: 18px; }
    h3 { margin-bottom: 8px; font-size: 14px; }
    code { display: inline-block; max-width: 100%; overflow-wrap: anywhere; border-radius: 5px; background: #eef1ed; padding: 2px 6px; }
    .verdict { display: inline-flex; align-items: center; border-radius: 999px; padding: 6px 12px; font-weight: 750; }
    .pass, .continue { background: #e7f2ec; color: #2e6549; }
    .needs_review, .hold_for_review { background: #f4eddf; color: #916f37; }
    .fail, .stop_and_fix, .failed { background: #f8e9e4; color: #9a4e3f; }
    .grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(320px, .92fr); gap: 14px; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .timeline, .coverage, .assertions, .evidence-list { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
    .timeline li, .coverage li, .assertions li, .evidence-list li, .judge-card { border: 1px solid #dce3da; border-radius: 8px; background: #fbfbf7; padding: 12px; }
    .timeline strong, .coverage strong { display: block; margin-bottom: 4px; }
    .timeline span, .coverage span { display: inline-flex; margin-bottom: 6px; border-radius: 999px; background: #eef1ed; padding: 2px 8px; font-size: 12px; font-weight: 700; }
    .judge-card > div { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .judge-card span { border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 750; background: rgba(255,255,255,.7); }
    .judge-card ul { display: grid; gap: 8px; list-style: none; margin: 10px 0 0; padding: 0; }
    .judge-card li { border-top: 1px solid rgba(217,224,216,.85); padding-top: 8px; }
    .judge-card p, .timeline p, .coverage p, .assertions p { margin-bottom: 0; color: #46504a; line-height: 1.5; }
    img { display: block; width: 100%; border: 1px solid #dce3da; border-radius: 8px; background: #1b211d; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: #667069; font-size: 13px; }
    @media (max-width: 860px) { main { padding: 14px; } .grid, .cards { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Evidence-Grounded AI Test Officer</h1>
      <p><span class="verdict ${escapeHtml(result.judgeReport.releaseJudge.verdict)}">${escapeHtml(verdictLabel(result))}</span></p>
      <p>${escapeHtml(releaseFinding?.reasoning ?? result.summary)}</p>
      <div class="meta">
        <code>${escapeHtml(result.id)}</code>
        <span>${escapeHtml(result.startedAt)} - ${escapeHtml(result.finishedAt)}</span>
      </div>
    </header>

    <section>
      <h2>Trust Boundary</h2>
      <ul class="evidence-list">
        <li><strong>Judge mode</strong><p>${escapeHtml(judgeModeText(result))} · source=${escapeHtml(result.judgeReport.source)} · llmStatus=${escapeHtml(result.judgeReport.llmStatus)}</p></li>
        <li><strong>Policy</strong><p>${escapeHtml(result.judgeReport.policyVersion)}</p></li>
        <li><strong>Evidence rule</strong><p>Release conclusions require cited evidence IDs; untrusted requirement and diff text are treated as data, not instructions.</p></li>
        ${renderArtifactIntegrity(result)}
        <li><strong>Fallback</strong><p>${result.judgeReport.llmError ? escapeHtml(result.judgeReport.llmError) : "No LLM fallback error recorded."}</p></li>
      </ul>
    </section>

    <section class="grid">
      <div>
        <h2>Risk Coverage</h2>
        <ul class="coverage">
          ${result.riskCoverageMatrix.map((item) => `<li>
            <span class="${item.passed ? "pass" : item.covered ? "fail" : "needs_review"}">${item.passed ? "pass" : item.covered ? "fail" : "warning"}</span>
            <strong>${escapeHtml(item.riskTitle)}</strong>
            <p>${escapeHtml(item.notes)}</p>
            <code>${escapeHtml(item.evidenceRefs.join(", ") || "无 evidenceRefs")}</code>
          </li>`).join("")}
        </ul>
      </div>
      <div>
        <h2>Latest Screenshot</h2>
        ${latestScreenshot ? `<img src="${escapeHtml(latestScreenshot)}" alt="latest screenshot" />` : "<p>无截图</p>"}
      </div>
    </section>

    <section>
      <h2>Evidence Timeline</h2>
      <ul class="timeline">
        ${result.steps.map((step) => `<li>
          <span class="${escapeHtml(step.status)}">${escapeHtml(step.status)}</span>
          <strong>${escapeHtml(step.title)}</strong>
          <p>${escapeHtml(step.details)}</p>
          ${step.screenshot ? `<code>${escapeHtml(step.screenshot)}</code>` : ""}
        </li>`).join("")}
      </ul>
    </section>

    <section>
      <h2>Judge Report</h2>
      <div class="cards">
        ${renderJudgeCard(result.judgeReport.planJudge)}
        ${renderJudgeCard(result.judgeReport.evidenceJudge)}
        ${renderJudgeCard(result.judgeReport.releaseJudge)}
      </div>
    </section>

    <section>
      <h2>Failed Assertions</h2>
      <ul class="assertions">
        ${failedAssertions.map((assertion) => `<li>
          <strong>${escapeHtml(assertion.name)}</strong>
          <p>Expected: ${escapeHtml(assertion.expected)}</p>
          <p>Actual: ${escapeHtml(assertion.actual)}</p>
        </li>`).join("") || "<li>无失败断言</li>"}
      </ul>
    </section>

    <section>
      <h2>Failure Attribution</h2>
      <ul class="evidence-list">
        ${result.failureAttributions.map((item) => `<li>
          <strong>#${item.rank} ${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.reasoning)}</p>
          <p>${escapeHtml(item.suggestedFix)}</p>
          <code>${escapeHtml(item.changeRefs?.map(changeRefLabel).join("; ") || "no change refs")}</code>
        </li>`).join("") || "<li>无失败归因</li>"}
      </ul>
    </section>

    <section>
      <h2>Reproduce</h2>
      <p><code>HEADLESS=1 npm run commit-check</code></p>
      <p>Bundle: <code>${escapeHtml(result.runBundleFile)}</code></p>
      <p>JSON: <code>${escapeHtml(result.reportFile)}</code></p>
      <p>Artifact integrity: <code>${escapeHtml(result.artifactIntegrityReportFile ?? "pending")}</code></p>
    </section>

    <section>
      <h2>Evidence Index</h2>
      <ul class="evidence-list">
        ${result.evidence.slice(-40).map((item) => `<li>
          <strong>${escapeHtml(item.id)}</strong>
          <p>${escapeHtml(item.type)} · ${escapeHtml(item.title)}</p>
          ${item.file ? `<code>${escapeHtml(item.file)}</code>` : ""}
        </li>`).join("")}
      </ul>
    </section>
  </main>
</body>
</html>`);
}

export async function writeReadableReports(input: {
  runDir: string;
  artifactBaseUrl: string;
  result: VisualRunResult;
}) {
  await mkdir(input.runDir, { recursive: true });
  const markdown = renderMarkdownReport(input.result);
  const markdownFile = path.join(input.runDir, "report.md");
  const htmlFile = path.join(input.runDir, "report.html");
  const resultWithReportLink = {
    ...input.result,
    markdownReportFile: `${input.artifactBaseUrl}/report.md`,
    htmlReportFile: `${input.artifactBaseUrl}/report.html`
  };
  const html = renderHtmlReport(resultWithReportLink);
  await writeFile(markdownFile, markdown);
  await writeFile(htmlFile, html);
  return {
    markdownReportFile: `${input.artifactBaseUrl}/report.md`,
    htmlReportFile: `${input.artifactBaseUrl}/report.html`
  };
}
