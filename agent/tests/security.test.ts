import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import {
  assertSecurityConfig,
  requireApiToken,
  requireArtifactAccess,
  securitySummary
} from "../src/security.js";

type EnvPatch = Record<string, string | undefined>;

function withEnv<T>(patch: EnvPatch, fn: () => T): T {
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
    return fn();
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

export function testSecurityBoundaries() {
  withEnv({ NODE_ENV: "production", AGENT_API_TOKEN: "dev-local-token" }, () => {
    assert.throws(() => assertSecurityConfig("0.0.0.0"), /must not use dev-local-token/);
  });

  withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined, ALLOW_QUERY_TOKEN_AUTH: undefined }, () => {
    const res = mockRes();
    let nextCalled = false;
    requireApiToken(mockReq({ query: { token: "dev-local-token" } }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(securitySummary().queryTokenAuth, "disabled");
  });

  withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined, ALLOW_QUERY_TOKEN_AUTH: "1" }, () => {
    const res = mockRes();
    let nextCalled = false;
    requireApiToken(mockReq({ query: { token: "dev-local-token" } }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(securitySummary().queryTokenAuth, "development-explicitly-enabled");
  });

  withEnv({ NODE_ENV: "production", AGENT_API_TOKEN: "real-token" }, () => {
    const res = mockRes();
    let nextCalled = false;
    requireArtifactAccess(mockReq({ path: "/artifacts/run.json", remoteAddress: "127.0.0.1" }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(securitySummary().artifactAccess, "token-required");
  });

  withEnv({ NODE_ENV: "development", AGENT_API_TOKEN: undefined }, () => {
    const res = mockRes();
    let nextCalled = false;
    requireArtifactAccess(mockReq({ path: "/artifacts/run.json", remoteAddress: "127.0.0.1" }), res, (() => {
      nextCalled = true;
    }) as NextFunction);
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });
}
