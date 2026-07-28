import { chromium } from "playwright";
import type { DiscoveryScanResult, DiscoveryScanSuggestion, HarnessGapScenarioDraft, SourceReadEnvelope, TargetAppRuntime } from "./types.js";
import { resolveProjectTarget } from "./projectAdapter.js";
import { writeScenarioDraft } from "./harnessGapStore.js";
import { createLlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import type { PlannedBusinessFlow } from "./planningConversation.js";

const DISCOVERY_NAVIGATION_TIMEOUT_MS = 20_000;
const DISCOVERY_DOM_READY_TIMEOUT_MS = 8_000;
const DISCOVERY_LIFECYCLE_GRACE_MS = 1_000;

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

function isRuntimeApiEndpoint(endpoint: DiscoveryScanResult["networkEndpoints"][number]) {
  if (["xhr", "fetch", "websocket", "eventsource"].includes(endpoint.resourceType ?? "")) return true;
  const pathname = endpoint.path ?? "";
  if (/^\/(?:api|auth|graphql|rpc|rest)(?:\/|$)/i.test(pathname)) return true;
  if (
    pathname === "/" ||
    /(?:^|\/)(?:@vite|@react-refresh|node_modules|src)(?:\/|$)/.test(pathname) ||
    /\.(?:m?js|cjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|ico|webp|avif)$/i.test(pathname)
  ) return false;
  return false;
}

function draftScenario(input: {
  suggestion: DiscoveryScanSuggestion;
  heading: string;
  url: string;
  projectId?: string;
}): Record<string, unknown> {
  const selector = input.suggestion.selectors as { role?: string; text?: string; testId?: string; css?: string };
  const locator = selector.css ?? "body";
  const expectedText = typeof selector.text === "string" && selector.text ? selector.text : input.heading;
  const action = input.suggestion.actions[0] ?? "visual_check";
  const buttonDrivenActions = new Set([
    "visual_check",
    "click_filter",
    "submit_empty_form",
    "fill_and_submit",
    "login_as_test_user",
    "login_invalid_user",
    "require_permission",
    "change_task_status",
    "edit_task_title",
    "search_keyword",
    "expect_empty_state",
    "simulate_error_and_retry",
    "table_sort_filter_paginate",
    "complex_form_validate",
    "approval_flow_transition",
    "role_permission_matrix"
  ]);
  const buttonName = buttonDrivenActions.has(action) ? selector.role : undefined;
  const submitDrivenActions = new Set([
    "submit_empty_form",
    "fill_and_submit",
    "login_as_test_user",
    "login_invalid_user",
    "complex_form_validate",
    "approval_flow_transition",
    "role_permission_matrix"
  ]);
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
      capabilities: [input.suggestion.capabilityKind ?? "discovery"],
      ...(input.projectId ? { projectIds: [input.projectId] } : {})
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
      action,
      triggerButtonName: buttonName,
      // A navigation/filter control is not also a submit control. Treating it
      // as both caused the probe and the compiled runner to click the same
      // button twice, often returning to the original panel.
      submitButtonName: submitDrivenActions.has(action) ? buttonName : undefined,
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
  projectId?: string;
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
    probeUrl: input.url,
    scenario
  };
}

function semanticTerms(value: string) {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length >= 2);
}

async function selectSuggestion(input: {
  suggestions: DiscoveryScanSuggestion[];
  project: { id: string; name: string };
  goal?: string;
  credentialId?: string;
}): Promise<Pick<DiscoveryScanResult, "recommendedScenarioId" | "recommendedScenarioIds" | "selectionProvenance">> {
  if (!input.suggestions.length) return {};
  const goal = input.goal?.trim() ?? "";
  const comprehensive = /全面|全量|所有业务|所有功能|完整灰度|full|comprehensive/i.test(goal);
  if (comprehensive) {
    // A full scan may be execution-budgeted later, but discovery itself must
    // never silently drop business flows. Every candidate receives an explicit
    // executed/excluded/blocked disposition in the parent run.
    const selected = input.suggestions;
    return {
      recommendedScenarioId: selected[0]?.suggestedScenarioId,
      recommendedScenarioIds: selected.map((suggestion) => suggestion.suggestedScenarioId),
      selectionProvenance: {
        mode: "deterministic",
        reason: `全面灰度模式已登记全部 ${selected.length} 条发现路径；高风险或缺少 oracle 的路径会明确标记为 blocked/excluded，不会被静默省略。`
      }
    };
  }
  const terms = semanticTerms(goal);
  const scored = input.suggestions.map((suggestion) => {
    const text = `${suggestion.title} ${suggestion.riskKind} ${suggestion.capabilityKind ?? ""} ${suggestion.reason} ${suggestion.actions.join(" ")}`.toLowerCase();
    const termMatches = terms.filter((term) => text.includes(term)).length;
    const domainBonus =
      (/登录|权限|login|auth|permission/i.test(goal) && suggestion.riskKind === "auth") ||
      (/接口|网络|api|network/i.test(goal) && suggestion.riskKind === "api_contract") ||
      (/表单|创建|输入|form|create|input/i.test(goal) && suggestion.riskKind === "form") ||
      (/上传|文件|upload|file/i.test(goal) && suggestion.riskKind === "upload") ||
      (/列表|表格|筛选|排序|table|filter|sort/i.test(goal) && suggestion.riskKind === "table")
        ? 8
        : 0;
    return { suggestion, score: termMatches + domainBonus };
  }).sort((left, right) => right.score - left.score);
  const first = scored[0]!;
  const second = scored[1];
  const deterministicIsClear = first.score >= 2 && (!second || first.score > second.score);
  if (deterministicIsClear || !input.credentialId) {
    const selected = deterministicIsClear
      ? first.suggestion
      : input.suggestions.find((suggestion) => suggestion.riskKind === "navigation") ?? first.suggestion;
    return {
      recommendedScenarioId: selected.suggestedScenarioId,
      recommendedScenarioIds: [selected.suggestedScenarioId],
      selectionProvenance: {
        mode: "deterministic",
        reason: deterministicIsClear
          ? "需求关键词与一个 Discovery 测试点形成唯一高置信度匹配。"
          : "没有启用 LLM 选择，使用最小只读视觉基线作为安全路径。"
      }
    };
  }
  const flows: PlannedBusinessFlow[] = input.suggestions.map((suggestion) => ({
    id: suggestion.id,
    title: suggestion.title,
    kind: suggestion.riskKind === "api_contract" ? "api" : "scenario",
    target: suggestion.suggestedScenarioId,
    status: "auto-bindable",
    confidence: "high",
    reason: suggestion.reason,
    scenarioId: suggestion.suggestedScenarioId,
    requiredInformation: []
  }));
  const advice = await createLlmPlanningAdvice({
    project: input.project,
    goal: goal || "对当前项目进行全面灰度测试",
    flows,
    credentialId: input.credentialId
  });
  if (advice.status === "passed") {
    const selectedFlowId = advice.prioritizedFlowIds.find((id) => flows.some((flow) => flow.id === id));
    const selected = input.suggestions.find((suggestion) => suggestion.id === selectedFlowId);
    if (selected) {
      return {
        recommendedScenarioId: selected.suggestedScenarioId,
        recommendedScenarioIds: [selected.suggestedScenarioId],
        selectionProvenance: {
          mode: "llm-assisted",
          reason: advice.summary ?? "LLM 在经过 Discovery 验证的候选场景中选择了最符合目标的路径。",
          llmStatus: advice.status,
          model: advice.model,
          callId: advice.callId
        }
      };
    }
  }
  const fallback = input.suggestions.find((suggestion) => suggestion.riskKind === "navigation") ?? first.suggestion;
  return {
    recommendedScenarioId: fallback.suggestedScenarioId,
    recommendedScenarioIds: [fallback.suggestedScenarioId],
    selectionProvenance: {
      mode: "deterministic-fallback",
      reason: "LLM 未能返回有效候选，已回退到经过 Discovery 验证的最小视觉基线。",
      llmStatus: advice.status,
      model: advice.model,
      callId: advice.callId,
      errorCode: advice.errorCode
    }
  };
}

function buildSuggestions(input: {
  page: DiscoveryScanResult["page"];
  networkEndpoints: DiscoveryScanResult["networkEndpoints"];
  openApiOperations: DiscoveryScanResult["openApiOperations"];
  projectId?: string;
}) {
  const suggestions: DiscoveryScanSuggestion[] = [];
  const add = (item: Omit<DiscoveryScanSuggestion, "id" | "humanReviewRequired">) => {
    const id = `discovery_${slug(item.title)}_${suggestions.length + 1}`;
    suggestions.push({ id, humanReviewRequired: true, ...item });
  };
  const pageHeading = input.page.headings[0] ?? input.page.title ?? "页面";
  const scenarioNamespace = slug(input.projectId ?? input.page.title ?? pageHeading);
  const runtimeApiEndpoints = input.networkEndpoints.filter(isRuntimeApiEndpoint);
  // Every unknown project gets one safe, executable baseline before we infer
  // project-specific controls. It only navigates, captures the page and checks
  // a heading that was actually observed during Discovery.
  add({
    title: "页面可访问与视觉基线",
    riskKind: "navigation",
    reason: "先验证真实页面可以加载并保留截图、DOM、网络和 console 证据。",
    capabilityKind: "domain_specific",
    suggestedScenarioId: `discovered_${scenarioNamespace}_visual_baseline`,
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
  const safeNavigationButtons = input.page.buttons.filter((button) => {
    const label = button.text.trim();
    if (!label || label.length > 48) return false;
    if (/(?:^|\b)(?:send|submit|save|create|delete|remove|publish|reload|new file)(?:\b|$)|登录|注册|提交|保存|创建|删除|发布|重新加载|新建/i.test(label)) return false;
    return /code|preview|version|setting|terminal|connect|market|skill|tool|execution|backstage|dashboard|report|代码|预览|版本|设置|终端|连接|报告/i.test(label);
  });
  for (const button of safeNavigationButtons) {
    add({
      title: `${button.text} 面板可访问性`,
      riskKind: "navigation",
      reason: `真实页面存在“${button.text}”入口；仅执行页面内导航并验证结果可见，不提交数据。`,
      capabilityKind: "domain_specific",
      suggestedScenarioId: `discovered_${scenarioNamespace}_${slug(button.text)}_navigation`,
      selectors: selectorForSuggestion({ buttonText: button.text, testId: button.testId }),
      actions: ["visual_check"],
      oracles: [{
        id: `discovered_${slug(button.text)}_navigation_dom`,
        name: `${button.text} 导航后页面仍可交互`,
        type: "dom_text",
        locator: "body",
        expectedTextIncludes: button.text,
        expected: `点击 ${button.text} 后页面仍保留可验证界面。`
      }],
      evidenceRequirements: ["screenshot", "dom", "network", "console", "trace"]
    });
  }
  const firstFormInput = input.page.inputs[0];
  const primaryButton = input.page.buttons
    .filter((button) =>
      /提交|保存|创建|登录|发送|submit|save|create|login|send/i.test(`${button.text} ${button.testId ?? ""} ${button.title ?? ""}`)
      || button.type === "submit"
    )
    .sort((left, right) => {
      const leftNear = left.nearInputLabel === firstFormInput?.label ? 1 : 0;
      const rightNear = right.nearInputLabel === firstFormInput?.label ? 1 : 0;
      if (leftNear !== rightNear) return rightNear - leftNear;
      const actionPriority = (value: string) => /^(?:send|submit|发送|提交)$/i.test(value) ? 3
        : /^(?:save|login|保存|登录)$/i.test(value) ? 2
          : /^(?:create|创建)$/i.test(value) ? 1 : 0;
      return actionPriority(right.text) - actionPriority(left.text);
    })[0];
  const fileInput = input.page.inputs.find((item) => item.type === "file");
  if (fileInput?.label) {
    add({
      title: "文件上传与结果反馈测试点",
      riskKind: "upload",
      reason: "页面包含文件选择控件，需要验证文件类型、上传结果和页面反馈。",
      capabilityKind: "file_upload",
      suggestedScenarioId: `discovered_${scenarioNamespace}_file_upload`,
      selectors: selectorForSuggestion({ testId: fileInput.testId, inputLabel: fileInput.label, buttonText: primaryButton?.text }),
      actions: ["file_upload_validate"],
      oracles: [{
        id: "discovered_upload_dom",
        name: "上传结果可验证",
        type: "file_upload_state",
        locator: "body",
        expectedTextIncludes: pageHeading,
        expected: "文件上传后页面必须出现可验证反馈。"
      }],
      evidenceRequirements: ["screenshot", "dom", "network", "console", "trace"]
    });
  }
  if ((input.page.inputs.length || input.page.forms.length) && firstFormInput?.label && primaryButton?.text) {
    add({
      title: "表单提交与校验测试点",
      riskKind: /登录|login|password|邮箱|email/i.test(JSON.stringify(input.page.inputs)) ? "auth" : "form",
      reason: "页面包含输入框或表单，需要验证必填、提交、错误提示和成功状态。",
      capabilityKind: /登录|login|password|邮箱|email/i.test(JSON.stringify(input.page.inputs)) ? "domain_specific" : "complex_form",
      suggestedScenarioId: `discovered_${scenarioNamespace}_form_validation`,
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
  const tableControl = input.page.buttons.find((button) =>
    /筛选|排序|下一页|上一页|filter|sort|next|previous/i.test(button.text) ||
    /filter|sort|pagination|next|previous/i.test(button.testId ?? "")
  );
  if (tableControl) {
    add({
      title: "表格/列表排序筛选分页测试点",
      riskKind: "table",
      reason: "页面包含列表、表格或分页相关控件，需要验证排序、筛选、分页和空状态。",
      capabilityKind: "table",
      suggestedScenarioId: `discovered_${scenarioNamespace}_table_flow`,
      selectors: selectorForSuggestion({ buttonText: tableControl.text, testId: input.page.testIds.find((id) => /table|list|row/i.test(id)) }),
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
  if (input.openApiOperations.length || runtimeApiEndpoints.length) {
    const operation = input.openApiOperations[0];
    const endpoint = runtimeApiEndpoints[0];
    const endpointIdentity = operation?.operationId ?? operation?.path ?? endpoint?.path ?? "api";
    add({
      title: "接口契约与网络请求测试点",
      riskKind: "api_contract",
      reason: "页面运行时产生网络请求，且可与 OpenAPI 或 network evidence 对照。",
      capabilityKind: "openapi_contract",
      suggestedScenarioId: `discovered_${scenarioNamespace}_${slug(endpointIdentity)}_api_contract`,
      selectors: selectorForSuggestion({ inputLabel: pageHeading }),
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
  return suggestions.slice(0, 12);
}

export async function runDiscoveryScan(input: {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  sourceContexts?: SourceReadEnvelope[];
  goal?: string;
  credentialId?: string;
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
          path: parsed.pathname,
          resourceType: response.request().resourceType()
        });
      } catch {
        networkEndpoints.push({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
          resourceType: response.request().resourceType()
        });
      }
    });
    // A number of real-world SPAs stream their document, inject boot scripts
    // or keep the initial response open. In those cases the page is already
    // visible and inspectable while the global DOMContentLoaded lifecycle
    // event has not fired yet. Discovery needs a committed, usable DOM rather
    // than a specific browser lifecycle event.
    let navigationWarning: string | undefined;
    try {
      await page.goto(url, { waitUntil: "commit", timeout: DISCOVERY_NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      const hasCommittedDocument = await page.evaluate(() =>
        location.href !== "about:blank" &&
        Boolean(document.documentElement)
      ).catch(() => false);
      if (!hasCommittedDocument) {
        throw error;
      }
      navigationWarning = `navigation_commit_timeout:${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      await page.waitForFunction(() => {
        const body = document.body;
        if (!body) return false;
        // innerText deliberately excludes source text inside <script>/<style>.
        // Falling back to textContent makes an unhydrated Vite shell look ready.
        const text = (body.innerText || "").replace(/\s+/g, " ").trim();
        const hasInteractiveContent = Boolean(body.querySelector("a,button,input,textarea,select,[role='button'],[data-testid]"));
        // A bare SPA mount node or script tag is not a usable page yet. Wait
        // until hydration exposes visible text or an actionable control.
        return text.length > 0 || hasInteractiveContent;
      }, undefined, { timeout: DISCOVERY_DOM_READY_TIMEOUT_MS });
    } catch (error) {
      const hasRenderableDocument = await page.evaluate(() =>
        Boolean(document.body?.querySelector("canvas,svg,video,img") || document.body?.innerHTML.trim())
      ).catch(() => false);
      if (!hasRenderableDocument) throw error;
      navigationWarning ??= `visible_dom_timeout:${error instanceof Error ? error.message : String(error)}`;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: DISCOVERY_LIFECYCLE_GRACE_MS }).catch((error) => {
      navigationWarning ??= `domcontentloaded_timeout:${error instanceof Error ? error.message : String(error)}`;
    });
    // Give client-side hydration a short, bounded window to expose headings,
    // controls and test ids without waiting for network idleness.
    await page.waitForTimeout(1_200);
    let pageModel: DiscoveryScanResult["page"];
    try {
      pageModel = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean).slice(0, 12),
      links: Array.from(document.querySelectorAll("a")).map((element) => ({ text: element.textContent?.replace(/\s+/g, " ").trim() ?? "", href: element.href })).filter((item) => item.text || item.href).slice(0, 30),
      buttons: Array.from(document.querySelectorAll("button,[role='button']")).map((element) => {
        const text = element.textContent?.replace(/\s+/g, " ").trim()
          || element.getAttribute("aria-label")
          || element.getAttribute("title")
          || "";
        let scope = element.parentElement;
        let inputDistance = 1;
        let nearInputLabel: string | undefined;
        while (scope && inputDistance <= 6) {
          const input = scope.querySelector("input,textarea,select");
          if (input) {
            const id = input.getAttribute("id");
            const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : undefined;
            nearInputLabel = label?.textContent?.replace(/\s+/g, " ").trim()
              || input.closest("label")?.textContent?.replace(/\s+/g, " ").trim()
              || input.getAttribute("aria-label")
              || input.getAttribute("placeholder")
              || input.getAttribute("name")
              || undefined;
            break;
          }
          scope = scope.parentElement;
          inputDistance += 1;
        }
        return {
          text,
          testId: element.getAttribute("data-testid") || undefined,
          role: element.getAttribute("role") || "button",
          title: element.getAttribute("title") || undefined,
          type: element.getAttribute("type") || undefined,
          nearInputLabel,
          inputDistance: nearInputLabel ? inputDistance : undefined
        };
      }).filter((item) => item.text || item.testId).slice(0, 40),
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
    const suggestions = buildSuggestions({ page: pageModel, networkEndpoints, openApiOperations, projectId: target.projectId });
    const selection = await selectSuggestion({
      suggestions,
      project: {
        id: target.projectId ?? input.projectId ?? "discovered-project",
        name: pageModel.title ?? input.projectId ?? "Discovered Project"
      },
      goal: input.goal,
      credentialId: input.credentialId
    });
    const heading = pageModel.headings[0] ?? pageModel.title ?? "页面";
    const drafts = await Promise.all(suggestions.map((suggestion) =>
      writeScenarioDraft(suggestionDraft({ suggestion, heading, url, projectId: target.projectId }))
    ));
    return {
      id: `discovery_${Date.now()}`,
      createdAt: new Date().toISOString(),
      target,
      page: pageModel,
      networkEndpoints: networkEndpoints.slice(0, 80),
      openApiOperations,
      suggestions,
      drafts,
      ...selection,
      status: "passed",
      message: navigationWarning
        ? `Discovery Scan 完成：页面已渲染，浏览器生命周期未在等待窗口内结束；已按可见 DOM 发现 ${suggestions.length} 个测试点草案。`
        : `Discovery Scan 完成：发现 ${suggestions.length} 个测试点草案。`
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
