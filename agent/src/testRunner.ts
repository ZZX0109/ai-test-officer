import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { EvidenceItem, RunBundle, RunRequest, RunStepEvidence, VisualRunResult } from "./types.js";
import { appendAudit } from "./auditLog.js";
import { requireBrowserControl } from "./permissionGate.js";
import { appendEvidence, readEvidence, writeRunBundle } from "./evidenceStore.js";
import { appendLoopEvent, readLoopEvents } from "./loopEventStore.js";
import { buildScenarioOracles } from "./oracleBuilder.js";
import { buildRiskCoverageMatrix } from "./riskCoverage.js";
import { appendRunHistory } from "./runHistory.js";
import { buildConflictPacket } from "./conflictReplay.js";
import { getScenario, type ScenarioAction, type ScenarioOracle } from "./scenarios.js";
import { buildLayeredJudgeReport } from "./judgeEngine.js";
import { buildLlmJudgeReport } from "./llmJudge.js";
import { writeReadableReports } from "./reportRenderer.js";
import { getProject, getProjectRuntimeStatus, resolveProjectTarget, startProject, stopProject, testProjectConnection } from "./projectAdapter.js";
import { buildFailureAttributions } from "./failureAttribution.js";
import { writeArtifactIntegrityReport } from "./artifactIntegrity.js";
import { assertExecutablePlan } from "./executablePlan.js";
import { withProjectRunLock } from "./runLock.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

function scenarioFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function envFlag(name: string) {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

async function ensureReportDirs(runId: string) {
  await mkdir(path.join(reportsDir, "screenshots", runId), { recursive: true });
  await mkdir(path.join(reportsDir, "runs", runId), { recursive: true });
  await mkdir(path.join(reportsDir, "videos"), { recursive: true });
  await mkdir(path.join(reportsDir, "traces"), { recursive: true });
}

function artifactUrl(filePath: string) {
  const relative = path.relative(reportsDir, filePath).split(path.sep).join("/");
  return `/artifacts/${relative}`;
}

export function shouldAutoStopProjectRuntime(input: {
  projectWasStartedByRunner: boolean;
  keepProjectRunning?: boolean;
  runtimeStatus?: { status: string };
}) {
  return Boolean(
    input.projectWasStartedByRunner &&
    !input.keepProjectRunning &&
    input.runtimeStatus?.status === "running"
  );
}

export function assertRunRequestExecutablePlan(input: Pick<RunRequest, "scenarioId" | "executablePlan">) {
  if (!input.executablePlan) return;
  assertExecutablePlan(input.executablePlan);
  if (!input.scenarioId) {
    throw new Error("Run request with executablePlan must declare scenarioId.");
  }
  const matchingStep = input.executablePlan.steps.find((step) => step.scenarioId === input.scenarioId);
  if (!matchingStep) {
    throw new Error(`Run request scenarioId ${input.scenarioId} is not present in executablePlan ${input.executablePlan.id}.`);
  }
}

async function safeTraceStop(context: BrowserContext, file: string) {
  try {
    await context.tracing.stop({ path: file });
    return file;
  } catch {
    return undefined;
  }
}

export async function runVisualGrayTest(input: RunRequest): Promise<VisualRunResult> {
  const lockProjectId = input.projectId ?? input.target?.projectId;
  if (!lockProjectId) return runVisualGrayTestUnlocked(input);
  return withProjectRunLock(lockProjectId, () => runVisualGrayTestUnlocked(input));
}

async function runVisualGrayTestUnlocked(input: RunRequest): Promise<VisualRunResult> {
  await requireBrowserControl(input);
  assertRunRequestExecutablePlan(input);
  const scenario = getScenario(input.scenarioId);
  const targetRuntime = await resolveProjectTarget(input);
  const id = `run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  await ensureReportDirs(id);

  const steps: RunStepEvidence[] = [];
  const network: VisualRunResult["network"] = [];
  const consoleEvents: VisualRunResult["console"] = [];
  const assertions: VisualRunResult["assertions"] = [];
  const screenshotDir = path.join(reportsDir, "screenshots", id);
  const runDir = path.join(reportsDir, "runs", id);
  const traceFile = path.join(reportsDir, "traces", `${id}.zip`);
  const evidenceWrites: Promise<unknown>[] = [];
  const headless = envFlag("HEADLESS");
  const recordVideo = envFlag("RECORD_VIDEO");
  const recordTrace = envFlag("TRACE");
  const configuredProject = input.projectId ? await getProject(input.projectId) : undefined;
  let projectWasStartedByRunner = false;
  let runtimeStatus: VisualRunResult["runtimeStatus"];
  const healthResult = configuredProject
    ? await testProjectConnection(configuredProject)
    : input.target
      ? await testProjectConnection({
        id: targetRuntime.projectId ?? "ad_hoc_target",
        name: targetRuntime.projectId ?? "Ad hoc target",
        projectPath: ".",
        frontendUrl: targetRuntime.frontendUrl,
        backendUrl: targetRuntime.backendUrl,
        healthCheckUrl: targetRuntime.healthCheckUrl,
        login: { method: "none" },
        createdAt: startedAt,
        updatedAt: startedAt
      })
      : undefined;
  if (configuredProject) {
    if (healthResult?.ok) {
      runtimeStatus = {
        projectId: configuredProject.id,
        status: "running",
        frontendUrl: configuredProject.frontendUrl,
        backendUrl: configuredProject.backendUrl,
        healthCheckUrl: configuredProject.healthCheckUrl,
        failureReason: "none",
        message: "Project is already healthy."
      };
    } else {
      const beforeStart = getProjectRuntimeStatus(configuredProject.id);
      runtimeStatus = await startProject(configuredProject.id);
      projectWasStartedByRunner = beforeStart.status === "idle" && runtimeStatus.status === "running";
    }
  } else if (healthResult) {
    runtimeStatus = {
      projectId: targetRuntime.projectId ?? "ad_hoc_target",
      status: healthResult.ok ? "running" : "failed",
      frontendUrl: targetRuntime.frontendUrl,
      backendUrl: targetRuntime.backendUrl,
      healthCheckUrl: targetRuntime.healthCheckUrl,
      failureReason: healthResult.reason,
      message: healthResult.message
    };
  }
  if (runtimeStatus?.status === "failed") {
    throw new Error(`runtime_unavailable:${runtimeStatus.failureReason ?? "unknown"}:${runtimeStatus.message ?? "Project runtime failed."}`);
  }

  await appendLoopEvent(id, {
    loopType: "plan_loop",
    iteration: 1,
    status: "passed",
    title: `${scenario.title} plan 已载入`,
    action: "load_scenario_plan",
    observation: scenario.planObservation,
    decision: "进入权限确认",
    decisionReason: "执行浏览器操作前需要 browser_control",
    evidenceRefs: []
  });
  const permissionEvidence = await appendEvidence(id, {
    type: "permission",
    title: "浏览器控制权限快照",
    payload: { ...input.permissionProfile, headless, recordVideo, recordTrace, runtimeStatus }
  });
  await appendLoopEvent(id, {
    loopType: "approval_loop",
    iteration: 1,
    status: "passed",
    title: "browser_control 权限已确认",
    action: "permission_check",
    observation: input.permissionProfile.browserControl ? "用户允许接管指定浏览器窗口" : "用户未授权",
    decision: "执行显式灰度测试",
    decisionReason: "权限检查通过",
    evidenceRefs: [permissionEvidence.id],
    permissionRef: permissionEvidence.id
  });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    ...(recordVideo ? { recordVideo: { dir: path.join(reportsDir, "videos") } } : {})
  });
  if (recordTrace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
  const page = await context.newPage();
  const pageVideo = page.video();

  page.on("console", (event) => {
    const item = { type: event.type(), text: event.text() };
    consoleEvents.push(item);
    evidenceWrites.push(appendEvidence(id, {
      type: "console",
      title: `Console ${item.type}`,
      payload: item
    }));
  });
  page.on("response", (response) => {
    const item = {
      method: response.request().method(),
      url: response.url(),
      status: response.status()
    };
    network.push(item);
    evidenceWrites.push(appendEvidence(id, {
      type: "network",
      title: `Network ${item.method} ${item.status}`,
      url: item.url,
      payload: item
    }));
  });
  page.on("requestfailed", (request) => {
    const item = { method: request.method(), url: request.url() };
    network.push(item);
    evidenceWrites.push(appendEvidence(id, {
      type: "network",
      title: `Network failed ${item.method}`,
      url: item.url,
      payload: item
    }));
  });

  async function screenshot(stepId: string) {
    const file = path.join(screenshotDir, `${stepId}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const url = artifactUrl(file);
    await appendEvidence(id, {
      type: "screenshot",
      title: `Screenshot ${stepId}`,
      stepId,
      file: url,
      payload: { file: url }
    });
    return url;
  }

  async function recordAssertion(assertion: VisualRunResult["assertions"][number], pathId: string) {
    const evidence = await appendEvidence(id, {
      type: "assertion",
      title: assertion.name,
      pathId,
      payload: { assertion }
    });
    if (assertion.fact) {
      assertion.fact.evidenceRefs = Array.from(new Set([...assertion.fact.evidenceRefs, evidence.id]));
    }
    assertions.push(assertion);
    return evidence;
  }

  async function recordDomEvidence(title: string, locator: string, pathId: string, stepId: string) {
    const texts = await page.locator(locator).allTextContents();
    const evidence = await appendEvidence(id, {
      type: "dom",
      title,
      pathId,
      stepId,
      payload: { locator, texts }
    });
    return { texts, evidence };
  }

  async function evaluateOracle(oracle: ScenarioOracle, stepId: string) {
    const pathId = scenario.corePath.pathId;
    if (oracle.type === "network_query") {
      const passed = network.some(
        (entry) =>
          entry.url.includes(oracle.networkUrlIncludes ?? "") &&
          entry.url.includes(oracle.expectedQueryFragment ?? "")
      );
      return recordAssertion({
        name: oracle.name,
        passed,
        expected: oracle.expected,
        actual: passed
          ? `请求包含 ${oracle.expectedQueryFragment}`
          : `请求缺少 ${oracle.expectedQueryFragment}`,
        fact: {
          kind: "network.url_contains",
          target: oracle.networkUrlIncludes ?? "",
          operator: "contains",
          expected: oracle.expectedQueryFragment ?? "",
          actual: network.map((entry) => entry.url).join("\n"),
          severity: "high",
          evidenceRefs: [],
          failureClass: passed ? undefined : "product_bug"
        }
      }, pathId);
    }
    if (oracle.type === "console_no_error") {
      const consoleErrors = consoleEvents.filter((entry) => /error|exception|failed/i.test(`${entry.type} ${entry.text}`));
      return recordAssertion({
        name: oracle.name,
        passed: consoleErrors.length === 0,
        expected: oracle.expected,
        actual: consoleErrors.length ? consoleErrors.map((entry) => entry.text).join("\n") : "未发现 console error",
        fact: {
          kind: "console.no_error",
          target: "browser_console",
          operator: "not_present",
          expected: "no console error",
          actual: consoleErrors.length ? consoleErrors.map((entry) => entry.text).join("\n") : "no console error",
          severity: "medium",
          evidenceRefs: [],
          failureClass: consoleErrors.length ? "product_bug" : undefined
        }
      }, pathId);
    }

    const locator =
      oracle.locator ??
      scenario.corePath.targetLocator ??
      scenario.corePath.statusLocator ??
      scenario.corePath.validationLocator ??
      scenario.corePath.emptyStateLocator ??
      scenario.corePath.errorLocator ??
      "[data-testid='task-list']";
    const { texts, evidence } = await recordDomEvidence(`${oracle.name} DOM`, locator, pathId, stepId);
    const text = texts.join(" ");
    const expectedText = oracle.expectedTextIncludes ?? oracle.expectedStatusText ?? scenario.corePath.expectedTextIncludes ?? "";
    const passed =
      oracle.type === "dom_all_text"
        ? texts.length > 0 && texts.every((item) => item.includes(oracle.expectedStatusText ?? expectedText))
        : text.includes(expectedText);
    const assertionEvidence = await recordAssertion({
      name: oracle.name,
      passed,
      expected: oracle.expected,
      actual: text || "没有读取到 DOM 文本",
      fact: {
        kind: oracle.type === "dom_all_text" ? "text.all_contains" : "text.contains",
        target: locator,
        operator: oracle.type === "dom_all_text" ? "all_contains" : "contains",
        expected: oracle.expectedTextIncludes ?? oracle.expectedStatusText ?? scenario.corePath.expectedTextIncludes ?? "",
        actual: text || "没有读取到 DOM 文本",
        severity: oracle.type === "error_text" ? "medium" : "high",
        evidenceRefs: [evidence.id],
        failureClass: passed ? undefined : texts.length === 0 ? "test_script_issue" : "product_bug"
      }
    }, pathId);
    return {
      ...assertionEvidence,
      evidenceRefs: [evidence.id, assertionEvidence.id]
    };
  }

  async function clickButton(name: string | undefined) {
    if (!name) throw new Error(`Scenario ${scenario.id} 缺少按钮名称`);
    await page.getByRole("button", { name, exact: true }).click();
  }

  async function runCoreAction(action: ScenarioAction) {
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
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      await clickButton(core.submitButtonName);
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
      await clickButton(core.triggerButtonName ?? core.submitButtonName);
      return;
    }
    if (action === "openapi_schema_contract") {
      await clickButton(core.triggerButtonName ?? core.submitButtonName);
      return;
    }
    if (action === "role_permission_matrix") {
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      return;
    }
    if (action === "investment_agent_workflow_auth_portfolio_research") {
      const email = process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL?.trim()
        || `ai-test-officer-${Date.now()}@example.com`;
      const password = process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD?.trim()
        || "InvestmentAgent123!";
      await page.getByRole("button", { name: "注册", exact: true }).click();
      await page.getByLabel("邮箱").fill(email);
      await page.getByLabel("密码").fill(password);
      await page.getByRole("button", { name: "创建账户", exact: true }).click();

      const setupHeading = page.getByRole("heading", { name: "完成前测和持仓录入", exact: true });
      const duplicateAccount = page.getByText(/Email already registered|already registered|已注册/i);
      await Promise.race([
        setupHeading.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
        duplicateAccount.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined)
      ]);
      if (await duplicateAccount.isVisible().catch(() => false)) {
        await page.getByRole("button", { name: "登录", exact: true }).click();
        await page.getByLabel("邮箱").fill(email);
        await page.getByLabel("密码").fill(password);
        await page.getByRole("button", { name: "进入系统", exact: true }).click();
      }

      await page.getByRole("heading", { name: "完成前测和持仓录入", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await page.getByRole("button", { name: /保存并生成投研面板/ }).click();
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
    const operationEvidence = await appendEvidence(id, {
      type: "operation",
      title: core.title,
      pathId: core.pathId,
      stepId: core.stepId,
      payload: {
        action: core.action,
        target: core.triggerButtonName ?? core.submitButtonName ?? core.inputLabel,
        input: core.input
      }
    });
    await page.waitForTimeout(core.waitMs ?? 700);
    const firstScreenshot = await screenshot(`after_${core.stepId}`);

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
        : `${core.title} 失败：至少一个 scenario oracle 未满足。`
    });
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: corePassed ? "passed" : "failed",
      title: "Core Path 断言完成",
      action: `verify_${core.pathId}`,
      observation: corePassed
        ? "scenario oracle 全部通过"
        : coreAssertions.map((assertion) => `${assertion.name}=${assertion.passed}`).join("；"),
      decision: corePassed ? "继续回归路径" : "进入失败恢复循环",
      decisionReason: corePassed ? "核心路径通过" : "retry_budget=1",
      evidenceRefs: coreEvidenceRefs
    });
    return corePassed;
  }

  async function runFailureRetry() {
    const core = scenario.corePath;
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
    await page.reload({ waitUntil: "networkidle" });
    await runCoreAction(core.action);
    await page.waitForTimeout(core.waitMs ?? 700);
    steps.push({
      stepId: core.retryStepId ?? `retry_${core.pathId}`,
      title: "失败路径自动重试",
      status: "warning",
      action: "retry",
      screenshot: await screenshot(core.retryStepId ?? `retry_${core.pathId}`),
      details: "重试路径已执行，失败结论仍以首轮结构化断言为准。"
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

  try {
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "Smoke 路径开始执行",
      action: "open_page",
      decisionReason: "先确认页面基础可用",
      evidenceRefs: []
    });
    await page.goto(targetRuntime.frontendUrl, { waitUntil: "networkidle", timeout: 15000 });
    await appendAudit({
      type: "agent_action",
      action: "browser_open",
      result: "recorded",
      details: { runId: id, appUrl: targetRuntime.frontendUrl }
    });
    const openScreenshot = await screenshot(scenario.smoke.stepId);
    const operationEvidence = await appendEvidence(id, {
      type: "operation",
      title: scenario.smoke.title,
      stepId: scenario.smoke.stepId,
      payload: { action: "browser_open", appUrl: targetRuntime.frontendUrl }
    });
    steps.push({
      stepId: scenario.smoke.stepId,
      title: scenario.smoke.title,
      status: "passed",
      action: "browser_open",
      screenshot: openScreenshot,
      details: `已打开 ${targetRuntime.frontendUrl}`
    });

    const titleVisible = await page.getByRole("heading", { name: scenario.smoke.headingName }).isVisible();
    const pageAssertionEvidence = await recordAssertion({
      name: scenario.smoke.assertionName,
      passed: titleVisible,
      expected: scenario.smoke.expected,
      actual: titleVisible ? "标题可见" : "标题不可见",
      fact: {
        kind: "element.visible",
        target: `heading:${scenario.smoke.headingName}`,
        operator: "exists",
        expected: scenario.smoke.headingName,
        actual: titleVisible ? "visible" : "hidden",
        severity: "high",
        evidenceRefs: [],
        failureClass: titleVisible ? undefined : "environment_issue"
      }
    }, scenario.smoke.pathId);
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: titleVisible ? "passed" : "failed",
      title: "Smoke 断言完成",
      action: "assert_page_loaded",
      observation: titleVisible ? "页面标题可见" : "页面标题不可见",
      decision: titleVisible ? "进入核心路径" : "记录失败并继续核心路径",
      decisionReason: "fail_fast=false，继续收集更多证据",
      evidenceRefs: [operationEvidence.id, pageAssertionEvidence.id]
    });

    const corePassed = await executeCorePath();
    if (!corePassed && scenario.corePath.action !== "simulate_error_and_retry") {
      await runFailureRetry();
    }
    await runRegressionPath();
  } finally {
    try {
      try {
        const html = await page.content();
        await appendEvidence(id, {
          type: "dom",
          title: "Full DOM snapshot",
          payload: { html: html.slice(0, 60_000), truncated: html.length > 60_000 }
        });
      } catch {
        // Page may already be closed after a hard browser failure; other evidence remains available.
      }
      if (recordTrace) {
        const stoppedTrace = await safeTraceStop(context, traceFile);
        if (stoppedTrace) {
          await appendEvidence(id, {
            type: "trace",
            title: "Playwright trace",
            file: artifactUrl(stoppedTrace),
            payload: { file: artifactUrl(stoppedTrace) }
          });
        }
      }
      await context.close();
      if (recordVideo && pageVideo) {
        try {
          const videoPath = await pageVideo.path();
          await appendEvidence(id, {
            type: "video",
            title: "Playwright video",
            file: artifactUrl(videoPath),
            payload: { file: artifactUrl(videoPath) }
          });
        } catch {
          // Video is optional; screenshots and trace remain authoritative evidence.
        }
      }
      await browser.close();
    } finally {
      if (configuredProject && shouldAutoStopProjectRuntime({ projectWasStartedByRunner, keepProjectRunning: input.keepProjectRunning, runtimeStatus })) {
        const stopped = await stopProject(configuredProject.id);
        runtimeStatus = {
          ...stopped,
          message: `Project auto-stopped after run because the runner started it. ${stopped.message}`
        };
        const stopEvidence = await appendEvidence(id, {
          type: "operation",
          title: "Project runtime auto-stop",
          payload: {
            projectId: configuredProject.id,
            projectWasStartedByRunner,
            keepProjectRunning: Boolean(input.keepProjectRunning),
            runtimeStatus
          }
        });
        await appendLoopEvent(id, {
          loopType: "report_loop",
          iteration: 0,
          status: "stopped",
          title: "runner 启动的项目已自动停止",
          action: "project_runtime_auto_stop",
          observation: runtimeStatus.message,
          decision: "继续生成 run bundle",
          decisionReason: "避免真实项目接入 smoke 后遗留 dev server 或子进程。",
          evidenceRefs: [stopEvidence.id]
        });
      }
    }
  }

  const failed = assertions.some((assertion) => !assertion.passed);
  const finishedAt = new Date().toISOString();
  await Promise.allSettled(evidenceWrites);
  const latestEvidence: EvidenceItem[] = await readEvidence(id);
  const partialResult = {
    assertions,
    steps,
    verdict: failed ? "hold_for_review" : "continue"
  } as Pick<VisualRunResult, "assertions" | "steps" | "verdict">;
  const oracles = buildScenarioOracles(scenario, latestEvidence);
  const riskCoverageMatrix = buildRiskCoverageMatrix({ assertions }, latestEvidence, scenario);
  const conflictPacket = buildConflictPacket({ assertions, steps }, latestEvidence);
  const runScenarioFingerprint = scenarioFingerprint({
    id: scenario.id,
    action: scenario.corePath.action,
    oracles: scenario.corePath.oracles
  });
  const aggregatedVerdict = await appendRunHistory({
    runId: id,
    appUrl: targetRuntime.frontendUrl,
    projectId: targetRuntime.projectId ?? configuredProject?.id,
    scenarioId: scenario.id,
    scenarioFingerprint: runScenarioFingerprint,
    result: partialResult
  });
  const baselineJudgeReport = buildLayeredJudgeReport({
    plan: input.plan,
    requirement: input.requirement,
    diff: input.diff,
    result: {
      steps,
      assertions,
      network,
      console: consoleEvents,
      riskCoverageMatrix,
      aggregatedVerdict,
      conflictPacket,
      verdict: failed ? "hold_for_review" : "continue"
    },
    evidence: latestEvidence
  });
  const judgeReport = await buildLlmJudgeReport({
    credentialId: input.credentialId,
    baseline: baselineJudgeReport,
    plan: input.plan,
    requirement: input.requirement,
    diff: input.diff,
    result: {
      steps,
      assertions,
      network,
      console: consoleEvents,
      riskCoverageMatrix,
      aggregatedVerdict,
      conflictPacket,
      verdict: failed ? "hold_for_review" : "continue"
    },
    evidence: latestEvidence
  });
  const failureAttributions = buildFailureAttributions({
    assertions,
    steps,
    network,
    console: consoleEvents,
    evidence: latestEvidence,
    sourceContexts: input.sourceContexts ?? [],
    impactAnalysis: input.impactAnalysis,
    diff: input.diff
  });
  const failedNames = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);
  const reflectionNote = failed
    ? `本次失败集中在 ${scenario.corePath.title}：${failedNames.join("、")}。下一轮应优先检查对应 evidence ID 的 network、DOM 和截图是否一致。`
    : `本次 ${scenario.title} 显式灰度路径通过，证据包包含 ${latestEvidence.length} 条 evidence。`;
  await appendLoopEvent(id, {
    loopType: conflictPacket.status === "not_triggered" ? "report_loop" : "evidence_conflict_loop",
    iteration: 1,
    status: conflictPacket.status === "not_triggered" ? "passed" : "waiting_for_user",
    title: conflictPacket.status === "not_triggered" ? "未触发证据冲突复现" : "失败证据需要用户复核",
    action: "build_conflict_packet",
    observation: conflictPacket.reason,
    decision: "生成报告",
    decisionReason: "当前运行已完成证据包构建",
    evidenceRefs: conflictPacket.evidenceRefs
  });
  await appendLoopEvent(id, {
    loopType: "report_loop",
    iteration: 1,
    status: "waiting_for_user",
    title: "报告已生成，等待用户裁决",
    action: "generate_report",
    observation: failed ? "核心路径存在失败断言" : "未发现阻塞断言",
    decision: failed ? "建议 hold_for_review" : "建议 continue",
    decisionReason: failed ? `${scenario.corePath.title} 存在 oracle 失败` : "所有断言通过",
    evidenceRefs: latestEvidence.map((item) => item.id).slice(-8)
  });
  const loopEvents = await readLoopEvents(id);
  const result: VisualRunResult = {
    id,
    startedAt,
    finishedAt,
    scenarioFingerprint: runScenarioFingerprint,
    verdict: failed ? "hold_for_review" : "continue",
    summary: failed
      ? "核心路径存在失败证据，建议用户复核并阻塞合并。"
      : "显式灰度路径未发现阻塞问题。",
    steps,
    network,
    console: consoleEvents,
    assertions,
    evidence: latestEvidence,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    aggregatedVerdict,
    reflectionNote,
    conflictPacket,
    failureAttributions,
    runtimeStatus,
    judgeReport,
    reportFile: artifactUrl(path.join(runDir, "report.json")),
    runBundleFile: artifactUrl(path.join(runDir, "run_bundle.json"))
  };
  const readableReports = await writeReadableReports({
    runDir,
    artifactBaseUrl: `/artifacts/runs/${id}`,
    result
  });
  result.markdownReportFile = readableReports.markdownReportFile;
  result.htmlReportFile = readableReports.htmlReportFile;
  result.artifactIntegrityReportFile = artifactUrl(path.join(runDir, "artifact_integrity.json"));
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  const bundle: RunBundle = {
    runId: id,
    startedAt,
    finishedAt,
    input,
    result,
    evidence: latestEvidence,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    conflictPacket,
    judgeReport,
    failureAttributions,
    runtimeStatus,
    project: configuredProject,
    sourceContexts: input.sourceContexts,
    impactAnalysis: input.impactAnalysis,
    executablePlan: input.executablePlan
  };
  const bundleFile = await writeRunBundle(bundle);
  result.runBundleFile = bundleFile;
  const artifactIntegrity = await writeArtifactIntegrityReport({
    result,
    reportsDir,
    outputFile: path.join(runDir, "artifact_integrity.json")
  });
  result.artifactIntegrity = artifactIntegrity;
  bundle.artifactIntegrity = artifactIntegrity;
  await writeReadableReports({
    runDir,
    artifactBaseUrl: `/artifacts/runs/${id}`,
    result
  });
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  await writeRunBundle(bundle);
  return result;
}
