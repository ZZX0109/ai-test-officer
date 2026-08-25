import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactAcceptanceDiagnostic } from "./production-acceptance-redaction.mjs";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const reportFile = path.join(root, "reports", "production-acceptance", "latest.json");
const startedAt = new Date().toISOString();
const composeProject = `ato-acceptance-${randomUUID().slice(0, 8)}`;
const acceptanceNetworkClient = process.env.ATO_ACCEPTANCE_NETWORK_CLIENT?.trim();
const apiBase = acceptanceNetworkClient ? "http://agent-api:4317" : "http://localhost:14317";
const oidcBase = acceptanceNetworkClient ? "http://keycloak:8080" : "http://127.0.0.1:18080";
let acceptanceNetworkAttached = false;
await mkdir(path.dirname(reportFile), { recursive: true });
const gateSseFaultRequirement = "验证客户门户表格的排序、筛选和分页功能（验收：Gate 提交后崩溃）";
const planApprovalFaultRequirement = "验证客户门户表格的排序、筛选和分页功能（验收：审批写入后崩溃）";
const artifactTemporaryUploadFaultRequirement = "验证客户门户表格的排序、筛选和分页功能（验收：临时上传后崩溃）";
const artifactTemporaryVerifiedFaultRequirement = "验证客户门户表格的排序、筛选和分页功能（验收：临时校验后崩溃）";
const artifactObjectFaultRequirement = "验证客户门户表格的排序、筛选和分页功能（验收：对象提交后崩溃）";
const actionReceiptFaultRunId = `acceptance-action-receipt-${randomUUID()}`;
const actionReceiptFaultActionId = "post-idempotent-write";
const actionReceiptFaultOperationId = "postIdempotentWrite";

// This script provisions an isolated, disposable Compose project. Generate
// secrets only for that local acceptance process so a clean checkout can run
// it without a developer-owned .env; production deployments still require
// externally injected secrets.
function ensureAcceptanceSecrets() {
  const generated = [];
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD"]) {
    if (!process.env[name]) {
      // These values are interpolated into a shell command for `mc alias set`.
      // Base64url may legally begin with `-`, which `mc` then interprets as an
      // option instead of the MinIO access key. Hex is URL/shell-safe and still
      // supplies more than enough entropy for this disposable acceptance stack.
      process.env[name] = randomBytes(24).toString("hex");
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
// The fault hook is disabled unless a Run/event pair matches one of these
// exact rules. Setting it before Compose starts keeps both crash cases at a
// real process boundary rather than a unit-test mock.
process.env.FAULT_INJECTION_ENABLED = "1";
process.env.FAULT_INJECTION_RULES_B64 = Buffer.from(JSON.stringify([
  { eventType: "run_judging", requirement: gateSseFaultRequirement, runKind: "path" },
  { eventType: "plan_approved", requirement: planApprovalFaultRequirement, runKind: "parent" },
  { eventType: "artifact_temporary_object_uploaded", requirement: artifactTemporaryUploadFaultRequirement, runKind: "path" },
  { eventType: "artifact_temporary_object_verified", requirement: artifactTemporaryVerifiedFaultRequirement, runKind: "path" },
  { eventType: "artifact_object_committed", requirement: artifactObjectFaultRequirement, runKind: "path" }
])).toString("base64url");
process.env.JUDGING_RECOVERY_GRACE_MS = "10000";
process.env.PLAN_APPROVAL_RESUME_RECOVERY_GRACE_MS = "10000";

function redact(value) {
  let result = String(value ?? "");
  for (const name of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD", "RUN_EVIDENCE_ED25519_PRIVATE_KEY", "RUN_EVIDENCE_ED25519_PUBLIC_KEY"]) {
    const secret = process.env[name];
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  return redactAcceptanceDiagnostic(result);
}

function composeInvocation() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return { executable: "docker", prefix: ["compose"], supportsWait: true };
  } catch {
    try {
      execFileSync("docker-compose", ["version"], { stdio: "ignore" });
      return { executable: "docker-compose", prefix: [], supportsWait: false };
    } catch {
      throw new Error("docker_compose_unavailable");
    }
  }
}

const composeCli = composeInvocation();

function docker(args, options = {}) {
  try {
    return execFileSync(composeCli.executable, [...composeCli.prefix, "-p", composeProject, "-f", compose, ...args], {
      cwd: root,
      encoding: "utf8",
      // Docker BuildKit can emit a large, highly dynamic progress stream. It
      // is useful in diagnostics, but inheriting it makes the acceptance
      // runner vulnerable to a closed controller output pipe before its own
      // failure report can be written.
      stdio: options.capture ? "pipe" : "inherit",
      // A clean Compose build can emit more than 8 MiB of BuildKit progress
      // across the matrix of API, worker, UI and target images. Keep capture
      // enabled for fail-closed diagnostics without turning a successful
      // image build into an ENOBUFS/compose_command_failed result.
      maxBuffer: 64 * 1024 * 1024,
      env: process.env
    });
  } catch (error) {
    const detail = error && typeof error === "object"
      ? [error.stderr, error.stdout]
        .map((value) => redact(String(value ?? "")).replace(/[\r\n]+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .slice(-500)
      : "";
    throw new Error(`compose_command_failed:${args.join("_")}${detail ? `:${detail}` : ""}`);
  }
}
function dockerCapture(args) {
  try { return redact(docker(args, { capture: true })).slice(-12_000); } catch (error) { return `capture_failed:${redact(error instanceof Error ? error.message : String(error))}`; }
}
function waitForComposeCommand(args, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      docker(args, { capture: true });
      return;
    } catch (error) {
      lastError = error;
    }
    execFileSync("sleep", ["1"]);
  }
  throw lastError instanceof Error ? lastError : new Error(`compose_health_timeout:${args.join("_")}`);
}
function hostDocker(args, options = {}) {
  try {
    return execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: process.env });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? redact(String(error.stderr ?? "")).replace(/[\r\n]+/g, " ").slice(0, 500)
      : "";
    throw new Error(`docker_command_failed:${args.join("_")}${detail ? `:${detail}` : ""}`);
  }
}
function attachAcceptanceNetworkClient() {
  if (!acceptanceNetworkClient) return;
  hostDocker(["network", "connect", `${composeProject}_control`, acceptanceNetworkClient]);
  acceptanceNetworkAttached = true;
}
function detachAcceptanceNetworkClient() {
  if (!acceptanceNetworkAttached || !acceptanceNetworkClient) return;
  try { hostDocker(["network", "disconnect", "-f", `${composeProject}_control`, acceptanceNetworkClient]); } catch { /* Compose teardown will still remove its own networks. */ }
  acceptanceNetworkAttached = false;
}
function proxyPolicyAuthorization(policy) {
  const payload = JSON.stringify(policy);
  const signature = createHmac("sha256", process.env.EGRESS_POLICY_SECRET).update(payload).digest("base64url");
  return Buffer.from(`ato:${Buffer.from(`${payload}.${signature}`).toString("base64url")}`).toString("base64");
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
    "egress-proxy",
    "minio-init",
    "reports-init",
    "todo-lite",
    "order-portal-lite",
    "customer-portal-lite",
    "target-db",
    "target-db-init"
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
  docker(["up", "-d", "--build", ...(composeCli.supportsWait ? ["--wait"] : [])], { capture: true });
  attachAcceptanceNetworkClient();
  checks.push("compose_healthy");
  const egressHealthCommand = ["exec", "-T", "egress-proxy", "node", "-e", "fetch('http://127.0.0.1:3128/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"];
  if (composeCli.supportsWait) docker(egressHealthCommand);
  else waitForComposeCommand(egressHealthCommand);
  checks.push("egress_proxy_healthy");
  const proxyPolicy = { runId: "production-acceptance", attemptId: "egress-audit", policyHash: "production-acceptance-policy", allowedHosts: ["example.com"], allowedPorts: [80, 443] };
  const proxyAuthorization = proxyPolicyAuthorization(proxyPolicy);
  docker(["exec", "-T", "-e", `ATO_TEST_PROXY_AUTH=${proxyAuthorization}`, "egress-proxy", "node", "-e", "const http = require('node:http'); const req = http.request({ host: '127.0.0.1', port: 3128, path: 'http://example.com/', headers: { 'proxy-authorization': `Basic ${process.env.ATO_TEST_PROXY_AUTH}`, 'x-ato-run-id': 'production-acceptance', 'x-ato-attempt-id': 'egress-audit', 'x-ato-policy-sha256': 'production-acceptance-policy' } }, response => { response.resume(); response.on('end', () => process.exit(response.statusCode && response.statusCode < 500 ? 0 : 1)); }); req.on('error', () => process.exit(1)); req.end();"]);
  checks.push("egress_proxy_policy_request");
  const seededCustomers = docker(["exec", "-T", "target-db", "psql", "-U", "target_app", "-d", "target_app", "-Atqc", "SELECT count(*) FROM customers"], { capture: true }).trim();
  if (seededCustomers !== "2") throw new Error(`target_database_seed_failed:${seededCustomers}`);
  checks.push("target_database_migration_seed");
  const applicationCustomers = docker(["exec", "-T", "customer-portal-lite", "node", "-e", "fetch('http://127.0.0.1:7103/api/customers?query=Globex').then(async r => { const body = await r.json(); if (!r.ok || !body.items?.includes('Globex Expansion')) process.exit(1); }).catch(() => process.exit(1))"]);
  checks.push("target_database_application_query");
  const acceptancePassword = ["acceptance-runner", "change-me"].join("-");
  async function obtainAccessToken() {
    let tokenResponse;
    let tokenFailure = "unavailable";
    // A cold Keycloak 26 image performs Quarkus augmentation before serving the
    // imported realm and can legitimately need more than one minute on laptops.
    for (let attempt = 0; attempt < 180; attempt += 1) {
      tokenResponse = await fetch(`${oidcBase}/realms/ai-test-officer/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "ai-test-officer-local", username: "acceptance-runner", password: acceptancePassword }) }).catch((error) => {
        tokenFailure = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 120) : "unavailable";
        return undefined;
      });
      if (tokenResponse?.ok) return (await tokenResponse.json()).access_token;
      if (tokenResponse) tokenFailure = `${tokenResponse.status}:${(await tokenResponse.text()).replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160)}`;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`oidc_token_${tokenFailure}`);
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${await obtainAccessToken()}` };
  const terminalStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function api(pathname, options = {}) {
    let lastError;
    let refreshedToken = false;
    // Restart/reconnect checks intentionally create short periods in which the
    // socket can be reset even though the API container remains healthy.
    // Every acceptance mutation carries an idempotency key, so retrying a
    // transport failure cannot duplicate state.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await fetch(`${apiBase}${pathname}`, {
          headers,
          ...options,
          signal: AbortSignal.timeout(5_000)
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        if (response.status === 401 && !refreshedToken) {
          headers.authorization = `Bearer ${await obtainAccessToken()}`;
          refreshedToken = true;
          continue;
        }
        if (![502, 503, 504].includes(response.status)) {
          // Keep the report secret-safe, but include an API error code so a
          // failed workflow can be diagnosed without preserving whole bodies.
          const detail = [payload?.error, payload?.runState]
            .filter((value) => typeof value === "string" && /^[a-z0-9_-]+$/i.test(value))
            .join(":");
          throw new Error(`acceptance_api_${response.status}:${pathname}${detail ? `:${detail}` : ""}`);
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
  function newPayload(suffix, inputOverrides = {}) {
    // A production run must include a requirement: active Graph planning
    // deliberately fail-closes ambiguous requests into human review. Supplying
    // the same real goal as the registered scenario lets this acceptance test
    // exercise planning, approval, execution and recovery rather than bypass
    // that safety policy.
    return { organizationId: "benchmark", actor: "acceptance-runner", idempotencyKey: `acceptance:${suffix}:${Date.now()}`, input: { appUrl: "http://customer-portal-lite:7103", requirement: "验证客户门户表格的排序、筛选和分页功能", diff: "客户门户列表筛选与分页逻辑变更", scenarioId: "generic_table_sort_filter_pagination", plannerMode: "deterministic", judgeMode: "deterministic", executionMode: "oci", capabilities: ["browser"], permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false }, ...inputOverrides } };
  }
  async function createApprovedRun(suffix, options = {}) {
    const payload = newPayload(suffix, options.input);
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
    // Graph nodes can persist a progress projection between the caller reading
    // a Run and submitting a control command. The Workbench follows the same
    // optimistic-concurrency protocol: refresh once on a version conflict and
    // retry the *same idempotency key*, never blindly duplicate the action.
    let current = run;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return (await api(`/v1/runs/${current.id}/${action}`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: current.version,
            actor: "acceptance-runner",
            idempotencyKey: `${current.id}:${action}:${suffix}`,
            ...(payload ? { payload } : {})
          })
        })).run;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("run_version_conflict") || attempt === 1) throw error;
        current = (await api(`/v1/runs/${current.id}`)).run;
        if (terminalStates.has(current.state)) return current;
      }
    }
    throw new Error(`control_retry_exhausted:${action}`);
  }
  async function waitForTerminal(runId, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "unknown";
    let lastVersion = "unknown";
    while (Date.now() < deadline) {
      const current = (await api(`/v1/runs/${runId}`)).run;
      lastState = String(current.state ?? "unknown");
      lastVersion = String(current.version ?? "unknown");
      if (terminalStates.has(current.state)) return current;
      await sleep(500);
    }
    throw new Error(`run_terminal_timeout:${runId}:${lastState}:v${lastVersion}`);
  }
  async function waitForState(runId, expected, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "unknown";
    while (Date.now() < deadline) {
      const current = (await api(`/v1/runs/${runId}`)).run;
      lastState = String(current.state ?? "unknown");
      if (expected.has(lastState)) return current;
      await sleep(100);
    }
    throw new Error(`run_state_timeout:${runId}:${Array.from(expected).join("_")}:${lastState}`);
  }
  async function waitForAgentInterrupt(runId, interruptKind, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastKind = "unknown";
    while (Date.now() < deadline) {
      const agent = (await api(`/v1/runs/${runId}/agent`)).agent;
      lastKind = String(agent?.pendingInterrupt?.kind ?? "none");
      if (agent?.status === "interrupted" && agent?.pendingInterrupt?.kind === interruptKind) return agent;
      await sleep(250);
    }
    throw new Error(`agent_interrupt_timeout:${runId}:${interruptKind}:${lastKind}`);
  }
  async function waitForCoverageChildRun(parentRunId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const coverage = await api(`/v1/runs/${parentRunId}/coverage`);
      const childRunId = coverage.coverage?.find((item) => typeof item.childRunId === "string")?.childRunId;
      if (childRunId) return childRunId;
      await sleep(100);
    }
    throw new Error(`worker_sigkill_child_run_missing:${parentRunId}`);
  }
  async function waitForWorkerFaultMarker(eventType, runId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    const marker = `[fault-injection] committed_run_event:${eventType}:${runId}`;
    while (Date.now() < deadline) {
      if (dockerCapture(["logs", "worker"]).includes(marker)) return;
      await sleep(200);
    }
    throw new Error(`fault_injection_marker_timeout:${eventType}:${runId}`);
  }
  function listObjectKeys(prefix) {
    const command = [
      "import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';",
      "const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.ARTIFACT_S3_ENDPOINT, forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === '1' });",
      `const result = await client.send(new ListObjectsV2Command({ Bucket: 'ai-test-officer', Prefix: ${JSON.stringify(prefix)} }));`,
      "console.log(JSON.stringify((result.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : [])));"
    ].join(" ");
    return JSON.parse(docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", command], { capture: true }));
  }
  function injectOutOfOrderQueueMessages(runId, version) {
    if (!Number.isInteger(version) || version < 1) throw new Error(`queue_reorder_invalid_version:${version}`);
    const staleVersion = version - 1;
    const command = [
      "import { Queue } from 'bullmq';",
      "const url = new URL(process.env.REDIS_URL);",
      "const connection = { host: url.hostname, port: Number(url.port || 6379), username: url.username || undefined, password: url.password || undefined, db: Number(url.pathname.slice(1) || 0), maxRetriesPerRequest: null };",
      "const queue = new Queue(process.env.RUN_QUEUE_NAME ?? 'ai-test-officer-runs', { connection });",
      `await queue.add('execute', { runId: ${JSON.stringify(runId)}, version: ${version}, jobId: ${JSON.stringify(`${runId}-delayed-current-v${version}`)} }, { jobId: ${JSON.stringify(`${runId}-delayed-current-v${version}`)}, delay: 1500, removeOnComplete: 500, removeOnFail: 500 });`,
      `await queue.add('execute', { runId: ${JSON.stringify(runId)}, version: ${staleVersion}, jobId: ${JSON.stringify(`${runId}-stale-v${staleVersion}`)} }, { jobId: ${JSON.stringify(`${runId}-stale-v${staleVersion}`)}, removeOnComplete: 500, removeOnFail: 500 });`,
      "await queue.close();"
    ].join(" ");
    docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", command]);
  }
  function actionReceiptInvocation() {
    return [
      "import { executeStructuredAction } from './agent/dist/structuredActionExecutors.js';",
      `const manifest = { schemaVersion: '1.0', projectId: 'acceptance-action-receipt', workspaceRoot: '.', commands: {}, commandAllowlist: ['node'], network: { mode: 'allow-target', allowedHosts: ['customer-portal-lite'] }, fixtures: [], apiOperations: [{ operationId: ${JSON.stringify(actionReceiptFaultOperationId)}, method: 'POST', pathTemplate: '/api/test-idempotent-write', baseUrlRef: 'backend', allowedStatusCodes: [201], idempotency: { requestHeader: 'Idempotency-Key', responseHeader: 'Idempotency-Key' } }], dataSources: [], backgroundTasks: [], execution: { mode: 'oci', image: 'node:22-alpine', engine: 'docker' } };`,
      `const project = { id: 'acceptance-action-receipt', name: 'Acceptance action receipt', projectPath: '/app', allowExternalProjectPath: true, frontendUrl: 'http://customer-portal-lite:7103', backendUrl: 'http://customer-portal-lite:7103', login: { method: 'none' }, env: {}, manifest, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };`,
      `const result = await executeStructuredAction({ action: { action: 'api-request', operationId: ${JSON.stringify(actionReceiptFaultOperationId)}, oracleId: 'idempotent-write' }, manifest, project, target: { frontendUrl: project.frontendUrl, backendUrl: project.backendUrl }, runId: ${JSON.stringify(actionReceiptFaultRunId)}, actionId: ${JSON.stringify(actionReceiptFaultActionId)} });`,
      "if (!result.passed) process.exit(1);",
      "console.log(JSON.stringify(result));"
    ].join(" ");
  }
  function readActionReceiptTarget(key) {
    const command = `const response = await fetch(${JSON.stringify(`http://customer-portal-lite:7103/api/test-idempotent-write?key=${encodeURIComponent(key)}`)}); if (!response.ok) process.exit(1); console.log(JSON.stringify(await response.json()));`;
    return JSON.parse(docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", command], { capture: true }));
  }
  function actionReceiptStatus() {
    return docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-Atqc", `SELECT status FROM action_execution_receipts_v1 WHERE run_id='${actionReceiptFaultRunId}' AND action_id='${actionReceiptFaultActionId}'`], { capture: true }).trim();
  }
  async function waitForPendingActionReceipt(key, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = readActionReceiptTarget(key);
      if (target.ok === true && target.writeCount === 1 && actionReceiptStatus() === "pending") return;
      await sleep(200);
    }
    throw new Error("action_receipt_post_effect_pending_checkpoint_missing");
  }
  async function waitForApiRecovery(errorCode) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const health = await fetch(`${apiBase}/api/health`).catch(() => undefined);
      if (health?.ok) return;
      await sleep(1_000);
    }
    throw new Error(errorCode);
  }
  async function assertSseReplayIncludesRunEvent(runId, eventType) {
    const controller = new AbortController();
    const response = await fetch(`${apiBase}/v1/runs/${runId}/stream`, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(`gate_sse_post_commit_stream_unavailable:${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      const payload = new TextDecoder().decode(first.value ?? new Uint8Array());
      if (!payload.includes(`\"type\":\"${eventType}\"`)) {
        throw new Error(`gate_sse_post_commit_replay_event_missing:${eventType}`);
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }
  async function assertCommittedArtifacts(runId) {
    const artifacts = (await api(`/v1/runs/${runId}/artifacts`)).artifacts;
    if (!artifacts?.some((item) => item.origin === "runtime-captured" && item.replicaUris?.some((uri) => uri.startsWith("s3://")))) throw new Error("committed_s3_artifact_missing");
  }
  function assertOutboxDrained(runId) {
    const pending = docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-Atqc", `SELECT count(*) FROM event_outbox_v1 WHERE aggregate_id='${runId}' AND status <> 'published'`], { capture: true }).trim();
    if (pending !== "0") throw new Error(`outbox_pending_after_terminal:${runId}:${pending}`);
    const publishedExecution = docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-Atqc", `SELECT count(*) FROM event_outbox_v1 WHERE aggregate_id='${runId}' AND topic='run.execute' AND status='published'`], { capture: true }).trim();
    if (Number(publishedExecution) < 1) throw new Error(`outbox_execution_not_published:${runId}`);
  }

  const initial = await createApprovedRun("initial", { verifyCreateIdempotency: true });
  const crossOrgResponse = await fetch(`${apiBase}/v1/runs`, { method: "POST", headers, body: JSON.stringify({ ...initial.payload, organizationId: "other-organization", idempotencyKey: `${initial.payload.idempotencyKey}:cross-org` }) });
  if (crossOrgResponse.status !== 403) throw new Error(`organization_isolation_failed:${crossOrgResponse.status}`);
  checks.push("idempotent_run_creation", "organization_isolation");
  let run = await grantPermission(initial.run, "initial", true);
  run = await waitForTerminal(run.id);
  await assertCommittedArtifacts(run.id);
  assertOutboxDrained(run.id);
  checks.push("oidc_runner_authorized", "queued_worker_execution", "artifact_v2_minio_committed", "duplicate_permission_delivery", "outbox_dispatch_committed");

  // SSE is strictly a projection transport. A client losing its stream must
  // never mutate durable Run state; a fresh GET is the authority used by the
  // Workbench to resume its display after reconnecting.
  const sseBeforeDisconnect = (await api(`/v1/runs/${run.id}`)).run;
  const sseAbort = new AbortController();
  const sseResponse = await fetch(`${apiBase}/v1/runs/${run.id}/stream`, { headers, signal: sseAbort.signal });
  const sseContentType = sseResponse.headers.get("content-type") ?? "none";
  if (!sseResponse.ok) {
    const detail = (await sseResponse.text()).replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160);
    throw new Error(`sse_disconnect_stream_not_opened:${sseResponse.status}:${detail}`);
  }
  if (!sseContentType.includes("text/event-stream") || !sseResponse.body) {
    sseAbort.abort();
    throw new Error(`sse_disconnect_stream_not_opened:${sseResponse.status}:${sseContentType.replace(/[^a-zA-Z0-9_:\/-]/g, "_")}:${sseResponse.body ? "body" : "no-body"}`);
  }
  const sseReader = sseResponse.body.getReader();
  await sseReader.read();
  sseAbort.abort();
  await sseReader.cancel().catch(() => undefined);
  await sleep(100);
  const sseAfterDisconnect = (await api(`/v1/runs/${run.id}`)).run;
  if (sseAfterDisconnect.id !== sseBeforeDisconnect.id || sseAfterDisconnect.version !== sseBeforeDisconnect.version || sseAfterDisconnect.state !== sseBeforeDisconnect.state) {
    throw new Error("sse_disconnect_durable_state_changed");
  }
  checks.push("sse_disconnect_query_recovery");

  // A successful upload is not a permanent proof: if an operator, lifecycle
  // policy or storage fault removes the committed replica later, the durable
  // Artifact ledger must record it and the API must stop presenting the old
  // Run Bundle's pass as a live release decision.
  const committedArtifact = (await api(`/v1/runs/${run.id}/artifacts`)).artifacts
    ?.find((item) => item.origin === "runtime-captured" && item.replicaUris?.some((uri) => uri.startsWith("s3://")));
  const replicaUri = committedArtifact?.replicaUris?.find((uri) => uri.startsWith("s3://"));
  const replicaMatch = typeof replicaUri === "string" ? /^s3:\/\/([^/]+)\/(.+)$/.exec(replicaUri) : undefined;
  if (!replicaMatch) throw new Error("artifact_reconciliation_fixture_missing_replica");
  const [, replicaBucket, replicaKey] = replicaMatch;
  docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", [
    "import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';",
    "const client = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.ARTIFACT_S3_ENDPOINT, forcePathStyle: process.env.ARTIFACT_S3_FORCE_PATH_STYLE === '1' });",
    `await client.send(new DeleteObjectCommand({ Bucket: ${JSON.stringify(replicaBucket)}, Key: ${JSON.stringify(replicaKey)} }));`
  ].join(" ")]);
  docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", [
    "import { reconcileConfiguredArtifactStore } from './agent/dist/artifactObjectReconciliation.js';",
    "const result = await reconcileConfiguredArtifactStore({ apply: true });",
    `if (!result.missingReferences.some((item) => item.id === ${JSON.stringify(committedArtifact.id)} || item.artifactId === ${JSON.stringify(committedArtifact.id)})) process.exit(1);`
  ].join(" ")]);
  const reconciledReport = await api(`/v1/runs/${run.id}/report`);
  if (reconciledReport.report?.finalStatus !== "blocked" || reconciledReport.report?.machineGate?.status !== "blocked") {
    throw new Error("artifact_reconciliation_gate_not_blocked");
  }
  const reconciledSlo = await api("/api/operations/slo");
  if (!reconciledSlo.slo?.alerts?.some((alert) => alert.id === "artifact_replica_missing" && alert.severity === "critical")) {
    throw new Error("operational_slo_missing_artifact_alert_failed");
  }
  checks.push("artifact_reconciliation_blocks_stale_replica", "operational_slo_alerts_stale_replica");

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
  assertOutboxDrained(resumed.id);
  checks.push("pause_resume_worker_restart");

  // A transient Worker control-plane network loss must not manufacture a
  // terminal result or drop the queued path. BullMQ reconnects after the
  // network returns; PostgreSQL Outbox remains the durable delivery record.
  const workerContainer = docker(["ps", "-q", "worker"], { capture: true }).trim();
  if (!workerContainer) throw new Error("worker_network_fault_worker_missing");
  const workerInspect = JSON.parse(hostDocker(["inspect", workerContainer], { capture: true }));
  const controlNetwork = Object.keys(workerInspect[0]?.NetworkSettings?.Networks ?? {})
    .find((name) => name.endsWith("_control"));
  if (!controlNetwork) throw new Error("worker_network_fault_control_network_missing");
  hostDocker(["network", "disconnect", controlNetwork, workerContainer]);
  const disconnectedWorkerRun = await createApprovedRun("worker-network-disconnect");
  const disconnectedWorkerQueued = await grantPermission(disconnectedWorkerRun.run, "worker-network-disconnect");
  await sleep(1_000);
  hostDocker(["network", "connect", controlNetwork, workerContainer]);
  const workerNetworkRecovered = await waitForTerminal(disconnectedWorkerQueued.id, 60_000);
  await assertCommittedArtifacts(workerNetworkRecovered.id);
  assertOutboxDrained(workerNetworkRecovered.id);
  checks.push("worker_network_disconnect_recovery");

  // Deliver a stale generation before the real Outbox job, then deliver a
  // delayed duplicate of the real generation after completion. The Worker must
  // reject the stale generation, execute exactly one child path, and leave the
  // durable terminal projection unchanged when the delayed message arrives.
  const reorderedRun = await createApprovedRun("queue-reordered-delayed");
  docker(["stop", "worker"]);
  const reorderedQueued = await grantPermission(reorderedRun.run, "queue-reordered-delayed");
  injectOutOfOrderQueueMessages(reorderedQueued.id, reorderedQueued.version);
  docker(["start", "worker"]);
  const reorderedTerminal = await waitForTerminal(reorderedQueued.id, 60_000);
  const reorderedCoverage = (await api(`/v1/runs/${reorderedQueued.id}/coverage`)).coverage ?? [];
  const reorderedChildRunIds = Array.from(new Set(reorderedCoverage.map((item) => item.childRunId).filter((id) => typeof id === "string")));
  if (reorderedChildRunIds.length !== 1) throw new Error(`queue_reorder_child_run_count:${reorderedChildRunIds.length}`);
  await assertCommittedArtifacts(reorderedChildRunIds[0]);
  assertOutboxDrained(reorderedQueued.id);
  const terminalEventsBeforeDelay = (await api(`/v1/runs/${reorderedQueued.id}/events`)).events
    .filter((event) => ["run_completed", "run_failed", "run_blocked", "run_cancelled"].includes(event.type));
  await sleep(2_000);
  const reorderedAfterDelay = (await api(`/v1/runs/${reorderedQueued.id}`)).run;
  const terminalEventsAfterDelay = (await api(`/v1/runs/${reorderedQueued.id}/events`)).events
    .filter((event) => ["run_completed", "run_failed", "run_blocked", "run_cancelled"].includes(event.type));
  if (reorderedAfterDelay.version !== reorderedTerminal.version || reorderedAfterDelay.state !== reorderedTerminal.state || terminalEventsBeforeDelay.length !== 1 || terminalEventsAfterDelay.length !== 1) {
    throw new Error("queue_reorder_delayed_delivery_changed_terminal");
  }
  checks.push("queue_out_of_order_generation_fence", "queue_delayed_delivery_single_terminal");

  // A target-side POST is committed before the local receipt is completed.
  // Kill the API container at that exact fact, then re-run the same action.
  // The stable key must keep the target's write count at one while the durable
  // PostgreSQL receipt moves from pending to completed.
  const actionReceiptKey = `ato_${createHash("sha256").update(JSON.stringify([actionReceiptFaultRunId, actionReceiptFaultActionId, actionReceiptFaultOperationId])).digest("hex")}`;
  const actionReceiptFaultRule = Buffer.from(JSON.stringify({
    runId: actionReceiptFaultRunId,
    actionId: actionReceiptFaultActionId,
    operationId: actionReceiptFaultOperationId
  })).toString("base64url");
  docker(["exec", "-T", "-d", "-e", `ACTION_RECEIPT_FAULT_RULE_B64=${actionReceiptFaultRule}`, "agent-api", "node", "--input-type=module", "-e", actionReceiptInvocation()]);
  await waitForPendingActionReceipt(actionReceiptKey);
  docker(["kill", "agent-api"]);
  await sleep(250);
  docker(["start", "agent-api"]);
  await waitForApiRecovery("action_receipt_api_restart_timeout");
  docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", actionReceiptInvocation()], { capture: true });
  const actionReceiptTarget = readActionReceiptTarget(actionReceiptKey);
  if (actionReceiptTarget.writeCount !== 1 || actionReceiptStatus() !== "completed") {
    throw new Error("action_receipt_retry_duplicate_or_incomplete");
  }
  checks.push("mutable_api_post_effect_sigkill_recovery", "mutable_api_post_effect_single_side_effect");

  // Each Artifact checkpoint is a real process crash after the named S3 fact
  // exists but before the next metadata transition. The recovered attempt must
  // complete once, and reconciliation must remove the first attempt's object
  // without letting a later ledger row adopt it.
  async function recoverArtifactStoreFault(input) {
    const faultRun = await createApprovedRun(input.suffix, { input: { requirement: input.requirement } });
    const queued = await grantPermission(faultRun.run, input.suffix);
    const childRunId = await waitForCoverageChildRun(queued.id);
    await waitForWorkerFaultMarker(input.eventType, childRunId);
    const abandonedKeys = listObjectKeys(input.objectPrefix(childRunId));
    if (abandonedKeys.length === 0) throw new Error(`${input.checkPrefix}_orphan_missing`);
    docker(["kill", "worker"]);
    await sleep(250);
    docker(["start", "worker"]);
    const recoveredChild = await waitForTerminal(childRunId, 150_000);
    await waitForTerminal(queued.id, 150_000);
    await assertCommittedArtifacts(recoveredChild.id);
    assertOutboxDrained(recoveredChild.id);
    const reconciliationOutput = docker(["exec", "-T", "agent-api", "node", "--input-type=module", "-e", [
      "import { reconcileConfiguredArtifactStore } from './agent/dist/artifactObjectReconciliation.js';",
      "console.log(JSON.stringify(await reconcileConfiguredArtifactStore({ apply: true, orphanGraceMs: 0, partialGraceMs: 0 })));"
    ].join(" ")], { capture: true });
    const reconciliation = JSON.parse(reconciliationOutput);
    const reconciledKeys = reconciliation[input.reconciliationField];
    if (!Array.isArray(reconciledKeys) || !reconciledKeys.some((key) => abandonedKeys.includes(key)) || reconciliation.deletedObjects < 1) {
      throw new Error(`${input.checkPrefix}_orphan_not_reconciled`);
    }
    if (input.rejectLedgerAdoption) {
      const artifacts = (await api(`/v1/runs/${recoveredChild.id}/artifacts`)).artifacts;
      if (artifacts.some((artifact) => artifact.replicaUris?.some((uri) => abandonedKeys.some((key) => uri.endsWith(`/${key}`))))) {
        throw new Error(`${input.checkPrefix}_orphan_adopted`);
      }
    }
    const events = (await api(`/v1/runs/${recoveredChild.id}/events`)).events;
    if (!events.some((event) => event.type === "run_retrying" && event.payload?.reason === "worker_lease_expired")) {
      throw new Error(`${input.checkPrefix}_recovery_trace_missing`);
    }
  }
  await recoverArtifactStoreFault({
    suffix: "artifact-temporary-upload-sigkill",
    requirement: artifactTemporaryUploadFaultRequirement,
    eventType: "artifact_temporary_object_uploaded",
    objectPrefix: (runId) => `ai-test-officer/.partial/${runId}`,
    reconciliationField: "stalePartialObjectKeys",
    checkPrefix: "artifact_temporary_upload"
  });
  await recoverArtifactStoreFault({
    suffix: "artifact-temporary-verified-sigkill",
    requirement: artifactTemporaryVerifiedFaultRequirement,
    eventType: "artifact_temporary_object_verified",
    objectPrefix: (runId) => `ai-test-officer/.partial/${runId}`,
    reconciliationField: "stalePartialObjectKeys",
    checkPrefix: "artifact_temporary_verified"
  });
  await recoverArtifactStoreFault({
    suffix: "artifact-object-commit-sigkill",
    requirement: artifactObjectFaultRequirement,
    eventType: "artifact_object_committed",
    objectPrefix: (runId) => `ai-test-officer/${runId}/`,
    reconciliationField: "orphanObjectKeys",
    checkPrefix: "artifact_object_commit",
    rejectLedgerAdoption: true
  });
  checks.push(
    "artifact_temporary_upload_sigkill_recovery",
    "artifact_temporary_upload_orphan_reconciled",
    "artifact_temporary_verified_sigkill_recovery",
    "artifact_temporary_verified_orphan_reconciled",
    "artifact_object_commit_sigkill_recovery",
    "artifact_object_commit_orphan_reconciled",
    "artifact_object_commit_no_orphan_adoption"
  );

  // This is a hard process crash, not a cooperative pause: the owning Worker
  // loses its in-memory controller and its BullMQ lock. The restarted service
  // must rediscover the stalled delivery, wait for the old Lease to expire,
  // and converge on one durable terminal outcome. Individual attempts remain
  // immutable recovery history rather than being silently overwritten.
  const crashRun = await createApprovedRun("worker-sigkill-running");
  docker(["stop", "worker"]);
  const crashQueued = await grantPermission(crashRun.run, "worker-sigkill-running");
  docker(["start", "worker"]);
  const crashChildRunId = await waitForCoverageChildRun(crashQueued.id);
  await waitForState(crashChildRunId, new Set(["running"]));
  docker(["kill", "worker"]);
  // `docker compose kill` deliberately bypasses the service manager in this
  // disposable harness. Start a replacement explicitly, which models the
  // scheduler/Kubernetes restart that owns a production worker process; the
  // replacement's stalled-job checker must then recover the abandoned lock.
  await sleep(250);
  docker(["start", "worker"]);
  const crashRecoveredChild = await waitForTerminal(crashChildRunId, 90_000);
  await waitForTerminal(crashQueued.id, 90_000);
  await assertCommittedArtifacts(crashRecoveredChild.id);
  assertOutboxDrained(crashRecoveredChild.id);
  const crashEvents = (await api(`/v1/runs/${crashRecoveredChild.id}/events`)).events;
  if (!crashEvents.some((event) => event.type === "run_retrying" && event.payload?.reason === "worker_lease_expired")) {
    throw new Error("worker_sigkill_recovery_trace_missing");
  }
  const terminalOutcomeCount = crashEvents.filter((event) => ["run_completed", "run_failed", "run_blocked", "run_cancelled"].includes(event.type)).length;
  if (terminalOutcomeCount !== 1) throw new Error(`worker_sigkill_duplicate_terminal_outcome:${terminalOutcomeCount}`);
  checks.push("worker_sigkill_running_recovery", "worker_sigkill_recovery_trace", "worker_sigkill_single_terminal_outcome");

  // `plan_approved` is the other human-decision boundary: PostgreSQL may
  // commit the approval before the API can resume the plan-approval Graph
  // interrupt. Keep the Worker stopped so recovery must come from the
  // restarted API process, then prove that the subsequent browser permission
  // still requires an explicit user action.
  const approvalFaultPayload = newPayload("plan-approval-post-commit", {
    requirement: planApprovalFaultRequirement
  });
  const approvalFaultCreated = (await api("/v1/runs", {
    method: "POST",
    body: JSON.stringify(approvalFaultPayload)
  })).run;
  docker(["stop", "worker"]);
  const approvalFaultRequest = fetch(`${apiBase}/v1/runs/${approvalFaultCreated.id}/plan-approval`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedVersion: approvalFaultCreated.version,
      actor: "acceptance-runner",
      idempotencyKey: `${approvalFaultCreated.id}:plan-approval-post-commit`
    })
  }).catch(() => undefined);
  const approvalFaultPersisted = await waitForState(approvalFaultCreated.id, new Set(["awaiting-permission"]));
  if (approvalFaultPersisted.state !== "awaiting-permission") {
    throw new Error(`approval_post_commit_state_invalid:${approvalFaultPersisted.state}`);
  }
  const approvalFaultEventsBeforeCrash = (await api(`/v1/runs/${approvalFaultCreated.id}/events`)).events;
  if (approvalFaultEventsBeforeCrash.filter((event) => event.type === "plan_approved").length !== 1) {
    throw new Error("approval_post_commit_event_not_unique_before_crash");
  }
  docker(["kill", "agent-api"]);
  await sleep(250);
  docker(["start", "agent-api"]);
  await waitForApiRecovery("approval_post_commit_api_restart_timeout");
  await waitForAgentInterrupt(approvalFaultCreated.id, "browser-permission", 60_000);
  await approvalFaultRequest;
  const approvalFaultAfterRecovery = (await api(`/v1/runs/${approvalFaultCreated.id}`)).run;
  const approvalFaultEventsAfterRecovery = (await api(`/v1/runs/${approvalFaultCreated.id}/events`)).events;
  if (approvalFaultEventsAfterRecovery.filter((event) => event.type === "plan_approved").length !== 1) {
    throw new Error("approval_post_commit_duplicate_approval");
  }
  docker(["start", "worker"]);
  const approvalFaultFinished = await waitForTerminal((await grantPermission(approvalFaultAfterRecovery, "plan-approval-post-commit")).id, 90_000);
  await assertCommittedArtifacts(approvalFaultFinished.id);
  assertOutboxDrained(approvalFaultFinished.id);
  checks.push("approval_post_commit_sigkill_recovery", "approval_post_commit_graph_resume", "approval_post_commit_single_approval");

  // `run_judging` is the exact boundary where a verified Machine Gate has
  // entered PostgreSQL but the graph call has not yet advanced its checkpoint.
  // Do not open an SSE stream before the kill: that makes the following
  // assertion about reconnect/replay rather than merely observing a live
  // update. The test-only hook pauses only this tagged Child Run immediately
  // after the transaction commits; Docker SIGKILL then models a real Worker
  // loss at the Gate/SSE boundary.
  const gateSseRun = await createApprovedRun("gate-sse-post-commit", {
    input: { requirement: gateSseFaultRequirement }
  });
  docker(["stop", "worker"]);
  const gateSseQueued = await grantPermission(gateSseRun.run, "gate-sse-post-commit");
  docker(["start", "worker"]);
  const gateSseChildRunId = await waitForCoverageChildRun(gateSseQueued.id);
  const gateSsePersisted = await waitForState(gateSseChildRunId, new Set(["judging"]), 60_000);
  if (!gateSsePersisted.machineGate) throw new Error("gate_sse_post_commit_machine_gate_missing");
  const gateSseBeforeCrashEvents = (await api(`/v1/runs/${gateSseChildRunId}/events`)).events;
  if (gateSseBeforeCrashEvents.filter((event) => event.type === "run_judging").length !== 1) {
    throw new Error("gate_sse_post_commit_gate_event_not_unique_before_crash");
  }
  docker(["kill", "worker"]);
  await sleep(250);
  docker(["start", "worker"]);
  const gateSseRecoveredChild = await waitForTerminal(gateSseChildRunId, 90_000);
  await waitForTerminal(gateSseQueued.id, 90_000);
  await assertCommittedArtifacts(gateSseRecoveredChild.id);
  assertOutboxDrained(gateSseRecoveredChild.id);
  const gateSseEvents = (await api(`/v1/runs/${gateSseRecoveredChild.id}/events`)).events;
  if (gateSseEvents.filter((event) => event.type === "run_judging").length !== 1) {
    throw new Error("gate_sse_post_commit_duplicate_gate_event");
  }
  const gateSseTerminalEvents = gateSseEvents.filter((event) => ["run_completed", "run_failed", "run_blocked", "human_review_requested"].includes(event.type));
  if (gateSseTerminalEvents.length !== 1 || gateSseTerminalEvents[0]?.payload?.recoveryReason !== "stalled_judging_checkpoint_after_gate_commit") {
    throw new Error(`gate_sse_post_commit_recovery_trace_invalid:${gateSseTerminalEvents.length}`);
  }
  const gateSseLeaseCount = docker(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-Atqc", `SELECT count(*) FROM execution_leases WHERE run_id='${gateSseChildRunId}'`], { capture: true }).trim();
  if (gateSseLeaseCount !== "0") throw new Error(`gate_sse_post_commit_orphan_lease:${gateSseLeaseCount}`);
  await assertSseReplayIncludesRunEvent(gateSseChildRunId, "run_judging");
  checks.push("gate_sse_post_commit_sigkill_recovery", "gate_sse_post_commit_recovery_trace", "gate_sse_post_commit_sse_replay");

  // Restart the API while a durable graph is already waiting for a Worker
  // result. The API owns neither the queue message nor the terminal state: the
  // parent checkpoint and Run Event Store must let a restarted API accept the
  // eventual Worker resume exactly once.
  const apiRestartRun = await createApprovedRun("api-restart-queued-run");
  docker(["stop", "worker"]);
  const apiRestartQueued = await grantPermission(apiRestartRun.run, "api-restart-queued-run");
  docker(["restart", "agent-api"]);
  await waitForApiRecovery("api_restart_queued_run_timeout");
  docker(["start", "worker"]);
  const apiRestartFinished = await waitForTerminal(apiRestartQueued.id);
  await assertCommittedArtifacts(apiRestartFinished.id);
  assertOutboxDrained(apiRestartFinished.id);
  checks.push("queued_run_agent_api_restart_recovery");

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
  assertOutboxDrained(leaseFinished.id);
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
  await waitForApiRecovery("api_restart_timeout");
  const recovered = await fetch(`${apiBase}/v1/runs/${run.id}`, { headers });
  if (!recovered.ok) throw new Error("postgres_event_recovery_failed");
  checks.push("postgres_api_worker_restart_recovery");
  docker(["exec", "-T", "egress-proxy", "sh", "-c", "test -s /var/log/ato/egress.jsonl && grep -q 'runId' /var/log/ato/egress.jsonl"]);
  checks.push("egress_audit_persisted");
  await save("passed", checks);
} catch (error) {
  await save("failed", checks, [error instanceof Error ? error.message : String(error)]);
  process.exitCode = 1;
} finally {
  detachAcceptanceNetworkClient();
  if (process.env.KEEP_ACCEPTANCE_STACK !== "1") { try { docker(["down", "--volumes", "--remove-orphans"]); } catch { /* report already contains the primary result */ } }
}
