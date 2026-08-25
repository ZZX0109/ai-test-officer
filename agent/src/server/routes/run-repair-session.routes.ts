import { Router, type Request } from "express";
import { z } from "zod";
import { agentInterruptSchema } from "@ai-test-officer/contracts";
import { authContext } from "../../security.js";
import { runEventStore } from "../../runEventStore.js";
import { getAgentGraphProjection, resumeAgentGraph } from "../../agentGraphService.js";
import {
  applyRepairSession,
  createRepairSession,
  exportRepairSession,
  findReusableProjectCodeSession,
  listRepairSessions,
  listRepairWorkspaceFiles,
  readRepairFile,
  readRepairSession,
  updateRepairSessionSummary,
  validateRepairSession,
  writeRepairFile
} from "../../repairWorkspace.js";
import { getProject, getProjectRuntimeStatusWithRecovery } from "../../projectAdapter.js";
import { proposeCodeRepair, proposeProjectStartupRepair } from "../../llmCodeRepair.js";
import { getWriteSafetyLayer } from "../../write-safety/index.js";
import type { ProjectScope } from "../../types.js";

export interface RunRepairRouterDependencies {
  assertOrganizationAccess: (request: Request, organizationId?: unknown) => void;
  assertProjectAccess: (request: Request, projectId: unknown, scope: ProjectScope) => Promise<unknown>;
}

export function runRepairSessionRouter(dependencies: RunRepairRouterDependencies) {
  const { assertOrganizationAccess, assertProjectAccess } = dependencies;
  const router = Router();

router.post("/v1/runs/:id/interrupts/:interruptId/resume", async (req, res, next) => {
  try {
    const body = z.object({
      approved: z.boolean().optional(),
      input: z.record(z.unknown()).default({}),
      decision: z.enum(["repair", "create-session", "provide-credentials", "recover-sandbox", "reopen-discovery", "dismiss"]).optional(),
      message: z.string().max(4_000).optional(),
      repairPlanId: z.string().optional()
    }).parse(req.body);
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    const projection = await getAgentGraphProjection(run.id);
    const interrupt = projection?.pendingInterrupt;
    if (!interrupt || interrupt.id !== String(req.params.interruptId)) {
      return void res.status(409).json({ error: "agent_interrupt_conflict" });
    }
    agentInterruptSchema.parse(interrupt);
    // `execution-result` is a private Graph/Worker rendezvous. A user response
    // cannot contain the signed execution generation, Attempt and artifacts
    // required to resume it safely. Older Workbench builds incorrectly showed
    // this as a generic repair choice, which appeared to do nothing and could
    // leave the graph checkpoint inconsistent.
    if (interrupt.kind === "execution-result") {
      return void res.status(409).json({
        error: "execution_result_worker_owned",
        message: "该等待项由执行 Worker 自动完成，不需要用户处理。"
      });
    }
    // The graph node that raised the interrupt decides how to interpret the
    // resume value. plan-approval / browser-permission / execution-result nodes
    // expect `{ approved, ...input }`; the repair-decision node expects a
    // structured RepairDecisionAnswer. Forward the matching shape so the
    // decision is actually applied rather than silently dismissed.
    const resumeValue = interrupt.kind === "repair-decision"
      ? { decision: body.decision ?? "dismiss", message: body.message, repairPlanId: body.repairPlanId }
      : { approved: body.approved ?? true, ...body.input };
    await resumeAgentGraph(run.id, resumeValue);
    // `resume` returns the raw graph state, which is not a projection and would
    // overwrite the client's view with a malformed object. Re-read the
    // projection the graph persisted while resuming, so the caller also sees any
    // *new* interrupt raised downstream of this decision.
    const agent = await getAgentGraphProjection(run.id);
    res.json({ agent });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/repairs", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ repairs: await listRepairSessions(run.id) });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/repairs", async (req, res, next) => {
  try {
    const body = z.object({
      autoAnalyze: z.boolean().default(true),
      credentialId: z.string().optional(),
      summary: z.string().max(2_000).optional()
    }).parse(req.body ?? {});
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "edit_sandbox");
    if (typeof run.input.projectId !== "string") return void res.status(409).json({ error: "run_project_missing" });
    const project = await getProject(run.input.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    let repair = await createRepairSession({
      runId: run.id,
      project,
      summary: body.summary,
      failureClass: run.machineGate?.status === "fail" ? "product-bug" : "unknown"
    });
    if (body.autoAnalyze) {
      repair = await proposeCodeRepair({ sessionId: repair.id, run, project, credentialId: body.credentialId });
    }
    res.status(201).json({ repair });
  } catch (error) { next(error); }
});

/**
 * Open the project-level code surface without pretending that a test run
 * exists. This creates an un-analyzed sandbox session: it is safe to browse
 * and edit, but it cannot publish a test result or apply to the source tree.
 */
router.post("/v1/projects/:id/code-sessions", async (req, res, next) => {
  try {
    const body = z.object({
      summary: z.string().max(2_000).optional(),
      autoAnalyze: z.boolean().default(false),
      credentialId: z.string().optional()
    }).parse(req.body ?? {});
    const project = await getProject(String(req.params.id));
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    await assertProjectAccess(req, project.id, "edit_sandbox");
    const reusable = body.autoAnalyze ? undefined : await findReusableProjectCodeSession(project.id);
    let repair = reusable ?? await createRepairSession({
      runId: `code-session:${project.id}:${crypto.randomUUID()}`,
      project,
      summary: body.summary ?? "项目代码沙盒已创建。原项目保持只读，保存和导出都只作用于沙盒副本。",
      failureClass: body.autoAnalyze ? "environment" : "unknown"
    });
    if (body.autoAnalyze) {
      const runtime = await getProjectRuntimeStatusWithRecovery(project.id);
      try {
        repair = await proposeProjectStartupRepair({
          sessionId: repair.id,
          project,
          runtime,
          credentialId: body.credentialId
        });
      } catch (error) {
        // The code surface remains useful when the provider is unavailable.
        // Return the session with an explicit diagnosis instead of turning a
        // model outage into another opaque, unopenable UI failure.
        const errorCode = (error instanceof Error ? error.message : "model_repair_failed")
          .replace(/[^a-zA-Z0-9_:-]/g, "_")
          .slice(0, 120);
        repair = await updateRepairSessionSummary(repair.id, {
          summary: `AI 启动修复未完成（${errorCode}）。沙盒副本已保留，原项目未修改。`,
          status: "editing",
          failureClass: "environment"
        });
      }
    }
    res.status(201).json({ repair });
  } catch (error) { next(error); }
});

router.get("/v1/repair-sessions/:id", async (req, res, next) => {
  try {
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    res.json({ repair });
  } catch (error) { next(error); }
});

// Deliberately registered before the wildcard file-content route below. The
// workbench receives only the filtered sandbox snapshot tree, never arbitrary
// paths from the host project.
router.get("/v1/repair-sessions/:id/files", async (req, res, next) => {
  try {
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    res.json({ files: await listRepairWorkspaceFiles(repair.id) });
  } catch (error) { next(error); }
});

router.get("/v1/repair-sessions/:id/files/*", async (req, res, next) => {
  try {
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    const requestedPath = (req.params as Record<string, string>)["0"] ?? "";
    res.json({ file: await readRepairFile(repair.id, requestedPath) });
  } catch (error) { next(error); }
});

router.put("/v1/repair-sessions/:id/files/*", async (req, res, next) => {
  try {
    const body = z.object({
      content: z.string().max(1024 * 1024),
      expectedVersion: z.number().int().nonnegative()
    }).parse(req.body);
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const requestedPath = (req.params as Record<string, string>)["0"] ?? "";
    res.json({ repair: await writeRepairFile({ id: repair.id, path: requestedPath, ...body }) });
  } catch (error) { next(error); }
});

router.post("/v1/repair-sessions/:id/validate", async (req, res, next) => {
  try {
    const body = z.object({ allowNetworkInstall: z.boolean().default(false) }).parse(req.body ?? {});
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const project = await getProject(repair.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    res.json({ repair: await validateRepairSession(repair.id, project, body) });
  } catch (error) { next(error); }
});

router.post("/v1/repair-sessions/:id/export", async (req, res, next) => {
  try {
    const body = z.object({ format: z.enum(["patch", "zip"]) }).parse(req.body);
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "export_source");
    res.json(await exportRepairSession(repair.id, body.format));
  } catch (error) { next(error); }
});

router.post("/v1/repair-sessions/:id/apply", async (req, res, next) => {
  try {
    const body = z.object({ confirm: z.literal(true), confirmHighRisk: z.boolean().default(false) }).parse(req.body);
    const repair = await readRepairSession(String(req.params.id));
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "apply_source");
    const project = await getProject(repair.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const safety = getWriteSafetyLayer();
    const proposed = safety.resolveProposal({
      actionId: `apply-${repair.id}`,
      proposedBy: "user",
      capability: "apply_source_patch",
      params: { repairSessionId: repair.id },
      reason: "User explicitly confirmed applying the validated sandbox patch.",
      sourceClaimIds: ["user-confirmation"],
      riskLevel: "high",
      requiresConfirmation: true,
      idempotencyKey: `apply-${repair.id}`,
      runId: run.id,
      projectId: repair.projectId,
      proposedAt: new Date().toISOString()
    });
    const policy = await safety.policyCheck(proposed);
    if (!policy.allowed) return void res.status(403).json({ error: "write_policy_denied", policy });
    const workflow = await safety.createApprovalWorkflow(proposed);
    if (workflow.status === "pending") await safety.approveWorkflow(workflow.workflowId, authContext(req)?.subject ?? "user", "Explicit apply confirmation");
    let applied: Awaited<ReturnType<typeof applyRepairSession>> | undefined;
    const execution = await safety.executeApproved(proposed, async () => {
      applied = await applyRepairSession(repair.id, project, { confirmHighRisk: body.confirmHighRisk });
      return {
        executionId: `exec-${repair.id}`,
        actionId: proposed.actionId,
        status: "executed",
        affectedTables: ["sandbox_source"],
        affectedRows: applied.files.length,
        durationMs: 0,
        executedAt: new Date().toISOString(),
        executorId: authContext(req)?.subject ?? "user"
      };
    });
    if (execution.status !== "executed" || !applied) return void res.status(409).json({ error: "write_execution_failed", execution, workflow });
    res.json({ repair: applied, workflow, execution });
  } catch (error) { next(error); }
});



  return router;
}

