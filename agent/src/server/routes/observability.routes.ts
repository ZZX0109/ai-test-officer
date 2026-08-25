import { Router } from "express";
import { z } from "zod";
import { getAgentSustainability } from "../../agentSustainability.js";
import { containerEngineIsReady } from "../../projectAdapter.js";
import { listStorageArchives, runStorageRetention, storageStatus } from "../../storageGovernance.js";
import { databasePoolStats } from "../../databaseRuntime.js";
import { collectOperationalSlo, renderOperationalSloPrometheus } from "../../operationalSlo.js";

export function observabilityRouter() {
  const router = Router();
  router.get("/api/storage/status", async (_req, res, next) => {
    try { res.json({ storage: await storageStatus() }); }
    catch (error) { next(error); }
  });
  router.get("/api/storage/database-pool", (_req, res) => {
    res.json({ pools: databasePoolStats() });
  });
  router.get("/api/operations/slo", async (_req, res, next) => {
    try { res.json({ slo: await collectOperationalSlo() }); }
    catch (error) { next(error); }
  });
  router.get("/api/operations/slo/prometheus", async (_req, res, next) => {
    try {
      res.type("text/plain; version=0.0.4").send(renderOperationalSloPrometheus(await collectOperationalSlo()));
    } catch (error) { next(error); }
  });
  router.get("/api/readiness", async (_req, res, next) => {
    try { res.json({ docker: { available: await containerEngineIsReady(), engine: "docker" as const } }); }
    catch (error) { next(error); }
  });
  router.get("/api/agent/sustainability", async (_req, res, next) => {
    try {
      const platform = getAgentSustainability();
      res.json({
        modules: ["context-layer", "memory", "tool-gateway", "write-safety", "tracing", "llm-input", "feedback-loop"],
        tools: platform.tools.getRegistry().listTools(),
        pendingApprovals: platform.writeSafety.getPendingApprovals().length,
        feedback: await platform.feedback.getStageCounts()
      });
    } catch (error) { next(error); }
  });
  router.get("/api/runs/:runId/trace", async (req, res, next) => {
    try {
      const chain = await getAgentSustainability().tracer.getChainByRunId(req.params.runId);
      if (!chain) return void res.status(404).json({ error: "trace_not_found", runId: req.params.runId });
      res.json({ chain, spans: chain.spans });
    } catch (error) { next(error); }
  });
  router.get("/api/agent/tools", (_req, res) => {
    res.json({ tools: getAgentSustainability().tools.getRegistry().listTools() });
  });
  router.get("/api/storage/archives", async (_req, res, next) => {
    try { res.json({ archives: await listStorageArchives() }); }
    catch (error) { next(error); }
  });
  router.post("/api/storage/retention/run", async (req, res, next) => {
    try {
      const body = z.object({ apply: z.boolean().default(false), archive: z.boolean().default(true) }).parse(req.body ?? {});
      res.json({ retention: await runStorageRetention(body) });
    } catch (error) { next(error); }
  });
  return router;
}
