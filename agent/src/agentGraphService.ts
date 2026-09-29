import {
  agentPermissionProfileSchema,
  resolveFinalStatus,
  type JudgeRecommendation,
  type MachineGate,
  type AgentGraphProjection,
  type AgentInterrupt,
  type BrowserObservation,
  pathExecutionResultSchema
} from "@ai-test-officer/contracts";
import { randomUUID } from "node:crypto";
import {
  createAgentCheckpointer,
  createAgentOrchestrationGraph,
  toJsonObject,
  type AgentGraphState,
  type EvidenceGateSubgraphInput
} from "@ai-test-officer/agent-orchestration";
import { readAgentGraphProjection, saveAgentGraphProjection } from "./agentGraphProjectionStore.js";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { executeAgentNodeIdempotently } from "./agentNodeExecutionStore.js";
import { appendEvidence, readEvidence, readRunBundle, writeRunBundle } from "./evidenceStore.js";
import { getProject, getProjectRuntimeStatusWithRecovery, startProject } from "./projectAdapter.js";
import { planRunFromDurableInput } from "./runPlanningService.js";
import {
  createCoverageItems,
  createDynamicBrowserCoverageItems,
  createManifestCoverageItems,
  isCoverageExercised,
  isCoverageTerminal,
  readCoverageItems,
  saveCoverageItems
} from "./coverageStore.js";
import { buildProofGraph, readProofArtifacts, writeProofArtifacts } from "./proofGraph.js";
import { persistParentAggregateEvidence } from "./parentRunEvidence.js";
import { buildLlmJudgeReport } from "./llmJudge.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { finalizeProofBundle, type MachineGateDraft } from "./proof/proofBundleService.js";
import { decideRepairFromDeterministic, mapDeterministicClassToFailureClass } from "./repairDecision.js";
import { persistRepairPlan } from "./repairPlan.js";
import type { EvidenceItem } from "./types.js";
import { runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import { getScenario } from "./scenarios.js";
import { getAgentSustainability } from "./agentSustainability.js";
import { withGraphExecutionScope } from "./graphSideEffects.js";
import { persistAgentObservation } from "./recoveryStore.js";
import {
  finalizeBrowserAgentTrace,
  dynamicBrowserScenarioId,
  closeBrowserAgentSession
} from "./browser-agent/sessionManager.js";
import { persistDynamicBrowserResult } from "./browser-agent/resultBundle.js";
import { readBrowserActionResults, readBrowserArtifacts } from "./browser-agent/store.js";
import { listLlmCalls } from "./llmProvider.js";
import {
  browserActionCompletesBusinessPath,
  browserPathResultsAreGrounded,
  coverageItemRepresentsAuthentication,
  deterministicRecommendation,
  finalizeBrowserExecutionProof,
  interactiveCoverageInventory,
  machineGateFromResult,
  persistBrowserPhaseForAggregate
} from "./graph/browserExecutionProof.js";
import {
  collectFailureEvidenceRefs,
  repairOperation
} from "./graph/repairOperation.js";
import {
  buildDiscoveryEvidence,
  deterministicRecoveryDecision,
  discoveryBlockedGate,
  discoveryCanHandOffToDynamicBrowser,
  discoverySourceContexts,
  discoveryState,
  requiresActiveBrowserDiscovery,
  requiresFullCoverage
} from "./graph/runtimeRecovery.js";
import { createRuntimeRecoveryHooks } from "./graph/runtimeRecoveryHooks.js";
import { createBrowserExecutionHooks } from "./graph/browserExecutionHooks.js";

export {
  browserActionCompletesBusinessPath,
  browserPathResultsAreGrounded,
  coverageItemRepresentsAuthentication
} from "./graph/browserExecutionProof.js";
export {
  discoveryCanHandOffToDynamicBrowser,
  requiresActiveBrowserDiscovery
} from "./graph/runtimeRecovery.js";

const scheduledBrowserBatchResumes = new Set<string>();

type GraphService = Awaited<ReturnType<typeof buildService>>;
let servicePromise: Promise<GraphService> | undefined;
// A run can be started from the POST /v1/runs background hand-off and, almost
// immediately afterwards, from a control endpoint which needs to synchronise
// the graph to an approval checkpoint. LangGraph persists checkpoints, but it
// does not serialize concurrent invokes for the same thread. Merge local
// callers before they contend for a durable node lease.
const inFlightGraphStarts = new Map<string, Promise<unknown>>();

export function agentOrchestrationMode(projectId?: string): "shadow" | "active" {
  // Product runs always use the authoritative graph. Shadow comparison belongs
  // to the benchmark harness and must never silently route an uploaded project
  // through the retired direct-run pipeline.
  void projectId;
  return "active";
}

async function buildService() {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for production agent orchestration");
  }
  const checkpointer = await createAgentCheckpointer({
    databaseUrl: process.env.DATABASE_URL,
    schema: process.env.LANGGRAPH_POSTGRES_SCHEMA ?? "langgraph"
  });
  // Single middleware chokepoint for every graph hook: it establishes the
  // async side-effect scope so shadow runs are firewalled by the stores
  // themselves rather than by per-node `if (mode === "shadow")` checks, which
  // is how the previous leaks slipped in.
  const node = <T extends Pick<AgentGraphState, "runId" | "mode">>(
    name: Parameters<typeof executeAgentNodeIdempotently>[1],
    operation: (state: T) => Promise<Record<string, unknown>>
  ) => async (state: T) => withGraphExecutionScope(
    { mode: state.mode, runId: state.runId },
    () => executeAgentNodeIdempotently(state.runId, name, 1, state, () => operation(state))
  );
  return createAgentOrchestrationGraph({
    checkpointer,
    hooks: {
      ...createRuntimeRecoveryHooks({ node }),
      // Discovery is intentionally not wrapped in the durable node-result
      // cache. A waiting runtime resumes the same LangGraph node and must make
      // a fresh bounded probe instead of replaying the cached waiting result.
      // The graph checkpoint still prevents a completed node from running
      // twice after a service restart.
      discover: async (state) => {
        const run = await runEventStore.get(state.runId);
        const baseCoverageMap = run?.impactAnalysis ? { impactAnalysis: run.impactAnalysis } : {};
        if (state.mode !== "active" || !run) return { coverageMap: baseCoverageMap };

        const project = typeof run.input.projectId === "string"
          ? await getProject(run.input.projectId)
          : undefined;
        if (!requiresActiveBrowserDiscovery(run, project?.manifest?.capabilities.browser !== false)) {
          return { coverageMap: baseCoverageMap };
        }

        const result = await runSmokeFirstDiscovery({
          projectId: typeof run.input.projectId === "string" ? run.input.projectId : undefined,
          appUrl: typeof run.input.appUrl === "string" ? run.input.appUrl : undefined,
          sourceContexts: discoverySourceContexts(run),
          goal: typeof run.input.requirement === "string" ? run.input.requirement : "全面扫描",
          smokeAttempts: 2,
          discoveryAttempts: 2
        });
        let discovery = discoveryState(result);
        // Build the immutable run evidence before publishing the graph-level
        // observation so its references point to real Evidence IDs rather than
        // the page observation record itself.
        const discoveryEvidence = buildDiscoveryEvidence(result, state.runId);
        // Promote the complete browser observation into the graph-level
        // observation ledger. The assistant must receive facts (URL, DOM,
        // console and network) rather than a generic "control not found"
        // string, while the original observation remains immutable in its own
        // store and is referenced by evidence IDs.
        if (result.observation) {
          const page = result.observation;
          await persistAgentObservation({
            schemaVersion: "1.0",
            id: `agent_observation_${page.id}`,
            runId: state.runId,
            stage: page.stage === "launch" ? "runtime" : page.stage === "completed" ? "dom" : "navigation",
            status: page.status === "ready" ? "ready" : page.status === "degraded" ? "degraded" : "failed",
            requestedUrl: page.requestedUrl,
            finalUrl: page.finalUrl,
            httpStatus: page.navigation.httpStatus,
            title: result.page.title,
            readyState: ["loading", "interactive", "complete", "unknown"].includes(page.document.readyState ?? "unknown")
              ? page.document.readyState as "loading" | "interactive" | "complete" | "unknown"
              : "unknown",
            accessibilityTree: page.document.accessibilityTree,
            controls: page.document.controls.map((control) => ({
              role: control.role,
              name: control.accessibleName,
              visible: control.visible,
              disabled: control.disabled,
              selector: control.testId ? `[data-testid=\"${control.testId}\"]` : undefined
            })),
            consoleErrors: page.console.filter((item) => item.type === "error").map((item) => item.text),
            pageErrors: page.pageErrors,
            failedRequests: page.failedRequests.map((item) => ({ method: item.method, url: item.url, status: item.status, failure: item.failure })),
            // The immutable discovery record is the screenshot/evidence
            // anchor; Artifact v2 IDs are attached later by the bundle writer.
            screenshotArtifactId: undefined,
            lifecycle: (page.browserLifecycle ?? []).map((item) => ({ event: item.type, at: item.at, detail: item.status })),
            summary: page.diagnosis.summary,
            evidenceRefs: discoveryEvidence.map((item) => item.id),
            retryable: page.diagnosis.retryable,
            userActionRequired: page.diagnosis.userActionRequired,
            createdAt: page.capturedAt
          }).catch(() => undefined);
        }
        // A committed application document is sufficient to hand the page to
        // the dynamic browser Agent. Static Discovery is an observation aid,
        // not the execution authority: a cold SPA can legitimately expose no
        // controls during this short probe and become actionable in the
        // long-lived Playwright session. Requiring controls here trapped the
        // Graph in retry-discovery/finalize before the browser Agent (and its
        // LLM action loop) was ever created.
        if (discoveryCanHandOffToDynamicBrowser({
          dynamicBrowser: run.input.dynamicBrowser === true,
          documentCommitted: result.observation?.navigation.documentCommitted === true,
          httpStatus: result.observation?.navigation.httpStatus
        })) {
          discovery = {
            ...discovery,
            status: "ready",
            reason: result.observation.document.interactiveElementCount > 0
              ? `runtime_controls_ready:${discovery.reason ?? "page-observed"}`
              : `runtime_document_committed_dynamic_binding:${discovery.reason ?? "controls-pending"}`
          };
        }
        // Promote the scan's real observations into evidence so the blocked gate
        // below is grounded rather than an evidence-free assertion.
        if (discovery.status === "ready") {
          return {
            coverageMap: { ...baseCoverageMap, discovery: { ...discovery, evidence: discoveryEvidence } },
            discoveryTerminal: false
          };
        }
        if (discovery.status === "waiting") {
          const dynamicBrowserCanOwnLogin = run?.input.dynamicBrowser === true
            && run.input.confirmedExecution === true
            && state.permissionProfile.browserControl !== false;
          // A login page is an observed application state, not a runtime
          // failure. Once the operator confirmed a dynamic browser run, the
          // shared Playwright session must continue into the browser Agent so
          // it can use an already saved project credential or raise the real
          // credential interrupt. The former compatibility branch stopped
          // here and made the UI claim that testing was blocked before the
          // login action broker was ever reached.
          if (dynamicBrowserCanOwnLogin) {
            return {
              coverageMap: { ...baseCoverageMap, discovery: { ...discovery, evidence: discoveryEvidence } },
              discoveryTerminal: false
            };
          }
          // Non-interactive callers still need a durable owner-tagged repair
          // plan because they cannot safely cross an authentication boundary.
          await persistRepairPlan({
            runId: state.runId,
            projectId: typeof run?.input.projectId === "string" ? run.input.projectId : undefined,
            attributionId: "discovery_waiting_auth",
            failureType: "discovery",
            problem: discovery.reason ?? "Discovery reached a login wall",
            decision: {
              owner: "user",
              type: "credential_required",
              executable: false,
              userMessage: "当前页面需要登录，请配置测试账号后重新执行 Discovery。",
              steps: ["打开凭据管理", "新增测试账号", "保存登录状态", "重新执行 Discovery"],
              validation: "重新扫描后页面不再停留在登录页",
              nextAction: "credential_required"
            },
            idempotencyKey: `discovery:${state.runId}:waiting`
          }).catch(() => undefined);
          return {
            coverageMap: { ...baseCoverageMap, discovery: { ...discovery, evidence: discoveryEvidence } },
            discoveryTerminal: true
          };
        }
        const machineGate = discoveryBlockedGate(discovery, state.runId, discoveryEvidence);
        // A blocked discovery is itself a triaged failure: persist a durable,
        // owner-tagged repair plan so the workbench can reopen it after a
        // restart (e.g. "configure credentials" for a login wall).
        await persistRepairPlan({
          runId: state.runId,
          projectId: typeof run?.input.projectId === "string" ? run.input.projectId : undefined,
          attributionId: `discovery_${discovery.status}`,
          failureType: "discovery",
          problem: discovery.reason ?? "Discovery did not reach an executable state",
          decision: {
            owner: "environment",
            type: "fix_environment",
            executable: false,
            userMessage: "Discovery 未能完成，请检查测试环境后重新诊断。",
            steps: ["检查服务/网络", "重新执行 Discovery"],
            validation: "Discovery 成功完成",
            nextAction: "fix_environment"
          },
          idempotencyKey: `discovery:${state.runId}:${discovery.status}`
        }).catch(() => undefined);
        return {
          coverageMap: { ...baseCoverageMap, discovery },
          discoveryTerminal: true,
          gate: {
            machineGate,
            finalStatus: "blocked",
            discovery
          }
        };
      },
      buildCoverageMap: node("build-coverage-map", async (state) => {
        const run = await runEventStore.get(state.runId);
        if (state.mode === "active" && run) {
          const requested = Array.isArray(run.input.coverageScenarioIds)
            ? run.input.coverageScenarioIds.filter((item): item is string => typeof item === "string")
            : [];
          const explicit = typeof run.input.scenarioId === "string" ? [run.input.scenarioId] : [];
          const current = await readCoverageItems(run.id);
          const discovered = requested.length || explicit.length
            ? createCoverageItems({ runId: run.id, scenarioIds: [...requested, ...explicit] })
            : [];
          const fullCoverage = requiresFullCoverage(run);
          const project = fullCoverage && typeof run.input.projectId === "string"
            ? await getProject(run.input.projectId)
            : undefined;
          const manifestItems = project?.manifest
            ? createManifestCoverageItems({ runId: run.id, manifest: project.manifest })
            : [];
          const merged = new Map(
            [...current, ...discovered, ...manifestItems].map((item) => [item.flowId, item])
          );
          if (merged.size) {
            await saveCoverageItems(run.id, [...merged.values()]);
          }
          const items = await readCoverageItems(run.id);
          return {
            coverageMap: {
              ...(state.coverageMap ?? {}),
              items,
              dispositionComplete: items.length > 0 && items.every(isCoverageTerminal)
            }
          };
        }
        try {
          const bundle = await readRunBundle(run?.resultRunId ?? state.runId);
          return {
            coverageMap: {
              ...(state.coverageMap ?? {}),
              items: bundle.coverageItems ?? [],
              dispositionComplete: (bundle.coverageItems ?? []).every(isCoverageTerminal)
            }
          };
        } catch {
          return {
            coverageMap: {
              ...(state.coverageMap ?? {}),
              items: [],
              dispositionComplete: false
            }
          };
        }
      }),
      plan: node("plan", async (state) => {
        const run = state.mode === "active"
          ? await planRunFromDurableInput(state.runId)
          : await runEventStore.get(state.runId);
        const planningTerminal = Boolean(run && ["awaiting-human-review", "blocked", "failed", "cancelled"].includes(run.state));
        if (state.mode === "active" && run && !planningTerminal) {
          const existing = await readCoverageItems(run.id);
          if (run.plan && run.planProvenance?.source === "dynamic-browser-agent") {
            const inventory = interactiveCoverageInventory(run.input.coverageInventory);
            const dynamicItems = createDynamicBrowserCoverageItems({
              runId: run.id,
              paths: run.plan.levels.flatMap((level) => level.paths).map((path) => ({
                id: path.id,
                title: path.title,
                status: inventory.find((item) => item.id === path.id)?.status,
                riskReason: `由动态浏览器 Agent 执行：${path.riskReason || path.steps.join(" → ")}`,
                surface: inventory.find((item) => item.id === path.id)?.surfaces?.includes("page")
                  ? "page"
                  : inventory.find((item) => item.id === path.id)?.surfaces?.includes("api")
                    ? "api"
                    : inventory.find((item) => item.id === path.id)?.surfaces?.includes("data")
                      ? "data"
                      : inventory.find((item) => item.id === path.id)?.surfaces?.includes("background-task")
                        ? "background-task"
                        : "page",
                preconditions: inventory.find((item) => item.id === path.id)?.preconditions,
                requiredEvidenceKinds: inventory.find((item) => item.id === path.id)?.requiredEvidenceKinds,
                behaviorDimensions: inventory.find((item) => item.id === path.id)?.behaviorDimensions
                  ?? (["happy-path", "negative", ...(/登录|权限|认证|审批|auth|permission|approval/i.test(path.title) ? ["permission", "recovery"] : [])] as Array<"happy-path" | "negative" | "permission" | "recovery">)
              }))
            });
            // Dynamic browser plans are the execution contract for uploaded
            // projects.  Do not retain a page Scenario Registry candidate
            // merely because impact analysis mentioned it: that stale item
            // can otherwise become the first executable coverage path and
            // silently replace the user's grouped inventory.  Non-page
            // manifest work remains eligible for its dedicated executor.
            const nonPageItems = existing.filter((item) => item.surface !== "page");
            const merged = new Map([...nonPageItems, ...dynamicItems].map((item) => [item.flowId, item]));
            await saveCoverageItems(run.id, [...merged.values()]);
          } else if (!existing.length) {
            const requested = Array.isArray(run.input.coverageScenarioIds)
              ? run.input.coverageScenarioIds.filter((item): item is string => typeof item === "string")
              : [];
            const recommended = run.impactAnalysis?.recommendedScenarios
              .filter((item) => item.confidence !== "low")
              .map((item) => item.scenarioId) ?? [];
            // A benchmark lane measures one planned path. The selected scenario
            // still comes from the rule or LLM planner, but impact-analysis
            // candidates must remain candidates rather than silently becoming
            // additional child runs with unrelated outcomes.
            const scenarioIds = run.input.executionProfile === "benchmark"
              ? (run.selectedScenarioId ? [run.selectedScenarioId] : [])
              : [...requested, ...recommended, ...(run.selectedScenarioId ? [run.selectedScenarioId] : [])];
            if (scenarioIds.length) {
              await saveCoverageItems(run.id, createCoverageItems({ runId: run.id, scenarioIds }));
            }
          }
        }
        return {
          planData: run?.plan ? { plan: run.plan, provenance: run.planProvenance } : {},
          tokenUsage: run?.plannerCalls?.reduce((total, call) => total + (call.usage.totalTokens ?? 0), 0)
            ?? (run?.plannerCall?.usage.totalTokens ?? 0),
          planningTerminal,
          browserAgentRequired: run?.planProvenance?.source === "dynamic-browser-agent"
        };
      }),
      compile: node("compile", async (state) => {
        const run = await runEventStore.get(state.runId);
        if (!run?.compiledPlan && state.mode === "active" && run?.planProvenance?.source !== "dynamic-browser-agent") {
          throw new Error("compiled_plan_missing");
        }
        if (run?.planProvenance?.source === "dynamic-browser-agent") {
          return { compiledPlan: {}, browserAgentRequired: true };
        }
        return { compiledPlan: run?.compiledPlan ? { compiledPlan: run.compiledPlan } : {} };
      }),
      prepareSandbox: node("prepare-sandbox", async (state) => {
        if (!state.projectId) return { execution: { ...(state.execution ?? {}), sandbox: "blocked", reason: "project_missing" } };
        let runtime = await getProjectRuntimeStatusWithRecovery(state.projectId);
        // The Graph owns the runnable state of an uploaded project.  An Agent
        // restart clears the in-memory runtime cache, so treating `idle` as a
        // passive "preparing" state made the following browser node fail with
        // browser_agent_runtime_idle and forced users to manually start the
        // project first.  Starting an OCI sandbox is a safe, bounded action;
        // credentials, network installation and source changes still go
        // through their own interrupts inside startProject.
        if (runtime.status !== "running") {
          runtime = await startProject(state.projectId, { runId: state.runId, attemptId: typeof state.execution?.attemptId === "string" ? state.execution.attemptId : undefined });
        }
        return {
          execution: {
            ...(state.execution ?? {}),
            sandbox: runtime.status === "running" ? "ready" : "preparing",
            runtime
          }
        };
      }),
      ...createBrowserExecutionHooks({ node }),
      collectAndGate: node<EvidenceGateSubgraphInput>("collect-and-gate", async (state) => {
        if (state.mode === "shadow") {
          const run = await runEventStore.get(state.runId);
          return { gate: run?.machineGate ? { machineGate: run.machineGate, outcomeSummary: run.outcomeSummary } : {} };
        }
        if (state.browserAgentRequired && state.execution?.aggregate !== true) {
          // Preserve the complete inventory during planning, then resolve any
          // path that never acquired a runtime executor into an explicit gap at
          // collection time. This allows runnable paths to proceed without
          // silently treating unbound work as covered.
          const collectedCoverage = await readCoverageItems(state.runId);
          const normalizedCoverage = collectedCoverage.map((item) => isCoverageTerminal(item)
            ? item
            : {
                ...item,
                disposition: "blocked" as const,
                dispositionReason: item.dispositionReason
                  ?? (item.surface === "page"
                    ? "runtime_binding_not_completed"
                    : "manifest_executor_binding_unavailable"),
                updatedAt: new Date().toISOString()
              });
          if (normalizedCoverage.some((item, index) => item !== collectedCoverage[index])) {
            await saveCoverageItems(state.runId, normalizedCoverage);
          }
          const traceArtifact = await finalizeBrowserAgentTrace(state.runId).catch(() => undefined);
          if (traceArtifact) {
            await appendEvidence(state.runId, {
              type: "trace",
              title: "Dynamic browser attempt trace",
              scenarioId: dynamicBrowserScenarioId(state.runId),
              attemptId: state.currentAttemptId,
              attempt: 1,
              artifactIds: [traceArtifact.id],
              file: traceArtifact.storageUri,
              payload: { browserAgent: true }
            });
          }
          const { coverage, decisions, results, evidence, artifacts, artifactIntegrity, finalized, outcomeSummary, modelExecution, qualityMetrics } = await finalizeBrowserExecutionProof({
            state,
            coverageScope: "all",
            integrityId: `${state.runId}_dynamic_artifact_integrity`
          });
          const finalStatus = finalized.machineGate.status;
          const currentRun = await runEventStore.get(state.runId);
          const currentProject = state.projectId ? await getProject(state.projectId) : undefined;
          const attemptId = state.currentAttemptId ?? artifacts[0]?.attemptId;
          if (!attemptId) throw new Error("browser_agent_attempt_missing");
          await persistDynamicBrowserResult({
            runId: state.runId,
            projectId: state.projectId,
            requirement: state.requirement,
            appUrl: currentProject?.frontendUrl ?? (typeof currentRun?.input.appUrl === "string" ? currentRun.input.appUrl : undefined),
            rawRunInput: currentRun?.input ?? {},
            startedAt: state.browserSession?.startedAt ?? currentRun?.createdAt ?? new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            scenarioId: dynamicBrowserScenarioId(state.runId),
            attemptId,
            coverage,
            decisions,
            actionResults: results,
            evidence,
            artifacts,
            artifactIntegrity,
            machineGate: finalized.machineGate,
            outcomeSummary,
            proof: finalized,
            modelExecution: {
              required: modelExecution.required,
              totalCallCount: modelExecution.totalCallCount,
              successfulBrowserActionCallCount: modelExecution.successfulBrowserActionCallCount,
              completedBrowserActionCount: modelExecution.completedBrowserActionCount,
              requiredArtifactKindsPresent: modelExecution.requiredArtifactKindsPresent
            },
            qualityMetrics
          });
          let run = await runEventStore.get(state.runId);
          if (run?.state === "queued") run = await appendSystemRunEvent(state.runId, "run_preparing", { browserAgent: true });
          if (run?.state === "preparing") run = await appendSystemRunEvent(state.runId, "run_started", { attemptId: state.currentAttemptId, browserAgent: true });
          if (run?.state === "running") run = await appendSystemRunEvent(state.runId, "evidence_collecting", { artifactIds: artifacts.map((item) => item.id) });
          if (run?.state === "collecting") await appendSystemRunEvent(state.runId, "run_judging", { machineGate: finalized.machineGate, outcomeSummary });
          return {
            gate: { machineGate: finalized.machineGate, finalStatus, outcomeSummary },
            execution: { ...(state.execution ?? {}), dynamicBrowserAgent: true, resultRunId: state.runId, artifactIds: artifacts.map((item) => item.id) }
          };
        }
        const resultRunId = typeof state.execution?.resultRunId === "string" ? state.execution.resultRunId : state.runId;
        const parsedPathResult = pathExecutionResultSchema.safeParse(state.execution?.pathResult);
        const pathResult = parsedPathResult.success ? parsedPathResult.data : undefined;
        if (pathResult?.error && !pathResult.resultRunId) {
          const machineGate = finalizeProofBundle({
            draft: {
              status: pathResult.status === "failed" ? "fail" : "blocked",
              reasons: [pathResult.error],
              reasonDetails: [],
              assertionFailures: []
            },
            runId: state.runId,
            machineGate: {
              status: pathResult.status === "failed" ? "fail" : "blocked",
              reasons: [pathResult.error],
              reasonDetails: [],
              assertionFailures: []
            }
          }).machineGate;
          const current = await runEventStore.get(state.runId);
          if (current?.state === "collecting") await appendSystemRunEvent(state.runId, "run_judging", { machineGate });
          return { gate: { machineGate, finalStatus: machineGate.status } };
        }
        if (state.execution?.aggregate === true && Array.isArray(state.execution.childRunIds)) {
          const childRunIds = state.execution.childRunIds.filter((item): item is string => typeof item === "string");
          const children = (await Promise.all(childRunIds.map((id) => runEventStore.get(id))))
            .filter((item): item is RunProjection => Boolean(item));
          const childProof = await Promise.all(children.map(async (child) => {
            const resultRunId = child.resultRunId ?? child.id;
            const [proof, llmCalls, browserActions, browserArtifacts] = await Promise.all([
              readProofArtifacts(resultRunId),
              listLlmCalls(resultRunId),
              readBrowserActionResults(resultRunId),
              readBrowserArtifacts(resultRunId)
            ]);
            return { child, proof, llmCalls, browserActions, browserArtifacts };
          }));
          const browserPhase = state.browserAgentRequired && state.execution?.dynamicBrowserChildren !== true
            ? await persistBrowserPhaseForAggregate(state)
            : undefined;
          const coverage = await readCoverageItems(state.runId);
          const parentRun = await runEventStore.get(state.runId);
          const requireModelExecution = parentRun?.input.requireModelExecution === true;
          const modelCalls = childProof.flatMap((item) => item.llmCalls);
          const successfulBrowserActionCalls = modelCalls.filter((call) => call.purpose === "browser-action" && call.status === "passed");
          const completedBrowserActions = childProof
            .flatMap((item) => item.browserActions)
            .filter((action) => action.status === "completed");
          const browserArtifactKinds = new Set(childProof.flatMap((item) => item.browserArtifacts.map((artifact) => artifact.kind)));
          const modelExecutionComplete = !requireModelExecution || (
            successfulBrowserActionCalls.length > 0
            && completedBrowserActions.length > 0
            && browserArtifactKinds.has("screenshot")
            && browserArtifactKinds.has("operation-log")
          );
          const coverageComplete = coverage.length > 0 && coverage.every(isCoverageTerminal);
          const blockedCoverage = coverage.filter((item) => item.disposition === "blocked");
          const failedCoverage = coverage.filter((item) => item.disposition === "failed");
          const excludedCoverage = coverage.filter((item) => item.disposition === "excluded");
          const childEvidenceComplete = children.length === childRunIds.length && children.every((child) =>
            child.outcomeSummary?.artifactIntegrityVerified === true
            && child.outcomeSummary?.evidenceGrounded === true
          );
          const evidenceComplete = childEvidenceComplete
            && (!browserPhase || (browserPhase.artifactIntegrityVerified && browserPhase.evidenceGrounded));
          const statuses = [
            ...children.map((child) => child.gateStatus ?? "needs-human-review"),
            ...(browserPhase ? [browserPhase.finalStatus as MachineGate["status"]] : [])
          ];
          const status: MachineGate["status"] = !coverageComplete || !modelExecutionComplete ? "blocked"
            : failedCoverage.length > 0 || statuses.includes("fail") ? "fail"
              : blockedCoverage.length > 0 || excludedCoverage.length > 0 || statuses.includes("blocked") ? "blocked"
              : statuses.includes("needs-human-review") ? "needs-human-review"
                : evidenceComplete ? "pass" : "needs-human-review";
          const reasons = [
            ...(!coverageComplete ? ["coverage_disposition_incomplete"] : []),
            ...(!modelExecutionComplete ? ["model_execution_evidence_incomplete"] : []),
            ...failedCoverage.map((item) => `coverage_failed:${item.flowId}:${item.dispositionReason ?? "oracle_failed"}`),
            ...blockedCoverage.map((item) => `coverage_blocked:${item.flowId}:${item.dispositionReason ?? "unspecified"}`),
            ...excludedCoverage.map((item) => `coverage_excluded:${item.flowId}:${item.dispositionReason ?? "not_applicable"}`),
            ...(!evidenceComplete ? ["child_evidence_incomplete"] : []),
            ...children.filter((child) => child.gateStatus !== "pass").map((child) => `child_run:${child.id}:${child.gateStatus ?? child.state}`)
          ];
          // The aggregate gate is a *draft*. Parent re-verification (child
          // proofBundleId checks + artifact/evidence hashing) happens inside
          // persistParentAggregateEvidence, which mints the authoritative
          // VerifiedMachineGate via finalizeProofBundle — never here.
          const aggregateDraft: MachineGateDraft = {
            status,
            reasons,
            reasonDetails: [],
            assertionFailures: children.flatMap((child) => child.machineGate?.assertionFailures ?? [])
          };
          const executionSucceeded = children.length > 0
            && children.every((child) => ["completed", "failed", "blocked", "awaiting-human-review"].includes(child.state))
            && (!browserPhase || browserPhase.executionSucceeded);
          let judgeRecommendation: JudgeRecommendation = {
            status: status === "pass" ? "pass" : status === "fail" ? "fail" : "needs-human-review",
            summary: `Aggregated ${children.length} path runs with ${coverage.length} coverage dispositions.`,
            evidenceRefs: []
          };
          let aggregate;
          try {
            aggregate = await persistParentAggregateEvidence({
              runId: state.runId,
              projectId: state.projectId,
              requirement: state.requirement,
              coverage,
              children: [
                ...childProof.map(({ child, proof, llmCalls: childLlmCalls, browserActions, browserArtifacts }) => ({
                  id: child.id,
                  state: child.state,
                  finalStatus: child.gateStatus,
                  evidenceSetRoot: proof.manifest?.evidenceSetRoot,
                  artifactIntegrityVerified: child.outcomeSummary?.artifactIntegrityVerified === true,
                  evidenceGrounded: child.outcomeSummary?.evidenceGrounded === true,
                  machineGate: child.machineGate,
                  modelCallCount: childLlmCalls.length,
                  successfulBrowserActionCallCount: childLlmCalls.filter((call) => call.purpose === "browser-action" && call.status === "passed").length,
                  completedBrowserActionCount: browserActions.filter((action) => action.status === "completed").length,
                  browserArtifactKinds: Array.from(new Set(browserArtifacts.map((artifact) => artifact.kind)))
                })),
                ...(browserPhase ? [browserPhase] : [])
              ],
              machineGateDraft: aggregateDraft,
              gateEligibleFacts: { executionSucceeded, requirementCovered: coverage.every(isCoverageExercised) },
              judgeRecommendation,
              modelExecution: {
                required: requireModelExecution,
                totalCallCount: modelCalls.length,
                successfulBrowserActionCallCount: successfulBrowserActionCalls.length,
                completedBrowserActionCount: completedBrowserActions.length,
                requiredArtifactsPresent: browserArtifactKinds.has("screenshot") && browserArtifactKinds.has("operation-log"),
                calls: modelCalls
              }
            });
          } catch (error) {
            // A parent aggregate is also required to publish its own Artifact
            // v2. If that publish fails (for example MinIO/S3 is offline), the
            // individual path has already retained its local diagnostics but
            // the parent must still reach a durable, fail-closed terminal
            // state. Letting this exception escape used to leave the business
            // Run in `collecting` even though the Graph projection said failed.
            const message = error instanceof Error ? error.message : String(error);
            let evidence: EvidenceItem[] = [];
            try {
              evidence = [await appendEvidence(state.runId, {
                type: "console",
                title: "Parent aggregate artifact publication failed",
                scenarioId: "parent-coverage-aggregate",
                attemptId: `${state.runId}_aggregate_attempt_1`,
                attempt: 1,
                sequence: 1,
                stepId: "aggregate-child-results",
                payload: {
                  errorCode: "artifact_object_store_unavailable",
                  message
                }
              })];
            } catch {
              // The terminal event below still carries the original error. A
              // local report-volume failure must never strand the Run either.
            }
            const evidenceRefs = evidence.map((item) => item.id);
            const blockedGate = finalizeProofBundle({
              draft: {
                status: "blocked",
                reasons: ["environment_unavailable", "artifact_object_store_unavailable"],
                reasonDetails: evidenceRefs.length ? [
                  {
                    code: "environment_unavailable",
                    summary: `Parent Artifact v2 publication failed: ${message}`,
                    evidenceRefs
                  },
                  {
                    code: "artifact_object_store_unavailable",
                    summary: `Parent Artifact v2 publication failed: ${message}`,
                    evidenceRefs
                  }
                ] : [],
                assertionFailures: []
              },
              runId: state.runId,
              scenarioId: "parent-coverage-aggregate",
              attemptId: `${state.runId}_aggregate_attempt_1`,
              evidence,
              gateEligibleFacts: { executionSucceeded: false, requirementCovered: coverageComplete }
            }).machineGate;
            const current = await runEventStore.get(state.runId);
            if (current?.state === "collecting") {
              await appendSystemRunEvent(state.runId, "run_judging", {
                machineGate: blockedGate,
                judgeRecommendation: {
                  status: "needs-human-review",
                  summary: "证据对象存储不可用，正式聚合报告未提交。",
                  evidenceRefs
                },
                finalStatus: "blocked",
                childRunIds,
                coverageComplete,
                resultRunId: state.runId,
                error: message
              });
            }
            return {
              gate: {
                machineGate: blockedGate,
                judgeRecommendation: {
                  status: "needs-human-review",
                  summary: "证据对象存储不可用，正式聚合报告未提交。",
                  evidenceRefs
                },
                finalStatus: "blocked",
                childRunIds,
                coverageComplete,
                resultRunId: state.runId
              }
            };
          }
          const aggregateGate = aggregate.result.machineGate!;
          judgeRecommendation = aggregate.result.judgeRecommendation ?? judgeRecommendation;
          const finalStatus = resolveFinalStatus({ machineGate: aggregateGate, judgeRecommendation });
          const current = await runEventStore.get(state.runId);
          if (current?.state === "collecting") {
            await appendSystemRunEvent(state.runId, "run_judging", {
              machineGate: aggregateGate,
              judgeRecommendation,
              finalStatus,
              childRunIds,
              coverageComplete,
              resultRunId: state.runId,
              outcomeSummary: aggregate.result.outcomeSummary
            });
          }
          return {
            gate: {
              machineGate: aggregateGate,
              judgeRecommendation,
              finalStatus,
              childRunIds,
              coverageComplete,
              resultRunId: state.runId,
              outcomeSummary: aggregate.result.outcomeSummary
            }
          };
        }
        const bundle = await readRunBundle(resultRunId);
        const machineGate = await machineGateFromResult(bundle);
        // Worker/test-runner Judge placeholders are not authoritative. A clear
        // verified Gate proceeds deterministically; the later selective-judge
        // node may replace this recommendation only for a real evidence or
        // attribution conflict.
        const judgeRecommendation = deterministicRecommendation(machineGate);
        const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
        const current = await runEventStore.get(state.runId);
        if (current?.state === "collecting") {
          await appendSystemRunEvent(state.runId, "run_judging", {
            resultRunId,
            machineGate,
            judgeRecommendation,
            outcomeSummary: bundle.result.outcomeSummary
          });
        }
        return {
          gate: {
            machineGate,
            judgeRecommendation,
            finalStatus,
            outcomeSummary: bundle.result.outcomeSummary
          }
        };
      }),
      triageFailure: node("triage-failure", async (state) => {
        const run = await runEventStore.get(state.runId);
        const gate = state.gate?.machineGate as MachineGate | undefined;
        const status = gate?.status ?? run?.machineGate?.status;
        const reasons = gate?.reasons ?? run?.machineGate?.reasons ?? [];
        let observedConflict = false;
        const resultRunId = typeof state.gate?.resultRunId === "string"
          ? state.gate.resultRunId
          : run?.resultRunId;
        let derivedAttemptId: string | undefined;
        // A human decision without evidence is a guess. Collect the concrete
        // evidence ids that back this failure so the interrupt can link the
        // user straight to what the system actually observed.
        const failureEvidenceRefs = await collectFailureEvidenceRefs(state.runId, resultRunId);
        if (resultRunId) {
          try {
            const bundle = await readRunBundle(resultRunId);
            observedConflict = !["not_triggered", "resolved"].includes(bundle.result.conflictPacket.status);
            // Bind the repair plan to the *real* attempt that produced the
            // failure. A single-attempt run has exactly one attempt id; runs with
            // zero or multiple attempts are persisted as run-level plans
            // (attemptId left undefined) rather than fabricating an id that would
            // violate the repair_plans_v1 (attempt_id, run_id) FK.
            const attempts = bundle.attempts ?? [];
            derivedAttemptId = attempts.length === 1 ? attempts[0].id : undefined;
          } catch {
            // The deterministic state remains authoritative if the optional
            // conflict packet cannot be loaded.
          }
        }
        const selectedScenario = run?.selectedScenarioId ? getScenario(run.selectedScenarioId) : undefined;
        const expectedFixtureFault = selectedScenario?.corePath?.action === "simulate_error_and_retry"
          && reasons.some((reason) => /(?:5\d\d|environment|network|api)/i.test(reason));
        const deterministicClass = reasons.some((reason) => /environment|health|command|dependency|artifact[_-]?object|object[ _-]?store|minio|\bs3\b|econnrefused|fetch failed/i.test(reason))
          ? "environment"
          : reasons.some((reason) => /proof[_-]?bundle|proof[_-]?persistence|proof[_-]?revalidation|credibility|ledger/i.test(reason))
            ? "evidence"
          : reasons.some((reason) => /selector|binding|script/.test(reason))
            ? "test-script"
            : status === "fail" ? "product-bug" : "unknown";
        let feedbackSessionId: string | undefined;
        if (status && status !== "pass") {
          const feedback = getAgentSustainability().feedback;
          const projectId = typeof run?.input.projectId === "string"
            ? run.input.projectId
            : typeof state.projectId === "string" ? state.projectId : "local";
          const existing = (await feedback.getProjectSessions(projectId))
            .find((session) => session.detection?.runId === state.runId && !session.closed);
          feedbackSessionId = existing?.sessionId ?? (await feedback.startSession(projectId, {
            runId: state.runId,
            scenarioId: run?.selectedScenarioId,
            failureType: deterministicClass === "environment" ? "environment_issue" : deterministicClass === "test-script" ? "selector_not_found" : "other",
            title: "Graph triage failure",
            description: reasons.join("; "),
            severity: status === "fail" ? "major" : "minor",
            artifactRefs: []
          })).sessionId;
        }
        const repairDecision = decideRepairFromDeterministic(
          mapDeterministicClassToFailureClass(deterministicClass),
          reasons.join("; ")
        );
        // Persist the owner-aware repair plan the moment the failure is triaged,
        // so the workbench can reopen "what must happen next" after a restart and
        // the feedback loop can learn which repair type cleared this class. The
        // idempotency key makes a graph re-run safe.
        if (status && status !== "pass") {
          await persistRepairPlan({
            runId: state.runId,
            projectId: typeof state.projectId === "string" ? state.projectId : undefined,
            attributionId: `triage_${deterministicClass}`,
            failureType: deterministicClass,
            problem: reasons.join("; ") || `run ${state.runId} failed with status ${status}`,
            decision: repairDecision,
            attemptId: derivedAttemptId,
            scenarioId: run?.selectedScenarioId,
            evidenceRefs: failureEvidenceRefs,
            policyVersion: "repair-policy-v1",
            idempotencyKey: `triage:${state.runId}:${deterministicClass}`
          }).catch(() => undefined);
        }
        if (status && status !== "pass") {
          const failure = {
                status,
                reasons,
                failureClass: deterministicClass,
                needsLlmJudge: observedConflict || (status === "needs-human-review" && deterministicClass === "unknown"),
                observedConflict,
                repairable: ["product-bug", "test-script", "environment"].includes(deterministicClass)
                  && state.permissionProfile.sandboxWrite,
                expectedFixtureFault,
                repairDecision,
                feedbackSessionId,
                // Carried into the repair-decision interrupt so the human sees
                // the exact attempt and evidence the decision is based on.
                attemptId: derivedAttemptId,
                evidenceRefs: failureEvidenceRefs
              };
          let recoveryDecision = deterministicRecoveryDecision({ ...state, failure } as AgentGraphState);
          // Parent aggregates own child outcomes; retrying the parent would
          // re-enter the aggregate executor without creating a new path child
          // and can strand the Graph at an execution-result interrupt. A failed
          // child is already an auditable terminal disposition, so finalize the
          // parent fail-closed and leave retry-path to the child run itself.
          if (run?.runKind === "parent" && recoveryDecision.action === "retry-path") {
            recoveryDecision = {
              ...recoveryDecision,
              id: `recovery_${randomUUID()}`,
              action: "blocked",
              reason: "父运行已汇总失败子路径；不会重复投递父运行，保留子路径证据供单独重试。",
              expectedState: "等待人工查看失败子路径"
            };
          }
          return {
            failure,
            recoveryDecision
          };
        }
        return { failure: {}, recoveryDecision: undefined };
      }),
      selectiveJudge: node("selective-judge", async (state) => {
        if (state.mode === "shadow") {
          return {
            judge: {
              unavailable: true,
              skipped: true,
              reason: "shadow_mode_no_model_side_effects",
              impact: "machine-gate-preserved"
            }
          };
        }
        const run = await runEventStore.get(state.runId);
        const resultRunId = typeof state.gate?.resultRunId === "string"
          ? state.gate.resultRunId
          : run?.resultRunId;
        if (!run || !resultRunId) {
          return { judge: { unavailable: true, error: "judge_result_bundle_missing", impact: "machine-gate-preserved" } };
        }
        const bundle = await readRunBundle(resultRunId);
        const report = await buildLlmJudgeReport({
          credentialId: typeof run.input.modelProfileId === "string" ? run.input.modelProfileId : undefined,
          baseline: bundle.judgeReport,
          plan: bundle.input.plan,
          requirement: bundle.input.requirement,
          diff: bundle.input.diff,
          result: {
            steps: bundle.result.steps,
            assertions: bundle.result.assertions,
            network: bundle.result.network,
            console: bundle.result.console,
            riskCoverageMatrix: bundle.riskCoverageMatrix,
            aggregatedVerdict: bundle.result.aggregatedVerdict,
            conflictPacket: bundle.conflictPacket,
            verdict: bundle.result.verdict
          },
          evidence: bundle.evidence,
          runId: state.runId,
          experimentId: typeof run.input.experimentId === "string" ? run.input.experimentId : undefined,
          requireLlm: true,
          llmBudget: run.input.llmBudget as Parameters<typeof buildLlmJudgeReport>[0]["llmBudget"],
          priorLlmTokens: run.plannerCalls?.reduce((total, call) => total + (call.usage.totalTokens ?? 0), 0)
        });
        if (report.llmStatus !== "passed" || !report.modelRecommendation) {
          return {
            tokenUsage: (run.plannerCalls?.reduce((total, call) => total + (call.usage.totalTokens ?? 0), 0) ?? 0)
              + (report.llmCall?.usage.totalTokens ?? 0),
            judge: {
              unavailable: true,
              error: report.llmError ?? "llm_judge_unavailable",
              impact: "machine-gate-preserved",
              llmCallId: report.llmCall?.id
            }
          };
        }
        const recommendation: JudgeRecommendation = {
          status: report.modelRecommendation.verdict === "needs_review"
            ? "needs-human-review"
            : report.modelRecommendation.verdict,
          summary: report.modelRecommendation.summary,
          evidenceRefs: report.modelRecommendation.evidenceRefs
        };
        const machineGate = state.gate?.machineGate as MachineGate;
        const completeResult = {
          ...bundle.result,
          evidence: bundle.evidence,
          artifactsV2: bundle.artifactsV2,
          attempts: bundle.attempts,
          loopEvents: bundle.loopEvents,
          oracles: bundle.oracles,
          riskCoverageMatrix: bundle.riskCoverageMatrix,
          conflictPacket: bundle.conflictPacket,
          failureAttributions: bundle.failureAttributions ?? [],
          artifactIntegrity: bundle.artifactIntegrity,
          judgeReport: report,
          judgeRecommendation: recommendation,
          finalStatus: resolveFinalStatus({ machineGate, judgeRecommendation: recommendation })
        };
        bundle.judgeReport = report;
        bundle.result.judgeReport = report;
        bundle.result.judgeRecommendation = recommendation;
        bundle.result.finalStatus = completeResult.finalStatus;
        const proof = buildProofGraph(completeResult);
        bundle.coverageItems = proof.coverageItems;
        bundle.conclusions = proof.conclusions;
        bundle.proofNodes = proof.proofNodes;
        bundle.proofEdges = proof.proofEdges;
        bundle.evidenceManifest = await writeProofArtifacts(bundle);
        await writeRunBundle(bundle);
        await persistExecutionResult(state.runId, completeResult);
        return {
          tokenUsage: (run.plannerCalls?.reduce((total, call) => total + (call.usage.totalTokens ?? 0), 0) ?? 0)
            + (report.llmCall?.usage.totalTokens ?? 0),
          gate: {
            ...(state.gate ?? {}),
            judgeRecommendation: recommendation,
            finalStatus: bundle.result.finalStatus
          },
          judge: {
            recommendation,
            route: "evidence-conflict",
            llmCallId: report.llmCall?.id
          }
        };
      }),
      // Repair is driven by the orchestration-level `repairNode`, which raises a
      // real LangGraph interrupt when a human decision is required. The hook is
      // invoked twice: assessment (attempt 1, resume undefined) decides whether
      // to auto-repair or return a `repairInterrupt` carrier; the resume pass
      // (attempt 2, resume set) applies the user's chosen decision. Splitting
      // attempts keeps a restart from re-applying the decision.
      repair: (state, resume) => executeAgentNodeIdempotently(
        state.runId,
        "repair",
        resume ? 2 : 1,
        state,
        () => repairOperation(state, resume)
      ).then((output) => output as unknown as Partial<AgentGraphState> & { repairInterrupt?: AgentInterrupt }),
      finalize: node("finalize", async (state) => {
        let run = await runEventStore.get(state.runId);
        if (state.mode === "active" && run && !["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(run.state)) {
          const coverage = await readCoverageItems(state.runId).catch(() => []);
          const hasCoverageGaps = coverage.some((item) => item.disposition === "blocked" || item.disposition === "excluded");
          const hasUnfinishedCoverage = coverage.some((item) => !isCoverageTerminal(item));
          const pathResult = pathExecutionResultSchema.safeParse(state.execution?.pathResult);
          const executionStatus = pathResult.success && pathResult.data.status === "blocked" && coverage.length === 0
            ? "infrastructure-failed" as const
            : hasCoverageGaps || hasUnfinishedCoverage
              ? "completed-with-gaps" as const
              : "completed" as const;
          const discovery = state.coverageMap?.discovery && typeof state.coverageMap.discovery === "object"
            ? state.coverageMap.discovery as Record<string, unknown>
            : undefined;
          const discoveryEvidence = discovery && Array.isArray(discovery.evidence)
            ? (discovery.evidence as EvidenceItem[])
            : [];
          const machineGate = (state.gate?.machineGate as MachineGate | undefined)
            ?? (state.discoveryTerminal && discovery
              ? discoveryBlockedGate(discovery, state.runId, discoveryEvidence)
              : undefined);
          const judgeRecommendation = state.gate?.judgeRecommendation as JudgeRecommendation | undefined;
          const finalStatus = machineGate
            ? resolveFinalStatus({ machineGate, judgeRecommendation })
            : pathResult.success && pathResult.data.status === "failed" ? "fail"
              : pathResult.success && pathResult.data.status === "blocked" ? "blocked"
                : "needs-human-review";
          const outcomeSummary = state.gate?.outcomeSummary
            ? { ...state.gate.outcomeSummary, executionStatus }
            : undefined;
          const payload = {
            resultRunId: state.execution?.resultRunId,
            machineGate,
            judgeRecommendation,
            finalStatus,
            executionStatus,
            outcomeSummary,
            ...(run.runKind === "parent" && (state.execution?.aggregate === true || Array.isArray(state.execution?.childRunIds)) ? {
              parentRunId: state.runId,
              baseRunId: typeof state.execution?.baseRunId === "string" ? state.execution.baseRunId : undefined,
              headRunId: typeof state.execution?.headRunId === "string" ? state.execution.headRunId : undefined,
              pairManifestId: typeof state.execution?.pairManifestId === "string" ? state.execution.pairManifestId : undefined,
              childRunIds: Array.isArray(state.execution?.childRunIds) ? state.execution.childRunIds : [],
              artifactIds: Array.isArray(state.execution?.artifactIds) ? state.execution.artifactIds : [],
              evidenceRefs: Array.from(new Set([
                ...(machineGate?.reasonDetails?.flatMap((detail) => detail.evidenceRefs) ?? []),
                ...(Array.isArray(state.execution?.evidenceRefs) ? state.execution.evidenceRefs : [])
              ].filter((ref): ref is string => typeof ref === "string"))),
              classification: typeof state.execution?.classification === "string"
                ? state.execution.classification
                : typeof run.input.differentialClassification === "string"
                  ? run.input.differentialClassification
                  : "inconclusive",
              blockReason: finalStatus === "blocked" || finalStatus === "needs-human-review"
                ? (machineGate?.reasons?.join("; ") || "parent_aggregate_requires_review")
                : undefined
            } : {}),
            ...(discovery ? { discovery } : {})
          };
          const isParentAggregate = run.runKind === "parent"
            && (state.execution?.aggregate === true || Array.isArray(state.execution?.childRunIds));
          run = isParentAggregate
            ? finalStatus === "pass" || finalStatus === "fail"
              ? await appendSystemRunEvent(state.runId, "parent_aggregate_completed", payload)
              : await appendSystemRunEvent(state.runId, "parent_aggregate_blocked", payload)
            : finalStatus === "pass"
              ? await appendSystemRunEvent(state.runId, "run_completed", payload)
              : finalStatus === "fail"
                ? await appendSystemRunEvent(state.runId, "run_failed", payload)
                : finalStatus === "blocked"
                  ? await appendSystemRunEvent(state.runId, "run_blocked", payload)
                  : await appendSystemRunEvent(state.runId, "human_review_requested", payload);
        }
        if (state.browserAgentRequired) await closeBrowserAgentSession(state.runId).catch(() => undefined);
        return {
          status: "completed",
          execution: {
            ...(state.execution ?? {}),
            finalStatus: run?.gateStatus,
            runState: run?.state
          }
        };
      }),
      onProjection: async (projection) => {
        await saveAgentGraphProjection(projection);
        const payload = projection.pendingInterrupt?.payload;
        const phase = payload && typeof payload === "object"
          ? (payload as Record<string, unknown>).phase
          : undefined;
        if (projection.pendingInterrupt?.kind === "execution-result" && phase === "browser-batch") {
          scheduleBrowserBatchResume(projection.runId);
        }
      }
    }
  });
}

async function graphService() {
  servicePromise ??= buildService();
  return servicePromise;
}

/**
 * A full scan can contain hundreds of page paths. The graph checkpoints after
 * a small browser batch and this internal scheduler resumes that checkpoint
 * once it is durable. It is deliberately not a user-facing approval or a
 * Worker result, so it must never be rendered as a blocking decision card.
 */
function scheduleBrowserBatchResume(runId: string) {
  if (scheduledBrowserBatchResumes.has(runId)) return;
  scheduledBrowserBatchResumes.add(runId);
  const resume = (delayMs: number) => {
    const timer = setTimeout(() => void attempt(20), delayMs);
    timer.unref?.();
  };
  const attempt = async (remaining: number): Promise<void> => {
    let finished = false;
    try {
      const projection = await getAgentGraphProjection(runId);
      const pending = projection?.pendingInterrupt;
      const phase = pending?.payload && typeof pending.payload === "object"
        ? (pending.payload as Record<string, unknown>).phase
        : undefined;
      if (pending?.kind === "execution-result" && phase === "browser-batch") {
        const requestedDelay = (pending.payload as Record<string, unknown>).delayMs;
        const delayMs = typeof requestedDelay === "number"
          ? Math.max(0, Math.min(requestedDelay, 30_000))
          : 0;
        if (delayMs > 0) {
          // Consume the persisted delay before resuming. Rewriting the
          // interrupt is unnecessary: this scheduler runs once per durable
          // checkpoint and the in-memory dedupe prevents duplicate resumes.
          const timer = setTimeout(() => void resumeAfterCooldown(), delayMs);
          timer.unref?.();
          return;
        }
        await resumeAgentGraph(runId, { execution: { phase: "browser-batch" } });
        finished = true;
        return;
      }
      if (remaining > 0) {
        resume(40);
        return;
      }
      finished = true;
    } catch {
      // A short-lived checkpoint race must not turn a valid Run into failed.
      // A subsequent durable projection refresh will schedule again.
      finished = true;
    } finally {
      if (finished) scheduledBrowserBatchResumes.delete(runId);
    }
  };
  const resumeAfterCooldown = async (): Promise<void> => {
    try {
      const projection = await getAgentGraphProjection(runId);
      const pending = projection?.pendingInterrupt;
      const phase = pending?.payload && typeof pending.payload === "object"
        ? (pending.payload as Record<string, unknown>).phase
        : undefined;
      if (pending?.kind === "execution-result" && phase === "browser-batch") {
        await resumeAgentGraph(runId, { execution: { phase: "browser-batch" } });
      }
    } catch {
      // The durable interrupt remains available for a later projection
      // refresh. A scheduling failure must not become an unhandled runtime
      // rejection in the API process.
    } finally {
      scheduledBrowserBatchResumes.delete(runId);
    }
  };
  resume(40);
}

function permissionProfile(run: RunProjection) {
  return agentPermissionProfileSchema.parse(
    typeof run.input.permissionProfile === "object" && run.input.permissionProfile
      ? run.input.permissionProfile
      : {}
  );
}

export async function startAgentGraphForRun(run: RunProjection) {
  const inFlight = inFlightGraphStarts.get(run.id);
  if (inFlight) return inFlight;

  const start = (async () => {
    const service = await graphService();
    const projectId = typeof run.input.projectId === "string" ? run.input.projectId : undefined;
    return service.start({
      runId: run.id,
      mode: agentOrchestrationMode(projectId),
      requirement: typeof run.input.requirement === "string" ? run.input.requirement : undefined,
      projectId,
      permissionProfile: permissionProfile(run),
      planApproved: !["draft", "planning", "awaiting-plan-approval"].includes(run.state),
      capabilitiesApproved: !["draft", "planning", "awaiting-plan-approval", "awaiting-permission"].includes(run.state)
    });
  })();
  inFlightGraphStarts.set(run.id, start);
  try {
    return await start;
  } finally {
    if (inFlightGraphStarts.get(run.id) === start) inFlightGraphStarts.delete(run.id);
  }
}

export function startAgentGraphInBackground(run: RunProjection) {
  queueMicrotask(() => void startAgentGraphForRun(run).catch((error) => recordBackgroundGraphFailure(run.id, error)));
}

async function recordBackgroundGraphFailure(runId: string, error: unknown) {
  const existing = await readAgentGraphProjection(runId);
  const message = error instanceof Error ? error.message : "Agent graph failed";
  await saveAgentGraphProjection({
      schemaVersion: "1.0",
      runId,
      threadId: runId,
      mode: existing?.mode ?? "active",
      status: "failed",
      currentNode: existing?.currentNode,
      completedNodes: existing?.completedNodes ?? [],
      progress: existing?.progress ?? 0,
      tokenUsage: existing?.tokenUsage ?? 0,
      browserAgentRequired: existing?.browserAgentRequired ?? false,
      browserLoopComplete: existing?.browserLoopComplete ?? false,
      continuationPasses: existing?.continuationPasses ?? 0,
      remainingPathCount: existing?.remainingPathCount ?? 0,
      lastError: {
        code: error instanceof Error ? error.message.split(":")[0] : "agent_graph_failed",
        message
      },
      updatedAt: new Date().toISOString()
  });
  // A failed background continuation must also terminate the durable Run.
  // Otherwise the projection says failed while /v1/runs remains queued and
  // the Workbench waits forever for a report that can never be produced.
  for (let retry = 0; retry < 3; retry += 1) {
    const current = await runEventStore.get(runId);
    if (!current || ["completed", "failed", "blocked", "cancelled"].includes(current.state)) return;
    if (![
      "planning", "awaiting-permission", "queued", "preparing", "running",
      "paused", "collecting", "judging", "awaiting-human-review"
    ].includes(current.state)) return;
    try {
      await runEventStore.append({
        runId,
        type: "run_blocked",
        expectedVersion: current.version,
        actor: "agent-graph",
        idempotencyKey: `${runId}:graph-background-failure:${current.version}`,
        payload: {
          finalStatus: "blocked",
          error: "agent_graph_background_failed",
          errorMessage: message,
          graphNode: existing?.currentNode
        }
      });
      return;
    } catch (appendError) {
      if (!(appendError instanceof Error) || !appendError.message.startsWith("run_version_conflict:")) throw appendError;
    }
  }
}

export async function resumeAgentGraph(runId: string, value: Record<string, unknown>) {
  const service = await graphService();
  return service.resume(runId, toJsonObject(value) ?? {});
}

export async function resumeAgentGraphInBackground(runId: string, value: Record<string, unknown>) {
  queueMicrotask(() => void resumeAgentGraph(runId, value).catch((error) => recordBackgroundGraphFailure(runId, error)));
}

export async function getAgentGraphProjection(runId: string): Promise<AgentGraphProjection | undefined> {
  const persisted = await readAgentGraphProjection(runId);
  if (persisted) return persisted;
  try {
    return await (await graphService()).state(runId);
  } catch {
    return undefined;
  }
}
