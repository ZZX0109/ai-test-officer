import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  finalizeLlmBudget,
  readLlmBudgetLedger,
  reserveLlmBudget
} from "../src/llmBudgetLedger.js";

export async function testLlmBudgetLedger() {
  const runId = `run_budget_${randomUUID().replaceAll("-", "")}`;
  const budget = {
    maxPlannerCalls: 2,
    maxJudgeCalls: 1,
    maxTriageCalls: 1,
    maxRepairCallsPerRound: 2,
    maxRepairRounds: 2,
    maxTransportAttempts: 3,
    maxSemanticRepairAttempts: 1,
    maxTotalTokens: 1_000,
    plannerMaxOutputTokens: 300,
    judgeMaxOutputTokens: 200,
    requestTimeoutMs: 1_000,
    totalTimeoutMs: 5_000
  };
  const logical = await reserveLlmBudget({
    runId,
    purpose: "judging",
    budget,
    estimatedTokens: 200,
    estimatedWallClockMs: 500,
    estimatedCostUsd: null
  });
  await finalizeLlmBudget(logical, {
    tokens: 120,
    wallClockMs: 100,
    estimatedCostUsd: null
  });
  const semanticRepair = await reserveLlmBudget({
    runId,
    purpose: "judging",
    budget,
    estimatedTokens: 100,
    estimatedWallClockMs: 300,
    estimatedCostUsd: null,
    countLogicalCall: false
  });
  await finalizeLlmBudget(semanticRepair, {
    tokens: 60,
    wallClockMs: 80,
    estimatedCostUsd: null
  });
  const ledger = await readLlmBudgetLedger(runId, budget);
  assert.equal(ledger.consumed.judgeCalls, 1, "semantic repair must not count as a second logical Judge call");
  assert.equal(ledger.consumed.tokens, 180);
  assert.equal(ledger.consumed.estimatedCostUsd, null, "unknown model price must remain unknown");
  await assert.rejects(
    reserveLlmBudget({
      runId,
      purpose: "judging",
      budget,
      estimatedTokens: 10,
      estimatedWallClockMs: 10,
      estimatedCostUsd: null
    }),
    /llm_budget_exceeded:judging_calls/
  );

  const browserBudget = { ...budget, maxBrowserActionCalls: 1 };
  const firstPath = await reserveLlmBudget({
    runId,
    scopeId: "coverage-path-a",
    purpose: "browser-action",
    budget: browserBudget,
    estimatedTokens: 800,
    estimatedWallClockMs: 500,
    estimatedCostUsd: null
  });
  await finalizeLlmBudget(firstPath, { tokens: 700, wallClockMs: 100, estimatedCostUsd: null });
  await assert.rejects(
    reserveLlmBudget({
      runId,
      scopeId: "coverage-path-a",
      purpose: "browser-action",
      budget: browserBudget,
      estimatedTokens: 10,
      estimatedWallClockMs: 10,
      estimatedCostUsd: null
    }),
    /llm_budget_exceeded:browser-action_calls/,
    "one path must retain its own bounded model-call allowance"
  );
  const secondPath = await reserveLlmBudget({
    runId,
    scopeId: "coverage-path-b",
    purpose: "browser-action",
    budget: browserBudget,
    estimatedTokens: 800,
    estimatedWallClockMs: 500,
    estimatedCostUsd: null
  });
  await finalizeLlmBudget(secondPath, { tokens: 650, wallClockMs: 90, estimatedCostUsd: null });
  const scopedLedger = await readLlmBudgetLedger(runId, budget);
  assert.equal(scopedLedger.scopes["coverage-path-a"]?.consumed.browserActionCalls, 1);
  assert.equal(scopedLedger.scopes["coverage-path-b"]?.consumed.browserActionCalls, 1);
  assert.equal(scopedLedger.consumed.browserActionCalls, 2, "Run totals must still aggregate actual browser usage");
  assert.equal(scopedLedger.consumed.tokens, 1_530, "Run totals remain transparent even when path budgets are isolated");
  await rm(path.resolve(process.cwd(), "..", "reports", "llm-budgets", `${runId}.json`), { force: true });
}
