import assert from "node:assert/strict";
import { buildBenchmarkCatalog, trustedBenchmarkRuntimeMetrics } from "../src/benchmarkSummary.js";

export function testBenchmarkSummary() {
  const catalog = buildBenchmarkCatalog({
    development: [{ id: "todo", projectId: "todo_lite", category: "form" }, { id: "order", projectId: "order_portal_lite", category: "permission" }],
    blind: [{ id: "blind-order", projectId: "order_portal_lite", category: "error" }],
    extended: [{ id: "customer", projectId: "customer_portal_lite", category: "table" }],
    mappings: [
      { logicalProjectId: "todo_lite", executionProjectId: "local_demo_app", targetUrl: "http://todo-lite:7101", targetKind: "app-under-test" },
      { logicalProjectId: "order_portal_lite", executionProjectId: "order-portal-lite", targetUrl: "http://order-portal-lite:7102", targetKind: "independent-fixture" },
      { logicalProjectId: "customer_portal_lite", executionProjectId: "customer-portal-lite", targetUrl: "http://customer-portal-lite:7103", targetKind: "independent-fixture" }
    ],
    challengeProjectIds: ["investment-agent"]
  });
  assert.equal(catalog.fixtureProjects.length, 3);
  assert.deepEqual(catalog.fixtureProjects.find((item) => item.logicalProjectId === "order_portal_lite"), {
    logicalProjectId: "order_portal_lite",
    executionProjectId: "order-portal-lite",
    targetUrl: "http://order-portal-lite:7102",
    targetKind: "independent-fixture",
    splits: ["development", "blind"]
  });
  assert.throws(() => buildBenchmarkCatalog({
    development: [{ id: "order", projectId: "order_portal_lite", category: "permission" }],
    blind: [],
    extended: [],
    mappings: [{ logicalProjectId: "todo_lite", executionProjectId: "local_demo_app" }],
    challengeProjectIds: []
  }), /benchmark_mapping_missing:order_portal_lite/);

  const missingProvenance = trustedBenchmarkRuntimeMetrics({ status: "completed" });
  assert.equal(missingProvenance.status, "blocked");
  const unsafeCommand = trustedBenchmarkRuntimeMetrics({
    status: "awaiting_blind_runs",
    conclusion: "development_only",
    provenance: { kind: "historical-recompute", rawRecordCount: 30, formalEligibleRecordCount: 20 },
    evaluations: [{ split: "development", completedRuns: 20, plannedRuns: 30, acceptance: { proven: false, reasons: [] }, lanes: { "test-command:none": { gateEligibleRate: 1 } } }]
  });
  assert.equal(unsafeCommand.status, "blocked");
  const recomputed = trustedBenchmarkRuntimeMetrics({
    status: "awaiting_blind_runs",
    conclusion: "development_only",
    provenance: { kind: "historical-recompute", rawRecordCount: 30, formalEligibleRecordCount: 20 },
    evaluations: [{ split: "development", completedRuns: 20, plannedRuns: 30, acceptance: { proven: false, reasons: [] }, lanes: {} }]
  });
  assert.equal(recomputed.completedRuns, 30);
  assert.equal(recomputed.formalEligibleRuns, 20);
}
