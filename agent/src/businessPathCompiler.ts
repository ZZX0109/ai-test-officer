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

function normalizedRoute(value: string) {
  return value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/(?:\$?\{[^}]+\}|:[A-Za-z0-9_{}-]+|\[[^\]]+\])/g, "/:param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase() || "/";
}

function entryKey(entry: BusinessCapabilityNode) {
  // The same route is re-discovered by every file that navigates to it. The
  // route — not the discovering file — is the business entry identity,
  // otherwise one real page becomes one pseudo path per referencing file.
  if (entry.kind === "page") return `page:${normalizedRoute(entry.metadata?.route ?? entry.source?.file ?? entry.label)}`;
  if (entry.kind === "api-route") return `api:${(entry.metadata?.method ?? "").toUpperCase()}:${normalizedRoute(entry.metadata?.route ?? entry.label.replace(/^[A-Z]+\s+/, ""))}`;
  return `${entry.kind}:${entry.source?.file ?? entry.label}`;
}

interface GraphAdjacency {
  outgoing: Map<string, string[]>;
  guarding: Map<string, string[]>;
}

/**
 * Follow only outgoing edges (entry → interaction → call → route → handler).
 * Incoming expansion is what used to glue every page onto shared components,
 * credential definitions and route params, turning one API node into a fake
 * "接口 → 页面" business flow per referrer. The single exception is `guards`:
 * a guard points at the route it protects, so the route's flow legitimately
 * includes its authentication boundary.
 */
function buildAdjacency(graph: BusinessCapabilityGraph): GraphAdjacency {
  const outgoing = new Map<string, string[]>();
  const guarding = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    if (edge.kind === "guards") guarding.set(edge.to, [...(guarding.get(edge.to) ?? []), edge.from]);
  }
  return { outgoing, guarding };
}

function connectedNodeIds(adjacency: GraphAdjacency, entryId: string, limit = 64) {
  const queue = [entryId];
  const visited = new Set<string>();
  while (queue.length && visited.size < limit) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of [...(adjacency.outgoing.get(current) ?? []), ...(adjacency.guarding.get(current) ?? [])]) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

function apiGroupKey(node: BusinessCapabilityNode) {
  const route = normalizedRoute(node.metadata?.route ?? node.label.replace(/^[A-Z]+\s+/, ""));
  const parts = route.split("/").filter(Boolean).filter((part) => !/^v\d+$/i.test(part) && part !== ":param");
  return parts.slice(0, 2).join("/") || "root";
}

/** Prefer the declaration page (the routed file) over navigation re-discoveries. */
function preferredPageEntry(current: BusinessCapabilityNode, candidate: BusinessCapabilityNode) {
  const score = (node: BusinessCapabilityNode) =>
    (/(^|\/)(pages?|views?|app)\//i.test(node.source?.file ?? "") ? 2 : 0)
    + (node.confidence === "high" ? 1 : 0);
  return score(candidate) > score(current) ? candidate : current;
}

/**
 * A page node only represents a user-testable business entry when it is a
 * routed/declared surface — not a shared component file that the convention
 * scanner optimistically tagged as a page.
 */
function isUserFacingPage(node: BusinessCapabilityNode) {
  if (node.metadata?.route) return true;
  const file = node.source?.file ?? "";
  return /(^|\/)(pages?|views?|app)\//i.test(file)
    || /(?:^|\/)(?:App|main|index)\.[cm]?[jt]sx$/i.test(file)
    || node.metadata?.entry === "spa";
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
 *
 * Entry discipline: a user-testable business function starts at a real page
 * (or, for API-only projects, at an API surface group). API routes, data
 * entities, credential definitions and route params are folded INTO the page
 * flows that exercise them — they never become standalone pseudo flows.
 */
export function compileBusinessPaths(input: {
  graph: BusinessCapabilityGraph;
  goal?: string;
  comprehensive: boolean;
  browserEnabled: boolean;
}) : BusinessPath[] {
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(input.graph);
  // The compatibility graph and the semantic scanner can both report the
  // same page/route. Use one canonical entry while retaining both nodes in
  // the compiled path's source set.
  const pageEntryMap = new Map<string, BusinessCapabilityNode>();
  const allPages = input.graph.nodes.filter((item) => item.kind === "page");
  const userFacingPages = allPages.filter(isUserFacingPage);
  // Unconventional projects may have only convention-tagged pages; never let
  // the facing-page filter erase the whole inventory.
  const entryPages = userFacingPages.length ? userFacingPages : allPages;
  for (const node of entryPages) {
    const key = entryKey(node);
    const existing = pageEntryMap.get(key);
    pageEntryMap.set(key, existing ? preferredPageEntry(existing, node) : node);
  }
  const pageEntries = [...pageEntryMap.values()];
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

  if (pageEntries.length) {
    // Page-first inventory: every real page becomes one auditable business
    // flow, carrying the controls, calls, routes and handlers it reaches.
    for (const entry of pageEntries) makePath(entry, connectedNodeIds(adjacency, entry.id));

    // Backend surface not exercised by any page stays auditable, but grouped
    // by API prefix — one row per resource group, never one pseudo flow per
    // internal route. Owner-less frontend calls join the same groups.
    const orphanRoutes = input.graph.nodes.filter((node) =>
      (node.kind === "api-route" || node.kind === "frontend-call") && !represented.has(node.id));
    const routeGroups = new Map<string, BusinessCapabilityNode[]>();
    for (const node of orphanRoutes) {
      const key = apiGroupKey(node);
      routeGroups.set(key, [...(routeGroups.get(key) ?? []), node]);
    }
    for (const [group, members] of [...routeGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nodeIds = new Set<string>();
      for (const member of members) {
        for (const id of connectedNodeIds(adjacency, member.id, 24)) nodeIds.add(id);
      }
      const synthetic: BusinessCapabilityNode = {
        id: stableId(`api-group:${group}`),
        kind: "api-route",
        label: `${group} 接口组（${members.length} 个操作）`,
        confidence: members.some((node) => node.confidence === "high") ? "high" : "medium",
        source: members[0]?.source
      };
      makePath(synthetic, nodeIds);
    }

    // Background tasks are user-relevant when nothing else triggers them.
    const taskGroups = new Map<string, BusinessCapabilityNode[]>();
    for (const node of input.graph.nodes.filter((item) => item.kind === "background-task" && !represented.has(item.id))) {
      taskGroups.set(node.label, [...(taskGroups.get(node.label) ?? []), node]);
    }
    for (const members of taskGroups.values()) {
      makePath(members[0]!, new Set(members.map((node) => node.id)));
    }

    // Data entities alone are verification targets, not business entries.
    const orphanData = input.graph.nodes.filter((node) => node.kind === "data-entity" && !represented.has(node.id));
    if (orphanData.length) {
      const synthetic: BusinessCapabilityNode = {
        id: stableId("data-group:all"),
        kind: "data-entity",
        label: `数据实体（${orphanData.length} 项）`,
        confidence: "medium",
        source: orphanData[0]?.source
      };
      makePath(synthetic, new Set(orphanData.map((node) => node.id)));
    }
  } else {
    // API-only project: the API surface IS the business inventory. Group by
    // resource prefix so large backends stay reviewable.
    const routeGroups = new Map<string, BusinessCapabilityNode[]>();
    for (const node of input.graph.nodes.filter((item) => item.kind === "api-route")) {
      const key = apiGroupKey(node);
      routeGroups.set(key, [...(routeGroups.get(key) ?? []), node]);
    }
    for (const [group, members] of [...routeGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const nodeIds = new Set<string>();
      for (const member of members) {
        for (const id of connectedNodeIds(adjacency, member.id)) nodeIds.add(id);
      }
      const synthetic: BusinessCapabilityNode = {
        id: stableId(`api-group:${group}`),
        kind: "api-route",
        label: `${group} 接口组（${members.length} 个操作）`,
        confidence: members.some((node) => node.confidence === "high") ? "high" : "medium",
        source: members[0]?.source
      };
      makePath(synthetic, nodeIds);
    }
    for (const node of input.graph.nodes.filter((item) => item.kind === "background-task" && !represented.has(item.id))) {
      makePath(node, new Set([node.id]));
    }
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
