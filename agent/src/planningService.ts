import path from "node:path";
import type { ProjectConfig } from "./types.js";
import type { DiscoveryScanResult } from "./types.js";
import { buildCodeImpactGraph, changedFilesFromDiff } from "./codeImpactGraph.js";
import { buildBusinessCapabilityGraph, readBusinessSourceSlices } from "./businessCapabilityGraph.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { createLlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import { buildPlanningConversation, type PlannedBusinessFlow, type PlanningConversationResult, type PlanningMessage } from "./planningConversation.js";
import { getPlanningFlowPage, getPlanningFunctionPage, savePlanningInventory } from "./planningInventoryStore.js";
import { probeDiscoveryConnectivity, runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import { toTargetProjectConfig } from "./projectAdapter.js";
import { compileBusinessFunctions } from "./businessFunctionCompiler.js";
import type { BusinessFunctionCompilation } from "./businessFunctionCompiler.js";
import type { BusinessPath } from "./businessPathCompiler.js";

export interface PlanningConversationRequest {
  message: string;
  diff: string;
  bugTicket?: string;
  planningMode: "llm-guided" | "scan-only";
  credentialId?: string;
  history: PlanningMessage[];
}

/**
 * The runtime login machinery (credential interrupt, deterministic form fill)
 * only engages when the confirmed plan actually contains a login step. When
 * Discovery observed a real authentication wall, pin it as the FIRST business
 * flow so the pre-run credential gate reliably asks for the test account
 * before any browser session starts — instead of stalling at /signin.
 */
function discoveryAuthGate(discovery?: DiscoveryScanResult) {
  if (!discovery) return undefined;
  // The auth suggestion is only emitted when the browser actually observed a
  // password + identity + submit form, so its presence is hard runtime
  // evidence of a login wall — regardless of how the scan status was rolled up.
  const loginSuggestion = discovery.suggestions.find((suggestion) =>
    suggestion.actions.some((action) => /login_as_test_user|login_invalid_user/.test(action))
  );
  if (discovery.status === "waiting-auth" || discovery.requiredAction === "credential_required" || loginSuggestion) {
    return discovery.observation.finalUrl || discovery.target.frontendUrl;
  }
  return undefined;
}

function injectLoginGateFlow(
  planning: PlanningConversationResult,
  discovery: DiscoveryScanResult | undefined,
  project: ProjectConfig
) {
  const gateUrl = discoveryAuthGate(discovery);
  if (!gateUrl) return;
  if (planning.businessFlows.some((flow) => flow.id === "flow_login_gate")) return;
  const hasCredential = Boolean(project.login?.credentialId);
  const loginFlow: PlannedBusinessFlow = {
    id: "flow_login_gate",
    title: "登录并进入应用（页面 Discovery 已确认登录入口）",
    kind: "page",
    target: gateUrl,
    status: "auto-bindable",
    confidence: "high",
    reason: `页面 Discovery 在 ${gateUrl} 真实观测到账号、密码与登录按钮；执行时会先使用已保存的沙盒测试账号完成登录，再进入登录后的业务流程。账号内容不会展示或写入报告。`,
    requiredInformation: hasCredential ? [] : ["需要配置仅用于沙盒的测试账号（执行前会请求确认）"],
    pathVersion: "2.0",
    summary: "页面：登录、认证、进入应用",
    surfaces: ["page"],
    risk: "high",
    roles: ["沙盒测试账号"],
    actionCandidates: ["login_as_test_user"],
    oracleCandidates: ["登录成功后离开登录页 URL，登录表单不再显示"],
    requiredEvidenceKinds: ["screenshot", "dom", "network"],
    sourceNodeIds: [],
    // This path is grounded by the runtime page observation rather than a
    // static source node. It still has one auditable source and must satisfy
    // the Run coverage contract, which deliberately rejects zero-source work.
    sourceCount: 1,
    sourceLocations: []
  };
  planning.businessFlows = [loginFlow, ...planning.businessFlows];
  planning.plan = {
    ...planning.plan,
    levels: planning.plan.levels.map((level, index) => index === 0
      ? {
        ...level,
        paths: [{
          id: loginFlow.id,
          title: loginFlow.title,
          riskReason: loginFlow.reason,
          expectedFrom: "existing_test" as const,
          retry: 0,
          // These strings are the machine-checked login contract: the pre-run
          // credential gate (loginPlan) matches this exact action vocabulary.
          steps: ["打开登录页", "login_as_test_user 使用沙盒测试账号登录", "验证已离开登录页", "采集登录证据"]
        }, ...level.paths]
      }
      : level)
  };
  planning.coverage.discovered += 1;
  planning.coverage.autoBindable += 1;
  planning.reply = `页面 Discovery 确认项目有登录入口，已把“登录并进入应用”固定为第一条业务路径；${hasCredential ? "已保存的测试账号会在执行前请求你确认后使用。" : "确认计划时会先请你配置仅用于沙盒的测试账号。"}\n\n${planning.reply}`;
}

/**
 * Keep the assistant contract at the business level.  The compiler and graph
 * retain source files, routes and internal path ids for execution, but those
 * implementation details are not a useful planning conversation for a user.
 */
function buildUserFacingPlanningReply(input: {
  goal: string;
  planning: PlanningConversationResult;
  compilation: BusinessFunctionCompilation;
}) {
  const { planning, compilation } = input;
  const comprehensive = /全面扫描|灰度测试|完整测试|全量测试|full[\s_-]*(scan|coverage)/i.test(input.goal);
  const functions = compilation.functions;
  const names = functions.slice(0, 12).map((feature) => feature.name);
  const remaining = Math.max(0, functions.length - names.length);
  const functionSummary = names.length
    ? `${names.join("、")}${remaining ? `等 ${functions.length} 个功能` : ""}`
    : "暂未确认具体业务功能";
  const needs = functions.filter((feature) => feature.status !== "ready");
  const loginRequired = planning.businessFlows.some((flow) => flow.id === "flow_login_gate")
    || functions.some((feature) => feature.name === "登录与身份认证");
  const requirement = comprehensive
    ? `我会按完整功能清单安排验证：${functionSummary}。`
    : `我会围绕你描述的目标定位并验证相关功能：${functionSummary}。`;
  const prerequisites = loginRequired
    ? "需要测试账号才能验证登录后的功能；账号只在沙盒会话中使用。"
    : needs.length
      ? `其中 ${needs.length} 个功能还需要在真实页面中确认条件，系统会在执行前补充绑定。`
      : "当前没有需要你额外补充的前置条件。";
  const next = planning.clarificationQuestions.length
    ? `下一步：请先确认${planning.clarificationQuestions[0]}，然后我会继续安排测试。`
    : "下一步：你确认清单后，我会在可见的测试页面中执行并汇报结果。";
  return [
    `项目用途：${compilation.overview.purpose}`,
    `已识别的业务功能：${requirement}`,
    `本次测试范围：${comprehensive ? "全面扫描全部已识别功能" : "仅测试你描述的目标相关功能"}。`,
    `前置条件：${prerequisites}`,
    next
  ].join("\n");
}

/** Planning orchestration is kept outside HTTP routing so it can be reused by
 * a Graph node, API route, and worker without reintroducing server.ts logic. */
export async function createPlanningConversation(input: {
  project: ProjectConfig;
  request: PlanningConversationRequest;
  reportsDir: string;
}) {
  const { project, request } = input;
  const requiresPageSmoke = /全面扫描|灰度测试|完整测试|全量测试|full[\s_-]*(scan|coverage)/i.test(request.message);
  let discoveryReadiness = await probeDiscoveryConnectivity({ projectId: project.id, maxAttempts: 2 });
  const targetRoot = toTargetProjectConfig(project).rootDir;
  const graph = await buildCodeImpactGraph({
    repositoryRoot: targetRoot,
    files: changedFilesFromDiff(request.diff),
    diff: request.diff || undefined,
    includeRepositorySources: true,
    cacheFile: path.join(input.reportsDir, "planning-cache", `${project.id}.json`)
  });
  const capabilityGraph = await buildBusinessCapabilityGraph({ repositoryRoot: targetRoot, codeGraph: graph, manifest: project.manifest });
  const analysis = analyzeIntake({ projectId: project.id, requirement: request.message, diff: request.diff, bugTicket: request.bugTicket, codeGraph: graph });
  const discovery = requiresPageSmoke && discoveryReadiness.status === "ready"
    ? await runSmokeFirstDiscovery({
      projectId: project.id,
      sourceContexts: analysis.sourceContexts,
      goal: request.message,
      discoveryAttempts: 2,
      // A saved test account turns the auth wall into a legitimate login test
      // point instead of a permanent "waiting-auth" block on every rescan.
      credentialId: project.login?.credentialId
    })
    : undefined;
  if (discovery?.orchestration) discoveryReadiness = discovery.orchestration;
  const planning = buildPlanningConversation({
    project,
    message: request.message,
    history: request.history,
    graph,
    capabilityGraph,
    analysis,
    discoveryReadiness
  });
  injectLoginGateFlow(planning, discovery, project);
  if (request.planningMode === "llm-guided") {
    const advice = await createLlmPlanningAdvice({
      project,
      goal: request.message,
      flows: planning.businessFlows,
      credentialId: request.credentialId,
      pageObservation: discovery?.observation,
      sourceSlices: await readBusinessSourceSlices({ repositoryRoot: targetRoot, locations: planning.businessFlows.flatMap((flow) => flow.sourceLocations ?? []), maxFiles: 12, maxChars: 18_000 })
    });
    planning.llmPlanning = advice;
    if (advice.status === "passed") {
      const priority = new Map(advice.prioritizedFlowIds.map((id, index) => [id, index]));
      planning.businessFlows = [...planning.businessFlows].sort((left, right) => (priority.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right.id) ?? Number.MAX_SAFE_INTEGER));
      const orderedFlowIds = new Map(planning.businessFlows.map((flow, index) => [flow.id, index]));
      planning.plan.levels = planning.plan.levels.map((level) => ({ ...level, paths: [...level.paths].sort((left, right) => (orderedFlowIds.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (orderedFlowIds.get(right.id) ?? Number.MAX_SAFE_INTEGER)) }));
      planning.reply = `${planning.reply}\n\nAI 规划建议：${advice.summary}`;
      planning.clarificationQuestions = [...new Set([...planning.clarificationQuestions, ...advice.clarificationQuestions])].slice(0, 6);
    }
  }
  const completeFlows = planning.businessFlows;
  const internalPaths: BusinessPath[] = completeFlows.map((flow) => ({
    id: flow.id,
    title: flow.title,
    summary: flow.summary ?? flow.target,
    status: flow.status === "executable" ? "auto-bindable" : flow.status,
    confidence: flow.confidence,
    risk: flow.risk ?? "medium",
    surfaces: flow.surfaces ?? (flow.kind === "page" ? ["page"] : flow.kind === "api" ? ["api"] : flow.kind === "data" ? ["data"] : ["background-task"]),
    roles: flow.roles ?? [],
    preconditions: flow.requiredInformation,
    actionCandidates: flow.actionCandidates ?? [],
    oracleCandidates: flow.oracleCandidates ?? [],
    requiredEvidenceKinds: flow.requiredEvidenceKinds ?? [],
    sourceNodeIds: flow.sourceNodeIds ?? [],
    sourceLocations: flow.sourceLocations ?? [],
    reason: flow.reason
  }));
  const businessCompilation = compileBusinessFunctions({
    paths: internalPaths,
    sourceCandidateCount: planning.coverage.sourceCandidates,
    snapshotHash: planning.businessGraph?.projectSnapshotHash,
    projectName: project.name,
    projectDescription: undefined
  });
  planning.businessFunctions = businessCompilation.functions;
  planning.projectOverview = businessCompilation.overview;
  planning.businessFunctionCount = businessCompilation.overview.businessFunctionCount;
  planning.technicalPathCount = businessCompilation.overview.technicalPathCount;
  planning.businessFunctionSnapshotHash = businessCompilation.overview.snapshotHash;
  planning.businessFunctionConfidence = businessCompilation.overview.confidence;
  planning.reply = buildUserFacingPlanningReply({
    goal: request.message,
    planning,
    compilation: businessCompilation
  });
  planning.businessFunctionPage = {
    total: businessCompilation.functions.length,
    limit: businessCompilation.functions.length
  };
  await savePlanningInventory({ id: planning.id, projectId: project.id, snapshotHash: planning.businessGraph?.projectSnapshotHash, flows: completeFlows, functions: businessCompilation.functions, createdAt: new Date().toISOString() });
  const firstFunctionPage = await getPlanningFunctionPage({ inventoryId: planning.id, projectId: project.id, limit: 24 });
  if (firstFunctionPage) {
    planning.businessFunctions = firstFunctionPage.functions;
    planning.businessFunctionPage = firstFunctionPage.page;
  }
  const firstPage = await getPlanningFlowPage({ inventoryId: planning.id, projectId: project.id, limit: 24 });
  if (firstPage) {
    const visibleIds = new Set(firstPage.flows.map((flow) => flow.id));
    planning.businessFlows = firstPage.flows;
    planning.businessFlowPage = firstPage.page;
    planning.plan = { ...planning.plan, levels: planning.plan.levels.map((level) => ({ ...level, paths: level.paths.filter((entry) => visibleIds.has(entry.id)) })) };
  }
  return { planning, ...(discovery ? { discovery } : {}) };
}
