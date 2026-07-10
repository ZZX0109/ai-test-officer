import type { ConnectorContext, ImpactAnalysis, ImpactAnalysisItem, SourceReadEnvelope } from "./types.js";
import { matchScenariosForContext } from "./scenarios.js";

function sourceIds(context: ConnectorContext, pattern: RegExp) {
  return context.sourceContexts
    .filter((source) => pattern.test(`${source.kind}\n${source.title}\n${source.summary}\n${source.uri ?? ""}`))
    .map((source) => source.id);
}

function matches(text: string, pattern: RegExp) {
  return pattern.test(text);
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

function buildAffectedPages(context: ConnectorContext): ImpactAnalysisItem[] {
  const text = `${context.requirement}\n${context.diff}\n${context.bugTicket}`; 
  const pages: ImpactAnalysisItem[] = [];
  if (matches(text, /task|任务|filter|筛选|search|搜索|status=/i)) {
    pages.push(item({
      kind: "page",
      target: "/tasks",
      reason: "需求或 diff 命中任务列表、筛选、搜索或状态关键词。",
      sourceContextIds: sourceIds(context, /requirement|bug|issue|jira|diff|openapi/i),
      confidence: "high"
    }));
  }
  if (matches(text, /login|登录|auth|权限|permission|session/i)) {
    pages.push(item({
      kind: "page",
      target: "/login",
      reason: "输入上下文命中登录、会话或权限关键词。",
      sourceContextIds: sourceIds(context, /requirement|bug|issue|jira|diff/i),
      confidence: "high"
    }));
  }
  return pages;
}

function buildAffectedApis(context: ConnectorContext): ImpactAnalysisItem[] {
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
  if (matches(text, /status=|keyword=|fetchTasks|tasks/i) && !apis.has("/api/tasks")) {
    apis.set("/api/tasks", {
      kind: "api",
      target: "/api/tasks",
      reason: "输入上下文命中任务接口、筛选、搜索或 fetchTasks 关键词。",
      sourceContextIds: sourceIds(context, /diff|openapi|requirement|bug|issue|jira/i),
      confidence: "high"
    });
  }
  if (matches(text, /login|auth|session|权限/i) && !apis.has("/api/auth/session")) {
    apis.set("/api/auth/session", {
      kind: "api",
      target: "/api/auth/session",
      reason: "输入上下文命中登录、会话或权限关键词。",
      sourceContextIds: sourceIds(context, /diff|openapi|requirement|bug|issue|jira/i),
      confidence: "high"
    });
  }
  return Array.from(apis.values()).map((api) => item(api));
}

export function buildImpactAnalysis(context: ConnectorContext): ImpactAnalysis {
  const scenarioMatches = matchScenariosForContext({
    requirement: context.requirement,
    diff: context.diff,
    bugTicket: context.bugTicket
  });
  const recommendedScenarios = scenarioMatches.slice(0, 8).map((match) => ({
    scenarioId: match.scenario.id,
    reason: `${match.scenario.summary ?? match.scenario.title} matched keywords: ${match.matchedKeywords.join(", ") || "registry fallback"}.`,
    confidence: match.score > 35 ? "high" as const : match.score > 12 ? "medium" as const : "low" as const,
    sourceContextIds: sourceIds(context, /diff|requirement|bug|issue|jira|openapi|pull request|pr/i)
  }));
  const affectedComponents = buildAffectedComponents(context);
  const affectedApis = buildAffectedApis(context);
  const affectedPages = buildAffectedPages(context);
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
    uncoveredRisks
  };
}
