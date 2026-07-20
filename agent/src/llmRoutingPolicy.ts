import type { ImpactAnalysis, IntakeAnalysis, LayeredJudgeReport } from "./types.js";

export interface LlmRoutingDecision {
  route: "deterministic" | "llm";
  reason: string;
  signals: string[];
}

const ambiguityPattern = /(?:或许|可能|视情况|适当|合理|兼容|优化一下|appropriate|maybe|possibly|ambiguous|unclear)/i;

export function routePlanner(input: {
  requirement?: string;
  explicitScenarioId?: string;
  intake: IntakeAnalysis;
  impactAnalysis?: ImpactAnalysis;
}): LlmRoutingDecision {
  if (input.explicitScenarioId) return { route: "deterministic", reason: "caller_bound_scenario", signals: ["explicit_scenario"] };
  const executable = input.intake.scenarioCandidates.filter((item) => item.executable && item.source !== "patrol");
  const ranked = input.impactAnalysis?.recommendedScenarios ?? [];
  const top = ranked[0];
  const second = ranked[1];
  const margin = top ? (top.score ?? 0) - (second?.score ?? 0) : 0;
  const signals: string[] = [];
  if (ambiguityPattern.test(input.requirement ?? "")) signals.push("ambiguous_requirement_language");
  if (executable.length === 0) signals.push("no_executable_scenario");
  if (input.impactAnalysis?.uncoveredRisks.length) signals.push("uncovered_risk");
  if (ranked.length > 1 && margin < 12) signals.push("close_scenario_scores");
  if (!top || top.confidence === "low") signals.push("low_impact_confidence");
  if (signals.length) return { route: "llm", reason: "complex_or_ambiguous_planning", signals };
  return {
    route: "deterministic",
    reason: "high_confidence_rule_match",
    signals: [`top_scenario:${top.scenarioId}`, `score_margin:${margin}`]
  };
}

export function routeJudge(input: {
  baseline: LayeredJudgeReport;
  conflictStatus: "not_triggered" | "needs_replay" | "resolved" | "needs_user_review";
  failedAssertionCount: number;
  insufficientEvidenceCount: number;
}): LlmRoutingDecision {
  const signals: string[] = [];
  if (["needs_replay", "needs_user_review"].includes(input.conflictStatus)) signals.push(`evidence_conflict:${input.conflictStatus}`);
  if (input.baseline.planJudge.verdict !== input.baseline.evidenceJudge.verdict) signals.push("judge_layer_disagreement");
  const deterministicClasses = new Set((input.baseline.releaseJudge.findings ?? []).map((finding) => finding.failureClass).filter(Boolean));
  const hasKnownAttribution = deterministicClasses.size === 1
    && [...deterministicClasses].every((failureClass) => ["product_bug", "test_script_issue", "environment_issue", "insufficient_evidence"].includes(failureClass!));
  // A deterministic product, environment, script, or evidence verdict is
  // already actionable. Calling an LLM there only increases latency and must
  // not be required for a formal decision.
  if (input.baseline.releaseJudge.verdict === "needs_review" && input.failedAssertionCount > 0 && !hasKnownAttribution) signals.push("failure_attribution_unclear");
  if (input.insufficientEvidenceCount > 0 && !hasKnownAttribution) signals.push("evidence_insufficient_unclassified");
  if (signals.length) return { route: "llm", reason: "conflict_or_unclear_attribution", signals };
  return { route: "deterministic", reason: "deterministic_evidence_sufficient", signals: ["no_conflict", "grounded_evidence"] };
}
