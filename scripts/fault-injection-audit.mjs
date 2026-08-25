import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const sourceFile = path.join(rootDir, "reports", "production-acceptance", "latest.json");
const reportDir = path.join(rootDir, "reports", "fault-injection");

const scenarios = [
  { id: "worker_sigkill_running", boundary: "执行中 Worker 硬杀", checks: ["worker_sigkill_running_recovery", "worker_sigkill_recovery_trace", "worker_sigkill_single_terminal_outcome"] },
  { id: "queued_pause_resume", boundary: "State/Queue 边界重启", checks: ["pause_resume_worker_restart"] },
  { id: "worker_network_disconnect", boundary: "Queue 已发送后 Worker 网络中断", checks: ["worker_network_disconnect_recovery"] },
  { id: "agent_api_restart_queued", boundary: "API 排队期重启", checks: ["queued_run_agent_api_restart_recovery"] },
  { id: "duplicate_and_lease_fencing", boundary: "重复 Job、旧 Generation 与 Lease 接管", checks: ["duplicate_permission_delivery", "queue_out_of_order_generation_fence", "queue_delayed_delivery_single_terminal", "expired_lease_takeover", "active_attempt_unique"] },
  { id: "service_restart_recovery", boundary: "Redis/PostgreSQL/MinIO 服务故障", checks: ["redis_reconnect_delivery", "postgres_api_worker_restart_recovery", "minio_unavailable_blocks_commit"] },
  { id: "artifact_replica_reconciliation", boundary: "已提交 Artifact Replica 丢失", checks: ["artifact_reconciliation_blocks_stale_replica", "operational_slo_alerts_stale_replica"] },
  { id: "sse_disconnect", boundary: "SSE 客户端断流", checks: ["sse_disconnect_query_recovery"] },
  { id: "mutable_api_receipt", boundary: "可变 API 写入后、回执完成前硬杀", checks: ["mutable_api_post_effect_sigkill_recovery", "mutable_api_post_effect_single_side_effect"] },
  { id: "artifact_temporary_upload", boundary: "Artifact 临时上传后硬杀", checks: ["artifact_temporary_upload_sigkill_recovery", "artifact_temporary_upload_orphan_reconciled"] },
  { id: "artifact_temporary_verified", boundary: "Artifact 临时对象校验后硬杀", checks: ["artifact_temporary_verified_sigkill_recovery", "artifact_temporary_verified_orphan_reconciled"] },
  { id: "artifact_object_commit", boundary: "最终对象提交、Ledger 写入前硬杀", checks: ["artifact_object_commit_sigkill_recovery", "artifact_object_commit_orphan_reconciled", "artifact_object_commit_no_orphan_adoption"] },
  { id: "gate_after_commit", boundary: "Gate 写入后、Checkpoint/SSE 前硬杀", checks: ["gate_sse_post_commit_sigkill_recovery", "gate_sse_post_commit_recovery_trace", "gate_sse_post_commit_sse_replay"] },
  { id: "approval_after_commit", boundary: "人工审批写入后、Graph resume 前硬杀", checks: ["approval_post_commit_sigkill_recovery", "approval_post_commit_graph_resume", "approval_post_commit_single_approval"] }
];

function markdown(report) {
  const rows = report.scenarios.map((scenario) => `| ${scenario.id} | ${scenario.boundary} | ${scenario.status} | ${scenario.missingChecks.join(", ") || "—"} |`).join("\n");
  return `# Fault Injection Audit\n\nGenerated: ${report.generatedAt}\n\n` +
    `Overall: **${report.status}**\n\n` +
    `This report is derived from the isolated Production Compose acceptance run and keeps the evidence boundary explicit. A check name means the corresponding black-box assertion passed; it is not a long-running production SLO or external-project result.\n\n` +
    `| Scenario | Boundary | Status | Missing checks |\n| --- | --- | --- | --- |\n${rows}\n\n` +
    `## Metrics\n\n` +
    `- Scenario check coverage: ${report.metrics.scenarioCheckCoverageRate}\n` +
    `- Verified scenario count: ${report.metrics.verifiedScenarioCount}/${report.metrics.scenarioCount}\n` +
    `- Recovery proof coverage: ${report.metrics.recoveryProofCoverageRate}\n` +
    `- Duplicate-side-effect proof coverage: ${report.metrics.duplicateSideEffectProofCoverageRate}\n` +
    `- Orphan reconciliation proof coverage: ${report.metrics.orphanReconciliationProofCoverageRate}\n\n` +
    `Remaining boundary: no claim is made for external projects, sealed blind evaluation, sustained production load, or a live monitoring dashboard.\n`;
}

let source;
try {
  source = JSON.parse(await readFile(sourceFile, "utf8"));
} catch {
  source = undefined;
}

const checks = new Set(Array.isArray(source?.checks) ? source.checks : []);
const evaluated = scenarios.map((scenario) => {
  const missingChecks = scenario.checks.filter((check) => !checks.has(check));
  return {
    ...scenario,
    status: source?.status === "passed" && missingChecks.length === 0 ? "verified" : "not-verified",
    missingChecks
  };
});
const verifiedScenarios = evaluated.filter((scenario) => scenario.status === "verified");
const requiredChecks = [...new Set(scenarios.flatMap((scenario) => scenario.checks))];
const verifiedChecks = requiredChecks.filter((check) => checks.has(check));
const proofCoverage = (prefixes) => {
  const required = requiredChecks.filter((check) => prefixes.some((prefix) => check.includes(prefix)));
  return required.length === 0 ? null : Number((required.filter((check) => checks.has(check)).length / required.length).toFixed(4));
};
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  source: "reports/production-acceptance/latest.json",
  sourceStatus: source?.status ?? "missing",
  status: source?.status === "passed" && verifiedScenarios.length === scenarios.length ? "isolated-compose-verified" : "not-ready",
  scenarios: evaluated,
  metrics: {
    scenarioCount: scenarios.length,
    verifiedScenarioCount: verifiedScenarios.length,
    requiredCheckCount: requiredChecks.length,
    verifiedCheckCount: verifiedChecks.length,
    scenarioCheckCoverageRate: scenarios.length === 0 ? 0 : Number((verifiedScenarios.length / scenarios.length).toFixed(4)),
    recoveryProofCoverageRate: proofCoverage(["recovery", "takeover", "resume", "reconnect", "generation_fence", "delayed_delivery"]),
    duplicateSideEffectProofCoverageRate: proofCoverage(["single_side_effect", "single_terminal", "single_approval", "no_orphan_adoption", "active_attempt_unique"]),
    orphanReconciliationProofCoverageRate: proofCoverage(["orphan_reconciled", "no_orphan_adoption", "artifact_reconciliation"])
  },
  limitation: "Isolated Compose check coverage is not a sustained production SLO, external-project acceptance, sealed blind evaluation, or proof of zero orphan data outside the exercised scenarios."
};

await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(reportDir, "latest.md"), markdown(report));
console.log(`Fault injection audit: ${path.join(reportDir, "latest.md")}`);
if (report.status !== "isolated-compose-verified" && process.env.ALLOW_INCOMPLETE_FAULT_AUDIT !== "1") process.exitCode = 1;
