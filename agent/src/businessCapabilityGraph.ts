import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectManifest } from "@ai-test-officer/contracts";
import type { CodeGraphEdge, CodeGraphNode, CodeImpactGraph } from "./codeImpactGraph.js";
import { parseBusinessSource, parsePythonSourcesBatch, type ParsedBusinessFile } from "./businessParserAdapters.js";

export type BusinessCapabilityNodeKind =
  | "file"
  | "page"
  | "ui-component"
  | "ui-action"
  | "frontend-call"
  | "api-route"
  | "handler"
  | "service"
  | "data-entity"
  | "background-task"
  | "auth-guard"
  | "external-integration"
  | "test";

export type BusinessCapabilityEdgeKind =
  | "declares"
  | "renders"
  | "navigates"
  | "triggers"
  | "calls"
  | "handles"
  | "uses"
  | "reads"
  | "writes"
  | "enqueues"
  | "consumes"
  | "guards"
  | "asserts";

export interface BusinessSourceLocation {
  file: string;
  line?: number;
  parser: string;
  sourceHash: string;
}

export interface BusinessCapabilityNode {
  id: string;
  kind: BusinessCapabilityNodeKind;
  label: string;
  confidence: "high" | "medium" | "low";
  source?: BusinessSourceLocation;
  metadata?: Record<string, string>;
}

export interface BusinessCapabilityEdge {
  from: string;
  to: string;
  kind: BusinessCapabilityEdgeKind;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface BusinessCapabilityGraph {
  version: "2.0";
  createdAt: string;
  repositoryRoot: string;
  projectSnapshotHash: string;
  sourceFileCount: number;
  nodes: BusinessCapabilityNode[];
  edges: BusinessCapabilityEdge[];
  diagnostics: string[];
}

type SourceFile = { relative: string; source: string; sourceHash: string; parser: string };

const ignoredDirectories = new Set([
  ".git", ".next", ".nuxt", ".output", ".ai-test-officer", "node_modules", "dist", "build", "coverage", ".venv", "venv", "vendor"
]);
const sensitiveNames = /(^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials?\.(?:json|ya?ml))$/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|vue|svelte|py)$/i;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(kind: string, value: string) {
  return `bcg_${kind}_${hash(value).slice(0, 20)}`;
}

function lineOf(source: string, position: number) {
  return source.slice(0, Math.max(0, position)).split("\n").length;
}

function parserFor(file: string) {
  if (/\.vue$/i.test(file)) return "vue-template-script";
  if (/\.svelte$/i.test(file)) return "svelte-component";
  if (/\.py$/i.test(file)) return "python-ast-signals";
  if (/\.(?:tsx|jsx)$/i.test(file)) return "typescript-jsx";
  return "typescript";
}

function normalizedRoute(value: string) {
  return value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/(?:\$?\{[^}]+\}|:[A-Za-z0-9_{}-]+|\[[^\]]+\])/g, "/:param")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function displayName(value: string) {
  return value
    .replace(/\.(?:[cm]?[jt]sx?|vue|svelte|py)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .replace(/\b(?:index|page|route|view|component)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || value;
}

async function discoverSafeSourceFiles(root: string, directory = root, result: string[] = []): Promise<string[]> {
  if (result.length >= 5_000) return result;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      await discoverSafeSourceFiles(root, absolute, result);
    } else if (entry.isFile() && sourceExtension.test(entry.name) && !sensitiveNames.test(relative)) {
      result.push(relative);
    }
    if (result.length >= 5_000) break;
  }
  return result;
}

async function readSources(root: string) {
  const result: SourceFile[] = [];
  for (const relative of await discoverSafeSourceFiles(root)) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    if (!(await stat(absolute).catch(() => undefined))?.isFile()) continue;
    const source = await readFile(absolute, "utf8").catch(() => "");
    if (!source) continue;
    result.push({ relative, source, sourceHash: hash(source), parser: parserFor(relative) });
  }
  return result;
}

function mapLegacyKind(kind: CodeGraphNode["kind"]): BusinessCapabilityNodeKind {
  if (kind === "file") return "file";
  if (kind === "page") return "page";
  if (kind === "frontend-call") return "frontend-call";
  if (kind === "api-route") return "api-route";
  if (kind === "historical-bug") return "test";
  return "ui-component";
}

function mapLegacyEdge(kind: CodeGraphEdge["kind"]): BusinessCapabilityEdgeKind {
  if (kind === "renders") return "renders";
  if (kind === "calls") return "calls";
  if (kind === "serves") return "handles";
  if (kind === "covered-by" || kind === "regressed-by") return "asserts";
  return "declares";
}

function capabilityToken(node: BusinessCapabilityNode) {
  const route = node.metadata?.route;
  const raw = `${route ?? ""} ${node.label} ${node.source?.file ?? ""}`.toLowerCase();
  return raw
    .replace(/\b(?:src|app|pages|page|components|component|routes|route|api|server|client|index|service|handler)\b/g, " ")
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter((token) => token.length >= 3 && !/^(get|post|put|patch|delete|fetch|axios|async|function)$/.test(token));
}

function addNode(nodes: Map<string, BusinessCapabilityNode>, node: BusinessCapabilityNode) {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
  return node.id;
}

function addEdge(edges: Map<string, BusinessCapabilityEdge>, edge: BusinessCapabilityEdge) {
  if (edge.from === edge.to) return;
  const key = `${edge.from}:${edge.to}:${edge.kind}`;
  if (!edges.has(key)) edges.set(key, edge);
}

function nodeFromSource(input: {
  kind: BusinessCapabilityNodeKind;
  label: string;
  file: SourceFile;
  position: number;
  confidence?: BusinessCapabilityNode["confidence"];
  metadata?: Record<string, string>;
}) {
  const line = lineOf(input.file.source, input.position);
  return {
    id: stableId(input.kind, `${input.file.relative}:${line}:${input.label}`),
    kind: input.kind,
    label: input.label,
    confidence: input.confidence ?? "medium",
    source: { file: input.file.relative, line, parser: input.file.parser, sourceHash: input.file.sourceHash },
    metadata: input.metadata
  } satisfies BusinessCapabilityNode;
}

function firstMatchPosition(source: string, match: RegExpExecArray) {
  return match.index ?? source.indexOf(match[0]);
}

async function scanSourceFile(
  file: SourceFile,
  nodes: Map<string, BusinessCapabilityNode>,
  edges: Map<string, BusinessCapabilityEdge>,
  diagnostics: string[],
  preParsed?: ParsedBusinessFile
) {
  const fileNodeId = addNode(nodes, {
    id: stableId("file", file.relative),
    kind: "file",
    label: file.relative,
    confidence: "high",
    source: { file: file.relative, line: 1, parser: file.parser, sourceHash: file.sourceHash }
  });
  const parsed = preParsed ?? await parseBusinessSource(file);
  diagnostics.push(...parsed.diagnostics.map((diagnostic) => `${file.relative}: ${diagnostic}`));
  const keys = new Map<string, string>();
  const addLocal = (key: string, node: BusinessCapabilityNode) => {
    const nodeId = addNode(nodes, node);
    keys.set(key, nodeId);
    addEdge(edges, { from: fileNodeId, to: nodeId, kind: "declares", confidence: node.confidence, reason: `${file.relative} declares ${node.kind} ${node.label}.` });
    return nodeId;
  };
  for (const fact of parsed.facts) {
    addLocal(fact.key, {
      id: stableId(fact.kind, `${file.relative}:${fact.line}:${fact.label}`),
      kind: fact.kind,
      label: fact.label,
      confidence: fact.confidence,
      source: { file: file.relative, line: fact.line, parser: parsed.adapter, sourceHash: file.sourceHash },
      metadata: fact.metadata
    });
  }
  for (const relation of parsed.relations) {
    const from = keys.get(relation.from);
    const to = keys.get(relation.to);
    if (from && to) addEdge(edges, { ...relation, from, to });
  }
}

/**
 * Build the semantic, versioned layer used for business-path planning.  It is
 * deliberately additive: CodeImpactGraph remains the compatibility graph for
 * older intake/benchmark consumers.
 */
export async function buildBusinessCapabilityGraph(input: {
  repositoryRoot: string;
  codeGraph: CodeImpactGraph;
  manifest?: ProjectManifest;
}) : Promise<BusinessCapabilityGraph> {
  const root = path.resolve(input.repositoryRoot);
  const nodes = new Map<string, BusinessCapabilityNode>();
  const edges = new Map<string, BusinessCapabilityEdge>();
  const diagnostics: string[] = [];
  const sources = await readSources(root);
  const sourceByFile = new Map(sources.map((file) => [file.relative, file]));

  const legacyMapping = new Map<string, string>();
  for (const legacy of input.codeGraph.nodes) {
    const source = legacy.file ? sourceByFile.get(legacy.file) : undefined;
    const mappedKind = mapLegacyKind(legacy.kind);
    const node: BusinessCapabilityNode = {
      id: stableId("legacy", legacy.id),
      kind: mappedKind,
      label: legacy.label,
      confidence: legacy.confidence,
      source: source && legacy.file ? { file: legacy.file, line: legacy.line, parser: source.parser, sourceHash: source.sourceHash } : undefined,
      // Router-declared pages carry their route as the label; preserving it as
      // metadata lets the path compiler dedupe them with scanner-found pages.
      ...(mappedKind === "page" && legacy.label.startsWith("/") ? { metadata: { route: legacy.label } } : {})
    };
    legacyMapping.set(legacy.id, addNode(nodes, node));
  }
  for (const edge of input.codeGraph.edges) {
    const from = legacyMapping.get(edge.from);
    const to = legacyMapping.get(edge.to);
    if (from && to) addEdge(edges, { from, to, kind: mapLegacyEdge(edge.kind), confidence: "high", reason: edge.reason });
  }
  // Python files are parsed in one batched AST process (see parser adapters);
  // the remaining adapters are CPU-local. A small pool keeps large
  // repositories from scanning strictly file-by-file while shared map writes
  // stay synchronous and race-free.
  const pythonParsed = await parsePythonSourcesBatch(sources.filter((file) => /\.py$/i.test(file.relative)));
  const scanQueue = [...sources];
  const scanWorkers = Array.from({ length: Math.min(8, scanQueue.length) }, async () => {
    for (let source = scanQueue.shift(); source; source = scanQueue.shift()) {
      await scanSourceFile(source, nodes, edges, diagnostics, pythonParsed.get(source.relative));
    }
  });
  await Promise.all(scanWorkers);

  // Index API routes by normalized route once. Matching every frontend call
  // against every route used to be O(calls x routes) string normalization —
  // the single hottest loop on backend-heavy uploads.
  const apiRoutesByNormalized = new Map<string, BusinessCapabilityNode[]>();
  for (const node of nodes.values()) {
    if (node.kind !== "api-route") continue;
    const key = normalizedRoute(node.metadata?.route ?? node.label.replace(/^[A-Z]+\s+/, ""));
    apiRoutesByNormalized.set(key, [...(apiRoutesByNormalized.get(key) ?? []), node]);
  }
  for (const call of nodes.values()) {
    if (call.kind !== "frontend-call") continue;
    const route = call.metadata?.route ?? call.label;
    for (const endpoint of apiRoutesByNormalized.get(normalizedRoute(route)) ?? []) {
      addEdge(edges, { from: call.id, to: endpoint.id, kind: "calls", confidence: "high", reason: `前端请求 ${route} 与后端路由 ${endpoint.metadata?.route ?? endpoint.label} 的规范化路径一致。` });
    }
  }
  for (const operation of input.manifest?.apiOperations ?? []) {
    const operationNode = addNode(nodes, {
      id: stableId("manifest-api", operation.operationId),
      kind: "api-route",
      label: `${operation.method} ${operation.pathTemplate}`,
      confidence: "high",
      metadata: { route: operation.pathTemplate, method: operation.method, operationId: operation.operationId }
    });
    for (const route of apiRoutesByNormalized.get(normalizedRoute(operation.pathTemplate)) ?? []) {
      addEdge(edges, { from: route.id, to: operationNode, kind: "asserts", confidence: "high", reason: `Manifest OpenAPI operation ${operation.operationId} confirms the route contract.` });
    }
  }
  for (const task of input.manifest?.backgroundTasks ?? []) {
    addNode(nodes, { id: stableId("manifest-task", task.id), kind: "background-task", label: task.id, confidence: "high", metadata: { statusOperationId: task.statusOperationId } });
  }
  for (const data of input.manifest?.dataSources ?? []) {
    addNode(nodes, { id: stableId("manifest-data", data.id), kind: "data-entity", label: data.id, confidence: "high", metadata: { readOnly: String(data.readOnly) } });
  }
  const snapshot = hash(JSON.stringify({ files: sources.map((source) => [source.relative, source.sourceHash]), manifest: input.manifest?.workspaceRoot ?? "" }));
  if (!sources.length) diagnostics.push("没有可安全索引的源码文件；仅保留兼容代码图节点。");
  if (sources.length >= 5_000) diagnostics.push("源码索引达到安全上限；未索引的文件将作为未知边界保留。");
  return {
    version: "2.0",
    createdAt: new Date().toISOString(),
    repositoryRoot: root,
    projectSnapshotHash: snapshot,
    sourceFileCount: sources.length,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    diagnostics
  };
}

export function businessNodeTokens(node: BusinessCapabilityNode) {
  return capabilityToken(node);
}

/** Read only the source slices already referenced by an auditable path. This
 * is the safe repository-wide retrieval boundary for planning LLM calls: it
 * never walks arbitrary paths and it never returns secret/config files. */
export async function readBusinessSourceSlices(input: {
  repositoryRoot: string;
  locations: BusinessSourceLocation[];
  maxFiles?: number;
  maxChars?: number;
}) {
  const root = path.resolve(input.repositoryRoot);
  const maxFiles = input.maxFiles ?? 12;
  const maxChars = input.maxChars ?? 18_000;
  const locations = [...new Map(input.locations.map((location) => [`${location.file}:${location.line ?? 0}`, location])).values()]
    .filter((location) => sourceExtension.test(location.file) && !sensitiveNames.test(location.file))
    .slice(0, maxFiles);
  let remaining = maxChars;
  const slices: Array<{ file: string; line?: number; sourceHash: string; content: string }> = [];
  for (const location of locations) {
    const absolute = path.resolve(root, location.file);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    const source = await readFile(absolute, "utf8").catch(() => "");
    if (!source) continue;
    const lines = source.split("\n");
    const line = location.line ?? 1;
    const start = Math.max(0, line - 18);
    const end = Math.min(lines.length, line + 42);
    const content = lines.slice(start, end).join("\n").slice(0, remaining);
    if (!content) break;
    remaining -= content.length;
    slices.push({ file: location.file, line, sourceHash: location.sourceHash, content });
    if (remaining <= 0) break;
  }
  return slices;
}
