import type { CommitCheckResult } from "./types.js";
import { normalizeLegacyGateStatus } from "@ai-test-officer/contracts";

export type CiExitCode = 0 | 1 | 2 | 3 | 4;
export type CiGateReport = ReturnType<typeof buildCiGateReport> | ReturnType<typeof buildCiErrorGateReport>;
export type CiFlakyMode = "warn" | "fail";

export interface CiGatePolicy {
  strictGate?: boolean;
  quarantinedScenarios?: string[];
  flakyMode?: CiFlakyMode;
}

function normalizePolicy(policy: CiGatePolicy | boolean = {}) {
  const normalized = typeof policy === "boolean" ? { strictGate: policy } : policy;
  return {
    strictGate: normalized.strictGate ?? false,
    quarantinedScenarios: normalized.quarantinedScenarios ?? [],
    flakyMode: normalized.flakyMode ?? "warn" as CiFlakyMode
  };
}

export function ciExitMeaning(exitCode: CiExitCode) {
  return {
    0: "pass",
    1: "release_gate_failed",
    2: "harness_gap_or_insufficient_coverage",
    3: "runtime_unavailable",
    4: "unexpected_cli_error"
  }[exitCode];
}

export function computeCiGateDecision(check: CommitCheckResult, policy: CiGatePolicy | boolean = {}) {
  const normalized = normalizePolicy(policy);
  const reasons: string[] = [];
  const selectedScenarioId = check.selectedScenarioId;
  const quarantined = Boolean(selectedScenarioId && normalized.quarantinedScenarios.includes(selectedScenarioId));
  const flaky = Boolean(check.run?.aggregatedVerdict.flaky);
  const gateStatus = check.run?.gateStatus ?? normalizeLegacyGateStatus(check.run?.judgeReport.releaseJudge.verdict ?? "needs_review");
  if (check.run?.runtimeStatus?.status === "failed") {
    reasons.push("runtime_unavailable");
    return { exitCode: 3 as CiExitCode, exitMeaning: ciExitMeaning(3), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (!check.run || check.skippedReason) {
    reasons.push("skipped_or_no_run");
    return { exitCode: 2 as CiExitCode, exitMeaning: ciExitMeaning(2), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (check.harnessGaps?.some((gap) => gap.status === "open")) {
    reasons.push("open_harness_gap");
    return { exitCode: 2 as CiExitCode, exitMeaning: ciExitMeaning(2), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  const verdict = check.run.judgeReport.releaseJudge.verdict;
  if (quarantined && verdict !== "pass") {
    reasons.push(`quarantined_scenario:${selectedScenarioId}`);
    return { exitCode: 2 as CiExitCode, exitMeaning: ciExitMeaning(2), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (flaky) {
    reasons.push(normalized.flakyMode === "fail" ? "flaky_fail" : "flaky_warn");
    const exitCode = normalized.flakyMode === "fail" ? 1 : 2;
    return { exitCode: exitCode as CiExitCode, exitMeaning: ciExitMeaning(exitCode as CiExitCode), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (gateStatus === "blocked") {
    reasons.push("machine_gate_blocked");
    return { exitCode: 3 as CiExitCode, exitMeaning: ciExitMeaning(3), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (gateStatus === "needs-human-review") {
    reasons.push("machine_gate_needs_human_review");
    const exitCode = normalized.strictGate ? 1 : 2;
    return { exitCode: exitCode as CiExitCode, exitMeaning: ciExitMeaning(exitCode as CiExitCode), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (gateStatus === "fail") {
    reasons.push("machine_gate_fail");
    return { exitCode: 1 as CiExitCode, exitMeaning: ciExitMeaning(1), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (verdict === "pass") {
    reasons.push("release_pass");
    return { exitCode: 0 as CiExitCode, exitMeaning: ciExitMeaning(0), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (verdict === "fail") {
    reasons.push("release_fail");
    return { exitCode: 1 as CiExitCode, exitMeaning: ciExitMeaning(1), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  if (normalized.strictGate && verdict === "needs_review") {
    reasons.push("needs_review_strict");
    return { exitCode: 1 as CiExitCode, exitMeaning: ciExitMeaning(1), policy: normalized, policyReasons: reasons, quarantined, flaky };
  }
  reasons.push("needs_review_harness");
  return { exitCode: 2 as CiExitCode, exitMeaning: ciExitMeaning(2), policy: normalized, policyReasons: reasons, quarantined, flaky };
}

export function computeCiExitCode(check: CommitCheckResult, policy: CiGatePolicy | boolean = {}): CiExitCode {
  return computeCiGateDecision(check, policy).exitCode;
}

export function buildCiGateReport(check: CommitCheckResult, policy: CiGatePolicy | boolean) {
  const decision = computeCiGateDecision(check, policy);
  return {
    schemaVersion: 1,
    id: check.id,
    runId: check.run?.id,
    commitSha: process.env.GITHUB_SHA ?? "local",
    projectId: check.run?.runtimeStatus?.projectId,
    selectedScenarioId: check.selectedScenarioId,
    scenarioVersion: check.executablePlan?.id ?? "unavailable",
    judgePolicyVersion: check.run?.judgeReport.policyVersion ?? "unavailable",
    executionMode: check.run?.judgeReport.executionMode ?? "not_available",
    llmStatus: check.run?.judgeReport.llmStatus ?? "not_available",
    fallbackUsed: check.run?.judgeReport.executionMode === "fallback_baseline",
    autoRepairCount: check.run?.repairAttempts?.length ?? 0,
    planSource: check.planSource,
    executablePlanId: check.executablePlan?.id,
    verdict: check.run?.verdict ?? "skipped",
    releaseJudge: check.run?.judgeReport.releaseJudge.verdict ?? "not_available",
    failureAttributions: check.run?.failureAttributions ?? [],
    skippedReason: check.skippedReason,
    harnessGapCount: check.harnessGaps?.filter((gap) => gap.status === "open").length ?? 0,
    readableReport: check.run?.htmlReportFile ?? check.run?.markdownReportFile,
    runBundle: check.run?.runBundleFile,
    commitCheckFile: check.commitCheckFile,
    strictGate: decision.policy.strictGate,
    gatePolicy: decision.policy,
    policyReasons: decision.policyReasons,
    quarantined: decision.quarantined,
    flaky: decision.flaky,
    exitCode: decision.exitCode,
    exitMeaning: decision.exitMeaning
  };
}

export function buildCiErrorGateReport(input: {
  id?: string;
  strictGate?: boolean;
  gatePolicy?: CiGatePolicy;
  exitCode: Extract<CiExitCode, 3 | 4>;
  errorMessage: string;
}) {
  const policy = normalizePolicy(input.gatePolicy ?? { strictGate: input.strictGate });
  return {
    schemaVersion: 1,
    id: input.id ?? `commit_check_error_${Date.now()}`,
    commitSha: process.env.GITHUB_SHA ?? "local",
    projectId: undefined,
    scenarioVersion: "not_available",
    judgePolicyVersion: "not_available",
    executionMode: "not_available",
    llmStatus: "not_available",
    fallbackUsed: false,
    autoRepairCount: 0,
    runId: undefined,
    selectedScenarioId: undefined,
    planSource: "not_available",
    executablePlanId: undefined,
    verdict: "error",
    releaseJudge: "not_available",
    failureAttributions: [],
    skippedReason: input.errorMessage,
    harnessGapCount: 0,
    readableReport: undefined,
    runBundle: undefined,
    commitCheckFile: undefined,
    strictGate: policy.strictGate,
    gatePolicy: policy,
    policyReasons: [ciExitMeaning(input.exitCode)],
    quarantined: false,
    flaky: false,
    exitCode: input.exitCode,
    exitMeaning: ciExitMeaning(input.exitCode),
    error: {
      message: input.errorMessage
    }
  };
}

export function buildCiAnnotationMarkdown(gate: Pick<CiGateReport, "verdict" | "releaseJudge" | "selectedScenarioId" | "exitCode" | "exitMeaning" | "readableReport" | "runBundle" | "skippedReason"> & {
  policyReasons?: string[];
  quarantined?: boolean;
  flaky?: boolean;
  runBundleZip?: string;
  downloadManifest?: string;
}) {
  return [
    "# AI Test Officer Gate",
    "",
    `- verdict: ${gate.verdict}`,
    `- releaseJudge: ${gate.releaseJudge}`,
    `- scenario: ${gate.selectedScenarioId ?? "not selected"}`,
    "commitSha" in gate && gate.commitSha ? `- commit: ${gate.commitSha}` : undefined,
    "projectId" in gate && gate.projectId ? `- project: ${gate.projectId}` : undefined,
    "judgePolicyVersion" in gate && gate.judgePolicyVersion ? `- judgePolicy: ${gate.judgePolicyVersion}` : undefined,
    "executionMode" in gate && gate.executionMode ? `- executionMode: ${gate.executionMode}` : undefined,
    "fallbackUsed" in gate ? `- fallback: ${String(gate.fallbackUsed)}` : undefined,
    `- exitCode: ${gate.exitCode} (${gate.exitMeaning})`,
    gate.policyReasons?.length ? `- policyReasons: ${gate.policyReasons.join(", ")}` : undefined,
    gate.quarantined ? "- quarantine: true" : undefined,
    gate.flaky ? "- flaky: true" : undefined,
    gate.readableReport ? `- report: ${gate.readableReport}` : undefined,
    gate.runBundle ? `- run bundle: ${gate.runBundle}` : undefined,
    gate.runBundleZip ? `- download bundle: ${gate.runBundleZip}` : undefined,
    gate.downloadManifest ? `- download manifest: ${gate.downloadManifest}` : undefined,
    gate.skippedReason ? `- skipped: ${gate.skippedReason}` : undefined
  ].filter(Boolean).join("\n");
}

export function buildCiPrAnnotations(gate: Pick<CiGateReport, "exitCode" | "exitMeaning" | "releaseJudge">) {
  return [{
    path: "AI_TEST_OFFICER",
    start_line: 1,
    end_line: 1,
    annotation_level: gate.exitCode === 0 ? "notice" : gate.exitCode === 1 || gate.exitCode === 3 || gate.exitCode === 4 ? "failure" : "warning",
    message: `${gate.exitMeaning}: ${gate.releaseJudge}`,
    title: "AI Test Officer"
  }];
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildCiJUnitReport(gate: CiGateReport) {
  const failures = gate.exitCode === 1 ? 1 : 0;
  const errors = gate.exitCode === 3 || gate.exitCode === 4 ? 1 : 0;
  const skipped = gate.exitCode === 2 ? 1 : 0;
  const scenario = gate.selectedScenarioId ?? "not_selected";
  const diagnostic = JSON.stringify({
    id: gate.id,
    runId: gate.runId,
    verdict: gate.verdict,
    releaseJudge: gate.releaseJudge,
    exitCode: gate.exitCode,
    exitMeaning: gate.exitMeaning,
    skippedReason: gate.skippedReason,
    harnessGapCount: gate.harnessGapCount,
    policyReasons: gate.policyReasons,
    quarantined: gate.quarantined,
    flaky: gate.flaky
  }, null, 2);
  const issueBody = escapeXml(gate.skippedReason ?? gate.exitMeaning);
  const issueMessage = escapeXml(gate.exitMeaning);
  const statusElement =
    failures ? `\n      <failure message="${issueMessage}">${issueBody}</failure>` :
    errors ? `\n      <error message="${issueMessage}">${issueBody}</error>` :
    skipped ? `\n      <skipped message="${issueMessage}">${issueBody}</skipped>` :
    "";
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    `<testsuite name="AI Test Officer Gate" tests="1" failures="${failures}" errors="${errors}" skipped="${skipped}">`,
    `  <testcase classname="ai-test-officer" name="gate:${escapeXml(scenario)}">${statusElement}`,
    `    <system-out>${escapeXml(diagnostic)}</system-out>`,
    "  </testcase>",
    "</testsuite>"
  ].join("\n");
}

export function buildCiUploadManifest(files: Array<string | undefined>) {
  return {
    schemaVersion: 1,
    files: Array.from(new Set([
      "reports/gate.json",
      "reports/junit.xml",
      "reports/pr-annotation.md",
      "reports/pr-annotations.json",
      "reports/artifact-upload-manifest.json",
      ...files.filter((file): file is string => Boolean(file))
    ]))
  };
}
