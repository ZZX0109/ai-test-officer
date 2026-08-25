import { Router, type Request } from "express";
import { z } from "zod";
import { agentPermissionProfileSchema, type AgentPermissionProfile } from "@ai-test-officer/contracts";
import {
  deletePatrolPlan,
  listPatrolJobs,
  listPatrolPlans,
  patrolTrend,
  runPatrolNow,
  startPatrolJob,
  stopPatrolJob,
  upsertPatrolPlan
} from "../../patrolScheduler.js";
import { listPatrolRuns } from "../../patrolRunStore.js";
import { requireRunnableTarget, runnableTargetShape, targetRuntimeSchema } from "../../runRequestContract.js";
import { grayPlanSchema } from "../schemas/execution.schemas.js";
import type { ProjectScope } from "../services/runAccess.service.js";

const patrolPlanSchema = z.object({
  id: z.string().default("core_path_daily"),
  title: z.string().optional(),
  appUrl: z.string().url().optional(),
  projectId: z.string().optional(),
  target: targetRuntimeSchema.optional(),
  scenarioId: z.string().optional(),
  intervalMs: z.number().int().min(10_000).optional(),
  cron: z.string().optional(),
  notify: z.array(z.string()).optional(),
  permissionProfile: agentPermissionProfileSchema.optional(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0),
    backoffMs: z.number().int().min(0)
  }).optional(),
  escalationPolicy: z.object({
    failureThreshold: z.number().int().min(1),
    riskTrendThreshold: z.enum(["regressed", "stable", "any"]),
    notify: z.array(z.string())
  }).optional(),
  status: z.enum(["running", "stopped"]).optional()
});

export function patrolRouter(input: {
  assertProjectAccess: (req: Request, projectId: unknown, scope: ProjectScope) => Promise<void>;
}) {
  const router = Router();

  router.get("/api/patrol/jobs", (_req, res) => {
    res.json({ jobs: listPatrolJobs() });
  });

  router.get("/api/patrol/plans", async (_req, res, next) => {
    try { res.json({ plans: await listPatrolPlans() }); }
    catch (error) { next(error); }
  });

  router.post("/api/patrol/plans", async (req, res, next) => {
    try {
      const plan = patrolPlanSchema.parse(req.body);
      await input.assertProjectAccess(req, plan.projectId, "run_tests");
      res.status(201).json({ plan: await upsertPatrolPlan(plan) });
    } catch (error) { next(error); }
  });

  router.patch("/api/patrol/plans/:id", async (req, res, next) => {
    try {
      const existing = (await listPatrolPlans()).find((plan) => plan.id === req.params.id);
      await input.assertProjectAccess(req, existing?.projectId, "run_tests");
      res.json({ plan: await upsertPatrolPlan({ ...patrolPlanSchema.partial().parse(req.body), id: req.params.id }) });
    } catch (error) { next(error); }
  });

  router.delete("/api/patrol/plans/:id", async (req, res, next) => {
    try {
      const existing = (await listPatrolPlans()).find((plan) => plan.id === req.params.id);
      await input.assertProjectAccess(req, existing?.projectId, "run_tests");
      res.json({ deleted: await deletePatrolPlan(req.params.id) });
    } catch (error) { next(error); }
  });

  router.get("/api/patrol/runs", async (_req, res, next) => {
    try { res.json({ patrolRuns: await listPatrolRuns() }); }
    catch (error) { next(error); }
  });

  router.post("/api/patrol/start", (req, res, next) => {
    try {
      const body = z.object({
        id: z.string().default("core_path_daily"),
        title: z.string().optional(),
        appUrl: z.string().url().optional(),
        projectId: z.string().optional(),
        target: targetRuntimeSchema.optional(),
        scenarioId: z.string().optional(),
        intervalMs: z.number().int().min(10_000).optional(),
        notify: z.array(z.string()).optional(),
        permissionProfile: agentPermissionProfileSchema
      }).parse(req.body);
      res.json({ job: startPatrolJob(body) });
    } catch (error) { next(error); }
  });

  router.post("/api/patrol/stop", (req, res, next) => {
    try {
      const body = z.object({ id: z.string().default("core_path_daily") }).parse(req.body);
      res.json({ job: stopPatrolJob(body.id) });
    } catch (error) { next(error); }
  });

  router.post("/api/patrol/run-now", async (req, res, next) => {
    try {
      const body = z.object({
        ...runnableTargetShape,
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        requirement: z.string().optional(),
        diff: z.string().optional(),
        plan: grayPlanSchema.optional(),
        notify: z.array(z.string()).default(["oncall"]),
        permissionProfile: agentPermissionProfileSchema
      }).superRefine(requireRunnableTarget).parse(req.body);
      await input.assertProjectAccess(req, body.projectId, "run_tests");
      const patrol = await runPatrolNow({
        appUrl: body.appUrl,
        projectId: body.projectId,
        target: body.target,
        scenarioId: body.scenarioId,
        credentialId: body.credentialId,
        requirement: body.requirement,
        diff: body.diff,
        plan: body.plan,
        notify: body.notify,
        permissionProfile: body.permissionProfile as AgentPermissionProfile
      });
      res.json(patrol);
    } catch (error) { next(error); }
  });

  router.post("/api/patrol/plans/:id/run-now", async (req, res, next) => {
    try {
      const plan = (await listPatrolPlans()).find((item) => item.id === req.params.id);
      if (!plan) return void res.status(404).json({ error: "Patrol plan not found" });
      await input.assertProjectAccess(req, plan.projectId, "run_tests");
      res.json(await runPatrolNow({
        appUrl: plan.appUrl,
        projectId: plan.projectId,
        target: plan.target,
        jobId: plan.id,
        scenarioId: plan.scenarioId,
        notify: plan.notify,
        permissionProfile: plan.permissionProfile
      }));
    } catch (error) { next(error); }
  });

  router.get("/api/patrol/trends", async (req, res, next) => {
    try {
      res.json({ trend: await patrolTrend({
        projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
        scenarioId: typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined
      }) });
    } catch (error) { next(error); }
  });

  return router;
}
