import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  addProjectMember,
  readProjectMembers,
  removeProjectMember
} from "../services/projectMember.service.js";

const addMemberRequestSchema = z.object({
  subject: z.string().min(1),
  role: z.enum(["owner", "editor", "viewer"]),
  expiresAt: z.string().optional()
}).strict();

export function projectMemberRouter() {
  const router = Router({ mergeParams: true });

  router.get("/", async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      res.json({ grants: await readProjectMembers(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req: Request<{ id: string }>, res: Response, next: NextFunction) => {
    try {
      const input = addMemberRequestSchema.parse(req.body);
      const grant = await addProjectMember({ ...input, projectId: req.params.id });
      res.status(201).json({ grant });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:grantId", async (
    req: Request<{ id: string; grantId: string }>,
    res: Response,
    next: NextFunction
  ) => {
    try {
      res.json({ deleted: await removeProjectMember(req.params.id, req.params.grantId) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
