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
    "sse_disconnect_query_recovery",
    "sse_disconnect_durable_state_changed",
    "artifact_reconciliation_blocks_stale_replica",
    "artifact_reconciliation_gate_not_blocked",
    "operational_slo_alerts_stale_replica",
    "operational_slo_missing_artifact_alert_failed",
    "artifact_temporary_upload_sigkill_recovery",
    "artifact_temporary_upload_orphan_reconciled",
    "artifact_temporary_verified_sigkill_recovery",
    "artifact_temporary_verified_orphan_reconciled",
    "artifact_object_commit_sigkill_recovery",
    "artifact_object_commit_orphan_reconciled",
    "artifact_object_commit_no_orphan_adoption",
    "recoverArtifactStoreFault",
    "artifact_temporary_object_uploaded",
    "artifact_temporary_object_verified",
    "artifact_object_committed",
    "redis_reconnect_delivery",
    "queued_run_agent_api_restart_recovery",
    "worker_network_disconnect_recovery",
    "queue_out_of_order_generation_fence",
    "queue_delayed_delivery_single_terminal",
    "queue_reorder_delayed_delivery_changed_terminal",
    "injectOutOfOrderQueueMessages",
    "mutable_api_post_effect_sigkill_recovery",
    "mutable_api_post_effect_single_side_effect",
    "action_receipt_post_effect_pending_checkpoint_missing",
    "action_receipt_retry_duplicate_or_incomplete",
    "ACTION_RECEIPT_FAULT_RULE_B64",
    "worker_sigkill_running_recovery",
    "worker_sigkill_recovery_trace",
    "worker_sigkill_single_terminal_outcome",
    "approval_post_commit_sigkill_recovery",
    "approval_post_commit_graph_resume",
    "approval_post_commit_single_approval",
    "gate_sse_post_commit_sigkill_recovery",
    "gate_sse_post_commit_recovery_trace",
    "gate_sse_post_commit_sse_replay",
    "worker_network_fault_control_network_missing",
    "postgres_api_worker_restart_recovery",
    "generic_table_sort_filter_pagination"
  ]) assert.match(script, new RegExp(marker));
  for (const marker of ["FAULT_INJECTION_ENABLED", "FAULT_INJECTION_RULES_B64", "JUDGING_RECOVERY_GRACE_MS", "PLAN_APPROVAL_RESUME_RECOVERY_GRACE_MS"]) assert.match(compose, new RegExp(marker));
  for (const marker of ["randomUUID", "randomBytes", "ensureAcceptanceSecrets", "generatedAcceptanceSecrets", "composeProject", "diagnostics", "agent-api", "worker", "keycloak", "postgres", "redis", "minio", "REDACTED"]) assert.match(script, new RegExp(marker));
  for (const file of ["loopEventStore.ts", "auditLog.ts", "requirementAcceptanceStore.ts", "commitCheckStore.ts", "patrolRunStore.ts", "demoVerificationStore.ts"]) {
    const source = await readFile(path.join(rootDir, "agent", "src", file), "utf8");
    assert.doesNotMatch(source, /const rootDir = path\.resolve\(process\.cwd\(\), "\.\."\);/, `${file} must not escape /app when a production container starts at the workspace root`);
  }
}
