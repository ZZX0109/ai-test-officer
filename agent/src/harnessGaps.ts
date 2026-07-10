import type { ConnectorContext, HarnessGap, IntakeAnalysis } from "./types.js";

function summarizeRequirement(context: ConnectorContext) {
  const text = [context.requirement, context.bugTicket, context.diff]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
  return (text || "未提供可归纳的需求、Bug 单或 diff。").slice(0, 360);
}

function suggestedOracleFrom(context: ConnectorContext) {
  if (/status=active|进行中|active/i.test(`${context.requirement}\n${context.diff}\n${context.bugTicket}`)) {
    return "验证请求携带 status=active，并且页面只展示 active 状态数据。";
  }
  if (/status=completed|已完成|completed/i.test(`${context.requirement}\n${context.diff}\n${context.bugTicket}`)) {
    return "验证请求携带 status=completed，并且页面只展示 completed 状态数据。";
  }
  return "从需求中抽取可观察的 DOM、network、console 和截图断言；llm_inferred 断言需人工确认。";
}

function suggestedStepsFrom(context: ConnectorContext) {
  if (/筛选|filter|status=/i.test(`${context.requirement}\n${context.diff}\n${context.bugTicket}`)) {
    return ["打开目标页面", "触发对应筛选控件", "检查请求查询参数", "检查页面列表状态", "保存截图和 DOM/network 证据"];
  }
  return ["打开目标页面", "执行需求描述中的核心操作", "检查需求对应的可见结果", "保存截图、DOM、network、console 证据"];
}

export function buildHarnessGaps(input: {
  source: HarnessGap["source"];
  context: ConnectorContext;
  analysis: IntakeAnalysis;
  selectedScenarioId?: string;
  relatedCheckId?: string;
  relatedRunId?: string;
}) {
  const now = new Date().toISOString();
  const gaps = input.analysis.scenarioCandidates
    .filter((candidate) => !candidate.executable)
    .map((candidate, index): HarnessGap => ({
      id: `gap_${Date.now()}_${index}`,
      createdAt: now,
      source: input.source,
      requirementSummary: summarizeRequirement(input.context),
      missingScenarioTitle: candidate.title,
      requiredCapabilities: candidate.requiredCapabilities,
      suggestedOracle: suggestedOracleFrom(input.context),
      suggestedSteps: suggestedStepsFrom(input.context),
      status: "open",
      relatedAnalysisId: input.analysis.id,
      relatedCheckId: input.relatedCheckId,
      relatedRunId: input.relatedRunId
    }));

  if (!input.selectedScenarioId && gaps.length === 0) {
    gaps.push({
      id: `gap_${Date.now()}_no_scenario`,
      createdAt: now,
      source: input.source,
      requirementSummary: summarizeRequirement(input.context),
      missingScenarioTitle: "未命中可执行测试场景",
      requiredCapabilities: ["scenario_harness_extension", "oracle_builder", "playwright_mcp"],
      suggestedOracle: suggestedOracleFrom(input.context),
      suggestedSteps: suggestedStepsFrom(input.context),
      status: "open",
      relatedAnalysisId: input.analysis.id,
      relatedCheckId: input.relatedCheckId,
      relatedRunId: input.relatedRunId
    });
  }

  return gaps;
}
