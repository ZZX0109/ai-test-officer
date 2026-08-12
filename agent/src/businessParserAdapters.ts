import { spawn } from "node:child_process";
import ts from "typescript";
import type { BusinessCapabilityEdgeKind, BusinessCapabilityNodeKind } from "./businessCapabilityGraph.js";

export interface ParserSourceFile {
  relative: string;
  source: string;
  sourceHash: string;
  parser: string;
}

export interface ParsedBusinessFact {
  key: string;
  kind: BusinessCapabilityNodeKind;
  label: string;
  line: number;
  confidence: "high" | "medium" | "low";
  metadata?: Record<string, string>;
}

export interface ParsedBusinessRelation {
  from: string;
  to: string;
  kind: BusinessCapabilityEdgeKind;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ParsedBusinessFile {
  adapter: string;
  facts: ParsedBusinessFact[];
  relations: ParsedBusinessRelation[];
  diagnostics: string[];
}

const requestMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const authNames = new Set(["requireauth", "requirelogin", "authenticate", "authorization", "protectedroute", "authguard", "useauth", "isauthenticated", "permission", "role"]);

function normaliseRoute(value: string) {
  return value.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "")
    .replace(/\/(?:\$?\{[^}]+\}|:[A-Za-z0-9_{}-]+|\[[^\]]+\])/g, "/:param")
    .replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function lineAt(source: ts.SourceFile, node: ts.Node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function textOfArgument(node: ts.Expression | undefined) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function propertyName(node: ts.Expression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

function isComponentName(name: string) { return /^[A-Z]/.test(name); }
function classifiedFunction(name: string): BusinessCapabilityNodeKind {
  const lower = name.toLowerCase();
  if (/(handler|controller|route)/.test(lower)) return "handler";
  if (/(service|repository|use[A-Z])/.test(name)) return "service";
  return isComponentName(name) ? "ui-component" : "ui-action";
}

function routeFromConvention(relative: string) {
  const clean = relative.replaceAll("\\", "/").replace(/\.(?:[cm]?[jt]sx?|vue)$/i, "");
  const nextPages = clean.match(/(?:^|\/)pages\/(.+)$/i);
  const nextApp = clean.match(/(?:^|\/)app\/(.+?)\/page$/i);
  const generic = clean.match(/(?:^|\/)(?:views?|routes?)\/(.+)$/i);
  const candidate = nextPages?.[1] ?? nextApp?.[1] ?? generic?.[1];
  if (!candidate) return undefined;
  const path = candidate.replace(/\/index$/i, "").replace(/\[(?:\.\.\.)?([^\]]+)\]/g, ":$1");
  return normaliseRoute(`/${path}`);
}

function parseVueTemplate(template: string, sourceOffset: number, source: ts.SourceFile, add: (fact: ParsedBusinessFact) => void) {
  // A small structural SFC parser: it tokenises start tags and attributes
  // rather than relying on broad source-text regex signals.
  let cursor = 0;
  while (cursor < template.length) {
    const start = template.indexOf("<", cursor);
    if (start < 0) break;
    const end = template.indexOf(">", start + 1);
    if (end < 0) break;
    const tag = template.slice(start + 1, end).trim();
    cursor = end + 1;
    if (!tag || tag.startsWith("/") || tag.startsWith("!")) continue;
    const tagNameEnd = tag.search(/[\s/]/);
    const tagName = tagNameEnd < 0 ? tag : tag.slice(0, tagNameEnd);
    let attrCursor = Math.max(0, tagNameEnd);
    while (attrCursor < tag.length) {
      while (/\s/.test(tag[attrCursor] ?? "")) attrCursor += 1;
      const nameStart = attrCursor;
      while (/[\w:@.-]/.test(tag[attrCursor] ?? "")) attrCursor += 1;
      const name = tag.slice(nameStart, attrCursor);
      if (!name) { attrCursor += 1; continue; }
      while (/\s/.test(tag[attrCursor] ?? "")) attrCursor += 1;
      let value = "";
      if (tag[attrCursor] === "=") {
        attrCursor += 1;
        while (/\s/.test(tag[attrCursor] ?? "")) attrCursor += 1;
        const quote = tag[attrCursor];
        if (quote === "\"" || quote === "'") {
          attrCursor += 1;
          const valueStart = attrCursor;
          const valueEnd = tag.indexOf(quote, valueStart);
          value = tag.slice(valueStart, valueEnd < 0 ? tag.length : valueEnd);
          attrCursor = valueEnd < 0 ? tag.length : valueEnd + 1;
        }
      }
      if (name === "@click" || name === "v-on:click" || name === "@submit" || name === "v-on:submit") {
        const position = sourceOffset + start + nameStart;
        add({
          key: `action:${position}:${value || tagName}`,
          kind: "ui-action",
          label: value || `${tagName} ${name}`,
          line: source.getLineAndCharacterOfPosition(position).line + 1,
          confidence: value ? "high" : "medium",
          metadata: { event: name.includes("submit") ? "submit" : "click", framework: "vue" }
        });
      }
    }
  }
}

function extractVueSections(source: string) {
  const lower = source.toLowerCase();
  const templateStart = lower.indexOf("<template");
  const templateContentStart = templateStart < 0 ? -1 : source.indexOf(">", templateStart) + 1;
  const templateEnd = templateContentStart < 0 ? -1 : lower.indexOf("</template>", templateContentStart);
  const scriptStart = lower.indexOf("<script");
  const scriptContentStart = scriptStart < 0 ? -1 : source.indexOf(">", scriptStart) + 1;
  const scriptEnd = scriptContentStart < 0 ? -1 : lower.indexOf("</script>", scriptContentStart);
  return {
    template: templateContentStart > 0 && templateEnd >= templateContentStart ? source.slice(templateContentStart, templateEnd) : "",
    templateOffset: Math.max(0, templateContentStart),
    script: scriptContentStart > 0 && scriptEnd >= scriptContentStart ? source.slice(scriptContentStart, scriptEnd) : source,
    scriptOffset: Math.max(0, scriptContentStart)
  };
}

function parseTypeScriptFile(file: ParserSourceFile, framework: "react" | "next" | "vue" | "typescript"): ParsedBusinessFile {
  const sections = framework === "vue" ? extractVueSections(file.source) : { template: "", templateOffset: 0, script: file.source, scriptOffset: 0 };
  const source = ts.createSourceFile(file.relative, sections.script, ts.ScriptTarget.Latest, true,
    /\.tsx?$|\.jsx?$/.test(file.relative) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts: ParsedBusinessFact[] = [];
  const relations: ParsedBusinessRelation[] = [];
  const byKey = new Map<string, ParsedBusinessFact>();
  const add = (fact: ParsedBusinessFact) => { if (!byKey.has(fact.key)) { byKey.set(fact.key, fact); facts.push(fact); } return fact.key; };
  const sourceLine = (node: ts.Node) => lineAt(source, node) + (sections.scriptOffset ? file.source.slice(0, sections.scriptOffset).split("\n").length - 1 : 0);
  const componentKeys: string[] = [];
  const actionKeys = new Map<string, string>();
  const callKeys: Array<{ key: string; owner?: string }> = [];
  const functionStack: string[] = [];
  const conventionRoute = routeFromConvention(file.relative);
  if (conventionRoute) add({ key: `page:route:${conventionRoute}`, kind: "page", label: conventionRoute, line: 1, confidence: "high", metadata: { route: conventionRoute, framework } });
  else if (/(^|\/)(?:views?|components?)\//i.test(file.relative) || /(?:^|\/)App\.[cm]?[jt]sx?$/i.test(file.relative)) {
    add({ key: "page:convention", kind: "page", label: file.relative, line: 1, confidence: "medium", metadata: { framework } });
  }
  const addFunction = (name: string, node: ts.Node) => {
    const kind = classifiedFunction(name);
    const key = `fn:${name}:${node.pos}`;
    add({ key, kind, label: name, line: sourceLine(node), confidence: kind === "ui-action" ? "medium" : "high", metadata: { framework } });
    if (kind === "ui-component") componentKeys.push(key);
    if (kind === "ui-action") actionKeys.set(name, key);
    return key;
  };
  const visit = (node: ts.Node) => {
    let entered: string | undefined;
    if (ts.isFunctionDeclaration(node) && node.name) entered = addFunction(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      entered = addFunction(node.name.text, node);
    }
    if (entered) functionStack.push(entered);
    if (ts.isJsxAttribute(node)) {
      const event = node.name.getText(source);
      if (["onClick", "onSubmit", "onChange"].includes(event)) {
        const expression = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : undefined;
        const label = expression && ts.isIdentifier(expression) ? expression.text : event;
        const key = add({ key: `jsx-action:${node.pos}`, kind: "ui-action", label, line: sourceLine(node), confidence: expression ? "high" : "medium", metadata: { event: event.slice(2).toLowerCase(), framework } });
        const handler = actionKeys.get(label);
        if (handler) relations.push({ from: key, to: handler, kind: "triggers", confidence: "high", reason: `JSX ${event} 绑定到 ${label}。` });
      }
      if (event === "href" && node.initializer && ts.isStringLiteral(node.initializer)) {
        const route = normaliseRoute(node.initializer.text);
        add({ key: `page:navigation:${node.pos}`, kind: "page", label: route, line: sourceLine(node), confidence: "high", metadata: { route, framework } });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = propertyName(callee);
      const receiver = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
      const routeValue = textOfArgument(node.arguments[0]);
      const owner = functionStack[functionStack.length - 1];
      if ((ts.isIdentifier(callee) && callee.text === "fetch") || (receiver && ["axios", "api", "client"].includes(receiver) && method && requestMethods.has(method.toLowerCase()))) {
        if (routeValue) {
          const route = normaliseRoute(routeValue);
          const key = add({ key: `request:${node.pos}`, kind: "frontend-call", label: route, line: sourceLine(node), confidence: "high", metadata: { route, method: ts.isIdentifier(callee) ? "GET" : method!.toUpperCase(), framework } });
          callKeys.push({ key, owner });
        }
      }
      if (receiver && ["app", "router"].includes(receiver) && method && requestMethods.has(method.toLowerCase()) && routeValue) {
        const route = normaliseRoute(routeValue);
        const key = add({ key: `route:${node.pos}`, kind: "api-route", label: `${method.toUpperCase()} ${route}`, line: sourceLine(node), confidence: "high", metadata: { route, method: method.toUpperCase(), framework: receiver === "router" ? "express-router" : "express" } });
        const handlerArg = node.arguments.find((argument, index) => index > 0 && ts.isIdentifier(argument));
        if (handlerArg && ts.isIdentifier(handlerArg)) {
          const handler = actionKeys.get(handlerArg.text) ?? [...byKey.entries()].find(([, fact]) => fact.label === handlerArg.text)?.[0];
          if (handler) relations.push({ from: key, to: handler, kind: "handles", confidence: "high", reason: `Express 路由引用处理函数 ${handlerArg.text}。` });
        }
      }
      if (receiver && ["router", "navigation"].includes(receiver) && ["push", "replace"].includes(method ?? "") && routeValue) {
        const route = normaliseRoute(routeValue);
        const target = add({ key: `navigate:${node.pos}`, kind: "page", label: route, line: sourceLine(node), confidence: "high", metadata: { route, framework } });
        if (owner) relations.push({ from: owner, to: target, kind: "navigates", confidence: "high", reason: `路由导航到 ${route}。` });
      }
      if (method === "add" && receiver && /queue|job/i.test(receiver)) {
        add({ key: `task:${node.pos}`, kind: "background-task", label: `${receiver}.add`, line: sourceLine(node), confidence: "high", metadata: { framework: "node-queue" } });
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ["Queue", "Worker", "BullMQ"].includes(node.expression.text)) {
      add({ key: `task:${node.pos}`, kind: "background-task", label: node.expression.text, line: sourceLine(node), confidence: "high", metadata: { framework: "node-queue" } });
    }
    if (ts.isIdentifier(node) && authNames.has(node.text.toLowerCase())) {
      add({ key: `auth:${node.pos}`, kind: "auth-guard", label: node.text, line: sourceLine(node), confidence: "high", metadata: { framework } });
    }
    if (ts.isClassDeclaration(node) && node.name && /(model|entity|schema)/i.test(node.name.text)) add({ key: `data:${node.pos}`, kind: "data-entity", label: node.name.text, line: sourceLine(node), confidence: "medium", metadata: { framework } });
    ts.forEachChild(node, visit);
    if (entered) functionStack.pop();
  };
  visit(source);
  if (framework === "vue" && sections.template) parseVueTemplate(sections.template, sections.templateOffset, ts.createSourceFile(file.relative, file.source, ts.ScriptTarget.Latest, true), add);
  const pages = facts.filter((fact) => fact.kind === "page");
  for (const page of pages) for (const component of componentKeys) relations.push({ from: page.key, to: component, kind: "renders", confidence: "medium", reason: "页面路由与组件由同一 AST 模块导出。" });
  for (const call of callKeys) if (call.owner) relations.push({ from: call.owner, to: call.key, kind: "calls", confidence: "high", reason: "函数体内调用前端请求。" });
  return { adapter: `${framework}-ast`, facts, relations, diagnostics: [] };
}

function runPythonAst(source: string) {
  const script = String.raw`import ast,json,sys
src=sys.stdin.read(); out=[]
try: tree=ast.parse(src)
except SyntaxError as e: print(json.dumps({"error":str(e)})); raise SystemExit(0)
def name(n):
  if isinstance(n, ast.Name): return n.id
  if isinstance(n, ast.Attribute): return name(n.value)+"."+n.attr
  return ""
def string(n): return n.value if isinstance(n, ast.Constant) and isinstance(n.value,str) else None
for n in ast.walk(tree):
  if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)):
    out.append(["function",n.name,n.lineno])
    for d in n.decorator_list:
      if isinstance(d,ast.Call):
        x=name(d.func); v=string(d.args[0]) if d.args else None
        if x in ("app.get","app.post","app.put","app.patch","app.delete","router.get","router.post","router.put","router.patch","router.delete") and v:
          out.append(["route",x,v,n.lineno,n.name])
  if isinstance(n,ast.Call):
    x=name(n.func)
    if x.endswith(".delay") or x.endswith(".enqueue") or x.endswith(".add"):
      out.append(["task",x,n.lineno])
    if x in ("Depends","Security") and n.args: out.append(["auth",name(n.args[0]),n.lineno])
  if isinstance(n,ast.ClassDef) and any(x in n.name.lower() for x in ("model","schema","entity")):
    out.append(["data",n.name,n.lineno])
print(json.dumps({"facts":out}))`;
  return new Promise<{ facts?: unknown[][]; error?: string }>((resolve) => {
    const child = spawn("python3", ["-c", script], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.once("error", () => resolve({ error: "python3_not_available" }));
    child.once("close", () => {
      try { resolve(JSON.parse(stdout || "{}") as { facts?: unknown[][]; error?: string }); }
      catch { resolve({ error: "python_ast_unavailable" }); }
    });
    child.stdin.end(source);
  });
}

async function parseFastApi(file: ParserSourceFile): Promise<ParsedBusinessFile> {
  const parsed = await runPythonAst(file.source);
  const facts: ParsedBusinessFact[] = [];
  const relations: ParsedBusinessRelation[] = [];
  const functionKeys = new Map<string, string>();
  const add = (fact: ParsedBusinessFact) => { if (!facts.some((item) => item.key === fact.key)) facts.push(fact); return fact.key; };
  for (const item of parsed.facts ?? []) {
    const [kind, first, second, third, fourth] = item;
    if (kind === "function" && typeof first === "string" && typeof second === "number") {
      functionKeys.set(first, add({ key: `fn:${first}:${second}`, kind: classifiedFunction(first), label: first, line: second, confidence: "high", metadata: { framework: "fastapi" } }));
    }
    if (kind === "route" && typeof first === "string" && typeof second === "string" && typeof third === "number") {
      const method = first.split(".").at(-1)?.toUpperCase() ?? "GET";
      const route = normaliseRoute(second);
      const routeKey = add({ key: `route:${third}:${route}`, kind: "api-route", label: `${method} ${route}`, line: third, confidence: "high", metadata: { route, method, framework: "fastapi" } });
      if (typeof fourth === "string" && functionKeys.has(fourth)) relations.push({ from: routeKey, to: functionKeys.get(fourth)!, kind: "handles", confidence: "high", reason: `FastAPI decorator 绑定处理函数 ${fourth}。` });
    }
    if (kind === "task" && typeof first === "string" && typeof second === "number") add({ key: `task:${second}:${first}`, kind: "background-task", label: first, line: second, confidence: "high", metadata: { framework: "fastapi" } });
    if (kind === "auth" && typeof first === "string" && typeof second === "number") add({ key: `auth:${second}:${first}`, kind: "auth-guard", label: first, line: second, confidence: "high", metadata: { framework: "fastapi" } });
    if (kind === "data" && typeof first === "string" && typeof second === "number") add({ key: `data:${second}:${first}`, kind: "data-entity", label: first, line: second, confidence: "medium", metadata: { framework: "fastapi" } });
  }
  return { adapter: "fastapi-python-ast", facts, relations, diagnostics: parsed.error ? [parsed.error] : [] };
}

export async function parseBusinessSource(file: ParserSourceFile): Promise<ParsedBusinessFile> {
  if (/\.py$/i.test(file.relative)) return parseFastApi(file);
  if (/\.vue$/i.test(file.relative)) return parseTypeScriptFile(file, "vue");
  if (/(?:^|\/)(?:app|pages)\//i.test(file.relative)) return parseTypeScriptFile(file, "next");
  if (/\.(?:[cm]?[jt]sx?)$/i.test(file.relative)) return parseTypeScriptFile(file, "react");
  return parseTypeScriptFile(file, "typescript");
}
