import { createHash } from "node:crypto";
import type { BusinessSourceLocation } from "./businessCapabilityGraph.js";
import type { BusinessPath, BusinessPathStatus } from "./businessPathCompiler.js";

export type BusinessFunctionStatus = "ready" | "needs-confirmation" | "blocked" | "unknown";
export type BehaviorCoverageDimension = "happy-path" | "negative" | "boundary" | "permission" | "state-transition" | "data-consistency" | "idempotency" | "recovery";

export interface BusinessFunction {
  id: string;
  name: string;
  purpose: string;
  roles: string[];
  risk: "low" | "medium" | "high";
  status: BusinessFunctionStatus;
  confidence: "high" | "medium" | "low";
  pathIds: string[];
  sourceLocations: BusinessSourceLocation[];
  evidenceRefs: string[];
  /** Internal paths are retained for the Agent, but are never required in the user-facing summary. */
  technicalPathCount: number;
  branchCount: number;
  summary: string;
  /** Only paths that represent a user-facing capability are counted here. */
  kind?: "business-capability";
  /** API/data/handler paths supporting this capability, never standalone UI rows. */
  implementationEvidencePathIds?: string[];
  /** Explicit gate contract shown to downstream proof evaluation. */
  passCriteria?: ["executable-entry", "key-action", "expected-result", "executed-oracle", "valid-evidence", "no-unresolved-high-risk"];
  /** Required test-design dimensions; path coverage alone is insufficient. */
  behaviorCoverage?: BehaviorCoverageDimension[];
}

export interface ProjectOverview {
  purpose: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: string[];
  businessFunctionCount: number;
  technicalPathCount: number;
  sourceCandidateCount: number;
  unknownCount: number;
  statusCounts: Record<BusinessFunctionStatus, number>;
  snapshotHash?: string;
}

export interface BusinessFunctionCompilation {
  functions: BusinessFunction[];
  overview: ProjectOverview;
  /** Technical inventory remains available to the Agent but is not a business function. */
  technicalPaths?: BusinessPath[];
}

function stableId(value: string) {
  return `business_function_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function clean(value: string) {
  return value
    .replace(/\s+(页面业务流程|接口业务流程|后台任务流程|数据验证流程|业务流程)(?:组)?$/u, "")
    .replace(/\s*接口组(?:\s*\([^)]*\))?$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function semanticName(path: BusinessPath) {
  const value = clean(path.title);
  const lower = `${value} ${path.summary}`.toLowerCase();
  const first = value.split(/\s+/)[0]?.toLowerCase() ?? "";
  const aliases: Record<string, string> = {
    agentexecutions: "执行记录",
    agentflows: "流程编排",
    agentflowsv2: "流程编排",
    agentflowv2: "流程编排",
    canvas: "流程编排",
    assistants: "AI 助手配置",
    chatbot: "对话与聊天",
    chatflows: "对话与聊天",
    chatmessage: "对话与聊天",
    chat: "对话与聊天",
    datasets: "数据集管理",
    dataset: "数据集管理",
    credentials: "凭据与接口配置",
    apikey: "凭据与接口配置",
    account: "账号与系统配置",
    audit: "审计与运行记录",
    attachments: "文件与附件",
    backstage: "应用基础界面",
    evaluations: "评估与质量分析",
    "api": "接口与集成"
  };
  if (aliases[first]) return aliases[first];
  if (/(登录|认证|signin|sign in|login|auth|session)/i.test(lower)) return "登录与身份认证";
  if (/(审批|审核|approve|approval|review)/i.test(lower)) return "审批与审核";
  if (/(导出|报告|export|report|download)/i.test(lower)) return "报告与导出";
  if (/(凭据|apikey|api key|credential|secret)/i.test(lower)) return "凭据与接口配置";
  if (/(设置|配置|account|账户|账号|settings)/i.test(lower)) return "账号与系统配置";
  if (/(创建|新增|新建|create|add)/i.test(lower)) return `${value || "创建"}功能`;
  if (/(查询|搜索|筛选|列表|search|filter|list)/i.test(lower)) return `${value || "查询"}功能`;
  if (/^(应用主界面|backstage|.*routes?)$/i.test(value)) return "应用基础界面";
  return value || "待确认业务功能";
}

function isTechnicalPath(path: BusinessPath) {
  if (path.kind === "business-capability") return false;
  if (path.kind === "api" || path.kind === "technical-resource" || path.kind === "runtime-observation"
    || (path.surfaces.includes("api") && !path.surfaces.includes("page"))) {
    return path.implementationEvidence !== false;
  }
  const text = `${path.title} ${path.summary}`;
  // Routed shell pages are implementation scaffolding, not user capabilities.
  // Keep them in the internal inventory so the Agent can use them as context,
  // but do not make users confirm a feature called “Default Redirect”.
  if (path.surfaces.includes("page")) {
    return /应用主界面|应用基础界面|default\s+redirect|backstage\s+(layout|redirect)|(^|\s)routes?($|\s)/i.test(text);
  }
  const clearlyBusiness = /(登录|认证|审批|审核|导出|报告|凭据|账号|账户|任务|订单|用户|项目|配置|login|signin|auth|create|approve|export|report|credential|account|task|order|user)/i.test(text);
  return path.surfaces.includes("data")
    || !clearlyBusiness
    || /(数据实体|schema|health|metrics|内部|internal|队列|后台任务|background)/i.test(text);
}

function statusFor(paths: BusinessPath[]): BusinessFunctionStatus {
  if (!paths.length) return "unknown";
  if (paths.every((path) => path.confidence === "low")) return "unknown";
  if (paths.some((path) => path.confidence === "low")) return "needs-confirmation";
  if (paths.every((path) => path.status === "coverage-gap")) return "blocked";
  if (paths.some((path) => path.status === "needs-input" || path.status === "coverage-gap")) return "needs-confirmation";
  return "ready";
}

function confidenceFor(paths: BusinessPath[]): BusinessFunction["confidence"] {
  if (paths.some((path) => path.confidence === "low")) return "low";
  if (paths.some((path) => path.confidence === "medium")) return "medium";
  return "high";
}

function purposeFor(name: string, paths: BusinessPath[]) {
  const surfaces = new Set(paths.flatMap((path) => path.surfaces));
  const surfaceText = [...surfaces].map((surface) => {
    if (surface === "page") return "页面操作";
    if (surface === "api") return "接口交互";
    if (surface === "data") return "数据校验";
    return "后台任务";
  });
  return `${name}，涉及${surfaceText.join("、") || "待确认实现"}。`;
}

function behaviorDimensionsFor(paths: BusinessPath[]): BehaviorCoverageDimension[] {
  const text = paths.map((path) => `${path.title} ${path.summary} ${path.actionCandidates.join(" ")}`).join(" ").toLowerCase();
  const dimensions = new Set<BehaviorCoverageDimension>(["happy-path", "negative"]);
  if (paths.some((path) => path.risk === "high") || /(登录|权限|认证|approve|auth|permission|role)/i.test(text)) dimensions.add("permission");
  if (/(创建|新增|编辑|删除|更新|create|add|edit|delete|update|数量|金额|边界|limit|count)/i.test(text)) dimensions.add("boundary");
  if (/(状态|进行中|完成|失败|审批|队列|任务|state|status|workflow|job)/i.test(text)) dimensions.add("state-transition");
  if (/(数据|保存|列表|详情|同步|一致|database|record|data)/i.test(text)) dimensions.add("data-consistency");
  if (/(重复|幂等|重试|retry|duplicate|idempot)/i.test(text)) dimensions.add("idempotency");
  if (/(恢复|回滚|异常|失败|recovery|rollback|error)/i.test(text)) dimensions.add("recovery");
  return [...dimensions];
}

/**
 * Converts technical execution paths into a small, user-facing function list.
 * This compiler is deterministic: LLMs may improve wording later, but never
 * decide counts or invent source relationships.
 */
export function compileBusinessFunctions(input: {
  paths: BusinessPath[];
  sourceCandidateCount?: number;
  snapshotHash?: string;
  projectName?: string;
  projectDescription?: string;
  capabilityHints?: Array<{ id: string; name: string; purpose?: string; pathIds?: string[]; routePrefixes?: string[]; risk?: "low" | "medium" | "high" }>;
}): BusinessFunctionCompilation {
  const groups = new Map<string, BusinessPath[]>();
  const hints = input.capabilityHints ?? [];
  const hintFor = (path: BusinessPath) => hints.find((hint) =>
    hint.pathIds?.includes(path.id)
    || (hint.routePrefixes?.length && hint.routePrefixes.some((prefix) => `${path.title} ${path.summary}`.includes(prefix)))
  );
  let technicalPathCount = 0;
  const technicalPaths: BusinessPath[] = [];
  for (const path of input.paths) {
    const hint = hintFor(path);
    // A manifest mapping is an explicit business declaration; it may promote
    // an otherwise technical API path while preserving the API as evidence.
    const classifiedPath = hint ? { ...path, kind: "business-capability" as const, implementationEvidence: false } : path;
    if (isTechnicalPath(classifiedPath)) {
      technicalPathCount += 1;
      technicalPaths.push(classifiedPath);
      continue;
    }
    const name = hint?.name ?? semanticName(path);
    groups.set(name, [...(groups.get(name) ?? []), classifiedPath]);
  }
  // An API can be implementation evidence for an already identified page
  // capability (for example Login page + POST /api/login). Attach it to that
  // capability, but keep it in the technical inventory and never create a
  // new user-facing row from the endpoint alone.
  for (const path of technicalPaths) {
    if (!path.surfaces.includes("api")) continue;
    const name = semanticName(path);
    if (groups.has(name)) groups.set(name, [...groups.get(name)!, path]);
  }
  const functions = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN")).map(([name, paths]) => {
    const sourceLocations = [...new Map(paths.flatMap((path) => path.sourceLocations).map((location) => [`${location.file}:${location.line ?? 0}:${location.sourceHash}`, location])).values()];
    const roles = [...new Set(paths.flatMap((path) => path.roles))];
    const status = statusFor(paths);
    const confidence = confidenceFor(paths);
    const pathIds = paths.map((path) => path.id);
    const implementationEvidencePathIds = paths
      .filter((path) => path.surfaces.includes("api") || path.implementationEvidence)
      .map((path) => path.id);
    return {
      id: stableId(`${input.snapshotHash ?? "unknown"}:${name}:${pathIds.sort().join(",")}`),
      name,
      purpose: hints.find((hint) => hint.name === name)?.purpose ?? purposeFor(name, paths),
      roles,
      risk: hints.find((hint) => hint.name === name)?.risk ?? (paths.some((path) => path.risk === "high") ? "high" : paths.some((path) => path.risk === "medium") ? "medium" : "low"),
      status,
      confidence,
      pathIds,
      sourceLocations,
      evidenceRefs: [],
      // A function contains only user-facing paths. Technical paths are
      // counted once at compilation level and remain available in inventory.
      technicalPathCount: 0,
      branchCount: paths.length,
      summary: `${paths.length} 条内部测试路径，${paths.flatMap((path) => path.actionCandidates).slice(0, 3).join("；") || "等待运行时绑定"}`,
      kind: "business-capability" as const,
      implementationEvidencePathIds,
      passCriteria: ["executable-entry", "key-action", "expected-result", "executed-oracle", "valid-evidence", "no-unresolved-high-risk"] as const,
      behaviorCoverage: behaviorDimensionsFor(paths)
    } satisfies BusinessFunction;
  });
  const description = input.projectDescription?.trim();
  const purpose = description
    ? description.slice(0, 240)
    : functions.length
      ? `这是一个包含${functions.slice(0, 4).map((item) => item.name).join("、")}等功能的 ${input.projectName ?? "Web/API"} 项目。`
      : "项目用途尚未确认，等待更多源码或运行时证据。";
  const unknownCount = functions.filter((item) => item.status === "unknown" || item.confidence === "low").length;
  const statusCounts = functions.reduce<Record<BusinessFunctionStatus, number>>((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { ready: 0, "needs-confirmation": 0, blocked: 0, unknown: 0 });
  return {
    functions,
    overview: {
      purpose,
      confidence: description ? "high" : functions.length ? "medium" : "low",
      evidenceRefs: sourceLocationsFor(functions),
      businessFunctionCount: functions.length,
      technicalPathCount,
      sourceCandidateCount: input.sourceCandidateCount ?? input.paths.reduce((sum, path) => sum + path.sourceNodeIds.length, 0),
      unknownCount,
      statusCounts,
      snapshotHash: input.snapshotHash
    },
    technicalPaths
  };
}

/**
 * Business-level pass contract. A green run is not enough: every capability
 * must have an executable entry, a real action, an explicit oracle and linked
 * evidence, and high-risk paths may not remain unresolved.
 */
export function evaluateBusinessFunctionPass(input: {
  capability: Pick<BusinessFunction, "id" | "name" | "risk" | "pathIds" | "passCriteria">;
  paths: Array<Pick<BusinessPath, "id" | "status" | "actionCandidates" | "oracleCandidates" | "requiredEvidenceKinds" | "risk">>;
  coverage: { disposition: string; actionPathIds?: string[]; oracleIds?: string[]; requiredEvidenceKinds?: string[]; dispositionReason?: string };
  results: Array<{ status: string; oracleResults?: Array<{ passed: boolean; evidenceRefs?: string[] }>; evidenceRefs?: string[] }>;
  evidenceKinds: Set<string>;
}) {
  const reasons: string[] = [];
  const paths = input.paths.filter((path) => input.capability.pathIds.includes(path.id));
  const executable = paths.some((path) => path.status === "auto-bindable");
  const action = paths.some((path) => path.actionCandidates.length > 0)
    && (input.coverage.actionPathIds?.length ?? 0) > 0;
  const expected = paths.some((path) => path.oracleCandidates.length > 0)
    && (input.coverage.oracleIds?.length ?? 0) > 0;
  const completed = input.results.filter((result) => result.status === "completed");
  const oraclePassed = completed.length > 0
    && completed.every((result) => (result.oracleResults ?? []).length > 0 && (result.oracleResults ?? []).every((oracle) => oracle.passed));
  const validEvidence = (input.coverage.requiredEvidenceKinds ?? []).every((kind) => input.evidenceKinds.has(kind))
    && (completed.some((result) => (result.evidenceRefs ?? []).length > 0 || (result.oracleResults ?? []).some((oracle) => (oracle.evidenceRefs ?? []).length > 0)));
  const unresolvedHighRisk = input.capability.risk === "high"
    && (input.coverage.disposition === "blocked" || input.coverage.disposition === "pending" || input.coverage.disposition === "binding" || input.coverage.disposition === "executing");
  if (!executable) reasons.push("business_executable_entry_missing");
  if (!action) reasons.push("business_key_action_missing");
  if (!expected) reasons.push("business_expected_result_missing");
  if (!oraclePassed) reasons.push("business_oracle_not_executed_or_failed");
  if (!validEvidence) reasons.push("business_valid_evidence_missing");
  if (unresolvedHighRisk) reasons.push("business_high_risk_unresolved");
  return { passed: reasons.length === 0, reasons };
}

function sourceLocationsFor(functions: BusinessFunction[]) {
  return [...new Set(functions.flatMap((item) => item.sourceLocations.slice(0, 4).map((location) => `${location.file}:${location.line ?? 0}`)))];
}

export function businessFunctionStatusLabel(status: BusinessFunctionStatus) {
  return status === "ready" ? "可规划" : status === "needs-confirmation" ? "需补充条件" : status === "blocked" ? "暂不可执行" : "待确认";
}

export function pathStatusCounts(paths: BusinessPath[]) {
  return paths.reduce<Record<BusinessPathStatus, number>>((counts, path) => {
    counts[path.status] += 1;
    return counts;
  }, { "auto-bindable": 0, "needs-input": 0, "coverage-gap": 0 });
}
