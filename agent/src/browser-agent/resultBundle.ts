import type {
  ArtifactV2,
  CoverageItem,
  MachineGate,
  RunOutcomeSummaryV2
} from "@ai-test-officer/contracts";
import { writeRunBundle } from "../evidenceStore.js";
import { persistExecutionResult } from "../executionPersistence.js";
import { buildProofGraph, writeProofArtifacts } from "../proofGraph.js";
import { proofPersistence, type FinalizeProofBundleResult } from "../proof/proofBundleService.js";
import type {
  ArtifactIntegrityReport,
  AssertionResult,
  EvidenceItem,
  LayeredJudgeReport,
  RunBundle,
  RunRequest,
  VisualRunResult
} from "../types.js";
import type { BrowserActionDecision, BrowserActionResult } from "@ai-test-officer/contracts";

function deterministicJudge(input: {
  status: MachineGate["status"];
  summary: string;
  evidenceRefs: string[];
}): LayeredJudgeReport {
  const verdict: "pass" | "fail" | "needs_review" = input.status === "pass" ? "pass" : input.status === "fail" ? "fail" : "needs_review";
  const finding = input.status === "pass" ? [] : [{
    id: "dynamic-browser-machine-gate",
    severity: "high" as const,
    title: "动态浏览器路径未满足机器门禁",
    reasoning: input.summary,
    evidenceRefs: input.evidenceRefs
  }];
  const layer = (name: "plan" | "evidence" | "release") => ({
    layer: name,
    title: name === "plan" ? "动态计划检查" : name === "evidence" ? "动态证据检查" : "发布检查",
    verdict,
    summary: input.summary,
    findings: finding
  });
  return {
    source: "deterministic_judge",
    executionMode: "deterministic",
    llmStatus: "not_configured",
    policyVersion: "dynamic-browser-proof-v1",
    createdAt: new Date().toISOString(),
    planJudge: layer("plan"),
    evidenceJudge: layer("evidence"),
    releaseJudge: layer("release")
  };
}

function inputRequest(input: {
  runId: string;
  projectId?: string;
  requirement?: string;
  appUrl?: string;
  raw: Record<string, unknown>;
}): RunRequest {
  const permissionProfile = input.raw.permissionProfile && typeof input.raw.permissionProfile === "object"
    ? input.raw.permissionProfile as RunRequest["permissionProfile"]
    : {
      observe: true,
      browserControl: true,
      sourceRead: true,
      sandboxWrite: false,
      sandboxCommand: false,
      networkInstall: false,
      hostApply: false,
      artifactExport: false,
      systemControl: false,
      workspaceControl: false,
      ideTerminalControl: false
    };
  return {
    runId: input.runId,
    projectId: input.projectId,
    appUrl: input.appUrl,
    requirement: input.requirement,
    executionProfile: input.raw.executionProfile === "benchmark" ? "benchmark" : "interactive",
    permissionProfile
  };
}

export async function persistDynamicBrowserResult(input: {
  runId: string;
  projectId?: string;
  requirement?: string;
  appUrl?: string;
  rawRunInput: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
  scenarioId: string;
  attemptId: string;
  coverage: CoverageItem[];
  decisions: BrowserActionDecision[];
  actionResults: BrowserActionResult[];
  evidence: EvidenceItem[];
  artifacts: ArtifactV2[];
  artifactIntegrity: ArtifactIntegrityReport;
  machineGate: MachineGate;
  outcomeSummary: RunOutcomeSummaryV2;
  proof: Pick<FinalizeProofBundleResult, "verdict" | "gateEligible">;
}) {
  const oracleById = new Map(input.decisions.flatMap((decision) => decision.oracles).map((oracle) => [oracle.id, oracle]));
  const assertionRows = input.actionResults.flatMap((result) => result.oracleResults.map((oracle) => ({ result, oracle })));
  const assertions: AssertionResult[] = assertionRows.map(({ oracle }) => ({
    name: `Dynamic oracle ${oracle.oracleId}`,
    passed: oracle.passed,
    expected: oracleById.get(oracle.oracleId)?.description ?? "Declared deterministic browser outcome",
    actual: oracle.actual,
    fact: {
      kind: "state.equals" as const,
      target: oracle.oracleId,
      operator: "equals" as const,
      expected: oracleById.get(oracle.oracleId)?.description ?? "oracle passes",
      actual: oracle.actual,
      severity: "high" as const,
      evidenceRefs: oracle.evidenceRefs,
      failureClass: oracle.passed ? undefined : "product_bug" as const
    }
  }));
  if (assertions.length === 0) {
    const refs = input.machineGate.reasonDetails.flatMap((reason) => reason.evidenceRefs);
    assertions.push({
      name: "Dynamic browser execution",
      passed: false,
      expected: "At least one deterministic oracle is evaluated",
      actual: "No deterministic oracle result was persisted",
      fact: {
        kind: "environment.error",
        target: "browser-agent",
        operator: "not_present",
        expected: "oracle result",
        actual: "missing",
        severity: "high",
        evidenceRefs: refs,
        failureClass: "insufficient_evidence"
      }
    });
  }
  const evidenceRefs = Array.from(new Set([
    ...input.machineGate.reasonDetails.flatMap((reason) => reason.evidenceRefs),
    ...assertions.flatMap((assertion) => assertion.fact?.evidenceRefs ?? [])
  ]));
  const summary = input.machineGate.status === "pass"
    ? `已执行 ${input.coverage.length} 条动态浏览器路径，确定性 Oracle 与证据校验通过。`
    : `动态浏览器测试结束，机器门禁为 ${input.machineGate.status}：${input.machineGate.reasons.join("；") || "证据或覆盖不完整"}`;
  const judgeReport = deterministicJudge({ status: input.machineGate.status, summary, evidenceRefs });
  const result: VisualRunResult = {
    id: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    verdict: input.machineGate.status === "pass" ? "continue" : input.machineGate.status === "fail" ? "stop_and_fix" : "hold_for_review",
    summary,
    steps: input.actionResults.map((item) => ({
      stepId: item.actionId,
      title: item.summary,
      status: item.status === "completed" && item.oracleResults.every((oracle) => oracle.passed) ? "passed" : "failed",
      action: input.decisions.flatMap((decision) => decision.actions).find((action) => action.actionId === item.actionId)?.action ?? "dynamic-browser-action",
      details: item.errorCode ? `${item.errorCode}: ${item.summary}` : item.summary
    })),
    network: [],
    console: [],
    assertions,
    evidence: input.evidence,
    loopEvents: [],
    oracles: [...oracleById.values()].map((oracle) => ({
      id: oracle.id,
      pathId: input.actionResults.find((result) => result.oracleResults.some((item) => item.oracleId === oracle.id))?.coverageItemId ?? input.coverage[0]?.id ?? "dynamic-browser",
      assertionName: `Dynamic oracle ${oracle.id}`,
      expectedFrom: "llm_inferred",
      preconditions: ["The bound browser observation is current and the control belongs to this attempt."],
      action: oracle.type,
      postconditions: [oracle.description],
      requiresHumanConfirmation: false,
      evidenceRefs: assertionRows.filter((item) => item.oracle.oracleId === oracle.id).flatMap((item) => item.oracle.evidenceRefs)
    })),
    riskCoverageMatrix: input.coverage.map((item) => {
      const pathResults = input.actionResults.filter((result) => result.coverageItemId === item.id);
      return {
        riskId: item.flowId,
        riskTitle: item.module,
        covered: item.disposition === "executed",
        passed: item.disposition === "executed" && pathResults.length > 0 && pathResults.every((result) => result.status === "completed" && result.oracleResults.length > 0 && result.oracleResults.every((oracle) => oracle.passed)),
        pathIds: [item.id],
        evidenceRefs: pathResults.flatMap((result) => result.evidenceRefs),
        notes: item.dispositionReason ?? item.disposition
      };
    }),
    aggregatedVerdict: {
      runCount: 1,
      failedAssertionCount: assertions.filter((assertion) => !assertion.passed).length,
      flaky: false,
      verdict: input.machineGate.status === "pass" ? "continue" : input.machineGate.status === "fail" ? "stop_and_fix" : "needs_review",
      reason: summary
    },
    reflectionNote: "LLM chose bounded semantic actions; deterministic executors, oracles and proof validation produced the result.",
    conflictPacket: { status: "not_triggered", reason: "No unresolved deterministic/LLM conclusion conflict.", evidenceRefs: [] },
    failureAttributions: [],
    attempts: [{
      id: input.attemptId,
      runId: input.runId,
      scenarioId: input.scenarioId,
      attempt: 1,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: input.machineGate.status === "pass" ? "passed" : input.machineGate.status === "fail" ? "failed" : "blocked",
      artifactIds: input.artifacts.map((artifact) => artifact.id)
    }],
    artifactsV2: input.artifacts,
    gateStatus: input.machineGate.status,
    machineGate: input.machineGate,
    finalStatus: input.machineGate.status,
    outcomeSummary: input.outcomeSummary,
    judgeReport,
    judgeRouting: { route: "deterministic", reason: "Dynamic actions are advisory; deterministic proof controls the verdict.", signals: ["browser-agent"] },
    reportFile: `/artifacts/runs/${input.runId}/run_bundle.json`,
    runBundleFile: `/artifacts/runs/${input.runId}/run_bundle.json`,
    artifactIntegrity: input.artifactIntegrity,
    coverageItems: input.coverage
  };
  const proof = buildProofGraph(result);
  result.conclusions = proof.conclusions;
  result.proofNodes = proof.proofNodes;
  result.proofEdges = proof.proofEdges;
  const bundle: RunBundle = {
    runId: input.runId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    input: inputRequest({ runId: input.runId, projectId: input.projectId, requirement: input.requirement, appUrl: input.appUrl, raw: input.rawRunInput }),
    result: { ...result, evidence: undefined, loopEvents: undefined, oracles: undefined, riskCoverageMatrix: undefined } as RunBundle["result"],
    evidence: input.evidence,
    artifactsV2: input.artifacts,
    attempts: result.attempts,
    loopEvents: result.loopEvents,
    oracles: result.oracles,
    riskCoverageMatrix: result.riskCoverageMatrix,
    conflictPacket: result.conflictPacket,
    failureAttributions: [],
    artifactIntegrity: input.artifactIntegrity,
    coverageItems: input.coverage,
    conclusions: result.conclusions,
    proofNodes: result.proofNodes,
    proofEdges: result.proofEdges,
    judgeReport
  };
  const manifest = await writeProofArtifacts(bundle);
  result.evidenceManifest = manifest;
  bundle.evidenceManifest = manifest;
  bundle.result.evidenceManifest = manifest;
  await writeRunBundle(bundle);
  await persistExecutionResult(input.runId, result, proofPersistence(input.proof));
  return result;
}
