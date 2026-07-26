import { chromium } from "playwright";
import type { DiscoveryScanResult, DiscoveryScanSuggestion, HarnessGapScenarioDraft, SourceReadEnvelope, TargetAppRuntime } from "./types.js";
import { resolveProjectTarget } from "./projectAdapter.js";
import { writeScenarioDraft } from "./harnessGapStore.js";

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "discovered";
}

function operationList(sourceContexts: SourceReadEnvelope[] | undefined) {
  return (sourceContexts ?? []).flatMap((source) =>
    source.readMeta?.openApi?.operations.map((operation) => ({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary
    })) ?? []
  );
}

function selectorForSuggestion(input: {
  testId?: string;
  buttonText?: string;
  inputLabel?: string;
}) {
  return {
    priority: ["role", "text", "testId", "css"],
    role: input.buttonText,
    text: input.inputLabel ?? input.buttonText,
    testId: input.testId,
    css: input.testId ? `[data-testid='${input.testId}']` : undefined
  };
}

function draftScenario(input: {
  suggestion: DiscoveryScanSuggestion;
  heading: string;
  url: string;
}): Record<string, unknown> {
  const selector = input.suggestion.selectors as { role?: string; text?: string; testId?: string; css?: string };
  const locator = selector.css ?? "body";
  const expectedText = typeof selector.text === "string" && selector.text ? selector.text : input.heading;
  return {
    id: input.suggestion.suggestedScenarioId,
    title: `${input.suggestion.title}（Discovery 草案）`,
    capabilityKind: input.suggestion.capabilityKind ?? "domain_specific",
    genericTemplate: false,
    planObservation: "discovery_scan -> selector_probe -> oracle_dry_run -> human_approval",
    summary: input.suggestion.reason,
    matcher: {
      keywords: [input.suggestion.riskKind, input.suggestion.title, input.suggestion.capabilityKind ?? "discovery"].filter(Boolean),
      riskLevel: "medium",
      sourceHints: ["llm_inferred"],
      capabilities: [input.suggestion.capabilityKind ?? "discovery"]
    },
    smoke: {
      pathId: `open_${input.suggestion.suggestedScenarioId}`,
      stepId: `open_${input.suggestion.suggestedScenarioId}`,
      title: "打开待探索页面",
      headingName: input.heading,
      assertionName: "页面可访问",
      expected: `${input.url} 可访问并出现 ${input.heading}`
    },
    corePath: {
      pathId: `${input.suggestion.suggestedScenarioId}_path`,
      stepId: `${input.suggestion.suggestedScenarioId}_step`,
      title: input.suggestion.title,
      action: input.suggestion.actions[0] ?? "visual_check",
      triggerButtonName: selector.role,
      submitButtonName: selector.role,
      inputLabel: typeof selector.text === "string" ? selector.text : undefined,
      input: input.suggestion.riskKind === "form" ? "Discovery Probe" : undefined,
      targetLocator: locator,
      expectedTextIncludes: expectedText,
      networkUrlIncludes: input.suggestion.riskKind === "api_contract" ? "/" : undefined,
      domAssertionName: `${input.suggestion.title} DOM 证据可验证`,
      riskReason: input.suggestion.reason,
      oracles: input.suggestion.oracles.length ? input.suggestion.oracles : [{
        id: `${input.suggestion.suggestedScenarioId}_dom`,
        name: `${input.suggestion.title} DOM 证据可验证`,
        type: "dom_text",
        locator,
        expectedTextIncludes: expectedText,
        expected: "Discovery dry-run 需要确认该页面状态是否满足业务预期。"
      }]
    },
    regressionPath: {
      stepId: `${input.suggestion.suggestedScenarioId}_snapshot`,
      title: "保留 Discovery 截图",
      action: "visual_check"
    }
  };
}

function suggestionDraft(input: {
  suggestion: DiscoveryScanSuggestion;
  heading: string;
  url: string;
}): HarnessGapScenarioDraft {
  const scenario = draftScenario(input);
  return {
    gapId: `discovery_${input.suggestion.id}`,
    createdAt: new Date().toISOString(),
    scenarioId: input.suggestion.suggestedScenarioId,
    draftReviewStatus: "draft",
    selectorProbeStatus: "not_run",
    riskKind: input.suggestion.riskKind,
    selectors: input.suggestion.selectors,
    actions: input.suggestion.actions,
    oracles: input.suggestion.oracles,
    evidenceRequirements: input.suggestion.evidenceRequirements,
    missingInfo: [],
    scenario
  };
}

function buildSuggestions(input: {
  page: DiscoveryScanResult["page"];
  networkEndpoints: DiscoveryScanResult["networkEndpoints"];
  openApiOperations: DiscoveryScanResult["openApiOperations"];
}) {
  const suggestions: DiscoveryScanSuggestion[] = [];
  const add = (item: Omit<DiscoveryScanSuggestion, "id" | "humanReviewRequired">) => {
    const id = `discovery_${slug(item.title)}_${suggestions.length + 1}`;
    suggestions.push({ id, humanReviewRequired: true, ...item });
  };
  const pageHeading = input.page.headings[0] ?? input.page.title ?? "页面";
  // Every unknown project gets one safe, executable baseline before we infer
  // project-specific controls. It only navigates, captures the page and checks
  // a heading that was actually observed during Discovery.
  add({
    title: "页面可访问与视觉基线",
    riskKind: "navigation",
    reason: "先验证真实页面可以加载并保留截图、DOM、网络和 console 证据。",
    capabilityKind: "domain_specific",
    suggestedScenarioId: `discovered_${slug(input.page.title ?? pageHeading)}_visual_baseline`,
    selectors: selectorForSuggestion({ inputLabel: pageHeading }),
    actions: ["visual_check"],
    oracles: [{
      id: "discovered_visual_baseline_dom",
      name: "页面核心标题可见",
      type: "dom_text",
      locator: "body",
      expectedTextIncludes: pageHeading,
      expected: `页面正文包含 ${pageHeading}`
    }],
    evidenceRequirements: ["screenshot", "dom", "network", "console", "trace"]
  });
  const firstFormInput = input.page.inputs[0];
  const primaryButton = input.page.buttons.find((button) => /提交|保存|创建|登录|submit|save|create|login/i.test(button.text)) ?? input.page.buttons[0];
  if (input.page.inputs.length || input.page.forms.length) {
    add({
      title: "表单提交与校验测试点",
      riskKind: /登录|login|password|邮箱|email/i.test(JSON.stringify(input.page.inputs)) ? "auth" : "form",
      reason: "页面包含输入框或表单，需要验证必填、提交、错误提示和成功状态。",
      capabilityKind: /登录|login|password|邮箱|email/i.test(JSON.stringify(input.page.inputs)) ? "domain_specific" : "complex_form",
      suggestedScenarioId: `discovered_${slug(input.page.title ?? "form")}_form_validation`,
      selectors: selectorForSuggestion({ testId: primaryButton?.testId, buttonText: primaryButton?.text, inputLabel: firstFormInput?.label ?? firstFormInput?.name }),
      actions: [/登录|login|password|邮箱|email/i.test(JSON.stringify(input.page.inputs)) ? "login_as_test_user" : "complex_form_validate"],
      oracles: [{
        id: "discovered_form_dom",
        name: "表单反馈可见",
        type: "dom_text",
        locator: primaryButton?.testId ? `[data-testid='${primaryButton.testId}']` : "body",
        expectedTextIncludes: primaryButton?.text ?? input.page.headings[0] ?? input.page.title,
        expected: "表单提交后页面必须出现可验证反馈。"
      }],
      evidenceRequirements: ["screenshot", "dom", "network", "console"]
    });
  }
  if (input.page.buttons.some((button) => /筛选|排序|下一页|上一页|filter|sort|next|previous/i.test(button.text)) || input.page.testIds.some((id) => /table|list|row|pagination/i.test(id))) {
    add({
      title: "表格/列表排序筛选分页测试点",
      riskKind: "table",
      reason: "页面包含列表、表格或分页相关控件，需要验证排序、筛选、分页和空状态。",
      capabilityKind: "table",
      suggestedScenarioId: `discovered_${slug(input.page.title ?? "table")}_table_flow`,
      selectors: selectorForSuggestion({ buttonText: input.page.buttons.find((button) => /筛选|排序|filter|sort/i.test(button.text))?.text, testId: input.page.testIds.find((id) => /table|list|row/i.test(id)) }),
      actions: ["table_sort_filter_paginate"],
      oracles: [{
        id: "discovered_table_dom",
        name: "列表状态可验证",
        type: "dom_text",
        locator: input.page.testIds.find((id) => /table|list|row/i.test(id)) ? `[data-testid='${input.page.testIds.find((id) => /table|list|row/i.test(id))}']` : "body",
        expectedTextIncludes: input.page.headings[0] ?? input.page.title,
        expected: "列表操作后 DOM 状态必须可验证。"
      }],
      evidenceRequirements: ["screenshot", "dom", "network"]
    });
  }
  if (input.openApiOperations.length || input.networkEndpoints.length) {
    const operation = input.openApiOperations[0];
    const endpoint = input.networkEndpoints.find((item) => item.path && !item.path.includes("@vite")) ?? input.networkEndpoints[0];
    add({
      title: "接口契约与网络请求测试点",
      riskKind: "api_contract",
      reason: "页面运行时产生网络请求，且可与 OpenAPI 或 network evidence 对照。",
      capabilityKind: "openapi_contract",
      suggestedScenarioId: `discovered_${slug(operation?.operationId ?? endpoint?.path ?? "api")}_api_contract`,
      selectors: selectorForSuggestion({ buttonText: primaryButton?.text, testId: primaryButton?.testId }),
      actions: ["openapi_schema_contract"],
      oracles: [{
        id: "discovered_api_schema",
        name: "接口请求符合契约",
        type: "api_schema",
        networkUrlIncludes: operation?.path ?? endpoint?.path ?? "/",
        expected: operation ? `${operation.method} ${operation.path}` : "运行时接口请求必须有成功响应。"
      }],
      evidenceRequirements: ["network", "dom", "screenshot"]
    });
  }
  return suggestions.slice(0, 6);
}

export async function runDiscoveryScan(input: {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  sourceContexts?: SourceReadEnvelope[];
}): Promise<DiscoveryScanResult> {
  const target = await resolveProjectTarget(input);
  // For a managed project the runtime-mapped URL is authoritative. A caller
  // may still carry the saved container port from before sandbox startup.
  const url = input.projectId ? target.frontendUrl : input.appUrl ?? target.frontendUrl;
  const openApiOperations = operationList(input.sourceContexts);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const networkEndpoints: DiscoveryScanResult["networkEndpoints"] = [];
  try {
    const page = await browser.newPage();
    page.on("response", (response) => {
      try {
        const parsed = new URL(response.url());
        networkEndpoints.push({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
          path: parsed.pathname
        });
      } catch {
        networkEndpoints.push({ method: response.request().method(), url: response.url(), status: response.status() });
      }
    });
    // Dev servers commonly keep HMR/SSE connections open. Discovery only
    // needs a parsed DOM; waiting for global network idleness makes healthy
    // projects look hung.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    let pageModel: DiscoveryScanResult["page"];
    try {
      pageModel = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean).slice(0, 12),
      links: Array.from(document.querySelectorAll("a")).map((element) => ({ text: element.textContent?.replace(/\s+/g, " ").trim() ?? "", href: element.href })).filter((item) => item.text || item.href).slice(0, 30),
      buttons: Array.from(document.querySelectorAll("button,[role='button']")).map((element) => ({ text: element.textContent?.replace(/\s+/g, " ").trim() ?? "", testId: element.getAttribute("data-testid") || undefined, role: element.getAttribute("role") || "button" })).filter((item) => item.text || item.testId).slice(0, 30),
      inputs: Array.from(document.querySelectorAll("input,textarea,select")).map((element) => {
        const id = element.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : undefined;
        return {
          label: label?.textContent?.replace(/\s+/g, " ").trim() || element.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || undefined,
          name: element.getAttribute("name") || undefined,
          type: element.getAttribute("type") || element.tagName.toLowerCase(),
          testId: element.getAttribute("data-testid") || undefined
        };
      }).slice(0, 30),
      forms: Array.from(document.querySelectorAll("form")).map((element) => ({ action: element.action || undefined, method: element.method || undefined, inputCount: element.querySelectorAll("input,textarea,select").length })).slice(0, 20),
      testIds: Array.from(document.querySelectorAll("[data-testid]")).map((element) => element.getAttribute("data-testid")).filter(Boolean).slice(0, 80)
      })) as DiscoveryScanResult["page"];
    } catch (error) {
      throw new Error(`discovery_page_model_failed:${error instanceof Error ? error.message : String(error)}`);
    }
    const suggestions = buildSuggestions({ page: pageModel, networkEndpoints, openApiOperations });
    const heading = pageModel.headings[0] ?? pageModel.title ?? "页面";
    const drafts = await Promise.all(suggestions.map((suggestion) => writeScenarioDraft(suggestionDraft({ suggestion, heading, url }))));
    return {
      id: `discovery_${Date.now()}`,
      createdAt: new Date().toISOString(),
      target,
      page: pageModel,
      networkEndpoints: networkEndpoints.slice(0, 80),
      openApiOperations,
      suggestions,
      drafts,
      status: "passed",
      message: `Discovery Scan 完成：发现 ${suggestions.length} 个测试点草案。`
    };
  } catch (error) {
    return {
      id: `discovery_${Date.now()}`,
      createdAt: new Date().toISOString(),
      target,
      page: { url, title: undefined, headings: [], links: [], buttons: [], inputs: [], forms: [], testIds: [] },
      networkEndpoints,
      openApiOperations,
      suggestions: [],
      drafts: [],
      status: "failed",
      message: error instanceof Error ? `Discovery Scan 失败：${error.message}` : "Discovery Scan 失败。"
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
