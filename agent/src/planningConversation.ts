import type { CodeImpactGraph, CodeGraphNode } from "./codeImpactGraph.js";
import type { BusinessCapabilityGraph, BusinessSourceLocation } from "./businessCapabilityGraph.js";
import { compileBusinessPaths } from "./businessPathCompiler.js";
import type { GrayPlan, IntakeAnalysis, ProjectConfig } from "./types.js";
import { getScenario, hasScenario } from "./scenarios.js";
import type { LlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import type { DiscoveryConnectivityResult } from "./smokeFirstDiscovery.js";
import type { BusinessFunction, ProjectOverview } from "./businessFunctionCompiler.js";

export type PlanningPhase = "clarifying" | "draft-ready";
export type BusinessFlowStatus = "executable" | "auto-bindable" | "needs-input" | "coverage-gap";

export interface PlanningMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface PlannedBusinessFlow {
  id: string;
  title: string;
  kind: "page" | "component" | "api" | "scenario" | "data" | "background-task";
  target: string;
  status: BusinessFlowStatus;
  confidence: "high" | "medium" | "low";
  reason: string;
  scenarioId?: string;
  requiredInformation: string[];
  /** Code-graph nodes represented by this business flow. Large repositories
   * are grouped into auditable feature flows instead of presenting every
   * component symbol as an independently executable test. */
  sourceNodeIds?: string[];
  sourceCount?: number;
  /** BusinessCapabilityGraph v2 details. The old fields remain so saved plans
   * and older Workbench clients can continue reading this response. */
  pathVersion?: "2.0";
  summary?: string;
  surfaces?: Array<"page" | "api" | "data" | "background-task">;
  risk?: "low" | "medium" | "high";
  roles?: string[];
  actionCandidates?: string[];
  oracleCandidates?: string[];
  requiredEvidenceKinds?: string[];
  sourceLocations?: BusinessSourceLocation[];
}

export interface PlanningConversationResult {
  id: string;
  phase: PlanningPhase;
  reply: string;
  clarificationQuestions: string[];
  businessFlows: PlannedBusinessFlow[];
  /** User-facing capability summary. businessFlows remains the internal execution inventory. */
  businessFunctions?: BusinessFunction[];
  projectOverview?: ProjectOverview;
  businessFunctionCount?: number;
  technicalPathCount?: number;
  businessFunctionSnapshotHash?: string;
  businessFunctionConfidence?: BusinessFunction["confidence"];
  businessFunctionPage?: {
    cursor?: string;
    nextCursor?: string;
    total: number;
    limit: number;
  };
  /** Initial page only. The complete immutable inventory is persisted by the
   * planning route and fetched through the cursor endpoint. */
  businessFlowPage?: {
    cursor?: string;
    nextCursor?: string;
    total: number;
    limit: number;
  };
  coverage: {
    discovered: number;
    executable: number;
    autoBindable: number;
    needsInput: number;
    gaps: number;
    /** Raw code-graph candidates represented by the grouped business flows. */
    sourceCandidates?: number;
    confidence: "high" | "medium" | "low";
    scope: "targeted" | "comprehensive";
  };
  plan: GrayPlan;
  analysis: IntakeAnalysis;
  recommendedScenarioId?: string;
  businessGraph?: {
    version: "2.0";
    sourceFileCount: number;
    projectSnapshotHash: string;
    diagnostics: string[];
  };
  llmPlanning?: LlmPlanningAdvice;
  discoveryReadiness?: DiscoveryConnectivityResult;
}

const MAX_UNGROUPED_COVERAGE_NODES = 80;
const MAX_SOURCE_NODES_PER_GROUP = 24;

function featureKey(node: CodeGraphNode) {
  if (node.kind === "api-route") {
    const route = node.label.replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "");
    const parts = route.split(/[/?#]/).filter(Boolean).filter((part) => !/^v\d+$/i.test(part));
    return `api:${parts.slice(0, 2).join("/") || "root"}`;
  }
  const file = (node.file ?? node.label).replace(/\\/g, "/");
  const parts = file.split("/").filter(Boolean);
  const anchor = parts.findIndex((part) => /^(pages?|views?|components?|routes?|controllers?)$/i.test(part));
  if (anchor >= 0) {
    const next = parts[anchor + 1];
    const feature = next && !/\.[a-z0-9]+$/i.test(next) ? next : "root";
    return `${node.kind}:${parts[anchor]}/${feature}`;
  }
  return `${node.kind}:${parts.slice(0, -1).slice(-2).join("/") || "root"}`;
}

function groupCoverageNodes(nodes: CodeGraphNode[]) {
  if (nodes.length <= MAX_UNGROUPED_COVERAGE_NODES) return nodes.map((node) => [node]);
  const byFeature = new Map<string, CodeGraphNode[]>();
  for (const node of nodes) {
    const key = featureKey(node);
    byFeature.set(key, [...(byFeature.get(key) ?? []), node]);
  }
  const groups: CodeGraphNode[][] = [];
  for (const entries of [...byFeature.values()].sort((left, right) => featureKey(left[0]!).localeCompare(featureKey(right[0]!)))) {
    const sorted = [...entries].sort((left, right) => left.label.localeCompare(right.label));
    for (let index = 0; index < sorted.length; index += MAX_SOURCE_NODES_PER_GROUP) {
      groups.push(sorted.slice(index, index + MAX_SOURCE_NODES_PER_GROUP));
    }
  }
  if (groups.length <= MAX_UNGROUPED_COVERAGE_NODES) return groups;
  // Extremely fragmented repositories can have hundreds of one-file feature
  // folders. Preserve every source node, but combine them into a bounded
  // number of execution units so confirmation does not create hundreds of
  // synchronous browser/LLM loops.
  const compacted: CodeGraphNode[][] = [];
  for (const kind of ["page", "symbol", "api-route"] as const) {
    const entries = nodes
      .filter((node) => node.kind === kind)
      .sort((left, right) => `${featureKey(left)}:${left.label}`.localeCompare(`${featureKey(right)}:${right.label}`));
    if (!entries.length) continue;
    const quota = Math.max(1, Math.floor(MAX_UNGROUPED_COVERAGE_NODES * (entries.length / nodes.length)));
    const chunkSize = Math.ceil(entries.length / quota);
    for (let index = 0; index < entries.length; index += chunkSize) compacted.push(entries.slice(index, index + chunkSize));
  }
  return compacted;
}

function flowId(kind: string, value: string) {
  return `flow_${kind}_${Buffer.from(value).toString("base64url").slice(0, 18)}`;
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\.(tsx?|jsx?|py)$/i, "")
    .replace(/[/_.-]+/g, " ")
    .replace(/\b(page|route|index|app)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || value;
}

// User-facing title for an API-route flow. Raw labels like "GET /api/orders"
// or "/api/reports" are bare routes; strip the HTTP method and the /api/
// prefix so the flow reads as a function ("orders 接口流程") rather than a
// route table entry. Controller-style labels ("usersController.list") are
// still humanized via camelCase/separator splitting.
function apiFlowTitle(label: string): string {
  const path = label
    .replace(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i, "")
    .replace(/^\/+api\/+(v?\d+\/)?/i, "")
    .replace(/^\/+/, "");
  return `${humanize(path)} 接口流程`;
}

function uniqueNodes(nodes: CodeGraphNode[], kind: CodeGraphNode["kind"]) {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (node.kind !== kind || seen.has(node.label)) return false;
    seen.add(node.label);
    return true;
  });
}

function buildFlows(input: {
  project: ProjectConfig;
  graph: CodeImpactGraph;
  capabilityGraph?: BusinessCapabilityGraph;
  analysis: IntakeAnalysis;
  goal: string;
  comprehensive: boolean;
  discoveryReadiness?: DiscoveryConnectivityResult;
}): PlannedBusinessFlow[] {
  const runtimeBlocked = Boolean(input.discoveryReadiness && input.discoveryReadiness.status !== "ready");
  // A full scan is a code-derived inventory first. Runtime readiness decides
  // whether the inventory may execute, not whether users can see the flows
  // discovered from their uploaded project.
  if (runtimeBlocked && !input.comprehensive && !input.capabilityGraph) {
    const readiness = input.discoveryReadiness!;
    const blocked = readiness.status === "blocked";
    const failed = readiness.status === "failed";
    return [{
      id: flowId("smoke", readiness.checkedUrl),
      title: "项目连通性与页面基线",
      kind: "page",
      target: readiness.checkedUrl,
      status: "needs-input",
      confidence: "high",
      reason: blocked
        ? `运行前置条件尚未满足：${readiness.reason}`
        : failed
          ? `连通性 smoke 已完成有限重试但仍失败：${readiness.reason}`
          : `项目仍在启动或恢复：${readiness.reason}`,
      requiredInformation: blocked
        ? ["解决项目运行、凭据或权限前置条件后重新检查"]
        : failed
          ? ["查看启动与健康检查日志，修复连通性后重新执行 smoke"]
          : ["等待项目运行状态变为 ready 后自动继续"]
    }];
  }
  const flows: PlannedBusinessFlow[] = [];
  const supportsBrowserDiscovery = input.project.manifest?.capabilities.browser !== false;
  const runtimeReason = runtimeBlocked
    ? `运行时页面预检尚未完成（${input.discoveryReadiness?.reason ?? "等待页面状态"}）；该代码路径已列入清单，确认执行时会先恢复页面状态再绑定动作与 oracle。`
    : undefined;
  if (input.capabilityGraph) {
    const compiled = compileBusinessPaths({
      graph: input.capabilityGraph,
      goal: input.goal,
      comprehensive: input.comprehensive,
      browserEnabled: supportsBrowserDiscovery
    });
    for (const path of compiled) {
      const primarySurface = path.surfaces.includes("page") ? "page"
        : path.surfaces.includes("api") ? "api"
          : path.surfaces.includes("data") ? "data"
            : "background-task";
      const status: BusinessFlowStatus = runtimeBlocked && path.status === "auto-bindable"
        ? "auto-bindable"
        : path.status;
      flows.push({
        id: path.id,
        title: path.title,
        kind: primarySurface,
        target: path.sourceLocations[0]?.file ?? path.id,
        status,
        confidence: path.confidence,
        reason: runtimeBlocked && path.status === "auto-bindable" ? `${path.reason} ${runtimeReason}` : path.reason,
        requiredInformation: path.preconditions,
        pathVersion: "2.0",
        summary: path.summary,
        surfaces: path.surfaces,
        risk: path.risk,
        roles: path.roles,
        actionCandidates: path.actionCandidates,
        oracleCandidates: path.oracleCandidates,
        requiredEvidenceKinds: path.requiredEvidenceKinds,
        sourceNodeIds: path.sourceNodeIds,
        sourceCount: path.sourceNodeIds.length,
        sourceLocations: path.sourceLocations
      });
    }
    // Existing verified scenarios are retained as separate executable
    // contracts. They complement the discovered inventory instead of hiding
    // it behind a scenario-registry-only plan.
  }
  for (const candidate of input.analysis.scenarioCandidates.filter((item) => item.source !== "patrol" && item.mappedScenarioId)) {
    const scenario = candidate.mappedScenarioId && hasScenario(candidate.mappedScenarioId)
      ? getScenario(candidate.mappedScenarioId)
      : undefined;
    const targetCompatible = Boolean(scenario && (
      scenario.genericTemplate
      || scenario.matcher?.projectIds?.includes(input.project.id)
    ));
    if (scenario && !targetCompatible) continue;
    const executable = candidate.executable && targetCompatible && !runtimeBlocked;
    flows.push({
      id: flowId("scenario", candidate.mappedScenarioId ?? candidate.id),
      title: candidate.title,
      kind: "scenario",
      target: candidate.mappedScenarioId ?? candidate.id,
      status: executable ? "executable" : runtimeBlocked && targetCompatible ? "auto-bindable" : "coverage-gap",
      confidence: executable ? "high" : "medium",
      reason: executable ? candidate.reason : runtimeBlocked && targetCompatible ? runtimeReason! : `${candidate.reason} 该场景尚未验证与当前项目的页面合同兼容。`,
      scenarioId: candidate.mappedScenarioId,
      requiredInformation: executable || (runtimeBlocked && targetCompatible) ? [] : ["需要生成并验证该功能的页面动作与断言"]
    });
  }

  for (const node of uniqueNodes(input.graph.nodes, "scenario")) {
    if (!hasScenario(node.label) || flows.some((flow) => flow.scenarioId === node.label)) continue;
    const scenario = getScenario(node.label);
    const targetCompatible = Boolean(
      scenario.genericTemplate
      || scenario.matcher?.projectIds?.includes(input.project.id)
    );
    if (!targetCompatible) continue;
    flows.push({
      id: flowId("scenario", scenario.id),
      title: scenario.title,
      kind: "scenario",
      target: scenario.id,
      status: runtimeBlocked ? "auto-bindable" : "executable",
      confidence: node.confidence,
      reason: runtimeBlocked ? runtimeReason! : `代码图中的页面、接口或符号命中了经过验证的场景 ${scenario.id}。`,
      scenarioId: scenario.id,
      requiredInformation: []
    });
  }

  // BusinessCapabilityGraph v2 already represents all static entries and
  // their transitive code links. Do not append the old page/component/API
  // directory heuristic on top of it, or every source is shown twice.
  if (input.capabilityGraph) return flows;

  const pageNodes = uniqueNodes(input.graph.nodes, "page");
  const apiNodes = uniqueNodes(input.graph.nodes, "api-route");
  const componentNodes = uniqueNodes(input.graph.nodes, "symbol")
    .filter((node) => /(^|\/)components?\//i.test(node.file ?? "")
      && /^[A-Z]/.test(node.label)
      && (node.symbolType === "function" || node.symbolType === "class"));
  const selectedNodes = input.comprehensive
    ? [...pageNodes, ...componentNodes, ...apiNodes]
    : [...pageNodes.slice(0, 12), ...componentNodes.slice(0, 12), ...apiNodes.slice(0, 12)];

  for (const nodes of groupCoverageNodes(selectedNodes)) {
    const node = nodes[0]!;
    const kind = node.kind === "page" ? "page" : node.kind === "symbol" ? "component" : "api";
    const grouped = nodes.length > 1;
    const groupBaseTarget = grouped ? featureKey(node) : node.label;
    // A large feature may be split into several bounded execution units.  The
    // human-facing feature name is shared, but every chunk needs a stable,
    // distinct target; otherwise the duplicate guard silently discards all
    // chunks after the first and the coverage inventory loses source nodes.
    const groupTarget = grouped
      ? `${groupBaseTarget}#${Buffer.from(nodes.map((item) => item.id).join("|")).toString("base64url").slice(0, 12)}`
      : groupBaseTarget;
    const duplicate = flows.some((flow) => flow.kind === kind && flow.target === groupTarget);
    if (duplicate) continue;
    const sampleTargets = nodes.slice(0, 3).map((item) => humanize(item.label)).join("、");
    const groupTitle = kind === "page" ? "页面与导航"
      : kind === "component" ? "界面功能"
        : "接口功能";
    flows.push({
      id: flowId(kind, groupTarget),
      title: grouped
        ? `${humanize(groupBaseTarget.replace(/^[^:]+:/, ""))} ${groupTitle}（${nodes.length} 项）`
        : kind === "page"
        ? `${/(^|\/)App$/i.test(node.label) ? "应用主界面" : humanize(node.label)} 页面流程`
        : kind === "component"
          ? `${humanize(node.label)} 功能`
          : apiFlowTitle(node.label),
      kind,
      target: groupTarget,
      status: supportsBrowserDiscovery ? "auto-bindable" : "coverage-gap",
      confidence: node.confidence,
      reason: runtimeReason ?? (grouped
        ? `代码扫描发现 ${nodes.length} 个属于同一功能域的${groupTitle}候选（如 ${sampleTargets}）；系统将它们作为一条可审计业务路径，在真实页面中继续拆解动作和 oracle。`
        : kind === "page"
        ? supportsBrowserDiscovery
          ? `代码扫描发现页面入口 ${node.label}；确认计划后会在内置浏览器中自动发现控件、绑定动作并验证断言。`
          : `代码扫描发现页面入口 ${node.label}，但当前项目未开放浏览器 Discovery。`
        : kind === "component"
          ? supportsBrowserDiscovery
            ? `代码扫描发现业务界面组件 ${node.label}；系统会先用页面 Discovery 绑定真实入口，候选冲突时再由 LLM 排定路径。`
            : `代码扫描发现业务界面组件 ${node.label}，但当前项目未开放浏览器 Discovery。`
          : supportsBrowserDiscovery
            ? `代码扫描发现接口 ${node.label}；系统会结合运行时 Network 与页面结果生成受控接口场景。`
            : `代码扫描发现接口 ${node.label}，但尚未绑定输入数据、预期状态和页面结果。`),
      requiredInformation: supportsBrowserDiscovery
        ? []
        : kind === "page" || kind === "component"
          ? ["需要开放浏览器 Discovery 或手工提供页面入口和验收结果"]
          : ["需要确认请求前置条件、测试数据和预期响应"],
      sourceNodeIds: nodes.map((item) => item.id),
      sourceCount: nodes.length
    });
  }
  // A comprehensive scan is an inventory, not an execution batch.  Truncating
  // the inventory made a large uploaded project look fully scanned while any
  // flow after the 200th code-graph node silently disappeared.  Later stages
  // can apply concurrency and execution budgets, but every discovered flow
  // must be shown and receive an explicit executed/excluded/blocked
  // disposition in the parent run.
  return flows;
}

function buildPlan(project: ProjectConfig, flows: PlannedBusinessFlow[], comprehensive: boolean): GrayPlan {
  const executable = flows.filter((flow) => flow.status === "executable");
  const autoBindable = flows.filter((flow) => flow.status === "auto-bindable");
  const gaps = flows.filter((flow) => flow.status === "coverage-gap" || flow.status === "needs-input");
  return {
    sessionName: `${project.name} · ${comprehensive ? "全面灰度测试" : "需求定向测试"}`,
    risks: [
      ...executable.slice(0, 20).map((flow) => ({
        id: `risk_${flow.id}`,
        level: "high" as const,
        title: flow.title,
        evidence: `需要运行 ${flow.target} 并采集截图、DOM、Network 与 Trace。`
      })),
      ...autoBindable.slice(0, 20).map((flow) => ({
        id: `bind_${flow.id}`,
        level: "medium" as const,
        title: `${flow.title} 等待自动绑定`,
        evidence: "确认计划后由内置浏览器 Discovery 绑定真实元素、动作和 oracle；规则无法唯一判断时才调用 LLM。"
      })),
      ...gaps.slice(0, 20).map((flow) => ({
        id: `gap_${flow.id}`,
        level: "medium" as const,
        title: `${flow.title} 尚未形成自动化覆盖`,
        evidence: flow.reason
      }))
    ],
    levels: [
      {
        id: "core_path",
        title: "已识别业务流程",
        description: "按代码入口和已验证场景整理；只有标记为可执行的项目会进入自动化队列。",
        paths: flows.map((flow) => ({
          id: flow.id,
          title: flow.title,
          riskReason: flow.reason,
          expectedFrom: flow.scenarioId ? "existing_test" : "llm_inferred",
          retry: 0,
          steps: flow.status === "executable"
            ? ["打开目标功能", "执行核心业务操作", "验证业务结果", "采集运行证据"]
            : flow.status === "auto-bindable"
              ? ["在沙盒内打开真实页面", "自动发现并绑定元素或接口", "编译受控动作与业务断言", "执行并采集 Artifact v2"]
              : ["补充测试前置条件", "绑定页面或接口动作", "定义业务断言", "人工确认后再执行"]
        }))
      }
    ]
  };
}

export function buildPlanningConversation(input: {
  project: ProjectConfig;
  message: string;
  history: PlanningMessage[];
  graph: CodeImpactGraph;
  capabilityGraph?: BusinessCapabilityGraph;
  analysis: IntakeAnalysis;
  discoveryReadiness?: DiscoveryConnectivityResult;
}): PlanningConversationResult {
  // Only user messages are requirements. Assistant copy often contains the
  // words “全面扫描” as an instruction hint; including it here made every
  // later targeted request inherit the previous full-inventory scope.
  const userHistory = input.history
    .filter((item) => item.role === "user")
    .map((item) => item.content);
  const historyText = userHistory.join("\n");
  const currentMessage = input.message.trim();
  const comprehensivePattern = /全面|全量|所有业务|所有功能|完整灰度|full|comprehensive/i;
  const targetedPattern = /测试|验证|检查|工作流|业务流程|功能|登录|权限|订单|报告|导出|刷新/i;
  const currentIsComprehensive = comprehensivePattern.test(currentMessage);
  const currentIsTargeted = targetedPattern.test(currentMessage) && !currentIsComprehensive;
  const comprehensive = currentIsComprehensive
    || (!currentIsTargeted && comprehensivePattern.test(historyText));
  const fullText = [historyText, currentMessage].filter(Boolean).join("\n");
  // A concrete current request is the active scope. Earlier user requests are
  // retained as context only when the current message is a continuation.
  const goalText = currentIsTargeted ? currentMessage : [historyText, currentMessage].filter(Boolean).join("\n");
  const flows = buildFlows({
    project: input.project,
    graph: input.graph,
    capabilityGraph: input.capabilityGraph,
    analysis: input.analysis,
    goal: goalText,
    comprehensive,
    discoveryReadiness: input.discoveryReadiness
  });
  const loginSignals = input.graph.nodes.some((node) => /login|signin|auth|登录|认证/i.test(`${node.label} ${node.file ?? ""}`));
  const loginAnswered = /无需登录|不需要登录|测试账号|账号[:：]|用户名|密码|已配置登录/i.test(fullText);
  const destructiveSignals = /删除|支付|退款|审批|发布|发送|批量修改/i.test(fullText);
  const isolationAnswered = /测试数据|沙盒|临时数据库|允许写入|只读/i.test(fullText);
  const clarificationQuestions: string[] = [];
  const blockingQuestions: string[] = [];
  if (input.discoveryReadiness && input.discoveryReadiness.status !== "ready") {
    const question = input.discoveryReadiness.status === "waiting"
      ? "项目仍在启动或恢复；连通性 smoke 通过后，系统会自动展开完整业务流程清单。"
      : input.discoveryReadiness.status === "blocked"
        ? `项目存在必须先处理的运行前置条件：${input.discoveryReadiness.reason}`
        : `项目连通性 smoke 已有限重试但仍失败：${input.discoveryReadiness.reason}`;
    clarificationQuestions.push(question);
    // The runtime gate blocks execution, but a comprehensive scan still has a
    // useful, auditable code plan to show and confirm.
    if (!comprehensive) blockingQuestions.push(question);
  }
  if (loginSignals && (!input.project.login || input.project.login.method === "none") && !loginAnswered) {
    clarificationQuestions.push("项目包含登录或权限功能：是否提供测试账号，还是只验证未登录状态？");
  }
  if (destructiveSignals && !isolationAnswered) {
    const question = "需求包含可能修改数据的操作：是否使用沙盒测试数据，哪些操作禁止执行？";
    clarificationQuestions.push(question);
    blockingQuestions.push(question);
  }
  if (!flows.length) {
    const question = "代码中暂未识别到页面、接口或可执行场景。请说明最重要的入口页面和正确结果。";
    clarificationQuestions.push(question);
    blockingQuestions.push(question);
  }
  const executable = flows.filter((flow) => flow.status === "executable").length;
  const autoBindable = flows.filter((flow) => flow.status === "auto-bindable").length;
  const needsInput = flows.filter((flow) => flow.status === "needs-input").length;
  const gaps = flows.filter((flow) => flow.status === "coverage-gap").length;
  const sourceCandidates = input.capabilityGraph
    ? new Set(flows.flatMap((flow) => flow.sourceNodeIds ?? [])).size
    : flows.reduce((total, flow) => total + (flow.sourceCount ?? 1), 0);
  const phase: PlanningPhase = blockingQuestions.length ? "clarifying" : "draft-ready";
  const scope = comprehensive ? "comprehensive" as const : "targeted" as const;
  const reply = input.discoveryReadiness && input.discoveryReadiness.status !== "ready" && !comprehensive && !input.capabilityGraph
    ? input.discoveryReadiness.status === "waiting"
      ? `正在等待 ${input.project.name} 通过连通性 smoke。系统暂不展开大量候选流程，避免生成无法执行的阻塞清单。`
      : input.discoveryReadiness.status === "blocked"
        ? `${input.project.name} 的连通性 smoke 被前置条件阻塞。系统只保留一个启动基线，不会先生成大量流程再全部标记阻塞。`
        : `${input.project.name} 的连通性 smoke 在有限重试后仍失败。系统已停止 Coverage 展开，并保留具体失败原因供诊断。`
    : input.discoveryReadiness && input.discoveryReadiness.status !== "ready" && (comprehensive || input.capabilityGraph)
      ? `${comprehensive ? "代码全面扫描" : "代码定向分析"}已完成：${sourceCandidates} 个代码候选已归并为 ${flows.length} 条业务路径并显示在计划中。运行时页面预检尚未完成，因此这些路径会在确认执行后先恢复登录或页面状态，再绑定真实控件、动作和 oracle；它们没有被算作已测试或已通过。`
    : phase === "clarifying"
      ? `我扫描了 ${input.project.name}，将 ${sourceCandidates} 个代码候选归并为 ${flows.length} 条业务路径，其中 ${executable} 条已有可执行场景、${autoBindable} 条可由内置浏览器自动绑定、${gaps} 条仍需补充。开始制定最终计划前还需要确认 ${clarificationQuestions.length} 个问题。`
    : comprehensive
      ? `测试计划已生成：${sourceCandidates} 个代码候选已归并为 ${flows.length} 条业务路径，${executable} 条可以直接执行，${autoBindable} 条会在确认后交给 LangGraph 页面观测与受控动作循环；只有经过真实页面探测仍无法形成动作与断言的路径才会转为覆盖缺口。当前已有 ${gaps} 条明确缺口。${clarificationQuestions.length ? "仍有可选信息可以补充，但不影响确认计划。" : ""}`
      : `已根据你的测试目标从代码中定位 ${flows.length} 条相关业务路径：${executable} 条可以直接执行，${autoBindable} 条会在确认后交给 LangGraph 页面观测与受控动作循环，${gaps} 条需要补充条件。你可以先查看这组定向计划，再决定是否开始测试。`;
  return {
    id: `planning_${Date.now()}`,
    phase,
    reply,
    clarificationQuestions,
    businessFlows: flows,
    coverage: {
      discovered: flows.length,
      executable,
      autoBindable,
      needsInput,
      gaps,
      sourceCandidates,
      confidence: flows.length && gaps === 0 && autoBindable === 0 ? "high" : flows.length ? "medium" : "low",
      scope
    },
    plan: buildPlan(input.project, flows, comprehensive),
    analysis: input.analysis,
    businessGraph: input.capabilityGraph ? {
      version: input.capabilityGraph.version,
      sourceFileCount: input.capabilityGraph.sourceFileCount,
      projectSnapshotHash: input.capabilityGraph.projectSnapshotHash,
      diagnostics: input.capabilityGraph.diagnostics
    } : undefined,
    recommendedScenarioId: flows.find((flow) => flow.status === "executable")?.scenarioId,
    discoveryReadiness: input.discoveryReadiness
  };
}
