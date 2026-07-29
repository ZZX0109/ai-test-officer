import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export type ValidationTarget = "body" | "params" | "query";

/**
 * Express middleware factory that validates and replaces a single request
 * segment (body / params / query) with the parsed result. On failure the
 * ZodError is forwarded to the central error handler (which maps it to 400).
 *
 * Usage:
 *   router.post("/v1/runs", validate(CreateRunRequestSchema), asyncHandler(...))
 *   router.get("/v1/runs/:id", validate(RunIdParamsSchema, "params"), ...)
 */
export function validate<Schema extends z.ZodTypeAny>(
  schema: Schema,
  target: ValidationTarget = "body"
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const record = req as unknown as Record<string, unknown>;
      record[target] = schema.parse(record[target]);
      next();
    } catch (error) {
      next(error);
    }
  };
}
