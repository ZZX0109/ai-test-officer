import type { FailureAttribution, ImpactAnalysis, SourceReadEnvelope, VisualRunResult } from "./types.js";

type DiagnosticSignal = NonNullable<NonNullable<FailureAttribution["changeRefs"]>[number]["diagnosticSignals"]>[number];

function evidenceRefsForFailure(input: {
  failedNames: string[];
  evidence: VisualRunResult["evidence"];
}) {
  const refs = new Set<string>();
  for (const item of input.evidence) {
    const text = JSON.stringify(item);
    if (
      item.type === "screenshot" ||
      item.type === "dom" ||
      item.type === "network" ||
      item.type === "console" ||
      input.failedNames.some((name) => text.includes(name))
    ) {
      refs.add(item.id);
    }
  }
  return Array.from(refs).slice(-12);
}

function sourceRefs(sources: SourceReadEnvelope[], pattern: RegExp) {
  return sources
    .filter((source) => pattern.test(`${source.kind}\n${source.title}\n${source.summary}\n${source.uri ?? ""}`))
    .map((source) => source.id);
}

function parseDiffHunks(diff: string | undefined) {
  if (!diff?.trim()) return [];
  const hunks: Array<{
    file: string;
    hunk?: string;
    lineStart?: number;
    lineEnd?: number;
    addedLines: Array<{ line: number; text: string }>;
  }> = [];
  let currentFile = "";
  let currentHunk = "";
  let currentLine: number | undefined;
  let addedLines: Array<{ line: number; text: string }> = [];
  function flush() {
    if (currentFile && (currentHunk || addedLines.length > 0)) {
      hunks.push({
        file: currentFile,
        hunk: currentHunk || undefined,
        lineStart: addedLines[0]?.line,
        lineEnd: addedLines.at(-1)?.line,
        addedLines
      });
    }
    addedLines = [];
  }
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      flush();
      currentFile = fileMatch[2];
      currentHunk = "";
      currentLine = undefined;
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      currentHunk = line;
      const lineMatch = line.match(/\+(\d+)(?:,\d+)?/);
      currentLine = lineMatch ? Number(lineMatch[1]) : undefined;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push({ line: currentLine ?? 0, text: line.slice(1) });
      if (currentLine !== undefined) currentLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
    if (currentLine !== undefined && currentHunk) {
      currentLine += 1;
    }
  }
  flush();
  return hunks.filter((item) => item.file);
}

function pushSignal(signals: DiagnosticSignal[], signal: DiagnosticSignal) {
  if (!signal.value.trim()) return;
  if (signal.value.trim().length < 3) return;
  if (signals.some((item) => item.kind === signal.kind && item.value === signal.value)) return;
  signals.push(signal);
}

function normalizeStackFile(rawFile: string) {
  let file = rawFile.trim();
  try {
    if (/^https?:\/\//i.test(file)) {
      file = new URL(file).pathname;
    }
  } catch {
    // Keep the raw frame when it is not a valid URL.
  }
  file = decodeURIComponent(file)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("?")[0]
    .split("#")[0];
  if (file.includes("node_modules/")) return undefined;
  const srcIndex = file.indexOf("/src/");
  if (srcIndex >= 0) file = file.slice(srcIndex + 1);
  return file;
}

function consoleSignals(consoleEvents: VisualRunResult["console"]) {
  const signals: DiagnosticSignal[] = [];
  const commonWords = new Set(["error", "failed", "cannot", "undefined", "reading", "function", "object", "promise", "exception"]);
  for (const entry of consoleEvents) {
    if (!/error|exception|failed|trace/i.test(`${entry.type} ${entry.text}`)) continue;
    for (const match of entry.text.matchAll(/(?:https?:\/\/[^\s)]+|\/?[^()\s]+?\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)):(\d+)(?::\d+)?/gi)) {
      const rawFrame = match[0].replace(/:(\d+)(?::\d+)?$/, "");
      const line = match[1];
      const file = normalizeStackFile(rawFrame);
      if (!file) continue;
      const basename = file.split("/").filter(Boolean).at(-1) ?? file;
      for (const value of Array.from(new Set([file, basename, `${file}:${line}`, `${basename}:${line}`]))) {
        pushSignal(signals, {
          kind: "console_stack",
          value,
          reason: `Console stack frame ${file}:${line}`,
          confidence: "high"
        });
      }
    }
    for (const match of entry.text.matchAll(/\b[A-Za-z_$][\w$]{4,}\b/g)) {
      const value = match[0];
      if (commonWords.has(value.toLowerCase())) continue;
      pushSignal(signals, {
        kind: "console_message",
        value,
        reason: `Console error token ${value}`,
        confidence: "medium"
      });
      if (signals.filter((signal) => signal.kind === "console_message").length >= 6) break;
    }
  }
  return signals;
}

function diagnosticSignals(input: {
  failedNames: string[];
  network: VisualRunResult["network"];
  console: VisualRunResult["console"];
  impactAnalysis?: ImpactAnalysis;
  evidence?: VisualRunResult["evidence"];
  sourceContexts?: SourceReadEnvelope[];
}): DiagnosticSignal[] {
  const signals: DiagnosticSignal[] = [];
  for (const name of input.failedNames) {
    pushSignal(signals, {
      kind: "assertion",
      value: name,
      reason: `Failed assertion: ${name}`,
      confidence: "medium"
    });
  }
  for (const entry of input.network) {
    const failedNetwork = !entry.status || entry.status >= 400;
    try {
      const parsed = new URL(entry.url);
      pushSignal(signals, {
        kind: "network_endpoint",
        value: parsed.pathname,
        reason: `${failedNetwork ? "Failed" : "Observed"} network request ${entry.method} ${parsed.pathname}`,
        confidence: failedNetwork ? "high" : "medium"
      });
      if (entry.status) {
        pushSignal(signals, {
          kind: "network_status",
          value: String(entry.status),
          reason: `Network status ${entry.status} for ${parsed.pathname}`,
          confidence: entry.status >= 400 ? "high" : "low"
        });
      }
      for (const [key, value] of parsed.searchParams.entries()) {
        pushSignal(signals, {
          kind: "query_param",
          value: `${key}=${value}`,
          reason: `Network query parameter ${key}=${value}`,
          confidence: failedNetwork ? "high" : "medium"
        });
        pushSignal(signals, {
          kind: "query_param",
          value,
          reason: `Network query value ${value}`,
          confidence: "medium"
        });
      }
    } catch {
      for (const part of entry.url.split(/[/?&=.-]/g)) {
        pushSignal(signals, {
          kind: "network_endpoint",
          value: part,
          reason: `Network URL token from ${entry.url}`,
          confidence: failedNetwork ? "medium" : "low"
        });
      }
    }
  }
  for (const signal of consoleSignals(input.console)) {
    pushSignal(signals, signal);
  }
  for (const item of input.evidence ?? []) {
    if (item.type !== "dom") continue;
    const text = JSON.stringify(item.payload);
    for (const match of text.matchAll(/data-testid=["']?([A-Za-z0-9_:-]+)/g)) {
      pushSignal(signals, {
        kind: "dom_test_id",
        value: match[1],
        reason: `DOM snapshot contains data-testid=${match[1]}`,
        confidence: "medium"
      });
    }
  }
  for (const source of input.sourceContexts ?? []) {
    for (const operation of source.readMeta?.openApi?.operations ?? []) {
      pushSignal(signals, {
        kind: "openapi_operation",
        value: operation.operationId ?? `${operation.method} ${operation.path}`,
        reason: `OpenAPI operation ${operation.operationId ?? `${operation.method} ${operation.path}`}`,
        confidence: "medium"
      });
      pushSignal(signals, {
        kind: "network_endpoint",
        value: operation.path,
        reason: `OpenAPI endpoint ${operation.method} ${operation.path}`,
        confidence: "medium"
      });
    }
  }
  for (const item of [
    ...(input.impactAnalysis?.affectedComponents ?? []),
    ...(input.impactAnalysis?.affectedApis ?? [])
  ]) {
    pushSignal(signals, {
      kind: "impact_target",
      value: item.target,
      reason: item.reason,
      confidence: item.confidence
    });
    for (const part of item.target.split(/[\s/?&=.:_-]/g)) {
      pushSignal(signals, {
        kind: "impact_target",
        value: part,
        reason: `Token from impacted target ${item.target}`,
        confidence: item.confidence === "high" ? "medium" : "low"
      });
    }
  }
  return signals.filter((signal) => signal.value.trim().length >= 3);
}

function signalMatchesText(signal: DiagnosticSignal, text: string) {
  const value = signal.value.toLowerCase();
  if (!value) return false;
  if (text.includes(value)) return true;
  if (signal.kind === "network_endpoint") {
    const endpointTail = value.split("/").filter(Boolean).at(-1);
    return Boolean(endpointTail && endpointTail.length >= 4 && text.includes(endpointTail));
  }
  if (signal.kind === "console_stack") {
    const frameFile = value.split(":")[0];
    const parts = frameFile.split("/").filter(Boolean);
    const basename = parts.at(-1);
    const tail = parts.slice(-2).join("/");
    return Boolean(
      text.includes(frameFile) ||
      (tail.length >= 4 && text.includes(tail)) ||
      (basename && basename.length >= 4 && text.includes(basename))
    );
  }
  return false;
}

function confidenceScore(confidence: DiagnosticSignal["confidence"]) {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function changeConfidence(input: {
  fileImpactHit: boolean;
  matchedSignals: DiagnosticSignal[];
}): FailureAttribution["confidence"] {
  if (input.fileImpactHit) return "high";
  if (input.matchedSignals.some((signal) => signal.kind === "network_endpoint" && signal.confidence === "high")) {
    return "high";
  }
  if (input.matchedSignals.some((signal) => signal.kind === "query_param" && signal.confidence === "high")) {
    return "high";
  }
  if (input.matchedSignals.some((signal) => signal.kind === "console_stack" && signal.confidence === "high")) {
    return "high";
  }
  if (input.matchedSignals.length > 0) return "medium";
  return "low";
}

function changeReason(input: {
  fileImpactHit: boolean;
  matchedSignals: DiagnosticSignal[];
}) {
  if (input.fileImpactHit) {
    return "Changed file appears directly in impact analysis.";
  }
  const endpoint = input.matchedSignals.find((signal) => signal.kind === "network_endpoint");
  const status = input.matchedSignals.find((signal) => signal.kind === "network_status");
  const query = input.matchedSignals.find((signal) => signal.kind === "query_param");
  const stack = input.matchedSignals.find((signal) => signal.kind === "console_stack");
  const operation = input.matchedSignals.find((signal) => signal.kind === "openapi_operation");
  const testId = input.matchedSignals.find((signal) => signal.kind === "dom_test_id");
  if (stack) {
    return `Diff hunk matches console stack frame ${stack.value}.`;
  }
  if (operation && endpoint) {
    return `Diff hunk matches OpenAPI operation ${operation.value} and endpoint ${endpoint.value}.`;
  }
  if (testId) {
    return `Diff hunk matches DOM test-id ${testId.value}.`;
  }
  if (endpoint && status) {
    return `Diff hunk matches failed network endpoint ${endpoint.value} and status ${status.value}.`;
  }
  if (endpoint && query) {
    return `Diff hunk matches failed network endpoint ${endpoint.value} and query ${query.value}.`;
  }
  if (endpoint) {
    return `Diff hunk matches failed network endpoint ${endpoint.value}.`;
  }
  if (input.matchedSignals.length > 0) {
    return `Diff hunk matched diagnostic signal(s): ${input.matchedSignals.map((signal) => `${signal.kind}=${signal.value}`).slice(0, 4).join(", ")}.`;
  }
  return "Changed file from current diff.";
}

function buildChangeRefs(input: {
  diff?: string;
  failedNames: string[];
  network: VisualRunResult["network"];
  console: VisualRunResult["console"];
  impactAnalysis?: ImpactAnalysis;
  evidence?: VisualRunResult["evidence"];
  sourceContexts?: SourceReadEnvelope[];
}) {
  const hunks = parseDiffHunks(input.diff);
  const affected = [
    ...(input.impactAnalysis?.affectedComponents ?? []),
    ...(input.impactAnalysis?.affectedApis ?? [])
  ];
  const signals = diagnosticSignals(input);
  const refs = hunks.map((hunk) => {
    const text = `${hunk.file}\n${hunk.hunk ?? ""}\n${hunk.addedLines.map((line) => line.text).join("\n")}`.toLowerCase();
    const matchedDiagnosticSignals = signals.filter((signal) => signalMatchesText(signal, text));
    const matchedSignals = matchedDiagnosticSignals.map((signal) => signal.value);
      const fileImpactHit = affected.some((item) =>
      item.kind !== "api" &&
      (hunk.file.includes(item.target) || item.target.includes(hunk.file) || hunk.file.endsWith(item.target) || item.target.endsWith(hunk.file))
      );
    const sourceMapHit = matchedDiagnosticSignals.some((signal) => signal.kind === "console_stack" && /src\//.test(signal.value));
    if (sourceMapHit) {
      matchedDiagnosticSignals.push({
        kind: "source_map",
        value: hunk.file,
        reason: "Console stack frame mapped to a source file in the diff hunk.",
        confidence: "high"
      });
    }
    const confidence = changeConfidence({ fileImpactHit, matchedSignals: matchedDiagnosticSignals });
    const score =
      (fileImpactHit ? 20 : 0) +
      matchedDiagnosticSignals.reduce((sum, signal) => sum + confidenceScore(signal.confidence), 0) +
      (confidence === "high" ? 5 : confidence === "medium" ? 2 : 0);
    return {
      file: hunk.file,
      hunk: hunk.hunk,
      lineStart: hunk.lineStart,
      lineEnd: hunk.lineEnd,
      matchedSignals: matchedSignals.slice(0, 8),
      diagnosticSignals: matchedDiagnosticSignals.slice(0, 8),
      addedLines: hunk.addedLines.filter((line) => {
        const lineText = line.text.toLowerCase();
        return matchedDiagnosticSignals.some((signal) => signalMatchesText(signal, lineText));
      }).slice(0, 5),
      reason: changeReason({ fileImpactHit, matchedSignals: matchedDiagnosticSignals }),
      confidence,
      score
    };
  });
  return refs
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score: _score, ...ref }) => ref);
}

function buildTopSuspects(input: {
  changeRefs: ReturnType<typeof buildChangeRefs>;
  evidenceRefs: string[];
  sourceContextIds: string[];
  fallbackSuggestedFix: string;
}): NonNullable<FailureAttribution["topSuspects"]> {
  return input.changeRefs
    .filter((ref) => input.evidenceRefs.length > 0 || input.sourceContextIds.length > 0)
    .slice(0, 3)
    .map((ref) => {
      const apiEndpoint = ref.diagnosticSignals?.find((signal) => signal.kind === "network_endpoint")?.value;
      const openApiOperationId = ref.diagnosticSignals?.find((signal) => signal.kind === "openapi_operation")?.value;
      const domTestId = ref.diagnosticSignals?.find((signal) => signal.kind === "dom_test_id")?.value;
      const stackComponent = ref.diagnosticSignals?.find((signal) => signal.kind === "console_stack")?.value;
      const fileComponent = ref.file.split("/").at(-1)?.replace(/\.(tsx?|jsx?|vue|svelte)$/i, "");
      return {
        filePath: ref.file,
        lineStart: ref.lineStart,
        lineEnd: ref.lineEnd,
        componentName: stackComponent?.split("/").at(-1)?.split(".")[0] ?? fileComponent,
        apiEndpoint,
        openApiOperationId,
        domTestId,
        reason: ref.reason,
        confidence: ref.confidence,
        evidenceRefs: input.evidenceRefs.slice(0, 8),
        sourceContextIds: input.sourceContextIds.slice(0, 6),
        suggestedFix: ref.diagnosticSignals?.some((signal) => signal.kind === "console_stack")
          ? "优先检查该文件附近的渲染/状态访问逻辑，并用关联截图与 console evidence 复现。"
          : ref.diagnosticSignals?.some((signal) => signal.kind === "dom_test_id")
            ? "优先检查该 test-id 对应组件的渲染条件、选择器契约和断言预期。"
            : ref.diagnosticSignals?.some((signal) => signal.kind === "openapi_operation")
              ? "优先检查 OpenAPI operation 对应 handler、schema 和前端调用参数。"
          : ref.diagnosticSignals?.some((signal) => signal.kind === "network_endpoint")
            ? "优先检查该文件关联的接口路径、请求参数和响应 schema，并对照 network evidence。"
            : input.fallbackSuggestedFix
      };
    });
}

export function buildFailureAttributions(input: {
  assertions: VisualRunResult["assertions"];
  steps: VisualRunResult["steps"];
  network: VisualRunResult["network"];
  console: VisualRunResult["console"];
  evidence: VisualRunResult["evidence"];
  sourceContexts: SourceReadEnvelope[];
  impactAnalysis?: ImpactAnalysis;
  diff?: string;
}): FailureAttribution[] {
  const failedAssertions = input.assertions.filter((assertion) => !assertion.passed);
  if (failedAssertions.length === 0) return [];
  const failedNames = failedAssertions.map((assertion) => assertion.name);
  const evidenceRefs = evidenceRefsForFailure({ failedNames, evidence: input.evidence });
  const networkFailures = input.network.filter((entry) => !entry.status || entry.status >= 400);
  const environmentNetworkFailures = networkFailures.filter((entry) => (entry.status ?? 0) >= 500 || (entry as unknown as Record<string, unknown>).failed === true);
  const consoleErrors = input.console.filter((entry) => /error|exception|failed/i.test(`${entry.type} ${entry.text}`));
  const recentSteps = input.steps.slice(-3).map((step) => `${step.title}: ${step.status}`).join(" -> ");
  const changedTargets = [
    ...(input.impactAnalysis?.affectedComponents.map((item) => item.target) ?? []),
    ...(input.impactAnalysis?.affectedApis.map((item) => item.target) ?? [])
  ].slice(0, 6);
  const changeRefs = buildChangeRefs({
    diff: input.diff,
    failedNames,
    network: input.network,
    console: input.console,
    impactAnalysis: input.impactAnalysis,
    evidence: input.evidence,
    sourceContexts: input.sourceContexts
  });
  const changedContext = changedTargets.length ? `；受影响目标=${changedTargets.join(", ")}` : "";
  const attributions: FailureAttribution[] = [];

  if (networkFailures.length > 0) {
    const sourceContextIds = sourceRefs(input.sourceContexts, /diff|openapi|api|pull request|pr/i);
    const suggestedFix = changedTargets.length
      ? `优先检查本次影响面命中的 ${changedTargets.join(", ")}，再核对 API handler、mock 数据、接口状态码和前端错误处理。`
      : "优先检查相关 API handler、mock 数据、接口状态码和前端错误处理。";
    attributions.push({
      id: `attr_network_${Date.now()}`,
      rank: attributions.length + 1,
      failureClass: environmentNetworkFailures.length ? "environment_issue" : "product_bug",
      title: environmentNetworkFailures.length ? "上游接口或测试环境返回 5xx" : "接口失败或异常响应最可能导致断言失败",
      reasoning: `失败断言=${failedNames.join(", ")}；网络失败=${networkFailures.map((entry) => `${entry.status ?? "failed"} ${entry.url}`).slice(0, 4).join(" | ")}${changedContext}。`,
      reproductionSteps: input.steps.map((step) => step.title),
      suggestedFix,
      changeRefs,
      evidenceRefs,
      sourceContextIds,
      topSuspects: buildTopSuspects({ changeRefs, evidenceRefs, sourceContextIds, fallbackSuggestedFix: suggestedFix }),
      confidence: "high"
    });
  }

  if (consoleErrors.length > 0) {
    const sourceContextIds = sourceRefs(input.sourceContexts, /diff|requirement|bug|issue|jira/i);
    const suggestedFix = "检查 console stack、组件渲染分支和运行时依赖是否与本次变更一致。";
    attributions.push({
      id: `attr_console_${Date.now()}`,
      rank: attributions.length + 1,
      failureClass: "product_bug",
      title: "浏览器 console 错误与失败时间线相关",
      reasoning: `最近步骤=${recentSteps}；console error=${consoleErrors.map((entry) => entry.text).slice(0, 3).join(" | ")}${changedContext}。`,
      reproductionSteps: input.steps.map((step) => step.title),
      suggestedFix,
      changeRefs,
      evidenceRefs,
      sourceContextIds,
      topSuspects: buildTopSuspects({ changeRefs, evidenceRefs, sourceContextIds, fallbackSuggestedFix: suggestedFix }),
      confidence: "medium"
    });
  }

  const selectorLike = failedAssertions.some((assertion) => assertion.fact?.failureClass === "test_script_issue");
  const assertionSourceContextIds = sourceRefs(input.sourceContexts, /diff|requirement|bug|issue|jira|openapi/i);
  const assertionSuggestedFix = selectorLike
    ? "检查 selector registry 与页面可访问名称/test-id 是否一致。"
    : "对照需求、截图、DOM snapshot 和 assertion fact 判断是产品行为变化还是需求变更。";
  attributions.push({
    id: `attr_assertion_${Date.now()}`,
    rank: attributions.length + 1,
    failureClass: selectorLike ? "test_script_issue" : failedAssertions[0]?.fact?.failureClass ?? "unknown",
    title: selectorLike ? "选择器或页面结构可能已变化" : "结构化断言未满足",
    reasoning: `失败断言=${failedNames.join(", ")}；最近执行步骤=${recentSteps || "无步骤记录"}${changedContext}。`,
    reproductionSteps: input.steps.map((step) => step.title),
    suggestedFix: assertionSuggestedFix,
    changeRefs,
    evidenceRefs,
    sourceContextIds: assertionSourceContextIds,
    topSuspects: buildTopSuspects({
      changeRefs,
      evidenceRefs,
      sourceContextIds: assertionSourceContextIds,
      fallbackSuggestedFix: assertionSuggestedFix
    }),
    confidence: selectorLike ? "high" : "medium"
  });

  return attributions.map((item, index) => ({ ...item, rank: index + 1 }));
}
