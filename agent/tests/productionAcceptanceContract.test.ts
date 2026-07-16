import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testProductionAcceptanceContract() {
  const compose = await readFile(path.join(rootDir, "deploy", "production-acceptance", "compose.yml"), "utf8");
  for (const service of ["postgres:", "redis:", "minio:", "keycloak:", "reports-init:", "agent-api:", "worker:", "todo-lite:", "order-portal-lite:", "customer-portal-lite:"]) assert.match(compose, new RegExp(`^  ${service}`, "m"));
  assert.match(compose, /NODE_ENV: production/);
  assert.match(compose, /DATABASE_URL:/);
  assert.match(compose, /REDIS_URL:/);
  assert.match(compose, /ARTIFACT_S3_BUCKET:/);
  assert.match(compose, /OIDC_ISSUER:/);
  assert.match(compose, /reports-init: \{ condition: service_completed_successfully \}/);
  assert.doesNotMatch(compose, /AGENT_API_TOKEN:/);
  assert.equal((compose.match(/target: benchmark-target/g) ?? []).length, 3);
  const dockerfile = await readFile(path.join(rootDir, "Dockerfile.production"), "utf8");
  assert.match(dockerfile, /FROM build AS benchmark-target/);
  assert.match(dockerfile, /FROM build AS production-agent/);
  assert.match(dockerfile, /rm -rf \/app\/fixtures \/app\/evaluation/);
  const dockerignore = await readFile(path.join(rootDir, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^evaluation$/m);
  const script = await readFile(path.join(rootDir, "scripts", "production-acceptance.mjs"), "utf8");
  assert.match(script, /idempotency_duplicate_run_failed/);
  assert.match(script, /organization_isolation_failed/);
  for (const marker of [
    "active_attempt_uniqueness_failed",
    "expired_lease_takeover",
    "cancel_cleanup_terminal_state",
    "minio_failure_rollback_failed",
    "redis_reconnect_delivery",
    "postgres_api_worker_restart_recovery",
    "generic_table_sort_filter_pagination"
  ]) assert.match(script, new RegExp(marker));
  for (const marker of ["randomUUID", "randomBytes", "ensureAcceptanceSecrets", "generatedAcceptanceSecrets", "composeProject", "diagnostics", "agent-api", "worker", "keycloak", "postgres", "redis", "minio", "REDACTED"]) assert.match(script, new RegExp(marker));
  for (const file of ["loopEventStore.ts", "auditLog.ts", "requirementAcceptanceStore.ts", "commitCheckStore.ts", "patrolRunStore.ts", "demoVerificationStore.ts"]) {
    const source = await readFile(path.join(rootDir, "agent", "src", file), "utf8");
    assert.doesNotMatch(source, /const rootDir = path\.resolve\(process\.cwd\(\), "\.\."\);/, `${file} must not escape /app when a production container starts at the workspace root`);
  }
}
