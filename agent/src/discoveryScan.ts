import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  DiscoveryPageObservation,
  DiscoveryScanResult,
  DiscoveryScanSuggestion,
  HarnessGapScenarioDraft,
  SourceReadEnvelope,
  TargetAppRuntime
} from "./types.js";
import { resolveProjectTarget } from "./projectAdapter.js";
import { writeScenarioDraft } from "./harnessGapStore.js";
import { createLlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import type { PlannedBusinessFlow } from "./planningConversation.js";
import { sanitizeDiscoveryPageObservation, writeDiscoveryPageObservation } from "./pageObservationStore.js";
import { queryRepairExperience } from "./feedback-loop/feedbackLoop.js";
import { ensurePlaywrightChromium } from "@ai-test-officer/playwright-runtime";

const DISCOVERY_NAVIGATION_TIMEOUT_MS = 20_000;
const DISCOVERY_TOTAL_OBSERVATION_BUDGET_MS = 60_000;
// Cold-started SPAs can spend well over eight seconds resolving their module
// graph before the first useful control appears. Treat that as startup work,
// not as proof that the page has no interactive surface.
const DISCOVERY_NO_PROGRESS_TIMEOUT_MS = 20_000;
const DISCOVERY_LIFECYCLE_GRACE_MS = 1_000;
const DISCOVERY_STABLE_WINDOW_MS = 600;
const DISCOVERY_POLL_INTERVAL_MS = 200;
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

function affectsDiscoveryReadiness(resourceType: string) {
  // Scripts, fonts and images are useful telemetry, but large Vite/Next module
  // graphs must not keep Discovery permanently "busy" after a usable DOM is
  // present. Only navigation and business-data traffic participate in the
  // readiness barrier; every request is still retained in network evidence.
  return ["document", "fetch", "xhr"].includes(resourceType);
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  bounds: { min: number; max: number }
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, Math.floor(value!)));
}

function observationText(value: unknown, limit = 1_200) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|afk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function observationUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, "[REDACTED]");
    }
    url.pathname = url.pathname
      .split("/")
      .map((segment) => /^[A-Za-z0-9_-]{25,}$/.test(segment) ? "[REDACTED]" : segment)
      .join("/");
    return observationText(url.toString(), 800);
  } catch {
    return observationText(value, 800);
  }
}

function discoveryDiagnosis(input: {
  status: DiscoveryPageObservation["status"];
  stage: DiscoveryPageObservation["stage"];
  documentCommitted: boolean;
  documentReadyState?: string;
  interactiveElementCount: number;
  httpStatus?: number;
  console: DiscoveryPageObservation["console"];
  pageErrors: string[];
  failedRequests: DiscoveryPageObservation["failedRequests"];
  error?: string;
}) {
  const likelyCauses: string[] = [];
  if (!input.documentCommitted) {
    likelyCauses.push("目标服务未响应、端口不可达或浏览器环境无法访问该地址");
  }
  if (input.httpStatus && input.httpStatus >= 400) {
    likelyCauses.push(`页面文档返回 HTTP ${input.httpStatus}`);
  }
  if (input.documentCommitted && input.interactiveElementCount === 0) {
    likelyCauses.push("页面已打开，但前端尚未渲染可操作控件");
    if (!input.documentReadyState || input.documentReadyState !== "complete") {
      likelyCauses.push("document.readyState 仍未到 complete，前端脚本或认证初始化可能卡住");
    }
    if (!input.console.length && !input.pageErrors.length && !input.failedRequests.length) {
      likelyCauses.push("页面 DOM 仍为空且没有可见浏览器错误，可能是客户端初始化请求未完成");
    }
  }
  if (input.pageErrors.length || input.console.some((item) => item.type === "error")) {
    likelyCauses.push("页面运行时出现 JavaScript 或 console 异常");
  } else if (input.console.length) {
    likelyCauses.push("页面 console 出现警告信息");
  }
  if (input.failedRequests.length) likelyCauses.push("页面存在失败的网络请求");
  if (input.error && /timeout|timed out/i.test(input.error)) {
    likelyCauses.push("页面加载或渲染超过 Discovery 等待窗口");
  }
  if (!likelyCauses.length && input.status !== "ready") likelyCauses.push("页面观测未形成可执行控件绑定");
  const summary = input.status === "ready"
    ? `页面已完成观测：发现 ${input.interactiveElementCount} 个可操作元素。`
    : input.documentCommitted && input.interactiveElementCount > 0
      ? `页面已完成基础观测，但同时发现需要诊断的运行时异常。`
      : input.documentCommitted
        ? `页面已打开，但在 ${input.stage} 阶段未形成完整可执行基线。`
      : `页面未成功打开，Discovery 停在 ${input.stage} 阶段。`;
  return {
    summary,
    likelyCauses: likelyCauses.slice(0, 4),
    retryable: !input.httpStatus
      || input.httpStatus >= 500
      || input.failedRequests.some((request) => (request.status ?? 0) >= 500)
      || /timeout|connection|refused/i.test(input.error ?? ""),
    userActionRequired: !input.documentCommitted || Boolean(input.httpStatus && input.httpStatus >= 400 && input.httpStatus < 500)
  };
}

async function captureDiscoveryScreenshot(page: Page, discoveryId: string) {
  const artifactPath = path.posix.join("discovery", `${discoveryId}.png`);
  const finalPath = path.join(rootDir, "reports", ...artifactPath.split("/"));
  await mkdir(path.dirname(finalPath), { recursive: true });
  await page.screenshot({ path: finalPath, fullPage: true, type: "png", timeout: 5_000 });
  return { storageUri: `/artifacts/${artifactPath}`, capturedAt: new Date().toISOString() };
}

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
  const selector = input.suggestion.selectors as {
    role?: string;
    text?: string;
    testId?: string;
    css?: string;
    usernameLabel?: string;
    passwordLabel?: string;
    usernameLocator?: string;
    passwordLocator?: string;
  };
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
  // `selector.text` is a useful text oracle for any suggestion, but is only
  // an input label for actions that genuinely type.  In particular, a table
  // control such as “按金额排序” must never be compiled into `fill(label)`:
  // that turns a discovered button into a fictitious text field and makes a
  // live-DOM probe fail before browser execution starts.
  const inputDrivenActions = new Set([
    "fill_and_submit",
    "search_keyword",
    "expect_empty_state",
    "approval_flow_transition",
    "authenticated_onboarding_workflow"
  ]);
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
      inputLabel: inputDrivenActions.has(action) && typeof selector.text === "string"
        ? selector.text
        : undefined,
      input: inputDrivenActions.has(action) && input.suggestion.riskKind === "form"
        ? "Discovery Probe"
        : undefined,
      usernameLabel: selector.usernameLabel,
      passwordLabel: selector.passwordLabel,
      usernameLocator: selector.usernameLocator,
      passwordLocator: selector.passwordLocator,
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
  // Theme toggles and hidden CSRF fields often precede the actual form. A
  // checkbox must not prevent Discovery from recognizing the login fields
  // that follow it.
  const formInputs = input.page.inputs.filter((item) =>
    !["checkbox", "radio", "hidden", "button", "submit"].includes((item.type ?? "").toLowerCase())
    && Boolean(item.label || item.name || item.testId)
  );
  const firstFormInput = formInputs[0];
  const passwordInput = formInputs.find((item) =>
    item.type?.toLowerCase() === "password" || /password|passwd|密码/i.test(`${item.label ?? ""} ${item.name ?? ""}`)
  );
  const usernameInput = formInputs.find((item) =>
    item !== passwordInput
    && (/email|username|user|login|邮箱|账号|用户名/i.test(`${item.type ?? ""} ${item.label ?? ""} ${item.name ?? ""}`)
      || item.type?.toLowerCase() === "email")
  ) ?? firstFormInput;
  const isAuthForm = Boolean(
    passwordInput
    && usernameInput
    && input.page.buttons.some((button) => /登录|login|sign[\s-]?in/i.test(button.text) || button.type === "submit")
  );
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
  if ((formInputs.length || input.page.forms.length) && firstFormInput?.label && primaryButton?.text) {
    const selectors = {
      ...selectorForSuggestion({
        testId: primaryButton?.testId,
        buttonText: primaryButton?.text,
        inputLabel: usernameInput?.label ?? firstFormInput?.label ?? firstFormInput?.name
      }),
      ...(isAuthForm ? {
        usernameLabel: usernameInput?.label,
        passwordLabel: passwordInput?.label,
        usernameLocator: usernameInput?.name
          ? `[name='${usernameInput.name.replace(/'/g, "\\'")}']`
          : usernameInput?.testId
            ? `[data-testid='${usernameInput.testId.replace(/'/g, "\\'")}']`
            : undefined,
        passwordLocator: passwordInput?.name
          ? `[name='${passwordInput.name.replace(/'/g, "\\'")}']`
          : passwordInput?.testId
            ? `[data-testid='${passwordInput.testId.replace(/'/g, "\\'")}']`
            : undefined
      } : {})
    };
    add({
      title: isAuthForm ? "登录与认证测试点" : "表单提交与校验测试点",
      riskKind: isAuthForm ? "auth" : "form",
      reason: isAuthForm
        ? "真实页面包含账号、密码和登录按钮；探针只验证控件绑定，正式运行才使用已授权的加密测试账号。"
        : "页面包含输入框或表单，需要验证必填、提交、错误提示和成功状态。",
      capabilityKind: isAuthForm ? "domain_specific" : "complex_form",
      suggestedScenarioId: `discovered_${scenarioNamespace}_form_validation`,
      selectors,
      actions: [isAuthForm ? "login_as_test_user" : "complex_form_validate"],
      oracles: [{
        id: "discovered_form_dom",
        name: isAuthForm ? "登录后应用界面可见" : "表单反馈可见",
        type: isAuthForm ? "url_not_contains" : "dom_text",
        locator: "body",
        ...(isAuthForm
          ? { excludedUrlIncludes: new URL(input.page.url).pathname || "/signin" }
          : { expectedTextIncludes: primaryButton?.text ?? input.page.headings[0] ?? input.page.title }),
        expected: isAuthForm
          ? `提交已授权的测试账号后应离开 ${new URL(input.page.url).pathname || "/signin"}。`
          : "表单提交后页面必须出现可验证反馈。"
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
        // A toolbar control normally lives next to — rather than inside — the
        // table.  Use the observed page surface for the first dry-run proof;
        // a richer table-state oracle is only emitted once we observe a
        // concrete row/header transition.  Binding a button-text assertion to
        // the table element itself creates a self-contradictory contract.
        locator: "body",
        // The action can legitimately change the active panel and remove the
        // original page heading.  Bind the dry-run oracle to the observed
        // table control instead of assuming that the initial heading survives
        // a sort/filter/page transition.
        expectedTextIncludes: tableControl.text,
        expected: `执行“${tableControl.text}”后，列表相关控件仍必须可验证。`
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
  // These are the browser-observed candidates for a comprehensive scan.  Do
  // not silently truncate them here: the execution scheduler, rather than
  // discovery, owns resource limits.  Keeping the complete list is what lets
  // the parent run prove that every discovered path was either executed,
  // explicitly excluded, or blocked with evidence.
  return suggestions;
}

/**
 * Authentication-wall detection.
 *
 * Discovery treats "the page is a login gate" as a distinct, recoverable state
 * rather than a failure. The signal must come from what the browser actually
 * observed — a password field plus an identity field and a submit affordance,
 * an explicit 401/403, or a login route — never from a guess about the product.
 */
export function detectAuthenticationGate(input: {
  page: DiscoveryScanResult["page"];
  url: string;
  httpStatus?: number;
}): { blocked: boolean; reason: string } {
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return { blocked: true, reason: `HTTP ${input.httpStatus}` };
  }
  const inputs = input.page.inputs ?? [];
  const passwordField = inputs.some((item) =>
    (item.type ?? "").toLowerCase() === "password"
    || /password|passwd|密码/i.test(`${item.label ?? ""} ${item.name ?? ""} ${item.testId ?? ""}`)
  );
  const identityField = inputs.some((item) =>
    (item.type ?? "").toLowerCase() === "email"
    || /email|username|user|login|account|邮箱|账号|用户名|手机号/i
      .test(`${item.label ?? ""} ${item.name ?? ""} ${item.testId ?? ""}`)
  );
  const submitAffordance = (input.page.buttons ?? []).some((button) =>
    /登录|登入|sign[\s-]?in|log[\s-]?in/i.test(`${button.text} ${button.title ?? ""} ${button.testId ?? ""}`)
    || button.type === "submit"
  );
  if (passwordField && identityField && submitAffordance) {
    return { blocked: true, reason: "页面包含账号、密码与登录按钮" };
  }
  // A password field alone is still an authentication wall when the route or
  // the visible heading says so; a settings page with a "change password" field
  // will not match both signals.
  const authRoute = /(?:^|\/)(?:login|signin|sign-in|auth|sso|oauth)(?:\/|$|\?)/i.test(input.url);
  const authHeading = (input.page.headings ?? []).some((heading) =>
    /登录|登入|sign\s?in|log\s?in|身份验证|authentication required/i.test(heading)
  );
  if (passwordField && (authRoute || authHeading)) {
    return { blocked: true, reason: authRoute ? "URL 指向登录路由" : "页面标题为登录页" };
  }
  return { blocked: false, reason: "" };
}

export async function runDiscoveryScan(input: {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  sourceContexts?: SourceReadEnvelope[];
  goal?: string;
  credentialId?: string;
  /**
   * Primarily exposed for deterministic integration tests. Production callers
   * should use the bounded default so a cold Vite module graph can finish
   * without allowing Discovery to wait indefinitely.
   */
  observationBudgetMs?: number;
  noProgressTimeoutMs?: number;
}): Promise<DiscoveryScanResult> {
  const target = await resolveProjectTarget(input);
  // For a managed project the runtime-mapped URL is authoritative. A caller
  // may still carry the saved container port from before sandbox startup.
  const url = input.projectId ? target.frontendUrl : input.appUrl ?? target.frontendUrl;
  const openApiOperations = operationList(input.sourceContexts);
  const discoveryId = `discovery_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const observationBudgetMs = boundedDuration(
    input.observationBudgetMs,
    DISCOVERY_TOTAL_OBSERVATION_BUDGET_MS,
    { min: 1_000, max: 120_000 }
  );
  const noProgressTimeoutMs = boundedDuration(
    input.noProgressTimeoutMs,
    DISCOVERY_NO_PROGRESS_TIMEOUT_MS,
    { min: 500, max: 30_000 }
  );
  const observationDeadline = startedMs + observationBudgetMs;
  const networkEndpoints: DiscoveryScanResult["networkEndpoints"] = [];
  const consoleEvents: DiscoveryPageObservation["console"] = [];
  const pageErrors: string[] = [];
  const failedRequests: DiscoveryPageObservation["failedRequests"] = [];
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const browserLifecycle: NonNullable<DiscoveryPageObservation["browserLifecycle"]> = [];
  const lifecycle = (event: NonNullable<DiscoveryPageObservation["browserLifecycle"]>[number]) => {
    if (browserLifecycle.length < 30) browserLifecycle.push(event);
  };
  let stage: DiscoveryPageObservation["stage"] = "launch";
  let documentCommitted = false;
  let httpStatus: number | undefined;
  let navigationWarning: string | undefined;
  let screenshot: DiscoveryPageObservation["screenshot"];
  let activeNetworkRequests = 0;
  let totalNetworkRequests = 0;
  let completedNetworkRequests = 0;
  let failedNetworkRequests = 0;
  let peakActiveNetworkRequests = 0;
  let lastNetworkActivityAt = Date.now();
  let activeReadinessRequests = 0;
  let readinessRequestSequence = 0;
  let lastReadinessNetworkActivityAt = Date.now();
  let documentObservation: DiscoveryPageObservation["document"] = {
    interactiveElementCount: 0,
    controls: []
  };

  const observeDocument = async () => {
    if (!page) return;
    const snapshot = await page.evaluate(() => {
      const controlElements = Array.from(document.querySelectorAll(
        "a,button,input,textarea,select,[role],[data-testid]"
      ));
      const controlFacts = controlElements.map((element) => {
        const html = element as HTMLElement;
        const tag = element.tagName.toLowerCase();
        const kind: "link" | "button" | "input" | "textarea" | "select" | "other" =
          tag === "a" ? "link"
            : tag === "button" ? "button"
              : tag === "input" ? "input"
                : tag === "textarea" ? "textarea"
                  : tag === "select" ? "select"
                    : "other";
        const id = element.getAttribute("id");
        const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : undefined;
        const accessibleName = element.getAttribute("aria-label")
          || label?.textContent
          || element.closest("label")?.textContent
          || element.getAttribute("placeholder")
          || element.textContent
          || undefined;
        const style = getComputedStyle(html);
        const bounds = html.getBoundingClientRect();
        const disabled = element instanceof HTMLButtonElement
          || element instanceof HTMLInputElement
          || element instanceof HTMLTextAreaElement
          || element instanceof HTMLSelectElement
          ? element.disabled
          : element.getAttribute("aria-disabled") === "true";
        const visible = style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && bounds.width > 0
          && bounds.height > 0;
        return {
          kind,
          role: element.getAttribute("role") || undefined,
          accessibleName: accessibleName?.replace(/\s+/g, " ").trim() || undefined,
          testId: element.getAttribute("data-testid") || undefined,
          inputType: element instanceof HTMLInputElement ? element.type : undefined,
          disabled,
          visible
        };
      });
      const summaryText = Array.from(document.querySelectorAll(
        "h1,h2,h3,label,button,[role='alert'],[role='status']"
      ))
        .filter((element) => {
          const html = element as HTMLElement;
          const style = getComputedStyle(html);
          const bounds = html.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity || "1") > 0
            && bounds.width > 0
            && bounds.height > 0;
        })
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .join(" ");
      return {
        readyState: document.readyState,
        bodyText: summaryText,
        interactiveElementCount: controlFacts.filter((control) =>
          control.visible && !control.disabled
        ).length,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        controls: controlFacts.filter((control) => control.visible).slice(0, 40)
      };
    }).catch(() => undefined);
    if (!snapshot) return;
    documentObservation = {
      readyState: snapshot.readyState,
      bodyTextSample: observationText(snapshot.bodyText),
      interactiveElementCount: snapshot.interactiveElementCount,
      viewport: snapshot.viewport,
      accessibilityTree: await page.locator("body").ariaSnapshot({ timeout: 1_000 })
        .then((tree) => observationText(tree, 4_000))
        .catch(() => undefined),
      controls: snapshot.controls.map((control) => ({
        ...control,
        accessibleName: control.accessibleName
          ? observationText(control.accessibleName, 240)
          : undefined,
        testId: control.testId ? observationText(control.testId, 240) : undefined,
        role: control.role ? observationText(control.role, 80) : undefined,
        inputType: control.inputType ? observationText(control.inputType, 80) : undefined
      }))
    };
  };

  const readPageModel = async (): Promise<DiscoveryScanResult["page"] | undefined> => {
    if (!page) return undefined;
    return page.evaluate(() => ({
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
        .filter(Boolean)
        .slice(0, 12),
      links: Array.from(document.querySelectorAll("a"))
        .map((element) => ({
          text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
          href: element.href
        }))
        .filter((item) => item.text || item.href)
        .slice(0, 30),
      buttons: Array.from(document.querySelectorAll("button,[role='button']"))
        .map((element) => {
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
        })
        .filter((item) => item.text || item.testId)
        .slice(0, 40),
      inputs: Array.from(document.querySelectorAll("input,textarea,select"))
        .map((element) => {
          const id = element.getAttribute("id");
          const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : undefined;
          return {
            label: label?.textContent?.replace(/\s+/g, " ").trim()
              || element.closest("label")?.textContent?.replace(/\s+/g, " ").trim()
              || element.getAttribute("aria-label")
              || element.getAttribute("placeholder")
              || element.getAttribute("name")
              || undefined,
            name: element.getAttribute("name") || undefined,
            type: element.getAttribute("type") || element.tagName.toLowerCase(),
            testId: element.getAttribute("data-testid") || undefined
          };
        })
        .slice(0, 30),
      forms: Array.from(document.querySelectorAll("form"))
        .map((element) => ({
          action: element.action || undefined,
          method: element.method || undefined,
          inputCount: element.querySelectorAll("input,textarea,select").length
        }))
        .slice(0, 20),
      testIds: Array.from(document.querySelectorAll("[data-testid]"))
        .map((element) => element.getAttribute("data-testid"))
        .filter((value): value is string => Boolean(value))
        .slice(0, 80)
    })) as Promise<DiscoveryScanResult["page"]>;
  };

  const waitForStableUsableDocument = async () => {
    type WaitOutcome = "stable" | "budget_exhausted" | "no_progress";
    let lastSignature = "";
    let stableSince = 0;
    let lastProgressAt = Date.now();
    let previousReadinessSequence = readinessRequestSequence;
    while (Date.now() < observationDeadline) {
      await observeDocument();
      const usable = Boolean(
        documentObservation.bodyTextSample?.trim()
        || documentObservation.interactiveElementCount > 0
      );
      const signature = [
        page?.url() ?? "about:blank",
        documentObservation.readyState ?? "unknown",
        documentObservation.interactiveElementCount,
        documentObservation.bodyTextSample?.slice(0, 400) ?? ""
      ].join(":");
      const networkProgressed = readinessRequestSequence !== previousReadinessSequence;
      const domProgressed = signature !== lastSignature;
      if (networkProgressed || domProgressed) lastProgressAt = Date.now();
      const networkQuiet = activeReadinessRequests === 0
        && Date.now() - lastReadinessNetworkActivityAt >= DISCOVERY_STABLE_WINDOW_MS;
      if (usable && networkQuiet && signature === lastSignature) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= DISCOVERY_STABLE_WINDOW_MS) {
          return "stable" satisfies WaitOutcome;
        }
      } else {
        stableSince = 0;
      }
      if (
        activeReadinessRequests === 0
        && Date.now() - lastProgressAt >= noProgressTimeoutMs
      ) {
        return "no_progress" satisfies WaitOutcome;
      }
      lastSignature = signature;
      previousReadinessSequence = readinessRequestSequence;
      const remainingMs = observationDeadline - Date.now();
      if (remainingMs <= 0) break;
      await page?.waitForTimeout(Math.min(DISCOVERY_POLL_INTERVAL_MS, remainingMs));
    }
    return "budget_exhausted" satisfies WaitOutcome;
  };

  const buildObservation = (
    status: DiscoveryPageObservation["status"],
    error?: string
  ): DiscoveryPageObservation => ({
    id: discoveryId,
    requestedUrl: observationUrl(url),
    finalUrl: observationUrl(page?.url() || url),
    startedAt,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    stage,
    status,
    navigation: {
      documentCommitted,
      httpStatus,
      warning: navigationWarning ? observationText(navigationWarning, 500) : undefined
    },
    network: {
      totalRequests: totalNetworkRequests,
      completedRequests: completedNetworkRequests,
      failedRequests: failedNetworkRequests,
      activeRequests: activeNetworkRequests,
      peakActiveRequests: peakActiveNetworkRequests,
      lastActivityAt: totalNetworkRequests > 0
        ? new Date(lastNetworkActivityAt).toISOString()
        : undefined
    },
    document: documentObservation,
    console: consoleEvents.slice(-20),
    pageErrors: pageErrors.slice(-20),
    failedRequests: failedRequests.slice(-20),
    browserLifecycle: browserLifecycle.slice(),
    screenshot,
    diagnosis: discoveryDiagnosis({
      status,
      stage,
      documentCommitted,
      documentReadyState: documentObservation.readyState,
      interactiveElementCount: documentObservation.interactiveElementCount,
      httpStatus,
      console: consoleEvents,
      pageErrors,
      failedRequests,
      error: error ?? navigationWarning
    })
  });

  try {
    await ensurePlaywrightChromium();
    lifecycle({ type: "browser_launch", status: "started", at: new Date().toISOString() });
    browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
    lifecycle({ type: "browser_launch", status: "succeeded", at: new Date().toISOString() });
    lifecycle({ type: "context_create", status: "started", at: new Date().toISOString() });
    context = await browser.newContext();
    lifecycle({ type: "context_create", status: "succeeded", at: new Date().toISOString() });
    lifecycle({ type: "page_new", status: "started", at: new Date().toISOString() });
    page = await context.newPage();
    lifecycle({ type: "page_new", status: "succeeded", at: new Date().toISOString() });
    page.on("request", (request) => {
      if (["websocket", "eventsource", "media"].includes(request.resourceType())) return;
      totalNetworkRequests += 1;
      activeNetworkRequests += 1;
      peakActiveNetworkRequests = Math.max(peakActiveNetworkRequests, activeNetworkRequests);
      lastNetworkActivityAt = Date.now();
      if (affectsDiscoveryReadiness(request.resourceType())) {
        activeReadinessRequests += 1;
        readinessRequestSequence += 1;
        lastReadinessNetworkActivityAt = Date.now();
      }
    });
    page.on("requestfinished", (request) => {
      if (["websocket", "eventsource", "media"].includes(request.resourceType())) return;
      completedNetworkRequests += 1;
      activeNetworkRequests = Math.max(0, activeNetworkRequests - 1);
      lastNetworkActivityAt = Date.now();
      if (affectsDiscoveryReadiness(request.resourceType())) {
        activeReadinessRequests = Math.max(0, activeReadinessRequests - 1);
        readinessRequestSequence += 1;
        lastReadinessNetworkActivityAt = Date.now();
      }
    });
    page.on("console", (event) => {
      if (!["warning", "error"].includes(event.type()) || consoleEvents.length >= 100) return;
      consoleEvents.push({ type: event.type(), text: observationText(event.text(), 500) });
    });
    page.on("pageerror", (error) => {
      if (pageErrors.length < 100) pageErrors.push(observationText(error.message, 500));
    });
    page.on("requestfailed", (request) => {
      if (!["websocket", "eventsource", "media"].includes(request.resourceType())) {
        failedNetworkRequests += 1;
        activeNetworkRequests = Math.max(0, activeNetworkRequests - 1);
        lastNetworkActivityAt = Date.now();
        if (affectsDiscoveryReadiness(request.resourceType())) {
          activeReadinessRequests = Math.max(0, activeReadinessRequests - 1);
          readinessRequestSequence += 1;
          lastReadinessNetworkActivityAt = Date.now();
        }
      }
      if (failedRequests.length >= 100) return;
      failedRequests.push({
        method: request.method(),
        url: observationUrl(request.url()),
        resourceType: request.resourceType(),
        failure: observationText(request.failure()?.errorText, 300) || undefined
      });
    });
    page.on("response", (response) => {
      if (networkEndpoints.length < 500) {
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
      }
      if (response.status() >= 400 && failedRequests.length < 100) {
        failedRequests.push({
          method: response.request().method(),
          url: observationUrl(response.url()),
          status: response.status(),
          resourceType: response.request().resourceType(),
          failure: `HTTP ${response.status()}`
        });
      }
    });
    // A number of real-world SPAs stream their document, inject boot scripts
    // or keep the initial response open. In those cases the page is already
    // visible and inspectable while the global DOMContentLoaded lifecycle
    // event has not fired yet. Discovery needs a committed, usable DOM rather
    // than a specific browser lifecycle event.
    stage = "navigation";
    try {
      lifecycle({ type: "page_goto", status: "started", at: new Date().toISOString(), url });
      const navigationBudgetMs = Math.max(
        1,
        Math.min(DISCOVERY_NAVIGATION_TIMEOUT_MS, observationDeadline - Date.now())
      );
      const response = await page.goto(url, { waitUntil: "commit", timeout: navigationBudgetMs });
      documentCommitted = true;
      httpStatus = response?.status();
      lifecycle({ type: "page_goto", status: "succeeded", at: new Date().toISOString(), url: page.url(), httpStatus });
    } catch (error) {
      lifecycle({
        type: "page_goto",
        status: "failed",
        at: new Date().toISOString(),
        url: page?.url() || url,
        error: error instanceof Error ? error.message : String(error)
      });
      const hasCommittedDocument = await page.evaluate(() =>
        location.href !== "about:blank" &&
        Boolean(document.documentElement)
      ).catch(() => false);
      if (!hasCommittedDocument) {
        throw error;
      }
      documentCommitted = true;
      navigationWarning = `navigation_commit_timeout:${error instanceof Error ? error.message : String(error)}`;
    }
    stage = "dom-ready";
    const waitOutcome = await waitForStableUsableDocument();
    if (waitOutcome !== "stable") {
      const hasRenderableDocument = await page.evaluate(() =>
        Boolean(document.body?.querySelector("canvas,svg,video,img") || document.body?.innerHTML.trim())
      ).catch(() => false);
      if (!hasRenderableDocument) throw new Error("discovery_dom_not_rendered");
      navigationWarning ??= waitOutcome === "budget_exhausted"
        ? `visible_dom_budget_exhausted:requests=${totalNetworkRequests},active=${activeNetworkRequests}`
        : `visible_dom_no_progress:requests=${totalNetworkRequests},active=${activeNetworkRequests}`;
    }
    await page.waitForLoadState("domcontentloaded", { timeout: DISCOVERY_LIFECYCLE_GRACE_MS }).catch((error) => {
      navigationWarning ??= `domcontentloaded_timeout:${error instanceof Error ? error.message : String(error)}`;
    });
    // Screenshot capture can itself consume time (for example while Chromium
    // waits for web fonts). Always resample the DOM and page model afterwards
    // so the observation never reports a stale pre-capture "0 controls" state.
    stage = "snapshot";
    screenshot = await captureDiscoveryScreenshot(page, discoveryId).catch((error) => {
      navigationWarning ??= `screenshot_failed:${error instanceof Error ? error.message : String(error)}`;
      return undefined;
    });
    await observeDocument();
    const pageModel = await readPageModel().catch((error) => {
      throw new Error(`discovery_page_model_failed:${error instanceof Error ? error.message : String(error)}`);
    });
    if (!pageModel) throw new Error("discovery_page_model_unavailable");
    stage = "selection";
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
    stage = "completed";
    const hasInteractiveSurface = documentObservation.interactiveElementCount > 0;
    // An authentication wall is only blocking when no test account was supplied.
    // With a credential the login flow itself becomes a legitimate test point.
    const authenticationGate = input.credentialId
      ? { blocked: false, reason: "" }
      : detectAuthenticationGate({ page: pageModel, url: page?.url() || url, httpStatus });
    // Close the experience loop: if this project already resolved an auth block
    // before, say so instead of asking the same question as if it were new.
    const priorAuthExperience = authenticationGate.blocked && (target.projectId ?? input.projectId)
      ? await queryRepairExperience({
        projectId: (target.projectId ?? input.projectId)!,
        repairStrategy: ["auth_fix"],
        limit: 1
      })
      : [];
    const priorAuthHint = priorAuthExperience[0]
      ? `历史经验：该项目此前通过“${priorAuthExperience[0].repairDescription}”解决过同类阻塞（成功率 ${Math.round(priorAuthExperience[0].successRate * 100)}%）。`
      : "";
    const baseObservation = sanitizeDiscoveryPageObservation(buildObservation(
      navigationWarning || consoleEvents.length || pageErrors.length || failedRequests.length || !hasInteractiveSurface
        ? "degraded"
        : "ready"
    ));
    const observation = authenticationGate.blocked
      ? sanitizeDiscoveryPageObservation({
        ...baseObservation,
        diagnosis: {
          ...baseObservation.diagnosis,
          summary: "页面已打开，但当前停留在登录入口，尚不能扫描登录后的业务流程。",
          likelyCauses: [authenticationGate.reason, ...baseObservation.diagnosis.likelyCauses].slice(0, 4),
          retryable: false,
          userActionRequired: true
        }
      })
      : baseObservation;
    await writeDiscoveryPageObservation({
      projectId: target.projectId ?? input.projectId,
      observation
    });
    return {
      id: discoveryId,
      createdAt: new Date().toISOString(),
      target,
      page: pageModel,
      networkEndpoints: networkEndpoints.slice(0, 80),
      openApiOperations,
      observation,
      suggestions: hasInteractiveSurface ? suggestions : [],
      drafts: hasInteractiveSurface ? drafts : [],
      ...(hasInteractiveSurface
        ? selection
        : {
          recommendedScenarioId: undefined,
          recommendedScenarioIds: [],
          selectionProvenance: { mode: "deterministic" as const, reason: "no_interactive_surface" }
        }),
      status: authenticationGate.blocked
        ? "waiting-auth"
        : hasInteractiveSurface ? "passed" : "partial",
      ...(authenticationGate.blocked ? { requiredAction: "credential_required" as const } : {}),
      message: authenticationGate.blocked
        ? `检测到登录页面，请配置测试账号。判定依据：${authenticationGate.reason}。${priorAuthHint}配置后重新执行 Discovery。`
        : !hasInteractiveSurface
        ? "Discovery Scan 已打开页面，但没有发现可操作控件；已保留页面观测，未生成可执行测试流程。"
        : navigationWarning
        ? `Discovery Scan 完成：页面已渲染，浏览器生命周期未在等待窗口内结束；已按可见 DOM 发现 ${suggestions.length} 个测试点草案。`
        : `Discovery Scan 完成：发现 ${suggestions.length} 个测试点草案。`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!browserLifecycle.some((event) => event.type === "browser_launch" && event.status === "succeeded")) {
      lifecycle({ type: "browser_launch", status: "failed", at: new Date().toISOString(), error: message });
    } else if (!browserLifecycle.some((event) => event.type === "context_create" && event.status === "succeeded")) {
      lifecycle({ type: "context_create", status: "failed", at: new Date().toISOString(), error: message });
    } else if (!browserLifecycle.some((event) => event.type === "page_new" && event.status === "succeeded")) {
      lifecycle({ type: "page_new", status: "failed", at: new Date().toISOString(), error: message });
    }
    if (page && documentCommitted) {
      screenshot = await captureDiscoveryScreenshot(page, discoveryId).catch((captureError) => {
        navigationWarning ??= `screenshot_failed:${captureError instanceof Error ? captureError.message : String(captureError)}`;
        return undefined;
      });
    }
    // Even a failed scan must describe the most recent state. A screenshot
    // timeout may outlive the original failure and allow a late SPA mount.
    await observeDocument();
    const failedPageModel = await readPageModel().catch(() => undefined);
    const observation = sanitizeDiscoveryPageObservation(buildObservation("failed", message));
    await writeDiscoveryPageObservation({
      projectId: target.projectId ?? input.projectId,
      observation
    }).catch(() => undefined);
    return {
      id: discoveryId,
      createdAt: new Date().toISOString(),
      target,
      page: failedPageModel ?? {
        url: page?.url() || url,
        title: undefined,
        headings: [],
        links: [],
        buttons: [],
        inputs: [],
        forms: [],
        testIds: []
      },
      networkEndpoints,
      openApiOperations,
      observation,
      suggestions: [],
      drafts: [],
      status: "failed",
      message: `Discovery Scan 失败：${observationText(message, 500)}`
    };
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
