// Real OIDC multi-tenant boundary acceptance.
// Starts the Postgres + Keycloak production stack, obtains two tokens whose
// organization_id claims differ, and verifies own-org access plus cross-org
// denial at both read and control endpoints.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const outDir = path.join(root, "reports", "redteam");
const reportPath = path.join(outDir, "oidc-multi-tenant-latest.json");
const project = `ato-oidc-${randomUUID().slice(0, 8)}`;
const apiBase = "http://127.0.0.1:14317";
const oidcBase = "http://127.0.0.1:18080";

await mkdir(outDir, { recursive: true });

function seedSecrets() {
  for (const name of [
    "POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
    "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD"
  ]) process.env[name] ??= randomBytes(24).toString("hex");
  process.env.KEYCLOAK_ADMIN ??= "oidc-admin";
  if (!process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY || !process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
  }
}

function composeRun(args, options = {}) {
  return execFileSync("docker", ["compose", "-p", project, "-f", compose, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env },
    timeout: options.timeout ?? 600_000
  });
}

async function waitFor(url, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
}

async function tokenFor(username, password) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${oidcBase}/realms/ai-test-officer/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "ai-test-officer-local", username, password })
      });
      if (response.ok) return (await response.json()).access_token;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(`oidc_token_timeout:${username}`);
}

function decodeClaims(token) {
  const payload = token.split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

async function api(method, pathname, token, body) {
  const response = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, body: json };
}

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "Real OIDC two-organization isolation against Postgres-backed production API",
  composeProject: project,
  stackHealthy: false,
  tokenClaims: {},
  checks: [],
  blockers: [],
  limitations: [
    "The test uses disposable acceptance volumes and non-production fixture credentials.",
    "Tokens are never written to the report; only decoded subject and organization claims are retained."
  ]
};

seedSecrets();
try {
  composeRun(["down", "--volumes", "--remove-orphans"], { capture: true, timeout: 120_000 });
  composeRun(["up", "-d", "--build", "--wait"], { capture: true });
  report.stackHealthy = await waitFor(`${apiBase}/api/health`);
  if (!report.stackHealthy) throw new Error("agent_api_health_timeout");
  report.checks.push("production_stack_healthy");

  const tokenA = await tokenFor("acceptance-org-a", "acceptance-org-a-change-me");
  const tokenB = await tokenFor("acceptance-org-b", "acceptance-org-b-change-me");
  const claimsA = decodeClaims(tokenA);
  const claimsB = decodeClaims(tokenB);
  report.tokenClaims = {
    organizationA: { subject: claimsA.sub, organizationId: claimsA.organization_id, roles: claimsA.roles },
    organizationB: { subject: claimsB.sub, organizationId: claimsB.organization_id, roles: claimsB.roles }
  };
  if (claimsA.organization_id !== "org_oidc_a" || claimsB.organization_id !== "org_oidc_b") throw new Error("oidc_organization_claim_mismatch");
  report.checks.push("oidc_tokens_have_distinct_organization_claims");

  const runPayload = (organizationId, suffix) => ({
    projectId: "fastapi-full-stack-template",
    organizationId,
    actor: `oidc-${organizationId}`,
    idempotencyKey: `oidc-isolation-${suffix}-${randomUUID()}`,
    input: {
      plannerMode: "deterministic",
      judgeMode: "deterministic",
      experimentId: `oidc-isolation-${suffix}`,
      repetition: 1,
      cachePolicy: "bypass",
      executionProfile: "benchmark",
      promptVersion: "plan-v1"
    }
  });
  const createdA = await api("POST", "/v1/runs", tokenA, runPayload("org_oidc_a", "a"));
  const createdB = await api("POST", "/v1/runs", tokenB, runPayload("org_oidc_b", "b"));
  const runIdA = createdA.body.run?.id;
  const runIdB = createdB.body.run?.id;
  report.checks.push("org_a_and_org_b_can_create_own_runs");
  if (createdA.status !== 201 || createdB.status !== 201 || !runIdA || !runIdB) throw new Error("oidc_own_org_create_failed");

  const ownRead = await api("GET", `/v1/runs/${runIdA}`, tokenA);
  const crossRead = await api("GET", `/v1/runs/${runIdA}`, tokenB);
  const crossControl = await api("POST", `/v1/runs/${runIdA}/plan-approval`, tokenB, {
    expectedVersion: createdA.body.run.version,
    actor: "oidc-org-b",
    idempotencyKey: `oidc-cross-control-${randomUUID()}`
  });
  report.checks.push("own_org_read_allowed");
  report.checks.push("cross_org_read_denied");
  report.checks.push("cross_org_control_denied");
  report.results = {
    created: { orgA: { status: createdA.status, runId: runIdA }, orgB: { status: createdB.status, runId: runIdB } },
    ownRead: { status: ownRead.status, allowed: ownRead.status === 200 },
    crossRead: { status: crossRead.status, denied: [401, 403].includes(crossRead.status) },
    crossControl: { status: crossControl.status, denied: [401, 403].includes(crossControl.status) }
  };
  if (ownRead.status !== 200 || ![401, 403].includes(crossRead.status) || ![401, 403].includes(crossControl.status)) throw new Error("oidc_cross_org_boundary_failed");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.blockers.push(error instanceof Error ? error.message : String(error));
} finally {
  try { composeRun(["down", "--volumes", "--remove-orphans"], { capture: true, timeout: 120_000 }); } catch {}
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`report → ${path.relative(root, reportPath)}`);
  console.log(`passed=${report.passed} checks=${report.checks.length} blockers=${report.blockers.length}`);
}

if (!report.passed) process.exitCode = 1;
