import { Router, type Request } from "express";
import { z } from "zod";
import type { ProjectScope } from "../../types.js";
import {
  generateProjectPlan,
  refineProjectPlan
} from "../services/planGeneration.service.js";
import { grayPlanSchema } from "../schemas/execution.schemas.js";

type AuthorizeProject = (
  request: Request,
  projectId: unknown,
  scope: ProjectScope
) => Promise<void>;

const generatePlanRequestSchema = z.object({
  projectId: z.string().optional(),
  requirement: z.string().min(1),
  diff: z.string().default(""),
  credentialId: z.string().optional()
}).strict();

const refinePlanRequestSchema = z.object({
  currentPlan: grayPlanSchema.optional(),
  feedback: z.string().min(1),
  failedAssertionNames: z.array(z.string()).default([])
}).strict();

export function planRouter(authorizeProject: AuthorizeProject) {
  const router = Router();

  router.post("/api/generate-plan", async (req, res, next) => {
    try {
      const input = generatePlanRequestSchema.parse(req.body);
      await authorizeProject(req, input.projectId, "run_tests");
      res.json(await generateProjectPlan(input));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/refine-plan", async (req, res, next) => {
    try {
      res.json(refineProjectPlan(refinePlanRequestSchema.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
