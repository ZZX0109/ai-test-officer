import { randomUUID } from "node:crypto";
import {
  browserActionDecisionSchema,
  browserActionResultSchema,
  llmBudgetSchema,
  type AgentGraphNode,
  type AgentInterrupt,
  type BrowserActionDecision
} from "@ai-test-officer/contracts";
import type { AgentGraphState } from "@ai-test-officer/agent-orchestration";
import { runEventStore } from "../runEventStore.js";
import { getProject, getProjectRuntimeStatusWithRecovery } from "../projectAdapter.js";
import {
  isCoverageTerminal,
  readCoverageItems,
  saveCoverageItems,
  updateCoverageDisposition
} from "../coverageStore.js";
import {
  dynamicBrowserScenarioId,
  ensureBrowserAgentSession,
  observeManagedBrowserSession,
  reloadManagedBrowserSession,
  updateManagedBrowserSession
} from "../browser-agent/sessionManager.js";
import { decideNextBrowserActions } from "../browser-agent/llmDecision.js";
import { browserActionPolicy, executeBrowserAgentAction } from "../browser-agent/actionBroker.js";
import { appendBrowserDecision, readBrowserActionResults } from "../browser-agent/store.js";
import { getProjectLoginSecret } from "../projectLoginStore.js";
import { listCredentials } from "../credentialStore.js";
import { getAgentSustainability } from "../agentSustainability.js";
import { credentialInterruptDecision } from "../browser-agent/login.js";
import { credentialInterruptMeta } from "./runtimeRecovery.js";
import {
  browserActionCompletesBusinessPath,
  browserPathResultsAreGrounded,
  coverageItemRepresentsAuthentication
} from "./browserExecutionProof.js";

const browserPathsPerGraphTurn = Math.max(1, Math.min(
  Number.parseInt(process.env.BROWSER_GRAPH_PATHS_PER_TURN ?? "3", 10) || 3,
  8
));
const browserModelCooldownMs = Math.max(1_000, Math.min(
  Number.parseInt(process.env.BROWSER_MODEL_COOLDOWN_MS ?? "5000", 10) || 5_000,
  30_000
));
const browserModelCooldownUntil = new Map<string, number>();

type NodeOperation = (state: AgentGraphState) => Promise<Record<string, unknown>>;
type WrapNode = (name: AgentGraphNode, operation: NodeOperation) => (state: AgentGraphState) => Promise<Record<string, unknown>>;

export function createBrowserExecutionHooks(input: { node: WrapNode }) {
  const { node } = input;
  return {
    observeBrowser: node("observe-browser", async (state) => {
      const run = await runEventStore.get(state.runId);
      if (!run) throw new Error("browser_agent_run_missing");
      const project = state.projectId ? await getProject(state.projectId) : undefined;
      const runtime = state.projectId ? await getProjectRuntimeStatusWithRecovery(state.projectId) : undefined;
      const url = runtime?.frontendUrl ?? project?.frontendUrl ?? (typeof run.input.appUrl === "string" ? run.input.appUrl : undefined);
      if (!url) throw new Error("browser_agent_target_url_missing");
      if (runtime && runtime.status !== "running") throw new Error(`browser_agent_runtime_${runtime.status}`);
      const coverage = await readCoverageItems(state.runId);
      const current = coverage.find((item) => item.id === state.currentCoverageItemId && item.surface === "page")
        ?? coverage.find((item) => item.disposition === "pending" && item.surface === "page")
        ?? coverage.find((item) => item.surface === "page");
      if (!current) throw new Error("browser_agent_coverage_missing");
      if (!isCoverageTerminal(current) && current.disposition !== "binding") {
        await updateCoverageDisposition({
          runId: state.runId, coverageItemId: current.id, disposition: "binding", reason: "binding_runtime_controls"
        });
      }
      const attemptId = state.currentAttemptId ?? `attempt_${randomUUID()}`;
      const session = await ensureBrowserAgentSession({
        runId: state.runId, attemptId, projectId: state.projectId, url,
        allowedOrigins: project?.allowedOrigins, routes: [{ id: "project-root", path: url }], headless: true
      });
      const observation = await observeManagedBrowserSession({ runId: state.runId, coverageItemId: current.id });
      return {
        currentCoverageItemId: current.id,
        currentAttemptId: attemptId,
        browserSession: session,
        browserObservation: observation,
        browserActionAuthorized: false,
        browserLoopComplete: false,
        browserBatchResumed: false,
        browserBatchDelayMs: undefined
      };
    }),
    decideBrowserAction: node("decide-browser-action", async (state) => {
      const observation = state.browserObservation;
      const session = state.browserSession;
      if (!observation || !session || !state.currentCoverageItemId) throw new Error("browser_agent_observation_missing");
      const run = await runEventStore.get(state.runId);
      if (!run) throw new Error("browser_agent_run_missing");
      const browserBudget = llmBudgetSchema.safeParse(run.input.llmBudget);
      const maxBrowserActionCalls = browserBudget.success ? browserBudget.data.maxBrowserActionCalls : 6;
      if (session.actionCount >= maxBrowserActionCalls || session.decisionCount >= maxBrowserActionCalls || session.rebindCount > 2) {
        const decision = browserActionDecisionSchema.parse({
          schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
          runId: state.runId, attemptId: observation.attemptId, observationId: observation.observationId,
          status: "blocked", reasonCode: "budget-exhausted", summary: "动态浏览器 Agent 已达到动作或重新绑定预算，停止循环以避免误操作。",
          actions: [], oracles: [], evidenceRefs: observation.evidenceRefs,
          userQuestion: "请查看当前页面和失败证据后决定是否继续。", createdAt: new Date().toISOString()
        });
        await appendBrowserDecision(decision);
        return { browserDecision: decision, browserLoopComplete: true };
      }
      const project = state.projectId ? await getProject(state.projectId) : undefined;
      const detectedLoginDecision = credentialInterruptDecision({
        runId: state.runId, coverageItemId: state.currentCoverageItemId, observation,
        configured: Boolean(project?.login?.credentialId)
      });
      const loginDecision = detectedLoginDecision
        && state.browserCredentialAuthorized === true
        && detectedLoginDecision.actions[0]?.action === "fill-control"
        && detectedLoginDecision.actions[0].valueRef.startsWith("credential.")
        ? { ...detectedLoginDecision, status: "act" as const, userQuestion: undefined }
        : detectedLoginDecision;
      if (loginDecision) {
        await appendBrowserDecision(loginDecision);
        return { browserDecision: loginDecision, browserSession: session, browserActionAuthorized: false };
      }
      const credentials = await listCredentials();
      const modelProfileId = typeof run.input.modelProfileId === "string"
        ? run.input.modelProfileId
        : credentials.find((item) => item.isDefault)?.id;
      const coverage = await readCoverageItems(state.runId);
      const item = coverage.find((entry) => entry.id === state.currentCoverageItemId);
      const prior = await readBrowserActionResults(state.runId);
      let decision: BrowserActionDecision;
      const modelCooldownKey = modelProfileId ?? "default";
      const cooldownRemainingMs = Math.max(0, (browserModelCooldownUntil.get(modelCooldownKey) ?? 0) - Date.now());
      const transientPageFault = observation.controls.length === 0
        && observation.failedRequests.some((request) => /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED/i.test(request.failure ?? ""));
      if (cooldownRemainingMs > 0) {
        decision = browserActionDecisionSchema.parse({
          schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
          runId: state.runId, attemptId: observation.attemptId, observationId: observation.observationId,
          status: "blocked", reasonCode: "model-rate-limited",
          summary: `模型服务正在冷却，${Math.ceil(cooldownRemainingMs / 1000)} 秒后会自动继续当前页面路径。`,
          actions: [], oracles: [], evidenceRefs: observation.evidenceRefs, createdAt: new Date().toISOString()
        });
      } else if (transientPageFault) {
        decision = browserActionDecisionSchema.parse({
          schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
          runId: state.runId, attemptId: observation.attemptId, observationId: observation.observationId,
          status: "blocked", reasonCode: "transient-observation", summary: "页面资源加载期间网络发生变化，自动刷新同一浏览器会话后重新观测。",
          actions: [], oracles: [], evidenceRefs: observation.evidenceRefs, createdAt: new Date().toISOString()
        });
      } else try {
        decision = await decideNextBrowserActions({
          observation, coverageItemId: state.currentCoverageItemId,
          goal: [run.input.requirement, item?.module, item?.dispositionReason].filter(Boolean).join("\n"),
          credentialId: modelProfileId, allowedRouteIds: ["project-root"],
          previousResults: prior.map((result) => ({ action: result.actionId, status: result.status, summary: result.summary })),
          budget: browserBudget.success ? browserBudget.data : undefined
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "browser_llm_decision_failed";
        const rateLimitedModelFailure = /(?:provider_http_429|http_429|rate[ _-]?limit|too many requests)/i.test(code);
        const retryableModelFailure = /fetch_failed|provider_|timeout|network|empty_response|responses_incomplete/i.test(code);
        if (rateLimitedModelFailure) browserModelCooldownUntil.set(modelCooldownKey, Date.now() + browserModelCooldownMs);
        decision = browserActionDecisionSchema.parse({
          schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
          runId: state.runId, attemptId: observation.attemptId, observationId: observation.observationId,
          status: "blocked",
          reasonCode: rateLimitedModelFailure ? "model-rate-limited" : retryableModelFailure ? "transient-model" : code.startsWith("llm_budget_exceeded") ? "budget-exhausted" : undefined,
          summary: code.startsWith("llm_budget_exceeded")
            ? `当前业务路径已达到独立的浏览器 AI 预算（${code}），系统会保留该路径证据并继续处理其他路径。`
            : rateLimitedModelFailure
              ? `模型服务暂时限流，系统会在 ${Math.ceil(browserModelCooldownMs / 1000)} 秒后自动重试当前页面路径。`
              : retryableModelFailure ? `浏览器模型调用暂时失败：${code}` : `浏览器 AI 决策失败：${code}`,
          actions: [], oracles: [], evidenceRefs: observation.evidenceRefs,
          userQuestion: retryableModelFailure || rateLimitedModelFailure
            ? undefined
            : code.startsWith("llm_budget_exceeded")
              ? "当前路径不会继续消耗预算；其他业务路径将继续执行。"
              : "系统已保留页面观测，请查看模型调用错误后重试。",
          createdAt: new Date().toISOString()
        });
      }
      await appendBrowserDecision(decision);
      const updated = await updateManagedBrowserSession(state.runId, { decisionCount: session.decisionCount + 1 });
      return { browserDecision: decision, browserSession: updated, browserActionAuthorized: false };
    }),
    authorizeBrowserAction: async (
      state: AgentGraphState,
      answer?: Record<string, unknown>
    ): Promise<Partial<AgentGraphState> & { browserInterrupt?: AgentInterrupt }> => {
      const decision = state.browserDecision;
      const observation = state.browserObservation;
      const action = decision?.actions[0];
      if (!decision || !observation || !action) return { browserActionAuthorized: false };
      const controlId = "controlId" in action ? action.controlId : undefined;
      const control = controlId ? observation.controls.find((item) => item.controlId === controlId) : undefined;
      const policy = browserActionPolicy(action, control);
      const credentialAction = action.action === "fill-control" && "valueRef" in action && action.valueRef.startsWith("credential.");
      if (answer) {
        const approved = answer.approved === true || answer.decision === "approved";
        return {
          browserActionAuthorized: approved,
          ...(credentialAction ? { browserCredentialAuthorized: approved } : {}),
          browserDecision: approved ? { ...decision, status: "act" } : { ...decision, status: "blocked", actions: [], userQuestion: "用户未批准该浏览器动作。" }
        };
      }
      if (credentialAction && state.browserCredentialAuthorized === true) return { browserActionAuthorized: true, browserDecision: { ...decision, status: "act" } };
      if (credentialAction) {
        const credentialMeta = await credentialInterruptMeta(state.projectId);
        if (credentialMeta.hasSavedCredential) {
          return { browserActionAuthorized: true, browserCredentialAuthorized: true, browserDecision: { ...decision, status: "act", userQuestion: undefined } };
        }
      }
      if (policy.allowed) return { browserActionAuthorized: true, browserDecision: { ...decision, status: "act", userQuestion: undefined } };
      if (!policy.confirmation && decision.status !== "needs-confirmation") {
        return { browserActionAuthorized: false, browserDecision: { ...decision, status: "blocked", reasonCode: "policy-blocked", actions: [], summary: "浏览器动作被安全策略拒绝。" } };
      }
      const interrupt: AgentInterrupt = await (async () => {
        const meta = credentialAction ? await credentialInterruptMeta(state.projectId) : { hasSavedCredential: false };
        return {
          id: `interrupt_${randomUUID()}`,
          runId: state.runId,
          kind: credentialAction ? "credential" : "dangerous-operation",
          status: "pending",
          title: credentialAction ? "需要测试账号" : "需要确认浏览器操作",
          detail: credentialAction
            ? meta.hasSavedCredential
              ? `已识别登录页面，并已保存测试账号${meta.usernameMasked ? `（${meta.usernameMasked}）` : ""}。授权后系统仅在当前沙盒会话中注入登录；账号和密码不会显示或写入报告。`
              : "已识别登录页面，但尚未配置测试账号。请在下方填写账号和密码，或暂不登录；账号会加密保存并仅注入沙盒，不会显示或写入报告。"
            : `${action.purpose}。预期变化：${action.expectedChange}`,
          requestedCapabilities: [credentialAction ? "credential" : "browserControl"],
          payload: { actionId: action.actionId, action: action.action, policyCode: policy.code },
          owner: "user",
          context: {
            browserDecisionId: decision.decisionId, actionId: action.actionId,
            ...(credentialAction ? { hasSavedCredential: meta.hasSavedCredential, ...(meta.usernameMasked ? { usernameMasked: meta.usernameMasked } : {}) } : {})
          },
          options: credentialAction
            ? meta.hasSavedCredential
              ? [{ value: "approved", label: "使用已保存账号继续" }, { value: "dismiss", label: "暂不登录" }]
              : [{ value: "approved", label: "保存账号并继续" }, { value: "dismiss", label: "暂不登录" }]
            : [{ value: "approved", label: "允许本次操作" }, { value: "dismiss", label: "拒绝" }],
          evidenceRefs: decision.evidenceRefs,
          createdAt: new Date().toISOString()
        } satisfies AgentInterrupt;
      })();
      return { browserActionAuthorized: false, browserInterrupt: interrupt };
    },
    executeBrowserAction: node("execute-browser-action", async (state) => {
      const decision = state.browserDecision;
      const action = decision?.actions[0];
      if (!decision || !action) throw new Error("browser_agent_action_missing");
      if (state.currentCoverageItemId) {
        await updateCoverageDisposition({ runId: state.runId, coverageItemId: state.currentCoverageItemId, disposition: "executing", reason: `browser_action:${action.action}` });
      }
      const project = state.projectId ? await getProject(state.projectId) : undefined;
      const userAuthorized = state.browserActionAuthorized === true || state.browserCredentialAuthorized === true;
      const gateway = getAgentSustainability().tools;
      const gatewayResult = await gateway.execute({
        callId: `browser:${action.actionId}`,
        capability: "browser.act",
        runId: state.runId,
        toolVersion: "1.0.0",
        approved: true,
        params: { runId: state.runId, action, oracles: decision.oracles, userAuthorized }
      });
      let result: import("@ai-test-officer/contracts").BrowserActionResult | undefined;
      if (gatewayResult.data && typeof gatewayResult.data === "object" && "resultId" in gatewayResult.data) {
        result = browserActionResultSchema.parse(gatewayResult.data);
      } else if (gatewayResult.errorCode !== "browser_action_unavailable" && !gatewayResult.success) {
        throw new Error(gatewayResult.error?.message ?? gatewayResult.errorCode ?? "browser_gateway_failed");
      }
      if (!result) {
        // Unit/CLI graph runners may not load the HTTP composition layer. Keep
        // the direct executor only as a compatibility adapter in that case;
        // production requests always take the gateway path above.
        result = await executeBrowserAgentAction({
          action, oracles: decision.oracles,
          userAuthorized,
          resolveValue: async (valueRef) => {
            if (valueRef.startsWith("testData.")) return `ato-${valueRef.slice("testData.".length).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
            if (valueRef.startsWith("credential.")) {
              const secretId = project?.login?.credentialId;
              if (!secretId) throw new Error("browser_credential_missing");
              const secret = await getProjectLoginSecret(secretId);
              if (!secret) throw new Error("browser_credential_missing");
              const field = valueRef.slice("credential.".length).toLowerCase();
              if (/user|email|account/.test(field)) return secret.username;
              if (/pass/.test(field)) return secret.password;
              throw new Error("browser_credential_field_not_allowed");
            }
            throw new Error("browser_value_ref_not_supported");
          }
        });
      }
      return { browserActionResult: result, browserActionAuthorized: false };
    }),
    verifyBrowserAction: node("verify-browser-action", async (state) => {
      const result = state.browserActionResult;
      if (!result) throw new Error("browser_agent_action_result_missing");
      const hasFailedOracle = result.oracleResults.some((oracle) => !oracle.passed);
      return {
        browserLoopComplete: result.status !== "completed" || hasFailedOracle,
        failure: result.status === "completed" && !hasFailedOracle ? undefined : {
          status: result.status === "failed" ? "fail" : "blocked",
          reasons: [result.errorCode ?? result.summary], evidenceRefs: result.evidenceRefs,
          repairable: result.errorCode === "browser_control_binding_stale"
        }
      };
    }),
    decideNextStep: node("decide-next-step", async (state) => {
      const result = state.browserActionResult;
      const decision = state.browserDecision;
      const coverage = await readCoverageItems(state.runId);
      const currentIndex = coverage.findIndex((item) => item.id === state.currentCoverageItemId);
      if (currentIndex < 0) return { browserLoopComplete: true };
      const pathResults = (await readBrowserActionResults(state.runId))
        .filter((item) => item.coverageItemId === state.currentCoverageItemId && (decision ? item.attemptId === decision.attemptId : true));
      const transientDecision = decision?.status === "blocked"
        && (decision.reasonCode === "transient-observation" || decision.reasonCode === "transient-model");
      if (transientDecision && (state.browserSession?.rebindCount ?? 0) < 2) {
        const session = await reloadManagedBrowserSession(state.runId);
        return { browserSession: session, browserDecision: undefined, browserActionResult: undefined, browserLoopComplete: false, failure: undefined };
      }
      if (decision?.status === "blocked" && decision.reasonCode === "model-rate-limited" && (state.browserRateLimitRetries ?? 0) < 1) {
        return {
          browserDecision: undefined, browserActionResult: undefined, browserLoopComplete: false,
          browserBatchPending: true, browserBatchDelayMs: browserModelCooldownMs, browserBatchResumed: false,
          browserRateLimitRetries: (state.browserRateLimitRetries ?? 0) + 1, failure: undefined,
          observation: { ...(state.observation ?? {}), stage: "model-cooldown", status: "waiting", summary: `模型服务限流，正在等待 ${Math.ceil(browserModelCooldownMs / 1000)} 秒后自动继续当前路径。` }
        };
      }
      let terminalDisposition: "executed" | "failed" | "blocked" | undefined;
      let dispositionReason: string | undefined;
      const completedLoginBoundary = result?.status === "completed"
        && result.oracleResults.length > 0
        && result.oracleResults.every((oracle) => oracle.passed)
        && result.oracleResults.some((oracle) => oracle.oracleId === "oracle_login_submit_changes_page");
      const currentCoverage = coverage[currentIndex];
      const currentPathIsAuthentication = coverageItemRepresentsAuthentication(currentCoverage);
      if (completedLoginBoundary && !currentPathIsAuthentication) {
        return { browserDecision: undefined, browserActionResult: undefined, browserLoopComplete: false, failure: undefined };
      }
      if (completedLoginBoundary) {
        terminalDisposition = "executed";
        dispositionReason = "已使用保存的测试账号登录，并验证登录页面已退出";
      } else if (browserActionCompletesBusinessPath(result)) {
        terminalDisposition = "executed";
        dispositionReason = "动态浏览器动作已执行，绑定的机器 Oracle 已通过";
      } else if (decision?.status === "complete") {
        const grounded = browserPathResultsAreGrounded(pathResults);
        terminalDisposition = grounded ? "executed" : "blocked";
        dispositionReason = grounded ? "动态浏览器动作和确定性 Oracle 已完成" : "浏览器 Agent 宣布完成，但缺少通过的确定性 Oracle";
      } else if (result?.status === "completed" && result.oracleResults.some((oracle) => !oracle.passed)) {
        terminalDisposition = "failed";
        dispositionReason = result.summary;
      } else if (decision?.status === "blocked") {
        terminalDisposition = "blocked";
        dispositionReason = decision.summary;
      } else if (result && result.status !== "completed") {
        terminalDisposition = "blocked";
        dispositionReason = result.summary;
      }
      if (!terminalDisposition) return { browserLoopComplete: false };
      coverage[currentIndex] = {
        ...coverage[currentIndex], disposition: terminalDisposition, dispositionReason,
        scenarioId: dynamicBrowserScenarioId(state.runId), attemptId: state.currentAttemptId, updatedAt: new Date().toISOString()
      };
      await saveCoverageItems(state.runId, coverage);
      const next = coverage.find((item) => item.disposition === "pending" && item.surface === "page");
      if (next) {
        const session = await updateManagedBrowserSession(state.runId, { actionCount: 0, decisionCount: 0, rebindCount: 0 });
        const pathsInBatch = (state.browserBatchPathCount ?? 0) + 1;
        const yieldBatch = pathsInBatch >= browserPathsPerGraphTurn;
        return {
          currentCoverageItemId: next.id, browserSession: session, browserDecision: undefined, browserActionResult: undefined,
          browserLoopComplete: false, browserBatchPathCount: pathsInBatch, browserBatchPending: yieldBatch,
          browserBatchDelayMs: undefined, browserBatchResumed: false, browserRateLimitRetries: 0,
          observation: {
            ...(state.observation ?? {}), stage: "browser-batch", status: yieldBatch ? "waiting" : "running",
            summary: yieldBatch
              ? `已完成本批 ${pathsInBatch} 条页面路径，正在保存进度并自动继续下一批。`
              : `已完成本批第 ${pathsInBatch} 条页面路径，继续处理下一条。`
          }
        };
      }
      const remainingStructuredPaths = coverage.filter((item) =>
        item.disposition === "pending" && item.surface !== "page" && Boolean(item.structuredPlan)
      ).length;
      return {
        browserLoopComplete: true, browserBatchPending: false, browserBatchDelayMs: undefined,
        browserBatchResumed: false, remainingPathCount: remainingStructuredPaths
      };
    })
  };
}
