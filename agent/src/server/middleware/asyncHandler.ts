import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async route handler so rejected promises are forwarded to Express's
 * error pipeline instead of becoming unhandled rejections.
 *
 * Usage:
 *   router.post("/v1/runs", requireRole("runner"), validate(CreateRunRequestSchema),
 *     asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
