import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { ConnectorContext, IntakeSource, SourceReadEnvelope } from "./types.js";

const execFileAsync = promisify(execFile);
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const remoteCache = new Map<string, { expiresAt: number; read: ConnectorRead }>();

type SourceReadMeta = NonNullable<SourceReadEnvelope["readMeta"]>;
type SourceRateLimitMeta = NonNullable<SourceReadMeta["rateLimit"]>;
type OpenApiReadMeta = NonNullable<SourceReadMeta["openApi"]>;

export interface ReadConnectorContextInput {
  requirementPath?: string;
  requirementUrl?: string;
  bugTicketPath?: string;
  bugTicketUrl?: string;
  prUrl?: string;
  prDiffUrl?: string;
  openApiPath?: string;
  openApiUrl?: string;
  gitBase?: string;
  gitHead?: string;
  staged?: boolean;
  fallbackDiff?: string;
  strictInput?: boolean;
}

type ConnectorRead = {
  text: string;
  status: IntakeSource["status"];
  summary: string;
  uri?: string;
  failureReason?: string;
  permissionState?: SourceReadEnvelope["permissionState"];
  trustLevel?: SourceReadEnvelope["trustLevel"];
  readMeta?: SourceReadMeta;
};

function hashText(text: string) {
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function sourceId(kind: SourceReadEnvelope["kind"], uri: string | undefined, title: string, contentHash: string | undefined) {
  return `src_${kind}_${createHash("sha1").update(`${kind}:${uri ?? title}:${contentHash ?? "empty"}`).digest("hex").slice(0, 10)}`;
}

function envelope(input: {
  kind: SourceReadEnvelope["kind"];
  title: string;
  uri?: string;
  read: ConnectorRead;
}): SourceReadEnvelope {
  const contentHash = hashText(input.read.text);
  const displayStatus: SourceReadEnvelope["displayStatus"] =
    input.read.status === "simulated"
      ? "simulated"
      : input.read.status === "missing"
        ? input.read.permissionState === "denied" || input.read.permissionState === "missing"
          ? "needs_auth"
          : "missing"
        : "ready";
  const evidenceUse: SourceReadEnvelope["evidenceUse"] =
    input.kind === "requirement_doc" ? "primary_requirement"
      : input.kind === "git_diff" || input.kind === "github_pr" || input.kind === "github_pr_diff" ? "change_context"
        : input.kind === "github_issue" || input.kind === "jira_issue" || input.kind === "tapd_bug" ? "bug_context"
          : input.kind === "openapi" ? "api_contract"
            : input.read.status === "missing" ? "not_used" : "supplemental";
  const plainLanguageSummary =
    displayStatus === "ready"
      ? `已接入 ${input.title}，会作为${evidenceUse === "primary_requirement" ? "需求依据" : evidenceUse === "change_context" ? "代码变更依据" : evidenceUse === "bug_context" ? "缺陷依据" : evidenceUse === "api_contract" ? "接口契约依据" : "补充依据"}。`
      : displayStatus === "needs_auth"
        ? `${input.title} 需要权限或 token，当前无法读取。`
        : displayStatus === "simulated"
          ? `${input.title} 来自演示 fixture，只能用于离线演示。`
          : `${input.title} 未读取成功：${input.read.failureReason ?? input.read.summary}`;
  return {
    id: sourceId(input.kind, input.uri, input.title, contentHash),
    kind: input.kind,
    title: input.title,
    uri: input.uri,
    status: input.read.status,
    summary: input.read.summary,
    failureReason: input.read.failureReason ?? (input.read.status === "missing" ? input.read.summary : undefined),
    permissionState: input.read.permissionState ?? "not_required",
    isSimulated: input.read.status === "simulated",
    evidenceUse,
    displayStatus,
    plainLanguageSummary,
    contentHash,
    readAt: new Date().toISOString(),
    trustLevel: input.read.trustLevel ?? (input.read.status === "simulated" ? "low" : input.read.status === "connected" ? "high" : "low"),
    readMeta: input.read.readMeta
  };
}

function intakeSourceFromEnvelope(item: SourceReadEnvelope): IntakeSource {
  return {
    kind: item.kind === "github_pr_diff" ? "git_diff" : item.kind === "github_pr" ? "pr" : item.kind,
    title: item.title,
    status: item.status,
    summary: item.failureReason ? `${item.summary} failure=${item.failureReason}` : item.summary
  };
}

function primaryConnectorRoot() {
  return path.resolve(process.env.WORKSPACE_ROOT ?? rootDir);
}

function connectorFileRoots() {
  const roots = [
    rootDir,
    primaryConnectorRoot(),
    ...(process.env.CONNECTOR_FILE_ROOTS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => path.resolve(item))
  ];
  return Array.from(new Set(roots));
}

function isInsideRoot(filePath: string, root: string) {
  const relative = path.relative(root, filePath);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative)) || relative === "";
}

function displayConnectorPath(filePath: string) {
  const root = connectorFileRoots().find((candidate) => isInsideRoot(filePath, candidate));
  if (!root) return filePath;
  return path.relative(root, filePath) || ".";
}

function safeWorkspacePath(inputPath: string) {
  const baseRoot = primaryConnectorRoot();
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(baseRoot, inputPath);
  const allowedRoot = connectorFileRoots().find((candidate) => isInsideRoot(resolved, candidate));
  if (!allowedRoot) {
    throw new Error(`Path is outside connector file roots: ${inputPath}. Set WORKSPACE_ROOT or CONNECTOR_FILE_ROOTS to allow this local project file.`);
  }
  return resolved;
}

function isDemoFixturePath(filePath: string) {
  const relative = path.relative(rootDir, filePath).split(path.sep).join("/");
  return relative === "data/fixtures" || relative.startsWith("data/fixtures/");
}

function isPrivateIPv4(ip: string) {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateIPv6(ip: string) {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized === "::"
  );
}

function allowPrivateConnectorUrls() {
  return process.env.ALLOW_PRIVATE_CONNECTOR_URLS === "1";
}

async function assertSafeConnectorUrl(url: URL) {
  if (allowPrivateConnectorUrls()) return;
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Connector URL only supports http/https.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Connector URL blocked: localhost is not allowed.");
  }
  const directIp = isIP(host);
  const addresses = directIp ? [{ address: host, family: directIp }] : await lookup(host, { all: true, verbatim: false });
  for (const item of addresses) {
    const blocked = item.family === 4 ? isPrivateIPv4(item.address) : isPrivateIPv6(item.address);
    if (blocked) {
      throw new Error(`Connector URL blocked: ${host} resolves to private address ${item.address}.`);
    }
  }
}

async function readTextFile(inputPath: string | undefined) {
  if (!inputPath?.trim()) {
    return { text: "", status: "missing" as const, summary: "未提供文件路径。" };
  }
  try {
    const filePath = safeWorkspacePath(inputPath);
    const text = await readFile(filePath, "utf8");
    const demoFixture = isDemoFixturePath(filePath);
    const relativePath = displayConnectorPath(filePath);
    return {
      text,
      status: demoFixture ? "simulated" as const : "connected" as const,
      summary: demoFixture
        ? `已读取 demo fixture ${relativePath}；该来源仅适合演示或离线 smoke。`
        : `已读取 ${relativePath}。`,
      uri: relativePath,
      trustLevel: demoFixture ? "low" as const : "high" as const
    };
  } catch (error) {
    return {
      text: "",
      status: "missing" as const,
      summary: error instanceof Error ? error.message : "文件读取失败。",
      failureReason: error instanceof Error ? error.message : "文件读取失败。"
    };
  }
}

function authHeadersFor(url: string) {
  const headers: Record<string, string> = {
    accept: "text/plain, application/json;q=0.9, */*;q=0.5",
    "user-agent": "ai-test-officer"
  };
  const parsed = new URL(url);
  if (parsed.hostname.includes("github.com") && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  if (process.env.CONNECTOR_AUTH_TOKEN) {
    headers.authorization = `Bearer ${process.env.CONNECTOR_AUTH_TOKEN}`;
  }
  if (parsed.hostname.includes("tapd") && process.env.TAPD_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.TAPD_API_TOKEN}`;
  }
  if ((parsed.hostname.includes("atlassian.net") || parsed.hostname.includes("jira")) && process.env.JIRA_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.JIRA_API_TOKEN}`;
  }
  return headers;
}

function githubJsonHeaders() {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "ai-test-officer"
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function summarizeRemoteText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (typeof json === "object" && json !== null) {
      return JSON.stringify(json, null, 2).slice(0, 80_000);
    }
  } catch {
    // Non-JSON text is expected for Markdown, TAPD exports, and PR diffs.
  }
  return trimmed.slice(0, 80_000);
}

const openApiMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function cleanYamlValue(value: string | undefined) {
  return value?.trim().replace(/^["']|["']$/g, "");
}

function parseOpenApiJson(text: string): OpenApiReadMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const doc = parsed as {
    openapi?: unknown;
    swagger?: unknown;
    info?: { title?: unknown; version?: unknown };
    paths?: Record<string, Record<string, {
      operationId?: unknown;
      summary?: unknown;
      tags?: unknown;
    }>>;
  };
  if (!doc.paths || typeof doc.paths !== "object") return undefined;
  const operations: OpenApiReadMeta["operations"] = [];
  for (const [routePath, methods] of Object.entries(doc.paths)) {
    if (!routePath.startsWith("/") || !methods || typeof methods !== "object") continue;
    for (const [method, operation] of Object.entries(methods)) {
      const normalizedMethod = method.toLowerCase();
      if (!openApiMethods.has(normalizedMethod) || !operation || typeof operation !== "object") continue;
      operations.push({
        method: normalizedMethod.toUpperCase(),
        path: routePath,
        operationId: typeof operation.operationId === "string" ? operation.operationId : undefined,
        summary: typeof operation.summary === "string" ? operation.summary : undefined,
        tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : undefined
      });
    }
  }
  if (!operations.length) return undefined;
  return {
    title: typeof doc.info?.title === "string" ? doc.info.title : undefined,
    version: typeof doc.info?.version === "string" ? doc.info.version : typeof doc.openapi === "string" ? doc.openapi : typeof doc.swagger === "string" ? doc.swagger : undefined,
    operationCount: operations.length,
    operations: operations.slice(0, 50)
  };
}

function parseOpenApiYaml(text: string): OpenApiReadMeta | undefined {
  const operations: OpenApiReadMeta["operations"] = [];
  const lines = text.split(/\r?\n/);
  let title: string | undefined;
  let version: string | undefined;
  let inPaths = false;
  let currentPath: string | undefined;
  let currentOperation: OpenApiReadMeta["operations"][number] | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^title:\s*/i.test(trimmed) && !title) title = cleanYamlValue(trimmed.replace(/^title:\s*/i, ""));
    if (/^version:\s*/i.test(trimmed) && !version) version = cleanYamlValue(trimmed.replace(/^version:\s*/i, ""));
    if (/^paths:\s*$/i.test(trimmed)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    const pathMatch = line.match(/^\s{2}["']?(\/[^:"']+)["']?:\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      currentOperation = undefined;
      continue;
    }
    const methodMatch = line.match(/^\s{4}(get|post|put|patch|delete|options|head|trace):\s*$/i);
    if (methodMatch && currentPath) {
      currentOperation = { method: methodMatch[1].toUpperCase(), path: currentPath };
      operations.push(currentOperation);
      continue;
    }
    if (!currentOperation) continue;
    const operationIdMatch = line.match(/^\s{6,}operationId:\s*(.+)$/i);
    if (operationIdMatch) currentOperation.operationId = cleanYamlValue(operationIdMatch[1]);
    const summaryMatch = line.match(/^\s{6,}summary:\s*(.+)$/i);
    if (summaryMatch) currentOperation.summary = cleanYamlValue(summaryMatch[1]);
    const tagsMatch = line.match(/^\s{6,}tags:\s*\[(.+)\]\s*$/i);
    if (tagsMatch) {
      currentOperation.tags = tagsMatch[1].split(",").map((tag) => cleanYamlValue(tag)).filter((tag): tag is string => Boolean(tag));
    }
  }
  if (!operations.length) return undefined;
  return {
    title,
    version,
    operationCount: operations.length,
    operations: operations.slice(0, 50)
  };
}

function parseOpenApi(text: string) {
  return parseOpenApiJson(text) ?? parseOpenApiYaml(text);
}

function openApiOperationText(meta: OpenApiReadMeta) {
  return [
    `OpenAPI title=${meta.title ?? "unknown"} version=${meta.version ?? "unknown"} operations=${meta.operationCount}`,
    ...meta.operations.map((operation) => [
      operation.method,
      operation.path,
      operation.operationId ? `operationId=${operation.operationId}` : "",
      operation.summary ? `summary=${operation.summary}` : "",
      operation.tags?.length ? `tags=${operation.tags.join(",")}` : ""
    ].filter(Boolean).join(" "))
  ].join("\n");
}

function normalizeOpenApiRead(read: ConnectorRead): ConnectorRead {
  if (!read.text.trim()) return read;
  const openApi = parseOpenApi(read.text);
  if (!openApi) {
    return {
      ...read,
      status: "missing",
      summary: `${read.summary} OpenAPI schema parse failed: no operations found.`,
      failureReason: "OpenAPI schema parse failed: no operations found.",
      trustLevel: "low",
      readMeta: {
        ...read.readMeta,
        documentVersion: undefined,
        openApi: {
          operationCount: 0,
          operations: []
        }
      }
    };
  }
  const operationText = openApiOperationText(openApi);
  return {
    ...read,
    text: `${read.text}\n\n${operationText}`,
    summary: `${read.summary} OpenAPI operations=${openApi.operationCount}${openApi.version ? ` version=${openApi.version}` : ""}.`,
    readMeta: {
      ...read.readMeta,
      documentVersion: openApi.version,
      openApi
    }
  };
}

function numberHeader(headers: Headers, name: string) {
  const value = headers.get(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function retryAfterMs(headers: Headers) {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function rateLimitMeta(headers: Headers): SourceRateLimitMeta | undefined {
  const limit = numberHeader(headers, "x-ratelimit-limit");
  const remaining = numberHeader(headers, "x-ratelimit-remaining");
  const reset = numberHeader(headers, "x-ratelimit-reset");
  const retryAfter = retryAfterMs(headers);
  if (limit === undefined && remaining === undefined && reset === undefined && retryAfter === undefined) return undefined;
  return {
    limit,
    remaining,
    resetAt: reset ? new Date(reset * 1000).toISOString() : undefined,
    retryAfterMs: retryAfter
  };
}

function connectorCacheTtlMs() {
  return Number(process.env.CONNECTOR_CACHE_TTL_MS ?? 5 * 60 * 1000);
}

function connectorRetryCount() {
  return Number(process.env.CONNECTOR_FETCH_RETRIES ?? 2);
}

function connectorRetryDelayMs() {
  return Number(process.env.CONNECTOR_RETRY_DELAY_MS ?? 250);
}

function shouldRetryStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function delay(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(inputUrl: string, label: string) {
  return `${label}:${inputUrl.trim()}`;
}

function cachedRead(inputUrl: string, label: string) {
  const ttl = connectorCacheTtlMs();
  if (ttl <= 0) return { read: undefined, cacheStatus: "bypass" as const };
  const cached = remoteCache.get(cacheKey(inputUrl, label));
  if (!cached) return { read: undefined, cacheStatus: "miss" as const };
  if (cached.expiresAt > Date.now()) {
    return {
      read: {
        ...cached.read,
        summary: `${cached.read.summary} cache=hit`,
        readMeta: {
          ...cached.read.readMeta,
          attempts: 0,
          cacheStatus: "hit" as const
        }
      },
      cacheStatus: "hit" as const
    };
  }
  remoteCache.delete(cacheKey(inputUrl, label));
  return { read: undefined, cacheStatus: "stale" as const };
}

function rememberRemoteRead(inputUrl: string, label: string, read: ConnectorRead) {
  const ttl = connectorCacheTtlMs();
  if (ttl <= 0 || read.status !== "connected") return;
  remoteCache.set(cacheKey(inputUrl, label), { expiresAt: Date.now() + ttl, read });
}

async function readTextUrl(inputUrl: string | undefined, label: string) {
  if (!inputUrl?.trim()) {
    return { text: "", status: "missing" as const, summary: `未提供${label} URL。` };
  }
  const cached = cachedRead(inputUrl, label);
  if (cached.read) return cached.read;
  const maxAttempts = Math.max(1, 1 + connectorRetryCount());
  let attempts = 0;
  try {
    let parsed = new URL(inputUrl);
    let response: Response | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      parsed = new URL(inputUrl);
      for (let redirectCount = 0; redirectCount < 4; redirectCount += 1) {
        await assertSafeConnectorUrl(parsed);
        response = await fetch(parsed, {
          headers: authHeadersFor(parsed.toString()),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000)
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) break;
        parsed = new URL(location, parsed);
      }
      if (!response || !shouldRetryStatus(response.status) || attempt === maxAttempts) break;
      await delay(retryAfterMs(response.headers) ?? connectorRetryDelayMs());
    }
    if (!response) {
      return {
        text: "",
        status: "missing" as const,
        summary: `${label} URL 读取失败。`,
        readMeta: { attempts, cacheStatus: cached.cacheStatus }
      };
    }
    const readMeta = {
      attempts,
      cacheStatus: cached.cacheStatus,
      httpStatus: response.status,
      finalUrl: parsed.toString(),
      rateLimit: rateLimitMeta(response.headers)
    };
    if (!response.ok) {
      return {
        text: "",
        status: "missing" as const,
        summary: `${label} URL 读取失败：HTTP ${response.status}。`,
        uri: parsed.toString(),
        permissionState: response.status === 401 || response.status === 403 ? "denied" as const : authHeadersFor(parsed.toString()).authorization ? "granted" as const : "unknown" as const,
        trustLevel: "low" as const,
        failureReason: `${label} URL HTTP ${response.status}`,
        readMeta
      };
    }
    const raw = await response.text();
    const text = summarizeRemoteText(raw);
    const read = {
      text,
      status: text ? "connected" as const : "missing" as const,
      summary: text ? `已读取远程${label}：${parsed.toString()}。` : `远程${label}为空。`,
      uri: parsed.toString(),
      permissionState: authHeadersFor(parsed.toString()).authorization ? "granted" as const : "unknown" as const,
      trustLevel: "medium" as const,
      failureReason: text ? undefined : `远程${label}为空。`,
      readMeta
    };
    rememberRemoteRead(inputUrl, label, read);
    return read;
  } catch (error) {
    return {
      text: "",
      status: "missing" as const,
      summary: error instanceof Error ? `${label} URL 读取失败：${error.message}` : `${label} URL 读取失败。`,
      uri: inputUrl,
      permissionState: "unknown" as const,
      trustLevel: "low" as const,
      failureReason: error instanceof Error ? error.message : `${label} URL 读取失败。`,
      readMeta: { attempts, cacheStatus: cached.cacheStatus }
    };
  }
}

function githubPullDiffUrl(prUrl: string | undefined) {
  if (!prUrl?.trim()) return undefined;
  try {
    const parsed = new URL(prUrl);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!parsed.hostname.includes("github.com") || !match) return undefined;
    return `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}.diff`;
  } catch {
    return undefined;
  }
}

function parseGithubPullUrl(prUrl: string | undefined) {
  if (!prUrl?.trim()) return undefined;
  try {
    const parsed = new URL(prUrl);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!parsed.hostname.includes("github.com") || !match) return undefined;
    return {
      owner: match[1],
      repo: match[2],
      number: Number(match[3])
    };
  } catch {
    return undefined;
  }
}

function parseGithubIssueUrl(issueUrl: string | undefined) {
  if (!issueUrl?.trim()) return undefined;
  try {
    const parsed = new URL(issueUrl);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!parsed.hostname.includes("github.com") || !match) return undefined;
    return {
      owner: match[1],
      repo: match[2],
      number: Number(match[3])
    };
  } catch {
    return undefined;
  }
}

function parseJiraIssueUrl(issueUrl: string | undefined) {
  if (!issueUrl?.trim()) return undefined;
  try {
    const parsed = new URL(issueUrl);
    const browseMatch = parsed.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
    const tailMatch = parsed.pathname.match(/\/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)/i);
    const key = browseMatch?.[1] ?? tailMatch?.[1];
    if (!key) return undefined;
    return {
      origin: parsed.origin,
      key: key.toUpperCase()
    };
  } catch {
    return undefined;
  }
}

function githubApiUrl(owner: string, repo: string, suffix: string) {
  const base = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  return `${base.replace(/\/$/, "")}/repos/${owner}/${repo}${suffix}`;
}

function linkedIssueNumbers(text: string) {
  const numbers = new Set<number>();
  const patterns = [
    /(?:fixes|fixed|close[sd]?|resolve[sd]?)\s+#(\d+)/gi,
    /#(\d+)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      numbers.add(Number(match[1]));
    }
  }
  return Array.from(numbers).slice(0, 5);
}

async function fetchGithubJson<T>(url: string) {
  let response: Response | undefined;
  const maxAttempts = Math.max(1, 1 + connectorRetryCount());
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await assertSafeConnectorUrl(new URL(url));
    response = await fetch(url, {
      headers: githubJsonHeaders(),
      signal: AbortSignal.timeout(10_000)
    });
    if (!shouldRetryStatus(response.status) || attempt === maxAttempts) break;
    await delay(retryAfterMs(response.headers) ?? connectorRetryDelayMs());
  }
  if (!response) throw new Error("GitHub API request did not return a response.");
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return {
    data: (await response.json()) as T,
    httpStatus: response.status,
    link: response.headers.get("link") ?? undefined,
    rateLimit: rateLimitMeta(response.headers)
  };
}

async function fetchGithubPullFiles(owner: string, repo: string, number: number) {
  const maxPages = Number(process.env.GITHUB_MAX_FILE_PAGES ?? 10);
  const files: Array<{ filename: string }> = [];
  let pagesRead = 0;
  let hasMore = false;
  let rateLimit: SourceRateLimitMeta | undefined;
  let httpStatus: number | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchGithubJson<Array<{ filename: string }>>(
      githubApiUrl(owner, repo, `/pulls/${number}/files?per_page=100&page=${page}`)
    );
    pagesRead = page;
    httpStatus = result.httpStatus;
    rateLimit = result.rateLimit;
    files.push(...result.data);
    const hasNextLink = /rel="next"/.test(result.link ?? "");
    const couldHaveNextPage = result.data.length === 100;
    if (!hasNextLink && !couldHaveNextPage) {
      hasMore = false;
      break;
    }
    hasMore = true;
  }
  return {
    files,
    readMeta: {
      attempts: pagesRead + 1,
      cacheStatus: "bypass" as const,
      httpStatus,
      rateLimit,
      pagination: {
        pagesRead,
        hasMore,
        itemCount: files.length
      }
    }
  };
}

async function readGithubPullMeta(prUrl: string | undefined): Promise<{
  meta?: ConnectorContext["prMeta"];
  text: string;
  status: IntakeSource["status"];
  summary: string;
  uri?: string;
  permissionState?: SourceReadEnvelope["permissionState"];
  trustLevel?: SourceReadEnvelope["trustLevel"];
  failureReason?: string;
  readMeta?: SourceReadEnvelope["readMeta"];
}> {
  const parsed = parseGithubPullUrl(prUrl);
  if (!parsed) {
    return {
      text: "",
      status: prUrl ? "missing" : "missing",
      summary: prUrl ? "PR URL 不是 GitHub pull request 格式。" : "未提供 PR 链接。"
    };
  }
  try {
    const pullResult = await fetchGithubJson<{
      title?: string;
      body?: string | null;
      html_url?: string;
    }>(githubApiUrl(parsed.owner, parsed.repo, `/pulls/${parsed.number}`));
    const pull = pullResult.data;
    const fileResult = await fetchGithubPullFiles(parsed.owner, parsed.repo, parsed.number);
    const issueNumbers = linkedIssueNumbers(`${pull.title ?? ""}\n${pull.body ?? ""}`);
    const linkedIssues = await Promise.all(
      issueNumbers.map(async (number) => {
        try {
          const issue = (await fetchGithubJson<{ title?: string; body?: string | null }>(
            githubApiUrl(parsed.owner, parsed.repo, `/issues/${number}`)
          )).data;
          return { number, title: issue.title, body: issue.body ?? "" };
        } catch {
          return { number };
        }
      })
    );
    const changedFiles = fileResult.files.map((file) => file.filename);
    const meta: ConnectorContext["prMeta"] = {
      provider: "github",
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      title: pull.title ?? "",
      body: pull.body ?? "",
      changedFiles,
      linkedIssues
    };
    const issueText = linkedIssues
      .map((issue) => `Issue #${issue.number}: ${issue.title ?? ""}\n${issue.body ?? ""}`)
      .join("\n\n");
    const text = [
      `GitHub PR #${parsed.number}: ${meta.title}`,
      meta.body,
      `Changed files:\n${changedFiles.map((file) => `- ${file}`).join("\n")}`,
      issueText
    ].filter(Boolean).join("\n\n");
    return {
      meta,
      text,
      status: "connected",
      summary: `已读取 GitHub PR #${parsed.number}：${meta.title || "无标题"}；changed files=${changedFiles.length}。`,
      uri: prUrl,
      permissionState: process.env.GITHUB_TOKEN ? "granted" : "unknown",
      trustLevel: "medium",
      readMeta: {
        ...fileResult.readMeta,
        attempts: (fileResult.readMeta.attempts ?? 0) + 1,
        httpStatus: pullResult.httpStatus,
        rateLimit: pullResult.rateLimit ?? fileResult.readMeta.rateLimit
      }
    };
  } catch (error) {
    return {
      text: "",
      status: "missing",
      summary: error instanceof Error ? `GitHub PR 元数据读取失败：${error.message}` : "GitHub PR 元数据读取失败。",
      uri: prUrl,
      permissionState: process.env.GITHUB_TOKEN ? "granted" : "missing",
      trustLevel: "low",
      failureReason: error instanceof Error ? error.message : "GitHub PR 元数据读取失败。"
    };
  }
}

async function readGithubIssue(issueUrl: string | undefined): Promise<ConnectorRead> {
  const parsed = parseGithubIssueUrl(issueUrl);
  if (!parsed) {
    return {
      text: "",
      status: issueUrl ? "missing" : "missing",
      summary: issueUrl ? "Bug URL 不是 GitHub issue 格式。" : "未提供 GitHub issue URL。"
    };
  }
  try {
    const result = await fetchGithubJson<{
      title?: string;
      body?: string | null;
      state?: string;
      html_url?: string;
      labels?: Array<{ name?: string }>;
      user?: { login?: string };
    }>(githubApiUrl(parsed.owner, parsed.repo, `/issues/${parsed.number}`));
    const issue = result.data;
    const labels = Array.isArray(issue.labels)
      ? issue.labels.map((label) => label.name).filter((name): name is string => Boolean(name))
      : [];
    return {
      text: [
        `GitHub Issue #${parsed.number}: ${issue.title ?? ""}`,
        `state=${issue.state ?? "unknown"}`,
        labels.length ? `labels=${labels.join(",")}` : "",
        issue.user?.login ? `author=${issue.user.login}` : "",
        issue.body ?? ""
      ].filter(Boolean).join("\n"),
      status: "connected",
      summary: `已读取 GitHub Issue #${parsed.number}：${issue.title ?? "无标题"}。`,
      uri: issue.html_url ?? issueUrl,
      permissionState: process.env.GITHUB_TOKEN ? "granted" : "unknown",
      trustLevel: "medium",
      readMeta: {
        attempts: 1,
        cacheStatus: "bypass",
        httpStatus: result.httpStatus,
        finalUrl: githubApiUrl(parsed.owner, parsed.repo, `/issues/${parsed.number}`),
        rateLimit: result.rateLimit
      }
    };
  } catch (error) {
    return {
      text: "",
      status: "missing",
      summary: error instanceof Error ? `GitHub Issue 读取失败：${error.message}` : "GitHub Issue 读取失败。",
      uri: issueUrl,
      permissionState: process.env.GITHUB_TOKEN ? "granted" : "missing",
      trustLevel: "low",
      failureReason: error instanceof Error ? error.message : "GitHub Issue 读取失败。"
    };
  }
}

async function readJiraIssue(issueUrl: string | undefined): Promise<ConnectorRead> {
  const parsed = parseJiraIssueUrl(issueUrl);
  if (!parsed) {
    return {
      text: "",
      status: issueUrl ? "missing" : "missing",
      summary: issueUrl ? "Bug URL 不是 Jira issue 格式。" : "未提供 Jira issue URL。"
    };
  }
  const apiUrl = `${parsed.origin}/rest/api/2/issue/${parsed.key}`;
  try {
    await assertSafeConnectorUrl(new URL(apiUrl));
    const response = await fetch(apiUrl, {
      headers: authHeadersFor(apiUrl),
      signal: AbortSignal.timeout(10_000)
    });
    const readMeta = {
      attempts: 1,
      cacheStatus: "bypass" as const,
      httpStatus: response.status,
      finalUrl: apiUrl,
      rateLimit: rateLimitMeta(response.headers)
    };
    if (!response.ok) {
      return {
        text: "",
        status: "missing",
        summary: `Jira Issue ${parsed.key} 读取失败：HTTP ${response.status}。`,
        uri: issueUrl,
        permissionState: response.status === 401 || response.status === 403 ? "denied" : authHeadersFor(apiUrl).authorization ? "granted" : "unknown",
        trustLevel: "low",
        failureReason: `Jira Issue HTTP ${response.status}`,
        readMeta
      };
    }
    const json = await response.json() as {
      key?: string;
      fields?: {
        summary?: string;
        description?: string | null;
        status?: { name?: string };
        issuetype?: { name?: string };
        priority?: { name?: string };
        labels?: string[];
      };
    };
    const fields = json.fields ?? {};
    return {
      text: [
        `Jira Issue ${json.key ?? parsed.key}: ${fields.summary ?? ""}`,
        fields.status?.name ? `status=${fields.status.name}` : "",
        fields.issuetype?.name ? `type=${fields.issuetype.name}` : "",
        fields.priority?.name ? `priority=${fields.priority.name}` : "",
        fields.labels?.length ? `labels=${fields.labels.join(",")}` : "",
        fields.description ?? ""
      ].filter(Boolean).join("\n"),
      status: "connected",
      summary: `已读取 Jira Issue ${json.key ?? parsed.key}：${fields.summary ?? "无标题"}。`,
      uri: issueUrl,
      permissionState: authHeadersFor(apiUrl).authorization ? "granted" : "unknown",
      trustLevel: "medium",
      readMeta
    };
  } catch (error) {
    return {
      text: "",
      status: "missing",
      summary: error instanceof Error ? `Jira Issue 读取失败：${error.message}` : "Jira Issue 读取失败。",
      uri: issueUrl,
      permissionState: process.env.JIRA_API_TOKEN ? "granted" : "missing",
      trustLevel: "low",
      failureReason: error instanceof Error ? error.message : "Jira Issue 读取失败。"
    };
  }
}

async function readBugTicketUrl(inputUrl: string | undefined): Promise<{
  kind: SourceReadEnvelope["kind"];
  read: ConnectorRead;
}> {
  if (parseGithubIssueUrl(inputUrl)) {
    return { kind: "github_issue", read: await readGithubIssue(inputUrl) };
  }
  if (parseJiraIssueUrl(inputUrl)) {
    return { kind: "jira_issue", read: await readJiraIssue(inputUrl) };
  }
  return { kind: "tapd_bug", read: await readTextUrl(inputUrl, "TAPD/Bug 单") };
}

async function readGitDiff(input: ReadConnectorContextInput) {
  const fallbackDiff = input.strictInput ? undefined : input.fallbackDiff;
  const remoteDiffUrl = input.prDiffUrl?.trim() || githubPullDiffUrl(input.prUrl);
  if (remoteDiffUrl) {
    const remote = await readTextUrl(remoteDiffUrl, "PR diff");
    if (remote.text) return remote;
    return {
      ...remote,
      summary: `${remote.summary} 已提供远程 PR diff，系统不会回退本地 demo 或 fallback diff。`,
      failureReason: remote.failureReason ?? "远程 PR diff 读取失败，且禁止回退 demo fixture。"
    };
  }
  try {
    const gitRoot = primaryConnectorRoot();
    const args = ["diff"];
    if (input.staged) {
      args.push("--cached");
    } else if (input.gitBase || input.gitHead) {
      args.push(`${input.gitBase ?? "HEAD"}..${input.gitHead ?? "HEAD"}`);
    }
    const { stdout } = await execFileAsync("git", args, {
      cwd: gitRoot,
      timeout: 8000,
      maxBuffer: 1024 * 1024
    });
    const diff = stdout.trim();
    if (diff) {
      return {
        text: diff,
        status: "connected" as const,
        summary: `已从 ${gitRoot} 读取 git diff。`,
        uri: `git:${gitRoot}`,
        trustLevel: "high" as const
      };
    }
    if (fallbackDiff?.trim()) {
      return {
        text: fallbackDiff,
        status: "simulated" as const,
        summary: "当前工作区无 git diff，已使用传入 fallback diff。",
        uri: "fallbackDiff",
        trustLevel: "low" as const
      };
    }
    return {
      text: "",
      status: "missing" as const,
      summary: "当前工作区无 git diff。"
    };
  } catch (error) {
    if (fallbackDiff?.trim()) {
      return {
        text: fallbackDiff,
        status: "simulated" as const,
        summary: "git diff 读取失败，已使用传入 fallback diff。",
        uri: "fallbackDiff",
        failureReason: error instanceof Error ? error.message : "git diff 读取失败。",
        trustLevel: "low" as const
      };
    }
    return {
      text: "",
      status: "missing" as const,
      summary: error instanceof Error ? error.message : "git diff 读取失败。",
      failureReason: error instanceof Error ? error.message : "git diff 读取失败。"
    };
  }
}

export async function readConnectorContext(input: ReadConnectorContextInput): Promise<ConnectorContext> {
  const [diff, requirementFile, requirementRemote, bugTicketFile, bugTicketRemote, openApiFile, openApiRemote, prMeta] = await Promise.all([
    readGitDiff(input),
    readTextFile(input.requirementPath),
    readTextUrl(input.requirementUrl, "需求文档"),
    readTextFile(input.bugTicketPath),
    readBugTicketUrl(input.bugTicketUrl),
    readTextFile(input.openApiPath),
    readTextUrl(input.openApiUrl, "OpenAPI 文档"),
    readGithubPullMeta(input.prUrl)
  ]);
  const requirement = input.requirementUrl ? requirementRemote : requirementFile;
  const bugTicket = input.bugTicketUrl ? bugTicketRemote.read : bugTicketFile;
  const bugTicketKind = input.bugTicketUrl ? bugTicketRemote.kind : "tapd_bug";
  const openApi = normalizeOpenApiRead(input.openApiUrl ? openApiRemote : openApiFile);
  const requirementWithPr = [requirement.text, prMeta.text, openApi.text ? `OpenAPI:\n${openApi.text}` : ""].filter(Boolean).join("\n\n");

  const sourceContexts: SourceReadEnvelope[] = [
    envelope({ kind: input.prDiffUrl || input.prUrl ? "github_pr_diff" : "git_diff", title: "Git/PR diff", uri: input.prDiffUrl ?? githubPullDiffUrl(input.prUrl), read: diff }),
    envelope({ kind: "requirement_doc", title: "需求文档", uri: input.requirementUrl ?? input.requirementPath, read: requirement }),
    envelope({ kind: bugTicketKind, title: bugTicketKind === "github_issue" ? "GitHub Issue" : bugTicketKind === "jira_issue" ? "Jira Issue" : "TAPD/Bug 单", uri: input.bugTicketUrl ?? input.bugTicketPath, read: bugTicket }),
    envelope({ kind: "openapi", title: "OpenAPI 文档", uri: input.openApiUrl ?? input.openApiPath, read: openApi }),
    envelope({
      kind: "github_pr",
      title: "Pull Request 元数据",
      uri: input.prUrl ?? input.prDiffUrl,
      read: {
        text: prMeta.text,
        status: input.prUrl ? prMeta.status : input.prDiffUrl ? diff.status : "missing",
        summary: input.prUrl || input.prDiffUrl
          ? `PR 来源：${input.prUrl ?? input.prDiffUrl}；diff 状态：${diff.status}；${prMeta.summary}`
          : "未提供 PR 链接。",
        failureReason: input.prUrl && prMeta.status === "missing" ? prMeta.summary : undefined,
        permissionState: prMeta.permissionState,
        trustLevel: prMeta.trustLevel,
        readMeta: prMeta.readMeta
      }
    })
  ];
  const sources = sourceContexts.map(intakeSourceFromEnvelope);

  return {
    requirement: requirementWithPr,
    diff: diff.text,
    bugTicket: bugTicket.text,
    prUrl: input.prUrl,
    prMeta: prMeta.meta,
    sourceContexts,
    sources
  };
}
