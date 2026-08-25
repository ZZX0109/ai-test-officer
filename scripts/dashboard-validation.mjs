// Dashboard + Prometheus rule validation (#5 生产 SLO — monitoring dashboard).
// Validates the SLO dashboard template + Prometheus rules are consistent with
// the actual metrics the agent renders (renderOperationalSloPrometheus).
// Produces a report covering: dashboard panels, Prometheus metrics, alert
// rules, and cross-references between them.
//
// Usage: node scripts/dashboard-validation.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const OUT = path.join(root, "reports", "production-slo");
await mkdir(OUT, { recursive: true });

const dashboardPath = path.join(root, "deploy", "observability", "ato-slo-dashboard.json");
const rulesPath = path.join(root, "deploy", "observability", "prometheus-rules.yml");

const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
const rulesText = await readFile(rulesPath, "utf8");

// Extract metric names from the Prometheus rendering function
// (renderOperationalSloPrometheus in agent/src/operationalSlo.ts).
// The source constructs metric names dynamically from the metrics object keys
// (camelCase -> snake_case), so we extract the keys from the source and
// convert them to the rendered metric names.
const sloSourcePath = path.join(root, "agent", "src", "operationalSlo.ts");
const sloSource = await readFile(sloSourcePath, "utf8");

// Extract the OperationalSloMetrics keys from the interface/type definition
// and the emptyMetrics object in the source.
const metricKeys = new Set();
// Match keys in the emptyMetrics object or the OperationalSloMetrics interface
const keyMatches = [...sloSource.matchAll(/(\w+):\s*(?:numeric\(|z\.|number|0|pools\.reduce)/g)];
for (const m of keyMatches) {
  const key = m[1];
  if (["stalledRuns", "pendingOutbox", "stalePublishingOutbox", "missingArtifactReplicas", "expiredLeases", "databaseWaitingClients"].includes(key)) {
    metricKeys.add(key);
  }
}
// Also include the always-rendered databaseConfigured + alert metrics
const renderedMetrics = [
  "ai_test_officer_slo_database_configured",
  "ai_test_officer_slo_alert",
  ...[...metricKeys].map((k) => `ai_test_officer_slo_${k.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`)}`)
];
const uniqueRenderedMetrics = [...new Set(renderedMetrics)];

// Extract alert rule names from the prometheus rules file
const alertRules = [...rulesText.matchAll(/- alert:\s*(\w+)/g)].map((m) => m[1]);
// Extract metric expressions from the rules file
const ruleExpressions = [...rulesText.matchAll(/expr:\s*(.+)/g)].map((m) => m[1].trim());

// Extract panel metric references from the dashboard
const panels = (dashboard.panels ?? []).map((p) => ({
  title: p.title,
  type: p.type,
  targets: (p.targets ?? []).map((t) => t.expr ?? t.query ?? "").filter(Boolean)
}));

// Cross-reference: do the dashboard panels reference metrics that the agent renders?
const panelMetrics = panels.flatMap((p) =>
  p.targets.flatMap((t) => [...t.matchAll(/ai_test_officer_slo_\w+/g)].map((m) => m[0]))
);
const uniquePanelMetrics = [...new Set(panelMetrics)];

// Cross-reference: do the prometheus rule expressions reference metrics that the agent renders?
const ruleMetricRefs = ruleExpressions.flatMap((expr) =>
  [...expr.matchAll(/ai_test_officer_slo_\w+/g)].map((m) => m[0])
);
const uniqueRuleMetricRefs = [...new Set(ruleMetricRefs)];

// Check for dangling references (panels/rules reference metrics not rendered by the agent)
const danglingPanelMetrics = uniquePanelMetrics.filter((m) => !uniqueRenderedMetrics.includes(m));
const danglingRuleMetrics = uniqueRuleMetricRefs.filter((m) => !uniqueRenderedMetrics.includes(m));

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "#5 生产 SLO — monitoring dashboard + Prometheus rules validation",
  dashboard: {
    path: path.relative(root, dashboardPath),
    title: dashboard.title,
    panelCount: panels.length,
    panels: panels.map((p) => ({ title: p.title, type: p.type, targets: p.targets }))
  },
  prometheusRules: {
    path: path.relative(root, rulesPath),
    alertCount: alertRules.length,
    alerts: alertRules,
    ruleExpressions: ruleExpressions
  },
  renderedMetrics: {
    sourceFile: path.relative(root, sloSourcePath),
    metrics: uniqueRenderedMetrics
  },
  crossReference: {
    panelMetricsReferenced: uniquePanelMetrics,
    ruleMetricsReferenced: uniqueRuleMetricRefs,
    danglingPanelMetrics,
    danglingRuleMetrics,
    allPanelMetricsRendered: danglingPanelMetrics.length === 0,
    allRuleMetricsRendered: danglingRuleMetrics.length === 0
  },
  summary: {
    dashboardValid: panels.length > 0 && danglingPanelMetrics.length === 0,
    rulesValid: alertRules.length > 0 && danglingRuleMetrics.length === 0,
    monitoringStackComplete: panels.length > 0 && alertRules.length > 0 && danglingPanelMetrics.length === 0 && danglingRuleMetrics.length === 0
  },
  limitations: [
    "This script validates template consistency (dashboard panels reference metrics that the agent renders; prometheus rules reference metrics the agent renders).",
    "Actual Grafana installation + live dashboard rendering requires a running Grafana instance pointing at a Prometheus that scrapes the agent's /api/operations/slo/prometheus endpoint.",
    "The production-acceptance compose stack validates the SLO endpoint + alert triggers structurally; this script validates the dashboard + rules templates separately.",
    "Long-running SLO data (hours/days) requires a persistent production deployment with a persistent Prometheus TSDB."
  ]
};

await writeFile(path.join(OUT, "dashboard-validation.json"), JSON.stringify(report, null, 2));
console.log(`report → reports/production-slo/dashboard-validation.json`);
console.log(`dashboard: ${report.dashboard.title} (${report.dashboard.panelCount} panels)`);
console.log(`prometheus rules: ${report.prometheusRules.alertCount} alerts`);
console.log(`rendered metrics: ${uniqueRenderedMetrics.length}`);
console.log(`cross-ref: panel metrics ${danglingPanelMetrics.length === 0 ? "OK" : "DANGLING: " + danglingPanelMetrics.join(",")}`);
console.log(`cross-ref: rule metrics ${danglingRuleMetrics.length === 0 ? "OK" : "DANGLING: " + danglingRuleMetrics.join(",")}`);
console.log(`monitoring stack complete: ${report.summary.monitoringStackComplete}`);
