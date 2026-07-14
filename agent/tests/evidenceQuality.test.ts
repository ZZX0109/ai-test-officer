import assert from "node:assert/strict";
import { buildEvidenceQualityReport } from "../src/evidenceQuality.js";

const identity = { schemaVersion: "2.0" as const, runId: "run-1", scenarioId: "scenario-1", attemptId: "attempt-1", attempt: 1, origin: "runtime-captured" as const, storageUri: "/artifacts/a", replicaUris: [], sequence: 1, monotonicOffsetMs: 0, integrity: { sha256: "a".repeat(64), sizeBytes: 1, mediaType: "application/json", capturedAt: "2026-01-01T00:00:00.000Z", collector: { name: "test", version: "1" } } };

export function testEvidenceQuality() {
  const report = buildEvidenceQualityReport({
    assertions: [{ name: "query", passed: true, expected: "x", actual: "x", fact: { kind: "network.url_contains", target: "/api", operator: "contains", expected: "x", actual: "x", severity: "high", evidenceRefs: ["assertion-1"] } }],
    evidence: [{ id: "assertion-1", runId: "run-1", type: "assertion", title: "query", timestamp: "2026-01-01T00:00:00.000Z", scenarioId: "scenario-1", attemptId: "attempt-1", attempt: 1, payload: {} }],
    artifacts: [
      { ...identity, id: "network", kind: "network" as const },
      { ...identity, id: "screenshot", kind: "screenshot" as const }
    ]
  });
  assert.equal(report.summary.groundedPassedRate, 1);
  assert.equal(report.assertions[0]?.status, "grounded");

  const missing = buildEvidenceQualityReport({
    assertions: [{ name: "visible", passed: true, expected: "x", actual: "x", fact: { kind: "text.contains", target: "#x", operator: "contains", expected: "x", actual: "x", severity: "high", evidenceRefs: ["assertion-1"] } }],
    evidence: [{ id: "assertion-1", runId: "run-1", type: "assertion", title: "visible", timestamp: "2026-01-01T00:00:00.000Z", payload: {} }],
    artifacts: [{ ...identity, id: "screenshot", kind: "screenshot" as const }]
  });
  assert.equal(missing.assertions[0]?.status, "insufficient");
  assert.match(missing.assertions[0]?.reasons.join(" ") ?? "", /attempt_missing/);

  const consoleReport = buildEvidenceQualityReport({
    assertions: [{ name: "console", passed: true, expected: "none", actual: "none", fact: { kind: "console.no_error", target: "console", operator: "not_present", expected: "none", actual: "none", severity: "medium", evidenceRefs: ["console-assertion"] } }],
    evidence: [{ id: "console-assertion", runId: "run-1", type: "assertion", title: "console", timestamp: "2026-01-01T00:00:00.000Z", attempt: 1, payload: {} }],
    artifacts: [{ ...identity, id: "console", kind: "console" as const }, { ...identity, id: "screenshot", kind: "screenshot" as const }]
  });
  assert.equal(consoleReport.assertions[0]?.status, "grounded");
}
