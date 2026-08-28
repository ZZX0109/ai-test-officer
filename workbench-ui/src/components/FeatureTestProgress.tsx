// Per-feature test verdict strip + list, joined on scenarioId.
//
// The user-facing business-function list carries planning status only
// (ready/needs-confirmation/blocked). A test verdict (pass/fail/blocked) lives
// on the run's conclusions, keyed by scenarioId. The internal businessFlows
// carry scenarioId, so joining flows -> conclusions -> verdict lets the
// Workbench show each testable feature turning color as the run executes,
// instead of burying verdicts in the trajectory or final report.

import type { Conclusion, CoverageItem, PlannedBusinessFlow } from "../types";

// "repaired" is green like "pass" but distinguishes a verdict that was flipped
// by a repair retest from one the original run produced. It lets the feature
// list mark a previously-failed feature green after the user repairs + the
// sandbox retest passes, without claiming the original run passed.
export type FeatureVerdict = "pass" | "fail" | "blocked" | "running" | "pending" | "repaired";

function verdictFromConclusion(conclusion: Conclusion): FeatureVerdict {
  if (conclusion.status === "passed") return "pass";
  if (conclusion.status === "failed") return "fail";
  return "blocked";
}

const VERDICT_LABEL: Record<FeatureVerdict, string> = {
  pass: "通过",
  fail: "失败",
  blocked: "阻塞",
  running: "进行中",
  pending: "待测",
  repaired: "修复通过"
};

export function FeatureTestProgress(props: {
  flows: PlannedBusinessFlow[];
  conclusions: Conclusion[];
  coverageItems?: CoverageItem[];
  runActive: boolean;
  /** ScenarioIds whose failed conclusion has been overturned by a passed
   * repair retest. The feature list turns green for these. */
  repairVerifiedScenarioIds?: Set<string>;
  /** Open a feature-scoped repair session for a failed feature. The runId is
   * the run that produced the failed conclusion (a child run for that one
   * scenario), so the repair is scoped to that feature by construction. */
  onRepair?: (runId: string, title: string) => void;
}) {
  const { flows, conclusions, coverageItems = [], runActive, repairVerifiedScenarioIds, onRepair } = props;
  const testable = flows;
  if (!testable.length) return null;

  // Conclusions arrive in append order; the last one per scenario wins.
  const latestByScenario = new Map<string, Conclusion>();
  for (const conclusion of conclusions) {
    latestByScenario.set(conclusion.scenarioId, conclusion);
  }
  const coverageByFlow = new Map(coverageItems.map((item) => [item.flowId, item]));

  const counts: Record<FeatureVerdict, number> = { pass: 0, fail: 0, blocked: 0, running: 0, pending: 0, repaired: 0 };
  const rows = testable.map((flow) => {
    const conclusion = latestByScenario.get(flow.scenarioId ?? "");
    const coverage = coverageByFlow.get(flow.id);
    let verdict: FeatureVerdict = coverage?.disposition === "executed" ? "pass"
      : coverage?.disposition === "failed" ? "fail"
        : coverage?.disposition === "blocked" || coverage?.disposition === "excluded" ? "blocked"
          : coverage?.disposition === "binding" || coverage?.disposition === "executing" ? "running"
            : conclusion ? verdictFromConclusion(conclusion)
              : "pending";
    // A passed repair retest overturns a failed/blocked verdict for that
    // feature. An already-passing feature is left as "pass".
    if (verdict !== "pass" && repairVerifiedScenarioIds?.has(flow.scenarioId ?? "")) {
      verdict = "repaired";
    }
    counts[verdict] += 1;
    return { flow, verdict, conclusion, coverage };
  });

  return (
    <section className="feature-test-progress" aria-label="逐条测试进度">
      <strong>逐条测试进度</strong>
      <div className="feature-test-progress__chips">
        <span className={`verdict-chip verdict-pass`}>通过 {counts.pass}</span>
        <span className={`verdict-chip verdict-repaired`}>修复通过 {counts.repaired}</span>
        <span className={`verdict-chip verdict-fail`}>失败 {counts.fail}</span>
        <span className={`verdict-chip verdict-blocked`}>阻塞 {counts.blocked}</span>
        {runActive ? <span className={`verdict-chip verdict-running`}>进行中 {counts.running}</span> : null}
        <span className={`verdict-chip verdict-pending`}>待测 {counts.pending}</span>
      </div>
      <ol className="feature-test-progress__list">
        {rows.map(({ flow, verdict, conclusion, coverage }) => (
          <li key={flow.id} className={`feature-test-progress__item verdict-${verdict}`}>
            <span className="verdict-dot" aria-hidden />
            <span className="feature-test-progress__title">{flow.title}</span>
            <span className="feature-test-progress__verdict">{VERDICT_LABEL[verdict]}</span>
            {coverage?.dispositionReason ? <span className="feature-test-progress__reason" title={coverage.dispositionReason}>{coverage.dispositionReason}</span> : null}
            {verdict === "fail" && conclusion && onRepair ? (
              <button
                type="button"
                className="feature-test-progress__repair"
                onClick={() => onRepair(conclusion.runId, flow.title)}
              >
                修复此功能
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
