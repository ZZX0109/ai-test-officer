import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildLayeredJudgeReport } from "./judgeEngine.js";
import { buildJudgeEvalInput, loadJudgeCases } from "./judgeEval.js";
import { buildLlmJudgeReport } from "./llmJudge.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportDir = path.join(rootDir, "reports", "judge-repeat-eval");

function majority(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "needs_review";
}

async function main() {
  const policy = JSON.parse(await readFile(path.join(rootDir, "data", "judge-policy", "repeat-policy.json"), "utf8")) as {
    repetitionsPerCase: number;
    maxTokensPerCall: number;
    batchTokenBudget: number;
    maxEstimatedCostUsd: number;
    estimatedOutputCostPer1kUsd: number;
    estimatedInputCostPer1kUsd: number;
    caseCount: number;
  };
  const allCases = await loadJudgeCases();
  const cases = allCases.slice(0, policy.caseCount);
  const excludedCases = allCases.slice(policy.caseCount).map((item) => item.id);
  const repetitions = policy.repetitionsPerCase;
  const plannedCalls = cases.length * repetitions;
  const reservedOutputTokens = plannedCalls * policy.maxTokensPerCall;
  const estimatedCostUsd = reservedOutputTokens / 1000 * policy.estimatedOutputCostPer1kUsd;
  const enabled = ["1", "true", "yes", "on"].includes((process.env.JUDGE_LLM_REPEAT_ENABLED ?? "").toLowerCase());
  const budgetExhausted = reservedOutputTokens > policy.batchTokenBudget || estimatedCostUsd > policy.maxEstimatedCostUsd;
  const evaluations: Array<Record<string, unknown>> = [];

  if (enabled && !budgetExhausted) {
    for (const caseItem of cases) {
      const input = buildJudgeEvalInput(caseItem);
      const baseline = buildLayeredJudgeReport(input);
      const calls = [];
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const report = await buildLlmJudgeReport({ ...input, baseline, maxTokens: policy.maxTokensPerCall });
        calls.push({ repetition, executionMode: report.executionMode, llmStatus: report.llmStatus, verdict: report.releaseJudge.verdict, error: report.llmError });
      }
      const verdicts = calls.map((call) => String(call.verdict));
      const stableVerdict = majority(verdicts);
      evaluations.push({ caseId: caseItem.id, expectedVerdict: caseItem.expectedReleaseVerdict, calls, stableVerdict, consistency: calls.filter((call) => call.verdict === stableVerdict).length / calls.length });
    }
  }

  const output = {
    id: `judge_repeat_eval_${Date.now()}`,
    createdAt: new Date().toISOString(),
    status: !enabled ? "disabled" : budgetExhausted ? "budget_exhausted" : "completed",
    policy: { ...policy, plannedCalls, reservedOutputTokens, estimatedCostUsd },
    caseCount: cases.length,
    excludedCases,
    repetitionsPerCase: repetitions,
    evaluations,
    metrics: evaluations.length > 0 ? {
      callsCompleted: evaluations.reduce((sum, item) => sum + (Array.isArray(item.calls) ? item.calls.length : 0), 0),
      meanConsistency: evaluations.reduce((sum, item) => sum + Number(item.consistency ?? 0), 0) / evaluations.length,
      majorityAgreement: evaluations.filter((item) => item.stableVerdict === item.expectedVerdict).length / evaluations.length
    } : null
  };
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "latest.json"), JSON.stringify(output, null, 2));
  await writeFile(path.join(reportDir, `${output.id}.json`), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
