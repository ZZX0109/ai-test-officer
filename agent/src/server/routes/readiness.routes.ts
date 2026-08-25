import { Router, type Request } from "express";
import { z } from "zod";
import { createReadinessService } from "../../readiness.js";
import { checkEnvironment } from "../../environmentCheck.js";
import { getProject, getProjectRuntimeStatusWithRecovery, containerEngineIsReady } from "../../projectAdapter.js";
import { listCredentials } from "../../credentialStore.js";
import { getProjectLoginSummary } from "../../projectLoginStore.js";
import { appendAudit } from "../../auditLog.js";
import { requireRole } from "../../security.js";
import type { ProjectRuntimeStatus } from "../../types.js";

export function readinessRouter(input: {
  assertProjectAccess: (req: Request, projectId: unknown, scope: "read_project" | "run_tests") => Promise<void>;
  startProject: (id: string) => Promise<ProjectRuntimeStatus>;
}) {
  const router = Router();
  const service = createReadinessService({
    getProject,
    getRuntime: getProjectRuntimeStatusWithRecovery,
    startProject: input.startProject,
    containerEngineIsReady,
    checkUrl: async (url) => {
      const result = await checkEnvironment(url);
      return { ok: result.ok, status: result.status, latencyMs: result.latencyMs };
    },
    listCredentials: async () => (await listCredentials()).map((item) => ({ id: item.id, provider: item.provider, model: item.model, isDefault: item.isDefault }))
    ,getProjectLoginSummary,
    audit: appendAudit
  });
  router.get("/v1/projects/:id/readiness", async (req, res, next) => {
    try {
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "project_not_found" });
      await input.assertProjectAccess(req, project.id, "read_project");
      res.json({ report: await service.inspect(project.id) });
    } catch (error) { next(error); }
  });
  router.post("/v1/projects/:id/bootstrap", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = z.object({ dryRun: z.boolean().default(false) }).strict().parse(req.body ?? {});
      const project = await getProject(req.params.id);
      if (!project) return void res.status(404).json({ error: "project_not_found" });
      await input.assertProjectAccess(req, project.id, "run_tests");
      if (body.dryRun) {
        res.json({ status: "dry-run", report: await service.inspect(project.id), steps: [] });
        return;
      }
      const result = await service.bootstrap(project.id);
      res.status(result.status === "completed" ? 200 : 202).json(result);
    } catch (error) { next(error); }
  });
  return router;
}
