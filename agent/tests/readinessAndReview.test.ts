import assert from "node:assert/strict";
import { createReadinessService } from "../src/readiness.js";
import { createReviewCase } from "../src/reviewCase.js";
import { mergeRuntimeBusinessPaths } from "../src/businessRuntimePathMerge.js";
import { createDefaultReadinessRegistry } from "../src/readinessRegistry.js";

export async function testReadinessAndReview() {
  const registry = createDefaultReadinessRegistry().fork();
  assert.throws(() => registry.record({ id: "unregistered", status: "ready", severity: "info", message: "x", evidence: [], requiredBy: [], updatedAt: "2026-01-01T00:00:00.000Z" }), /readiness_check_unregistered/);
  registry.record({ id: "project.runtime", status: "ready", severity: "info", message: "x", evidence: [], requiredBy: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.throws(() => registry.record({ id: "project.runtime", status: "ready", severity: "info", message: "x", evidence: [], requiredBy: [], updatedAt: "2026-01-01T00:00:00.000Z" }), /readiness_check_duplicate_result/);
  const service = createReadinessService({
    getProject: async (id) => id === "demo" ? {
      id: "demo", name: "Demo", projectPath: "/tmp/demo", frontendUrl: "http://demo.local", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      manifest: { execution: { mode: "oci", engine: "docker", image: "node:22" }, network: { mode: "allowlist", allowedHosts: ["api.example.com"], enforcement: "external-egress-proxy" } } as never
    } : undefined,
    getRuntime: async () => ({ projectId: "demo", status: "idle", message: "not started" }),
    containerEngineIsReady: async () => false,
    checkUrl: async () => ({ ok: false, status: 0, latencyMs: 1 }),
    listCredentials: async () => [],
    now: () => "2026-01-01T00:00:00.000Z"
  });
  const report = await service.inspect("demo");
  assert.equal(report.status, "blocked");
  assert.ok(report.checks.some((item) => item.id === "runtime.container-engine"));
  assert.equal((await service.inspect("missing")).status, "blocked");

  const review = createReviewCase({ id: "run_1", status: "blocked", reason: "egress proxy 未配置", canRetry: true });
  assert.equal(review?.category, "network");
  assert.equal(review?.canRetry, true);

  const merged = mergeRuntimeBusinessPaths([], [{ url: "http://demo.local/tasks", method: "GET", source: "browser", evidenceRefs: ["ev_1"] }]);
  assert.equal(merged[0].status, "needs-input");
  assert.deepEqual(merged[0].runtimeEvidenceRefs, ["ev_1"]);
}
