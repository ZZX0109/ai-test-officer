import type { Dispatch, SetStateAction } from "react";
import { approveScenarioDraft, listScenarios, probeScenarioDraft, runDiscoveryScan } from "../api";
import type {
  Credential,
  DiscoveryScanResult,
  HarnessGapScenarioDraft,
  PermissionProfile,
  PlanningConversationResult,
  PlanningMessage,
  ProjectConfig,
  ScenarioSummary
} from "../types";
import type { PlanningAutomationPresentation } from "../components/PlanningConversationPanel";
import type { AutomationFailure, ScenarioExecutionTarget } from "./useConfirmedScenarioExecution";

type ExecutionOutcome = { success: boolean; detail: string } | undefined;

interface UseAutomaticPlanningInput {
  permissionProfile: PermissionProfile;
  planningResult: PlanningConversationResult | null;
  requirementText: string;
  executionMode: "oci" | "trusted-local";
  defaultCredential?: Credential;
  discovery: DiscoveryScanResult | null;
  ensureProjectReadyForAutomation: (projectOverride?: ProjectConfig) => Promise<ProjectConfig>;
  executeConfirmedScenarioAutomatically: (
    scenarioId: string | undefined,
    permission: PermissionProfile,
    target?: ScenarioExecutionTarget
  ) => Promise<ExecutionOutcome>;
  analyzeAutomationFailures: (failures: AutomationFailure[], completedCount: number) => Promise<unknown>;
  userFacingError: (value: string) => string;
  setPlanningAutomation: Dispatch<SetStateAction<PlanningAutomationPresentation>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setRunPreviewModalOpen: Dispatch<SetStateAction<boolean>>;
  setAutomationFailures: Dispatch<SetStateAction<AutomationFailure[]>>;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setDiscovery: Dispatch<SetStateAction<DiscoveryScanResult | null>>;
  setScenarioDrafts: Dispatch<SetStateAction<HarnessGapScenarioDraft[]>>;
  setScenarioId: Dispatch<SetStateAction<string>>;
  setScenarios: Dispatch<SetStateAction<ScenarioSummary[]>>;
  setRevealProjectLoginSettings: Dispatch<SetStateAction<boolean>>;
}

function chooseDiscoveryDraft(requirementText: string, planning: PlanningConversationResult, result: DiscoveryScanResult) {
  const semanticText = `${requirementText} ${planning.businessFlows.map((flow) => flow.title).join(" ")}`.toLowerCase();
  return result.drafts.map((draft) => {
    const draftText = `${draft.riskKind ?? ""} ${draft.actions?.join(" ") ?? ""} ${JSON.stringify(draft.scenario)}`.toLowerCase();
    const terms = semanticText.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2);
    const matches = terms.filter((term) => draftText.includes(term)).length;
    const riskBonus = /登录|权限|login|permission/.test(semanticText) && draft.riskKind === "auth" ? 8
      : /接口|api|网络|network/.test(semanticText) && draft.riskKind === "api_contract" ? 8
        : /筛选|列表|表格|filter|table/.test(semanticText) && draft.riskKind === "table" ? 8 : 0;
    return { draft, score: matches + riskBonus };
  }).sort((left, right) => right.score - left.score)[0]?.draft;
}

/**
 * Convert the user-facing business-function inventory back into the complete
 * internal path inventory. The official demo used to replace this with one
 * hard-coded filter path, so a four-function plan could incorrectly pass
 * after exercising only one function.
 */
export function buildDynamicCoverageInventory(planning: PlanningConversationResult): NonNullable<ScenarioExecutionTarget["coverageInventory"]> {
  const flowsById = new Map(planning.businessFlows.map((flow) => [flow.id, flow]));
  const functionPaths = (planning.businessFunctions ?? []).flatMap((feature) => {
    const pathIds = feature.pathIds.length ? feature.pathIds : [feature.id];
    return pathIds.map((pathId) => {
      const flow = flowsById.get(pathId);
      const status = flow?.status ?? (feature.status === "ready"
        ? "auto-bindable"
        : feature.status === "blocked" ? "coverage-gap" : "needs-input");
      return {
        id: pathId,
        title: feature.pathIds.length > 1 && flow ? `${feature.name} · ${flow.title}` : feature.name,
        status,
        kind: flow?.kind ?? "page" as const,
        target: flow?.target ?? feature.name,
        sourceNodeIds: flow?.sourceNodeIds ?? [],
        sourceCount: Math.max(1, flow?.sourceCount || flow?.sourceNodeIds?.length || feature.sourceLocations.length || 1),
        surfaces: flow?.surfaces ?? ["page" as const],
        requiredEvidenceKinds: flow?.requiredEvidenceKinds,
        preconditions: flow?.requiredInformation ?? []
      };
    });
  });
  const rawPaths = functionPaths.length ? functionPaths : planning.businessFlows.map((flow) => ({
    id: flow.id,
    title: flow.title,
    status: flow.status,
    kind: flow.kind,
    target: flow.target,
    sourceNodeIds: flow.sourceNodeIds ?? [],
    sourceCount: Math.max(1, flow.sourceCount || flow.sourceNodeIds?.length || 1),
    surfaces: flow.surfaces,
    requiredEvidenceKinds: flow.requiredEvidenceKinds,
    preconditions: flow.requiredInformation
  }));
  return [...new Map(rawPaths.map((path) => [path.id, path])).values()];
}

/**
 * Turns an approved planning draft into explicit, evidence-bearing execution
 * paths. It preserves every unbound path as a blocked disposition and never
 * upgrades a discovery or binding failure to a successful Run.
 */
export function useAutomaticPlanning(input: UseAutomaticPlanningInput) {
  async function continueAutomaticPlanning(
    grantedProfile = input.permissionProfile,
    projectOverride?: ProjectConfig,
    planningOverride?: PlanningConversationResult
  ) {
    const activePlanning = planningOverride ?? input.planningResult;
    if (!activePlanning) return;
    const comprehensiveRun = /全面|灰度|全量|所有业务|所有功能|full|comprehensive/i.test(`${input.requirementText} ${activePlanning.plan.sessionName}`);
    if (!grantedProfile.observe || !grantedProfile.browserControl) {
      input.setPlanningAutomation({ phase: "needs-permission", detail: "先允许本次浏览器操作，授权后系统会依次准备沙盒、扫描页面并生成可执行路径。" });
      input.setMessage("等待本次沙盒浏览器操作授权。");
      input.setRunPreviewModalOpen(true);
      return;
    }
    input.setAutomationFailures([]);
    input.setPlanningAutomation({ phase: "preparing-project", detail: "正在启动并连接被测项目。" });
    input.setMessage("计划已确认，正在自动准备项目。");
    let activeScenarioId: string | undefined;
    try {
      const project = await input.ensureProjectReadyForAutomation(projectOverride);
      // The bundled official demo deliberately uses the same dynamic browser
      // Agent as an uploaded project. A fixture scenario is useful for unit
      // tests, but must never make the product demo look model-driven when no
      // model has observed or acted on the page.
      const useDynamicBrowserAgent = project.demoProfile?.enabled === true
        || project.manifest?.execution.mode === "oci"
        || input.executionMode === "oci";
      if (useDynamicBrowserAgent) {
        const isOfficialModelDemo = project.demoProfile?.enabled === true;
        const coverageInventory = buildDynamicCoverageInventory(activePlanning);
        const runnableCoverageCount = coverageInventory.filter((item) => item.status === "executable" || item.status === "auto-bindable").length;
        const businessFunctionCount = activePlanning.businessFunctionCount ?? activePlanning.businessFunctions?.length ?? coverageInventory.length;
        const statusCounts = activePlanning.projectOverview?.statusCounts;
        const runnableFunctionCount = statusCounts?.ready ?? runnableCoverageCount;
        const pendingFunctionCount = statusCounts
          ? statusCounts["needs-confirmation"] + statusCounts.blocked + statusCounts.unknown
          : Math.max(0, businessFunctionCount - runnableFunctionCount);
        input.setPlanningMessages((current) => [...current, {
          id: `dynamic_browser_handoff_${Date.now()}`, role: "assistant",
          content: `项目服务已连通。已识别 ${businessFunctionCount} 个业务功能，其中 ${runnableFunctionCount} 个可以开始验证，${pendingFunctionCount} 个会在执行时补充条件。AI 会在可见页面中操作并检查结果；只有遇到账号或高风险操作才会询问你。`,
          createdAt: new Date().toISOString()
        }]);
        input.setPlanningAutomation({ phase: "starting-run", detail: "正在创建自主浏览器 Run；首个页面观测或动作产生后会立即显示在测试现场。" });
        const outcome = await input.executeConfirmedScenarioAutomatically(undefined, grantedProfile, {
          appUrl: project.frontendUrl, projectId: project.id, batchMode: true, coverageScenarioIds: [], coverageInventory,
          coverageMode: comprehensiveRun ? "full" : "targeted",
          dynamicBrowser: true,
          requireModelExecution: project.demoProfile?.enabled === true,
          // The official path is intentionally narrow, but a real model may
          // need more than one observe/act cycle before its deterministic
          // oracle can be evaluated. Keep the normal page-path budget instead
          // of letting the default 12k aggregate reserve block the demo.
          ...(isOfficialModelDemo ? {
            llmBudget: { maxBrowserActionCalls: 6, maxTotalTokens: 30_000, totalTimeoutMs: 120_000 }
          } : {})
        });
        if (outcome?.success) {
          input.setAutomationFailures([]);
          input.setPlanningAutomation({ phase: "ready", detail: outcome.detail });
          input.setMessage(outcome.detail);
        } else {
          const failure: AutomationFailure = { scenarioId: "dynamic-browser-agent", title: "动态浏览器自动化", target: project.frontendUrl, stage: "execution", detail: outcome?.detail ?? "动态浏览器 Run 未返回结果" };
          input.setAutomationFailures([failure]);
          await input.analyzeAutomationFailures([failure], 0);
          input.setPlanningAutomation({ phase: "blocked", detail: failure.detail });
          input.setMessage(failure.detail);
        }
        return;
      }
      input.setPlanningAutomation({ phase: "discovering", detail: "正在读取真实页面、控件、接口和可验证结果。" });
      const reusable = input.discovery && input.discovery.target.projectId === project.id
        && input.discovery.orchestration?.status === "ready"
        && Date.now() - new Date(input.discovery.observation.capturedAt).getTime() < 10 * 60_000
        ? input.discovery : undefined;
      const response = reusable ? { discovery: reusable } : await runDiscoveryScan({
        appUrl: project.frontendUrl, projectId: project.id, sourceContexts: activePlanning.analysis.sourceContexts,
        goal: input.requirementText || activePlanning.plan.sessionName, credentialId: input.defaultCredential?.id
      });
      input.setDiscovery(response.discovery);
      input.setScenarioDrafts(response.discovery.drafts);
      if (response.discovery.status === "waiting-auth") {
        input.setPlanningMessages((current) => [...current, {
          id: `discovery_waiting_auth_${Date.now()}`, role: "assistant", content: response.discovery.message, createdAt: new Date().toISOString(),
          repairPlan: {
            owner: "user", type: "credential_required", executable: false, problem: "被测页面是登录入口，未配置可用的测试账号。",
            steps: ["打开凭据管理，新增本项目可用的测试账号。", "不要在对话中直接发送密码，凭据只在服务端加密保存。", "保存后重新执行页面扫描。"],
            validation: "重新扫描后页面不再停留在登录页，且能发现可操作控件。", message: response.discovery.message, status: "pending", action: "configure-credentials"
          }
        }]);
        input.setPlanningAutomation({ phase: "needs-credentials", detail: "被测页面需要登录，请先配置测试账号再重新扫描。" });
        input.setRevealProjectLoginSettings(true);
        input.setMessage("被测页面需要登录，请先配置测试账号。");
        return;
      }
      if (response.discovery.status === "failed") throw new Error(response.discovery.message);
      const recommendedIds = response.discovery.recommendedScenarioIds?.length
        ? response.discovery.recommendedScenarioIds
        : response.discovery.recommendedScenarioId ? [response.discovery.recommendedScenarioId] : [];
      const selectedDrafts = recommendedIds.length
        ? recommendedIds.map((id) => response.discovery.drafts.find((draft) => draft.scenarioId === id)).filter((draft): draft is HarnessGapScenarioDraft => Boolean(draft))
        : [chooseDiscoveryDraft(input.requirementText, activePlanning, response.discovery)].filter((draft): draft is HarnessGapScenarioDraft => Boolean(draft));
      const compiledScenarioIds = Array.from(new Set(activePlanning.businessFlows.filter((flow) => flow.status === "executable" && Boolean(flow.scenarioId)).map((flow) => flow.scenarioId!)));
      if (!selectedDrafts.length && !compiledScenarioIds.length) throw new Error("页面扫描没有找到可安全执行的测试路径。");
      input.setPlanningMessages((current) => [...current, { id: `discovery_summary_${Date.now()}`, role: "assistant", content: `真实页面扫描完成：已确认 ${selectedDrafts.length} 个低风险业务功能可以开始验证。尚未确认的功能会保留在清单中，不会被误报为已测试。`, createdAt: new Date().toISOString() }]);
      const selectionMode = response.discovery.selectionProvenance?.mode === "llm-assisted" ? "LLM 已在真实页面候选中选定最符合目标的路径"
        : response.discovery.selectionProvenance?.mode === "deterministic-fallback" ? "LLM 选择不可用，已采用验证过的安全基线路径"
          : selectedDrafts.length > 1 ? `全面灰度模式已选出 ${selectedDrafts.length} 条低风险真实页面路径` : "规则已找到唯一高置信度路径";
      input.setPlanningAutomation({ phase: "binding", detail: `${selectionMode}；正在确认页面元素、操作、预期结果和证据要求。`, scenarioId: selectedDrafts[0]?.scenarioId });
      const approvedScenarioIds = [...compiledScenarioIds];
      const bindingFailures: AutomationFailure[] = [];
      const bindingRepairs: string[] = [];
      for (const [index, draft] of selectedDrafts.entries()) {
        activeScenarioId = draft.scenarioId;
        input.setPlanningAutomation({ phase: "binding", detail: `正在确认第 ${index + 1}/${selectedDrafts.length} 条路径的页面元素、操作、预期结果和证据要求。`, scenarioId: draft.scenarioId });
        const probed = await probeScenarioDraft(draft.scenarioId, input.defaultCredential?.id);
        input.setScenarioDrafts((current) => [probed.draft, ...current.filter((item) => item.scenarioId !== probed.draft.scenarioId)]);
        const flow = activePlanning.businessFlows.find((candidate) => candidate.scenarioId === draft.scenarioId || candidate.id === draft.gapId);
        const scenarioTitle = typeof draft.scenario.title === "string" ? draft.scenario.title : undefined;
        const successfulRepairs = (probed.draft.repairAttempts ?? []).filter((attempt) => attempt.status === "repaired");
        if (successfulRepairs.length) bindingRepairs.push(`${draft.scenarioId}：${successfulRepairs.map((attempt) => `${attempt.strategy === "llm-assisted" ? "AI" : "规则"}修复 ${attempt.changedFields.join("、")}`).join("；")}`);
        if (probed.draft.selectorProbeStatus !== "passed") {
          bindingFailures.push({ scenarioId: draft.scenarioId, title: flow?.title ?? scenarioTitle ?? draft.scenarioId, target: probed.draft.probeUrl ?? probed.draft.probeTrace?.navigationUrl, stage: "binding", detail: probed.draft.missingInfo?.join("、") || "无法验证选择器和预期结果", requiredInformation: probed.draft.missingInfo ?? [] });
          continue;
        }
        const approved = await approveScenarioDraft(draft.scenarioId);
        if (approved.draft.draftReviewStatus === "approved") {
          if (!approvedScenarioIds.includes(approved.draft.scenarioId)) approvedScenarioIds.push(approved.draft.scenarioId);
        } else {
          bindingFailures.push({ scenarioId: draft.scenarioId, title: flow?.title ?? scenarioTitle ?? draft.scenarioId, target: approved.draft.probeUrl ?? approved.draft.probeTrace?.navigationUrl, stage: "binding", detail: approved.draft.missingInfo?.join("、") || "测试路径未通过自动可执行性校验", requiredInformation: approved.draft.missingInfo ?? [] });
        }
      }
      if (bindingRepairs.length) input.setPlanningMessages((current) => [...current, { id: `binding_repair_${Date.now()}`, role: "assistant", content: `页面操作已自动重新确认并验证：${bindingRepairs.join("；")}。所有调整都限制在已观察到的按钮、标题、testId 和网络请求内，没有修改被测项目代码。`, createdAt: new Date().toISOString() }]);
      if (!approvedScenarioIds.length) {
        await input.analyzeAutomationFailures(bindingFailures, 0);
        const detail = `${bindingFailures.length} 条候选路径未能在实际页面确认操作和预期结果，已完成 LLM/规则归因；没有可安全执行的路径被伪装成通过。`;
        input.setPlanningAutomation({ phase: "blocked", detail });
        input.setMessage(detail);
        return;
      }
      input.setScenarioId(approvedScenarioIds[0]!);
      const scenarios = await listScenarios();
      input.setScenarios(scenarios.scenarios);
      input.setPlanningAutomation({ phase: "starting-run", detail: `正在创建 1 个父运行并调度 ${approvedScenarioIds.length} 条独立路径。${bindingFailures.length ? `另有 ${bindingFailures.length} 条绑定失败，已保留诊断。` : ""}`, scenarioId: approvedScenarioIds[0] });
      const coverageScenarioIds = comprehensiveRun ? Array.from(new Set(activePlanning.businessFlows.map((flow) => flow.scenarioId ?? flow.id))) : approvedScenarioIds;
      const outcome = await input.executeConfirmedScenarioAutomatically(approvedScenarioIds[0]!, grantedProfile, { appUrl: project.frontendUrl, projectId: project.id, batchMode: true, coverageScenarioIds });
      const completedCount = outcome?.success ? approvedScenarioIds.length : 0;
      const executionFailures: AutomationFailure[] = outcome?.success ? [] : [{ scenarioId: approvedScenarioIds[0]!, title: activePlanning.businessFlows.find((flow) => flow.scenarioId === approvedScenarioIds[0])?.title, target: project.frontendUrl, stage: "execution", detail: outcome?.detail ?? "父运行未返回有效聚合结果" }];
      const queuedFailures = [...bindingFailures, ...executionFailures];
      if (queuedFailures.length) {
        await input.analyzeAutomationFailures(queuedFailures, completedCount);
        const detail = `已继续完成 ${completedCount} 条路径；${queuedFailures.length} 条失败链路已交给 AI 归因，等待确认修复后重试。`;
        input.setPlanningAutomation({ phase: "blocked", detail });
        input.setMessage(detail);
      } else {
        input.setAutomationFailures([]);
        const detail = `${completedCount} 条测试路径已全部执行完成。`;
        input.setPlanningAutomation({ phase: "ready", detail, scenarioId: approvedScenarioIds.at(-1) });
        input.setMessage(detail);
      }
    } catch (error) {
      const detail = input.userFacingError(error instanceof Error ? error.message : "自动生成可执行测试路径失败");
      input.setAutomationFailures([{ scenarioId: activeScenarioId ?? "automation-preparation", title: "自动化测试准备", stage: "execution", detail }]);
      input.setPlanningAutomation({ phase: "blocked", detail });
      input.setMessage(detail);
    }
  }

  return { continueAutomaticPlanning };
}
