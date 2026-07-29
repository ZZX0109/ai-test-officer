import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactAcceptanceDiagnostic } from "./production-acceptance-redaction.mjs";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const reportFile = path.join(root, "reports", "production-acceptance", "latest.json");
const startedAt = new Date().toISOString();
const composeProject = `ato-acceptance-${randomUUID().slice(0, 8)}`;
await mkdir(path.dirname(reportFile), { recursive: true });

// This script provisions an isolated, disposable Compose project. Generate
// secrets only for that local acceptance process so a clean checkout can run
// it without a developer-owned .env; production deployments still require
// externally injected secrets.
function ensureAcceptanceSecrets() {
  const generated = [];
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN"]) {
    if (!process.env[name]) {
      process.env[name] = randomBytes(24).toString("base64url");
      generated.push(name);
    }
  }
  if (!process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY || !process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY) {
    const keys = generateKeyPairSync("ed25519");
    process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    generated.push("RUN_EVIDENCE_ED25519_PRIVATE_KEY", "RUN_EVIDENCE_ED25519_PUBLIC_KEY");
  }
  if (!process.env.KEYCLOAK_ADMIN) {
    process.env.KEYCLOAK_ADMIN = "acceptance-admin";
    generated.push("KEYCLOAK_ADMIN");
  }
  return generated;
}
const generatedAcceptanceSecrets = ensureAcceptanceSecrets();

function redact(value) {
  let result = String(value ?? "");
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "RUN_EVIDENCE_ED25519_PRIVATE_KEY", "RUN_EVIDENCE_ED25519_PUBLIC_KEY"]) {
    const secret = process.env[name];
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return redactAcceptanceDiagnostic(result);
}

function docker(args, options = {}) {
  try {
    return execFileSync("docker", ["compose", "-p", composeProject, "-f", compose, ...args], { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: process.env });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? redact(String(error.stderr ?? "")).replace(/[\r\n]+/g, " ").slice(0, 500)
      : "";
    throw new Error(`compose_command_failed:${args.join("_")}${detail ? `:${detail}` : ""}`);
  }
}
function dockerCapture(args) {
  try { return redact(docker(args, { capture: true })).slice(-12_000); } catch (error) { return `capture_failed:${redact(error instanceof Error ? error.message : String(error))}`; }
}
function diagnostics() {
  const services = [
    "agent-api",
    "worker",
    "workbench",
    "keycloak",
    "postgres",
    "redis",
    "minio",
    "minio-init",
    "reports-init",
    "todo-lite",
    "order-portal-lite",
    "customer-portal-lite"
  ];
  return {
    composeProject,
    config: dockerCapture(["config"]),
    ps: dockerCapture(["ps", "--all"]),
    logs: Object.fromEntries(services.map((service) => [service, dockerCapture(["logs", "--no-color", "--tail", "120", service])]))
  };
}
async function save(status, checks, blockers = []) { await writeFile(reportFile, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), status, checks, blockers, generatedAcceptanceSecrets, diagnostics: diagnostics() }, null, 2)); }
try { execFileSync("docker", ["info"], { stdio: "ignore" }); } catch { await save("blocked", [], ["docker_daemon_unavailable"]); console.error("production_acceptance_blocked:docker_daemon_unavailable"); process.exit(2); }

const checks = [];
try {
  // Each acceptance run owns fresh state. Reusing a PostgreSQL volume with a
  // different ephemeral test password makes the API look unhealthy before a
  // single production check can run.
  docker(["down", "--volumes", "--remove-orphans"]);
  docker(["up", "-d", "--build", "--wait"]);
  checks.push("compose_healthy");
  let tokenResponse;
  let tokenFailure = "unavailable";
  const acceptancePassword = ["acceptance-runner", "change-me"].join("-");
  // A cold Keycloak 26 image performs Quarkus augmentation before serving the
  // imported realm and can legitimately need more than one minute on laptops.
  for (let attempt = 0; attempt < 180; attempt += 1) {
    tokenResponse = await fetch("http://127.0.0.1:18080/realms/ai-test-officer/protocol/openid-connect/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ai-test-officer-local", username: "acceptance-runner", password: acceptancePassword }) }).catch((error) => {
      tokenFailure = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120) : "unavailable";
      return undefined;
    });
    if (tokenResponse?.ok) break;
    if (tokenResponse) tokenFailure = `${tokenResponse.status}:${(await tokenResponse.text()).replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160)}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!tokenResponse?.ok) throw new Error(`oidc_token_${tokenFailure}`);
  const token = (await tokenResponse.json()).access_token;
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const terminalStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function api(pathname, options = {}) {
    let lastError;
    // Restart/reconnect checks intentionally create short periods in which the
    // socket can be reset even though the API container remains healthy.
    // Every acceptance mutation carries an idempotency key, so retrying a
    // transport failure cannot duplicate state.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await fetch(`http://localhost:14317${pathname}`, {
          headers,
          ...options,
          signal: AbortSignal.timeout(5_000)
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        if (![502, 503, 504].includes(response.status)) {
          throw new Error(`acceptance_api_${response.status}:${pathname}`);
        }
        lastError = new Error(`acceptance_api_${response.status}:${pathname}`);
      } catch (error) {
        if (error instanceof Error && /^acceptance_api_(?!50[234])/.test(error.message)) throw error;
        lastError = error;
      }
      if (attempt < 6) await sleep(250 * attempt);
    }
    throw new Error(`acceptance_api_transport_exhausted:${pathname}:${lastError instanceof Error ? lastError.message : "unknown"}`);
  }
  function newPayload(suffix) {
    return { organizationId: "benchmark", actor: "acceptance-runner", idempotencyKey: `acceptance:${suffix}:${Date.now()}`, input: { appUrl: "http://customer-portal-lite:7103", scenarioId: "generic_table_sort_filter_pagination", plannerMode: "deterministic", judgeMode: "deterministic", executionMode: "oci", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } } };
  }
  async function createApprovedRun(suffix, options = {}) {
    const payload = newPayload(suffix);
    let created = (await api("/v1/runs", { method: "POST", body: JSON.stringify(payload) })).run;
    if (options.verifyCreateIdempotency) {
      const duplicate = await api("/v1/runs", { method: "POST", body: JSON.stringify(payload) });
      if (duplicate.run?.id !== created.id) throw new Error("idempotency_duplicate_run_failed");
    }
    created = (await api(`/v1/runs/${created.id}/plan-approval`, { method: "POST", body: JSON.stringify({ expectedVersion: created.version, actor: "acceptance-runner", idempotencyKey: `${created.id}:plan` }) })).run;
    return { payload, run: created };
  }
  async function grantPermission(run, suffix, duplicate = false) {
    const body = { expectedVersion: run.version, actor: "acceptance-runner", idempotencyKey: `${run.id}:permission:${suffix}` };
    const granted = (await api(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify(body) })).run;
    if (duplicate) {
      const replay = (await api(`/v1/runs/${run.id}/permissions`, { method: "POST", body: JSON.stringify(body) })).run;
      if (replay.version !== granted.version || replay.id !== granted.id) throw new Error("idempotency_duplicate_permission_failed");
    }
    return granted;
  }
  async function control(run, action, suffix, payload) {
    return (await api(`/v1/runs/${run.id}/${action}`, { method: "POST", body: JSON.stringify({ expectedVersion: run.version, actor: "acceptance-runner", idempotencyKey: `${run.id}:${action}:${suffix}`, ...(payload ? { payload } : {}) }) })).run;
  }
  async function waitForTerminal(runId, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = (await api(`/v1/runs/${runId}`)).run;
      if (terminalStates.has(current.state)) return current;
      await sleep(500);
    }
    throw new Error(`run_terminal_timeout:${runId}`);
  }
  async function assertCommittedArtifacts(runId) {
    const artifacts = (await api(`/v1/runs/${runId}/artifacts`)).artifacts;
    if (!artifacts?.some((item) => item.origin === "runtime-captured" && item.replicaUris?.some((uri) => uri.startsWith("s3://")))) throw new Error("committed_s3_artifact_missing");
  }

  const initial = await createApprovedRun("initial", { verifyCreateIdempotency: true });
  const crossOrgResponse = await fetch("http://localhost:14317/v1/runs", { method: "POST", headers, body: JSON.stringify({ ...initial.payload, organizationId: "other-organization", idempotencyKey: `${initial.payload.idempotencyKey}:cross-org` }) });
  if (crossOrgResponse.status !== 403) throw new Error(`organization_isolation_failed:${crossOrgResponse.status}`);
  checks.push("idempotent_run_creation", "organization_isolation");
  let run = await grantPermission(initial.run, "initial", true);
  run = await waitForTerminal(run.id);
  await assertCommittedArtifacts(run.id);
  checks.push("oidc_runner_authorized", "queued_worker_execution", "artifact_v2_minio_committed", "duplicate_permission_delivery");

  const pauseRun = await createApprovedRun("pause-resume");
  // Pause at the queued checkpoint instead of racing a fast fixture's browser
  // execution. This also proves the worker cannot execute a paused run after a
  // restart, and resume produces a new versioned BullMQ job.
  docker(["stop", "worker"]);
  let paused = await grantPermission(pauseRun.run, "pause-resume");
  paused = await control(paused, "pause", "pause");
  if (paused.state !== "paused") throw new Error(`pause_state_invalid:${paused.state}`);
  docker(["start", "worker"]);
  paused = await control(paused, "resume", "resume");
  const resumed = await waitForTerminal(paused.id);
  await assertCommittedArtifacts(resumed.id);
  checks.push("pause_resume_worker_restart");

  const cancelRun = await createApprovedRun("cancel");
  let cancelling = await grantPermission(cancelRun.run, "cancel");
  cancelling = await control(cancelling, "cancel", "cancel");
  const cancelled = await waitForTerminal(cancelling.id);
  if (cancelled.state !== "cancelled") throw new Error(`cancel_state_invalid:${cancelled.state}`);
  checks.push("cancel_cleanup_terminal_state");

  const leaseRun = await createApprovedRun("lease-takeover");
  docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-c", `INSERT INTO execution_leases (run_id,worker_id,attempt_id,lease_until,heartbeat_at) VALUES ('${leaseRun.run.id}','fault-injector','expired-attempt',now() - interval '1 second',now()) ON CONFLICT (run_id) DO UPDATE SET lease_until=EXCLUDED.lease_until`]);
  const leaseQueued = await grantPermission(leaseRun.run, "lease-takeover");
  const leaseFinished = await waitForTerminal(leaseQueued.id);
  await assertCommittedArtifacts(leaseFinished.id);
  const attemptCount = docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-Atqc", `SELECT count(*) FROM attempts_v1 WHERE run_id='${leaseFinished.id}'`], { capture: true }).trim();
  if (attemptCount !== "1") throw new Error(`active_attempt_uniqueness_failed:${attemptCount}`);
  checks.push("expired_lease_takeover", "active_attempt_unique");

  docker(["restart", "redis"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const redis = docker(["exec", "-T", "redis", "redis-cli", "-a", process.env.REDIS_PASSWORD, "ping"], { capture: true });
    if (redis.includes("PONG")) break;
    await sleep(1_000);
  }
  const redisRun = await createApprovedRun("redis-reconnect");
  const redisFinished = await waitForTerminal((await grantPermission(redisRun.run, "redis-reconnect")).id);
  await assertCommittedArtifacts(redisFinished.id);
  checks.push("redis_reconnect_delivery");

  docker(["stop", "minio"]);
  const objectFailureRun = await createApprovedRun("object-store-failure");
  const objectFailure = await waitForTerminal((await grantPermission(objectFailureRun.run, "object-store-failure")).id);
  const failedArtifacts = (await api(`/v1/runs/${objectFailure.id}/artifacts`)).artifacts;
  if (!["failed", "blocked", "awaiting-human-review"].includes(objectFailure.state) || failedArtifacts.some((item) => item.replicaUris?.some((uri) => uri.startsWith("s3://")))) {
    throw new Error("minio_failure_rollback_failed");
  }
  docker(["start", "minio"]);
  let minioRecovered = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(["exec", "-T", "minio", "curl", "-fsS", "http://localhost:9000/minio/health/live"], { capture: true });
      minioRecovered = true;
      break;
    } catch { /* wait for MinIO to accept object-store commits again */ }
    await sleep(1_000);
  }
  if (!minioRecovered) throw new Error("minio_restart_timeout");
  checks.push("minio_unavailable_blocks_commit");

  docker(["restart", "postgres"]);
  let postgresRecovered = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const ready = docker(["exec", "-T", "postgres", "pg_isready", "-U", "ai_test_officer"], { capture: true });
      if (ready.includes("accepting connections")) { postgresRecovered = true; break; }
    } catch { /* PostgreSQL is still replaying/rebinding its socket. */ }
    await sleep(1_000);
  }
  if (!postgresRecovered) throw new Error("postgres_restart_timeout");
  // The API and worker reconnect from PostgreSQL events after the database is
  // ready. Restarting them before this point converts a recovery check into a
  // DNS race and hides the actual replay behaviour.
  docker(["restart", "agent-api", "worker"]);
  let apiRecovered = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const health = await fetch("http://localhost:14317/api/health").catch(() => undefined);
    if (health?.ok) { apiRecovered = true; break; }
    await sleep(1_000);
  }
  if (!apiRecovered) throw new Error("api_restart_timeout");
  const recovered = await fetch(`http://localhost:14317/v1/runs/${run.id}`, { headers });
  if (!recovered.ok) throw new Error("postgres_event_recovery_failed");
  checks.push("postgres_api_worker_restart_recovery");
  await save("passed", checks);
} catch (error) {
  await save("failed", checks, [error instanceof Error ? error.message : String(error)]);
  process.exitCode = 1;
} finally {
  if (process.env.KEEP_ACCEPTANCE_STACK !== "1") { try { docker(["down", "--volumes", "--remove-orphans"]); } catch { /* report already contains the primary result */ } }
}
