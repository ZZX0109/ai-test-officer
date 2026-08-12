import { createHash } from "node:crypto";
import type { BusinessCapabilityGraph, BusinessCapabilityNode, BusinessSourceLocation } from "./businessCapabilityGraph.js";
import { businessNodeTokens } from "./businessCapabilityGraph.js";

export type BusinessPathSurface = "page" | "api" | "data" | "background-task";
export type BusinessPathStatus = "auto-bindable" | "needs-input" | "coverage-gap";

export interface BusinessPath {
  id: string;
  title: string;
  summary: string;
  status: BusinessPathStatus;
  confidence: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  surfaces: BusinessPathSurface[];
  roles: string[];
  preconditions: string[];
  actionCandidates: string[];
  oracleCandidates: string[];
  requiredEvidenceKinds: string[];
  sourceNodeIds: string[];
  sourceLocations: BusinessSourceLocation[];
  reason: string;
}

function stableId(value: string) {
  return `business_path_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function display(value: string) {
  return value
    .replace(/^[A-Z]+\s+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || value;
}

function surfaceFor(kind: BusinessCapabilityNode["kind"]): BusinessPathSurface | undefined {
  if (["page", "ui-component", "ui-action", "auth-guard"].includes(kind)) return "page";
  if (["api-route", "handler", "service", "frontend-call", "external-integration"].includes(kind)) return "api";
  if (kind === "data-entity") return "data";
  if (kind === "background-task") return "background-task";
  return undefined;
}

function titleFor(entry: BusinessCapabilityNode) {
  if (entry.kind === "page") return `${display(entry.label)} 页面业务流程`;
  if (entry.kind === "api-route") return `${display(entry.label)} 接口业务流程`;
  if (entry.kind === "background-task") return `${display(entry.label)} 后台任务流程`;
  if (entry.kind === "data-entity") return `${display(entry.label)} 数据验证流程`;
  return `${display(entry.label)} 业务流程`;
}

function entryKey(entry: BusinessCapabilityNode) {
  if (entry.kind === "page") return `page:${entry.source?.file ?? entry.metadata?.route ?? entry.label}`;
  if (entry.kind === "api-route") return `api:${entry.metadata?.method ?? ""}:${entry.metadata?.route ?? entry.label.replace(/^[A-Z]+\s+/, "")}`;
  return `${entry.kind}:${entry.source?.file ?? entry.label}`;
}

function connectedNodeIds(graph: BusinessCapabilityGraph, entryId: string) {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const queue = [entryId];
  const visited = new Set<string>();
  while (queue.length && visited.size < 64) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of [...(outgoing.get(current) ?? []), ...(incoming.get(current) ?? [])]) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

function relevance(path: BusinessPath, goal: string) {
  const tokens = goal.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((token) => token.length >= 2);
  if (!tokens.length) return 0;
  const haystack = `${path.title} ${path.summary} ${path.reason}`.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

/**
 * Compile a connected, inspectable business-path inventory. Execution is
 * intentionally separate: a static path becomes executable only after the
 * runtime binder can attach real controls/API fixtures/oracles.
 */
export function compileBusinessPaths(input: {
  graph: BusinessCapabilityGraph;
  goal?: string;
  comprehensive: boolean;
  browserEnabled: boolean;
}) : BusinessPath[] {
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const entryKinds = new Set<BusinessCapabilityNode["kind"]>(["page", "api-route", "background-task", "data-entity"]);
  // The compatibility graph and the semantic scanner can both report the
  // same page/route. Use one canonical entry while retaining both nodes in
  // the compiled path's source set.
  const entries = [...new Map(input.graph.nodes
    .filter((node) => entryKinds.has(node.kind))
    .map((node) => [entryKey(node), node])).values()];
  const represented = new Set<string>();
  const paths: BusinessPath[] = [];
  const makePath = (entry: BusinessCapabilityNode, nodeIds: Set<string>) => {
    const nodes = [...nodeIds].flatMap((id) => nodesById.get(id) ? [nodesById.get(id)!] : []);
    const surfaces = [...new Set(nodes.flatMap((node) => {
      const surface = surfaceFor(node.kind);
      return surface ? [surface] : [];
    }))];
    const hasAuth = nodes.some((node) => node.kind === "auth-guard");
    const hasAction = nodes.some((node) => node.kind === "ui-action" || node.kind === "frontend-call" || node.kind === "api-route");
    const confidence = nodes.some((node) => node.confidence === "high") ? "high" : nodes.some((node) => node.confidence === "medium") ? "medium" : "low";
    const status: BusinessPathStatus = surfaces.includes("page") && input.browserEnabled
      ? "auto-bindable"
      : surfaces.some((surface) => surface === "api" || surface === "data" || surface === "background-task")
        ? "needs-input"
        : "coverage-gap";
    const actions = [
      ...(surfaces.includes("page") ? ["在真实页面绑定控件并执行核心交互"] : []),
      ...(surfaces.includes("api") ? ["调用已声明的 API operation 并验证响应"] : []),
      ...(surfaces.includes("data") ? ["使用只读数据断言或隔离 snapshot"] : []),
      ...(surfaces.includes("background-task") ? ["触发任务并等待声明的终态"] : [])
    ];
    const oracles = [
      ...(surfaces.includes("page") ? ["URL、DOM、控件状态或可见文本变化"] : []),
      ...(surfaces.includes("api") ? ["允许接口的状态码和响应摘要"] : []),
      ...(surfaces.includes("data") ? ["声明查询模板的结果变化"] : []),
      ...(surfaces.includes("background-task") ? ["后台任务进入声明终态"] : [])
    ];
    const tokens = new Set(nodes.flatMap(businessNodeTokens));
    const summary = `${surfaces.map((surface) => surface === "background-task" ? "后台任务" : surface === "data" ? "数据" : surface === "api" ? "接口" : "页面").join(" → ")}：${[...tokens].slice(0, 5).join("、") || display(entry.label)}`;
    const path: BusinessPath = {
      id: stableId(`${input.graph.projectSnapshotHash}:${entry.id}`),
      title: titleFor(entry),
      summary,
      status,
      confidence,
      risk: hasAuth || surfaces.includes("data") || surfaces.includes("background-task") ? "high" : "medium",
      surfaces,
      roles: hasAuth ? ["需要运行时确认角色/登录态"] : [],
      preconditions: [
        ...(surfaces.includes("page") ? ["项目页面可访问"] : []),
        ...(hasAuth ? ["测试账号或未登录场景"] : []),
        ...(surfaces.includes("api") && !surfaces.includes("page") ? ["API operation 与 fixture 已声明"] : []),
        ...(surfaces.includes("data") ? ["隔离数据源或只读 snapshot"] : [])
      ],
      actionCandidates: actions,
      oracleCandidates: oracles,
      requiredEvidenceKinds: [...new Set([
        ...(surfaces.includes("page") ? ["screenshot", "dom", "trace"] : []),
        ...(surfaces.includes("api") ? ["network", "operation-log"] : []),
        ...(surfaces.includes("data") ? ["operation-log"] : []),
        ...(surfaces.includes("background-task") ? ["operation-log", "network"] : [])
      ])],
      sourceNodeIds: nodes.map((node) => node.id),
      sourceLocations: nodes.flatMap((node) => node.source ? [node.source] : []),
      reason: hasAction
        ? `由 ${nodes.length} 个代码节点组成，入口、交互、接口和后续处理关系均保留可追溯来源；运行时会验证实际动作和 oracle。`
        : `已从代码中识别入口，但尚未形成安全的动作与 oracle 绑定。`
    };
    paths.push(path);
    nodes.forEach((node) => represented.add(node.id));
  };

  for (const entry of entries) makePath(entry, connectedNodeIds(input.graph, entry.id));
  for (const node of input.graph.nodes.filter((node) => surfaceFor(node.kind) && !represented.has(node.id))) {
    makePath(node, new Set([node.id]));
  }
  const unique = new Map(paths.map((path) => [path.id, path]));
  const values = [...unique.values()];
  if (input.comprehensive) return values.sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
  const relevant = values
    .map((path) => ({ path, score: relevance(path, input.goal ?? "") }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.path.title.localeCompare(right.path.title, "zh-CN"))
    .map(({ path }) => path);
  return relevant.length ? relevant : values.slice(0, 12);
}
