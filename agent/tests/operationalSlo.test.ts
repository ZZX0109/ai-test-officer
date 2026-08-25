import assert from "node:assert/strict";
import { deriveOperationalSloAlerts, operationalSloUnavailableAlert, renderOperationalSloPrometheus } from "../src/operationalSlo.js";

export function testOperationalSloAlerts() {
  const alerts = deriveOperationalSloAlerts({
    stalledRuns: 1,
    pendingOutbox: 20,
    stalePublishingOutbox: 1,
    missingArtifactReplicas: 1,
    expiredLeases: 1,
    databaseWaitingClients: 1
  });
  assert.deepEqual(alerts.map((alert) => alert.id), [
    "stalled_runs",
    "artifact_replica_missing",
    "outbox_stale_publishing",
    "expired_leases",
    "outbox_backlog",
    "database_pool_waiting"
  ]);
  assert.equal(alerts.filter((alert) => alert.severity === "critical").length, 3);
  assert.deepEqual(deriveOperationalSloAlerts({ stalledRuns: 0, pendingOutbox: 19, stalePublishingOutbox: 0, missingArtifactReplicas: 0, expiredLeases: 0, databaseWaitingClients: 0 }), []);
  assert.deepEqual(operationalSloUnavailableAlert("metrics_query_failed"), {
    id: "slo_unavailable",
    severity: "critical",
    value: 1,
    threshold: 0,
    message: "Operational SLO metrics are unavailable: metrics_query_failed."
  });
  const prometheus = renderOperationalSloPrometheus({
    generatedAt: "2026-01-01T00:00:00.000Z",
    databaseConfigured: false,
    metrics: { stalledRuns: 0, pendingOutbox: 2, stalePublishingOutbox: 0, missingArtifactReplicas: 0, expiredLeases: 0, databaseWaitingClients: 0 },
    alerts: [operationalSloUnavailableAlert("database_not_configured")]
  });
  assert.match(prometheus, /ai_test_officer_slo_database_configured 0/);
  assert.match(prometheus, /ai_test_officer_slo_pending_outbox 2/);
  assert.match(prometheus, /ai_test_officer_slo_alert\{alert_id="slo_unavailable",severity="critical"\} 1/);
}
