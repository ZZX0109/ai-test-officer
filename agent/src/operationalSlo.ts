import { databasePoolStats, getDatabasePool } from "./databaseRuntime.js";

export interface OperationalSloSnapshot {
  generatedAt: string;
  databaseConfigured: boolean;
  metrics: {
    stalledRuns: number;
    pendingOutbox: number;
    stalePublishingOutbox: number;
    missingArtifactReplicas: number;
    expiredLeases: number;
    databaseWaitingClients: number;
  };
  alerts: Array<{
    id: "stalled_runs" | "outbox_backlog" | "outbox_stale_publishing" | "artifact_replica_missing" | "expired_leases" | "database_pool_waiting" | "slo_unavailable";
    severity: "critical" | "warning";
    value: number;
    threshold: number;
    message: string;
  }>;
  unavailableReason?: string;
}

export function deriveOperationalSloAlerts(metrics: OperationalSloSnapshot["metrics"]): OperationalSloSnapshot["alerts"] {
  const alerts: OperationalSloSnapshot["alerts"] = [];
  if (metrics.stalledRuns > 0) alerts.push({ id: "stalled_runs", severity: "critical", value: metrics.stalledRuns, threshold: 0, message: "A Run has exceeded its durable execution timeout and requires recovery." });
  if (metrics.missingArtifactReplicas > 0) alerts.push({ id: "artifact_replica_missing", severity: "critical", value: metrics.missingArtifactReplicas, threshold: 0, message: "A reconciled Artifact replica is missing; affected Machine Gates are fail-closed." });
  if (metrics.stalePublishingOutbox > 0) alerts.push({ id: "outbox_stale_publishing", severity: "critical", value: metrics.stalePublishingOutbox, threshold: 0, message: "An Outbox delivery has remained publishing beyond the recovery window." });
  if (metrics.expiredLeases > 0) alerts.push({ id: "expired_leases", severity: "warning", value: metrics.expiredLeases, threshold: 0, message: "An execution lease expired; verify takeover and Generation Fencing." });
  if (metrics.pendingOutbox >= 20) alerts.push({ id: "outbox_backlog", severity: "warning", value: metrics.pendingOutbox, threshold: 20, message: "Outbox backlog reached the operational warning threshold." });
  if (metrics.databaseWaitingClients > 0) alerts.push({ id: "database_pool_waiting", severity: "warning", value: metrics.databaseWaitingClients, threshold: 0, message: "Database clients are waiting for a shared pool connection." });
  return alerts;
}

const emptyMetrics: OperationalSloSnapshot["metrics"] = {
  stalledRuns: 0,
  pendingOutbox: 0,
  stalePublishingOutbox: 0,
  missingArtifactReplicas: 0,
  expiredLeases: 0,
  databaseWaitingClients: 0
};

export function operationalSloUnavailableAlert(reason: "database_not_configured" | "metrics_query_failed"): OperationalSloSnapshot["alerts"][number] {
  return {
    id: "slo_unavailable",
    severity: "critical",
    value: 1,
    threshold: 0,
    message: `Operational SLO metrics are unavailable: ${reason}.`
  };
}

/** Render the low-cardinality snapshot for Prometheus-compatible scrapers. */
export function renderOperationalSloPrometheus(snapshot: OperationalSloSnapshot): string {
  const lines = [
    "# HELP ai_test_officer_slo_database_configured Whether the durable metrics database is configured.",
    "# TYPE ai_test_officer_slo_database_configured gauge",
    `ai_test_officer_slo_database_configured ${snapshot.databaseConfigured ? 1 : 0}`,
    ...Object.entries(snapshot.metrics).flatMap(([name, value]) => {
      const metric = `ai_test_officer_slo_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
      return [
        `# TYPE ${metric} gauge`,
        `${metric} ${value}`
      ];
    }),
    "# HELP ai_test_officer_slo_alert Active operational alert (1 means firing).",
    "# TYPE ai_test_officer_slo_alert gauge",
    ...snapshot.alerts.map((alert) => `ai_test_officer_slo_alert{alert_id="${alert.id}",severity="${alert.severity}"} 1`)
  ];
  return `${lines.join("\n")}\n`;
}

function numeric(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

/**
 * Read low-cardinality production SLO signals from the durable stores.  This
 * deliberately exposes counts only—never Run IDs, tokens, credentials or
 * Artifact locations—so a metrics scraper can consume it without widening
 * tenant data access.
 */
export async function collectOperationalSlo(): Promise<OperationalSloSnapshot> {
  const generatedAt = new Date().toISOString();
  const pools = databasePoolStats();
  const databaseWaitingClients = pools.reduce((sum, pool) => sum + pool.waitingCount, 0);
  const db = getDatabasePool();
  if (!db) {
    const metrics = { ...emptyMetrics, databaseWaitingClients };
    return { generatedAt, databaseConfigured: false, metrics, alerts: [operationalSloUnavailableAlert("database_not_configured"), ...deriveOperationalSloAlerts(metrics)], unavailableReason: "database_not_configured" };
  }
  try {
    const result = await db.query<{
      stalled_runs: string;
      pending_outbox: string;
      stale_publishing_outbox: string;
      missing_artifact_replicas: string;
      expired_leases: string;
    }>(`
      SELECT
        (SELECT count(*) FROM run_projections
          WHERE state IN ('queued','preparing','running','collecting','judging')
            AND updated_at < now() - interval '20 minutes') AS stalled_runs,
        (SELECT count(*) FROM event_outbox_v1 WHERE status='pending') AS pending_outbox,
        (SELECT count(*) FROM event_outbox_v1
          WHERE status='publishing' AND updated_at < now() - interval '1 minute') AS stale_publishing_outbox,
        (SELECT count(*) FROM artifacts_v1
          WHERE payload->>'objectStoreState' IN ('missing','uncommitted')) AS missing_artifact_replicas,
        (SELECT count(*) FROM execution_leases WHERE lease_until < now()) AS expired_leases
    `);
    const row = result.rows[0] ?? {};
    const metrics = {
      stalledRuns: numeric(row.stalled_runs),
      pendingOutbox: numeric(row.pending_outbox),
      stalePublishingOutbox: numeric(row.stale_publishing_outbox),
      missingArtifactReplicas: numeric(row.missing_artifact_replicas),
      expiredLeases: numeric(row.expired_leases),
      databaseWaitingClients
    };
    return { generatedAt, databaseConfigured: true, metrics, alerts: deriveOperationalSloAlerts(metrics) };
  } catch {
    const metrics = { ...emptyMetrics, databaseWaitingClients };
    return {
      generatedAt,
      databaseConfigured: true,
      metrics,
      alerts: [operationalSloUnavailableAlert("metrics_query_failed"), ...deriveOperationalSloAlerts(metrics)],
      // This endpoint is intentionally suitable for an unauthenticated health
      // scraper. Keep database/provider diagnostics in server logs rather
      // than returning connection details through a public metrics surface.
      unavailableReason: "metrics_query_failed"
    };
  }
}
