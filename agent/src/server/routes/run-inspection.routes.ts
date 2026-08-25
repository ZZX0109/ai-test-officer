import { Router, type Request } from "express";
import { z } from "zod";
import { authContext } from "../../security.js";
import { runEventStore } from "../../runEventStore.js";
import {
  agentOrchestrationMode,
  getAgentGraphProjection,
  resumeAgentGraph,
  startAgentGraphInBackground
} from "../../agentGraphService.js";
import {
  browserSessionFramePath,
  readBrowserActionResults,
  readBrowserDecisions,
  readBrowserObservations,
  readBrowserSession
} from "../../browser-agent/store.js";
import {
  acquireBrowserControl,
  executeUserBrowserInput,
  releaseBrowserControl,
  resizeManagedBrowserViewport,
  subscribeBrowserLiveFrames
} from "../../browser-agent/sessionManager.js";
import { listRecoveryRecords } from "../../recoveryStore.js";
import { readCoverageItems } from "../../coverageStore.js";
import { listLlmCalls } from "../../llmProvider.js";
import { readLlmBudgetLedger } from "../../llmBudgetLedger.js";
import { readRunBundle } from "../../evidenceStore.js";
import { readProofArtifacts, verifyEvidenceManifest } from "../../proofGraph.js";
import {
  listAgentMessages,
  listRunKnowledge,
  listRunKnowledgeConflicts,
  listRunKnowledgeToolExecutions
} from "../../knowledge-boundary/store.js";
import type { ProjectScope } from "../../types.js";

export interface RunInspectionRouterDependencies {
  assertOrganizationAccess: (request: Request, organizationId?: unknown) => void;
  assertProjectAccess: (request: Request, projectId: unknown, scope: ProjectScope) => Promise<unknown>;
}

export function runInspectionRouter(dependencies: RunInspectionRouterDependencies) {
  const { assertOrganizationAccess, assertProjectAccess } = dependencies;
  const router = Router();

  router.get("/v1/runs/:id", async (req, res, next) => {
    try {
      const run = await runEventStore.get(String(req.params.id));
      if (!run) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, run.input.organizationId);
      await assertProjectAccess(req, run.input.projectId, "read_artifacts");
      res.json({ run });
    } catch (error) { next(error); }
  });

  router.get("/v1/runs/:id/events", async (req, res, next) => {
    try {
      const run = await runEventStore.get(String(req.params.id));
      if (!run) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, run.input.organizationId);
      await assertProjectAccess(req, run.input.projectId, "read_artifacts");
      res.json({ events: await runEventStore.events(run.id) });
    } catch (error) { next(error); }
  });

router.get("/v1/runs/:id/agent", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const agent = await getAgentGraphProjection(run.id);
    res.json({ agent: agent ?? null });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/browser-session", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ session: await readBrowserSession(run.id) ?? null });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/browser-observations", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ observations: await readBrowserObservations(run.id) });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/browser-actions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const [decisions, actions] = await Promise.all([readBrowserDecisions(run.id), readBrowserActionResults(run.id)]);
    res.json({ decisions, actions });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/browser-frame", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(browserSessionFramePath(run.id), (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: "browser_frame_not_available" });
    });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/browser-live", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");

    // The Workbench consumes this as a binary canvas stream. Evidence files
    // remain immutable artifacts, while this endpoint only mirrors the latest
    // compositor frame from the same Playwright BrowserContext the Agent uses.
    let closed = false;
    let responseReady = false;
    const queuedFrames: Buffer[] = [];
    const writeFrame = (frame: Buffer) => {
      if (closed || res.writableEnded) return;
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(frame.length, 0);
      res.write(header);
      res.write(frame);
    };
    // Subscribe before committing the HTTP status. If the in-memory
    // Playwright session has already closed, this lets us return a useful 409
    // instead of first sending 200 and then crashing with ERR_HTTP_HEADERS_SENT.
    const unsubscribe = await subscribeBrowserLiveFrames(run.id, (frame) => {
      if (!responseReady) queuedFrames.push(frame);
      else writeFrame(frame);
    });
    res.status(200);
    res.setHeader("Content-Type", "application/x-ai-test-officer-browser-stream");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    responseReady = true;
    for (const frame of queuedFrames.splice(0)) writeFrame(frame);
    req.on("close", () => {
      closed = true;
      void unsubscribe();
    });
  } catch (error) {
    if (!res.headersSent && error instanceof Error && error.message === "browser_session_not_active") {
      return void res.status(409).json({ error: "browser_session_not_active", message: "共享浏览器会话尚未建立或已经结束。" });
    }
    next(error);
  }
});

router.post("/v1/runs/:id/browser-control/acquire", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    // This endpoint is itself an authenticated, explicit operator action. It
    // may pre-empt the Agent's short lease so the user can immediately handle
    // MFA, consent or a blocked page in the same Playwright context.
    res.json({ session: await acquireBrowserControl(run.id, "user", { force: true }) });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/browser-control/release", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ session: await releaseBrowserControl(run.id, "user") });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/browser-viewport", async (req, res, next) => {
  try {
    const body = z.object({
      width: z.number().finite().int().min(320).max(3_840),
      height: z.number().finite().int().min(240).max(2_160)
    }).strict().parse(req.body);
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ session: await resizeManagedBrowserViewport(run.id, body) });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/browser-input", async (req, res, next) => {
  try {
    const body = z.object({
      kind: z.enum(["click", "type", "press", "scroll"]),
      x: z.number().finite().nonnegative().optional(),
      y: z.number().finite().nonnegative().optional(),
      text: z.string().max(4_000).optional(),
      key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]).optional(),
      deltaY: z.number().finite().min(-5_000).max(5_000).optional()
    }).strict().parse(req.body);
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ observation: await executeUserBrowserInput({ runId: run.id, ...body }) });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/recovery-actions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const records = await listRecoveryRecords(String(req.params.id));
    res.json(records);
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/observations", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const records = await listRecoveryRecords(String(req.params.id));
    res.json({ observations: records.observations });
  } catch (error) { next(error); }
});

/** Resume the active graph with a recovery decision. Safe recovery actions
 * are executed by the graph; credential, source-write and other risky actions
 * remain interrupt-gated and are never performed by this route itself. */
// eslint-disable-next-line complexity -- this endpoint validates every resume gate explicitly.
router.post("/v1/runs/:id/recover", async (req, res, next) => {
  try {
    const body = z.object({
      approved: z.boolean().default(true),
      action: z.string().optional(),
      idempotencyKey: z.string().min(1).optional()
    }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const value = { approved: body.approved, actor: authContext(req)?.subject ?? "user", ...(body.action ? { action: body.action } : {}) };
    const projection = await getAgentGraphProjection(run.id);
    const resumed = projection?.pendingInterrupt
      ? await resumeAgentGraph(run.id, value)
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, runId: run.id, resumed: resumed ?? null, agent: await getAgentGraphProjection(run.id) ?? null });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/paths/:pathId/retry", async (req, res, next) => {
  try {
    const body = z.object({ idempotencyKey: z.string().min(1).optional() }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const projection = await getAgentGraphProjection(run.id);
    if (!projection) return void res.status(409).json({ error: "agent_state_unavailable" });
    const resumed = projection.pendingInterrupt
      ? await resumeAgentGraph(run.id, { approved: true, action: "retry-path", pathId: String(req.params.pathId), actor: authContext(req)?.subject ?? "user" })
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, pathId: String(req.params.pathId), idempotencyKey: body.idempotencyKey, resumed: resumed ?? null });
  } catch (error) { next(error); }
});

router.post("/v1/runs/:id/continue", async (req, res, next) => {
  try {
    const body = z.object({ approved: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const projection = await getAgentGraphProjection(run.id);
    const resumed = projection?.pendingInterrupt
      ? await resumeAgentGraph(run.id, { approved: body.approved, action: "continue-safe-paths", actor: authContext(req)?.subject ?? "user" })
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, resumed: resumed ?? null });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/coverage", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const proof = await readProofArtifacts(resultRunId);
    const durableCoverage = proof.coverageItems.length
      ? proof.coverageItems
      : await readCoverageItems(run.id);
    const disposition = {
      executed: durableCoverage.filter((item) => item.disposition === "executed").length,
      excluded: durableCoverage.filter((item) => item.disposition === "excluded").length,
      blocked: durableCoverage.filter((item) => item.disposition === "blocked").length,
      pending: durableCoverage.filter((item) => item.disposition === "pending").length
    };
    res.json({
      coverage: durableCoverage,
      disposition,
      complete: durableCoverage.length > 0 && disposition.pending === 0
    });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/llm-calls", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const calls = await listLlmCalls(run.id);
    const ledger = await readLlmBudgetLedger(run.id);
    const knownCosts = calls.map((call) => call.usage.estimatedCostUsd).filter((value): value is number => typeof value === "number");
    res.json({
      calls,
      budgetLedger: ledger,
      summary: {
        count: calls.length,
        totalTokens: calls.reduce((sum, call) => sum + (call.usage.totalTokens ?? 0), 0),
        cost: knownCosts.length === calls.length ? knownCosts.reduce((sum, value) => sum + value, 0) : "unknown",
        retries: calls.reduce((sum, call) => sum + Math.max(0, (call.transportAttempts?.length ?? 1) - 1), 0),
        failures: calls.filter((call) => call.status !== "passed").length
      }
    });
  } catch (error) { next(error); }
});

router.get("/v1/runs/:id/conclusions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const proof = await readProofArtifacts(resultRunId);
    let integrity = { valid: false, errors: ["manifest_missing"] };
    if (proof.manifest) {
      try {
        const [knowledge, conflicts, toolExecutions, messages] = await Promise.all([
          listRunKnowledge(resultRunId),
          listRunKnowledgeConflicts(resultRunId),
          listRunKnowledgeToolExecutions(resultRunId),
          listAgentMessages(resultRunId)
        ]);
        integrity = verifyEvidenceManifest(
          await readRunBundle(resultRunId),
          proof.manifest,
          { ...knowledge, conflicts, toolExecutions, messages }
        );
      } catch {
        integrity = { valid: false, errors: ["manifest_verification_failed"] };
      }
    }
    res.json({
      conclusions: integrity.valid
        ? proof.conclusions
        : proof.conclusions.map((item) => ({ ...item, proofStatus: "invalid" })),
      manifest: proof.manifest ? { ...proof.manifest, integrityStatus: integrity.valid ? proof.manifest.integrityStatus : "integrity-invalid" } : null,
      integrity
    });
  } catch (error) { next(error); }
});

// eslint-disable-next-line complexity -- proof traversal is deliberately bounded and fail-closed.
router.get("/v1/conclusions/:id/proof", async (req, res, next) => {
  try {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    if (!runId) return void res.status(400).json({ error: "run_id_required" });
    const run = await runEventStore.get(runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const bundle = await readRunBundle(resultRunId);
    const proof = await readProofArtifacts(resultRunId);
    const conclusion = proof.conclusions.find((item) => item.conclusionId === String(req.params.id));
    if (!conclusion) return void res.status(404).json({ error: "conclusion_not_found" });
    const nodeIds = new Set<string>([conclusion.conclusionId]);
    const edges = proof.proofEdges.filter((edge) => {
      if (!nodeIds.has(edge.fromId)) return false;
      nodeIds.add(edge.toId);
      return true;
    });
    for (let pass = 0; pass < 6; pass += 1) {
      for (const edge of proof.proofEdges) {
        if (nodeIds.has(edge.fromId)) nodeIds.add(edge.toId);
      }
    }
    const selectedEdges = proof.proofEdges.filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
    res.json({
      conclusion,
      edges: selectedEdges.length ? selectedEdges : edges,
      evidence: bundle.evidence.filter((item) => nodeIds.has(item.id)),
      artifacts: (bundle.artifactsV2 ?? []).filter((item) => nodeIds.has(item.id)),
      attempts: (bundle.attempts ?? []).filter((item) => nodeIds.has(item.id)),
      steps: bundle.result.steps.filter((item) => nodeIds.has(item.stepId)),
      manifest: proof.manifest ?? null
    });
  } catch (error) { next(error); }
});

  return router;
}
