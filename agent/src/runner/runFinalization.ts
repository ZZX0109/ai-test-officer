import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runOutcomeSummaryV2Schema, type ArtifactV2 } from "@ai-test-officer/contracts";
import { commitCapturedFile, type AttemptClock } from "@ai-test-officer/playwright-runtime";
import { BudgetTracker } from "@ai-test-officer/execution-worker";
import type { EvidenceItem, RunBundle, RunRequest, VisualRunResult } from "../types.js";
import { finalizeEvidenceArtifactLinks, readEvidence, writeRunBundle } from "../evidenceStore.js";
import { appendLoopEvent, readLoopEvents } from "../loopEventStore.js";
import { buildScenarioOracles } from "../oracleBuilder.js";
import { buildRiskCoverageMatrix } from "../riskCoverage.js";
import { buildEvidenceQualityReport } from "../evidenceQuality.js";
import { appendRunHistory } from "../runHistory.js";
import { buildConflictPacket } from "../conflictReplay.js";
import { getScenario } from "../scenarios.js";
import { buildLayeredJudgeReport } from "../judgeEngine.js";
import { routeJudge } from "../llmRoutingPolicy.js";
import { buildLlmJudgeReport } from "../llmJudge.js";
import { writeReadableReports } from "../reportRenderer.js";
import { getProject, resolveProjectTarget } from "../projectAdapter.js";
import { buildFailureAttributions } from "../failureAttribution.js";
import { decideRepair } from "../repairDecision.js";
import { persistRepairPlan, selectRepairableAttribution } from "../repairPlan.js";
import { writeArtifactIntegrityReport } from "../artifactIntegrity.js";
import { mirrorArtifactsToConfiguredStore } from "../artifactObjectStore.js";
import { buildProofGraph, writeProofArtifacts } from "../proofGraph.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "../proof/proofBundleService.js";
import { finalizeMachineGate } from "./machineGateFinalization.js";
import { linkCommittedAttemptArtifacts } from "../proof/evidenceArtifactLinker.js";

type Scenario = ReturnType<typeof getScenario>;
type TargetRuntime = Awaited<ReturnType<typeof resolveProjectTarget>>;
type ConfiguredProject = Awaited<ReturnType<typeof getProject>>;
type Attempt = NonNullable<VisualRunResult["attempts"]>[number];

export interface RunFinalizationInput {
  input: RunRequest;
  reportsDir: string;
  runDir: string;
  artifactUrl: (filePath: string) => string;
  scenarioFingerprint: (value: unknown) => string;
  id: string;
  startedAt: string;
  frontendUrl: string;
  targetRuntime: TargetRuntime;
  configuredProject: ConfiguredProject;
  runtimeStatus: VisualRunResult["runtimeStatus"];
  scenario: Scenario;
  compiledPlan: RunRequest["compiledPlan"];
  attemptClock: AttemptClock;
  activeAttempt: number;
  attemptIdentity: () => { runId: string; scenarioId: string; attemptId: string; attempt: number };
  attempts: Attempt[];
  artifactsV2: ArtifactV2[];
  budgetTracker: BudgetTracker;
  evidenceWrites: Promise<unknown>[];
  appendEvidence: (runId: string, evidence: Omit<EvidenceItem, "id" | "runId" | "timestamp">) => Promise<EvidenceItem>;
  steps: VisualRunResult["steps"];
  network: VisualRunResult["network"];
  consoleEvents: VisualRunResult["console"];
  assertions: VisualRunResult["assertions"];
  executionError: VisualRunResult["executionError"];
}

/**
 * Builds the durable result, proof bundle, reports, and repair hand-off after
 * browser execution is over. It deliberately receives only persisted attempt
 * data so report generation cannot influence execution or Machine Gate facts.
 */
export async function finalizeVisualRun(input: RunFinalizationInput): Promise<VisualRunResult> {
  const {
    artifactUrl,
    artifactClock: _artifactClock,
    ...context
  } = input as RunFinalizationInput & { artifactClock?: never };
  void _artifactClock;
  const {
    activeAttempt, appendEvidence, artifactsV2, assertions, attemptClock, attemptIdentity,
    attempts, budgetTracker, compiledPlan, configuredProject, consoleEvents, evidenceWrites,
    executionError, frontendUrl, id, input: runInput, reportsDir, runDir, runtimeStatus,
    scenario, scenarioFingerprint, startedAt, steps, targetRuntime, network
  } = context;
  const failed = assertions.some((assertion) => !assertion.passed);
  const runFailed = failed || Boolean(executionError);
  const finishedAt = new Date().toISOString();
  await Promise.allSettled(evidenceWrites);
  for (const [kind, value, mediaType] of [
    ["network", network, "application/json"],
    ["console", consoleEvents, "application/json"]
  ] as const) {
    const finalPath = path.join(runDir, `attempt-${activeAttempt}-${kind}.json`);
    const temporaryPath = `${finalPath}.partial`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2));
    const artifact = await commitCapturedFile({
      temporaryPath,
      finalPath,
      id: `${id}_${kind}_attempt_${activeAttempt}`,
      identity: attemptIdentity(),
      stepId: `attempt-${activeAttempt}-finalize`,
      kind,
      mediaType,
      storageUri: artifactUrl(finalPath),
      clock: attemptClock,
      collectorVersion: "0.2.0"
    });
    const locatedArtifact: ArtifactV2 = {
      ...artifact,
      locator: {
        timeRange: {
          from: attempts[activeAttempt - 1]?.startedAt ?? startedAt,
          to: artifact.integrity.capturedAt
        }
      }
    };
    artifactsV2.push(locatedArtifact);
    budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
    attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
    await appendEvidence(id, {
      type: kind,
      title: `${kind} artifact attempt ${activeAttempt}`,
      file: artifact.storageUri,
      artifactIds: [artifact.id],
      payload: { file: artifact.storageUri, count: value.length }
    });
  }
  attempts[activeAttempt - 1] = {
    ...attempts[activeAttempt - 1],
    status: attempts.length > 1 ? attempts[activeAttempt - 1].status : failed || executionError ? "failed" : "passed",
    finishedAt
  };
  let latestEvidence: EvidenceItem[] = await readEvidence(id);
  const declaredRequiredKinds = (compiledPlan?.requiredEvidenceKinds
    ?? runInput.executablePlan?.steps.find((step) => step.scenarioId === scenario.id)?.evidenceRequirements
    ?? ["screenshot", "dom", "network", "console"])
    .filter((kind) => ["screenshot", "dom", "network", "console", "trace", "video"].includes(kind)) as ArtifactV2["kind"][];
  const requiredKinds = Array.from(new Set<ArtifactV2["kind"]>([
    ...declaredRequiredKinds,
    "trace"
  ]));
  const mirroredArtifacts = await mirrorArtifactsToConfiguredStore(artifactsV2, reportsDir);
  artifactsV2.splice(0, artifactsV2.length, ...mirroredArtifacts);
  latestEvidence = linkCommittedAttemptArtifacts(latestEvidence, artifactsV2);
  const evidenceQuality = buildEvidenceQualityReport({ assertions, evidence: latestEvidence, artifacts: artifactsV2 });
  for (const quality of evidenceQuality.assertions) {
    for (const evidenceRef of quality.evidenceRefs) {
      const evidence = latestEvidence.find((item) => item.id === evidenceRef);
      if (!evidence) continue;
      evidence.artifactIds = Array.from(new Set([...(evidence.artifactIds ?? []), ...quality.artifactIds]));
    }
  }
  latestEvidence = await finalizeEvidenceArtifactLinks(id, latestEvidence);
  const partialResult = {
    assertions,
    steps,
    verdict: runFailed ? "hold_for_review" : "continue"
  } as Pick<VisualRunResult, "assertions" | "steps" | "verdict">;
  const oracles = buildScenarioOracles(scenario, latestEvidence);
  const riskCoverageMatrix = buildRiskCoverageMatrix({ assertions }, latestEvidence, scenario);
  const conflictPacket = buildConflictPacket({ assertions, steps }, latestEvidence);
  const runScenarioFingerprint = scenarioFingerprint({
    id: scenario.id,
    action: scenario.corePath.action,
    oracles: scenario.corePath.oracles
  });
  const historicalVerdict = await appendRunHistory({
    runId: id,
    appUrl: frontendUrl,
    projectId: targetRuntime.projectId ?? configuredProject?.id,
    scenarioId: scenario.id,
    scenarioFingerprint: runScenarioFingerprint,
    result: partialResult
  });
  const retryRecovered = attempts.length > 1 && attempts[0]?.status === "failed" && attempts.at(-1)?.status === "passed";
  const aggregatedVerdict = retryRecovered
    ? { ...historicalVerdict, flaky: true, verdict: "needs_review" as const, reason: "First attempt failed and a retry passed; marked timing-sensitive." }
    : historicalVerdict;
  const judgeResult = {
    steps,
    assertions,
    network,
    console: consoleEvents,
    riskCoverageMatrix,
    aggregatedVerdict,
    conflictPacket,
    verdict: runFailed ? "hold_for_review" as const : "continue" as const
  };
  const baselineJudgeReport = buildLayeredJudgeReport({
    plan: runInput.plan,
    requirement: runInput.requirement,
    diff: runInput.diff,
    result: judgeResult,
    evidence: latestEvidence
  });
  const judgeRouting = runInput.judgeMode === "adaptive"
    ? executionError?.failureClass === "test_script_issue"
      ? { route: "deterministic" as const, reason: "test_script_failure_is_actionable", signals: ["test_script_failure"] }
      : routeJudge({
        baseline: baselineJudgeReport,
        conflictStatus: conflictPacket.status,
        failedAssertionCount: assertions.filter((item) => !item.passed).length,
        insufficientEvidenceCount: evidenceQuality.assertions.filter((item) => item.status === "insufficient").length,
        knownEnvironmentFailureCount: network.filter((item) => {
          const candidate = item as unknown as Record<string, unknown>;
          return (typeof candidate.status === "number" && candidate.status >= 500)
            || candidate.failed === true || Boolean(candidate.error);
        }).length
      })
    : { route: runInput.judgeMode === "llm-assisted" ? "llm" as const : "deterministic" as const, reason: "explicit_mode", signals: [`mode:${runInput.judgeMode ?? "deterministic"}`] };
  const assistedJudgeReport = judgeRouting.route === "llm"
    ? await buildLlmJudgeReport({
      credentialId: runInput.credentialId,
      baseline: baselineJudgeReport,
      plan: runInput.plan,
      requirement: runInput.requirement,
      diff: runInput.diff,
      result: judgeResult,
      evidence: latestEvidence,
      runId: id,
      experimentId: runInput.experimentId,
      requireLlm: true,
      llmBudget: runInput.llmBudget,
      priorLlmTokens: runInput.priorLlmTokens
    })
    : baselineJudgeReport;
  const {
    artifactIntegrityReport,
    finalStatus,
    gateEligible,
    judgeRecommendation,
    judgeReport,
    machineGate,
    outcomeSummary
  } = finalizeMachineGate({
    id,
    scenarioId: scenario.id,
    attemptId: attemptIdentity().attemptId,
    artifacts: artifactsV2,
    requiredKinds,
    evidence: latestEvidence,
    assertions,
    attempts,
    executionError,
    failed,
    evidenceQuality,
    riskCoverageMatrix,
    network,
    judgeReport: assistedJudgeReport
  });
  const failureAttributions = buildFailureAttributions({
    assertions,
    steps,
    network,
    console: consoleEvents,
    evidence: latestEvidence,
    sourceContexts: runInput.sourceContexts ?? [],
    impactAnalysis: runInput.impactAnalysis,
    diff: runInput.diff
  });
  const topAttribution = selectRepairableAttribution(failureAttributions);
  if (runFailed && topAttribution) {
    await persistRepairPlan({
      runId: id,
      projectId: targetRuntime.projectId ?? configuredProject?.id,
      attributionId: topAttribution.id,
      failureType: topAttribution.failureClass,
      problem: topAttribution.title,
      decision: decideRepair(topAttribution)
    });
  }
  const failedNames = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);
  const reflectionNote = runFailed
    ? `本次失败集中在 ${scenario.corePath.title}：${failedNames.join("、") || executionError?.code}。下一轮应优先检查对应 evidence ID 的 network、DOM 和截图是否一致。`
    : `本次 ${scenario.title} 显式灰度路径通过，证据包包含 ${latestEvidence.length} 条 evidence。`;
  await appendLoopEvent(id, {
    loopType: conflictPacket.status === "not_triggered" ? "report_loop" : "evidence_conflict_loop",
    iteration: 1,
    status: conflictPacket.status === "not_triggered" ? "passed" : "waiting_for_user",
    title: conflictPacket.status === "not_triggered" ? "未触发证据冲突复现" : "失败证据需要用户复核",
    action: "build_conflict_packet",
    observation: conflictPacket.reason,
    decision: "生成报告",
    decisionReason: "当前运行已完成证据包构建",
    evidenceRefs: conflictPacket.evidenceRefs
  });
  await appendLoopEvent(id, {
    loopType: "report_loop",
    iteration: 1,
    status: "waiting_for_user",
    title: "报告已生成，等待用户裁决",
    action: "generate_report",
    observation: runFailed ? "核心路径存在失败断言或执行错误" : "未发现阻塞断言",
    decision: runFailed ? "建议 hold_for_review" : "建议 continue",
    decisionReason: executionError ? executionError.code : failed ? `${scenario.corePath.title} 存在未通过的验证条件` : "所有断言通过",
    evidenceRefs: latestEvidence.map((item) => item.id).slice(-8)
  });
  const loopEvents = await readLoopEvents(id);
  const result: VisualRunResult = {
    id,
    startedAt,
    finishedAt,
    scenarioFingerprint: runScenarioFingerprint,
    verdict: runFailed ? "hold_for_review" : "continue",
    summary: runFailed ? "核心路径存在失败证据，建议用户复核并阻塞合并。" : "显式灰度路径未发现阻塞问题。",
    steps,
    network,
    console: consoleEvents,
    assertions,
    evidence: latestEvidence,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    aggregatedVerdict,
    reflectionNote,
    conflictPacket,
    failureAttributions,
    attempts,
    artifactsV2,
    gateStatus: finalStatus,
    machineGate,
    judgeRecommendation,
    finalStatus,
    outcomeSummary,
    executionError,
    repairAttempts: loopEvents
      .filter((event) => event.loopType === "failure_recovery_loop" && event.status === "retrying")
      .slice(0, Math.max(0, Math.min(runInput.maxAutoRepairs ?? 2, 2)))
      .map((event, index) => ({
        attempt: index + 1,
        kind: "execution_retry" as const,
        status: "completed" as const,
        reason: event.decisionReason ?? "受控执行重试",
        evidenceRefs: event.evidenceRefs
      })),
    runtimeStatus,
    evidenceQuality,
    judgeReport,
    judgeRouting,
    reportFile: artifactUrl(path.join(runDir, "report.json")),
    runBundleFile: artifactUrl(path.join(runDir, "run_bundle.json"))
  };
  const proofGraph = buildProofGraph(result);
  result.coverageItems = proofGraph.coverageItems;
  result.conclusions = proofGraph.conclusions;
  result.proofNodes = proofGraph.proofNodes;
  result.proofEdges = proofGraph.proofEdges;
  if (proofGraph.errors.length > 0 && result.finalStatus === "pass") {
    const degradedDraft: MachineGateDraft = {
      status: "needs-human-review",
      reasons: [...new Set([...(result.machineGate?.reasons ?? machineGate.reasons), ...proofGraph.errors.map((error) => `proof_invalid:${error}`)])],
      reasonDetails: result.machineGate?.reasonDetails ?? machineGate.reasonDetails,
      assertionFailures: result.machineGate?.assertionFailures ?? machineGate.assertionFailures
    };
    const degraded = finalizeProofBundle({
      draft: degradedDraft,
      runId: id,
      scenarioId: scenario.id,
      attemptId: attemptIdentity().attemptId,
      evidence: latestEvidence,
      artifactsV2,
      artifactIntegrity: artifactIntegrityReport,
      requiredArtifactKinds: requiredKinds,
      machineGate: degradedDraft,
      judgeReport
    });
    result.machineGate = degraded.machineGate;
    result.finalStatus = "needs-human-review";
    result.gateStatus = "needs-human-review";
    result.outcomeSummary = runOutcomeSummaryV2Schema.parse({
      ...(result.outcomeSummary ?? outcomeSummary),
      ...proofCredibility(degraded.verdict, degraded.machineGate, degraded.gateEligible),
      finalStatus: "needs-human-review"
    });
  }
  const readableReports = await writeReadableReports({ runDir, artifactBaseUrl: `/artifacts/runs/${id}`, result });
  result.markdownReportFile = readableReports.markdownReportFile;
  result.htmlReportFile = readableReports.htmlReportFile;
  result.artifactIntegrityReportFile = artifactUrl(path.join(runDir, "artifact_integrity.json"));
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  const bundle: RunBundle = {
    runId: id,
    startedAt,
    finishedAt,
    input: runInput,
    result,
    evidence: latestEvidence,
    artifactsV2,
    attempts,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    conflictPacket,
    judgeReport,
    failureAttributions,
    runtimeStatus,
    project: configuredProject,
    sourceContexts: runInput.sourceContexts,
    impactAnalysis: runInput.impactAnalysis,
    executablePlan: runInput.executablePlan
  };
  bundle.coverageItems = result.coverageItems;
  bundle.conclusions = result.conclusions;
  bundle.proofNodes = result.proofNodes;
  bundle.proofEdges = result.proofEdges;
  const artifactIntegrity = await writeArtifactIntegrityReport({ result, reportsDir, outputFile: path.join(runDir, "artifact_integrity.json") });
  result.artifactIntegrity = artifactIntegrity;
  bundle.artifactIntegrity = artifactIntegrity;
  const evidenceManifest = await writeProofArtifacts(bundle);
  result.evidenceManifest = evidenceManifest;
  bundle.evidenceManifest = evidenceManifest;
  await writeReadableReports({ runDir, artifactBaseUrl: `/artifacts/runs/${id}`, result });
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  result.runBundleFile = await writeRunBundle(bundle);
  return result;
}
