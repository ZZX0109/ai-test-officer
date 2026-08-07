import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AttemptClock,
  commitCapturedFile
} from "@ai-test-officer/playwright-runtime";
import {
  resolveFinalStatus,
  runOutcomeSummaryV2Schema,
  type CoverageItem,
  type JudgeRecommendation,
  type MachineGate
} from "@ai-test-officer/contracts";
import { appendEvidence, writeRunBundle } from "./evidenceStore.js";
import { persistExecutionResult } from "./executionPersistence.js";
import { buildProofGraph, writeProofArtifacts } from "./proofGraph.js";
import {
  finalizeProofBundle,
  proofCredibility,
  type MachineGateDraft
} from "./proof/proofBundleService.js";
import { assertVerifiedMachineGate } from "./proof/proofBundleIntegrity.js";
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
  const verdict = status === "pass" ? "pass" : status === "fail" ? "fail" : "needs_review";
  return {
    layer,
    title: `${layer} aggregate judge`,
    verdict,
    summary,
    findings: status === "pass" ? [] : [{
      id: `aggregate_${layer}_${status}`,
      severity: status === "fail" ? "high" : "medium",
      failureClass: status === "blocked" ? "environment_issue" : status === "fail" ? "product_bug" : "insufficient_evidence",
      title: summary,
      reasoning: "Parent verdict is derived only from terminal path runs and their verified evidence manifests.",
      evidenceRefs: [evidenceId]
    }]
  };
}

function judgeReport(status: MachineGate["status"], evidenceId: string, summary: string): LayeredJudgeReport {
  return {
    source: "deterministic_judge",
    executionMode: "deterministic",
    llmStatus: "not_configured",
    policyVersion: "parent-aggregate-policy-v1",
    createdAt: new Date().toISOString(),
    planJudge: judgeLayer("plan", status, evidenceId, summary),
    evidenceJudge: judgeLayer("evidence", status, evidenceId, summary),
    releaseJudge: judgeLayer("release", status, evidenceId, summary)
  };
}

export async function persistParentAggregateEvidence(input: {
  runId: string;
  projectId?: string;
  requirement?: string;
  coverage: CoverageItem[];
  children: Array<{
    id: string;
    state: string;
    finalStatus?: string;
    evidenceSetRoot?: string;
    artifactIntegrityVerified: boolean;
    evidenceGrounded: boolean;
    /** The child's own verified gate — required so the parent can prove each
     * child was itself minted by the Proof Bundle Service (proofBundleId
     * present), not self-asserted. */
    machineGate?: MachineGate;
  }>;
  /** The aggregate draft (status + reasons). Credibility flags are never
   * supplied here; the parent mints them via `finalizeProofBundle`. */
  machineGateDraft: MachineGateDraft;
  gateEligibleFacts: { executionSucceeded: boolean; requirementCovered: boolean };
  judgeRecommendation: JudgeRecommendation;
}) {
  const now = new Date().toISOString();
  const scenarioId = "parent-coverage-aggregate";
  const attemptId = `${input.runId}_aggregate_attempt_1`;
  const stepId = "aggregate-child-results";
  const directory = path.join(reportsDir, "runs", input.runId);
  await mkdir(directory, { recursive: true });
  const finalPath = path.join(directory, "parent-aggregate.json");
  const temporaryPath = `${finalPath}.partial`;
  await writeFile(temporaryPath, JSON.stringify({
    runId: input.runId,
    coverage: input.coverage.map((item) => ({
      id: item.id,
      flowId: item.flowId,
      disposition: item.disposition,
      childRunId: item.childRunId
    })),
    children: input.children,
    machineGate: input.machineGateDraft
  }, null, 2));
  const clock = new AttemptClock();
  const artifact = await commitCapturedFile({
    temporaryPath,
    finalPath,
    id: `${input.runId}_parent_aggregate`,
    identity: { runId: input.runId, scenarioId, attemptId, attempt: 1 },
    stepId,
    kind: "operation-log",
    mediaType: "application/json",
    storageUri: `/artifacts/runs/${input.runId}/parent-aggregate.json`,
    clock,
    collectorVersion: "0.2.0"
  });
  const evidence = await appendEvidence(input.runId, {
    type: "operation",
    title: "Parent coverage and child-run aggregation",
    scenarioId,
    attemptId,
    attempt: 1,
    sequence: artifact.sequence + 1,
    stepId,
    file: artifact.storageUri,
    artifactIds: [artifact.id],
    payload: {
      childRunIds: input.children.map((item) => item.id),
      childEvidenceRoots: input.children.map((item) => item.evidenceSetRoot).filter(Boolean),
      coverageDispositionComplete: input.coverage.every((item) => item.disposition !== "pending")
    }
  });
  const judgeRecommendation: JudgeRecommendation = {
    ...input.judgeRecommendation,
    evidenceRefs: [evidence.id]
  };
  // Prove every child run was itself minted by the Proof Bundle Service
  // (carries a proofBundleId), so the parent aggregate cannot launder an
  // unverified child gate into a pass. Unverified children downgrade the
  // aggregate to needs-human-review via an explicit reason.
  const unverifiedChildren = input.children
    .map((child) => child.machineGate)
    .filter((gate): gate is MachineGate => Boolean(gate))
    .filter((gate) => {
      try {
        assertVerifiedMachineGate(gate);
        return false;
      } catch {
        return true;
      }
    });
  const draft: MachineGateDraft = {
    status: input.machineGateDraft.status,
    reasons: [
      ...input.machineGateDraft.reasons,
      ...(unverifiedChildren.length ? [`child_gate_unverified:${unverifiedChildren.length}`] : [])
    ],
    reasonDetails: input.machineGateDraft.reasonDetails ?? [],
    assertionFailures: input.machineGateDraft.assertionFailures ?? []
  };
  // The parent re-mints its own verified gate from its own evidence + artifacts
  // (the aggregate operation-log + the child evidence-set roots it references).
  // Credibility flags are computed here, never copied from a child gate.
  const finalized = finalizeProofBundle({
    draft,
    runId: input.runId,
    scenarioId,
    attemptId,
    evidence: [evidence],
    artifactsV2: [artifact],
    gateEligibleFacts: input.gateEligibleFacts
  });
  const machineGate = finalized.machineGate;
  const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
  const covered = input.coverage.length > 0 && input.coverage.every((item) => item.disposition !== "pending");
  const requirementPassed = machineGate.status === "pass";
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: input.gateEligibleFacts.executionSucceeded,
    requirementCovered: covered,
    requirementPassed,
    ...proofCredibility(finalized.verdict, machineGate, finalized.gateEligible),
    machineGate,
    judgeRecommendation,
    finalStatus
  });
  const summary = `Aggregated ${input.children.length} child runs across ${input.coverage.length} coverage items.`;
  const result: VisualRunResult = {
    id: input.runId,
    startedAt: now,
    finishedAt: now,
    verdict: finalStatus === "pass" ? "continue" : finalStatus === "fail" ? "stop_and_fix" : "hold_for_review",
    summary,
    steps: [{
      stepId,
      title: "Aggregate path child runs",
      status: finalStatus === "pass" ? "passed" : finalStatus === "fail" ? "failed" : "warning",
      action: "aggregate_path_runs",
      details: summary
    }],
    network: [],
    console: [],
    assertions: [{
      name: "All required coverage paths have terminal, evidence-backed results",
      passed: requirementPassed,
      expected: "Every required coverage item has a terminal child run and verified evidence.",
      actual: `${input.coverage.filter((item) => item.disposition !== "pending").length}/${input.coverage.length} dispositions; gate=${machineGate.status}`,
      fact: {
        kind: "state.equals",
        target: "parent_coverage_gate",
        operator: "equals",
        expected: "pass",
        actual: machineGate.status,
        severity: "high",
        evidenceRefs: [evidence.id],
        failureClass: machineGate.status === "pass"
          ? undefined
          : machineGate.status === "blocked"
            ? "environment_issue"
            : machineGate.status === "fail"
              ? "product_bug"
              : "insufficient_evidence"
      }
    }],
    evidence: [evidence],
    loopEvents: [],
    oracles: [{
      id: "parent-coverage-terminal-oracle",
      pathId: stepId,
      assertionName: "All required coverage paths have terminal, evidence-backed results",
      expectedFrom: "requirement",
      preconditions: ["All child runs reached a terminal state."],
      action: "Aggregate child finalStatus and signed evidence roots.",
      postconditions: ["No coverage item remains pending."],
      requiresHumanConfirmation: false,
      evidenceRefs: [evidence.id]
    }],
    riskCoverageMatrix: [{
      riskId: "parent_coverage_completeness",
      riskTitle: "Parent coverage completeness",
      covered,
      passed: requirementPassed,
      pathIds: [stepId],
      evidenceRefs: [evidence.id],
      notes: summary
    }],
    aggregatedVerdict: {
      runCount: input.children.length,
      failedAssertionCount: requirementPassed ? 0 : 1,
      flaky: false,
      verdict: finalStatus === "pass" ? "continue" : finalStatus === "fail" ? "stop_and_fix" : "hold_for_review",
      reason: summary
    },
    reflectionNote: "Parent result is immutable and does not replace any child result.",
    conflictPacket: {
      status: "not_triggered",
      reason: "Parent aggregate uses deterministic child results.",
      evidenceRefs: [evidence.id]
    },
    failureAttributions: [],
    attempts: [{
      id: attemptId,
      runId: input.runId,
      scenarioId,
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      status: finalStatus === "pass" ? "passed" : "failed",
      artifactIds: [artifact.id]
    }],
    artifactsV2: [artifact],
    gateStatus: finalStatus,
    machineGate,
    judgeRecommendation,
    finalStatus,
    outcomeSummary,
    judgeReport: judgeReport(machineGate.status, evidence.id, summary),
    judgeRouting: {
      route: "deterministic",
      reason: "parent aggregation never requires semantic inference",
      signals: ["child-final-status", "coverage-disposition", "evidence-manifest"]
    },
    reportFile: `/artifacts/runs/${input.runId}/parent-aggregate.json`,
    runBundleFile: `/artifacts/runs/${input.runId}/run_bundle.json`,
    coverageItems: input.coverage
  };
  const proof = buildProofGraph(result);
  result.conclusions = proof.conclusions;
  result.proofNodes = proof.proofNodes;
  result.proofEdges = proof.proofEdges;
  const bundle: RunBundle = {
    runId: input.runId,
    startedAt: now,
    finishedAt: now,
    input: {
      runId: input.runId,
      projectId: input.projectId,
      requirement: input.requirement,
      scenarioId,
      permissionProfile: {
        observe: true,
        browserControl: false,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    },
    result: { ...result, evidence: undefined, loopEvents: undefined, oracles: undefined, riskCoverageMatrix: undefined } as RunBundle["result"],
    evidence: result.evidence,
    artifactsV2: result.artifactsV2,
    attempts: result.attempts,
    loopEvents: result.loopEvents,
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix,
    conflictPacket: result.conflictPacket,
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
  await persistExecutionResult(input.runId, result, { verdict: finalized.verdict, gateEligible: finalized.gateEligible });
  return { result, bundle, manifest };
}
