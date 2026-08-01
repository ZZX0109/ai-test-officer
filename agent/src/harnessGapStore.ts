import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { HarnessGap, HarnessGapScenarioDraft } from "./types.js";
import { scenarioExecutabilityIssues } from "./scenarios.js";
import { createLlmScenarioBindingRepair } from "./llmScenarioRepair.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const gapDir = path.join(rootDir, "reports", "harness-gaps");
const draftDir = path.join(gapDir, "drafts");
const scenarioDir = path.join(rootDir, "data", "scenarios");
const indexFile = path.join(gapDir, "index.json");
const latestFile = path.join(gapDir, "latest.json");

function draftFile(scenarioId: string) {
  return path.join(draftDir, `${scenarioId}.json`);
}

async function readAll() {
  try {
    const raw = await readFile(indexFile, "utf8");
    return JSON.parse(raw) as HarnessGap[];
  } catch {
    return [];
  }
}

async function writeAll(gaps: HarnessGap[]) {
  await mkdir(gapDir, { recursive: true });
  await writeFile(indexFile, JSON.stringify(gaps.slice(-200), null, 2));
  await writeFile(latestFile, JSON.stringify(gaps.at(-1) ?? null, null, 2));
}

export async function writeHarnessGaps(gaps: HarnessGap[]) {
  if (gaps.length === 0) return [];
  await mkdir(gapDir, { recursive: true });
  const all = await readAll();
  const written: HarnessGap[] = [];
  for (const gap of gaps) {
    const file = path.join(gapDir, `${gap.id}.json`);
    await writeFile(file, JSON.stringify(gap, null, 2));
    all.push(gap);
    written.push(gap);
  }
  await writeAll(all);
  return written;
}

export async function listHarnessGaps() {
  return readAll();
}

export async function updateHarnessGap(id: string, input: Partial<Pick<HarnessGap, "status">>) {
  const all = await readAll();
  const index = all.findIndex((gap) => gap.id === id);
  if (index === -1) return undefined;
  const updated: HarnessGap = {
    ...all[index],
    ...input
  };
  all[index] = updated;
  await writeAll(all);
  await writeFile(path.join(gapDir, `${id}.json`), JSON.stringify(updated, null, 2));
  return updated;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "generated-scenario";
}

function inferDraftAction(gap: HarnessGap) {
  const text = `${gap.requirementSummary}\n${gap.missingScenarioTitle}\n${gap.suggestedOracle}`;
  if (/status=completed|已完成/i.test(text)) return { action: "click_filter", button: "已完成", query: "status=completed" };
  if (/status=active|进行中/i.test(text)) return { action: "click_filter", button: "进行中", query: "status=active" };
  if (/搜索|keyword|search/i.test(text)) return { action: "search_keyword", button: "搜索", query: "keyword=TODO" };
  if (/空状态|无数据|empty|暂无/i.test(text)) return { action: "expect_empty_state", button: "搜索", query: "keyword=TODO" };
  if (/错误|异常|error|timeout|500|503/i.test(text)) return { action: "simulate_error_and_retry", button: "模拟错误", query: "status=error" };
  if (/必填|required|表单|创建|新增/i.test(text)) return { action: "submit_empty_form", button: "新增", query: "" };
  return { action: "fill_and_submit", button: "新增", query: "" };
}

function buildDraftScenario(gap: HarnessGap) {
  const inferred = inferDraftAction(gap);
  const scenarioId = `generated_${slug(gap.missingScenarioTitle)}`;
  const isSearch = inferred.action === "search_keyword" || inferred.action === "expect_empty_state";
  const isError = inferred.action === "simulate_error_and_retry";
  const isRequired = inferred.action === "submit_empty_form";
  return {
    id: scenarioId,
    title: `${gap.missingScenarioTitle}（草案）`,
    planObservation: "smoke -> generated core_path -> regression",
    summary: `由 harness gap ${gap.id} 生成的 scenario 草案，需要人工确认 locator、输入和 oracle。`,
    matcher: {
      keywords: Array.from(new Set([
        ...gap.missingScenarioTitle.split(/\s+/),
        ...gap.requiredCapabilities,
        "generated",
        "harness-gap"
      ])).filter(Boolean).slice(0, 12),
      riskLevel: "medium",
      sourceHints: [gap.source],
      capabilities: gap.requiredCapabilities
    },
    smoke: {
      pathId: "open_task_page",
      stepId: "open_task_page",
      title: "打开任务列表页",
      headingName: "任务管理系统",
      assertionName: "页面标题可见",
      expected: "任务管理系统标题出现"
    },
    corePath: {
      pathId: `${scenarioId}_path`,
      stepId: `${scenarioId}_step`,
      retryStepId: `retry_${scenarioId}_path`,
      title: gap.missingScenarioTitle,
      action: inferred.action,
      triggerButtonName: inferred.button,
      submitButtonName: inferred.button,
      retryButtonName: isError ? "重试" : undefined,
      inputLabel: isSearch ? "搜索任务" : undefined,
      input: isSearch ? "TODO" : undefined,
      networkUrlIncludes: "/api/tasks",
      expectedQueryFragment: inferred.query || undefined,
      targetLocator: isError ? "[data-testid='task-title']" : "[data-testid='task-list']",
      validationLocator: isRequired ? "[data-testid='title-error']" : undefined,
      expectedValidationText: isRequired ? "请输入任务标题" : undefined,
      emptyStateLocator: inferred.action === "expect_empty_state" ? "[data-testid='empty-state']" : undefined,
      expectedEmptyText: inferred.action === "expect_empty_state" ? "暂无任务" : undefined,
      errorLocator: isError ? "[data-testid='error-state']" : undefined,
      expectedErrorText: isError ? "任务接口失败" : undefined,
      expectedTextIncludes: "TODO",
      queryAssertionName: inferred.query ? `${gap.missingScenarioTitle} 请求参数符合预期` : undefined,
      domAssertionName: `${gap.missingScenarioTitle} 页面结果符合预期`,
      riskReason: gap.suggestedOracle,
      oracles: [
        ...(inferred.query ? [{
          id: `${scenarioId}_query`,
          name: `${gap.missingScenarioTitle} 请求参数符合预期`,
          type: "network_query",
          networkUrlIncludes: "/api/tasks",
          expectedQueryFragment: inferred.query,
          expected: `GET /api/tasks?${inferred.query}`
        }] : []),
        {
          id: `${scenarioId}_dom`,
          name: `${gap.missingScenarioTitle} 页面结果符合预期`,
          type: isRequired ? "validation_text" : inferred.action === "expect_empty_state" ? "empty_state" : isError ? "error_text" : "dom_text",
          locator: isRequired
            ? "[data-testid='title-error']"
            : inferred.action === "expect_empty_state"
              ? "[data-testid='empty-state']"
              : isError
                ? "[data-testid='error-state']"
                : "[data-testid='task-list']",
          expectedTextIncludes: isRequired ? "请输入任务标题" : isError ? "任务接口失败" : "TODO",
          expected: gap.suggestedOracle
        }
      ]
    },
    regressionPath: {
      stepId: "all_filter_regression",
      title: "继续执行全部筛选回归路径",
      action: "click_filter",
      triggerButtonName: "全部"
    }
  };
}

function corePathOf(scenario: Record<string, unknown>) {
  return scenario.corePath && typeof scenario.corePath === "object"
    ? scenario.corePath as Record<string, unknown>
    : {};
}

function draftEvidenceRequirements(scenario: Record<string, unknown>) {
  const core = corePathOf(scenario);
  const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
  const requirements = new Set(["screenshot", "dom"]);
  for (const oracle of oracles) {
    if (oracle.type === "network_query") requirements.add("network");
    if (oracle.type === "console_no_error") requirements.add("console");
  }
  return Array.from(requirements);
}

function enrichDraft(draft: HarnessGapScenarioDraft): HarnessGapScenarioDraft {
  const core = corePathOf(draft.scenario);
  const locator =
    core.targetLocator ??
    core.statusLocator ??
    core.validationLocator ??
    core.emptyStateLocator ??
    core.errorLocator;
  const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
  const missingInfo = [
    typeof core.action === "string" ? undefined : "corePath.action",
    typeof locator === "string" && locator.trim() ? undefined : "corePath selector locator",
    oracles.length ? undefined : "corePath.oracles",
    ...scenarioExecutabilityIssues(draft.scenario)
  ].filter((item): item is string => Boolean(item));
  return {
    ...draft,
    draftReviewStatus: draft.draftReviewStatus ?? "draft",
    selectorProbeStatus: draft.selectorProbeStatus ?? "not_run",
    riskKind: draft.riskKind ?? "generated_harness_gap",
    selectors: draft.selectors ?? {
      role: core.triggerButtonName ?? core.submitButtonName ?? core.retryButtonName,
      text: core.expectedTextIncludes ?? core.expectedStatusText ?? core.expectedValidationText ?? core.expectedEmptyText ?? core.expectedErrorText,
      css: locator
    },
    actions: draft.actions ?? (typeof core.action === "string" ? [core.action] : []),
    oracles: draft.oracles ?? oracles,
    evidenceRequirements: draft.evidenceRequirements ?? draftEvidenceRequirements(draft.scenario),
    // Never trust an empty array supplied by a generator. Recompute the
    // structural requirements and merge any human-entered gaps.
    missingInfo: Array.from(new Set([...(draft.missingInfo ?? []), ...missingInfo]))
  };
}

async function writeDraft(draft: HarnessGapScenarioDraft) {
  await mkdir(draftDir, { recursive: true });
  const enriched = enrichDraft(draft);
  enriched.scenarioFile = `/artifacts/harness-gaps/drafts/${enriched.scenarioId}.json`;
  await writeFile(draftFile(enriched.scenarioId), JSON.stringify(enriched, null, 2));
  return enriched;
}

export async function writeScenarioDraft(draft: HarnessGapScenarioDraft) {
  return writeDraft(draft);
}

async function readDraft(id: string) {
  const { readdir } = await import("node:fs/promises");
  try {
    const direct = JSON.parse(await readFile(draftFile(id), "utf8")) as HarnessGapScenarioDraft;
    return enrichDraft(direct);
  } catch {
    // Fall through to gap-id lookup below.
  }
  try {
    const files = (await readdir(draftDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const draft = enrichDraft(JSON.parse(await readFile(path.join(draftDir, file), "utf8")) as HarnessGapScenarioDraft);
      if (draft.gapId === id || draft.scenarioId === id) return draft;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function createHarnessGapScenarioDraft(id: string): Promise<HarnessGapScenarioDraft | undefined> {
  const gap = (await readAll()).find((item) => item.id === id);
  if (!gap) return undefined;
  const scenario = buildDraftScenario(gap);
  const draft: HarnessGapScenarioDraft = {
    gapId: gap.id,
    createdAt: new Date().toISOString(),
    scenarioId: String(scenario.id),
    scenario
  };
  return writeDraft(draft);
}

export async function installHarnessGapScenarioDraft(id: string): Promise<HarnessGapScenarioDraft | undefined> {
  const draft = await readDraft(id) ?? await createHarnessGapScenarioDraft(id);
  if (!draft) return undefined;
  const probed = draft.selectorProbeStatus === "passed" ? draft : await probeScenarioDraft(draft.scenarioId);
  if (!probed || probed.selectorProbeStatus !== "passed") return probed;
  return approveScenarioDraft(probed.scenarioId);
}

export async function listScenarioDrafts() {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = (await readdir(draftDir)).filter((file) => file.endsWith(".json")).sort();
    const drafts = await Promise.all(files.map(async (file) => enrichDraft(JSON.parse(await readFile(path.join(draftDir, file), "utf8")) as HarnessGapScenarioDraft)));
    return drafts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  } catch {
    return [];
  }
}

type DraftProbeTrace = NonNullable<HarnessGapScenarioDraft["probeTrace"]>;

interface DraftProbeResult {
  issues: string[];
  trace: DraftProbeTrace;
}

function normalizedLabel(value: string) {
  return value.toLowerCase().replace(/[\s_\-:：/]+/g, "");
}

function closestObservedButton(expected: string, observed: string[]) {
  const normalizedExpected = normalizedLabel(expected);
  const matches = observed.filter((candidate) => {
    const normalizedCandidate = normalizedLabel(candidate);
    return normalizedCandidate === normalizedExpected
      || normalizedCandidate.includes(normalizedExpected)
      || normalizedExpected.includes(normalizedCandidate);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

async function visiblePageModel(page: Page) {
  return page.evaluate(() => ({
    headings: Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean)
      .slice(0, 20),
    buttons: Array.from(document.querySelectorAll("button,[role='button']"))
      .map((node) => (node.textContent ?? node.getAttribute("aria-label") ?? "").trim())
      .filter(Boolean)
      .slice(0, 40),
    testIds: Array.from(document.querySelectorAll("[data-testid]"))
      .map((node) => node.getAttribute("data-testid") ?? "")
      .filter(Boolean)
      .slice(0, 80)
  })).catch(() => ({ headings: [] as string[], buttons: [] as string[], testIds: [] as string[] }));
}

async function waitForDraftBindings(
  page: Page,
  smoke: Record<string, unknown>,
  core: Record<string, unknown>,
  action: string
) {
  const buttonNames = Array.from(new Set([
    core.triggerButtonName,
    core.submitButtonName
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()))));
  const boundInputCount = async (field: "username" | "password") => {
    const locator = typeof core[`${field}Locator`] === "string" ? String(core[`${field}Locator`]).trim() : "";
    const label = typeof core[`${field}Label`] === "string" ? String(core[`${field}Label`]).trim() : "";
    if (locator) return page.locator(locator).count();
    if (!label) return 0;
    return (await page.getByLabel(label, { exact: true }).count())
      || page.getByPlaceholder(label, { exact: true }).count();
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (["login_as_test_user", "login_invalid_user"].includes(action)) {
      const [username, password, submit] = await Promise.all([
        boundInputCount("username"),
        boundInputCount("password"),
        typeof core.submitButtonName === "string"
          ? page.getByRole("button", { name: core.submitButtonName, exact: true }).count()
          : Promise.resolve(0)
      ]);
      if (username > 0 && password > 0 && submit > 0) return true;
    } else if (buttonNames.length > 0) {
      const counts = await Promise.all(buttonNames.map((name) =>
        page.getByRole("button", { name, exact: true }).count()
      ));
      if (counts.every((count) => count > 0)) return true;
    } else {
      const heading = typeof smoke.headingName === "string" ? smoke.headingName.trim() : "";
      if (heading) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (bodyText.includes(heading)) return true;
      } else if (await page.locator("button,input,textarea,select,[data-testid]").count() > 0) {
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function runSafeProbeAction(
  page: Page,
  core: Record<string, unknown>,
  action: string
): Promise<{ page: Page; executed: boolean; error?: string }> {
  const clickButton = async (name: unknown) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("missing button binding");
    const button = page.getByRole("button", { name, exact: true });
    if (await button.count() === 0) throw new Error(`button not found: ${name}`);
    const popupPromise = page.context().waitForEvent("page", { timeout: 1_250 }).catch(() => undefined);
    await button.first().click({ timeout: 5_000 });
    const popup = await popupPromise;
    const activePage = popup ?? page;
    await activePage.waitForLoadState("domcontentloaded", { timeout: 4_000 }).catch(() => undefined);
    await activePage.waitForTimeout(250);
    return activePage;
  };
  try {
    let activePage = page;
    switch (action) {
      case "visual_check":
      case "click_filter":
      case "require_permission":
      case "change_task_status":
      case "edit_task_title":
      case "simulate_error_and_retry":
        if (core.triggerButtonName) activePage = await clickButton(core.triggerButtonName);
        else await page.waitForTimeout(250);
        return { page: activePage, executed: true };
      case "search_keyword":
      case "expect_empty_state":
      case "fill_and_submit": {
        if (typeof core.inputLabel !== "string") throw new Error("missing input binding");
        const input = page.getByLabel(core.inputLabel, { exact: true });
        const target = await input.count() ? input : page.getByPlaceholder(core.inputLabel, { exact: true });
        await target.first().fill(typeof core.input === "string" ? core.input : "Discovery Probe");
        activePage = await clickButton(core.submitButtonName);
        return { page: activePage, executed: true };
      }
      case "submit_empty_form":
      case "complex_form_validate":
        activePage = await clickButton(core.submitButtonName);
        return { page: activePage, executed: true };
      case "login_as_test_user":
      case "login_invalid_user":
        // Discovery probes verify that authentication controls are bindable,
        // but never submit credentials. The formal runner performs the login
        // later using the project's encrypted credential after authorization.
        return { page, executed: false };
      case "table_sort_filter_paginate":
        if (core.triggerButtonName) activePage = await clickButton(core.triggerButtonName);
        if (typeof core.selectLabel === "string" && typeof core.selectValue === "string") {
          await activePage.getByLabel(core.selectLabel, { exact: true }).selectOption(core.selectValue);
        }
        if (typeof core.inputLabel === "string") {
          await activePage.getByLabel(core.inputLabel, { exact: true }).fill(
            typeof core.input === "string" ? core.input : "Discovery Probe"
          );
        }
        if (core.submitButtonName && core.submitButtonName !== core.triggerButtonName) {
          activePage = await clickButton(core.submitButtonName);
        }
        return { page: activePage, executed: true };
      case "openapi_schema_contract":
        if (core.triggerButtonName || core.submitButtonName) {
          activePage = await clickButton(core.triggerButtonName ?? core.submitButtonName);
        } else {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => undefined);
          await page.waitForTimeout(Math.min(Math.max(Number(core.waitMs) || 500, 250), 2_000));
        }
        return { page: activePage, executed: true };
      default:
        return {
          page,
          executed: false,
          error: `probe.action_not_safe:${action || "missing"}`
        };
    }
  } catch (error) {
    return {
      page,
      executed: false,
      error: `probe.action_failed:${error instanceof Error ? error.message : String(error)}`
    };
  }
}

async function probeDraftPage(draft: HarnessGapScenarioDraft): Promise<DraftProbeResult> {
  const emptyTrace: DraftProbeTrace = {
    navigationUrl: draft.probeUrl,
    actionExecuted: false,
    observedHeadings: [],
    observedButtons: [],
    observedTestIds: [],
    responseUrls: []
  };
  if (!draft.probeUrl) return { issues: [], trace: emptyTrace };
  const scenario = draft.scenario;
  const smoke = scenario.smoke && typeof scenario.smoke === "object"
    ? scenario.smoke as Record<string, unknown>
    : {};
  const core = corePathOf(scenario);
  const action = typeof core.action === "string" ? core.action : "";
  const buttonNames = Array.from(new Set([
    core.triggerButtonName,
    core.submitButtonName
  ].filter((value): value is string => typeof value === "string" && Boolean(value.trim()))));
  const runtimeIssues: string[] = [];
  const responses: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
    const context = await browser.newContext();
    let page = await context.newPage();
    context.on("response", (response) => responses.push(response.url()));
    await page.goto(draft.probeUrl, { waitUntil: "commit", timeout: 20_000 });
    // Wait for this scenario's bindings, not merely the first piece of page
    // chrome. ANDFlow renders its top navigation before auth configuration is
    // resolved; treating that shell as "ready" made the probe check Login too
    // early and report a false missing-control failure.
    const documentBecameObservable = await waitForDraftBindings(page, smoke, core, action);
    const before = await visiblePageModel(page);
    if (!documentBecameObservable
      && before.headings.length === 0
      && before.buttons.length === 0
      && before.testIds.length === 0) {
      runtimeIssues.push("probe.page_not_ready:no_observable_controls");
    }
    emptyTrace.observedHeadings = before.headings;
    emptyTrace.observedButtons = before.buttons;
    emptyTrace.observedTestIds = before.testIds;

    const heading = typeof smoke.headingName === "string" ? smoke.headingName.trim() : "";
    if (heading) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (!bodyText.includes(heading)) runtimeIssues.push(`probe.heading_missing:${heading}`);
    }

    emptyTrace.action = action;
    for (const buttonName of buttonNames) {
      if (await page.getByRole("button", { name: buttonName, exact: true }).count() === 0) {
        runtimeIssues.push(`probe.button_missing:${buttonName}`);
      }
    }

    const inputLabel = typeof core.inputLabel === "string" ? core.inputLabel.trim() : "";
    const actionRequiresInput = new Set([
      "form_submit",
      "complex_form_validate",
      "search_validate",
      "file_upload_validate"
    ]).has(action);
    if (inputLabel && actionRequiresInput) {
      const labelled = await page.getByLabel(inputLabel, { exact: true }).count();
      const placeholder = await page.getByPlaceholder(inputLabel, { exact: true }).count();
      if (labelled === 0 && placeholder === 0) runtimeIssues.push(`probe.input_missing:${inputLabel}`);
    }
    if (["login_as_test_user", "login_invalid_user"].includes(action)) {
      for (const field of ["username", "password"] as const) {
        const locator = typeof core[`${field}Locator`] === "string" ? String(core[`${field}Locator`]).trim() : "";
        const label = typeof core[`${field}Label`] === "string" ? String(core[`${field}Label`]).trim() : "";
        const bound = locator
          ? await page.locator(locator).count()
          : label
            ? await page.getByLabel(label, { exact: true }).count()
              || await page.getByPlaceholder(label, { exact: true }).count()
            : 0;
        if (!bound) runtimeIssues.push(`probe.input_missing:${field}`);
      }
    }

    // Oracle checks describe post-action state. The old probe evaluated them
    // before performing the action, which made valid generated scenarios look
    // like coverage gaps. Only execute after all action preconditions exist.
    if (!runtimeIssues.some((issue) =>
      issue.startsWith("probe.button_missing:") || issue.startsWith("probe.input_missing:")
    )) {
      const actionResult = await runSafeProbeAction(page, core, action);
      page = actionResult.page;
      emptyTrace.actionExecuted = actionResult.executed;
      emptyTrace.actionError = actionResult.error;
      emptyTrace.postActionUrl = page.url();
      if (actionResult.error) runtimeIssues.push(actionResult.error);
    }
    const after = await visiblePageModel(page);
    emptyTrace.observedHeadings = Array.from(new Set([...before.headings, ...after.headings]));
    emptyTrace.observedButtons = Array.from(new Set([...before.buttons, ...after.buttons]));
    emptyTrace.observedTestIds = Array.from(new Set([...before.testIds, ...after.testIds]));

    const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
    if (emptyTrace.actionExecuted) for (const oracle of oracles) {
      const oracleLocator = typeof oracle.locator === "string" ? oracle.locator.trim() : "";
      if (oracleLocator && await page.locator(oracleLocator).count() === 0) {
        runtimeIssues.push(`probe.oracle_locator_missing:${oracleLocator}`);
      }
      const expectedText = typeof oracle.expectedTextIncludes === "string" ? oracle.expectedTextIncludes.trim() : "";
      if (oracleLocator && expectedText) {
        const oracleText = await page.locator(oracleLocator).allTextContents().catch(() => []);
        if (!oracleText.some((text) => text.includes(expectedText))) {
          runtimeIssues.push(`probe.oracle_text_missing:${expectedText}`);
        }
      }
      const networkFragment = typeof oracle.networkUrlIncludes === "string" ? oracle.networkUrlIncludes.trim() : "";
      if (networkFragment && !responses.some((url) => url.includes(networkFragment))) {
        runtimeIssues.push(`probe.network_missing:${networkFragment}`);
      }
    }
  } catch (error) {
    runtimeIssues.push(`probe.page_unavailable:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
  emptyTrace.responseUrls = Array.from(new Set(responses)).slice(0, 100);
  return { issues: Array.from(new Set(runtimeIssues)), trace: emptyTrace };
}

function repairDiscoveryDraft(
  draft: HarnessGapScenarioDraft,
  probe: DraftProbeResult
): { draft: HarnessGapScenarioDraft; changedFields: string[]; reason: string } {
  if (!draft.gapId.startsWith("discovery_")) {
    return { draft, changedFields: [], reason: "Only Discovery-generated drafts are eligible for automatic binding repair." };
  }
  const scenario = structuredClone(draft.scenario);
  const smoke = scenario.smoke && typeof scenario.smoke === "object"
    ? scenario.smoke as Record<string, unknown>
    : {};
  const core = corePathOf(scenario);
  const changedFields: string[] = [];
  const observedHeading = probe.trace.observedHeadings.find(Boolean);

  if (probe.issues.some((issue) => issue.startsWith("probe.heading_missing:")) && observedHeading) {
    smoke.headingName = observedHeading;
    smoke.expected = `${draft.probeUrl ?? "页面"} 可访问并出现 ${observedHeading}`;
    scenario.smoke = smoke;
    changedFields.push("smoke.headingName", "smoke.expected");
  }

  for (const field of ["triggerButtonName", "submitButtonName"] as const) {
    const expected = typeof core[field] === "string" ? String(core[field]) : "";
    if (!expected || !probe.issues.includes(`probe.button_missing:${expected}`)) continue;
    const replacement = closestObservedButton(expected, probe.trace.observedButtons);
    if (replacement && replacement !== expected) {
      core[field] = replacement;
      changedFields.push(`corePath.${field}`);
    }
  }

  const action = typeof core.action === "string" ? core.action : "";
  const genericVisualOracleFailed = action === "visual_check" && probe.issues.some((issue) =>
    issue.startsWith("probe.oracle_") || issue.startsWith("probe.selector_missing:")
  );
  if (genericVisualOracleFailed && observedHeading) {
    core.targetLocator = "body";
    core.expectedTextIncludes = observedHeading;
    const oracles = Array.isArray(core.oracles) ? core.oracles as Array<Record<string, unknown>> : [];
    for (const oracle of oracles) {
      if (oracle.type === "dom_text") {
        oracle.locator = "body";
        oracle.expectedTextIncludes = observedHeading;
        oracle.expected = `动作执行后页面仍包含可验证标题 ${observedHeading}`;
      }
    }
    changedFields.push("corePath.targetLocator", "corePath.oracles");
  }
  scenario.corePath = core;
  const reason = changedFields.length
    ? `Bound ${changedFields.join(", ")} from the real page probe.`
    : "The probe did not expose a unique safe binding; human review is still required.";
  return {
    draft: {
      ...draft,
      scenario,
      missingInfo: (draft.missingInfo ?? []).filter((item) => !item.startsWith("probe."))
    },
    changedFields: Array.from(new Set(changedFields)),
    reason
  };
}

export async function probeScenarioDraft(id: string, credentialId?: string) {
  const draft = await readDraft(id);
  if (!draft) return undefined;
  const stableMissingInfo = (draft.missingInfo ?? []).filter((item) => !item.startsWith("probe."));
  let probe = stableMissingInfo.length
    ? {
        issues: [] as string[],
        trace: {
          navigationUrl: draft.probeUrl,
          actionExecuted: false,
          observedHeadings: [],
          observedButtons: [],
          observedTestIds: [],
          responseUrls: []
        } satisfies DraftProbeTrace
      }
    : await probeDraftPage(draft);
  let workingDraft = draft;
  let repairAttempts = draft.repairAttempts ?? [];
  if (probe.issues.length && stableMissingInfo.length === 0) {
    const repaired = repairDiscoveryDraft(draft, probe);
    repairAttempts = [...repairAttempts, {
      attempt: repairAttempts.length + 1,
      strategy: "deterministic" as const,
      status: repaired.changedFields.length ? "repaired" as const : "not-repairable" as const,
      changedFields: repaired.changedFields,
      reason: repaired.reason,
      at: new Date().toISOString()
    }];
    if (repaired.changedFields.length) {
      workingDraft = repaired.draft;
      probe = await probeDraftPage(workingDraft);
    }
  }
  if (probe.issues.length && stableMissingInfo.length === 0 && credentialId && draft.gapId.startsWith("discovery_")) {
    const llmRepair = await createLlmScenarioBindingRepair({
      draft: {
        ...workingDraft,
        missingInfo: probe.issues,
        probeTrace: probe.trace
      },
      credentialId
    });
    repairAttempts = [...repairAttempts, {
      attempt: repairAttempts.length + 1,
      strategy: "llm-assisted",
      status: llmRepair.status === "passed" ? "repaired" : llmRepair.status === "failed" ? "failed" : "not-repairable",
      changedFields: llmRepair.changedFields,
      reason: llmRepair.reason,
      at: new Date().toISOString(),
      model: llmRepair.model,
      callId: llmRepair.callId
    }];
    if (llmRepair.status === "passed" && llmRepair.scenario) {
      workingDraft = {
        ...workingDraft,
        scenario: llmRepair.scenario,
        missingInfo: []
      };
      probe = await probeDraftPage(workingDraft);
    }
  }
  const missingInfo = Array.from(new Set([...stableMissingInfo, ...probe.issues]));
  const probed = enrichDraft({
    ...workingDraft,
    selectorProbeStatus: missingInfo.length ? "failed" : "passed",
    missingInfo,
    probeTrace: probe.trace,
    repairAttempts
  });
  return writeDraft(probed);
}

export async function approveScenarioDraft(id: string) {
  const probed = await probeScenarioDraft(id);
  if (!probed || probed.selectorProbeStatus !== "passed") return probed;
  await mkdir(scenarioDir, { recursive: true });
  const installed = path.join(scenarioDir, `${probed.scenarioId}.json`);
  await writeFile(installed, JSON.stringify(probed.scenario, null, 2));
  const approved = await writeDraft({
    ...probed,
    draftReviewStatus: "approved",
    selectorProbeStatus: "passed",
    installedFile: path.relative(rootDir, installed)
  });
  await updateHarnessGap(approved.gapId, { status: "implemented" });
  return approved;
}
