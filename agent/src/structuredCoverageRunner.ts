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
import {
  getProject,
  resolveProjectTarget,
  startProject,
  testProjectConnection
} from "./projectAdapter.js";
import { executeStructuredAction, type StructuredAction } from "./structuredActionExecutors.js";
import type {
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
  const attemptId = `${input.runId}_attempt_1`;
  const scenarioId = plan.scenarioId;
  const clock = new AttemptClock();
  const directory = path.join(reportsDir, "runs", input.runId);
  await mkdir(directory, { recursive: true });

  const action = plan.steps[0]?.action;
  if (!action || !["api-request", "data-assert", "wait-job", "command-check"].includes(action.action)) {
    throw new Error("structured_coverage_action_invalid");
  }
  // API and long-running job checks require a reachable service. Data and
  // command checks execute inside their own isolated adapter and must not be
  // blocked merely because the frontend is intentionally not running.
  if (action.action === "api-request" || action.action === "wait-job") {
    const health = await testProjectConnection(project);
    if (!health.ok) {
      const runtime = await startProject(project.id);
      if (runtime.status !== "running") {
        throw new Error(`runtime_unavailable:${runtime.failureReason}:${runtime.message}`);
      }
    }
  }
  const target = await resolveProjectTarget({ projectId: project.id });

  let execution: Awaited<ReturnType<typeof executeStructuredAction>> | undefined;
  let executionError: string | undefined;
  try {
    execution = await executeStructuredAction({
      action: action as StructuredAction,
      manifest: project.manifest,
      project,
      target,
      signal: input.signal
    });
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  }

  const stepId = plan.steps[0].id;
  const finalPath = path.join(directory, `${stepId}.operation.json`);
  const temporaryPath = `${finalPath}.partial`;
  await writeFile(temporaryPath, JSON.stringify({
    coverageItemId: input.coverageItem.id,
    flowId: input.coverageItem.flowId,
    action,
    result: execution,
    error: executionError
  }, null, 2));
  const committed = await commitCapturedFile({
    temporaryPath,
    finalPath,
    id: `${input.runId}_operation_1_${stepId}`,
    identity: { runId: input.runId, scenarioId, attemptId, attempt: 1 },
    stepId,
    kind: "operation-log",
    mediaType: "application/json",
    storageUri: `/artifacts/runs/${input.runId}/${path.basename(finalPath)}`,
    clock,
    collectorVersion: "0.2.0"
  });
  const artifact = execution?.locator ? { ...committed, locator: execution.locator } : committed;
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
      ...(execution?.payload ?? {}),
      ...(executionError ? { errorCode: executionError.split(":")[0], error: executionError } : {})
    }
  });

  const classification = executionError ? classifyExecutionError(executionError) : undefined;
  const machineStatus: MachineGate["status"] = executionError
    ? classification!.gate
    : execution?.passed ? "pass" : "fail";
  const summary = executionError
    ? `Structured coverage path could not complete: ${executionError}`
    : execution?.summary ?? "Structured coverage path produced no result.";
  const machineGate: MachineGate = {
    status: machineStatus,
    reasons: machineStatus === "pass" ? [] : [executionError ? `structured_execution_error:${executionError}` : "structured_oracle_failed"],
    reasonDetails: machineStatus === "pass" ? [] : [{
      code: executionError ? executionError.split(":")[0] : "structured_oracle_failed",
      summary,
      evidenceRefs: [evidence.id]
    }],
    assertionFailures: execution?.passed ? [] : [input.coverageItem.oracleIds[0] ?? action.action],
    evidenceComplete: true
  };
  const judgeRecommendation: JudgeRecommendation = {
    status: machineStatus === "pass" ? "pass" : machineStatus === "fail" ? "fail" : "needs-human-review",
    summary,
    evidenceRefs: [evidence.id]
  };
  const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
  const requirementCovered = !executionError;
  const requirementPassed = requirementCovered && execution?.passed === true;
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: !executionError,
    requirementCovered,
    requirementPassed,
    artifactIntegrityVerified: true,
    evidenceGrounded: true,
    gateEligible: requirementCovered,
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
    steps: [{
      stepId,
      title: input.coverageItem.module,
      status: machineStatus === "pass" ? "passed" : machineStatus === "fail" ? "failed" : "warning",
      action: action.action,
      details: summary
    }],
    network: action.action === "api-request" || action.action === "wait-job"
      ? [{ method: execution?.locator.method ?? "GET", url: input.coverageItem.route ?? input.coverageItem.operationId ?? input.coverageItem.flowId, status: execution?.locator.statusCode }]
      : [],
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
        failureClass: executionError ? classification?.failureClass : execution?.passed ? undefined : "product_bug"
      }
    }],
    evidence: [evidence],
    loopEvents: [],
    oracles: [{
      id: input.coverageItem.oracleIds[0] ?? `${input.coverageItem.flowId}:oracle`,
      pathId: input.coverageItem.flowId,
      assertionName: input.coverageItem.oracleIds[0] ?? `${input.coverageItem.flowId}:oracle`,
      expectedFrom: "requirement",
      preconditions: input.coverageItem.preconditions,
      action: JSON.stringify(action),
      postconditions: ["A committed operation artifact and deterministic assertion exist."],
      requiresHumanConfirmation: false,
      evidenceRefs: [evidence.id]
    }],
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
  await persistExecutionResult(input.runId, result);
  return result;
}
