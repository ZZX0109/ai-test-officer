import assert from "node:assert/strict";
import { buildRepairAction } from "../src/failureAttribution.js";
import {
  decideRepair,
  decideRepairFromDeterministic,
  generateUserMessage,
  mapDeterministicClassToFailureClass
} from "../src/repairDecision.js";
import { selectRepairableAttribution, toRepairPlanPayload } from "../src/repairPlan.js";
import {
  assistantActionForRepairDecision,
  buildDeterministicAssistantFallback
} from "../src/assistantFallback.js";
import { detectAuthenticationGate } from "../src/discoveryScan.js";
import { repairTypeToMemoryStrategy } from "../src/feedback-loop/feedbackLoop.js";
import type { FailureAttribution, FailureClass } from "../src/types.js";

function attribution(
  failureClass: FailureClass,
  overrides: Partial<FailureAttribution> = {}
): FailureAttribution {
  return {
    id: `attr_${failureClass}`,
    rank: 1,
    failureClass,
    title: `${failureClass} 失败`,
    reasoning: "selector #submit 未命中当前页面结构",
    suggestedFix: "",
    reproductionSteps: [],
    evidenceRefs: [],
    sourceContextIds: [],
    confidence: "medium",
    ...overrides
  };
}

function testRepairActionOwnership() {
  // Ownership must be derived from the failure class, not from optimism about
  // what the agent can fix. Only a script/selector defect is agent-owned.
  assert.equal(buildRepairAction("test_script_issue", "x").owner, "agent");
  assert.equal(buildRepairAction("test_script_issue", "x").type, "update_selector");
  assert.equal(buildRepairAction("environment_issue", "x").owner, "environment");
  assert.equal(buildRepairAction("environment_issue", "x").type, "fix_environment");
  assert.equal(buildRepairAction("insufficient_evidence", "x").owner, "user");
  assert.equal(buildRepairAction("product_bug", "x").owner, "developer");
  assert.equal(buildRepairAction("product_bug", "x").type, "product_bug");
  assert.equal(buildRepairAction("unknown", "x").owner, "developer");

  // Refined classification: the same failure class must split by the evidence
  // carried in the reasoning, otherwise every gap becomes "give me a password".
  assert.equal(buildRepairAction("test_script_issue", "selector #submit 未命中").type, "selector_drift");
  assert.equal(buildRepairAction("environment_issue", "health check 503 端口不可达").type, "runtime_unavailable");
  assert.equal(buildRepairAction("insufficient_evidence", "x").type, "evidence_missing");
  assert.equal(buildRepairAction("insufficient_evidence", "返回 401 未登录").type, "credential_required");
  assert.equal(buildRepairAction("insufficient_evidence", "返回 401 未登录").owner, "user");
  // An auth signal must beat the `unknown` fallback: a login wall is never a
  // "developer, please have a look" problem.
  assert.equal(buildRepairAction("unknown", "页面跳转到 /login").type, "credential_required");
  assert.equal(buildRepairAction("unknown", "页面跳转到 /login").owner, "user");

  for (const failureClass of [
    "test_script_issue",
    "environment_issue",
    "insufficient_evidence",
    "product_bug",
    "unknown"
  ] as FailureClass[]) {
    const action = buildRepairAction(failureClass, "reason");
    assert.ok(action.steps.length > 0, `${failureClass} 必须给出具体步骤`);
    assert.ok(action.validation.length > 0, `${failureClass} 必须给出验证方式`);
  }
}

function testDecideRepairExecutability() {
  // `executable` is the autonomy switch. Anything not owned by the agent must
  // never be auto-repaired, otherwise the loop silently retries a user problem.
  const scriptDecision = decideRepair(attribution("test_script_issue"));
  assert.equal(scriptDecision.owner, "agent");
  assert.equal(scriptDecision.executable, true);

  for (const failureClass of [
    "environment_issue",
    "insufficient_evidence",
    "product_bug",
    "unknown"
  ] as FailureClass[]) {
    const decision = decideRepair(attribution(failureClass));
    assert.equal(decision.executable, false, `${failureClass} 不允许自动修复`);
    assert.notEqual(decision.owner, "agent");
    assert.ok(decision.userMessage.trim().length > 0, `${failureClass} 必须有用户可读说明`);
    assert.equal(decision.nextAction, decision.type);
  }
}

function testDecisionPrefersAttachedRepairAction() {
  // A persisted attribution already carries the action that was decided when the
  // failure happened; re-deriving it would let the two drift apart.
  const decision = decideRepair(attribution("product_bug", {
    repairAction: {
      type: "provide_credential",
      owner: "user",
      steps: ["配置测试账号"],
      validation: "重新扫描不再停留在登录页"
    }
  }));
  assert.equal(decision.owner, "user");
  assert.equal(decision.type, "provide_credential");
  assert.deepEqual(decision.steps, ["配置测试账号"]);
}

function testUserMessagesAreActionable() {
  const credential = generateUserMessage(buildRepairAction("insufficient_evidence", "返回 401 未登录"));
  assert.match(credential, /登录/);
  assert.match(credential, /不要直接发送密码/);
  const evidence = generateUserMessage(buildRepairAction("insufficient_evidence", "x"));
  assert.match(evidence, /证据/);
  const environment = generateUserMessage(buildRepairAction("environment_issue", "x"));
  assert.match(environment, /Docker|APP_URL|端口/);
  const selector = generateUserMessage(buildRepairAction("test_script_issue", "x"));
  assert.match(selector, /自动更新/);
}

/**
 * The action offered in chat must be derived from the repair decision, not from
 * the reply template. Offering "重试失败链路" for a credential- or
 * environment-owned failure is a dead end the user cannot act on.
 */
function testAssistantActionFollowsDecision() {
  assert.equal(
    assistantActionForRepairDecision({ owner: "user", type: "credential_required" }),
    "configure-credentials"
  );
  assert.equal(
    assistantActionForRepairDecision({ owner: "environment", type: "runtime_unavailable" }),
    "retry-runtime"
  );
  assert.equal(
    assistantActionForRepairDecision({ owner: "agent", type: "selector_drift" }),
    "retry-failed-path"
  );
  assert.equal(
    assistantActionForRepairDecision({ owner: "developer", type: "product_bug" }),
    "create-repair"
  );
  assert.equal(
    assistantActionForRepairDecision({ owner: "user", type: "discovery_incomplete" }),
    "retry-discovery"
  );
  assert.equal(assistantActionForRepairDecision(undefined), undefined);
  // Unknown type still routes by owner instead of silently retrying.
  assert.equal(assistantActionForRepairDecision({ owner: "environment" }), "retry-runtime");
  assert.equal(assistantActionForRepairDecision({ owner: "developer" }), "open-evidence");

  // End-to-end: the deterministic fallback must surface the decision's action.
  const reply = buildDeterministicAssistantFallback({
    userMessage: "为什么失败了",
    finalStatus: "blocked",
    summary: "候选路径没有全部通过绑定",
    repairDecision: {
      owner: "user",
      type: "credential_required",
      executable: false,
      userMessage: "请先配置测试账号。",
      steps: ["打开凭据管理"],
      validation: "重新扫描不再停留在登录页"
    }
  });
  assert.equal(reply.suggestedAction, "configure-credentials");
  assert.match(reply.reply, /请先配置测试账号/);
}

function testDeterministicGraphClassMapping() {
  // The graph triage uses its own literals; an unmapped literal must degrade to
  // `unknown` (developer-owned), never to an agent-owned auto repair.
  assert.equal(mapDeterministicClassToFailureClass("environment"), "environment_issue");
  assert.equal(mapDeterministicClassToFailureClass("test-script"), "test_script_issue");
  assert.equal(mapDeterministicClassToFailureClass("product-bug"), "product_bug");
  assert.equal(mapDeterministicClassToFailureClass("something-new"), "unknown");

  const autoRepairable = decideRepairFromDeterministic(
    mapDeterministicClassToFailureClass("test-script"),
    "selector 漂移"
  );
  assert.equal(autoRepairable.executable, true);
  const blocked = decideRepairFromDeterministic(
    mapDeterministicClassToFailureClass("unrecognized"),
    "未知原因"
  );
  assert.equal(blocked.executable, false);
}

function testRepairPlanProjection() {
  const top = attribution("environment_issue", { rank: 2, title: "环境不可达" });
  const other = attribution("test_script_issue", { id: "attr_low", rank: 1, title: "选择器漂移" });
  // Rank ordering, not array order, decides which failure the plan addresses.
  assert.equal(selectRepairableAttribution([top, other])?.id, "attr_low");
  assert.equal(selectRepairableAttribution([])?.id, undefined);
  assert.equal(selectRepairableAttribution(undefined), undefined);

  const payload = toRepairPlanPayload({
    runId: "run_1",
    problem: top.title,
    decision: decideRepair(top)
  });
  assert.ok(payload);
  assert.equal(payload.owner, "environment");
  assert.equal(payload.problem, "环境不可达");
  assert.ok(payload.steps.length > 0);
  assert.ok(payload.message.length > 0);
  assert.equal(toRepairPlanPayload(undefined), undefined);
}

function testAuthenticationGateDetection() {
  const loginPage = {
    url: "http://localhost:5173/login",
    headings: ["请登录"],
    links: [],
    buttons: [{ text: "登录" }],
    inputs: [
      { label: "用户名", name: "username", type: "text" },
      { label: "密码", name: "password", type: "password" }
    ],
    forms: [{ inputCount: 2 }],
    testIds: []
  };
  assert.equal(
    detectAuthenticationGate({ page: loginPage, url: loginPage.url }).blocked,
    true
  );

  // 401/403 is an authentication wall even with no visible form.
  assert.equal(
    detectAuthenticationGate({
      page: { ...loginPage, inputs: [], buttons: [], headings: [] },
      url: "http://localhost:5173/",
      httpStatus: 401
    }).blocked,
    true
  );

  // A settings page with a password field is NOT a login wall: a false positive
  // here would stop a perfectly testable page and demand credentials.
  assert.equal(
    detectAuthenticationGate({
      page: {
        url: "http://localhost:5173/settings",
        headings: ["账户设置"],
        links: [],
        buttons: [{ text: "保存" }],
        inputs: [{ label: "新密码", name: "newPassword", type: "password" }],
        forms: [{ inputCount: 1 }],
        testIds: []
      },
      url: "http://localhost:5173/settings"
    }).blocked,
    false
  );

  // An ordinary dashboard must stay unblocked.
  assert.equal(
    detectAuthenticationGate({
      page: {
        url: "http://localhost:5173/dashboard",
        headings: ["概览"],
        links: [],
        buttons: [{ text: "新建" }],
        inputs: [{ label: "搜索", name: "q", type: "text" }],
        forms: [],
        testIds: []
      },
      url: "http://localhost:5173/dashboard"
    }).blocked,
    false
  );
}

function testRepairTypeMemoryMapping() {
  assert.equal(repairTypeToMemoryStrategy("update_selector"), "selector_fix");
  assert.equal(repairTypeToMemoryStrategy("selector_drift"), "selector_fix");
  assert.equal(repairTypeToMemoryStrategy("provide_credential"), "auth_fix");
  assert.equal(repairTypeToMemoryStrategy("credential_required"), "auth_fix");
  assert.equal(repairTypeToMemoryStrategy("fix_environment"), "config_change");
  assert.equal(repairTypeToMemoryStrategy("runtime_unavailable"), "config_change");
  assert.equal(repairTypeToMemoryStrategy("modify_code"), "code_patch");
  assert.equal(repairTypeToMemoryStrategy("product_bug"), "code_patch");
  assert.equal(repairTypeToMemoryStrategy("manual_review"), "other");
  assert.equal(repairTypeToMemoryStrategy("evidence_missing"), "other");
  assert.equal(repairTypeToMemoryStrategy("discovery_incomplete"), "other");
}

export function testRepairDecision() {
  testRepairActionOwnership();
  testDecideRepairExecutability();
  testDecisionPrefersAttachedRepairAction();
  testUserMessagesAreActionable();
  testAssistantActionFollowsDecision();
  testDeterministicGraphClassMapping();
  testRepairPlanProjection();
  testAuthenticationGateDetection();
  testRepairTypeMemoryMapping();
  console.log("repair decision tests passed");
}
