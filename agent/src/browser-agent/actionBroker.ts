import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Frame, Locator } from "playwright";
import {
  browserActionResultSchema,
  type BrowserActionResult,
  type BrowserAgentAction,
  type BrowserControl,
  type BrowserObservation,
  type DynamicOracle
} from "@ai-test-officer/contracts";
import { appendEvidence, getReportsDir } from "../evidenceStore.js";
import {
  acquireBrowserControl,
  commitBrowserAgentArtifact,
  dynamicBrowserScenarioId,
  getManagedBrowserSession,
  observeManagedBrowserSession,
  updateManagedBrowserSession
} from "./sessionManager.js";
import {
  appendBrowserActionResult,
  publishBrowserAgentLifecycle,
  readBrowserObservation
} from "./store.js";

const destructivePattern = /delete|remove|destroy|purchase|buy|pay|send|publish|deploy|删除|移除|购买|支付|发送|发布|部署/i;
const credentialPattern = /credential|password|secret|login|username|token|凭据|密码|登录|账号/i;

function controlDescription(control: BrowserControl) {
  return [control.role, control.accessibleName, control.label, control.testId].filter(Boolean).join(" ");
}

export function browserActionPolicy(action: BrowserAgentAction, control?: BrowserControl) {
  if (action.risk === "forbidden") return { allowed: false, confirmation: false, code: "browser_action_forbidden" };
  if (action.action === "fill-control" && credentialPattern.test(action.valueRef)) return { allowed: false, confirmation: true, code: "browser_credential_confirmation_required" };
  if (action.action === "navigate-route" && action.risk !== "low") return { allowed: false, confirmation: true, code: "browser_navigation_confirmation_required" };
  if (control && destructivePattern.test(`${controlDescription(control)} ${action.purpose}`)) return { allowed: false, confirmation: true, code: "browser_destructive_confirmation_required" };
  if (action.risk === "high") return { allowed: false, confirmation: true, code: "browser_high_risk_confirmation_required" };
  return { allowed: true, confirmation: false };
}

function frameForControl(frames: Frame[], control: BrowserControl) {
  if (control.framePath.length === 0) return frames.find((frame) => frame.parentFrame() === null);
  const expected = control.framePath.at(-1);
  return frames.find((frame) => frame.url() === expected);
}

function safeCss(value: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9-]*(?:\[(?:name|type)="[a-zA-Z0-9_.:@/-]+"\]){0,2}$/.test(value)) {
    throw new Error("browser_css_candidate_rejected");
  }
  return value;
}

async function resolveControlLocator(observation: BrowserObservation, controlId: string): Promise<{ control: BrowserControl; locator: Locator }> {
  const managed = getManagedBrowserSession(observation.runId);
  if (!managed) throw new Error("browser_session_not_active");
  const control = observation.controls.find((item) => item.controlId === controlId);
  if (!control) throw new Error("browser_control_not_found");
  if (control.attemptId !== managed.state.attemptId) throw new Error("browser_control_cross_attempt");
  if (!control.visible || control.disabled || control.obscured) throw new Error("browser_control_not_actionable");
  const frame = frameForControl(managed.runtime.page.frames(), control);
  if (!frame) throw new Error("browser_control_frame_missing");
  for (const candidate of [...control.locatorCandidates].sort((left, right) => Number(right.unique) - Number(left.unique))) {
    let locator: Locator;
    if (candidate.strategy === "test-id") locator = frame.getByTestId(candidate.value);
    else if (candidate.strategy === "label") locator = frame.getByLabel(candidate.value, { exact: true });
    else if (candidate.strategy === "text") locator = frame.getByText(candidate.value, { exact: true });
    else if (candidate.strategy === "role-name") {
      const parsed = JSON.parse(candidate.value) as { role?: string; name?: string };
      if (!parsed.role || !parsed.name) continue;
      locator = frame.getByRole(parsed.role as Parameters<Frame["getByRole"]>[0], { name: parsed.name, exact: true });
    } else locator = frame.locator(safeCss(candidate.value));
    if (await locator.count().catch(() => 0) === 1 && await locator.isVisible().catch(() => false)) return { control, locator };
  }
  throw new Error("browser_control_binding_stale");
}

async function screenshotEvidence(runId: string, attemptId: string, stepId: string, phase: "before" | "after" | "failure") {
  const managed = getManagedBrowserSession(runId);
  if (!managed) throw new Error("browser_session_not_active");
  const directory = path.join(getReportsDir(), "runs", runId, "browser-agent", "screenshots");
  const finalPath = path.join(directory, `${stepId}-${phase}.png`);
  const temporary = `${finalPath}.${process.pid}.partial`;
  await mkdir(directory, { recursive: true });
  await managed.runtime.page.screenshot({ path: temporary, type: "png", animations: "disabled", timeout: 5_000 });
  await rename(temporary, finalPath);
  const artifact = await commitBrowserAgentArtifact({
    runId,
    filePath: finalPath,
    id: `${runId}_${stepId}_${phase}_screenshot`,
    stepId,
    kind: "screenshot",
    mediaType: "image/png"
  });
  return appendEvidence(runId, {
    type: "screenshot",
    title: `${phase} browser action ${stepId}`,
    scenarioId: dynamicBrowserScenarioId(runId),
    attemptId,
    stepId,
    file: artifact.storageUri,
    artifactIds: [artifact.id],
    locator: { pageUrl: managed.runtime.page.url(), viewport: managed.runtime.page.viewportSize() ?? undefined },
    payload: { phase, file: finalPath }
  });
}

async function observationEvidence(observation: BrowserObservation, stepId: string, phase: "before" | "after") {
  const directory = path.join(getReportsDir(), "runs", observation.runId, "browser-agent", "dom");
  const filePath = path.join(directory, `${stepId}-${phase}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, JSON.stringify(observation, null, 2));
  const artifact = await commitBrowserAgentArtifact({
    runId: observation.runId,
    filePath,
    id: `${observation.runId}_${stepId}_${phase}_dom`,
    stepId,
    kind: "dom",
    mediaType: "application/json"
  });
  return appendEvidence(observation.runId, {
    type: "dom",
    title: `${phase} dynamic browser observation`,
    scenarioId: dynamicBrowserScenarioId(observation.runId),
    attemptId: observation.attemptId,
    pathId: observation.coverageItemId,
    stepId,
    url: observation.finalUrl,
    file: artifact.storageUri,
    artifactIds: [artifact.id],
    locator: { pageUrl: observation.finalUrl, selector: "body", snapshotSha256: observation.pageFingerprint },
    payload: {
      phase,
      observationId: observation.observationId,
      pageFingerprint: observation.pageFingerprint,
      title: observation.title,
      readyState: observation.readyState,
      bodyTextSample: observation.bodyTextSample,
      controls: observation.controls.map((control) => ({ controlId: control.controlId, role: control.role, name: control.accessibleName, visible: control.visible, disabled: control.disabled })),
      consoleErrors: observation.consoleErrors,
      pageErrors: observation.pageErrors,
      failedRequests: observation.failedRequests
    }
  });
}

function compare(operator: "equals" | "contains" | "not-contains", actual: string, expected: string) {
  if (operator === "equals") return actual === expected;
  if (operator === "contains") return actual.includes(expected);
  return !actual.includes(expected);
}

function evaluateOracle(oracle: DynamicOracle, before: BrowserObservation, after: BrowserObservation) {
  if (oracle.type === "dom-change") {
    const changed = before.pageFingerprint !== after.pageFingerprint;
    const passed = oracle.expected === "changed" ? changed : !changed;
    return { oracleId: oracle.id, passed, actual: changed ? "DOM changed" : "DOM unchanged" };
  }
  if (oracle.type === "url") return { oracleId: oracle.id, passed: compare(oracle.operator, after.finalUrl, oracle.expected), actual: after.finalUrl };
  if (oracle.type === "count-change") {
    const delta = after.controls.length - before.controls.length;
    const actual = delta > 0 ? "increased" : delta < 0 ? "decreased" : "unchanged";
    return { oracleId: oracle.id, passed: actual === oracle.expected, actual };
  }
  if (oracle.type === "text") {
    const control = oracle.controlId ? after.controls.find((item) => item.controlId === oracle.controlId) : undefined;
    const actual = control ? controlDescription(control) : after.bodyTextSample;
    return { oracleId: oracle.id, passed: compare(oracle.operator, actual, oracle.expected), actual: actual.slice(0, 1_000) };
  }
  if (oracle.type === "element-state") {
    const control = after.controls.find((item) => item.controlId === oracle.controlId);
    const actual = !control || !control.visible ? "hidden" : control.disabled ? "disabled" : "enabled";
    const passed = oracle.expected === "visible" ? Boolean(control?.visible) : actual === oracle.expected;
    return { oracleId: oracle.id, passed, actual };
  }
  if (oracle.type === "input-state") {
    const control = after.controls.find((item) => item.controlId === oracle.controlId);
    const actual = control?.valueState ?? "empty";
    return { oracleId: oracle.id, passed: actual === oracle.expected, actual };
  }
  const matching = after.failedRequests.filter((request) => request.url.includes(oracle.operationId));
  const passed = oracle.expectedStatus === undefined
    ? matching.length === 0
    : matching.some((request) => request.status === oracle.expectedStatus);
  return { oracleId: oracle.id, passed, actual: matching.length ? matching.map((item) => `${item.method} ${item.url} ${item.status ?? item.failure ?? "failed"}`).join("\n") : "no failed request observed" };
}

async function executeAction(action: BrowserAgentAction, before: BrowserObservation, resolveValue: (valueRef: string) => Promise<string>) {
  const managed = getManagedBrowserSession(action.runId);
  if (!managed) throw new Error("browser_session_not_active");
  const page = managed.runtime.page;
  if (action.action === "observe-page" || action.action === "evaluate-oracle") return;
  if (action.action === "navigate-route") {
    const route = managed.routes.get(action.routeId);
    if (!route) throw new Error("browser_route_not_allowed");
    const destination = new URL(route, page.url());
    if (!managed.allowedOrigins.has(destination.origin)) throw new Error("browser_cross_origin_navigation_rejected");
    await page.goto(destination.toString(), { waitUntil: "domcontentloaded", timeout: action.timeoutMs });
    return;
  }
  if (action.action === "press-key" && !action.controlId) {
    await page.keyboard.press(action.key);
    return;
  }
  const targetControlId = "controlId" in action ? action.controlId : undefined;
  if (!targetControlId) throw new Error("browser_control_required");
  const { locator } = await resolveControlLocator(before, targetControlId);
  if (action.action === "click-control" || action.action === "submit-form") await locator.click({ timeout: action.timeoutMs });
  else if (action.action === "fill-control") await locator.fill(await resolveValue(action.valueRef), { timeout: action.timeoutMs });
  else if (action.action === "select-control") await locator.selectOption(await resolveValue(action.valueRef), { timeout: action.timeoutMs });
  else if (action.action === "check-control") await locator.setChecked(action.checked, { timeout: action.timeoutMs });
  else if (action.action === "press-key") await locator.press(action.key, { timeout: action.timeoutMs });
  else if (action.action === "scroll-to-control") await locator.scrollIntoViewIfNeeded({ timeout: action.timeoutMs });
  else if (action.action === "wait-for-control") {
    if (action.state === "visible" || action.state === "hidden") await locator.waitFor({ state: action.state, timeout: action.timeoutMs });
    else if (action.state === "enabled") await locator.isEnabled({ timeout: action.timeoutMs }).then((enabled) => { if (!enabled) throw new Error("browser_control_not_enabled"); });
    else await locator.isDisabled({ timeout: action.timeoutMs }).then((disabled) => { if (!disabled) throw new Error("browser_control_not_disabled"); });
  }
}

export async function executeBrowserAgentAction(input: {
  action: BrowserAgentAction;
  oracles: DynamicOracle[];
  resolveValue: (valueRef: string) => Promise<string>;
  /** Set only after the matching LangGraph interrupt was explicitly approved. */
  userAuthorized?: boolean;
}): Promise<BrowserActionResult> {
  const { action } = input;
  const startedAt = new Date().toISOString();
  const source = await readBrowserObservation(action.runId, action.sourceObservationId);
  if (!source) throw new Error("browser_source_observation_missing");
  if (source.attemptId !== action.attemptId) throw new Error("browser_action_cross_attempt");
  const managed = getManagedBrowserSession(action.runId);
  if (!managed) throw new Error("browser_session_not_active");
  await acquireBrowserControl(action.runId, "agent").catch((error) => {
    if (!(error instanceof Error) || error.message !== "browser_control_owned_by_agent") throw error;
  });
  const controlId = "controlId" in action ? action.controlId : undefined;
  const control = controlId ? source.controls.find((item) => item.controlId === controlId) : undefined;
  const policy = browserActionPolicy(action, control);
  const approvedByUser = input.userAuthorized === true && policy.confirmation === true;
  if (!policy.allowed && !approvedByUser) {
    await updateManagedBrowserSession(action.runId, { owner: "waiting-user", status: "waiting-user" });
    const result = browserActionResultSchema.parse({
      schemaVersion: "1.0", resultId: `browser_result_${randomUUID()}`, actionId: action.actionId,
      runId: action.runId, attemptId: action.attemptId,
      coverageItemId: action.coverageItemId,
      status: policy.confirmation ? "needs-confirmation" : "blocked", errorCode: policy.code,
      summary: policy.confirmation ? "该浏览器动作需要用户确认。" : "该浏览器动作被安全策略拒绝。",
      beforeObservationId: source.observationId, evidenceRefs: source.evidenceRefs,
      oracleResults: [], startedAt, completedAt: new Date().toISOString()
    });
    return appendBrowserActionResult(result);
  }
  publishBrowserAgentLifecycle({ runId: action.runId, type: "browser.action.authorized", payload: { actionId: action.actionId } });
  publishBrowserAgentLifecycle({ runId: action.runId, type: "browser.action.started", payload: { actionId: action.actionId, action: action.action } });
  const beforeDom = await observationEvidence(source, action.actionId, "before");
  const beforeScreenshot = await screenshotEvidence(action.runId, action.attemptId, action.actionId, "before").catch(() => undefined);
  try {
    const fresh = await observeManagedBrowserSession({ runId: action.runId, coverageItemId: action.coverageItemId });
    if (fresh.pageFingerprint !== action.sourcePageFingerprint) {
      await updateManagedBrowserSession(action.runId, { rebindCount: managed.state.rebindCount + 1 });
      publishBrowserAgentLifecycle({ runId: action.runId, type: "browser.control.changed", payload: { actionId: action.actionId, sourceObservationId: source.observationId, currentObservationId: fresh.observationId } });
      throw new Error("browser_control_binding_stale");
    }
    await executeAction(action, fresh, input.resolveValue);
    await managed.runtime.page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
    await managed.runtime.page.waitForTimeout(250);
    const after = await observeManagedBrowserSession({ runId: action.runId, coverageItemId: action.coverageItemId });
    const afterDom = await observationEvidence(after, action.actionId, "after");
    const afterScreenshot = await screenshotEvidence(action.runId, action.attemptId, action.actionId, "after").catch(() => undefined);
    const oracleResults = input.oracles.filter((oracle) => action.oracleIds.includes(oracle.id)).map((oracle) => evaluateOracle(oracle, fresh, after));
    const operationDirectory = path.join(getReportsDir(), "runs", action.runId, "browser-agent", "operations");
    const operationPath = path.join(operationDirectory, `${action.actionId}.json`);
    await mkdir(operationDirectory, { recursive: true });
    await writeFile(operationPath, JSON.stringify({ action, beforeObservationId: fresh.observationId, afterObservationId: after.observationId, oracleResults }, null, 2));
    const operationArtifact = await commitBrowserAgentArtifact({
      runId: action.runId,
      filePath: operationPath,
      id: `${action.runId}_${action.actionId}_operation`,
      stepId: action.actionId,
      kind: "operation-log",
      mediaType: "application/json"
    });
    const operation = await appendEvidence(action.runId, {
      type: "operation", title: `Dynamic browser action ${action.action}`, attemptId: action.attemptId,
      scenarioId: dynamicBrowserScenarioId(action.runId),
      pathId: action.coverageItemId, stepId: action.actionId, url: after.finalUrl,
      file: operationArtifact.storageUri,
      artifactIds: [operationArtifact.id],
      payload: { action, beforeObservationId: fresh.observationId, afterObservationId: after.observationId, oracleResults }
    });
    const evidenceRefs = [beforeDom.id, beforeScreenshot?.id, operation.id, afterDom.id, afterScreenshot?.id].filter((item): item is string => Boolean(item));
    const groundedOracleResults = await Promise.all(oracleResults.map(async (oracle) => {
      const evidence = await appendEvidence(action.runId, {
        type: "assertion", title: `Dynamic oracle ${oracle.oracleId}`, attemptId: action.attemptId,
        scenarioId: dynamicBrowserScenarioId(action.runId),
        pathId: action.coverageItemId, stepId: action.actionId,
        artifactIds: [operationArtifact.id],
        payload: oracle
      });
      publishBrowserAgentLifecycle({ runId: action.runId, type: "browser.oracle.evaluated", payload: { ...oracle, evidenceRefs: [evidence.id] } });
      return { ...oracle, evidenceRefs: [evidence.id] };
    }));
    const result = browserActionResultSchema.parse({
      schemaVersion: "1.0", resultId: `browser_result_${randomUUID()}`, actionId: action.actionId,
      runId: action.runId, attemptId: action.attemptId, status: "completed",
      coverageItemId: action.coverageItemId,
      summary: groundedOracleResults.every((item) => item.passed) ? "浏览器动作完成，绑定 Oracle 已验证。" : "浏览器动作完成，但至少一个绑定 Oracle 未通过。",
      beforeObservationId: fresh.observationId, afterObservationId: after.observationId,
      evidenceRefs: [...evidenceRefs, ...groundedOracleResults.flatMap((item) => item.evidenceRefs)],
      oracleResults: groundedOracleResults, startedAt, completedAt: new Date().toISOString()
    });
    await updateManagedBrowserSession(action.runId, { actionCount: managed.state.actionCount + 1 });
    return appendBrowserActionResult(result);
  } catch (error) {
    const failureScreenshot = await screenshotEvidence(action.runId, action.attemptId, action.actionId, "failure").catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const failureDirectory = path.join(getReportsDir(), "runs", action.runId, "browser-agent", "operations");
    const failurePath = path.join(failureDirectory, `${action.actionId}-failure.json`);
    await mkdir(failureDirectory, { recursive: true });
    await writeFile(failurePath, JSON.stringify({
      action,
      beforeObservationId: source.observationId,
      errorCode: message.split(":")[0],
      message,
      failedAt: new Date().toISOString()
    }, null, 2));
    const failureArtifact = await commitBrowserAgentArtifact({
      runId: action.runId,
      filePath: failurePath,
      id: `${action.runId}_${action.actionId}_failure_operation`,
      stepId: action.actionId,
      kind: "operation-log",
      mediaType: "application/json"
    });
    const failure = await appendEvidence(action.runId, {
      type: "operation", title: `Dynamic browser action failed: ${action.action}`, attemptId: action.attemptId,
      scenarioId: dynamicBrowserScenarioId(action.runId),
      pathId: action.coverageItemId, stepId: action.actionId,
      file: failureArtifact.storageUri,
      artifactIds: [failureArtifact.id],
      payload: { action, errorCode: message.split(":")[0], message }
    });
    const result = browserActionResultSchema.parse({
      schemaVersion: "1.0", resultId: `browser_result_${randomUUID()}`, actionId: action.actionId,
      runId: action.runId, attemptId: action.attemptId, status: "failed", errorCode: message.split(":")[0],
      coverageItemId: action.coverageItemId,
      summary: message, beforeObservationId: source.observationId,
      evidenceRefs: [beforeDom.id, beforeScreenshot?.id, failure.id, failureScreenshot?.id].filter((item): item is string => Boolean(item)),
      oracleResults: [], startedAt, completedAt: new Date().toISOString()
    });
    return appendBrowserActionResult(result);
  }
}
