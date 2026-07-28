import type { CodeImpactGraph, CodeGraphNode } from "./codeImpactGraph.js";
import type { GrayPlan, IntakeAnalysis, ProjectConfig } from "./types.js";
import { getScenario, hasScenario } from "./scenarios.js";
import type { LlmPlanningAdvice } from "./llmPlanningAdvisor.js";

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
  kind: "page" | "component" | "api" | "scenario";
  target: string;
  status: BusinessFlowStatus;
  confidence: "high" | "medium" | "low";
  reason: string;
  scenarioId?: string;
  requiredInformation: string[];
}

export interface PlanningConversationResult {
  id: string;
  phase: PlanningPhase;
  reply: string;
  clarificationQuestions: string[];
  businessFlows: PlannedBusinessFlow[];
  coverage: {
    discovered: number;
    executable: number;
    autoBindable: number;
    needsInput: number;
    gaps: number;
    confidence: "high" | "medium" | "low";
    scope: "targeted" | "comprehensive";
  };
  plan: GrayPlan;
  analysis: IntakeAnalysis;
  recommendedScenarioId?: string;
  llmPlanning?: LlmPlanningAdvice;
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
  analysis: IntakeAnalysis;
  comprehensive: boolean;
}): PlannedBusinessFlow[] {
  const flows: PlannedBusinessFlow[] = [];
  const supportsBrowserDiscovery = input.project.manifest?.capabilities.browser !== false;
  for (const candidate of input.analysis.scenarioCandidates.filter((item) => item.source !== "patrol" && item.mappedScenarioId)) {
    const scenario = candidate.mappedScenarioId && hasScenario(candidate.mappedScenarioId)
      ? getScenario(candidate.mappedScenarioId)
      : undefined;
    const targetCompatible = Boolean(scenario && (
      scenario.genericTemplate
      || scenario.matcher?.projectIds?.includes(input.project.id)
    ));
    if (scenario && !targetCompatible) continue;
    const executable = candidate.executable && targetCompatible;
    flows.push({
      id: flowId("scenario", candidate.mappedScenarioId ?? candidate.id),
      title: candidate.title,
      kind: "scenario",
      target: candidate.mappedScenarioId ?? candidate.id,
      status: executable ? "executable" : "coverage-gap",
      confidence: executable ? "high" : "medium",
      reason: executable ? candidate.reason : `${candidate.reason} 该场景尚未验证与当前项目的页面合同兼容。`,
      scenarioId: candidate.mappedScenarioId,
      requiredInformation: executable ? [] : ["需要生成并验证该功能的页面动作与断言"]
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
      status: "executable",
      confidence: node.confidence,
      reason: `代码图中的页面、接口或符号命中了经过验证的场景 ${scenario.id}。`,
      scenarioId: scenario.id,
      requiredInformation: []
    });
  }

  const pageNodes = uniqueNodes(input.graph.nodes, "page");
  const apiNodes = uniqueNodes(input.graph.nodes, "api-route");
  const componentNodes = uniqueNodes(input.graph.nodes, "symbol")
    .filter((node) => /(^|\/)components?\//i.test(node.file ?? "")
      && /^[A-Z]/.test(node.label)
      && (node.symbolType === "function" || node.symbolType === "class"));
  const selectedNodes = input.comprehensive
    ? [...pageNodes, ...componentNodes, ...apiNodes]
    : [...pageNodes.slice(0, 12), ...componentNodes.slice(0, 12), ...apiNodes.slice(0, 12)];

  for (const node of selectedNodes) {
    const kind = node.kind === "page" ? "page" : node.kind === "symbol" ? "component" : "api";
    const duplicate = flows.some((flow) => flow.kind === kind && flow.target === node.label);
    if (duplicate) continue;
    flows.push({
      id: flowId(kind, node.label),
      title: kind === "page"
        ? `${/(^|\/)App$/i.test(node.label) ? "应用主界面" : humanize(node.label)} 页面流程`
        : kind === "component"
          ? `${humanize(node.label)} 功能`
          : `${node.label} 接口流程`,
      kind,
      target: node.label,
      status: supportsBrowserDiscovery ? "auto-bindable" : "coverage-gap",
      confidence: node.confidence,
      reason: kind === "page"
        ? supportsBrowserDiscovery
          ? `代码扫描发现页面入口 ${node.label}；确认计划后会在内置浏览器中自动发现控件、绑定动作并验证断言。`
          : `代码扫描发现页面入口 ${node.label}，但当前项目未开放浏览器 Discovery。`
        : kind === "component"
          ? supportsBrowserDiscovery
            ? `代码扫描发现业务界面组件 ${node.label}；系统会先用页面 Discovery 绑定真实入口，候选冲突时再由 LLM 排定路径。`
            : `代码扫描发现业务界面组件 ${node.label}，但当前项目未开放浏览器 Discovery。`
          : supportsBrowserDiscovery
            ? `代码扫描发现接口 ${node.label}；系统会结合运行时 Network 与页面结果生成受控接口场景。`
            : `代码扫描发现接口 ${node.label}，但尚未绑定输入数据、预期状态和页面结果。`,
      requiredInformation: supportsBrowserDiscovery
        ? []
        : kind === "page" || kind === "component"
          ? ["需要开放浏览器 Discovery 或手工提供页面入口和验收结果"]
          : ["需要确认请求前置条件、测试数据和预期响应"]
    });
  }
  return flows.slice(0, 200);
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
  analysis: IntakeAnalysis;
}): PlanningConversationResult {
  const fullText = [...input.history.map((item) => item.content), input.message].join("\n");
  const comprehensive = /全面|全量|所有业务|所有功能|完整灰度|full|comprehensive/i.test(fullText);
  const flows = buildFlows({ project: input.project, graph: input.graph, analysis: input.analysis, comprehensive });
  const loginSignals = input.graph.nodes.some((node) => /login|signin|auth|登录|认证/i.test(`${node.label} ${node.file ?? ""}`));
  const loginAnswered = /无需登录|不需要登录|测试账号|账号[:：]|用户名|密码|已配置登录/i.test(fullText);
  const destructiveSignals = /删除|支付|退款|审批|发布|发送|批量修改/i.test(fullText);
  const isolationAnswered = /测试数据|沙盒|临时数据库|允许写入|只读/i.test(fullText);
  const clarificationQuestions: string[] = [];
  const blockingQuestions: string[] = [];
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
  const phase: PlanningPhase = blockingQuestions.length ? "clarifying" : "draft-ready";
  const scope = comprehensive ? "comprehensive" as const : "targeted" as const;
  const reply = phase === "clarifying"
    ? `我扫描了 ${input.project.name}，识别到 ${flows.length} 条业务或技术流程，其中 ${executable} 条已有可执行场景、${autoBindable} 条可由内置浏览器自动绑定、${gaps} 条仍需补充。开始制定最终计划前还需要确认 ${clarificationQuestions.length} 个问题。`
    : `测试计划已生成：共识别 ${flows.length} 条流程，${executable} 条可以直接执行，${autoBindable} 条会在确认后进入页面 Discovery 和受控场景绑定；只有经过真实页面探测仍无法形成动作与断言的项目才会转为覆盖缺口。当前已有 ${gaps} 条明确缺口。${clarificationQuestions.length ? "仍有可选信息可以补充，但不影响确认计划。" : ""}`;
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
      confidence: flows.length && gaps === 0 && autoBindable === 0 ? "high" : flows.length ? "medium" : "low",
      scope
    },
    plan: buildPlan(input.project, flows, comprehensive),
    analysis: input.analysis,
    recommendedScenarioId: flows.find((flow) => flow.status === "executable")?.scenarioId
  };
}
