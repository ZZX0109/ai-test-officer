import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  resolveFinalStatus,
  runOutcomeSummaryV2Schema,
  type CoverageItem,
  type JudgeRecommendation,
  type MachineGate
} from "@ai-test-officer/contracts";
import {
  AttemptClock,
  commitCapturedFile
} from "@ai-test-officer/playwright-runtime";
import { appendEvidence, writeRunBundle } from "./evidenceStore.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { buildProofGraph, writeProofArtifacts } from "./proofGraph.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "./proof/proofBundleService.js";
import { mirrorArtifactsToConfiguredStore } from "./artifactObjectStore.js";
import {
  getProject,
  resolveProjectTarget,
  startProject,
  testProjectConnection
} from "./projectAdapter.js";
import { runStructuredReActLoop, type StructuredReActLoopResult } from "./react/structuredLoop.js";
import type { StructuredAction } from "./structuredActionExecutors.js";
import type {
  ArtifactIntegrityReport,
  JudgeResult,
  LayeredJudgeReport,
  RunBundle,
  VisualRunResult
} from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

function judgeLayer(
  layer: JudgeResult["layer"],
  status: MachineGate["status"],
  evidenceId: string,
  summary: string
): JudgeResult {
  return {
    layer,
    title: `${layer} structured coverage judge`,
    verdict: status === "pass" ? "pass" : status === "fail" ? "fail" : "needs_review",
    summary,
    findings: status === "pass" ? [] : [{
      id: `structured_${layer}_${status}`,
      severity: status === "fail" ? "high" : "medium",
      failureClass: status === "fail" ? "product_bug" : status === "blocked" ? "environment_issue" : "insufficient_evidence",
      title: summary,
      reasoning: "The verdict is derived from an allow-listed manifest action and its committed operation artifact.",
      evidenceRefs: [evidenceId]
    }]
  };
}

function judgeReport(status: MachineGate["status"], evidenceId: string, summary: string): LayeredJudgeReport {
  return {
    source: "deterministic_judge",
    executionMode: "deterministic",
    llmStatus: "not_configured",
    policyVersion: "structured-coverage-policy-v1",
    createdAt: new Date().toISOString(),
    planJudge: judgeLayer("plan", status, evidenceId, summary),
    evidenceJudge: judgeLayer("evidence", status, evidenceId, summary),
    releaseJudge: judgeLayer("release", status, evidenceId, summary)
  };
}

function classifyExecutionError(message: string): {
  gate: "blocked" | "needs-human-review";
  failureClass: "environment_issue" | "test_script_issue";
} {
  if (/credential|connection|runtime|timeout|network|oci|command|unavailable|aborted/i.test(message)) {
    return { gate: "blocked", failureClass: "environment_issue" };
  }
  return { gate: "needs-human-review", failureClass: "test_script_issue" };
}

export async function runStructuredCoveragePath(input: {
  runId: string;
  attemptId?: string;
  projectId: string;
  coverageItem: CoverageItem;
  requirement?: string;
  signal?: AbortSignal;
}): Promise<VisualRunResult> {
  const project = await getProject(input.projectId);
  if (!project?.manifest) throw new Error("structured_coverage_project_manifest_missing");
  const plan = input.coverageItem.structuredPlan;
  if (!plan) throw new Error("structured_coverage_plan_missing");
  const startedAt = new Date().toISOString();
  const attemptId = input.attemptId ?? `${input.runId}_attempt_1`;
  const scenarioId = plan.scenarioId;
  const clock = new AttemptClock();
  const directory = path.join(reportsDir, "runs", input.runId);
  await mkdir(directory, { recursive: true });

  const actions = plan.steps.map((step) => step.action);
  const action = actions[0];
  if (!action || actions.some((candidate) => !["api-request", "data-assert", "wait-job", "command-check"].includes(candidate.action))) {
    throw new Error("structured_coverage_action_invalid");
  }
  // API and long-running job checks require a reachable service. Data and
  // command checks execute inside their own isolated adapter and must not be
  // blocked merely because the frontend is intentionally not running.
  if (actions.some((candidate) => candidate.action === "api-request" || candidate.action === "wait-job")) {
    const health = await testProjectConnection(project);
    if (!health.ok) {
      const runtime = await startProject(project.id);
      if (runtime.status !== "running") {
        throw new Error(`runtime_unavailable:${runtime.failureReason}:${runtime.message}`);
      }
    }
  }
  const target = await resolveProjectTarget({ projectId: project.id });

  let react: StructuredReActLoopResult;
  let executionError: string | undefined;
  try {
    react = await runStructuredReActLoop({
      steps: plan.steps,
      manifest: project.manifest,
      project,
      target,
      signal: input.signal
    });
    executionError = react.error;
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    react = { turns: [], completed: false, passed: false, error: executionError };
  }
  const executions = react.turns;
  const execution = executions.at(-1)?.result;
  const firstFailedTurnIndex = executions.findIndex((turn) => turn.status !== "executed");
  const firstFailedTurn = firstFailedTurnIndex >= 0 ? executions[firstFailedTurnIndex] : undefined;
  const firstFailedOracleIndex = firstFailedTurnIndex >= 0 ? firstFailedTurnIndex : Math.max(0, executions.length - 1);

  const stepId = firstFailedTurn?.stepId ?? executions.at(-1)?.stepId ?? plan.steps[0].id;
  const allPassed = react.completed && react.passed;
  // Keep operation artifacts immutable across retries.  The run directory is
  // shared by all attempts, so the attempt identity must be part of the file
  // name as well as the Artifact id; otherwise a later attempt overwrites the
  // bytes that prove the earlier result.
  const attemptKey = attemptId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const finalPath = path.join(directory, `${stepId}.${attemptKey}.operation.json`);
  const temporaryPath = `${finalPath}.partial`;
  await writeFile(temporaryPath, JSON.stringify({
    coverageItemId: input.coverageItem.id,
    flowId: input.coverageItem.flowId,
    actions,
    turns: executions,
    result: execution,
    error: executionError
  }, null, 2));
  const committed = await commitCapturedFile({
    temporaryPath,
    finalPath,
    id: `${input.runId}_operation_${attemptKey}_${stepId}`,
    identity: { runId: input.runId, scenarioId, attemptId, attempt: 1 },
    stepId,
    kind: "operation-log",
    mediaType: "application/json",
    storageUri: `/artifacts/runs/${input.runId}/${path.basename(finalPath)}`,
    clock,
    collectorVersion: "0.2.0"
  });
  // Browser and structured (API/data/job/command) paths have the same
  // production evidence contract. A local operation log is not a committed
  // production artifact until the configured object store has atomically
  // accepted and verified it. Do this before minting the proof bundle so the
  // returned Artifact v2 carries its immutable S3 replica URI.
  const capturedArtifact = execution?.locator ? { ...committed, locator: execution.locator } : committed;
  const [artifact] = await mirrorArtifactsToConfiguredStore([capturedArtifact], reportsDir);
  const evidence = await appendEvidence(input.runId, {
    type: "operation",
    title: `${input.coverageItem.surface} coverage: ${input.coverageItem.module}`,
    scenarioId,
    attemptId,
    attempt: 1,
    sequence: artifact.sequence + 1,
    pathId: input.coverageItem.flowId,
    stepId,
    file: artifact.storageUri,
    artifactIds: [artifact.id],
    locator: execution?.locator,
    payload: {
      action: action.action,
      coverageItemId: input.coverageItem.id,
      turns: executions.map((turn) => ({
        stepId: turn.stepId,
        action: turn.action.action,
        status: turn.status,
        summary: turn.result?.summary,
        error: turn.error,
        payload: turn.result?.payload
      })),
      ...(execution?.payload ?? {}),
      ...(executionError ? { errorCode: executionError.split(":")[0], error: executionError } : {})
    }
  });

  const classification = executionError ? classifyExecutionError(executionError) : undefined;
  const machineStatus: MachineGate["status"] = executionError
    ? classification!.gate
    : allPassed ? "pass" : "fail";
  const summary = executionError
    ? `Structured coverage path could not complete: ${executionError}`
    : allPassed
      ? `Structured ReAct loop completed ${executions.length} allow-listed steps.`
      : executions.at(-1)?.result?.summary ?? "Structured coverage path produced no result.";
  const machineGateDraft: MachineGateDraft = {
    status: machineStatus,
    reasons: machineStatus === "pass" ? [] : [executionError ? `structured_execution_error:${executionError}` : "structured_oracle_failed"],
    reasonDetails: machineStatus === "pass" ? [] : [{
      code: executionError ? executionError.split(":")[0] : "structured_oracle_failed",
      summary,
      evidenceRefs: [evidence.id]
    }],
    assertionFailures: allPassed ? [] : [input.coverageItem.oracleIds[firstFailedOracleIndex] ?? firstFailedTurn?.action.action ?? action.action]
  };
  // Proof credibility (evidenceComplete / artifactIntegrityVerified /
  // evidenceGrounded / gateEligible) is computed from the actually-captured
  // artifact + evidence by the Proof Bundle Service — the single minting point.
  const requirementCovered = executions.length > 0;
  const artifactIntegrity: ArtifactIntegrityReport = {
    id: `${input.runId}_artifact_integrity`,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: { total: 1, present: 1, missing: 0, unreadable: 0, pathEscapes: 0, selfReferences: 0, hashMismatches: 0, hashed: 1 },
    items: [{ id: artifact.id, artifactUri: artifact.storageUri, kind: "operation", evidenceId: evidence.id, status: "present", sha256: artifact.integrity.sha256, sizeBytes: artifact.integrity.sizeBytes }]
  };
  const { machineGate, verdict, issues, gateEligible } = finalizeProofBundle({
    draft: machineGateDraft,
    runId: input.runId,
    evidence: [evidence],
    artifactsV2: [artifact],
    artifactIntegrity,
    requiredArtifactKinds: ["operation-log"],
    machineGate: machineGateDraft,
    judgeReport: judgeReport(machineStatus, evidence.id, summary),
    gateEligibleFacts: { executionSucceeded: allPassed, requirementCovered }
  });
  const judgeRecommendation: JudgeRecommendation = {
    status: machineStatus === "pass" ? "pass" : machineStatus === "fail" ? "fail" : "needs-human-review",
    summary,
    evidenceRefs: [evidence.id]
  };
  const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
  const requirementPassed = requirementCovered && allPassed;
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: allPassed,
    requirementCovered,
    requirementPassed,
    ...proofCredibility(verdict, machineGate, gateEligible),
    proofValidationIssues: issues,
    machineGate,
    judgeRecommendation,
    finalStatus
  });
  const result: VisualRunResult = {
    id: input.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict: finalStatus === "pass" ? "continue" : finalStatus === "fail" ? "stop_and_fix" : "hold_for_review",
    summary,
    steps: executions.length > 0 ? executions.map((turn) => ({
      stepId: turn.stepId,
      title: `${input.coverageItem.module} · ${turn.action.action}`,
      status: turn.status === "executed" ? "passed" : turn.status === "failed" ? "failed" : "warning",
      action: turn.action.action,
      details: turn.result?.summary ?? turn.error ?? summary
    })) : [{
      stepId,
      title: input.coverageItem.module,
      status: "warning" as const,
      action: action.action,
      details: summary
    }],
    network: executions.flatMap((turn) => turn.action.action === "api-request" || turn.action.action === "wait-job"
      ? [{ method: turn.result?.locator.method ?? "GET", url: input.coverageItem.route ?? input.coverageItem.operationId ?? input.coverageItem.flowId, status: turn.result?.locator.statusCode }]
      : []),
    console: [],
    assertions: [{
      name: input.coverageItem.oracleIds[0] ?? `${input.coverageItem.flowId}:oracle`,
      passed: requirementPassed,
      expected: "The manifest-bound operation satisfies its declared oracle.",
      actual: summary,
      fact: {
        kind: executionError ? "environment.error" : "state.equals",
        target: input.coverageItem.flowId,
        operator: "equals",
        expected: "pass",
        actual: machineStatus,
        severity: input.coverageItem.risk === "critical" || input.coverageItem.risk === "high" ? "high" : "medium",
        evidenceRefs: [evidence.id],
        failureClass: executionError ? classification?.failureClass : allPassed ? undefined : "product_bug"
      }
    }],
    evidence: [evidence],
    loopEvents: [],
    oracles: executions.map((turn, index) => ({
      id: input.coverageItem.oracleIds[index] ?? `${input.coverageItem.flowId}:oracle:${index + 1}`,
      pathId: input.coverageItem.flowId,
      assertionName: input.coverageItem.oracleIds[index] ?? `${input.coverageItem.flowId}:oracle:${index + 1}`,
      expectedFrom: "requirement",
      preconditions: input.coverageItem.preconditions,
      action: JSON.stringify(turn.action),
      postconditions: ["A committed operation artifact and deterministic assertion exist."],
      requiresHumanConfirmation: false,
      evidenceRefs: [evidence.id]
    })),
    riskCoverageMatrix: [{
      riskId: input.coverageItem.id,
      riskTitle: input.coverageItem.module,
      covered: requirementCovered,
      passed: requirementPassed,
      pathIds: [input.coverageItem.flowId],
      evidenceRefs: [evidence.id],
      notes: summary
    }],
    aggregatedVerdict: {
      runCount: 1,
      failedAssertionCount: requirementPassed ? 0 : 1,
      flaky: false,
      verdict: finalStatus === "pass" ? "continue" : finalStatus === "fail" ? "stop_and_fix" : "hold_for_review",
      reason: summary
    },
    reflectionNote: "Structured path results are deterministic and cannot be upgraded by an unavailable LLM.",
    conflictPacket: { status: "not_triggered", reason: "No cross-layer conflict.", evidenceRefs: [evidence.id] },
    failureAttributions: machineStatus === "pass" ? [] : [{
      id: `${input.runId}_failure_1`,
      rank: 1,
      failureClass: executionError ? classification!.failureClass : "product_bug",
      title: summary,
      reasoning: summary,
      suggestedFix: executionError ? "Repair the environment or manifest binding, then create a new validation run." : "Inspect the product behavior associated with the failed oracle.",
      reproductionSteps: [JSON.stringify(action)],
      evidenceRefs: [evidence.id],
      sourceContextIds: [],
      confidence: executionError ? "medium" : "high"
    }],
    attempts: [{
      id: attemptId,
      runId: input.runId,
      scenarioId,
      attempt: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: machineStatus === "pass" ? "passed" : "failed",
      retryReason: executionError,
      artifactIds: [artifact.id]
    }],
    artifactsV2: [artifact],
    gateStatus: finalStatus,
    machineGate,
    judgeRecommendation,
    finalStatus,
    outcomeSummary,
    executionError: executionError ? {
      code: classification?.failureClass === "environment_issue" ? "environment_failure" : "action_binding_failure",
      stepId,
      message: executionError,
      failureClass: classification?.failureClass ?? "unknown"
    } : undefined,
    judgeReport: judgeReport(machineStatus, evidence.id, summary),
    judgeRouting: { route: "deterministic", reason: "manifest-bound structured action", signals: [action.action] },
    reportFile: `/artifacts/runs/${input.runId}/${path.basename(finalPath)}`,
    runBundleFile: `/artifacts/runs/${input.runId}/run_bundle.json`,
    coverageItems: [{ ...input.coverageItem, disposition: executionError ? "blocked" : "executed", dispositionReason: summary, attemptId }]
  };
  const proof = buildProofGraph(result);
  result.conclusions = proof.conclusions;
  result.proofNodes = proof.proofNodes;
  result.proofEdges = proof.proofEdges;
  const bundle: RunBundle = {
    runId: input.runId,
    startedAt,
    finishedAt: result.finishedAt,
    input: {
      runId: input.runId,
      projectId: input.projectId,
      requirement: input.requirement,
      scenarioId,
      compiledPlan: plan,
      permissionProfile: {
        observe: true,
        browserControl: false,
        sourceRead: true,
        sandboxWrite: false,
        sandboxCommand: action.action === "command-check",
        networkInstall: false,
        hostApply: false,
        artifactExport: false,
        systemControl: false,
        workspaceControl: false,
        ideTerminalControl: false
      }
    },
    project,
    result: { ...result, evidence: undefined, loopEvents: undefined, oracles: undefined, riskCoverageMatrix: undefined } as RunBundle["result"],
    evidence: result.evidence,
    artifactsV2: result.artifactsV2,
    attempts: result.attempts,
    loopEvents: result.loopEvents,
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix,
    conflictPacket: result.conflictPacket,
    failureAttributions: result.failureAttributions,
    coverageItems: result.coverageItems,
    conclusions: result.conclusions,
    proofNodes: result.proofNodes,
    proofEdges: result.proofEdges,
    judgeReport: result.judgeReport
  };
  const manifest = await writeProofArtifacts(bundle);
  result.evidenceManifest = manifest;
  bundle.evidenceManifest = manifest;
  bundle.result.evidenceManifest = manifest;
  await writeRunBundle(bundle);
  await persistExecutionResult(input.runId, result, { verdict, gateEligible });
  return result;
}
