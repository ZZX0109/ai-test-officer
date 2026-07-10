import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

const defaultDevToken = "dev-local-token";
const defaultAllowedOrigins = [
  "http://localhost:6173",
  "http://127.0.0.1:6173",
  "http://localhost:6174",
  "http://127.0.0.1:6174"
];

const rateBuckets = new Map<string, { resetAt: number; count: number }>();

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
  if (!isDevelopment() && process.env.AGENT_API_TOKEN === defaultDevToken) {
    throw new Error("AGENT_API_TOKEN must not use dev-local-token outside NODE_ENV=development.");
  }
  if (!process.env.AGENT_API_TOKEN && (!isDevelopment() || !isLoopbackHost(host))) {
    throw new Error("Default dev-local-token requires NODE_ENV=development and HOST bound to 127.0.0.1/localhost.");
  }
}

export function securitySummary() {
  return {
    auth: "x-agent-token or bearer token",
    tokenSource: process.env.AGENT_API_TOKEN ? "AGENT_API_TOKEN" : "development-loopback-default",
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

export function requireApiToken(req: Request, res: Response, next: NextFunction) {
  if (isPublicRoute(req)) {
    next();
    return;
  }

  if (providedToken(req) === expectedToken()) {
    next();
    return;
  }

  res.status(401).json({
    error: "Unauthorized",
    message: "Missing or invalid x-agent-token."
  });
}

export function requireArtifactAccess(req: Request, res: Response, next: NextFunction) {
  if (providedToken(req) === expectedToken() || (allowLoopbackArtifactBypass() && isLoopbackAddress(req.socket.remoteAddress))) {
    next();
    return;
  }
  res.status(401).json({
    error: "Unauthorized",
    message: "Artifact access requires a valid token or development loopback-only local access."
  });
}
