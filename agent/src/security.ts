import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const defaultDevToken = "dev-local-token";
const defaultAllowedOrigins = [
  "http://localhost:6173",
  "http://127.0.0.1:6173",
  "http://localhost:6174",
  "http://127.0.0.1:6174"
];

const rateBuckets = new Map<string, { resetAt: number; count: number }>();
export type AuthRole = "admin" | "runner" | "reviewer";
export interface AuthContext { subject: string; organizationId: string; roles: AuthRole[]; claims: JWTPayload }
const authContexts = new WeakMap<Request, AuthContext>();
let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function parseCsv(value: string | undefined, fallback: string[]) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : fallback;
}

function isDevelopment() {
  return (process.env.NODE_ENV ?? "development") === "development";
}

function isLoopbackHost(host: string) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function expectedToken() {
  if (process.env.AGENT_API_TOKEN) return process.env.AGENT_API_TOKEN;
  if (isDevelopment()) return defaultDevToken;
  throw new Error("AGENT_API_TOKEN is required outside NODE_ENV=development.");
}

function allowQueryTokenAuth() {
  return isDevelopment() && process.env.ALLOW_QUERY_TOKEN_AUTH === "1";
}

function allowLoopbackArtifactBypass() {
  return isDevelopment() && process.env.DISABLE_LOOPBACK_ARTIFACT_BYPASS !== "1";
}

function providedToken(req: Request) {
  const bearerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const queryToken = allowQueryTokenAuth() && typeof req.query.token === "string" ? req.query.token : undefined;
  return req.header("x-agent-token") ?? bearerToken ?? queryToken;
}

export function assertSecurityConfig(host: string) {
  const oidcConfigured = Boolean(process.env.OIDC_ISSUER && process.env.OIDC_AUDIENCE && process.env.OIDC_JWKS_URL);
  if (!isDevelopment() && process.env.AGENT_API_TOKEN === defaultDevToken) {
    throw new Error("AGENT_API_TOKEN must not use dev-local-token outside NODE_ENV=development.");
  }
  if (!oidcConfigured && !process.env.AGENT_API_TOKEN && (!isDevelopment() || !isLoopbackHost(host))) {
    throw new Error("Default dev-local-token requires NODE_ENV=development and HOST bound to 127.0.0.1/localhost.");
  }
}

export function securitySummary() {
  return {
    auth: process.env.OIDC_ISSUER ? "OIDC bearer JWT" : "development shared token",
    tokenSource: process.env.OIDC_ISSUER ? "OIDC_JWKS_URL" : process.env.AGENT_API_TOKEN ? "AGENT_API_TOKEN" : "development-loopback-default",
    nodeEnv: process.env.NODE_ENV ?? "development",
    allowedOrigins: parseCsv(process.env.ALLOWED_ORIGINS, defaultAllowedOrigins),
    queryTokenAuth: allowQueryTokenAuth() ? "development-explicitly-enabled" : "disabled",
    artifactAccess: allowLoopbackArtifactBypass() ? "token or development loopback-only" : "token-required",
    rateLimit: {
      windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
      max: Number(process.env.RATE_LIMIT_MAX ?? 240)
    }
  };
}

export function createCorsOptions(): CorsOptions {
  const allowedOrigins = new Set(parseCsv(process.env.ALLOWED_ORIGINS, defaultAllowedOrigins));
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin not allowed"));
    }
  };
}

function isPublicRoute(req: Request) {
  return (
    req.method === "OPTIONS" ||
    (req.method === "GET" && req.path === "/api/health")
  );
}

export function basicRateLimit(req: Request, res: Response, next: NextFunction) {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const max = Number(process.env.RATE_LIMIT_MAX ?? 240);
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { resetAt: now + windowMs, count: 1 });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  next();
}

async function verifyOidc(req: Request) {
  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!issuer || !audience || !jwksUrl) return false;
  const token = providedToken(req);
  if (!token) return false;
  remoteJwks ??= createRemoteJWKSet(new URL(jwksUrl));
  const verified = await jwtVerify(token, remoteJwks, { issuer, audience });
  const roleClaim = process.env.OIDC_ROLE_CLAIM ?? "roles";
  const orgClaim = process.env.OIDC_ORGANIZATION_CLAIM ?? "organization_id";
  const rawRoles = verified.payload[roleClaim];
  const roles = (Array.isArray(rawRoles) ? rawRoles : typeof rawRoles === "string" ? rawRoles.split(/[ ,]/) : [])
    .filter((role): role is AuthRole => ["admin", "runner", "reviewer"].includes(String(role)));
  authContexts.set(req, {
    subject: verified.payload.sub ?? "unknown",
    organizationId: String(verified.payload[orgClaim] ?? ""),
    roles,
    claims: verified.payload
  });
  return Boolean(verified.payload.sub && verified.payload[orgClaim] && roles.length);
}

export function authContext(req: Request) { return authContexts.get(req); }

export function isOrganizationAuthorized(context: AuthContext | undefined, organizationId: unknown) {
  if (!context) return false;
  if (context.subject === "local-dev" || context.roles.includes("admin")) return true;
  return Boolean(organizationId && String(organizationId) === context.organizationId);
}

export function requireInternalWorkerIdentity(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_WORKER_TOKEN;
  if (!expected || req.header("x-internal-worker-token") !== expected) {
    res.status(403).json({ error: "internal_worker_identity_required" });
    return;
  }
  next();
}

export async function requireApiToken(req: Request, res: Response, next: NextFunction) {
  if (isPublicRoute(req)) {
    next();
    return;
  }

  try {
    if (await verifyOidc(req)) {
      next();
      return;
    }
  } catch {
    // Fail closed and use the common 401 response below.
  }
  if (isDevelopment() && providedToken(req) === expectedToken()) {
    authContexts.set(req, { subject: "local-dev", organizationId: "local", roles: ["admin", "runner", "reviewer"], claims: {} });
    next();
    return;
  }

  res.status(401).json({
    error: "Unauthorized",
    message: "Missing or invalid x-agent-token."
  });
}

export function requireRole(allowed: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const context = authContext(req);
    if (context && context.roles.some((role) => allowed.includes(role))) return next();
    res.status(403).json({ error: "Forbidden", message: `Required role: ${allowed.join(" or ")}` });
  };
}

export async function requireArtifactAccess(req: Request, res: Response, next: NextFunction) {
  try {
    if (await verifyOidc(req)) return next();
  } catch {
    // Fail closed below.
  }
  if ((isDevelopment() && providedToken(req) === expectedToken()) || (allowLoopbackArtifactBypass() && isLoopbackAddress(req.socket.remoteAddress))) {
    next();
    return;
  }
  res.status(401).json({
    error: "Unauthorized",
    message: "Artifact access requires a valid token or development loopback-only local access."
  });
}
