import {
  runOutcomeSummaryV2Schema,
  type JudgeRecommendation,
  type MachineGate
} from "@ai-test-officer/contracts";
import type { EvidenceGateSubgraphInput } from "@ai-test-officer/agent-orchestration";
import { appendEvidence, readEvidence, readRunBundle } from "../evidenceStore.js";
import { getProject } from "../projectAdapter.js";
import { readCoverageItems, isCoverageExercised, isCoverageTerminal } from "../coverageStore.js";
import { readProofArtifacts } from "../proofGraph.js";
import { revalidatePersistedMachineGate } from "../executionPersistence.js";
import {
  finalizeProofBundle,
  proofContributorCredibility,
  proofCredibility,
  type MachineGateDraft,
  type VerifiedMachineGate
} from "../proof/proofBundleService.js";
import type { ProofBundleInput } from "../proof/proofBundleValidator.js";
import {
  dynamicBrowserScenarioId,
  finalizeBrowserAgentTrace
} from "../browser-agent/sessionManager.js";
import {
  readBrowserActionResults,
  readBrowserArtifacts,
  readBrowserDecisions
} from "../browser-agent/store.js";
import { persistDynamicBrowserResult } from "../browser-agent/resultBundle.js";
import { runEventStore } from "../runEventStore.js";
import { artifactKindToIntegrityKind } from "../artifactIntegrity.js";

export type InteractiveCoverageInventoryItem = {
  id: string;
  status?: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
  surfaces?: Array<"page" | "api" | "data" | "background-task">;
  preconditions?: string[];
  requiredEvidenceKinds?: Array<"screenshot" | "dom" | "network" | "console" | "trace" | "video" | "download" | "operation-log" | "report" | "attachment" | "source-patch" | "changed-files-archive" | "repair-validation-log">;
};

export function interactiveCoverageInventory(value: unknown): InteractiveCoverageInventoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string") return [];
    const surfaces = Array.isArray(candidate.surfaces)
      ? candidate.surfaces.filter((surface): surface is NonNullable<InteractiveCoverageInventoryItem["surfaces"]>[number] => surface === "page" || surface === "api" || surface === "data" || surface === "background-task")
      : undefined;
    const preconditions = Array.isArray(candidate.preconditions)
      ? candidate.preconditions.filter((value): value is string => typeof value === "string")
      : undefined;
    const requiredEvidenceKinds = Array.isArray(candidate.requiredEvidenceKinds)
      ? candidate.requiredEvidenceKinds.filter((kind): kind is NonNullable<InteractiveCoverageInventoryItem["requiredEvidenceKinds"]>[number] => ["screenshot", "dom", "network", "console", "trace", "video", "download", "operation-log", "report", "attachment", "source-patch", "changed-files-archive", "repair-validation-log"].includes(String(kind)))
      : undefined;
    const status = candidate.status === "executable" || candidate.status === "auto-bindable"
      || candidate.status === "needs-input" || candidate.status === "coverage-gap"
      ? candidate.status
      : undefined;
    return [{ id: candidate.id, status, surfaces, preconditions, requiredEvidenceKinds }];
  });
}

export function coverageItemRepresentsAuthentication(item: { flowId: string; module: string } | undefined) {
  if (!item) return false;
  const text = `${item.flowId} ${item.module}`.trim();
  const authSignal = /login|log-in|sign[ -]?in|auth(?:entication)?|登录|登陆|认证/i.test(text);
  if (!authSignal) return false;
  const downstreamSignal = /(?:登录|登陆|认证)(?:成功)?后|(?:after|then|post)[ _-]?(?:login|log-in|sign[ -]?in|auth)/i.test(text)
    || /(?:login|log-in|sign[ -]?in|auth(?:entication)?)[ _-]?(?:then|and)[ _-]?(?:open|create|edit|delete|export|approve|view|search)/i.test(text);
  return !downstreamSignal;
}

export function browserPathResultsAreGrounded(results: Array<{
  status: string;
  errorCode?: string;
  oracleResults: Array<{ passed: boolean }>;
}>) {
  const authoritative = results.filter((item) => item.errorCode !== "browser_control_binding_stale");
  return authoritative.length > 0
    && authoritative.some((item) => item.oracleResults.length > 0)
    && authoritative.every((item) => item.status === "completed" && item.oracleResults.every((oracle) => oracle.passed));
}

export function browserActionCompletesBusinessPath(result: {
  status: string;
  oracleResults: Array<{ oracleId: string; passed: boolean }>;
} | undefined) {
  if (!result || result.status !== "completed" || result.oracleResults.length === 0) return false;
  if (result.oracleResults.some((oracle) => oracle.oracleId.startsWith("oracle_login_"))) return false;
  return result.oracleResults.every((oracle) => oracle.passed);
}

export async function finalizeBrowserExecutionProof(input: {
  state: EvidenceGateSubgraphInput;
  coverageScope: "all" | "browser";
  integrityId: string;
  reasonPrefix?: "browser_";
}) {
  const [allCoverage, decisions, results, evidence, artifacts] = await Promise.all([
    readCoverageItems(input.state.runId),
    readBrowserDecisions(input.state.runId),
    readBrowserActionResults(input.state.runId),
    readEvidence(input.state.runId),
    readBrowserArtifacts(input.state.runId)
  ]);
  const coverage = input.coverageScope === "browser"
    ? allCoverage.filter((item) => item.surface === "page")
    : allCoverage;
  const coverageComplete = coverage.length > 0 && coverage.every(isCoverageTerminal);
  const blockedCoverage = coverage.filter((item) => item.disposition === "blocked");
  const failedCoverage = coverage.filter((item) => item.disposition === "failed");
  const excludedCoverage = coverage.filter((item) => item.disposition === "excluded");
  const executedResults = results.filter((item) => item.status === "completed");
  const failedOracles = executedResults.flatMap((item) => item.oracleResults.filter((oracle) => !oracle.passed));
  const nonRetryableFailures = results.filter((item) =>
    item.status !== "completed" && item.errorCode !== "browser_control_binding_stale"
  );
  const executionSucceeded = executedResults.length > 0 && nonRetryableFailures.length === 0;
  const requirementCovered = coverageComplete && coverage.every(isCoverageExercised);
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  const requiredKinds = ["screenshot", "dom", "trace", "operation-log"] as const;
  const missingKinds = requiredKinds.filter((kind) => !artifactKinds.has(kind));
  const evidenceByArtifact = new Map<string, string>();
  for (const item of evidence) for (const artifactId of item.artifactIds ?? []) evidenceByArtifact.set(artifactId, item.id);
  const artifactIntegrity = {
    id: input.integrityId,
    runId: input.state.runId,
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts" as const,
    summary: { total: artifacts.length, present: artifacts.length, missing: 0, unreadable: 0, pathEscapes: 0, selfReferences: 0, hashMismatches: 0, hashed: artifacts.length },
    items: artifacts.map((artifact) => ({
      id: artifact.id,
      artifactUri: artifact.storageUri,
      kind: artifactKindToIntegrityKind(artifact.kind),
      evidenceId: evidenceByArtifact.get(artifact.id),
      status: "present" as const,
      origin: artifact.origin,
      sizeBytes: artifact.integrity.sizeBytes,
      sha256: artifact.integrity.sha256
    }))
  };
  const status: MachineGate["status"] = !coverageComplete || !executionSucceeded || missingKinds.length > 0
    ? "blocked"
    : failedOracles.length > 0 || failedCoverage.length > 0 ? "fail"
      : blockedCoverage.length > 0 || excludedCoverage.length > 0 ? "blocked" : "pass";
  const failedEvidenceRefs = results
    .filter((item) => item.status !== "completed" || item.oracleResults.some((oracle) => !oracle.passed))
    .flatMap((item) => item.evidenceRefs);
  const decisionEvidenceRefs = decisions.flatMap((item) => item.evidenceRefs);
  const reasonEvidence = [...new Set([...failedEvidenceRefs, ...decisionEvidenceRefs])].slice(0, 8);
  const prefix = input.reasonPrefix ?? "";
  const reasons = [
    ...(!coverageComplete ? [`${prefix}coverage_disposition_incomplete`] : []),
    ...failedCoverage.map((item) => `${prefix}coverage_failed:${item.flowId}`),
    ...blockedCoverage.map((item) => `${prefix}coverage_blocked:${item.flowId}`),
    ...excludedCoverage.map((item) => `${prefix}coverage_excluded:${item.flowId}`),
    ...(!executionSucceeded ? ["browser_action_execution_incomplete"] : []),
    ...missingKinds.map((kind) => `required_artifact_missing:${kind}`),
    ...failedOracles.map((oracle) => `oracle_failed:${oracle.oracleId}`)
  ];
  const draft: MachineGateDraft = {
    status,
    reasons,
    reasonDetails: reasons.map((reason) => ({
      code: reason.split(":")[0],
      summary: reason,
      evidenceRefs: reasonEvidence
    })).filter((item) => item.evidenceRefs.length > 0),
    assertionFailures: failedOracles.map((oracle) => oracle.oracleId)
  };
  const finalized = finalizeProofBundle({
    draft,
    runId: input.state.runId,
    scenarioId: artifacts[0]?.scenarioId,
    attemptId: input.state.currentAttemptId,
    evidence,
    artifactsV2: artifacts,
    artifactIntegrity,
    requiredArtifactKinds: [...requiredKinds],
    machineGate: draft,
    gateEligibleFacts: { executionSucceeded, requirementCovered }
  });
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    executionStatus: blockedCoverage.length > 0 || excludedCoverage.length > 0
      ? "completed-with-gaps"
      : "completed",
    schedulingCompleted: true,
    executionStarted: results.length > 0,
    executionSucceeded,
    requirementCovered,
    requirementPassed: requirementCovered && failedOracles.length === 0,
    ...proofCredibility(finalized.verdict, finalized.machineGate, finalized.gateEligible),
    finalStatus: finalized.machineGate.status
  });
  return {
    coverage,
    decisions,
    results,
    evidence,
    artifacts,
    artifactIntegrity,
    finalized,
    outcomeSummary,
    executionSucceeded
  };
}

export async function persistBrowserPhaseForAggregate(state: EvidenceGateSubgraphInput) {
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
      payload: { browserAgent: true, mixedParentPhase: true }
    });
  }
  const { coverage: browserCoverage, decisions, results, evidence, artifacts, artifactIntegrity, finalized, outcomeSummary, executionSucceeded } = await finalizeBrowserExecutionProof({
    state,
    coverageScope: "browser",
    integrityId: `${state.runId}_browser_phase_artifact_integrity`,
    reasonPrefix: "browser_"
  });
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
    coverage: browserCoverage,
    decisions,
    actionResults: results,
    evidence,
    artifacts,
    artifactIntegrity,
    machineGate: finalized.machineGate,
    outcomeSummary,
    proof: finalized
  });
  const proof = await readProofArtifacts(state.runId);
  return {
    id: `${state.runId}:browser-phase`,
    state: "completed",
    finalStatus: finalized.machineGate.status,
    evidenceSetRoot: proof.manifest?.evidenceSetRoot,
    ...proofContributorCredibility(outcomeSummary),
    machineGate: finalized.machineGate,
    executionSucceeded
  };
}

export async function machineGateFromResult(bundle: Awaited<ReturnType<typeof readRunBundle>>): Promise<MachineGate> {
  const result = bundle.result;
  const stampedGate = result.machineGate as (MachineGate & Partial<VerifiedMachineGate>) | undefined;
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

export function deterministicRecommendation(machineGate: MachineGate): JudgeRecommendation {
  return {
    status: machineGate.status === "pass"
      ? "pass"
      : machineGate.status === "fail"
        ? "fail"
        : "needs-human-review",
    summary: "Deterministic recommendation derived from the verified Machine Gate; no LLM Judge was required.",
    evidenceRefs: Array.from(new Set(machineGate.reasonDetails?.flatMap((detail) => detail.evidenceRefs) ?? []))
  };
}
