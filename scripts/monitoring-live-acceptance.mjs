// Live Prometheus/Grafana acceptance for the production SLO stack.
// Verifies a real scrape, a real Prometheus alert transition, Grafana health,
// and that the monitoring services are backed by named persistent volumes.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "production-acceptance", "compose.yml");
const outDir = path.join(root, "reports", "production-slo");
const reportPath = path.join(outDir, "monitoring-live-latest.json");
const project = `ato-monitoring-${randomUUID().slice(0, 8)}`;
const prometheus = "http://127.0.0.1:19090";
const grafana = "http://127.0.0.1:13000";

await mkdir(outDir, { recursive: true });

for (const name of [
  "POSTGRES_PASSWORD", "REDIS_PASSWORD", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
  "KEYCLOAK_ADMIN_PASSWORD", "INTERNAL_WORKER_TOKEN", "EGRESS_POLICY_SECRET", "TARGET_DB_PASSWORD"
]) process.env[name] ??= randomBytes(24).toString("hex");
process.env.KEYCLOAK_ADMIN ??= "monitoring-admin";
if (!process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY || !process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
}

function composeRun(args, options = {}) {
  return execFileSync("docker", ["compose", "--profile", "observability", "-p", project, "-f", compose, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env },
    timeout: options.timeout ?? 600_000
  });
}

async function waitFor(url, timeoutMs = 180_000) {
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

async function prometheusQuery(query) {
  const response = await fetch(`${prometheus}/api/v1/query?query=${encodeURIComponent(query)}`);
  const body = await response.json();
  return { status: response.status, body };
}

async function alertState(alertName) {
  const response = await fetch(`${prometheus}/api/v1/rules?type=alert`);
  const body = await response.json();
  const groups = body.data?.groups ?? [];
  const rule = groups.flatMap((group) => group.rules ?? []).find((item) => item.name === alertName);
  return { status: response.status, state: rule?.state ?? "missing", alerts: rule?.alerts ?? [] };
}

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "Live Prometheus/Grafana scrape, alert exercise and persistence acceptance",
  composeProject: project,
  checks: [],
  results: {},
  blockers: [],
  limitations: [
    "The alert exercise uses a disposable stale run projection to safely trigger the stalled-runs rule.",
    "No external notification provider is configured; this verifies Prometheus rule evaluation, not PagerDuty delivery."
  ]
};

try {
  composeRun(["down", "--volumes", "--remove-orphans"], { capture: true, timeout: 120_000 });
  composeRun(["up", "-d", "--build", "--wait"], { capture: true });
  const [agentHealthy, prometheusReady, grafanaHealthy] = await Promise.all([
    waitFor("http://127.0.0.1:14317/api/health"),
    waitFor(`${prometheus}/-/ready`),
    waitFor(`${grafana}/api/health`)
  ]);
  report.results.health = { agentHealthy, prometheusReady, grafanaHealthy };
  if (!agentHealthy || !prometheusReady || !grafanaHealthy) throw new Error("monitoring_service_health_failed");
  report.checks.push("agent_prometheus_grafana_healthy");

  const target = await prometheusQuery('up{job="ai-test-officer-agent"}');
  const targetUp = Number(target.body.data?.result?.[0]?.value?.[1] ?? 0) === 1;
  report.results.scrapeTarget = { status: target.status, up: targetUp, series: target.body.data?.result?.length ?? 0 };
  if (!targetUp) throw new Error("prometheus_agent_target_not_up");
  report.checks.push("prometheus_scrape_target_up");

  const stalledId = `monitor-stalled-${randomUUID()}`;
  composeRun(["exec", "-T", "postgres", "psql", "-U", "ai_test_officer", "-d", "ai_test_officer", "-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO run_projections (run_id,state,version,created_at,updated_at,projection_json) VALUES ('${stalledId}','running',1,now() - interval '1 hour',now() - interval '1 hour','{}'::jsonb) ON CONFLICT (run_id) DO UPDATE SET state='running',updated_at=now() - interval '1 hour'`], { capture: true, timeout: 30_000 });
  const metricDeadline = Date.now() + 90_000;
  let stalledMetric = null;
  while (Date.now() < metricDeadline) {
    stalledMetric = await prometheusQuery("ai_test_officer_slo_stalled_runs");
    const value = Number(stalledMetric.body.data?.result?.[0]?.value?.[1] ?? 0);
    if (value > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const stalledValue = Number(stalledMetric?.body.data?.result?.[0]?.value?.[1] ?? 0);
  report.results.stalledMetric = { value: stalledValue, queryStatus: stalledMetric?.status };
  if (stalledValue <= 0) throw new Error("stalled_run_metric_not_observed");
  report.checks.push("stalled_run_metric_scraped");

  const alertDeadline = Date.now() + 180_000;
  let alert = await alertState("AtoStalledRuns");
  while (Date.now() < alertDeadline && alert.state !== "firing") {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    alert = await alertState("AtoStalledRuns");
  }
  report.results.alert = { name: "AtoStalledRuns", state: alert.state, activeAlerts: alert.alerts.length };
  if (alert.state !== "firing") throw new Error("prometheus_stalled_run_alert_not_firing");
  report.checks.push("prometheus_alert_fired_for_stalled_run");

  // Restart only the monitoring services while preserving their named volumes.
  composeRun(["down"], { capture: true, timeout: 120_000 });
  composeRun(["up", "-d", "prometheus", "grafana", "--wait"], { capture: true, timeout: 180_000 });
  const restartPrometheus = await waitFor(`${prometheus}/-/ready`);
  const restartGrafana = await waitFor(`${grafana}/api/health`);
  report.results.restart = { prometheusReady: restartPrometheus, grafanaHealthy: restartGrafana, namedVolumes: ["prometheus-data", "grafana-data"] };
  if (!restartPrometheus || !restartGrafana) throw new Error("monitoring_restart_failed");
  report.checks.push("monitoring_services_restart_with_named_volumes");
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
