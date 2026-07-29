import type { NextFunction, Request, RequestHandler, Response } from "express";
import { authContext } from "../../security.js";

export interface AuthenticatedRequest extends Request {
  auth: ReturnType<typeof authContext>;
}

/**
 * Preloads the security/auth context derived from the request onto `req.auth`
 * so downstream handlers and routers can read it without re-parsing headers.
 *
 * Behavior-preserving: `authContext(req)` is deterministic given the request,
 * so attaching it here is equivalent to calling it inline in each route.
 */
export function requestContext(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  (req as AuthenticatedRequest).auth = authContext(req);
  next();
}
