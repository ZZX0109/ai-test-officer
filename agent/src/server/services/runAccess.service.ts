import path from "node:path";
import type { Request } from "express";
import { finalizeProofBundle, proofCredibility } from "../../proof/proofBundleService.js";
import { readRunBundle } from "../../evidenceStore.js";
import { authContext, isOrganizationAuthorized } from "../../security.js";
import { hasProjectScope, projectAccessDecision } from "../../projectAccess.js";
import { runEventStore } from "../../runEventStore.js";

export type ProjectScope = Parameters<typeof hasProjectScope>[0]["scope"];

export function createRunAccessService(reportsDir: string) {
  function assertOrganizationAccess(req: Request, organizationId: unknown) {
    const context = authContext(req);
    if (!isOrganizationAuthorized(context, organizationId)) throw new Error("organization_forbidden");
  }

  async function assertProjectAccess(req: Request, projectId: unknown, scope: ProjectScope) {
    if (!projectId) return;
    const context = authContext(req);
    if (!context) throw new Error("project_not_found_or_forbidden");
    if (context.subject === "local-dev" || context.roles.includes("admin")) return;
    const decision = await projectAccessDecision({ projectId: String(projectId), subject: context.subject, scope });
    if (!decision.member) throw new Error("project_not_found_or_forbidden");
    if (!decision.allowed) throw new Error("project_scope_forbidden");
  }

  function artifactUrl(filePath: string) {
    return `/artifacts/${path.relative(reportsDir, filePath).split(path.sep).join("/")}`;
  }

  function runBundleProjectId(bundle: Awaited<ReturnType<typeof readRunBundle>>) {
    return bundle.input?.projectId ?? bundle.project?.id;
  }

  async function readAuthorizedLegacyRun(req: Request, runId: string, scope: ProjectScope = "read_artifacts") {
    const bundle = await readRunBundle(runId);
    const projectId = runBundleProjectId(bundle);
    const context = authContext(req);
    if (!projectId && context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
      throw new Error("project_not_found_or_forbidden");
    }
    await assertProjectAccess(req, projectId, scope);
    return bundle;
  }

  async function assertAuthorizedRun(req: Request, runId: string, scope: ProjectScope = "read_artifacts") {
    const run = await runEventStore.get(runId);
    if (run) {
      assertOrganizationAccess(req, run.input.organizationId);
      await assertProjectAccess(req, run.input.projectId, scope);
      return;
    }
    await readAuthorizedLegacyRun(req, runId, scope);
  }

  function isMissingRunBundle(error: unknown) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
  }

  function releaseRecommendation(input: { executionStatus?: string; finalStatus?: string }) {
    if (input.executionStatus === "cancelled" || input.executionStatus === "infrastructure-failed") {
      return { decision: "无法判断，需要补充条件" as const, reason: "本次执行未完成，不能据此作出发布判断。" };
    }
    if (input.finalStatus === "fail") {
      return { decision: "不建议发布" as const, reason: "至少一个核心业务 Oracle 已真实执行且未通过。" };
    }
    if (input.finalStatus === "blocked" || input.finalStatus === "needs-human-review") {
      return { decision: "无法判断，需要补充条件" as const, reason: "核心路径未执行，或现有证据不足以形成可信发布结论。" };
    }
    if (input.finalStatus === "pass" && input.executionStatus === "completed") {
      return { decision: "可以发布" as const, reason: "全部核心路径已执行，Oracle 通过且 Proof Bundle 完整。" };
    }
    if (input.finalStatus === "pass" && input.executionStatus === "completed-with-gaps") {
      return { decision: "有条件发布" as const, reason: "已执行的核心路径通过，但报告仍包含明确的非关键覆盖缺口。" };
    }
    return { decision: "无法判断，需要补充条件" as const, reason: "测试执行尚未形成可信的完成态结论。" };
  }

  function unavailableRunReport(run: NonNullable<Awaited<ReturnType<typeof runEventStore.get>>>) {
    const finalStatus = run.gateStatus ?? (run.state === "blocked" ? "blocked" : run.state === "failed" ? "fail" : "needs-human-review");
    const machineGate = finalizeProofBundle({
      draft: { status: finalStatus, reasons: ["run_bundle_unavailable"], reasonDetails: [], assertionFailures: [] },
      runId: run.id,
      machineGate: { status: finalStatus, reasons: ["run_bundle_unavailable"], reasonDetails: [], assertionFailures: [] }
    }).machineGate;
    return {
      runId: run.id,
      state: run.state,
      executionStatus: run.executionStatus,
      finalStatus,
      gateStatus: finalStatus,
      releaseRecommendation: releaseRecommendation({ executionStatus: run.executionStatus, finalStatus }),
      outcomeSummary: {
        schemaVersion: "2.0",
        executionStatus: run.executionStatus,
        schedulingCompleted: ["completed", "failed", "blocked", "cancelled"].includes(run.state),
        executionStarted: ["running", "collecting", "judging", "awaiting-human-review", "completed", "failed", "blocked"].includes(run.state),
        executionSucceeded: false,
        requirementCovered: false,
        requirementPassed: false,
        ...proofCredibility({ artifactIntegrityVerified: machineGate.evidenceComplete, evidenceGrounded: machineGate.evidenceComplete, evidenceComplete: machineGate.evidenceComplete }, machineGate, false),
        machineGate,
        judgeRecommendation: run.judgeRecommendation,
        humanDecision: run.humanDecision,
        finalStatus
      },
      machineGate,
      judgeRecommendation: run.judgeRecommendation ?? {
        status: finalStatus === "fail" ? "fail" : "needs-human-review",
        summary: "Run reached a terminal state before a report bundle was committed.",
        evidenceRefs: []
      },
      reportAvailability: "unavailable" as const,
      artifacts: [],
      evidence: []
    };
  }

  return {
    artifactUrl,
    assertAuthorizedRun,
    assertOrganizationAccess,
    assertProjectAccess,
    isMissingRunBundle,
    readAuthorizedLegacyRun,
    releaseRecommendation,
    unavailableRunReport
  };
}
