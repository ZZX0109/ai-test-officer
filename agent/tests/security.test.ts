import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import {
  assertSecurityConfig,
  isOrganizationAuthorized,
  requireApiToken,
  requireArtifactAccess,
  requireInternalWorkerIdentity,
  securitySummary
} from "../src/security.js";
import { grantAllows } from "../src/projectAccess.js";

type EnvPatch = Record<string, string | undefined>;

async function withEnv<T>(patch: EnvPatch, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function mockReq(input: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  remoteAddress?: string;
}) {
  const headers = new Map(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: input.method ?? "GET",
    path: input.path ?? "/api/private",
    query: input.query ?? {},
    socket: { remoteAddress: input.remoteAddress ?? "10.0.0.7" },
    ip: input.remoteAddress ?? "10.0.0.7",
    header(name: string) {
      return headers.get(name.toLowerCase());
    }
  } as unknown as Request;
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    }
  } as Response & { statusCode: number; body: unknown };
}

export async function testSecurityBoundaries() {
  assert.equal(isOrganizationAuthorized({ subject: "runner-a", organizationId: "org-a", roles: ["runner"], claims: {} }, "org-a"), true);
  assert.equal(isOrganizationAuthorized({ subject: "runner-a", organizationId: "org-a", roles: ["runner"], claims: {} }, "org-b"), false);
  assert.equal(isOrganizationAuthorized({ subject: "admin-a", organizationId: "org-a", roles: ["admin"], claims: {} }, "org-b"), true);
  const grant = { id: "grant-1", projectId: "project-a", subject: "runner-a", role: "runner" as const, tokenKind: "dev" as const, scopes: ["run_tests", "read_artifacts"] as const, createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" };
  assert.equal(grantAllows(grant, "runner-a", "run_tests", new Date("2026-06-01")), true);
  assert.equal(grantAllows(grant, "runner-b", "run_tests", new Date("2026-06-01")), false);
  assert.equal(grantAllows(grant, "runner-a", "run_tests", new Date("2027-01-01")), false);
  await withEnv({ NODE_ENV: "production", AGENT_API_TOKEN: "dev-local-token" }, () => {
    assert.throws(() => assertSecurityConfig("0.0.0.0"), /must not use dev-local-token/);
  });

  await withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined, ALLOW_QUERY_TOKEN_AUTH: undefined }, async () => {
    const res = mockRes();
    let nextCalled = false;
    await requireApiToken(mockReq({ query: { token: "dev-local-token" } }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(securitySummary().queryTokenAuth, "disabled");
  });

  await withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined, ALLOW_QUERY_TOKEN_AUTH: "1" }, async () => {
    const res = mockRes();
    let nextCalled = false;
    await requireApiToken(mockReq({ query: { token: "dev-local-token" } }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(securitySummary().queryTokenAuth, "development-explicitly-enabled");
  });

  await withEnv({ NODE_ENV: "production", AGENT_API_TOKEN: "real-token" }, async () => {
    const res = mockRes();
    let nextCalled = false;
    await requireArtifactAccess(mockReq({ path: "/artifacts/run.json", remoteAddress: "127.0.0.1" }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(securitySummary().artifactAccess, "token-required");
  });

  await withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined }, async () => {
    const res = mockRes();
    let nextCalled = false;
    await requireArtifactAccess(mockReq({ path: "/artifacts/run.json", remoteAddress: "127.0.0.1" }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  await withEnv({ INTERNAL_WORKER_TOKEN: "worker-secret" }, async () => {
    const denied = mockRes();
    let nextCalled = false;
    requireInternalWorkerIdentity(mockReq({}), denied, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(denied.statusCode, 403);
    const accepted = mockRes();
    requireInternalWorkerIdentity(mockReq({ headers: { "x-internal-worker-token": "worker-secret" } }), accepted, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, true);
  });
}
