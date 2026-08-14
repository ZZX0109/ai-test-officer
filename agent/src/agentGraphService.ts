import {
  agentPermissionProfileSchema,
  resolveFinalStatus,
  type JudgeRecommendation,
  type MachineGate,
  type AgentGraphProjection,
  type AgentInterrupt,
  browserActionDecisionSchema,
  runOutcomeSummaryV2Schema,
  type BrowserActionDecision,
  type BrowserAgentAction,
  type BrowserObservation,
  type RepairDecisionAnswer,
  type RecoveryActionResult,
  type RecoveryDecision,
  recoveryActionResultSchema
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
import { appendEvidence, readEvidence, readRunBundle, writeRunBundle } from "./evidenceStore.js";
import { getProject, getProjectRuntimeStatusWithRecovery, startProject } from "./projectAdapter.js";
import { createRepairSession, validateRepairSession } from "./repairWorkspace.js";
import { planRunFromDurableInput } from "./runPlanningService.js";
import { proposeCodeRepair } from "./llmCodeRepair.js";
import {
  createCoverageItems,
  createDynamicBrowserCoverageItems,
  createManifestCoverageItems,
  readCoverageItems,
  saveCoverageItems
} from "./coverageStore.js";
import { buildProofGraph, readProofArtifacts, writeProofArtifacts } from "./proofGraph.js";
import { persistParentAggregateEvidence } from "./parentRunEvidence.js";
import { buildLlmJudgeReport } from "./llmJudge.js";
import { persistExecutionResult, revalidatePersistedMachineGate } from "./executionPersistence.js";
import { finalizeProofBundle, proofContributorCredibility, proofCredibility, type MachineGateDraft, type VerifiedMachineGate } from "./proof/proofBundleService.js";
import type { ProofBundleInput } from "./proof/proofBundleValidator.js";
import { decideRepairFromDeterministic, mapDeterministicClassToFailureClass } from "./repairDecision.js";
import { persistRepairPlan } from "./repairPlan.js";
import type { RepairDecision, RepairOwner, EvidenceItem } from "./types.js";
import { runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import { getScenario } from "./scenarios.js";
import type { SourceReadEnvelope } from "./types.js";
import { getAgentSustainability } from "./agentSustainability.js";
import { withGraphExecutionScope } from "./graphSideEffects.js";
import { persistAgentObservation, persistRecoveryAction, persistRecoveryDecision } from "./recoveryStore.js";
import { chooseLlmRecoveryDecision } from "./llmRecoveryDecision.js";
import {
  ensureBrowserAgentSession,
  observeManagedBrowserSession,
  updateManagedBrowserSession,
  reloadManagedBrowserSession,
  finalizeBrowserAgentTrace,
  dynamicBrowserScenarioId,
  closeBrowserAgentSession
} from "./browser-agent/sessionManager.js";
import { decideNextBrowserActions } from "./browser-agent/llmDecision.js";
import { browserActionPolicy, executeBrowserAgentAction } from "./browser-agent/actionBroker.js";
import { appendBrowserDecision, readBrowserActionResults, readBrowserArtifacts, readBrowserDecisions } from "./browser-agent/store.js";
import { persistDynamicBrowserResult } from "./browser-agent/resultBundle.js";
import { getProjectLoginSecret, getProjectLoginSummary } from "./projectLoginStore.js";
import { listCredentials } from "./credentialStore.js";
import { artifactKindToIntegrityKind } from "./artifactIntegrity.js";
import { credentialInterruptDecision, observationShowsAuthenticationBoundary } from "./browser-agent/login.js";

/**
 * One LangGraph invoke must never try to walk an entire full-scan inventory.
 * Keep this deliberately small: a page path costs several graph nodes and a
 * model call, while the checkpoint between batches makes progress durable.
 */
const browserPathsPerGraphTurn = Math.max(1, Math.min(
  Number.parseInt(process.env.BROWSER_GRAPH_PATHS_PER_TURN ?? "3", 10) || 3,
  8
));
const browserModelCooldownMs = Math.max(1_000, Math.min(
  Number.parseInt(process.env.BROWSER_MODEL_COOLDOWN_MS ?? "5000", 10) || 5_000,
  30_000
));
const scheduledBrowserBatchResumes = new Set<string>();
const browserModelCooldownUntil = new Map<string, number>();

type InteractiveCoverageInventoryItem = {
  id: string;
  status?: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
  surfaces?: Array<"page" | "api" | "data" | "background-task">;
  preconditions?: string[];
  requiredEvidenceKinds?: Array<"screenshot" | "dom" | "network" | "console" | "trace" | "video" | "download" | "operation-log" | "report" | "attachment" | "source-patch" | "changed-files-archive" | "repair-validation-log">;
};

function interactiveCoverageInventory(value: unknown): InteractiveCoverageInventoryItem[] {
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
  // "登录后创建订单" and "sign in then open settings" describe a business
  // path whose prerequisite is authentication. Completing the login boundary
  // must not complete that downstream path.
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
  // Username/password population and login submission are prerequisites. They
  // must never be mistaken for proof that an unrelated business path was
  // exercised. The submit boundary has its own explicit handling below.
  if (result.oracleResults.some((oracle) => oracle.oracleId.startsWith("oracle_login_"))) return false;
  return result.oracleResults.every((oracle) => oracle.passed);
}

async function finalizeBrowserExecutionProof(input: {
  state: AgentGraphState;
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
  const coverageComplete = coverage.length > 0 && coverage.every((item) => item.disposition !== "pending");
  const blockedCoverage = coverage.filter((item) => item.disposition === "blocked");
  const executedResults = results.filter((item) => item.status === "completed");
  const failedOracles = executedResults.flatMap((item) => item.oracleResults.filter((oracle) => !oracle.passed));
  // A stale binding which is followed by a successful re-observation is an
  // auditable retry, not a second terminal result. Both mixed and browser-only
  // runs must apply this rule identically.
  const nonRetryableFailures = results.filter((item) =>
    item.status !== "completed" && item.errorCode !== "browser_control_binding_stale"
  );
  const executionSucceeded = executedResults.length > 0 && nonRetryableFailures.length === 0;
  const requirementCovered = coverageComplete && blockedCoverage.length === 0
    && coverage.every((item) => item.disposition === "executed");
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
  const status: MachineGate["status"] = !coverageComplete || blockedCoverage.length > 0 || !executionSucceeded || missingKinds.length > 0
    ? "blocked"
    : failedOracles.length > 0 ? "fail" : "pass";
  const failedEvidenceRefs = results
    .filter((item) => item.status !== "completed" || item.oracleResults.some((oracle) => !oracle.passed))
    .flatMap((item) => item.evidenceRefs);
  const decisionEvidenceRefs = decisions.flatMap((item) => item.evidenceRefs);
  const reasonEvidence = [...new Set([...failedEvidenceRefs, ...decisionEvidenceRefs])].slice(0, 8);
  const prefix = input.reasonPrefix ?? "";
  const reasons = [
    ...(!coverageComplete ? [`${prefix}coverage_disposition_incomplete`] : []),
    ...blockedCoverage.map((item) => `${prefix}coverage_blocked:${item.flowId}`),
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

/**
 * Persist the browser part of a mixed parent run before the Worker aggregates
 * API/data/job children.  The parent aggregate will replace the top-level run
 * bundle, but it must first have an immutable, verified browser evidence root
 * to include as one of its contributors.
 *
 * This deliberately does not advance the Run event state: when it is called
 * the Worker has already moved the parent to `collecting`, and only the final
 * aggregate may publish `run_judging`.
 */
async function persistBrowserPhaseForAggregate(state: AgentGraphState) {
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
// A run can be started from the POST /v1/runs background hand-off and, almost
// immediately afterwards, from a control endpoint which needs to synchronise
// the graph to an approval checkpoint. LangGraph persists checkpoints, but it
// does not serialize concurrent invokes for the same thread. Merge local
// callers before they contend for a durable node lease.
const inFlightGraphStarts = new Map<string, Promise<unknown>>();

export function agentOrchestrationMode(projectId?: string): "shadow" | "active" {
  if (process.env.AGENT_ORCHESTRATION_MODE === "shadow") return "shadow";
  // Active is the production/default path. Set AGENT_ORCHESTRATION_MODE=shadow
  // only for explicit comparison runs or an emergency rollback.
  // The former allowlist made a newly uploaded project silently fall back to
  // the legacy executor. Keep the variable for observability/rollback notes,
  // but do not let it downgrade normal projects; an explicit `shadow` mode is
  // the only supported rollback switch.
  void projectId;
  return "active";
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

export function discoveryCanHandOffToDynamicBrowser(input: {
  dynamicBrowser: boolean;
  documentCommitted: boolean;
  httpStatus?: number;
}) {
  const status = input.httpStatus ?? 200;
  return input.dynamicBrowser
    && input.documentCommitted
    && status >= 200
    && status < 400;
}

const MAX_RECOVERY_ATTEMPTS = {
  "retry-runtime": 2,
  "retry-discovery": 2,
  "retry-path": 2
} as const;

function recoveryEvidenceRefs(state: AgentGraphState): string[] {
  const refs = new Set<string>();
  const discovery = state.coverageMap?.discovery;
  if (discovery && typeof discovery === "object" && Array.isArray((discovery as Record<string, unknown>).evidence)) {
    for (const item of (discovery as { evidence: Array<{ id?: string }> }).evidence) {
      if (item.id) refs.add(item.id);
    }
  }
  const failureRefs = state.failure && Array.isArray(state.failure.evidenceRefs) ? state.failure.evidenceRefs : [];
  for (const ref of failureRefs) if (typeof ref === "string") refs.add(ref);
  return [...refs].slice(0, 20);
}

/**
 * Tell the credential interrupt whether the project already has a saved login
 * account. The operator-facing copy and options branch on this: an existing
 * account means "use saved account", not "please save one first". Without this
 * the panel always claimed no account existed while the run record believed
 * one was saved — the exact contradiction the operator saw.
 */
async function credentialInterruptMeta(projectId?: string): Promise<{ hasSavedCredential: boolean; usernameMasked?: string }> {
  if (!projectId) return { hasSavedCredential: false };
  try {
    const project = await getProject(projectId);
    const credentialId = project?.login?.credentialId;
    if (!credentialId) return { hasSavedCredential: false };
    const summary = await getProjectLoginSummary(credentialId);
    if (!summary) return { hasSavedCredential: false };
    return { hasSavedCredential: true, usernameMasked: summary.usernameMasked };
  } catch {
    return { hasSavedCredential: false };
  }
}

function deterministicRecoveryDecision(state: AgentGraphState): RecoveryDecision {
  const now = new Date().toISOString();
  const discovery = state.coverageMap?.discovery;
  const discoveryReason = discovery && typeof discovery === "object"
    ? String((discovery as Record<string, unknown>).reason ?? "")
    : "";
  const failureReason = Array.isArray(state.failure?.reasons)
    ? state.failure.reasons.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("; ")
    : "";
  // A product assertion can fail without a machine-gate reason. Never emit an
  // empty RecoveryDecision.reason: it violates the contract and used to strand
  // the Graph in `judging` with no user-visible recovery action.
  const reason = (discoveryReason.trim() || failureReason.trim() || "测试路径未完成，已保留失败证据并等待下一步处理");
  const lower = reason.toLowerCase();
  const evidenceRefs = recoveryEvidenceRefs(state);
  let action: RecoveryDecision["action"] = "blocked";
  let userQuestion: string | undefined;
  // Fault-injection scenarios deliberately create a 5xx/failed network
  // observation.  Treating that expected observation as a broken sandbox
  // caused the Graph to restart the runtime, overwrite the attempt lifecycle,
  // and loop instead of preserving the intended `needs_review` conclusion.
  // The flag is derived from the public scenario contract, never evaluator
  // labels, and only suppresses recovery after the expected action ran.
  const expectedFixtureFault = state.failure?.expectedFixtureFault === true;
  // Object-store failures happen after an executor has already produced local
  // evidence. They are an infrastructure block, never a reason to repair the
  // target project or loop through browser discovery. The persisted temporary
  // evidence remains available for diagnosis, while formal publication stays
  // fail-closed until MinIO/S3 is healthy again.
  if (expectedFixtureFault) {
    action = "blocked";
    userQuestion = "已按测试场景触发接口故障并采集网络与页面证据；这不是沙盒启动故障，因此不会重启项目或覆盖该 Attempt。";
  } else if (/artifact[_-]?object|object[ _-]?store|minio|\bs3\b|econnrefused|fetch failed/i.test(lower)) {
    action = "blocked";
    userQuestion = "测试步骤已执行，但证据对象存储当前不可用；系统已阻止正式提交，不会将此问题归为被测项目缺陷。请恢复对象存储后新建或重试该路径。";
  } else if (observationShowsAuthenticationBoundary(state.browserObservation)
    || (/credential|凭据|401|403|unauthorized|未登录/i.test(lower) && Boolean(state.browserObservation))) {
    action = "request-credentials";
    userQuestion = "页面要求登录，请配置测试账号后继续 Discovery。";
  } else if (state.discoveryTerminal === true) {
    action = /port|health|docker|sandbox|启动|连接|unreachable|timeout/i.test(lower)
      ? "retry-runtime"
      : "retry-discovery";
  } else if (state.failure?.status && state.failure.status !== "pass") {
    if (state.failure.failureClass === "evidence") {
      action = "blocked";
      userQuestion = "测试步骤已完成，但 AI 测试官自身的证据账本校验异常；系统不会把它当作外部项目缺陷，也不会修改你的项目。";
    } else action = state.failure.failureClass === "environment" ? "retry-runtime"
      : state.failure.failureClass === "test-script" ? "repair-harness"
        : state.failure.failureClass === "product-bug" ? "repair-product"
          : "retry-path";
  }
  const attempts = state.recoveryAttempts?.[action] ?? 0;
  const max = action in MAX_RECOVERY_ATTEMPTS ? MAX_RECOVERY_ATTEMPTS[action as keyof typeof MAX_RECOVERY_ATTEMPTS] : 1;
  if (attempts >= max && action !== "blocked") {
    action = "blocked";
    userQuestion = `恢复动作已达到上限（${max} 次），请查看运行详情后决定下一步。`;
  }
  return {
    schemaVersion: "1.0",
    id: `recovery_${randomUUID()}`,
    runId: state.runId,
    attemptId: state.currentAttemptId,
    action,
    reason,
    confidence: evidenceRefs.length ? "high" : "low",
    evidenceRefs,
    preconditions: action === "retry-runtime" ? ["项目路径和启动配置存在"] : [],
    expectedState: action === "request-credentials" ? "等待用户配置测试账号" : action === "blocked" ? "等待人工处理" : "重新进入可执行测试阶段",
    ...(userQuestion ? { userQuestion } : {}),
    createdAt: now,
    policyVersion: "recovery-policy-v1"
  };
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
      diagnoseRuntime: node("diagnose-runtime", async (state) => {
        const run = await runEventStore.get(state.runId);
        const projectId = state.projectId;
        const runtime = projectId ? await getProjectRuntimeStatusWithRecovery(projectId) : undefined;
        const discovery = state.coverageMap?.discovery;
        const summary = discovery && typeof discovery === "object"
          ? String((discovery as Record<string, unknown>).reason ?? "Discovery 未完成")
          : runtime?.message ?? "缺少运行时观测。";
        const observation = {
          schemaVersion: "1.0" as const,
          id: `observation_${randomUUID()}`,
          runId: state.runId,
          stage: "recovery" as const,
          status: runtime?.status === "running" ? "degraded" as const : "failed" as const,
          ...(typeof run?.input.appUrl === "string" ? { requestedUrl: run.input.appUrl } : {}),
          summary,
          evidenceRefs: recoveryEvidenceRefs(state),
          retryable: true,
          userActionRequired: /login|sign in|登录|credential|凭据|401|403/i.test(summary),
          createdAt: new Date().toISOString()
        };
        await persistAgentObservation(observation);
        return {
          observation: { ...observation, runtime, discovery },
          recoveryResult: undefined
        };
      }),
      chooseRecovery: node("choose-recovery", async (state) => {
        const baseline = deterministicRecoveryDecision(state);
        const run = await runEventStore.get(state.runId);
        const decision = await chooseLlmRecoveryDecision({
          baseline,
          credentialId: typeof run?.input.modelProfileId === "string" ? run.input.modelProfileId : undefined,
          projectId: state.projectId,
          failureClass: typeof state.failure?.failureClass === "string" ? state.failure.failureClass : undefined,
          observation: state.observation
        });
        await persistRecoveryDecision(decision);
        return {
          recoveryDecision: decision,
          recoveryAttempts: {
            ...(state.recoveryAttempts ?? {})
          }
        };
      }),
      recover: async (state) => {
        const decision = state.recoveryDecision ?? deterministicRecoveryDecision(state);
        const answer = (state as AgentGraphState & { interruptAnswer?: Record<string, unknown> }).interruptAnswer;
        if (decision.action === "request-credentials" && !answer) {
          const meta = await credentialInterruptMeta(state.projectId);
          const pending: AgentInterrupt = {
            id: `interrupt_${randomUUID()}`,
            runId: state.runId,
            kind: "credential",
            status: "pending",
            title: "需要测试账号",
            detail: meta.hasSavedCredential
              ? `已保存测试账号${meta.usernameMasked ? `（${meta.usernameMasked}）` : ""}。授权后系统仅在当前沙盒会话中注入登录，不会显示或写入报告。`
              : (decision.userQuestion ?? "当前页面需要登录凭据后才能继续 Discovery。请填写测试账号和密码，或暂不登录。"),
            requestedCapabilities: ["credential"],
            payload: { action: "provide-credentials" },
            owner: "user",
            context: {
              recoveryDecision: decision,
              hasSavedCredential: meta.hasSavedCredential,
              ...(meta.usernameMasked ? { usernameMasked: meta.usernameMasked } : {})
            },
            options: meta.hasSavedCredential
              ? [{ value: "approved", label: "使用已保存账号继续" }, { value: "dismiss", label: "暂不登录" }]
              : [{ value: "approved", label: "保存账号并继续" }, { value: "dismiss", label: "暂不登录" }],
            evidenceRefs: decision.evidenceRefs,
            createdAt: new Date().toISOString()
          };
          return { recoveryDecision: decision, recoveryInterrupt: pending };
        }
        if (decision.action === "request-credentials" && answer?.approved !== true) {
          return {
            recoveryDecision: decision,
            recoveryResult: recoveryActionResultSchema.parse({
              schemaVersion: "1.0", actionId: `action_${randomUUID()}`, runId: state.runId,
              action: decision.action, status: "blocked", evidenceRefs: decision.evidenceRefs,
              nextState: "blocked", userMessage: "用户未确认测试账号配置。", startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
            })
          };
        }
        // Once credentials are confirmed, the next concrete action is a fresh
        // Discovery probe. Keeping `request-credentials` as the action would
        // otherwise make verifyRecovery finalize immediately after the user
        // did exactly what we asked.
        const decisionForExecution: RecoveryDecision = decision.action === "request-credentials"
          ? { ...decision, id: `recovery_${randomUUID()}`, action: "retry-discovery", reason: "测试账号已确认，重新执行页面 Discovery。", expectedState: "重新进入可执行测试阶段", userQuestion: undefined }
          : decision;
        if (decisionForExecution.id !== decision.id) await persistRecoveryDecision(decisionForExecution);
        const attempts = { ...(state.recoveryAttempts ?? {}), [decisionForExecution.action]: (state.recoveryAttempts?.[decisionForExecution.action] ?? 0) + 1 };
        const startedAt = new Date().toISOString();
        let status: "completed" | "failed" | "blocked" = "completed";
        let message = "恢复动作已完成。";
        let discoveryUpdate: Record<string, unknown> | undefined;
        if (decisionForExecution.action === "retry-runtime" && state.projectId) {
          const runtime = await startProject(state.projectId);
          status = runtime.status === "running" ? "completed" : "failed";
          message = runtime.message;
        } else if (decisionForExecution.action === "retry-discovery" && state.projectId) {
          const scan = await runSmokeFirstDiscovery({ projectId: state.projectId, goal: state.requirement ?? "重新扫描页面", smokeAttempts: 2, discoveryAttempts: 2 });
          const discovered = discoveryState(scan);
          discoveryUpdate = { ...discovered, evidence: buildDiscoveryEvidence(scan, state.runId) };
          status = discovered.status === "ready" ? "completed" : "failed";
          message = scan.message;
        } else if (decisionForExecution.action === "retry-path") {
          status = "completed";
          message = "已创建新的路径 Attempt，准备重新执行。";
        } else if (decisionForExecution.action === "repair-harness" || decisionForExecution.action === "repair-product") {
          status = "blocked";
          message = "该恢复动作需要进入修复工作区并由用户确认。";
        } else if (decisionForExecution.action === "blocked") {
          status = "blocked";
          message = decision.userQuestion ?? "没有可执行的恢复动作。";
        }
        const result = recoveryActionResultSchema.parse({
          schemaVersion: "1.0", actionId: `action_${randomUUID()}`, runId: state.runId,
          action: decisionForExecution.action, status, evidenceRefs: decisionForExecution.evidenceRefs,
          nextState: status === "completed" ? "verify-recovery" : "blocked",
          ...(status !== "completed" ? { errorCode: "recovery_failed", userMessage: message } : {}),
          startedAt, completedAt: new Date().toISOString()
        });
        await persistRecoveryAction(result, decision.id);
        return {
          recoveryDecision: decisionForExecution,
          recoveryAttempts: attempts,
          recoveryResult: result,
          ...(discoveryUpdate ? { coverageMap: { ...(state.coverageMap ?? {}), discovery: discoveryUpdate }, discoveryTerminal: false } : {})
        };
      },
      verifyRecovery: node("verify-recovery", async (state) => {
        const result = state.recoveryResult;
        if (!result) return { recoveryResult: undefined };
        return {
          observation: {
            ...(state.observation ?? {}),
            stage: "recovery",
            status: result.status === "completed" ? "ready" : "failed",
            summary: result.userMessage ?? result.nextState,
            evidenceRefs: result.evidenceRefs
          }
        };
      }),
      retryPath: node("retry-path", async (state) => {
        const run = await runEventStore.get(state.runId);
        // A retry is valid only before Graph finalization.  Requeueing a
        // terminal Run would overwrite its provenance, so callers must create
        // a linked validation run instead.
        if (!run || run.state !== "judging") {
          return {
            recoveryResult: recoveryActionResultSchema.parse({
              schemaVersion: "1.0",
              actionId: `action_${randomUUID()}`,
              runId: state.runId,
              action: "retry-path",
              status: "blocked",
              evidenceRefs: state.recoveryDecision?.evidenceRefs ?? [],
              nextState: "blocked",
              errorCode: "retry_path_not_available",
              userMessage: "当前运行没有处于可重试的判定阶段；原始证据保持不变。",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString()
            })
          };
        }
        const retried = await appendSystemRunEvent(state.runId, "run_retrying", {
          recoveryActionId: state.recoveryResult?.actionId,
          previousAttemptId: state.currentAttemptId,
          reason: state.recoveryDecision?.reason ?? "retry_failed_path"
        });
        // `runOrchestrator` imports this service, so use a lazy import to keep
        // the Graph module acyclic during initialisation. This creates a real
        // BullMQ/in-process delivery; it is never merely a UI status change.
        const { enqueueRun } = await import("./runOrchestrator.js");
        // Let LangGraph commit the following execution-result interrupt before
        // the new Worker delivery starts. With an in-process worker an eager
        // enqueue can otherwise complete between `run_retrying` and the graph
        // checkpoint, recreating the old-result race this node exists to fix.
        const schedule = setTimeout(() => void enqueueRun(retried.id, retried.version).catch(() => undefined), 0);
        schedule.unref?.();
        return {
          currentAttemptId: `attempt_${randomUUID()}`,
          recoveryResult: state.recoveryResult,
          observation: {
            ...(state.observation ?? {}),
            stage: "recovery",
            status: "ready",
            summary: "已创建新的执行 Attempt 并重新投递 Worker；原失败 Attempt 保持可追溯。"
          }
        };
      }),
      continuePaths: node("continue-paths", async (state) => {
        const coverage = await readCoverageItems(state.runId).catch(() => []);
        const pending = coverage.filter((item) => item.disposition === "pending").length;
        const continuationPasses = state.continuationPasses ?? 0;
        return {
          remainingPathCount: pending,
          continuationPasses: pending > 0 ? continuationPasses + 1 : continuationPasses,
          observation: {
            ...(state.observation ?? {}),
            stage: "recovery",
            status: "ready",
            summary: pending
              ? `父 Run 将继续投递 ${pending} 条独立待执行路径（第 ${continuationPasses + 1} 次恢复继续）。`
              : "没有独立待执行路径；已保留失败路径与其证据。"
          }
        };
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
                requiredEvidenceKinds: inventory.find((item) => item.id === path.id)?.requiredEvidenceKinds
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
          runtime = await startProject(state.projectId);
        }
        return {
          execution: {
            ...(state.execution ?? {}),
            sandbox: runtime.status === "running" ? "ready" : "preparing",
            runtime
          }
        };
      }),
      observeBrowser: node("observe-browser", async (state) => {
        const run = await runEventStore.get(state.runId);
        if (!run) throw new Error("browser_agent_run_missing");
        const project = state.projectId ? await getProject(state.projectId) : undefined;
        const runtime = state.projectId ? await getProjectRuntimeStatusWithRecovery(state.projectId) : undefined;
        const url = runtime?.frontendUrl
          ?? project?.frontendUrl
          ?? (typeof run.input.appUrl === "string" ? run.input.appUrl : undefined);
        if (!url) throw new Error("browser_agent_target_url_missing");
        if (runtime && runtime.status !== "running") throw new Error(`browser_agent_runtime_${runtime.status}`);
        const coverage = await readCoverageItems(state.runId);
        const current = coverage.find((item) => item.id === state.currentCoverageItemId && item.surface === "page")
          ?? coverage.find((item) => item.disposition === "pending" && item.surface === "page")
          ?? coverage.find((item) => item.surface === "page");
        if (!current) throw new Error("browser_agent_coverage_missing");
        const attemptId = state.currentAttemptId ?? `attempt_${randomUUID()}`;
        const routes = [
          { id: "project-root", path: url }
        ];
        const session = await ensureBrowserAgentSession({
          runId: state.runId,
          attemptId,
          projectId: state.projectId,
          url,
          allowedOrigins: project?.allowedOrigins,
          routes,
          headless: true
        });
        const observation = await observeManagedBrowserSession({
          runId: state.runId,
          coverageItemId: current.id
        });
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
        if (session.actionCount >= 20 || session.decisionCount >= 6 || session.rebindCount > 2) {
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
        const run = await runEventStore.get(state.runId);
        if (!run) throw new Error("browser_agent_run_missing");
        const project = state.projectId ? await getProject(state.projectId) : undefined;
        const detectedLoginDecision = credentialInterruptDecision({
          runId: state.runId,
          coverageItemId: state.currentCoverageItemId,
          observation,
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
          // No LLM call is necessary: password + account field + a visible
          // submit control is direct runtime evidence of an authentication
          // boundary.  Preserve the model budget for the page after login.
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
            schemaVersion: "1.0",
            decisionId: `browser_decision_${randomUUID()}`,
            runId: state.runId,
            attemptId: observation.attemptId,
            observationId: observation.observationId,
            status: "blocked",
            reasonCode: "model-rate-limited",
            summary: `模型服务正在冷却，${Math.ceil(cooldownRemainingMs / 1000)} 秒后会自动继续当前页面路径。`,
            actions: [],
            oracles: [],
            evidenceRefs: observation.evidenceRefs,
            createdAt: new Date().toISOString()
          });
        } else if (transientPageFault) {
          decision = browserActionDecisionSchema.parse({
            schemaVersion: "1.0",
            decisionId: `browser_decision_${randomUUID()}`,
            runId: state.runId,
            attemptId: observation.attemptId,
            observationId: observation.observationId,
            status: "blocked",
            reasonCode: "transient-observation",
            summary: "页面资源加载期间网络发生变化，自动刷新同一浏览器会话后重新观测。",
            actions: [],
            oracles: [],
            evidenceRefs: observation.evidenceRefs,
            createdAt: new Date().toISOString()
          });
        } else try {
          decision = await decideNextBrowserActions({
            observation,
            coverageItemId: state.currentCoverageItemId,
            goal: [run.input.requirement, item?.module, item?.dispositionReason].filter(Boolean).join("\n"),
            credentialId: modelProfileId,
            allowedRouteIds: ["project-root"],
            previousResults: prior.map((result) => ({ action: result.actionId, status: result.status, summary: result.summary }))
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "browser_llm_decision_failed";
          const rateLimitedModelFailure = /(?:provider_http_429|http_429|rate[ _-]?limit|too many requests)/i.test(code);
          const retryableModelFailure = /fetch_failed|provider_|timeout|network|empty_response|responses_incomplete/i.test(code);
          if (rateLimitedModelFailure) browserModelCooldownUntil.set(modelCooldownKey, Date.now() + browserModelCooldownMs);
          decision = browserActionDecisionSchema.parse({
            schemaVersion: "1.0",
            decisionId: `browser_decision_${randomUUID()}`,
            runId: state.runId,
            attemptId: observation.attemptId,
            observationId: observation.observationId,
            status: "blocked",
            reasonCode: rateLimitedModelFailure ? "model-rate-limited" : retryableModelFailure ? "transient-model" : code.startsWith("llm_budget_exceeded") ? "budget-exhausted" : undefined,
            summary: code.startsWith("llm_budget_exceeded")
              ? `当前业务路径已达到独立的浏览器 AI 预算（${code}），系统会保留该路径证据并继续处理其他路径。`
              : rateLimitedModelFailure
                ? `模型服务暂时限流，系统会在 ${Math.ceil(browserModelCooldownMs / 1000)} 秒后自动重试当前页面路径。`
              : retryableModelFailure
                ? `浏览器模型调用暂时失败：${code}`
                : `浏览器 AI 决策失败：${code}`,
            actions: [],
            oracles: [],
            evidenceRefs: observation.evidenceRefs,
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
      authorizeBrowserAction: async (state: AgentGraphState, answer?: Record<string, unknown>) => {
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
        if (credentialAction && state.browserCredentialAuthorized === true) {
          return { browserActionAuthorized: true, browserDecision: { ...decision, status: "act" } };
        }
        if (credentialAction) {
          const credentialMeta = await credentialInterruptMeta(state.projectId);
          if (credentialMeta.hasSavedCredential) {
            // The operator already granted browser control for this run and
            // explicitly saved a project-scoped test account. Requiring a
            // second confirmation for each username/password field leaves the
            // autonomous loop parked on login even though all prerequisites
            // are satisfied. The secret remains server-side and is injected
            // only into this sandbox BrowserContext.
            return {
              browserActionAuthorized: true,
              browserCredentialAuthorized: true,
              browserDecision: { ...decision, status: "act", userQuestion: undefined }
            };
          }
        }
        if (policy.allowed) {
          // The deterministic broker owns capability policy. A model may label
          // an ordinary observed control conservatively as
          // `needs-confirmation`, but that must not pause an autonomous test
          // when the action is neither credential-bearing nor destructive.
          // Sensitive cases have already been separated above and destructive
          // controls produce `policy.confirmation=true`.
          return {
            browserActionAuthorized: true,
            browserDecision: { ...decision, status: "act", userQuestion: undefined }
          };
        }
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
              browserDecisionId: decision.decisionId,
              actionId: action.actionId,
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
        const project = state.projectId ? await getProject(state.projectId) : undefined;
        const result = await executeBrowserAgentAction({
          action,
          oracles: decision.oracles,
          userAuthorized: state.browserActionAuthorized === true || state.browserCredentialAuthorized === true,
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
            reasons: [result.errorCode ?? result.summary],
            evidenceRefs: result.evidenceRefs,
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
        const priorResults = (await readBrowserActionResults(state.runId))
          .filter((item) => item.coverageItemId === state.currentCoverageItemId && (decision ? item.attemptId === decision.attemptId : true));
        const pathResults = priorResults;
        const transientDecision = decision?.status === "blocked"
          && (decision.reasonCode === "transient-observation" || decision.reasonCode === "transient-model");
        if (transientDecision && (state.browserSession?.rebindCount ?? 0) < 2) {
          const session = await reloadManagedBrowserSession(state.runId);
          return {
            browserSession: session,
            browserDecision: undefined,
            browserActionResult: undefined,
            browserLoopComplete: false,
            failure: undefined
          };
        }
        if (decision?.status === "blocked" && decision.reasonCode === "model-rate-limited" && (state.browserRateLimitRetries ?? 0) < 1) {
          return {
            browserDecision: undefined,
            browserActionResult: undefined,
            browserLoopComplete: false,
            browserBatchPending: true,
            browserBatchDelayMs: browserModelCooldownMs,
            browserBatchResumed: false,
            browserRateLimitRetries: (state.browserRateLimitRetries ?? 0) + 1,
            failure: undefined,
            observation: {
              ...(state.observation ?? {}),
              stage: "model-cooldown",
              status: "waiting",
              summary: `模型服务限流，正在等待 ${Math.ceil(browserModelCooldownMs / 1000)} 秒后自动继续当前路径。`
            }
          };
        }
        let terminalDisposition: "executed" | "blocked" | undefined;
        let dispositionReason: string | undefined;
        const completedLoginBoundary = result?.status === "completed"
          && result.oracleResults.length > 0
          && result.oracleResults.every((oracle) => oracle.passed)
          && result.oracleResults.some((oracle) => oracle.oracleId === "oracle_login_submit_changes_page");
        const currentCoverage = coverage[currentIndex];
        const currentPathIsAuthentication = coverageItemRepresentsAuthentication(currentCoverage);
        if (completedLoginBoundary && !currentPathIsAuthentication) {
          // Authentication is a session prerequisite, not proof that an
          // arbitrary business flow (approval, order creation, export, ...)
          // was tested. Keep the current CoverageItem pending and observe the
          // post-login page before asking for the first action of that flow.
          return {
            browserDecision: undefined,
            browserActionResult: undefined,
            browserLoopComplete: false,
            failure: undefined
          };
        }
        if (completedLoginBoundary) {
          // The deterministic login helper has a terminal machine Oracle. Once
          // it proves that the password field disappeared, this authentication
          // path is complete. Asking the model for another action made it log
          // out again and turned a successful login into a false blocker.
          terminalDisposition = "executed";
          dispositionReason = "已使用保存的测试账号登录，并验证登录页面已退出";
        } else if (browserActionCompletesBusinessPath(result)) {
          // A dynamic CoverageItem compiles to one bounded browser action and
          // its declared machine Oracle. Once that proof is present, the path
          // is complete. Previously the graph kept asking the model to explore
          // unrelated controls until its budget expired, converting successful
          // automation into a false blocked result.
          terminalDisposition = "executed";
          dispositionReason = "动态浏览器动作已执行，绑定的机器 Oracle 已通过";
        } else if (decision?.status === "complete") {
          const grounded = browserPathResultsAreGrounded(pathResults);
          terminalDisposition = grounded ? "executed" : "blocked";
          dispositionReason = grounded ? "动态浏览器动作和确定性 Oracle 已完成" : "浏览器 Agent 宣布完成，但缺少通过的确定性 Oracle";
        } else if (result?.status === "completed" && result.oracleResults.some((oracle) => !oracle.passed)) {
          // Coverage means the path and oracle were actually executed. A
          // business assertion failure is an executed path with a fail gate,
          // not an infrastructure coverage gap.
          terminalDisposition = "executed";
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
          ...coverage[currentIndex],
          disposition: terminalDisposition,
          dispositionReason,
          scenarioId: dynamicBrowserScenarioId(state.runId),
          attemptId: state.currentAttemptId,
          updatedAt: new Date().toISOString()
        };
        await saveCoverageItems(state.runId, coverage);
        // API/data/background items belong to their deterministic executors;
        // never ask the browser model to fake those checks through UI clicks.
        const next = coverage.find((item) => item.disposition === "pending" && item.surface === "page");
        if (next) {
          const session = await updateManagedBrowserSession(state.runId, { actionCount: 0, decisionCount: 0, rebindCount: 0 });
          const pathsInBatch = (state.browserBatchPathCount ?? 0) + 1;
          const yieldBatch = pathsInBatch >= browserPathsPerGraphTurn;
          return {
            currentCoverageItemId: next.id,
            browserSession: session,
            browserDecision: undefined,
            browserActionResult: undefined,
            browserLoopComplete: false,
            browserBatchPathCount: pathsInBatch,
            browserBatchPending: yieldBatch,
            browserBatchDelayMs: undefined,
            browserBatchResumed: false,
            browserRateLimitRetries: 0,
            observation: {
              ...(state.observation ?? {}),
              stage: "browser-batch",
              status: yieldBatch ? "waiting" : "running",
              summary: yieldBatch
                ? `已完成本批 ${pathsInBatch} 条页面路径，正在保存进度并自动继续下一批。`
                : `已完成本批第 ${pathsInBatch} 条页面路径，继续处理下一条。`
            }
          };
        }
        const remainingStructuredPaths = coverage.filter((item) =>
          item.disposition === "pending"
          && item.surface !== "page"
          && Boolean(item.structuredPlan)
        ).length;
        return {
          browserLoopComplete: true,
          browserBatchPending: false,
          browserBatchDelayMs: undefined,
          browserBatchResumed: false,
          remainingPathCount: remainingStructuredPaths
        };
      }),
      collectAndGate: node("collect-and-gate", async (state) => {
        if (state.mode === "shadow") {
          const run = await runEventStore.get(state.runId);
          return { gate: run?.machineGate ? { machineGate: run.machineGate, outcomeSummary: run.outcomeSummary } : {} };
        }
        if (state.browserAgentRequired && state.execution?.aggregate !== true) {
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
          const { coverage, decisions, results, evidence, artifacts, artifactIntegrity, finalized, outcomeSummary } = await finalizeBrowserExecutionProof({
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
            proof: finalized
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
          const browserPhase = state.browserAgentRequired
            ? await persistBrowserPhaseForAggregate(state)
            : undefined;
          const coverage = await readCoverageItems(state.runId);
          const coverageComplete = coverage.length > 0 && coverage.every((item) => item.disposition !== "pending");
          const blockedCoverage = coverage.filter((item) => item.disposition === "blocked");
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
                ...childProof.map(({ child, proof }) => ({
                  id: child.id,
                  state: child.state,
                  finalStatus: child.gateStatus,
                  evidenceSetRoot: proof.manifest?.evidenceSetRoot,
                  artifactIntegrityVerified: child.outcomeSummary?.artifactIntegrityVerified === true,
                  evidenceGrounded: child.outcomeSummary?.evidenceGrounded === true,
                  machineGate: child.machineGate
                })),
                ...(browserPhase ? [browserPhase] : [])
              ],
              machineGateDraft: aggregateDraft,
              gateEligibleFacts: { executionSucceeded, requirementCovered: coverageComplete },
              judgeRecommendation
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
        { value: "repair", label: "授权 AI 生成沙盒补丁", description: "AI 会根据当前证据在隔离副本中生成补丁，并在修改后执行验证；不会写入原项目。" },
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
  // Assessment is always human-gated. The model may diagnose and propose a
  // sandbox patch, but creating/writing that patch is a user-approved action;
  // neither agent-owned selector fixes nor product repair may silently modify
  // a project copy in the background.
  if (!state.projectId || !state.permissionProfile.sandboxWrite) {
    return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run, "sandbox-write-required") };
  }
  return { repairInterrupt: buildRepairInterrupt(state, repairDecision, failureClass, run) };
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
  return service.resume(runId, value);
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
