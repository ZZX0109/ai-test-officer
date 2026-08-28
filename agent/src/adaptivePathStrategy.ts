import type { AdaptivePathDecisionV1, CoverageItem } from "@ai-test-officer/contracts";
import { adaptivePathDecisionV1Schema } from "@ai-test-officer/contracts";

const riskWeight: Record<CoverageItem["risk"], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

export interface PathInformationSignal {
  uncertainty?: number;
  expectedInformationGain?: number;
  cost?: number;
  evidenceRefs?: string[];
}

export function rankCoverageItems(input: {
  items: CoverageItem[];
  signals?: Record<string, PathInformationSignal>;
}): { items: CoverageItem[]; decisions: AdaptivePathDecisionV1[] } {
  const signals = input.signals ?? {};
  const scored = input.items.map((item) => {
    const signal = signals[item.id] ?? {};
    const uncertainty = Math.max(0, signal.uncertainty ?? (item.disposition === "pending" ? 1 : 0.5));
    const expectedInformationGain = Math.max(0, signal.expectedInformationGain ?? 1);
    const cost = Math.max(0.01, signal.cost ?? 1);
    const score = riskWeight[item.risk] * uncertainty * expectedInformationGain / cost;
    return { item, uncertainty, expectedInformationGain, cost, score, evidenceRefs: signal.evidenceRefs ?? [] };
  }).sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id));

  const decisions = scored.map((entry, index) => adaptivePathDecisionV1Schema.parse({
    schemaVersion: "1.0",
    coverageItemId: entry.item.id,
    risk: riskWeight[entry.item.risk],
    uncertainty: entry.uncertainty,
    expectedInformationGain: entry.expectedInformationGain,
    cost: entry.cost,
    score: entry.score,
    rank: index + 1,
    reason: `risk(${riskWeight[entry.item.risk]}) × uncertainty(${entry.uncertainty}) × informationGain(${entry.expectedInformationGain}) ÷ cost(${entry.cost})`,
    evidenceRefs: entry.evidenceRefs,
    createdAt: new Date().toISOString()
  }));

  // Ranking is allowed to reorder work, never to remove a CoverageItem.
  return { items: scored.map((entry) => entry.item), decisions };
}
