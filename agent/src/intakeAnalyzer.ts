import type { GrayPlan, IntakeAnalysis, IntakeSource, ScenarioCandidate, SourceReadEnvelope } from "./types.js";
import { buildScenarioGrayPlan, fixedGrayPlan } from "./plan.js";
import { getDefaultScenarioId, matchScenariosForContext } from "./scenarios.js";
import { buildImpactAnalysis } from "./impactAnalysis.js";
import type { CodeImpactGraph } from "./codeImpactGraph.js";

export interface AnalyzeIntakeInput {
  requirement: string;
  diff: string;
  bugTicket?: string;
  projectId?: string;
  prUrl?: string;
  sources?: IntakeSource[];
  sourceContexts?: SourceReadEnvelope[];
  codeGraph?: CodeImpactGraph;
}

function has(text: string, pattern: RegExp) {
  return pattern.test(text);
}

function sourceStatus(value: string | undefined): "connected" | "simulated" | "missing" {
  if (!value?.trim()) return "missing";
  return "simulated";
}

function buildSources(input: AnalyzeIntakeInput): IntakeSource[] {
  if (input.sources?.length) return input.sources;
  return [
    {
      kind: "git_diff",
      title: "MCP Git/PR diff",
      status: sourceStatus(input.diff),
      summary: input.diff ? "已读取本次代码变更文本，可用于影响面判断。" : "未提供 diff。"
    },
    {
      kind: "requirement_doc",
      title: "MCP 需求文档",
      status: sourceStatus(input.requirement),
      summary: input.requirement ? "已读取需求验收口径，可用于拆分测试场景。" : "未提供需求。"
    },
    {
      kind: "tapd_bug",
      title: "MCP TAPD/Bug 单",
      status: sourceStatus(input.bugTicket),
      summary: input.bugTicket ? "已读取缺陷上下文，可用于回归路径优先级。" : "未接入缺陷单。"
    },
    {
      kind: "pr",
      title: "MCP Pull Request",
      status: sourceStatus(input.prUrl),
      summary: input.prUrl ? "已记录 PR 来源，可回写检查结果。" : "未提供 PR 链接。"
    }
  ];
}

function inferChangedAreas(input: AnalyzeIntakeInput) {
  const content = `${input.requirement}\n${input.diff}\n${input.bugTicket ?? ""}`;
  const areas = new Set<string>();
  if (has(content, /fetch|api|request|query|status=/i)) areas.add("接口请求参数");
  if (has(content, /filter|筛选|状态|completed|active/i)) areas.add("列表筛选与状态展示");
  if (has(content, /搜索|search|keyword|query/i)) areas.add("搜索与关键字查询");
  if (has(content, /新增|创建|create|required|必填|form/i)) areas.add("表单创建与校验");
  if (has(content, /空状态|无数据|empty|暂无/i)) areas.add("空状态展示");
  if (has(content, /异常|error|timeout|500|503|重试/i)) areas.add("异常恢复");
  if (has(content, /login|账号|密码|权限/i)) areas.add("登录与权限态");
  if (has(content, /状态变更|状态流|state transition|标记完成|复杂列表/i)) areas.add("复杂列表状态变更");
  if (has(content, /巡检|线上|核心功能|值班/i)) areas.add("线上核心路径巡检");
  if (areas.size === 0) areas.add("通用页面交互");
  return Array.from(areas);
}

function buildScenarioCandidates(input: AnalyzeIntakeInput): ScenarioCandidate[] {
  const content = `${input.requirement}\n${input.diff}\n${input.bugTicket ?? ""}`;
  const scenarioMatches = matchScenariosForContext(input);
  const candidates: ScenarioCandidate[] = scenarioMatches.map((match) => ({
    id: `candidate_${match.scenario.id}`,
    title: match.scenario.title,
    source: match.source,
    riskLevel: match.riskLevel,
    reason: [
      match.scenario.summary ?? "命中可执行场景注册表。",
      `匹配关键词：${match.matchedKeywords.join(", ")}`,
      `匹配分：${match.score}`
    ].join(" "),
    executable: true,
    mappedScenarioId: match.scenario.id,
    requiredCapabilities: match.requiredCapabilities
  }));

  candidates.push({
    id: "candidate_core_patrol",
    title: "线上核心路径定时巡检",
    source: "patrol",
    riskLevel: "medium",
    reason: "核心业务路径需要脱离 PR 手动触发，定时发现异常并推送值班。",
    executable: true,
    mappedScenarioId: scenarioMatches[0]?.scenario.id ?? getDefaultScenarioId(),
    requiredCapabilities: ["scheduler", "playwright_mcp", "bot_notifier"]
  });

  const needsEdgeHarness =
    has(content, /空状态|无数据|empty/i) &&
    !scenarioMatches.some((match) => match.scenario.id.includes("empty"));
  const needsErrorHarness =
    has(content, /接口失败|异常|error|timeout|500|503|重试/i) &&
    !scenarioMatches.some((match) => match.scenario.id.includes("error"));

  if (scenarioMatches.length === 0 || needsEdgeHarness || needsErrorHarness) {
    candidates.push({
      id: "candidate_error_state",
      title: scenarioMatches.length === 0 ? "未注册场景的需求补测" : "空状态与异常状态补测",
      source: "llm_inferred",
      riskLevel: "medium",
      reason: scenarioMatches.length === 0
        ? "输入文本未命中当前 scenario registry，Plan Judge 不能把该需求算作已覆盖。"
        : "需求或缺陷文本出现异常态信号，但当前 Demo harness 还未执行该路径。",
      executable: false,
      requiredCapabilities: ["scenario_harness_extension", "network_mock"]
    });
  }

  return candidates;
}

function inferRisks(input: AnalyzeIntakeInput): GrayPlan["risks"] {
  const content = `${input.requirement}\n${input.diff}`;
  const scenario = matchScenariosForContext(input)[0]?.scenario;
  if (scenario) return buildScenarioGrayPlan(scenario).risks;
  if (has(content, /query|fetch|筛选|filter|status=/i)) return fixedGrayPlan.risks;
  return [
    {
      id: "risk_unknown_change",
      level: "medium",
      title: "变更影响面不明确",
      evidence: "输入文本未命中现有 scenario，需要先由 Plan Judge 标记覆盖缺口。"
    }
  ];
}

export function analyzeIntake(input: AnalyzeIntakeInput): IntakeAnalysis {
  const scenarioCandidates = buildScenarioCandidates(input);
  const sourceContexts = input.sourceContexts ?? [];
  const impactAnalysis = sourceContexts.length
    ? buildImpactAnalysis({
      requirement: input.requirement,
      diff: input.diff,
      bugTicket: input.bugTicket ?? "",
      projectId: input.projectId,
      prUrl: input.prUrl,
      sourceContexts,
      sources: input.sources ?? buildSources(input)
    }, input.codeGraph)
    : undefined;
  return {
    id: `intake_${Date.now()}`,
    createdAt: new Date().toISOString(),
    sources: buildSources(input),
    sourceContexts: sourceContexts.length ? sourceContexts : undefined,
    impactAnalysis,
    changedAreas: inferChangedAreas(input),
    risks: inferRisks(input),
    scenarioCandidates,
    recommendedTrigger: scenarioCandidates.some((item) => item.source === "patrol") ? "patrol" : "commit"
  };
}
