import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScenarioCapabilityKind } from "./types.js";

export type ScenarioRiskLevel = "high" | "medium" | "low";
export type ScenarioMatchSource = "diff" | "requirement" | "tapd_bug" | "patrol" | "llm_inferred";

export type ScenarioAction =
  | "click_filter"
  | "submit_empty_form"
  | "fill_and_submit"
  | "login_as_test_user"
  | "login_invalid_user"
  | "require_permission"
  | "change_task_status"
  | "edit_task_title"
  | "search_keyword"
  | "expect_empty_state"
  | "simulate_error_and_retry"
  | "visual_check"
  | "table_sort_filter_paginate"
  | "complex_form_validate"
  | "file_upload_validate"
  | "approval_flow_transition"
  | "openapi_schema_contract"
  | "role_permission_matrix"
  | "authenticated_onboarding_workflow";

export type ScenarioOracleType =
  | "network_query"
  | "dom_text"
  | "dom_all_text"
  | "validation_text"
  | "empty_state"
  | "error_text"
  | "console_no_error"
  | "api_schema"
  | "file_upload_state"
  | "role_permission_state";

export interface ScenarioMatcher {
  keywords: string[];
  riskLevel: ScenarioRiskLevel;
  sourceHints: string[];
  capabilities: string[];
  /** Optional project allow-list. A scenario must never be selected only because
   * its wording matches when its controls and oracles belong to another target. */
  projectIds?: string[];
}

export interface ScenarioSmoke {
  pathId: string;
  stepId: string;
  title: string;
  headingName: string;
  assertionName: string;
  expected: string;
}

export interface ScenarioOracle {
  id: string;
  name: string;
  type: ScenarioOracleType;
  expected: string;
  locator?: string;
  networkUrlIncludes?: string;
  expectedQueryFragment?: string;
  expectedTextIncludes?: string;
  expectedStatusText?: string;
}

export interface ScenarioCorePath {
  pathId: string;
  stepId: string;
  retryStepId?: string;
  title: string;
  action: ScenarioAction;
  riskReason: string;
  triggerButtonName?: string;
  submitButtonName?: string;
  retryButtonName?: string;
  inputLabel?: string;
  input?: string;
  selectLabel?: string;
  selectValue?: string;
  waitMs?: number;
  networkUrlIncludes?: string;
  expectedQueryFragment?: string;
  statusLocator?: string;
  expectedStatusText?: string;
  queryAssertionName?: string;
  domAssertionName?: string;
  targetLocator?: string;
  expectedTextIncludes?: string;
  validationLocator?: string;
  expectedValidationText?: string;
  emptyStateLocator?: string;
  expectedEmptyText?: string;
  errorLocator?: string;
  expectedErrorText?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  registerButtonName?: string;
  usernameLabel?: string;
  passwordLabel?: string;
  createAccountButtonName?: string;
  loginButtonName?: string;
  loginSubmitButtonName?: string;
  setupHeadingName?: string;
  setupSubmitButtonPattern?: string;
  oracles: ScenarioOracle[];
}

export interface ScenarioRegressionPath {
  stepId: string;
  title: string;
  action?: ScenarioAction;
  triggerButtonName?: string;
  expectedTextIncludes?: string;
}

export interface ExecutableScenario {
  id: string;
  title: string;
  planObservation: string;
  summary?: string;
  capabilityKind?: ScenarioCapabilityKind;
  genericTemplate?: boolean;
  matcher?: ScenarioMatcher;
  smoke: ScenarioSmoke;
  corePath: ScenarioCorePath;
  regressionPath?: ScenarioRegressionPath;
}

type LegacyScenario = Omit<ExecutableScenario, "corePath"> & {
  corePath: Partial<ScenarioCorePath> & {
    clickStepId?: string;
    triggerButtonName?: string;
    networkUrlIncludes?: string;
    expectedQueryFragment?: string;
    statusLocator?: string;
    expectedStatusText?: string;
    queryAssertionName?: string;
    domAssertionName?: string;
    riskReason?: string;
  };
};

const fallbackTaskFilterScenario: ExecutableScenario = normalizeScenario({
  id: "task_filter_completed",
  title: "任务列表已完成筛选验收",
  planObservation: "smoke -> core_path(completed filter) -> regression(all filter)",
  summary: "验证已完成任务筛选是否正确传递 status=completed，并检查 DOM 只展示 completed 任务。",
  matcher: {
    keywords: ["filter", "筛选", "status=completed", "completed", "已完成"],
    riskLevel: "high",
    sourceHints: ["diff", "requirement", "tapd_bug"],
    capabilities: ["mcp_git_diff", "playwright_mcp", "evidence_store"]
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
    pathId: "completed_filter_path",
    stepId: "click_completed",
    title: "点击已完成并验证筛选结果",
    action: "click_filter",
    triggerButtonName: "已完成",
    networkUrlIncludes: "/api/tasks",
    expectedQueryFragment: "status=completed",
    statusLocator: "[data-testid='task-status']",
    expectedStatusText: "completed",
    queryAssertionName: "已完成筛选请求携带 status=completed",
    domAssertionName: "页面只展示 completed 任务",
    riskReason: "diff 修改了筛选请求逻辑",
    oracles: []
  },
  regressionPath: {
    stepId: "all_filter_regression",
    title: "继续执行全部筛选回归路径",
    action: "click_filter",
    triggerButtonName: "全部"
  }
});

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

function normalizeScenario(raw: LegacyScenario): ExecutableScenario {
  const action = raw.corePath.action ?? "click_filter";
  const stepId = raw.corePath.stepId ?? raw.corePath.clickStepId ?? raw.corePath.pathId ?? `${raw.id}_core`;
  const queryAssertionName =
    raw.corePath.queryAssertionName ?? `${raw.title}请求参数符合预期`;
  const domAssertionName =
    raw.corePath.domAssertionName ?? `${raw.title}页面结果符合预期`;
  const oracles = raw.corePath.oracles?.length
    ? raw.corePath.oracles
    : buildDefaultOracles(raw, queryAssertionName, domAssertionName);

  return {
    ...raw,
    capabilityKind: raw.capabilityKind ?? "domain_specific",
    genericTemplate: raw.genericTemplate ?? false,
    corePath: {
      ...raw.corePath,
      pathId: raw.corePath.pathId ?? `${raw.id}_path`,
      stepId,
      retryStepId: raw.corePath.retryStepId ?? `retry_${raw.corePath.pathId ?? raw.id}`,
      title: raw.corePath.title ?? raw.title,
      action,
      riskReason: raw.corePath.riskReason ?? raw.summary ?? "需求或 diff 命中该可执行场景。",
      queryAssertionName,
      domAssertionName,
      oracles
    },
    regressionPath: raw.regressionPath
      ? {
        action: "click_filter",
        ...raw.regressionPath
      }
      : undefined
  };
}

function buildDefaultOracles(
  raw: LegacyScenario,
  queryAssertionName: string,
  domAssertionName: string
): ScenarioOracle[] {
  const oracles: ScenarioOracle[] = [];
  if (raw.corePath.networkUrlIncludes && raw.corePath.expectedQueryFragment) {
    oracles.push({
      id: `${raw.corePath.pathId}_query`,
      name: queryAssertionName,
      type: "network_query",
      networkUrlIncludes: raw.corePath.networkUrlIncludes,
      expectedQueryFragment: raw.corePath.expectedQueryFragment,
      expected: `GET ${raw.corePath.networkUrlIncludes}?${raw.corePath.expectedQueryFragment}`
    });
  }
  if (raw.corePath.statusLocator && raw.corePath.expectedStatusText) {
    oracles.push({
      id: `${raw.corePath.pathId}_dom`,
      name: domAssertionName,
      type: "dom_all_text",
      locator: raw.corePath.statusLocator,
      expectedStatusText: raw.corePath.expectedStatusText,
      expected: `所有匹配节点文本包含 ${raw.corePath.expectedStatusText}`
    });
  }
  if (raw.corePath.targetLocator && raw.corePath.expectedTextIncludes) {
    oracles.push({
      id: `${raw.corePath.pathId}_text`,
      name: domAssertionName,
      type: "dom_text",
      locator: raw.corePath.targetLocator,
      expectedTextIncludes: raw.corePath.expectedTextIncludes,
      expected: `目标节点文本包含 ${raw.corePath.expectedTextIncludes}`
    });
  }
  return oracles;
}

function loadScenario(file: string) {
  return normalizeScenario(JSON.parse(readFileSync(file, "utf8")) as LegacyScenario);
}

function loadScenarioDirectory() {
  try {
    const scenarioDir = path.join(rootDir, "data", "scenarios");
    return readdirSync(scenarioDir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => loadScenario(path.join(scenarioDir, file)));
  } catch {
    return [];
  }
}

const loadedScenarios = loadScenarioDirectory();
const scenarioList = loadedScenarios.length ? loadedScenarios : [fallbackTaskFilterScenario];
const defaultScenario =
  scenarioList.find((scenario) => scenario.id === fallbackTaskFilterScenario.id) ??
  scenarioList[0] ??
  fallbackTaskFilterScenario;

const scenarios: Record<string, ExecutableScenario> = Object.fromEntries(
  scenarioList.map((scenario) => [scenario.id, scenario])
);

export function getDefaultScenarioId() {
  return defaultScenario.id;
}

export function getScenario(id = defaultScenario.id) {
  const scenario = scenarios[id];
  if (!scenario) {
    throw new Error(`Unknown scenarioId: ${id}. Register it in data/scenarios/*.json before execution.`);
  }
  return scenario;
}

export function hasScenario(id: string | undefined) {
  return Boolean(id && scenarios[id]);
}

export function listScenarios() {
  return scenarioList.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    capabilityKind: scenario.capabilityKind ?? "domain_specific",
    genericTemplate: Boolean(scenario.genericTemplate),
    planObservation: scenario.planObservation,
    matcher: scenario.matcher,
    corePath: {
      action: scenario.corePath.action,
      pathId: scenario.corePath.pathId,
      title: scenario.corePath.title,
      oracleCount: scenario.corePath.oracles.length
    }
  }));
}

export function listExecutableScenarios() {
  return scenarioList;
}

function keywordHits(text: string, keywords: string[]) {
  const lowerText = text.toLowerCase();
  return keywords.filter((keyword) => lowerText.includes(keyword.toLowerCase()));
}

function hasExactQuery(text: string, query: string | undefined) {
  return Boolean(query) && text.toLowerCase().includes(query!.toLowerCase());
}

function inferScenarioSource(input: {
  requirement: string;
  diff: string;
  bugTicket?: string;
}, keywords: string[]): ScenarioMatchSource {
  if (keywordHits(input.diff, keywords).length) return "diff";
  if (keywordHits(input.bugTicket ?? "", keywords).length) return "tapd_bug";
  if (keywordHits(input.requirement, keywords).length) return "requirement";
  return "llm_inferred";
}

export function matchScenariosForContext(input: {
  requirement: string;
  diff: string;
  bugTicket?: string;
  projectId?: string;
}) {
  return scenarioList
    .map((scenario) => {
      const matcher = scenario.matcher ?? {
        keywords: [scenario.id, scenario.title],
        riskLevel: "medium" as ScenarioRiskLevel,
        sourceHints: ["requirement"],
        capabilities: ["playwright_mcp", "evidence_store"]
      };
      // Legacy callers without a project context keep the broad discovery
      // behaviour. Once a project is known, project-scoped scenarios are a
      // hard boundary and cannot leak into a different fixture.
      if (input.projectId && matcher.projectIds?.length && !matcher.projectIds.includes(input.projectId)) {
        return undefined;
      }
      const requirementHits = keywordHits(input.requirement, matcher.keywords);
      const diffHits = keywordHits(input.diff, matcher.keywords);
      const bugHits = keywordHits(input.bugTicket ?? "", matcher.keywords);
      const matchedKeywords = Array.from(new Set([...requirementHits, ...diffHits, ...bugHits]));
      const query = scenario.corePath.expectedQueryFragment;
      const score =
        requirementHits.length * 8 +
        diffHits.length * 12 +
        bugHits.length * 14 +
        (hasExactQuery(input.requirement, query) ? 18 : 0) +
        (hasExactQuery(input.diff, query) ? 28 : 0) +
        (hasExactQuery(input.bugTicket ?? "", query) ? 30 : 0);
      return {
        scenario,
        score,
        matchedKeywords,
        source: inferScenarioSource(input, matcher.keywords),
        riskLevel: matcher.riskLevel,
        requiredCapabilities: matcher.capabilities
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
}
