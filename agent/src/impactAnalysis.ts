import type { ConnectorContext, ImpactAnalysis, ImpactAnalysisItem, SourceReadEnvelope } from "./types.js";
import type { CodeImpactGraph } from "./codeImpactGraph.js";
import { buildDiffImpactGraph } from "./codeImpactGraph.js";
import { matchScenariosForContext } from "./scenarios.js";

function sourceIds(context: ConnectorContext, pattern: RegExp) {
  return context.sourceContexts
    .filter((source) => pattern.test(`${source.kind}\n${source.title}\n${source.summary}\n${source.uri ?? ""}`))
    .map((source) => source.id);
}

function item(input: Omit<ImpactAnalysisItem, "id">): ImpactAnalysisItem {
  return {
    ...input,
    id: `impact_${input.kind}_${Math.random().toString(16).slice(2, 10)}`
  };
}

function diffFiles(diff: string) {
  return Array.from(diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)).map((match) => match[2]);
}

function buildAffectedComponents(context: ConnectorContext): ImpactAnalysisItem[] {
  const files = diffFiles(context.diff);
  return files.map((file) => item({
    kind: file.includes("/api/") || file.includes("server/") ? "api" : file.includes("src/") ? "component" : "unknown",
    target: file,
    reason: `Git diff changed ${file}.`,
    sourceContextIds: sourceIds(context, /diff|pull request|pr/i),
    confidence: file.includes("src/") || file.includes("/api/") ? "high" : "medium"
  }));
}

function buildAffectedPages(context: ConnectorContext, graph: CodeImpactGraph): ImpactAnalysisItem[] {
  return graph.nodes
    .filter((node) => node.kind === "page")
    .map((node) => item({
      kind: "page",
      target: node.label,
      reason: node.file
        ? `代码图在 ${node.file}${node.line ? `:${node.line}` : ""} 识别到页面或路由。`
        : "代码图识别到页面或路由。",
      sourceContextIds: sourceIds(context, /requirement|bug|issue|jira|diff|pull request|pr/i),
      confidence: node.confidence
    }));
}

function buildAffectedApis(context: ConnectorContext, graph: CodeImpactGraph): ImpactAnalysisItem[] {
  const text = `${context.requirement}\n${context.diff}\n${context.bugTicket}`;
  const apis = new Map<string, Omit<ImpactAnalysisItem, "id">>();
  for (const source of context.sourceContexts) {
    if (source.kind !== "openapi") continue;
    for (const operation of source.readMeta?.openApi?.operations ?? []) {
      const target = `${operation.method} ${operation.path}`;
      apis.set(target, {
        kind: "api",
        target,
        reason: `OpenAPI operation${operation.operationId ? ` ${operation.operationId}` : ""}${operation.summary ? `: ${operation.summary}` : ""}.`,
        sourceContextIds: [source.id],
        confidence: "high"
      });
    }
  }
  for (const match of text.matchAll(/\/api\/[a-z0-9_/-]+/gi)) {
    if (!apis.has(match[0])) {
      apis.set(match[0], {
        kind: "api",
        target: match[0],
        reason: `输入上下文命中接口路径或接口相关关键词：${match[0]}`,
        sourceContextIds: sourceIds(context, /diff|openapi|requirement|bug|issue|jira/i),
        confidence: "medium"
      });
    }
  }
  for (const node of graph.nodes.filter((candidate) => candidate.kind === "api-route" || candidate.kind === "frontend-call")) {
    if (apis.has(node.label)) continue;
    apis.set(node.label, {
      kind: "api",
      target: node.label,
      reason: node.file
        ? `代码图在 ${node.file}${node.line ? `:${node.line}` : ""} 识别到接口声明或调用。`
        : "代码图识别到接口声明或调用。",
      sourceContextIds: sourceIds(context, /diff|openapi|requirement|bug|issue|jira|pull request|pr/i),
      confidence: node.confidence
    });
  }
  return Array.from(apis.values()).map((api) => item(api));
}

function riskSignals(context: ConnectorContext) {
  const text = `${context.requirement}\n${context.diff}\n${context.bugTicket}`.toLowerCase();
  const files = diffFiles(context.diff);
  const signals: Array<{ id: string; label: string; pattern: RegExp; weight: number }> = [
    { id: "authorization", label: "权限/RBAC 变更", pattern: /auth|login|permission|role|rbac|权限|登录/, weight: 24 },
    { id: "state_transition", label: "状态机/审批变更", pattern: /approve|reject|transition|workflow|state|状态|审批/, weight: 20 },
    { id: "data_contract", label: "数据模型或迁移变更", pattern: /migration|schema|model|database|openapi|迁移|数据表|接口契约/, weight: 18 },
    { id: "api", label: "API/路由变更", pattern: /\/api\/|router|handler|endpoint|fetch|请求|接口/, weight: 16 },
    { id: "async", label: "异步/重试/队列变更", pattern: /queue|worker|async|retry|timeout|任务|重试|超时/, weight: 14 },
    { id: "historical_bug", label: "缺陷上下文", pattern: /bug|regression|defect|缺陷|回归/, weight: 12 }
  ];
  const active = signals.filter((signal) => signal.pattern.test(text));
  if (files.length >= 8) active.push({ id: "change_breadth", label: `变更范围 ${files.length} 个文件`, pattern: /$^/, weight: 12 });
  else if (files.length >= 3) active.push({ id: "change_breadth", label: `变更范围 ${files.length} 个文件`, pattern: /$^/, weight: 6 });
  return active;
}

function priorityFor(score: number): "critical" | "high" | "medium" | "low" {
  if (score >= 65) return "critical";
  if (score >= 40) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function buildImpactAnalysis(context: ConnectorContext, suppliedGraph?: CodeImpactGraph): ImpactAnalysis {
  const codeGraph = suppliedGraph ?? buildDiffImpactGraph({ diff: context.diff });
  const scenarioMatches = matchScenariosForContext({
    requirement: context.requirement,
    diff: context.diff,
    bugTicket: context.bugTicket
  });
  const signals = riskSignals(context);
  const recommendedScenarios = scenarioMatches.map((match) => {
    const scenarioText = `${match.scenario.id} ${match.scenario.title} ${match.scenario.summary ?? ""} ${(match.scenario.matcher?.capabilities ?? []).join(" ")}`.toLowerCase();
    const relevantSignals = signals.filter((signal) => scenarioText.includes(signal.id.replace("_", " ")) ||
      (signal.id === "authorization" && /auth|permission|role|rbac/.test(scenarioText)) ||
      (signal.id === "state_transition" && /approval|workflow|transition|state/.test(scenarioText)) ||
      (signal.id === "data_contract" && /openapi|schema|contract/.test(scenarioText)) ||
      (signal.id === "api" && /api|network|contract/.test(scenarioText)) ||
      (signal.id === "async" && /error|retry|patrol/.test(scenarioText)) ||
      signal.id === "change_breadth" || signal.id === "historical_bug");
    const graphNode = codeGraph.nodes.find((node) => node.kind === "scenario" && node.label === match.scenario.id);
    const graphReasons = graphNode ? codeGraph.edges.filter((edge) => edge.to === graphNode.id && edge.kind === "covered-by").map((edge) => edge.reason) : [];
    const graphScore = Math.min(24, graphReasons.length * 8);
    const score = Math.min(100, match.score + relevantSignals.reduce((sum, signal) => sum + signal.weight, 0) + (match.riskLevel === "high" ? 8 : 0) + graphScore);
    return {
      scenarioId: match.scenario.id,
      reason: `${match.scenario.summary ?? match.scenario.title} matched keywords: ${match.matchedKeywords.join(", ") || "registry fallback"}; risk drivers: ${relevantSignals.map((signal) => signal.label).join("、") || "keyword match"}; code graph: ${graphReasons.join(" | ") || "no direct graph edge"}.`,
      confidence: score >= 45 ? "high" as const : score >= 18 ? "medium" as const : "low" as const,
      priority: priorityFor(score),
      score,
      riskDrivers: [...relevantSignals.map((signal) => signal.id), ...(graphReasons.length ? ["code_graph"] : [])],
      sourceContextIds: sourceIds(context, /diff|requirement|bug|issue|jira|openapi|pull request|pr/i)
    };
  })
    // Registry keywords can rank an already grounded scenario, but cannot
    // manufacture a production business fact. Only an explicit code-graph
    // relationship may promote a fixed scenario into the impact result.
    .filter((candidate) => candidate.riskDrivers.includes("code_graph"))
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const affectedComponents = buildAffectedComponents(context);
  const affectedApis = buildAffectedApis(context, codeGraph);
  const affectedPages = buildAffectedPages(context, codeGraph);
  const uncoveredRisks = recommendedScenarios.length
    ? []
    : [{
      id: `uncovered_${Date.now()}`,
      title: "变更未命中可执行 scenario",
      reason: "当前 diff、需求和 Bug 上下文没有匹配到 scenario registry，不能声称已覆盖。",
      requiredCapabilities: ["scenario_harness_extension", "oracle_builder", "playwright_runner"],
      sourceContextIds: context.sourceContexts.map((source) => source.id)
    }];
  return {
    id: `impact_${Date.now()}`,
    createdAt: new Date().toISOString(),
    affectedPages,
    affectedApis,
    affectedComponents,
    recommendedScenarios,
    uncoveredRisks,
    codeGraph
  };
}
