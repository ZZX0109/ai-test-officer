import { computeCiExitCode } from "../src/ciContract.js";
import type { CommitCheckResult } from "../src/types.js";

function check(overrides: Partial<CommitCheckResult>): CommitCheckResult {
  return {
    id: "ci_shell_probe",
    createdAt: new Date().toISOString(),
    context: { requirement: "", diff: "", bugTicket: "", sourceContexts: [], sources: [] },
    analysis: {
      id: "analysis",
      createdAt: new Date().toISOString(),
      sources: [],
      changedAreas: [],
      risks: [],
      scenarioCandidates: [],
      recommendedTrigger: "commit"
    },
    plan: { sessionName: "probe", risks: [], levels: [] },
    planSource: "probe",
    ...overrides
  };
}

function run(releaseJudge: "pass" | "needs_review" | "fail", runtimeFailed = false) {
  return {
    id: "run",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    verdict: releaseJudge === "pass" ? "continue" as const : "hold_for_review" as const,
    summary: "probe",
    steps: [],
    network: [],
    console: [],
    assertions: [],
    evidence: [],
    loopEvents: [],
    oracles: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue" as const, reason: "probe" },
    reflectionNote: "probe",
    conflictPacket: { status: "not_triggered" as const, reason: "probe", evidenceRefs: [] },
    failureAttributions: [],
    runtimeStatus: runtimeFailed ? { projectId: "p", status: "failed" as const, message: "runtime failed" } : undefined,
    judgeReport: {
      source: "deterministic_judge" as const,
      executionMode: "deterministic" as const,
      llmStatus: "not_configured" as const,
      policyVersion: "probe",
      createdAt: new Date().toISOString(),
      planJudge: { layer: "plan" as const, title: "plan", verdict: "pass" as const, summary: "pass", findings: [] },
      evidenceJudge: { layer: "evidence" as const, title: "evidence", verdict: "pass" as const, summary: "pass", findings: [] },
      releaseJudge: { layer: "release" as const, title: "release", verdict: releaseJudge, summary: releaseJudge, findings: [] }
    },
    reportFile: "/artifacts/runs/run/report.json",
    runBundleFile: "/artifacts/runs/run/run_bundle.json"
  };
}

const probeCase = process.argv[2];
try {
  if (probeCase === "unexpected") throw new Error("unexpected_cli_error_probe");
  const exitCode = {
    pass: () => computeCiExitCode(check({ run: run("pass") })),
    fail: () => computeCiExitCode(check({ run: run("fail") })),
    strict_review: () => computeCiExitCode(check({ run: run("needs_review") }), { strictGate: true }),
    harness: () => computeCiExitCode(check({ skippedReason: "missing harness" })),
    runtime: () => computeCiExitCode(check({ run: run("pass", true) }))
  }[probeCase ?? ""];
  if (!exitCode) throw new Error(`unknown_probe_case:${probeCase}`);
  process.exitCode = exitCode();
} catch {
  process.exitCode = 4;
}
