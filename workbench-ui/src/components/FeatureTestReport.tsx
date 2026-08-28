// Per-feature test report, organized by the user-facing feature list rather
// than internal run/scenario/attempt IDs.
//
// The terminal report (workflow-guide step 8) joins businessFlows (which carry
// scenarioId) to the run's conclusions (keyed by scenarioId) so each feature is
// one row: title -> verdict -> evidence refs. It sits beside the dialogue and
// trajectory tabs, so a reader can cross from a feature's verdict to the full
// evidence trail in the trajectory panel.

import type { Conclusion, CoverageItem, PlannedBusinessFlow } from "../types";

export type ReportVerdict = "pass" | "fail" | "blocked" | "untested";

function verdictFromConclusion(conclusion: Conclusion): ReportVerdict {
  if (conclusion.status === "passed") return "pass";
  if (conclusion.status === "failed") return "fail";
  return "blocked";
}

const VERDICT_LABEL: Record<ReportVerdict, string> = {
  pass: "通过",
  fail: "失败",
  blocked: "阻塞",
  untested: "未测"
};

export function FeatureTestReport(props: {
  flows: PlannedBusinessFlow[];
  conclusions: Conclusion[];
  coverageItems?: CoverageItem[];
  /** Switch the run view to the trajectory tab so the reader can follow a
   * feature's verdict into its full evidence trail. */
  onViewTrajectory?: () => void;
}) {
  const { flows, conclusions, coverageItems = [], onViewTrajectory } = props;
  if (!flows.length) {
    return (
      <section className="feature-test-report" aria-label="按功能组织的测试报告">
        <p className="muted">尚未识别功能列表；完成识别与测试后，这里按功能给出结论。</p>
      </section>
    );
  }

  // Conclusions arrive in append order; the last one per scenario wins.
  const latestByScenario = new Map<string, Conclusion>();
  for (const conclusion of conclusions) {
    latestByScenario.set(conclusion.scenarioId, conclusion);
  }
  const coverageByFlow = new Map(coverageItems.map((item) => [item.flowId, item]));

  const rows = flows.map((flow) => {
    const conclusion = latestByScenario.get(flow.scenarioId ?? "");
    const coverage = coverageByFlow.get(flow.id);
    const verdict: ReportVerdict = coverage?.disposition === "executed" ? "pass"
      : coverage?.disposition === "failed" ? "fail"
        : coverage?.disposition === "blocked" || coverage?.disposition === "excluded" ? "blocked"
          : conclusion ? verdictFromConclusion(conclusion) : "untested";
    return { flow, verdict, conclusion, coverage };
  });

  const counts: Record<ReportVerdict, number> = { pass: 0, fail: 0, blocked: 0, untested: 0 };
  for (const row of rows) counts[row.verdict] += 1;
  const tested = rows.length - counts.untested;

  return (
    <section className="feature-test-report" aria-label="按功能组织的测试报告">
      <header className="feature-test-report__header">
        <strong>测试报告（按功能）</strong>
        <span className="feature-test-report__summary">
          共 {flows.length} 个功能 · 已测 {tested} · 通过 {counts.pass} · 失败 {counts.fail} · 阻塞 {counts.blocked}
        </span>
        {onViewTrajectory ? (
          <button type="button" className="feature-test-report__trajectory" onClick={onViewTrajectory}>
            在轨迹中查看证据
          </button>
        ) : null}
      </header>
      <table className="feature-test-report__table">
        <thead>
          <tr><th scope="col">功能</th><th scope="col">结论</th><th scope="col">证据</th></tr>
        </thead>
        <tbody>
          {rows.map(({ flow, verdict, conclusion, coverage }) => (
            <tr key={flow.id} className={`verdict-${verdict}`}>
              <td className="feature-test-report__title">{flow.title}</td>
              <td className="feature-test-report__verdict">
                <span className="verdict-dot" aria-hidden />
                {VERDICT_LABEL[verdict]}
              </td>
              <td className="feature-test-report__evidence">
                {conclusion?.evidenceRefs?.length ? (
                  <ul>
                    {conclusion.evidenceRefs.map((ref) => <li key={ref}>{ref}</li>)}
                  </ul>
                ) : <span className="muted">{coverage?.dispositionReason ?? "—"}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
