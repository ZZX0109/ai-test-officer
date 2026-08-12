import { randomUUID } from "node:crypto";
import { browserActionDecisionSchema, type BrowserObservation } from "@ai-test-officer/contracts";

function observedLoginForm(observation: BrowserObservation) {
  const actionable = observation.controls.filter((control) => control.visible && !control.disabled && !control.obscured);
  const password = actionable.find((control) => control.kind === "input" && control.inputType === "password");
  if (!password) return undefined;
  const username = actionable.find((control) => control.kind === "input" && control.controlId !== password.controlId && control.valueState !== "nonempty" && /email|user|account|login|账号|邮箱/i.test([control.inputType, control.accessibleName, control.label, control.testId].filter(Boolean).join(" ")));
  const submit = actionable.find((control) => control.kind === "button" && /sign\s*in|log\s*in|login|登录/i.test([control.accessibleName, control.label, control.testId].filter(Boolean).join(" ")));
  return submit ? { username, password, submit, passwordNeedsValue: password.valueState !== "nonempty" } : undefined;
}

/** Deterministic, evidence-grounded login continuation. The LLM never
 * guesses credentials; it receives this bounded decision after observation. */
export function credentialInterruptDecision(input: { runId: string; coverageItemId: string; observation: BrowserObservation; configured: boolean }) {
  const login = observedLoginForm(input.observation);
  if (!login) return undefined;
  const target = login.username ?? (login.passwordNeedsValue ? login.password : undefined);
  const valueRef = target?.controlId === login.password.controlId ? "credential.password" : "credential.username";
  const oracleId = target ? `oracle_${valueRef === "credential.password" ? "login_password" : "login_username"}_filled` : "oracle_login_submit_changes_page";
  const action = target
    ? { actionId: `browser_action_${randomUUID()}`, action: "fill-control" as const, runId: input.runId, attemptId: input.observation.attemptId, coverageItemId: input.coverageItemId, sourceObservationId: input.observation.observationId, sourcePageFingerprint: input.observation.pageFingerprint, controlId: target.controlId, valueRef, purpose: "使用项目测试账号填写已识别的登录字段", expectedChange: "登录字段从空变为已填写；系统不会记录账号或密码内容。", oracleIds: [oracleId], risk: "medium" as const, timeoutMs: 10_000 }
    : { actionId: `browser_action_${randomUUID()}`, action: "click-control" as const, runId: input.runId, attemptId: input.observation.attemptId, coverageItemId: input.coverageItemId, sourceObservationId: input.observation.observationId, sourcePageFingerprint: input.observation.pageFingerprint, controlId: login.submit.controlId, purpose: "提交已填写的登录表单并进入受测项目", expectedChange: "登录成功后，当前登录表单不再显示。", oracleIds: [oracleId], risk: "low" as const, timeoutMs: 10_000 };
  return browserActionDecisionSchema.parse({
    schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`, runId: input.runId, attemptId: input.observation.attemptId, observationId: input.observation.observationId,
    status: target ? "needs-confirmation" : "act",
    summary: target ? input.configured ? "已识别登录页面；需要授权在沙盒浏览器中使用已保存的测试账号继续。" : "已识别登录页面，但此项目尚未绑定测试账号。" : "登录字段已填写，正在提交登录表单。",
    actions: [action],
    oracles: [target ? { id: oracleId, type: "input-state" as const, controlId: target.controlId, expected: "nonempty" as const, description: "验证登录字段已填写，但不读取或保存字段内容。" } : { id: oracleId, type: "element-state" as const, controlId: login.password.controlId, expected: "hidden" as const, description: "验证登录成功后密码输入框已从当前页面消失。" }],
    evidenceRefs: input.observation.evidenceRefs,
    userQuestion: target ? input.configured ? "请确认允许系统仅在本次沙盒运行中使用已保存的测试账号。" : "请先在项目的“测试账号”配置中保存账号和密码；保存后可从此处继续，系统不会展示或写入报告。" : undefined,
    createdAt: new Date().toISOString()
  });
}
