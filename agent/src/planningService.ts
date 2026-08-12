import path from "node:path";
import type { ProjectConfig } from "./types.js";
import { buildCodeImpactGraph, changedFilesFromDiff } from "./codeImpactGraph.js";
import { buildBusinessCapabilityGraph, readBusinessSourceSlices } from "./businessCapabilityGraph.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { createLlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import { buildPlanningConversation, type PlanningMessage } from "./planningConversation.js";
import { getPlanningFlowPage, savePlanningInventory } from "./planningInventoryStore.js";
import { listScenarios } from "./scenarios.js";
import { probeDiscoveryConnectivity, runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import { toTargetProjectConfig } from "./projectAdapter.js";

export interface PlanningConversationRequest {
  message: string;
  diff: string;
  bugTicket?: string;
  planningMode: "llm-guided" | "scan-only";
  credentialId?: string;
  history: PlanningMessage[];
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
  const scenarioContracts = listScenarios()
    .filter((scenario) => !scenario.matcher?.projectIds?.length || scenario.matcher.projectIds.includes(project.id))
    .map((scenario) => ({ id: scenario.id, keywords: scenario.matcher?.keywords ?? [scenario.id, scenario.title] }));
  const targetRoot = toTargetProjectConfig(project).rootDir;
  const graph = await buildCodeImpactGraph({
    repositoryRoot: targetRoot,
    files: changedFilesFromDiff(request.diff),
    diff: request.diff || undefined,
    includeRepositorySources: true,
    scenarios: scenarioContracts,
    cacheFile: path.join(input.reportsDir, "planning-cache", `${project.id}.json`)
  });
  const capabilityGraph = await buildBusinessCapabilityGraph({ repositoryRoot: targetRoot, codeGraph: graph, manifest: project.manifest });
  const analysis = analyzeIntake({ projectId: project.id, requirement: request.message, diff: request.diff, bugTicket: request.bugTicket, codeGraph: graph });
  const discovery = requiresPageSmoke && discoveryReadiness.status === "ready"
    ? await runSmokeFirstDiscovery({ projectId: project.id, sourceContexts: analysis.sourceContexts, goal: request.message, discoveryAttempts: 2 })
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
  await savePlanningInventory({ id: planning.id, projectId: project.id, snapshotHash: planning.businessGraph?.projectSnapshotHash, flows: completeFlows, createdAt: new Date().toISOString() });
  const firstPage = await getPlanningFlowPage({ inventoryId: planning.id, projectId: project.id, limit: 24 });
  if (firstPage) {
    const visibleIds = new Set(firstPage.flows.map((flow) => flow.id));
    planning.businessFlows = firstPage.flows;
    planning.businessFlowPage = firstPage.page;
    planning.plan = { ...planning.plan, levels: planning.plan.levels.map((level) => ({ ...level, paths: level.paths.filter((entry) => visibleIds.has(entry.id)) })) };
  }
  return { planning, ...(discovery ? { discovery } : {}) };
}
