import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Locator } from "playwright";
import type { ArtifactV2 } from "@ai-test-officer/contracts";
import { commitCapturedFile, type AttemptClock } from "@ai-test-officer/playwright-runtime";
import { BudgetTracker } from "@ai-test-officer/execution-worker";
import { appendAudit } from "../auditLog.js";
import { appendLoopEvent } from "../loopEventStore.js";
import { getProject, resolveProjectTarget } from "../projectAdapter.js";
import { getProjectLoginSecret } from "../projectLoginStore.js";
import { getScenario, type ScenarioAction, type ScenarioOracle } from "../scenarios.js";
import { executeStructuredAction } from "../structuredActionExecutors.js";
import { classifyExecutionError, reloadUsablePage } from "../executionRuntime.js";
import { executeCompiledAction } from "./compiledPlanBinding.js";
import type { EvidenceItem, RunRequest, RunStepEvidence, VisualRunResult } from "../types.js";

type Scenario = ReturnType<typeof getScenario>;
type Project = Awaited<ReturnType<typeof getProject>>;
type TargetRuntime = Awaited<ReturnType<typeof resolveProjectTarget>>;
type ProjectLoginSecret = Awaited<ReturnType<typeof getProjectLoginSecret>>;
type Attempt = NonNullable<VisualRunResult["attempts"]>[number];
type PageObservation = {
  evidence: EvidenceItem;
  snapshot: {
    phase: "before" | "after" | "failure";
    url: string;
    title: string;
    readyState: string;
    bodyTextSample: string;
    bodyHash: string;
    interactiveElementCount: number;
    controls: Array<{ kind: string; name?: string; testId?: string; visible: boolean; disabled: boolean }>;
    alerts: string[];
    consoleErrors: string[];
    failedRequests: Array<{ method: string; url: string; status?: number }>;
    capturedAt: string;
    changes?: string[];
  };
};

export interface ScenarioExecutionContext {
  input: RunRequest;
  page: Page;
  scenario: Scenario;
  compiledPlan?: RunRequest["compiledPlan"];
  configuredProject: Project;
  targetRuntime: TargetRuntime;
  projectLoginSecret: ProjectLoginSecret;
  runDir: string;
  frontendUrl: string;
  artifactUrl: (filePath: string) => string;
  attemptClock: AttemptClock;
  id: string;
  getActiveAttempt: () => number;
  setActiveAttempt: (attempt: number) => void;
  getCapturedScreenshotCount: () => number;
  attemptIdentity: () => { runId: string; scenarioId: string; attemptId: string; attempt: number };
  attempts: Attempt[];
  artifactsV2: ArtifactV2[];
  budgetTracker: BudgetTracker;
  steps: RunStepEvidence[];
  network: VisualRunResult["network"];
  consoleEvents: VisualRunResult["console"];
  assertions: VisualRunResult["assertions"];
  browserLifecycleEvents: Array<Record<string, unknown>>;
  appendEvidence: (runId: string, evidence: Omit<EvidenceItem, "id" | "runId" | "timestamp">) => Promise<EvidenceItem>;
  screenshot: (stepId: string) => Promise<string | undefined>;
  captureStepPageObservation: (
    stepId: string,
    pathId: string,
    phase: "before" | "after" | "failure",
    telemetryStart: { network: number; console: number },
    before?: PageObservation["snapshot"]
  ) => Promise<PageObservation>;
  recordAssertion: (
    assertion: VisualRunResult["assertions"][number],
    pathId: string,
    stepId?: string
  ) => Promise<EvidenceItem>;
  evaluateOracle: (oracle: ScenarioOracle, stepId: string, pathId?: string) => Promise<EvidenceItem>;
  evaluateCompiledSmokePath: (stepId: string) => Promise<EvidenceItem>;
  evaluateCompiledRegressionPath: (
    stepId: string,
    pathId: string,
    telemetryStart: { network: number; console: number }
  ) => Promise<EvidenceItem>;
  isSmokeAnchorVisible: () => Promise<boolean>;
  assertWithinRunBudget: () => void;
  clickButton?: never;
  resolveObservedLoginField?: never;
  recordBrowserLifecycle: () => void;
  startAttemptTrace: () => Promise<void>;
  finishAttemptTrace: () => Promise<void>;
}

export function createScenarioExecutor(context: ScenarioExecutionContext) {
  const {
    appendEvidence, artifactsV2, assertions, attemptIdentity, attempts, browserLifecycleEvents,
    budgetTracker, captureStepPageObservation, configuredProject, consoleEvents, evaluateCompiledRegressionPath,
    evaluateCompiledSmokePath, evaluateOracle, finishAttemptTrace, id, input, isSmokeAnchorVisible,
    network, page, projectLoginSecret, recordAssertion, recordBrowserLifecycle, runDir, scenario,
    screenshot, startAttemptTrace, steps, targetRuntime, assertWithinRunBudget, compiledPlan,
    frontendUrl, artifactUrl, attemptClock
  } = context;
  let activeAttempt = context.getActiveAttempt();
  let activeCompiledStepId: string | undefined;
  let executionError: NonNullable<VisualRunResult["executionError"]> | undefined;

  async function clickButton(name: string | undefined, options: { allowObservedAuthButton?: boolean } = {}) {
    if (!name) throw new Error(`Scenario ${scenario.id} 缺少按钮名称`);
    const exact = page.getByRole("button", { name, exact: true }).first();
    if (await exact.count().catch(() => 0)) {
      await exact.click();
      return;
    }
    // Uploaded projects frequently use a different locale or wording for
    // their login submit button. Only auth scenarios may use this fallback,
    // and only after the declared selector was proven absent. The observed
    // role/name still comes from the current page DOM; no arbitrary selector
    // or command is accepted.
    if (options.allowObservedAuthButton) {
      const observed = page.getByRole("button", { name: /^(login|sign[ -]?in|登录|登录测试账号)$/i }).first();
      if (await observed.count().catch(() => 0)) {
        await observed.click();
        return;
      }
    }
    await exact.click();
  }

  async function resolveObservedLoginField(
    declaredLocator: string | undefined,
    declaredLabel: string | undefined,
    kind: "username" | "password"
  ) {
    const declared = declaredLocator
      ? page.locator(declaredLocator).first()
      : declaredLabel
        ? page.getByLabel(declaredLabel, { exact: true }).first()
        : undefined;
    if (declared && await declared.count().catch(() => 0)) return declared;
    // Keep the fallback constrained to conventional login inputs. It is
    // useful for real projects whose labels/locales differ from a registry
    // template, while remaining auditable in the DOM and inaccessible to
    // arbitrary model-generated selectors.
    const candidates = kind === "password"
      ? page.locator("input[type='password'], input[autocomplete='current-password']")
      : page.locator("input[type='email'], input[name='username'], input[autocomplete='username'], input[type='text']");
    const fallback = candidates.first();
    if (await fallback.count().catch(() => 0)) return fallback;
    if (declared) return declared;
    throw new Error(`login_${kind}_field_not_found`);
  }

  async function runCoreAction(action: ScenarioAction) {
    assertWithinRunBudget();
    budgetTracker.consume({ steps: 1 });
    const core = scenario.corePath;
    if (action === "click_filter") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "change_task_status") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "login_as_test_user") {
      if ((core.usernameLocator || core.usernameLabel) && (core.passwordLocator || core.passwordLabel)) {
        if (!projectLoginSecret) throw new Error("credential_missing:project_login_credential");
        const username = await resolveObservedLoginField(core.usernameLocator, core.usernameLabel, "username");
        const password = await resolveObservedLoginField(core.passwordLocator, core.passwordLabel, "password");
        await username.fill(projectLoginSecret.username);
        await password.fill(projectLoginSecret.password);
        await clickButton(core.submitButtonName, { allowObservedAuthButton: true });
        return;
      }
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      await clickButton(core.submitButtonName, { allowObservedAuthButton: true });
      return;
    }
    if (action === "login_invalid_user") {
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "require_permission") {
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      return;
    }
    if (action === "submit_empty_form") {
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "fill_and_submit") {
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "search_keyword" || action === "expect_empty_state") {
      if (!core.inputLabel) throw new Error(`Scenario ${scenario.id} 缺少输入框 label`);
      await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "edit_task_title") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "simulate_error_and_retry") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "visual_check") {
      if (core.triggerButtonName) await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "table_sort_filter_paginate") {
      if (core.triggerButtonName) await clickButton(core.triggerButtonName);
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      if (core.retryButtonName) await clickButton(core.retryButtonName);
      return;
    }
    if (action === "complex_form_validate") {
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "file_upload_validate") {
      if (!core.inputLabel) throw new Error(`Scenario ${scenario.id} 缺少文件上传 label`);
      const uploadFile = path.join(runDir, "invoice-fixture.txt");
      await writeFile(uploadFile, "Invoice fixture for AI Test Officer upload validation.\n");
      await page.getByLabel(core.inputLabel).setInputFiles(uploadFile);
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      return;
    }
    if (action === "approval_flow_transition") {
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      await clickButton(core.triggerButtonName ?? core.submitButtonName);
      return;
    }
    if (action === "openapi_schema_contract") {
      if (core.triggerButtonName || core.submitButtonName) {
        await clickButton(core.triggerButtonName ?? core.submitButtonName);
      } else {
        await page.waitForTimeout(Math.min(Math.max(core.waitMs ?? 250, 0), 2_000));
      }
      return;
    }
    if (action === "role_permission_matrix") {
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      return;
    }
    if (action === "authenticated_onboarding_workflow") {
      const email = projectLoginSecret?.username
        || process.env[core.usernameEnv ?? "TEST_WORKFLOW_USERNAME"]?.trim()
        || `ai-test-officer-${Date.now()}@example.com`;
      const password = projectLoginSecret?.password
        || process.env[core.passwordEnv ?? "TEST_WORKFLOW_PASSWORD"]?.trim()
        || "InvestmentAgent123!";
      await page.getByRole("button", { name: core.registerButtonName ?? "注册", exact: true }).click();
      await page.getByLabel(core.usernameLabel ?? "邮箱").fill(email);
      await page.getByLabel(core.passwordLabel ?? "密码").fill(password);
      await page.getByRole("button", { name: core.createAccountButtonName ?? "创建账户", exact: true }).click();

      const setupHeading = page.getByRole("heading", { name: core.setupHeadingName ?? "完成前测和持仓录入", exact: true });
      const duplicateAccount = page.getByText(/Email already registered|already registered|已注册/i);
      await Promise.race([
        setupHeading.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
        duplicateAccount.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined)
      ]);
      if (await duplicateAccount.isVisible().catch(() => false)) {
        await page.getByRole("button", { name: core.loginButtonName ?? "登录", exact: true }).click();
        await page.getByLabel(core.usernameLabel ?? "邮箱").fill(email);
        await page.getByLabel(core.passwordLabel ?? "密码").fill(password);
        await page.getByRole("button", { name: core.loginSubmitButtonName ?? "进入系统", exact: true }).click();
      }

      await page.getByRole("heading", { name: core.setupHeadingName ?? "完成前测和持仓录入", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await page.getByRole("button", { name: new RegExp(core.setupSubmitButtonPattern ?? "保存并生成投研面板") }).click();
      await page.getByRole("heading", { name: "组合风险与 Agent 投研闭环", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      const auditTab = page.getByRole("button", { name: /审稿复盘/ });
      if (await auditTab.isVisible().catch(() => false)) {
        await auditTab.click();
        const refreshButton = page.getByRole("button", { name: /刷新证据/ }).first();
        if (await refreshButton.isVisible().catch(() => false)) {
          await refreshButton.click().catch(() => undefined);
          await page.waitForTimeout(1200);
        }
      }
      return;
    }
  }

  async function executeCorePath() {
    const core = scenario.corePath;
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "Core Path 开始执行",
      action: `${core.action}_${core.pathId}`,
      decisionReason: core.riskReason,
      evidenceRefs: []
    });
    await runCoreAction(core.action);
    await appendAudit({
      type: "agent_action",
      action: `${core.action}_${core.pathId}`,
      result: "recorded",
      details: { runId: id, scenarioId: scenario.id, action: core.action }
    });
    await page.waitForTimeout(core.waitMs ?? 700);
    const firstScreenshot = await screenshot(`after_${core.stepId}`);
    const operationEvidence = await appendEvidence(id, {
      type: "operation",
      title: core.title,
      pathId: core.pathId,
      stepId: core.stepId,
      ...(firstScreenshot ? {
        file: firstScreenshot,
        artifactIds: [`${id}_screenshot_${activeAttempt}_after_${core.stepId}`]
      } : {}),
      payload: {
        action: core.action,
        target: core.triggerButtonName ?? core.submitButtonName ?? core.inputLabel,
        input: core.input,
        screenshotCaptured: Boolean(firstScreenshot)
      }
    });

    const preRetryOracles =
      core.action === "simulate_error_and_retry"
        ? core.oracles.filter((oracle) => oracle.type === "network_query" || oracle.type === "error_text")
        : core.oracles;
    const postRetryOracles =
      core.action === "simulate_error_and_retry"
        ? core.oracles.filter((oracle) => oracle.type !== "network_query" && oracle.type !== "error_text")
        : [];

    const coreEvidenceRefs: string[] = [operationEvidence.id];
    for (const oracle of preRetryOracles) {
      const evidence = await evaluateOracle(oracle, core.stepId);
      coreEvidenceRefs.push(evidence.id);
    }

    let retryScreenshot: string | undefined;
    if (core.action === "simulate_error_and_retry") {
      await appendLoopEvent(id, {
        loopType: "failure_recovery_loop",
        iteration: 1,
        status: "retrying",
        title: "异常路径执行重试恢复",
        action: "click_retry",
        observation: "接口错误提示已采集，继续点击重试验证恢复。",
        decision: "执行恢复路径",
        decisionReason: "错误恢复场景要求同一轮采集失败态和恢复态证据。",
        evidenceRefs: coreEvidenceRefs
      });
      await clickButton(core.retryButtonName);
      await page.waitForTimeout(core.waitMs ?? 700);
      retryScreenshot = await screenshot(core.retryStepId ?? `retry_${core.stepId}`);
      for (const oracle of postRetryOracles) {
        const evidence = await evaluateOracle(oracle, core.retryStepId ?? core.stepId);
        coreEvidenceRefs.push(evidence.id);
      }
    }

    const oracleNames = core.oracles.map((oracle) => oracle.name);
    const coreAssertions = assertions.filter((assertion) => oracleNames.includes(assertion.name));
    const corePassed = coreAssertions.length > 0 && coreAssertions.every((assertion) => assertion.passed);
    steps.push({
      stepId: core.pathId,
      title: core.title,
      status: corePassed ? "passed" : "failed",
      action: core.action,
      screenshot: retryScreenshot ?? firstScreenshot,
      details: corePassed
        ? `${core.title} 通过。`
        : `${core.title} 失败：至少一个验证条件未满足。`
    });
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: corePassed ? "passed" : "failed",
      title: "Core Path 断言完成",
      action: `verify_${core.pathId}`,
      observation: corePassed
        ? "所有验证条件均已通过"
        : coreAssertions.map((assertion) => `${assertion.name}=${assertion.passed}`).join("；"),
      decision: corePassed ? "继续回归路径" : "进入失败恢复循环",
      decisionReason: corePassed ? "核心路径通过" : "retry_budget=1",
      evidenceRefs: coreEvidenceRefs
    });
    return corePassed;
  }

  async function runFailureRetry() {
    const core = scenario.corePath;
    await finishAttemptTrace();
    attempts[activeAttempt - 1] = {
      ...attempts[activeAttempt - 1],
      status: "failed",
      finishedAt: new Date().toISOString(),
      retryReason: "retryable_execution_failure"
    };
    activeAttempt += 1;
    context.setActiveAttempt(activeAttempt);
    attempts.push({
      id: `${id}_attempt_${activeAttempt}`,
      runId: id,
      scenarioId: scenario.id,
      attempt: activeAttempt,
      startedAt: new Date().toISOString(),
      status: "running",
      retryReason: "retryable_execution_failure",
      artifactIds: []
    });
    await startAttemptTrace();
    await appendLoopEvent(id, {
      loopType: "failure_recovery_loop",
      iteration: 1,
      status: "retrying",
      title: "失败路径自动重试",
      action: `retry_${core.pathId}`,
      observation: "核心路径首次执行失败",
      decision: "重放同一路径并保留截图",
      decisionReason: "retry_budget=1",
      evidenceRefs: assertions.filter((item) => !item.passed).map((item) => item.name)
    });
    await reloadUsablePage(page);
    const assertionStart = assertions.length;
    await runCoreAction(core.action);
    await page.waitForTimeout(core.waitMs ?? 700);
    for (const oracle of core.oracles) await evaluateOracle(oracle, core.retryStepId ?? core.stepId);
    const retryPassed = assertions.slice(assertionStart).length > 0 && assertions.slice(assertionStart).every((assertion) => assertion.passed);
    steps.push({
      stepId: core.retryStepId ?? `retry_${core.pathId}`,
      title: "失败路径自动重试",
      status: retryPassed ? "warning" : "failed",
      action: "retry",
      screenshot: await screenshot(core.retryStepId ?? `retry_${core.pathId}`),
      details: retryPassed ? "重试通过，但首轮失败仍保留并标记 flaky/timing-sensitive。" : "重试仍失败，首轮与重试证据均已保留。"
    });
    await appendLoopEvent(id, {
      loopType: "failure_recovery_loop",
      iteration: 2,
      status: "failed",
      title: "重试完成，失败证据保留",
      action: "record_retry_result",
      observation: "核心路径失败后已重试，证据包保留给用户复核。",
      decision: "继续执行回归路径",
      decisionReason: "fail_fast=false，需要收集更多证据",
      evidenceRefs: []
    });
    attempts[activeAttempt - 1] = { ...attempts[activeAttempt - 1], status: retryPassed ? "passed" : "failed", finishedAt: new Date().toISOString() };
  }

  async function runRegressionPath() {
    if (!scenario.regressionPath) return;
    if (scenario.regressionPath.triggerButtonName) {
      await clickButton(scenario.regressionPath.triggerButtonName);
      await page.waitForTimeout(400);
    }
    await appendAudit({
      type: "agent_action",
      action: `continue_regression_${scenario.regressionPath.stepId}`,
      result: "recorded",
      details: { runId: id, target: scenario.regressionPath.triggerButtonName }
    });
    steps.push({
      stepId: scenario.regressionPath.stepId,
      title: scenario.regressionPath.title,
      status: "passed",
      action: scenario.regressionPath.action ?? "click_filter",
      screenshot: await screenshot(scenario.regressionPath.stepId),
      details: "单路径失败后未终止整轮测试，已继续执行回归路径。"
    });
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 2,
      status: "passed",
      title: "回归路径继续执行",
      action: `continue_regression_${scenario.regressionPath.stepId}`,
      observation: scenario.regressionPath.triggerButtonName
        ? `已执行 ${scenario.regressionPath.triggerButtonName}`
        : "已执行回归路径",
      decision: "生成测试报告",
      decisionReason: "所有配置路径执行完成",
      evidenceRefs: []
    });
  }

  async function executeCompiledPlan() {
    if (!compiledPlan) throw new Error("compiled_plan_missing");
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "LLM Action DSL 开始执行",
      action: "execute_compiled_plan",
      decisionReason: "计划已经通过 contracts 与场景 capability 绑定校验",
      evidenceRefs: []
    });
    let regressionTelemetryStart: { network: number; console: number } | undefined;
    const failedPathIds = new Set<string>();
    for (const [stepIndex, step] of compiledPlan.steps.entries()) {
      if (step.pathId && failedPathIds.has(step.pathId)) {
        steps.push({
          stepId: step.id,
          title: `跳过依赖步骤：${step.action.action}`,
          status: "warning",
          action: "dependency_skipped",
          details: `同一路径 ${step.pathId} 的前置动作已经失败；该依赖步骤未执行，其他独立路径继续。`
        });
        await appendLoopEvent(id, {
          loopType: "failure_recovery_loop",
          iteration: steps.length,
          status: "stopped",
          title: `Skipped dependent step ${step.id}`,
          action: "skip_failed_path_dependency",
          observation: `path=${step.pathId}`,
          decision: "继续执行其他独立路径",
          decisionReason: "fail_fast=false; dependency_scope=path",
          evidenceRefs: []
        });
        continue;
      }
      activeCompiledStepId = step.id;
      let beforeObservation: Awaited<ReturnType<typeof captureStepPageObservation>> | undefined;
      let stepScreenshot: string | undefined;
      const stepTelemetryStart = { network: network.length, console: consoleEvents.length };
      try {
        assertWithinRunBudget();
        budgetTracker.consume({ steps: 1 });
        const assertionStart = assertions.length;
        const pathId = step.pathId ?? scenario.corePath.pathId;
        beforeObservation = await captureStepPageObservation(
          step.id,
          pathId,
          "before",
          stepTelemetryStart
        );
        const remainingRequiredScreenshots = compiledPlan.steps.length - stepIndex;
        const canCaptureBeforeScreenshot = context.getCapturedScreenshotCount() + remainingRequiredScreenshots + 2
          <= budgetTracker.budget.maxScreenshots;
        if (canCaptureBeforeScreenshot
          && ["navigate", "click", "fill", "select", "upload"].includes(step.action.action)) {
          await screenshot(`${step.id}_before`);
        }
        const fixturePath = path.join(runDir, "invoice-fixture.txt");
        if (scenario.regressionPath && step.pathId === scenario.regressionPath.stepId && !regressionTelemetryStart) {
          regressionTelemetryStart = { network: network.length, console: consoleEvents.length };
        }
        const structuredResult = await executeCompiledAction(step.action, step.id, {
          page,
          scenario,
          targetFrontendUrl: frontendUrl,
          evaluateOracle: (oracle, stepId) => evaluateOracle(oracle, stepId, step.pathId ?? scenario.corePath.pathId),
          resolveFixture: async (fixtureRef) => {
            if (fixtureRef !== "scenarioFixture" || scenario.corePath.action !== "file_upload_validate") {
              throw new Error(`compiled_plan_unknown_fixture:${fixtureRef}`);
            }
            await writeFile(fixturePath, "AI Test Officer scenario fixture.\n");
            return fixturePath;
          },
          resolveValue: async (valueRef) => {
            if (!projectLoginSecret) throw new Error("credential_missing:project_login_credential");
            if (valueRef === "projectLoginUsername") return projectLoginSecret.username;
            if (valueRef === "projectLoginPassword") return projectLoginSecret.password;
            throw new Error(`compiled_plan_unknown_dynamic_value:${valueRef}`);
          },
          executeStructured: async (action) => {
            if (!configuredProject?.manifest) throw new Error("structured_action_project_manifest_missing");
            return executeStructuredAction({
              action,
              manifest: configuredProject.manifest,
              project: configuredProject,
              target: targetRuntime,
              signal: input.signal
            });
          },
          onNavigation: (event) => browserLifecycleEvents.push({ type: "page_goto", ...event, capturedAt: new Date().toISOString() })
        });
        recordBrowserLifecycle();
        if (step.pathId === scenario.smoke.pathId && step.action.action === "navigate") {
          await evaluateCompiledSmokePath(step.id);
        }
        if (scenario.regressionPath && step.pathId === scenario.regressionPath.stepId
          && !compiledPlan.steps.slice(stepIndex + 1).some((candidate) => candidate.pathId === step.pathId)) {
          await evaluateCompiledRegressionPath(step.id, step.pathId, regressionTelemetryStart ?? { network: network.length, console: consoleEvents.length });
        }
        const afterObservation = await captureStepPageObservation(
          step.id,
          pathId,
          "after",
          stepTelemetryStart,
          beforeObservation.snapshot
        );
        stepScreenshot = await screenshot(step.id);
        let operationEvidence: EvidenceItem;
        if (structuredResult) {
          const finalPath = path.join(runDir, `${step.id}.operation.json`);
          const temporaryPath = `${finalPath}.partial`;
          await writeFile(temporaryPath, JSON.stringify({
            action: step.action,
            result: structuredResult
          }, null, 2));
          const artifact = await commitCapturedFile({
            temporaryPath,
            finalPath,
            id: `${id}_operation_${activeAttempt}_${step.id}`,
            identity: attemptIdentity(),
            stepId: step.id,
            kind: "operation-log",
            mediaType: "application/json",
            storageUri: artifactUrl(finalPath),
            clock: attemptClock,
            collectorVersion: "0.2.0"
          });
          const locatedArtifact: ArtifactV2 = {
            ...artifact,
            locator: structuredResult.locator
          };
          artifactsV2.push(locatedArtifact);
          budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
          attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
          operationEvidence = await appendEvidence(id, {
            type: "operation",
            title: `Structured action ${step.action.action}`,
            pathId: step.pathId ?? scenario.corePath.pathId,
            stepId: step.id,
            file: artifact.storageUri,
            artifactIds: [artifact.id],
            locator: structuredResult.locator,
            payload: {
              action: step.action.action,
              observationEvidenceRefs: [beforeObservation.evidence.id, afterObservation.evidence.id],
              changes: afterObservation.snapshot.changes ?? [],
              ...structuredResult.payload
            }
          });
          const oracleId = "oracleId" in step.action ? step.action.oracleId : step.action.action;
          await recordAssertion({
            name: `${oracleId}: ${step.action.action}`,
            passed: structuredResult.passed,
            expected: "Declared manifest operation and oracle succeed.",
            actual: structuredResult.summary,
            fact: {
              kind: "state.equals",
              target: oracleId,
              operator: "equals",
              expected: "passed",
              actual: structuredResult.passed ? "passed" : "failed",
              severity: "high",
              evidenceRefs: [operationEvidence.id],
              failureClass: structuredResult.passed ? undefined : "product_bug"
            }
          }, step.pathId ?? scenario.corePath.pathId, step.id);
        } else {
          operationEvidence = await appendEvidence(id, {
            type: "operation",
            title: `Compiled action ${step.action.action}`,
            pathId: step.pathId ?? scenario.corePath.pathId,
            stepId: step.id,
            ...(stepScreenshot ? {
              file: stepScreenshot,
              artifactIds: [`${id}_screenshot_${activeAttempt}_${step.id}`]
            } : {}),
            payload: {
              action: step.action.action,
              observationEvidenceRefs: [beforeObservation.evidence.id, afterObservation.evidence.id],
              changes: afterObservation.snapshot.changes ?? [],
              ...(step.action.action === "click" || step.action.action === "fill" || step.action.action === "select" || step.action.action === "upload"
                ? { selectorRef: step.action.selectorRef }
                : {}),
              ...(step.action.action === "assert" ? { oracleId: step.action.oracleId } : {})
            }
          });
        }
        const newAssertions = assertions.slice(assertionStart);
        const passed = newAssertions.every((assertion) => assertion.passed);
        steps.push({
          stepId: step.id,
          title: `LLM plan: ${step.action.action}`,
          status: passed ? "passed" : "failed",
          action: step.action.action,
          screenshot: stepScreenshot,
          details: passed ? "受控测试步骤执行完成。" : "该步骤的验证条件未通过。"
        });
        await appendLoopEvent(id, {
          loopType: "gray_execution_loop",
          iteration: steps.length,
          status: passed ? "passed" : "failed",
          title: `Compiled step ${step.id}`,
          action: step.action.action,
          observation: passed ? "动作完成且绑定断言通过" : "绑定断言失败",
          decision: "继续执行下一条已编译动作",
          decisionReason: "fail_fast=false，保留完整计划证据",
          evidenceRefs: [beforeObservation.evidence.id, operationEvidence.id, afterObservation.evidence.id]
        });
      } catch (error) {
        const classified = classifyExecutionError(error, step.id);
        executionError ??= classified;
        if (step.pathId) failedPathIds.add(step.pathId);
        const failureScreenshot = stepScreenshot ?? await screenshot(step.id).catch(() => undefined);
        const failureObservation = await captureStepPageObservation(
          step.id,
          step.pathId ?? scenario.corePath.pathId,
          "failure",
          stepTelemetryStart,
          beforeObservation?.snapshot
        ).catch(() => undefined);
        const errorEvidence = await appendEvidence(id, {
          type: "operation",
          title: `Compiled action ${step.action.action} failed`,
          pathId: step.pathId ?? scenario.corePath.pathId,
          stepId: step.id,
          ...(failureScreenshot ? {
            file: failureScreenshot,
            artifactIds: [`${id}_screenshot_${activeAttempt}_${step.id}`]
          } : {}),
          payload: {
            action: step.action.action,
            code: classified.code,
            failureClass: classified.failureClass,
            message: classified.message,
            observationEvidenceRefs: [
              beforeObservation?.evidence.id,
              failureObservation?.evidence.id
            ].filter((item): item is string => Boolean(item)),
            changes: failureObservation?.snapshot.changes ?? []
          }
        });
        steps.push({
          stepId: step.id,
          title: `动作失败：${step.action.action}`,
          status: "failed",
          action: step.action.action,
          screenshot: failureScreenshot,
          details: `${classified.code}: ${classified.message}`
        });
        await appendLoopEvent(id, {
          loopType: "failure_recovery_loop",
          iteration: steps.length,
          status: "failed",
          title: `Compiled step ${step.id} failed`,
          action: "persist_failure_and_continue",
          observation: classified.code,
          decision: "跳过同路径依赖步骤，继续其他独立路径",
          decisionReason: classified.failureClass,
          evidenceRefs: [
            beforeObservation?.evidence.id,
            errorEvidence.id,
            failureObservation?.evidence.id
          ].filter((item): item is string => Boolean(item))
        });
      } finally {
        activeCompiledStepId = undefined;
      }
    }
  }

  return {
    executeCompiledPlan,
    executeCorePath,
    getActiveCompiledStepId: () => activeCompiledStepId,
    getExecutionError: () => executionError,
    runFailureRetry,
    runRegressionPath
  };
}
