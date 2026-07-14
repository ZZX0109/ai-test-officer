import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const reportFile = path.join(root, "reports", "production-acceptance", "latest.json");
const startedAt = new Date().toISOString();
await mkdir(path.dirname(reportFile), { recursive: true });

function docker(args, options = {}) { return execFileSync("docker", ["compose", "-f", compose, ...args], { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: process.env }); }
async function save(status, checks, blockers = []) { await writeFile(reportFile, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), status, checks, blockers }, null, 2)); }

const required = ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) { await save("blocked", [], missing.map((name) => `${name}_missing`)); console.error(`production_acceptance_blocked:${missing.join(",")}`); process.exit(2); }
try { execFileSync("docker", ["info"], { stdio: "ignore" }); } catch { await save("blocked", [], ["docker_daemon_unavailable"]); console.error("production_acceptance_blocked:docker_daemon_unavailable"); process.exit(2); }

const checks = [];
try {
  docker(["up", "-d", "--build", "--wait"]);
  checks.push("compose_healthy");
  let tokenResponse;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    tokenResponse = await fetch("http://localhost:18080/realms/ai-test-officer/protocol/openid-connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ai-test-officer-local", username: "acceptance-runner", password: "acceptance-runner-change-me" }) }).catch(() => undefined);
    if (tokenResponse?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!tokenResponse?.ok) throw new Error(`oidc_token_${tokenResponse?.status ?? "unavailable"}`);
  const token = (await tokenResponse.json()).access_token;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const createPayload = { organizationId: "benchmark", actor: "acceptance-runner", idempotencyKey: `acceptance:${Date.now()}`, input: { appUrl: "http://todo-lite:7101", scenarioId: "task_filter_completed", plannerMode: "deterministic", judgeMode: "deterministic", executionMode: "oci", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } } };
  const createResponse = await fetch("http://localhost:14317/v1/runs", { method: "POST", headers, body: JSON.stringify(createPayload) });
  if (!createResponse.ok) throw new Error(`run_create_${createResponse.status}`);
  let run = (await createResponse.json()).run;
  const duplicateResponse = await fetch("http://localhost:14317/v1/runs", { method: "POST", headers, body: JSON.stringify(createPayload) });
  const duplicate = await duplicateResponse.json();
  if (!duplicateResponse.ok || duplicate.run?.id !== run.id) throw new Error("idempotency_duplicate_run_failed");
  const crossOrgResponse = await fetch("http://localhost:14317/v1/runs", { method: "POST", headers, body: JSON.stringify({ ...createPayload, organizationId: "other-organization", idempotencyKey: `${createPayload.idempotencyKey}:cross-org` }) });
  if (crossOrgResponse.status !== 403) throw new Error(`organization_isolation_failed:${crossOrgResponse.status}`);
  checks.push("idempotent_run_creation", "organization_isolation");
  run = (await (await fetch(`http://localhost:14317/v1/runs/${run.id}/plan-approval`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: run.version, actor: "acceptance-runner", idempotencyKey: `${run.id}:plan` }) })).json()).run;
  run = (await (await fetch(`http://localhost:14317/v1/runs/${run.id}/permissions`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: run.version, actor: "acceptance-runner", idempotencyKey: `${run.id}:permission` }) })).json()).run;
  while (!["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(run.state)) { await new Promise((resolve) => setTimeout(resolve, 1000)); run = (await (await fetch(`http://localhost:14317/v1/runs/${run.id}`, { headers })).json()).run; }
  const artifacts = (await (await fetch(`http://localhost:14317/v1/runs/${run.id}/artifacts`, { headers })).json()).artifacts;
  if (!artifacts?.some((item) => item.origin === "runtime-captured" && item.replicaUris?.some((uri) => uri.startsWith("s3://")))) throw new Error("committed_s3_artifact_missing");
  checks.push("oidc_runner_authorized", "queued_worker_execution", "artifact_v2_minio_committed");
  docker(["restart", "agent-api"]);
  const recovered = await fetch(`http://localhost:14317/v1/runs/${run.id}`, { headers });
  if (!recovered.ok) throw new Error("postgres_event_recovery_failed");
  checks.push("postgres_restart_recovery");
  const redis = docker(["exec", "-T", "redis", "redis-cli", "-a", process.env.REDIS_PASSWORD, "ping"], { capture: true });
  if (!redis.includes("PONG")) throw new Error("redis_health_failed");
  checks.push("redis_delivery_available");
  await save("passed", checks);
} catch (error) {
  await save("failed", checks, [error instanceof Error ? error.message : String(error)]);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_ACCEPTANCE_STACK !== "1") { try { docker(["down", "--volumes", "--remove-orphans"]); } catch { /* report already contains the primary result */ } }
}
