import { Router, type Request } from "express";
import { createReviewCase } from "../../reviewCase.js";
import { runEventStore } from "../../runEventStore.js";

export function reviewRouter(input: {
  assertOrganizationAccess: (req: Request, organizationId: unknown) => void;
  assertProjectAccess: (req: Request, projectId: unknown, scope: "read_artifacts") => Promise<void>;
}) {
  const router = Router();
  router.get("/v1/runs/:id/review-case", async (req, res, next) => {
    try {
      const run = await runEventStore.get(req.params.id);
      if (!run) return void res.status(404).json({ error: "run_not_found" });
      input.assertOrganizationAccess(req, run.input.organizationId);
      await input.assertProjectAccess(req, run.input.projectId, "read_artifacts");
      const payload = (await runEventStore.events(run.id)).at(-1)?.payload ?? {};
      res.json({ reviewCase: createReviewCase({
        id: run.id,
        state: run.state,
        status: typeof run.gateStatus === "string" ? run.gateStatus : undefined,
        reason: typeof payload.error === "string" ? payload.error : typeof payload.reason === "string" ? payload.reason : undefined,
        summary: typeof payload.message === "string" ? payload.message : undefined,
        evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs.filter((item): item is string => typeof item === "string") : [],
        canRetry: ["failed", "blocked", "awaiting-human-review"].includes(run.state),
        canResume: ["paused", "awaiting-human-review", "awaiting-permission"].includes(run.state)
      }) });
    } catch (error) { next(error); }
  });
  return router;
}
