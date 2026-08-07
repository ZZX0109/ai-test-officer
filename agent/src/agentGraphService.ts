import {
  agentPermissionProfileSchema,
  resolveFinalStatus,
  type JudgeRecommendation,
  type MachineGate,
  type AgentGraphProjection,
  type AgentInterrupt,
  type RepairDecisionAnswer
} from "@ai-test-officer/contracts";
import { randomUUID } from "node:crypto";
import {
  createAgentCheckpointer,
  createAgentOrchestrationGraph,
  type AgentGraphState
} from "@ai-test-officer/agent-orchestration";
import { readAgentGraphProjection, saveAgentGraphProjection } from "./agentGraphProjectionStore.js";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { executeAgentNodeIdempotently } from "./agentNodeExecutionStore.js";
import { readEvidence, readRunBundle, writeRunBundle } from "./evidenceStore.js";
import { getProject, getProjectRuntimeStatusWithRecovery } from "./projectAdapter.js";
import { createRepairSession, validateRepairSession } from "./repairWorkspace.js";
import { planRunFromDurableInput } from "./runPlanningService.js";
import { proposeCodeRepair } from "./llmCodeRepair.js";
import {
  createCoverageItems,
  createManifestCoverageItems,
  readCoverageItems,
  saveCoverageItems
} from "./coverageStore.js";
import { buildProofGraph, readProofArtifacts, writeProofArtifacts } from "./proofGraph.js";
import { persistParentAggregateEvidence } from "./parentRunEvidence.js";
import { buildLlmJudgeReport } from "./llmJudge.js";
import { persistExecutionResult, revalidatePersistedMachineGate } from "./executionPersistence.js";
import { finalizeProofBundle, type MachineGateDraft, type VerifiedMachineGate } from "./proof/proofBundleService.js";
import type { ProofBundleInput } from "./proof/proofBundleValidator.js";
import { decideRepairFromDeterministic, mapDeterministicClassToFailureClass } from "./repairDecision.js";
import { persistRepairPlan } from "./repairPlan.js";
import type { RepairDecision, RepairOwner, EvidenceItem } from "./types.js";
import { runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import type { SourceReadEnvelope } from "./types.js";
import { getAgentSustainability } from "./agentSustainability.js";
import { withGraphExecutionScope } from "./graphSideEffects.js";

async function machineGateFromResult(bundle: Awaited<ReturnType<typeof readRunBundle>>): Promise<MachineGate> {
  const result = bundle.result;
  const stampedGate = result.machineGate as (MachineGate & Partial<VerifiedMachineGate>) | undefined;
  // A gate already stamped by the Proof Bundle Service carries a proofBundleId.
  // Before trusting / returning it we re-verify the authoritative ledger row:
  // canonical hash, run/attempt/scenario binding and evidence grounding. A
  // tampered or inconsistent gate is downgraded to needs-human-review so it can
  // never be used to declare a run "pass". (Offline / file-only mode where the
  // ledger row legitimately does not exist fails open — see
  // revalidatePersistedMachineGate.)
  if (stampedGate?.proofBundleId) {
    const proofInput: ProofBundleInput = {
      evidence: bundle.evidence ?? [],
      artifactsV2: result.artifactsV2,
      artifactIntegrity: result.artifactIntegrity,
      machineGate: stampedGate,
      judgeReport: result.judgeReport,
      oracles: bundle.oracles,
      riskCoverageMatrix: bundle.riskCoverageMatrix
    };
    return revalidatePersistedMachineGate(result.id, stampedGate as VerifiedMachineGate, proofInput);
  }
  const status = result.machineGate?.status ?? result.gateStatus ?? "needs-human-review";
  const draft: MachineGateDraft = {
    status,
    reasons: result.artifactIntegrity?.items
      .filter((item) => !["present", "self_reference"].includes(item.status))
      .map((item) => `${item.id}:${item.status}`) ?? [],
    reasonDetails: (result.artifactIntegrity?.items ?? [])
      .filter((item) => !["present", "self_reference"].includes(item.status) && item.evidenceId)
      .map((item) => ({
        code: item.status,
        summary: `${item.id}:${item.status}`,
        evidenceRefs: [item.evidenceId!]
      })),
    assertionFailures: result.assertions.filter((item) => !item.passed).map((item) => item.name)
  };
  // Correction #1: never omit the top-level Evidence just because `result`
  // does not carry it. The bundle-level evidence is the source of truth for
  // grounding/completeness, so it is always forwarded to the verifier.
  return finalizeProofBundle({
    draft,
    runId: result.id,
    evidence: bundle.evidence ?? [],
    artifactsV2: result.artifactsV2,
    artifactIntegrity: result.artifactIntegrity,
    machineGate: draft,
    judgeReport: result.judgeReport
  }).machineGate;
}

function recommendationFromResult(result: Awaited<ReturnType<typeof readRunBundle>>["result"]): JudgeRecommendation | undefined {
  if (result.judgeRecommendation) return result.judgeRecommendation;
  const judge = result.judgeReport?.releaseJudge;
  if (!judge) return undefined;
  return {
    status: judge.verdict === "needs_review" ? "needs-human-review" : judge.verdict,
    summary: judge.summary,
    evidenceRefs: Array.from(new Set(judge.findings.flatMap((finding) => finding.evidenceRefs)))
  };
}

type GraphService = Awaited<ReturnType<typeof buildService>>;
let servicePromise: Promise<GraphService> | undefined;

export function agentOrchestrationMode(projectId?: string): "shadow" | "active" {
  if (process.env.AGENT_ORCHESTRATION_MODE !== "active") return "shadow";
  const allowlist = (process.env.AGENT_GRAPH_ACTIVE_PROJECTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowlist.length) return "active";
  return projectId && allowlist.includes(projectId) ? "active" : "shadow";
}

function requiresFullCoverage(run: RunProjection) {
  return run.runKind === "parent" && (
    run.input.coverageMode === "full"
    || /全面|灰度|full[\s_-]*(scan|coverage)|all[\s_-]*(paths|flows)/i.test(String(run.input.requirement ?? ""))
  );
}

export function requiresActiveBrowserDiscovery(
  run: RunProjection,
  manifestBrowserCapability = true
) {
  const requestedCapabilities = Array.isArray(run.input.capabilities)
    ? run.input.capabilities.filter((item): item is string => typeof item === "string")
    : ["browser"];
  return requiresFullCoverage(run)
    && requestedCapabilities.includes("browser")
    && manifestBrowserCapability;
}

function discoverySourceContexts(run: RunProjection): SourceReadEnvelope[] {
  const now = new Date().toISOString();
  const sources: SourceReadEnvelope[] = [];
  if (typeof run.input.requirement === "string" && run.input.requirement.trim()) {
    sources.push({
      id: "run_requirement",
      kind: "manual",
      title: "Run requirement",
      status: "connected",
      summary: run.input.requirement,
      permissionState: "not_required",
      isSimulated: false,
      evidenceUse: "primary_requirement",
      displayStatus: "ready",
      readAt: now,
      trustLevel: "medium"
    });
  }
  if (typeof run.input.diff === "string" && run.input.diff.trim()) {
    sources.push({
      id: "run_diff",
      kind: "git_diff",
      title: "Run diff",
      status: "connected",
      summary: run.input.diff,
      permissionState: "not_required",
      isSimulated: false,
      evidenceUse: "change_context",
      displayStatus: "ready",
      readAt: now,
      trustLevel: "high"
    });
  }
  return sources;
}

function discoveryState(result: Awaited<ReturnType<typeof runSmokeFirstDiscovery>>) {
  const orchestration = result.orchestration;
  const status = orchestration?.status ?? (result.status === "passed" ? "ready" : "failed");
  return {
    status,
    reason: orchestration?.reason ?? result.observation.diagnosis.summary ?? result.message,
    retryable: orchestration?.retryable ?? result.observation.diagnosis.retryable,
    checkedUrl: orchestration?.checkedUrl ?? result.target.frontendUrl,
    attempts: orchestration?.attempts ?? 0,
    maxAttempts: orchestration?.maxAttempts ?? 0,
    discoveryAttempts: orchestration?.discoveryAttempts ?? 0,
    observationId: result.observation.id,
    documentCommitted: result.observation.navigation.documentCommitted,
    interactiveElementCount: result.observation.document.interactiveElementCount
  };
}

/**
 * Build grounded evidence from a Discovery scan result so a blocked gate is
 * never an evidence-free assertion. The observation already captured page
 * navigation, failed requests, console/page errors, a screenshot and a DOM
 * summary; we promote those into EvidenceItems the Proof Bundle Service can
 * reason over. Without this, `finalizeProofBundle` degrades a blocked
 * discovery to `needs-human-review` purely for lack of evidence — even when the
 * discovery had a perfectly good reason (e.g. an auth wall or a downed service).
 */
function buildDiscoveryEvidence(
  scan: Awaited<ReturnType<typeof runSmokeFirstDiscovery>>,
  runId: string
): EvidenceItem[] {
  const obs = scan.observation;
  if (!obs) return [];
  const now = new Date().toISOString();
  const base = { runId, timestamp: now, attempt: 0, sequence: 0 } as const;
  const items: EvidenceItem[] = [];

  items.push({
    ...base,
    id: `discovery-page-${obs.id}`,
    type: "network",
    title: `页面观测：${obs.finalUrl || (scan.orchestration?.checkedUrl ?? "unknown")}`,
    url: obs.finalUrl,
    locator: {
      pageUrl: obs.finalUrl,
      sourceLocation: `httpStatus=${obs.navigation.httpStatus ?? "n/a"}`,
      lineStart: obs.navigation.documentCommitted ? undefined : 0
    },
    payload: {
      httpStatus: obs.navigation.httpStatus,
      documentCommitted: obs.navigation.documentCommitted,
      interactiveElementCount: obs.document.interactiveElementCount,
      stage: obs.stage,
      bodyTextSample: obs.document.bodyTextSample?.slice(0, 500)
    }
  });

  if (obs.failedRequests.length) {
    items.push({
      ...base,
      id: `discovery-network-${obs.id}`,
      type: "network",
      title: `失败请求（${obs.failedRequests.length}）`,
      url: obs.finalUrl,
      payload: { failedRequests: obs.failedRequests.slice(0, 12) }
    });
  }

  const errors = [
    ...obs.pageErrors,
    ...obs.console.filter((entry) => /error|exception|failed/i.test(entry.type)).map((entry) => entry.text)
  ];
  if (errors.length) {
    items.push({
      ...base,
      id: `discovery-console-${obs.id}`,
      type: "console",
      title: `控制台与页面错误（${errors.length}）`,
      url: obs.finalUrl,
      payload: { errors: errors.slice(0, 20) }
    });
  }

  if (obs.screenshot) {
    items.push({
      ...base,
      id: `discovery-screenshot-${obs.id}`,
      type: "screenshot",
      title: "Discovery 截图",
      file: obs.screenshot.storageUri,
      url: obs.finalUrl,
      locator: { pageUrl: obs.finalUrl },
      payload: { storageUri: obs.screenshot.storageUri }
    });
  }

  if (obs.document.accessibilityTree) {
    items.push({
      ...base,
      id: `discovery-dom-${obs.id}`,
      type: "dom",
      title: "DOM 摘要（ARIA）",
      url: obs.finalUrl,
      payload: { accessibilityTree: obs.document.accessibilityTree.slice(0, 2000) }
    });
  }

  if (obs.browserLifecycle?.length) {
    items.push({
      ...base,
      id: `discovery-lifecycle-${obs.id}`,
      type: "console",
      title: "浏览器启动与端口探测",
      payload: { browserLifecycle: obs.browserLifecycle }
    });
  }

  return items;
}

function discoveryBlockedGate(
  discovery: Record<string, unknown>,
  runId: string,
  evidence: EvidenceItem[] = []
): MachineGate {
  const status = String(discovery.status ?? "failed");
  const reason = String(discovery.reason ?? "discovery_smoke_failed");
  const evidenceRefs = evidence.map((item) => item.id);
  // Structured reason detail + evidence refs let the gate-reason proof verify
  // the block instead of failing closed to needs-human-review.
  const reasonDetails = evidenceRefs.length
    ? [{
        code: "environment_unavailable",
        summary: `discovery_${status}:${reason}`,
        evidenceRefs: evidenceRefs.slice(0, 8)
      }]
    : [];
  return finalizeProofBundle({
    draft: {
      status: "blocked",
      reasons: [`discovery_${status}:${reason}`],
      reasonDetails,
      assertionFailures: []
    },
    runId,
    evidence,
    machineGate: {
      status: "blocked",
      reasons: [`discovery_${status}:${reason}`],
      reasonDetails,
      assertionFailures: []
    }
  }).machineGate;
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
  const node = (
    name: Parameters<typeof executeAgentNodeIdempotently>[1],
    operation: (state: AgentGraphState) => Promise<Record<string, unknown>>
  ) => async (state: AgentGraphState) => withGraphExecutionScope(
    { mode: state.mode, runId: state.runId },
    () => executeAgentNodeIdempotently(state.runId, name, 1, state, () => operation(state))
  );
  return createAgentOrchestrationGraph({
    checkpointer,
    hooks: {
      intake: node("intake", async (state) => {
        const run = await runEventStore.get(state.runId);
        return { requirement: typeof run?.input.requirement === "string" ? run.input.requirement : state.requirement };
      }),
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
        const discovery = discoveryState(result);
        // Promote the scan's real observations into evidence so the blocked gate
        // below is grounded rather than an evidence-free assertion.
        const discoveryEvidence = buildDiscoveryEvidence(result, state.runId);
        if (discovery.status === "ready") {
          return {
            coverageMap: { ...baseCoverageMap, discovery: { ...discovery, evidence: discoveryEvidence } },
            discoveryTerminal: false
          };
        }
        if (discovery.status === "waiting") {
          // A login wall is a non-terminal, owner-tagged failure: persist a
          // durable "configure credentials" plan so the workbench can reopen it.
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
            discoveryTerminal: false
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
              dispositionComplete: items.length > 0 && items.every((item) => item.disposition !== "pending")
            }
          };
        }
        try {
          const bundle = await readRunBundle(run?.resultRunId ?? state.runId);
          return {
            coverageMap: {
              ...(state.coverageMap ?? {}),
              items: bundle.coverageItems ?? [],
              dispositionComplete: (bundle.coverageItems ?? []).every((item) => item.disposition !== "pending")
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
          if (!existing.length) {
            const requested = Array.isArray(run.input.coverageScenarioIds)
              ? run.input.coverageScenarioIds.filter((item): item is string => typeof item === "string")
              : [];
            const recommended = run.impactAnalysis?.recommendedScenarios
              .filter((item) => item.confidence !== "low")
              .map((item) => item.scenarioId) ?? [];
            const scenarioIds = [...requested, ...recommended, ...(run.selectedScenarioId ? [run.selectedScenarioId] : [])];
            if (scenarioIds.length) {
              await saveCoverageItems(run.id, createCoverageItems({ runId: run.id, scenarioIds }));
            }
          }
        }
        return {
          planData: run?.plan ? { plan: run.plan, provenance: run.planProvenance } : {},
          planningTerminal
        };
      }),
      compile: node("compile", async (state) => {
        const run = await runEventStore.get(state.runId);
        if (!run?.compiledPlan && state.mode === "active") throw new Error("compiled_plan_missing");
        return { compiledPlan: run?.compiledPlan ? { compiledPlan: run.compiledPlan } : {} };
      }),
      prepareSandbox: node("prepare-sandbox", async (state) => {
        if (!state.projectId) return { execution: { ...(state.execution ?? {}), sandbox: "blocked", reason: "project_missing" } };
        const runtime = await getProjectRuntimeStatusWithRecovery(state.projectId);
        return {
          execution: {
            ...(state.execution ?? {}),
            sandbox: runtime.status === "running" ? "ready" : "preparing",
            runtime
          }
        };
      }),
      collectAndGate: node("collect-and-gate", async (state) => {
        if (state.mode === "shadow") {
          const run = await runEventStore.get(state.runId);
          return { gate: run?.machineGate ? { machineGate: run.machineGate, outcomeSummary: run.outcomeSummary } : {} };
        }
        const resultRunId = typeof state.execution?.resultRunId === "string" ? state.execution.resultRunId : state.runId;
        if (state.execution?.error && !state.execution.resultRunId) {
          const machineGate = finalizeProofBundle({
            draft: {
              status: state.execution.finalStatus === "fail" ? "fail" : "blocked",
              reasons: [String(state.execution.error)],
              reasonDetails: [],
              assertionFailures: []
            },
            runId: state.runId,
            machineGate: {
              status: state.execution.finalStatus === "fail" ? "fail" : "blocked",
              reasons: [String(state.execution.error)],
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
          const childProof = await Promise.all(children.map(async (child) => ({
            child,
            proof: await readProofArtifacts(child.resultRunId ?? child.id)
          })));
          const coverage = await readCoverageItems(state.runId);
          const coverageComplete = coverage.length > 0 && coverage.every((item) => item.disposition !== "pending");
          const blockedCoverage = coverage.filter((item) => item.disposition === "blocked");
          const evidenceComplete = children.length === childRunIds.length && children.every((child) =>
            child.outcomeSummary?.artifactIntegrityVerified === true
            && child.outcomeSummary?.evidenceGrounded === true
          );
          const statuses = children.map((child) => child.gateStatus ?? "needs-human-review");
          const status: MachineGate["status"] = !coverageComplete || blockedCoverage.length > 0 || statuses.includes("blocked") ? "blocked"
            : statuses.includes("fail") ? "fail"
              : statuses.includes("needs-human-review") ? "needs-human-review"
                : evidenceComplete ? "pass" : "needs-human-review";
          const reasons = [
            ...(!coverageComplete ? ["coverage_disposition_incomplete"] : []),
            ...blockedCoverage.map((item) => `coverage_blocked:${item.flowId}:${item.dispositionReason ?? "unspecified"}`),
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
          const executionSucceeded = children.length > 0 && children.every((child) =>
            ["completed", "failed", "blocked", "awaiting-human-review"].includes(child.state)
          );
          let judgeRecommendation: JudgeRecommendation = {
            status: status === "pass" ? "pass" : status === "fail" ? "fail" : "needs-human-review",
            summary: `Aggregated ${children.length} path runs with ${coverage.length} coverage dispositions.`,
            evidenceRefs: []
          };
          const aggregate = await persistParentAggregateEvidence({
            runId: state.runId,
            projectId: state.projectId,
            requirement: state.requirement,
            coverage,
            children: childProof.map(({ child, proof }) => ({
              id: child.id,
              state: child.state,
              finalStatus: child.gateStatus,
              evidenceSetRoot: proof.manifest?.evidenceSetRoot,
              artifactIntegrityVerified: child.outcomeSummary?.artifactIntegrityVerified === true,
              evidenceGrounded: child.outcomeSummary?.evidenceGrounded === true,
              machineGate: child.machineGate
            })),
            machineGateDraft: aggregateDraft,
            gateEligibleFacts: { executionSucceeded, requirementCovered: coverageComplete },
            judgeRecommendation
          });
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
        const judgeRecommendation = recommendationFromResult(bundle.result);
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
        const deterministicClass = reasons.some((reason) => /environment|health|command|dependency/.test(reason))
          ? "environment"
          : reasons.some((reason) => /selector|binding|script/.test(reason))
            ? "test-script"
            : status === "fail" ? "product-bug" : "unknown";
        let feedbackSessionId: string | undefined;
        if (status && status !== "pass") {
          const feedback = getAgentSustainability().feedback;
          const projectId = typeof run?.input.projectId === "string"
            ? run.input.projectId
            : typeof state.projectId === "string" ? state.projectId : "local";
          const existing = feedback.getProjectSessions(projectId)
            .find((session) => session.detection?.runId === state.runId && !session.closed);
          feedbackSessionId = existing?.sessionId ?? feedback.startSession(projectId, {
            runId: state.runId,
            scenarioId: run?.selectedScenarioId,
            failureType: deterministicClass === "environment" ? "environment_issue" : deterministicClass === "test-script" ? "selector_not_found" : "other",
            title: "Graph triage failure",
            description: reasons.join("; "),
            severity: status === "fail" ? "major" : "minor",
            artifactRefs: []
          }).sessionId;
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
        return status && status !== "pass"
          ? {
              failure: {
                status,
                reasons,
                failureClass: deterministicClass,
                needsLlmJudge: observedConflict || (status === "needs-human-review" && deterministicClass === "unknown"),
                observedConflict,
                repairable: ["product-bug", "test-script", "environment"].includes(deterministicClass)
                  && state.permissionProfile.sandboxWrite,
                repairDecision,
                feedbackSessionId,
                // Carried into the repair-decision interrupt so the human sees
                // the exact attempt and evidence the decision is based on.
                attemptId: derivedAttemptId,
                evidenceRefs: failureEvidenceRefs
              }
            }
          : { failure: {} };
      }),
      selectiveJudge: node("selective-judge", async (state) => {
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
            : state.execution?.finalStatus === "fail" ? "fail"
              : state.execution?.finalStatus === "blocked" ? "blocked"
                : "needs-human-review";
          const payload = {
            resultRunId: state.execution?.resultRunId,
            machineGate,
            judgeRecommendation,
            finalStatus,
            outcomeSummary: state.gate?.outcomeSummary,
            ...(discovery ? { discovery } : {})
          };
          run = finalStatus === "pass"
            ? await appendSystemRunEvent(state.runId, "run_completed", payload)
            : finalStatus === "fail"
              ? await appendSystemRunEvent(state.runId, "run_failed", payload)
              : finalStatus === "blocked"
                ? await appendSystemRunEvent(state.runId, "run_blocked", payload)
                : await appendSystemRunEvent(state.runId, "human_review_requested", payload);
        }
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
      }
    }
  });
}

/**
 * Repair helpers for the human-in-the-loop `repair` graph node. The node raises
 * a real LangGraph interrupt (handled by `repairNode` in agent-orchestration)
 * carrying the problem, the diagnosis already performed, the suggested handling
 * and the concrete options the human may choose. On resume the same hook runs
 * again (attempt 2) to apply the decision. Assessment (attempt 1) is separated
 * from application (attempt 2) so a restart replays the assessment without
 * re-applying the user's choice.
 */
function buildRepairOptions(owner: RepairOwner) {
  switch (owner) {
    case "user":
      return [
        { value: "provide-credentials", label: "配置登录凭据", description: "在凭据管理中配置测试账号后重新执行 Discovery。" },
        { value: "repair", label: "由系统修复", description: "授权系统在沙盒中复现并生成修复方案。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    case "environment":
      return [
        { value: "recover-sandbox", label: "恢复测试环境", description: "确认 Docker / APP_URL / 端口映射后恢复沙盒。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    case "developer":
      return [
        { value: "create-session", label: "创建修复工作区", description: "进入修复工作区对源码进行修改。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
    default:
      return [
        { value: "repair", label: "由系统修复", description: "在沙盒中自动复现并修复。" },
        { value: "dismiss", label: "保留失败结论", description: "不修复，保留当前失败结果。" }
      ];
  }
}

/**
 * Collect the evidence ids that justify a failure decision.
 *
 * Ordering matters: the evidence closest to the failure is the most useful, so
 * the newest items win. Screenshots / console / network / assertion evidence is
 * preferred because those are the artefacts a human actually inspects; the tail
 * of the timeline is used as a fallback when no typed evidence exists. Returning
 * an empty list is acceptable (the run may have failed before any capture) but
 * it must never be a fabricated id — the interrupt links to real evidence only.
 */
async function collectFailureEvidenceRefs(
  runId: string,
  resultRunId?: string
): Promise<string[]> {
  const seen = new Set<string>();
  const preferred: string[] = [];
  const fallback: string[] = [];
  const sources = resultRunId && resultRunId !== runId ? [resultRunId, runId] : [runId];
  for (const source of sources) {
    let items: EvidenceItem[];
    try {
      items = await readEvidence(source);
    } catch {
      continue;
    }
    for (const item of [...items].reverse()) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const bucket = /screenshot|console|network|assertion|dom|error/i.test(String(item.type))
        ? preferred
        : fallback;
      bucket.push(item.id);
    }
  }
  return [...preferred, ...fallback].slice(0, 8);
}

function ownerLabel(owner: RepairOwner): string {
  if (owner === "user") return "用户";
  if (owner === "environment") return "环境";
  if (owner === "developer") return "开发者";
  return "系统";
}

function buildRepairInterrupt(
  state: AgentGraphState,
  repairDecision: RepairDecision,
  failureClass: string | undefined,
  run: RunProjection | undefined,
  reason?: "sandbox-write-required"
): AgentInterrupt {
  const reasons = (state.failure?.reasons as string[] | undefined) ?? [];
  const options = buildRepairOptions(repairDecision.owner);
  const sandboxBlocked = reason === "sandbox-write-required";
  const evidenceRefs = Array.isArray(state.failure?.evidenceRefs)
    ? (state.failure.evidenceRefs as string[]).filter((id) => typeof id === "string" && id.length > 0)
    : [];
  return {
    id: `interrupt_${randomUUID()}`,
    runId: state.runId,
    kind: "repair-decision",
    status: "pending",
    title: `需要${ownerLabel(repairDecision.owner)}决策：${failureClass ?? "测试失败"}`,
    detail: sandboxBlocked
      ? `${repairDecision.userMessage}\n\n需要沙盒写入权限才能自动修复，请在权限配置中放行后重试。`
      : repairDecision.userMessage,
    requestedCapabilities: [],
    owner: repairDecision.owner,
    context: {
      failureClass,
      problem: repairDecision.userMessage,
      diagnosis: reasons,
      suggestedApproach: repairDecision.steps.join("\n"),
      validation: repairDecision.validation,
      sandboxBlocked
    },
    options,
    diagnoses: reasons,
    evidenceRefs,
    attemptId: typeof state.failure?.attemptId === "string" ? (state.failure.attemptId as string) : undefined,
    scenarioId: run?.selectedScenarioId,
    payload: {
      problem: repairDecision.userMessage,
      diagnosis: reasons,
      suggestedApproach: repairDecision.steps.join("\n"),
      options: options.map((option) => option.value),
      owner: repairDecision.owner,
      runId: state.runId,
      failureClass,
      evidenceRefs,
      sandboxBlocked
    },
    createdAt: new Date().toISOString()
  };
}

async function performAgentAutoRepair(
  state: AgentGraphState,
  failureClass: string | undefined,
  run: RunProjection | undefined
): Promise<Record<string, unknown>> {
  if (!state.projectId) return {};
  const project = await getProject(state.projectId);
  if (!project) return {};
  const repair = await createRepairSession({
    runId: state.runId,
    project,
    summary: `Graph triage: ${String(failureClass ?? "unknown")}`,
    failureClass: failureClass === "product-bug" ? "product-bug"
      : failureClass === "test-script" ? "test-script"
        : failureClass === "environment" ? "environment"
          : "unknown"
  });
  try {
    const freshRun = run ?? await runEventStore.get(state.runId);
    if (!freshRun) return { repairSessionId: repair.id };
    const proposed = await proposeCodeRepair({
      sessionId: repair.id,
      run: freshRun,
      project,
      credentialId: typeof freshRun.input.modelProfileId === "string" ? freshRun.input.modelProfileId : undefined
    });
    if (proposed.files.length > 0) await validateRepairSession(repair.id, project);
  } catch {
    // A failed repair proposal must never erase or weaken the original
    // machine result. The editable sandbox session remains available.
  }
  return { repairSessionId: repair.id };
}

async function applyRepairDecision(
  state: AgentGraphState,
  repairDecision: RepairDecision,
  failureClass: string | undefined,
  answer: RepairDecisionAnswer,
  run: RunProjection | undefined
): Promise<Record<string, unknown>> {
  if (answer.decision === "repair" || answer.decision === "create-session") {
    // The human authorised the agent to act: create the repair workspace and
    // propose a patch. Covers agent / developer / user-owned failures where the
    // missing capability or access has now been granted.
    return performAgentAutoRepair(state, failureClass, run);
  }
  // "provide-credentials" / "recover-sandbox" / "reopen-discovery" are driven by
  // the workbench (credential config, sandbox recovery, re-run Discovery); the
  // graph simply resumes and the UI owns the follow-up. "dismiss" keeps the
  // original failure conclusion. Record the choice for traceability.
  await appendSystemRunEvent(state.runId, "repair_decision_recorded", {
    decision: answer.decision,
    message: answer.message,
    repairPlanId: answer.repairPlanId
  }).catch(() => undefined);
  return {};
}

async function repairOperation(
  state: AgentGraphState,
  resume?: RepairDecisionAnswer
): Promise<Record<string, unknown>> {
  const repairDecision = state.failure?.repairDecision as RepairDecision | undefined;
  const failureClass = state.failure?.failureClass as string | undefined;
  // A failure with no decision has nothing to repair or surface.
  if (!repairDecision) return {};
  const run = await runEventStore.get(state.runId);
  // Persist the plan before branching so it survives a restart and the
  // workbench can always reopen it (idempotent re-write).
  if (failureClass) {
    await persistRepairPlan({
      runId: state.runId,
      projectId: typeof state.projectId === "string" ? state.projectId : undefined,
      attributionId: `triage_${failureClass}`,
      failureType: failureClass,
      problem: ((state.failure?.reasons as string[] | undefined) ?? []).join("; ") || `run ${state.runId} failed`,
      decision: repairDecision,
      scenarioId: run?.selectedScenarioId,
      policyVersion: "repair-policy-v1",
      idempotencyKey: `triage:${state.runId}:${failureClass}`
    }).catch(() => undefined);
  }
  // RESUME pass: apply the human's decision.
  if (resume) {
    return applyRepairDecision(state, repairDecision, failureClass, resume, run);
  }
  // ASSESSMENT pass: auto-repair agent-owned writable failures, otherwise raise
  // a real interrupt carrying problem + diagnosis + options.
  if (repairDecision.owner !== "agent") {
    return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run) };
  }
  if (!state.projectId || !state.permissionProfile.sandboxWrite) {
    return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run, "sandbox-write-required") };
  }
  return performAgentAutoRepair(state, failureClass, run);
}

async function graphService() {
  servicePromise ??= buildService();
  return servicePromise;
}

function permissionProfile(run: RunProjection) {
  return agentPermissionProfileSchema.parse(
    typeof run.input.permissionProfile === "object" && run.input.permissionProfile
      ? run.input.permissionProfile
      : {}
  );
}

export async function startAgentGraphForRun(run: RunProjection) {
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
}

export function startAgentGraphInBackground(run: RunProjection) {
  queueMicrotask(() => void startAgentGraphForRun(run).catch(async (error) => {
    const existing = await readAgentGraphProjection(run.id);
    await saveAgentGraphProjection({
      schemaVersion: "1.0",
      runId: run.id,
      threadId: run.id,
      mode: agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined),
      status: "failed",
      currentNode: existing?.currentNode,
      completedNodes: existing?.completedNodes ?? [],
      progress: existing?.progress ?? 0,
      tokenUsage: existing?.tokenUsage ?? 0,
      lastError: {
        code: error instanceof Error ? error.message.split(":")[0] : "agent_graph_failed",
        message: error instanceof Error ? error.message : "Agent graph failed"
      },
      updatedAt: new Date().toISOString()
    });
  }));
}

export async function resumeAgentGraph(runId: string, value: Record<string, unknown>) {
  const service = await graphService();
  return service.resume(runId, value);
}

export async function resumeAgentGraphInBackground(runId: string, value: Record<string, unknown>) {
  queueMicrotask(() => void resumeAgentGraph(runId, value).catch(() => undefined));
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
