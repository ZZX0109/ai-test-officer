import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type CodeGraphNodeKind = "file" | "symbol" | "api-route" | "frontend-call" | "page" | "scenario" | "historical-bug";
export interface CodeGraphNode { id: string; kind: CodeGraphNodeKind; label: string; file?: string; line?: number; confidence: "high" | "medium" | "low" }
export interface CodeGraphEdge { from: string; to: string; kind: "exports" | "serves" | "calls" | "renders" | "covered-by" | "regressed-by"; reason: string }
export interface CodeImpactGraph { version: "1.0"; createdAt: string; repositoryRoot: string; nodes: CodeGraphNode[]; edges: CodeGraphEdge[]; explanations: string[]; cacheHits: number }

interface CachedFile { sha256: string; nodes: CodeGraphNode[]; edges: CodeGraphEdge[] }
interface GraphCache { files: Record<string, CachedFile> }

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function id(kind: string, value: string) { return `${kind}_${digest(value).slice(0, 16)}`; }

function lineOf(source: ts.SourceFile, node: ts.Node) { return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1; }

function normalizedApiPath(value: string) {
  return value.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "").replace(/\/:?[A-Za-z0-9_{}-]+/g, "/:param").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

async function discoverSourceFiles(root: string, directory = root, found: string[] = []): Promise<string[]> {
  if (found.length >= 1_000) return found;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "build", "coverage", ".ai-test-officer"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await discoverSourceFiles(root, absolute, found);
    else if (entry.isFile() && /\.(?:tsx?|jsx?|py)$/.test(entry.name)) found.push(path.relative(root, absolute));
    if (found.length >= 1_000) break;
  }
  return found;
}

function indexTypeScript(file: string, relative: string, sourceText: string): CachedFile {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const fileId = id("file", relative);
  const nodes: CodeGraphNode[] = [{ id: fileId, kind: "file", label: relative, file: relative, confidence: "high" }];
  const edges: CodeGraphEdge[] = [];
  const addSymbol = (name: string, node: ts.Node) => {
    const symbolId = id("symbol", `${relative}:${name}`);
    nodes.push({ id: symbolId, kind: "symbol", label: name, file: relative, line: lineOf(source, node), confidence: "high" });
    edges.push({ from: fileId, to: symbolId, kind: "exports", reason: `${relative} declares ${name}` });
    return symbolId;
  };
  const visit = (node: ts.Node, owner = fileId) => {
    let nextOwner = owner;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) nextOwner = addSymbol(node.name.text, node);
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) nextOwner = addSymbol(declaration.name.text, declaration);
      }
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const target = node.arguments[0].text;
      const expression = node.expression.getText(source);
      if (/\.(get|post|put|patch|delete|use)$/.test(expression) && target.startsWith("/")) {
        const routeId = id("api", target);
        if (!nodes.some((item) => item.id === routeId)) nodes.push({ id: routeId, kind: "api-route", label: target, file: relative, line: lineOf(source, node), confidence: "high" });
        edges.push({ from: nextOwner, to: routeId, kind: "serves", reason: `${expression} registers ${target}` });
      }
      if (/^(fetch|axios\.|api\.)/.test(expression) && target.includes("/")) {
        const callId = id("call", target);
        if (!nodes.some((item) => item.id === callId)) nodes.push({ id: callId, kind: "frontend-call", label: target, file: relative, line: lineOf(source, node), confidence: "high" });
        edges.push({ from: nextOwner, to: callId, kind: "calls", reason: `${expression} calls ${target}` });
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextOwner));
  };
  visit(source);
  if (/(^|\/)(pages|routes|app)\//.test(relative)) {
    const pageId = id("page", relative);
    nodes.push({ id: pageId, kind: "page", label: relative.replace(/\.(tsx?|jsx?)$/, ""), file: relative, confidence: "medium" });
    edges.push({ from: fileId, to: pageId, kind: "renders", reason: "File path matches a page/router convention." });
  }
  return { sha256: digest(sourceText), nodes, edges };
}

async function indexPython(script: string, root: string, files: string[]) {
  return new Promise<Record<string, CachedFile>>((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? "python3", [script, root, ...files], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`python_ast_failed:${stderr.slice(0, 500)}`));
      try { resolve(JSON.parse(stdout) as Record<string, CachedFile>); } catch { reject(new Error("python_ast_invalid_json")); }
    });
  });
}

export async function buildCodeImpactGraph(input: { repositoryRoot: string; files: string[]; cacheFile?: string; includeRepositorySources?: boolean; scenarios?: Array<{ id: string; keywords: string[] }>; historicalBugs?: Array<{ id: string; title: string; files: string[] }> }): Promise<CodeImpactGraph> {
  const root = path.resolve(input.repositoryRoot);
  const cacheFile = input.cacheFile ?? path.join(root, ".ai-test-officer", "impact-cache.json");
  const cache: GraphCache = await readFile(cacheFile, "utf8").then((raw) => JSON.parse(raw) as GraphCache).catch(() => ({ files: {} }));
  const nextCache: GraphCache = { files: { ...cache.files } };
  let cacheHits = 0;
  const pythonFiles: string[] = [];
  const indexedFiles = Array.from(new Set(input.includeRepositorySources ? [...input.files, ...await discoverSourceFiles(root)] : input.files)).sort();
  for (const relative of indexedFiles) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`impact_path_escape:${relative}`);
    if (!(await stat(absolute).catch(() => undefined))?.isFile()) continue;
    const source = await readFile(absolute, "utf8");
    const sha256 = digest(source);
    if (cache.files[relative]?.sha256 === sha256) { cacheHits += 1; continue; }
    if (/\.tsx?$/.test(relative)) nextCache.files[relative] = indexTypeScript(absolute, relative, source);
    else if (/\.py$/.test(relative)) pythonFiles.push(relative);
  }
  if (pythonFiles.length) {
    const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/python_ast_index.py");
    Object.assign(nextCache.files, await indexPython(script, root, pythonFiles));
  }
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(nextCache, null, 2));
  const selected = indexedFiles.flatMap((file) => nextCache.files[file] ? [nextCache.files[file]] : []);
  const nodes = selected.flatMap((item) => item.nodes);
  const edges = selected.flatMap((item) => item.edges);
  const fileNodes = nodes.filter((node) => node.kind === "file");
  const apiRoutes = nodes.filter((node) => node.kind === "api-route");
  const frontendCalls = nodes.filter((node) => node.kind === "frontend-call");
  const pages = nodes.filter((node) => node.kind === "page");
  for (const call of frontendCalls) {
    for (const route of apiRoutes.filter((candidate) => normalizedApiPath(candidate.label) === normalizedApiPath(call.label))) {
      edges.push({ from: call.id, to: route.id, kind: "calls", reason: `Frontend call ${call.label} resolves to API route ${route.label}.` });
    }
    for (const page of pages.filter((candidate) => candidate.file === call.file)) {
      edges.push({ from: page.id, to: call.id, kind: "renders", reason: `Page ${page.label} contains frontend call ${call.label}.` });
    }
  }
  for (const scenario of input.scenarios ?? []) {
    const matches = nodes.filter((node) => scenario.keywords.some((keyword) => node.label.toLowerCase().includes(keyword.toLowerCase())));
    if (!matches.length) continue;
    const scenarioId = id("scenario", scenario.id);
    nodes.push({ id: scenarioId, kind: "scenario", label: scenario.id, confidence: "medium" });
    matches.forEach((node) => edges.push({ from: node.id, to: scenarioId, kind: "covered-by", reason: `Matched scenario keyword for ${scenario.id}.` }));
  }
  for (const bug of input.historicalBugs ?? []) {
    const bugId = id("bug", bug.id);
    nodes.push({ id: bugId, kind: "historical-bug", label: bug.title, confidence: "high" });
    fileNodes.filter((node) => node.file && bug.files.includes(node.file)).forEach((node) => edges.push({ from: node.id, to: bugId, kind: "regressed-by", reason: `Historical bug ${bug.id} touched ${node.file}.` }));
  }
  const explanations = edges.filter((edge) => ["serves", "calls", "covered-by", "regressed-by"].includes(edge.kind)).map((edge) => edge.reason);
  return { version: "1.0", createdAt: new Date().toISOString(), repositoryRoot: root, nodes, edges, explanations, cacheHits };
}
