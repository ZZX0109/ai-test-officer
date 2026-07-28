import {
  agentPermissionProfileSchema,
  resolveFinalStatus,
  type JudgeRecommendation,
  type MachineGate,
  type AgentGraphProjection
} from "@ai-test-officer/contracts";
import {
  createAgentCheckpointer,
  createAgentOrchestrationGraph,
  type AgentGraphState
} from "@ai-test-officer/agent-orchestration";
import { readAgentGraphProjection, saveAgentGraphProjection } from "./agentGraphProjectionStore.js";
import { appendSystemRunEvent, runEventStore, type RunProjection } from "./runEventStore.js";
import { executeAgentNodeIdempotently } from "./agentNodeExecutionStore.js";
import { readRunBundle, writeRunBundle } from "./evidenceStore.js";
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
import { persistExecutionResult } from "./executionPersistence.js";

function machineGateFromResult(result: Awaited<ReturnType<typeof readRunBundle>>["result"]): MachineGate {
  if (result.machineGate) return result.machineGate;
  const status = result.gateStatus ?? "needs-human-review";
  return {
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
    assertionFailures: result.assertions.filter((item) => !item.passed).map((item) => item.name),
    evidenceComplete: status !== "blocked" && status !== "needs-human-review"
  };
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

async function buildService() {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for production agent orchestration");
  }
  const checkpointer = await createAgentCheckpointer({
    databaseUrl: process.env.DATABASE_URL,
    schema: process.env.LANGGRAPH_POSTGRES_SCHEMA ?? "langgraph"
  });
  const node = (
    name: Parameters<typeof executeAgentNodeIdempotently>[1],
    operation: (state: AgentGraphState) => Promise<Record<string, unknown>>
  ) => async (state: AgentGraphState) => executeAgentNodeIdempotently(
    state.runId,
    name,
    1,
    state,
    () => operation(state)
  );
  return createAgentOrchestrationGraph({
    checkpointer,
    hooks: {
      intake: node("intake", async (state) => {
        const run = await runEventStore.get(state.runId);
        return { requirement: typeof run?.input.requirement === "string" ? run.input.requirement : state.requirement };
      }),
      discover: node("discover", async (state) => {
        const run = await runEventStore.get(state.runId);
        return { coverageMap: run?.impactAnalysis ? { impactAnalysis: run.impactAnalysis } : {} };
      }),
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
          const fullCoverage = run.runKind === "parent" && (
            run.input.coverageMode === "full"
            || /全面|灰度|full[\s_-]*(scan|coverage)|all[\s_-]*(paths|flows)/i.test(String(run.input.requirement ?? ""))
          );
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
          const machineGate: MachineGate = {
            status: state.execution.finalStatus === "fail" ? "fail" : "blocked",
            reasons: [String(state.execution.error)],
            reasonDetails: [],
            assertionFailures: [],
            evidenceComplete: false
          };
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
          const machineGate: MachineGate = {
            status,
            reasons: [
              ...(!coverageComplete ? ["coverage_disposition_incomplete"] : []),
              ...blockedCoverage.map((item) => `coverage_blocked:${item.flowId}:${item.dispositionReason ?? "unspecified"}`),
              ...(!evidenceComplete ? ["child_evidence_incomplete"] : []),
              ...children.filter((child) => child.gateStatus !== "pass").map((child) => `child_run:${child.id}:${child.gateStatus ?? child.state}`)
            ],
            reasonDetails: [],
            assertionFailures: children.flatMap((child) => child.machineGate?.assertionFailures ?? []),
            evidenceComplete
          };
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
              evidenceGrounded: child.outcomeSummary?.evidenceGrounded === true
            })),
            machineGate,
            judgeRecommendation
          });
          const aggregateGate = aggregate.result.machineGate ?? machineGate;
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
        const machineGate = machineGateFromResult(bundle.result);
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
        if (resultRunId) {
          try {
            const bundle = await readRunBundle(resultRunId);
            observedConflict = !["not_triggered", "resolved"].includes(bundle.result.conflictPacket.status);
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
        return status && status !== "pass"
          ? {
              failure: {
                status,
                reasons,
                failureClass: deterministicClass,
                needsLlmJudge: observedConflict || (status === "needs-human-review" && deterministicClass === "unknown"),
                observedConflict,
                repairable: ["product-bug", "test-script", "environment"].includes(deterministicClass)
                  && state.permissionProfile.sandboxWrite
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
      repair: node("repair", async (state) => {
        if (!state.projectId || !state.permissionProfile.sandboxWrite) return {};
        const project = await getProject(state.projectId);
        if (!project) return {};
        const repair = await createRepairSession({
          runId: state.runId,
          project,
          summary: `Graph triage: ${String(state.failure?.failureClass ?? "unknown")}`,
          failureClass: state.failure?.failureClass === "product-bug" ? "product-bug"
            : state.failure?.failureClass === "test-script" ? "test-script"
              : state.failure?.failureClass === "environment" ? "environment"
                : "unknown"
        });
        try {
          const run = await runEventStore.get(state.runId);
          if (!run) return { repairSessionId: repair.id };
          const proposed = await proposeCodeRepair({
            sessionId: repair.id,
            run,
            project,
            credentialId: typeof run.input.modelProfileId === "string" ? run.input.modelProfileId : undefined
          });
          if (proposed.files.length > 0) await validateRepairSession(repair.id, project);
        } catch {
          // A failed repair proposal must never erase or weaken the original
          // machine result. The editable sandbox session remains available.
        }
        return { repairSessionId: repair.id };
      }),
      finalize: node("finalize", async (state) => {
        let run = await runEventStore.get(state.runId);
        if (state.mode === "active" && run && !["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(run.state)) {
          const machineGate = state.gate?.machineGate as MachineGate | undefined;
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
            outcomeSummary: state.gate?.outcomeSummary
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
