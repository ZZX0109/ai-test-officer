import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  persistRepairPlan,
  readRepairPlans,
  resolveRunRepairPlan,
  toAssistantRepairDecision,
  toRepairPlanPayload
} from "../src/repairPlan.js";
import type { RepairDecision } from "../src/types.js";

/**
 * Repair-plan ledger closure tests (P0-15).
 *
 * These cover the two loops that were still open after the panel/API work:
 *
 *  1. **Graph restart** — a re-entered graph recomputes the same plan. With a
 *     stable idempotency key the second write must NOT create a second plan,
 *     otherwise the feedback loop double-counts one failure.
 *  2. **Login blocked → user-executable recovery** — a credential failure must
 *     travel from the persisted decision all the way to a workbench action the
 *     user can actually press ("configure-credentials"), never "retry".
 *
 * Proof tampering and cross-attempt injection are covered separately by
 * `proofBundleIntegrity.test.ts`.
 */

const rootDir = path.basename(process.cwd()) === "agent"
  ? path.resolve(process.cwd(), "..")
  : process.cwd();

function planFileFor(runId: string) {
  return path.join(rootDir, "reports", "repair-plans", `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

const credentialDecision: RepairDecision = {
  owner: "user",
  type: "credential_required",
  executable: false,
  userMessage: "当前页面需要登录。\n\n请进入凭据管理配置测试账号。\n不要直接发送密码。",
  steps: ["打开凭据管理", "新增本项目可用测试账号", "重新执行 Discovery"],
  validation: "登录后进入业务页面并能发现可操作控件",
  nextAction: "credential_required"
};

async function testGraphRestartDoesNotDuplicatePlan(runId: string) {
  const idempotencyKey = `repair_plan_${runId}_credential_required`;
  const input = {
    runId,
    projectId: "project_test",
    failureType: "auth_required",
    problem: "被测页面是登录入口，未配置可用的测试账号。",
    decision: credentialDecision,
    attemptId: `${runId}_attempt_1`,
    scenarioId: "scenario_login",
    evidenceRefs: ["evidence_login_wall"],
    policyVersion: "repair-policy-v1",
    idempotencyKey
  };

  const first = await persistRepairPlan(input);
  assert.ok(first, "first persist must return the stored plan");
  assert.equal(first.id, idempotencyKey, "the idempotency key must be the plan id, so a re-run collides");

  // Simulate a graph restart recomputing the identical decision.
  await persistRepairPlan(input);

  const stored = await readRepairPlans(runId);
  const matching = stored.filter((plan) => plan.id === idempotencyKey);
  assert.equal(
    matching.length,
    1,
    `a graph restart must not duplicate the plan (found ${matching.length} copies)`
  );
  assert.equal(stored.length, 1, "no extra plan rows may appear for this run");
}

async function testPersistedPlanIsAuthoritativeAndActionable(runId: string) {
  const plan = await resolveRunRepairPlan(runId);
  assert.ok(plan, "the persisted plan must be resolvable for the run");
  assert.equal(plan.persisted, true, "a stored plan must win over a recomputed one");

  // Binding: without these the panel can describe a repair but not act on it.
  assert.equal(plan.planId, `repair_plan_${runId}_credential_required`);
  assert.equal(plan.attemptId, `${runId}_attempt_1`);
  assert.equal(plan.scenarioId, "scenario_login");
  assert.equal(plan.status, "pending");
  assert.deepEqual(plan.evidenceRefs, ["evidence_login_wall"]);
  assert.equal(plan.policyVersion, "repair-policy-v1");

  const payload = toRepairPlanPayload(plan);
  assert.ok(payload);
  // The whole point of P0-9/P0-10: a login wall offers the credential form,
  // never a retry the user cannot possibly satisfy.
  assert.equal(payload.action, "configure-credentials");
  assert.equal(payload.owner, "user");
  assert.equal(payload.type, "credential_required");
  assert.equal(payload.executable, false);
  assert.equal(payload.planId, plan.planId);
  assert.equal(payload.attemptId, plan.attemptId);
  assert.deepEqual(payload.evidenceRefs, ["evidence_login_wall"]);

  // The chat fallback and the panel must read the same decision.
  const assistantDecision = toAssistantRepairDecision(plan);
  assert.ok(assistantDecision);
  assert.equal(assistantDecision.type, "credential_required");
  assert.equal(assistantDecision.owner, "user");
  assert.equal(assistantDecision.executable, false);
  assert.match(assistantDecision.userMessage, /不要直接发送密码/);
}

async function testProductBugPlanIsNeverAgentExecutable(runId: string) {
  const stored = await persistRepairPlan({
    runId,
    failureType: "product_bug",
    problem: "结算金额与预期不一致。",
    decision: {
      owner: "developer",
      type: "product_bug",
      executable: false,
      userMessage: "失败由产品行为（疑似缺陷）导致。",
      steps: ["在沙盒中复现失败路径", "生成修复方案并展示 Diff"],
      validation: "确认后的修复使断言通过且未引入回归",
      nextAction: "product_bug"
    },
    attemptId: `${runId}_attempt_1`,
    idempotencyKey: `repair_plan_${runId}_product_bug`
  });
  assert.ok(stored);
  assert.equal(stored.owner, "developer", "a suspected product defect must never be owned by the agent");
  assert.equal(stored.executable, false, "acting on a product defect means editing source: never autonomous");

  const plan = await resolveRunRepairPlan(runId);
  assert.ok(plan);
  // The panel offers a reviewable diff, not a silent auto-fix.
  assert.equal(toRepairPlanPayload(plan)?.action, "create-repair");
}

export async function testRepairPlanLedger() {
  const runId = `run_test_repair_ledger_${process.pid}`;
  const productBugRunId = `run_test_repair_ledger_bug_${process.pid}`;
  try {
    await testGraphRestartDoesNotDuplicatePlan(runId);
    await testPersistedPlanIsAuthoritativeAndActionable(runId);
    await testProductBugPlanIsNeverAgentExecutable(productBugRunId);
    console.log("repair plan ledger tests passed");
  } finally {
    // Only the two files this test created; never a directory.
    await rm(planFileFor(runId), { force: true }).catch(() => undefined);
    await rm(planFileFor(productBugRunId), { force: true }).catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void testRepairPlanLedger();
}
