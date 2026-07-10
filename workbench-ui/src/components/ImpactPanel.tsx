import type { ImpactAnalysis } from "../types";

export function ImpactPanel({ impact }: { impact?: ImpactAnalysis }) {
  if (!impact) return null;
  const affected = [...impact.affectedPages, ...impact.affectedApis, ...impact.affectedComponents];
  return (
    <section className="impact-box">
      <h3>Impact Analysis</h3>
      <div className="source-list">
        {affected.map((item) => (
          <article key={item.id}>
            <strong>{item.target}</strong>
            <span>{item.kind} · {item.confidence}</span>
            <p>{item.reason}</p>
          </article>
        ))}
        {impact.recommendedScenarios.map((item) => (
          <article key={item.scenarioId} className="passed">
            <strong>{item.scenarioId}</strong>
            <span>recommended · {item.confidence}</span>
            <p>{item.reason}</p>
          </article>
        ))}
        {impact.uncoveredRisks.map((risk) => (
          <article key={risk.id} className="failed">
            <strong>{risk.title}</strong>
            <span>harness backlog</span>
            <p>{risk.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
