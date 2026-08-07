import assert from "node:assert/strict";
import { contextLayerOutputSchema, experienceMemoryEntrySchema, traceChainSchema, writeActionSchema } from "@ai-test-officer/contracts";
import { ContextLayer } from "../src/context-layer/contextLayer.js";
import { MemoryService } from "../src/memory/memoryService.js";
import { Tracer } from "../src/tracing/tracer.js";
import { WriteSafetyLayer } from "../src/write-safety/writeSafety.js";

export async function testSustainabilityModules() {
  const now = new Date().toISOString();
  const context = new ContextLayer({
    getProjectContext: async (projectId) => ({ schemaVersion: "1.0", project: { id: projectId, name: "fixture", techStack: ["vite"], packageManager: "npm" }, routing: { frontendRoutes: [], apiEndpoints: [] }, testPaths: [], login: { method: "none", requiresCredentials: false }, dependencies: { knownIssues: [], commonProblems: [] }, summary: "fixture", generatedAt: now }),
    getRunStatus: async (runId) => ({ schemaVersion: "1.0", runId, state: "running", progress: 0.5, completedNodes: [], elapsedMs: 1, budget: { tokensUsed: 1, tokensBudget: 10, wallClockMs: 1, wallClockBudgetMs: 10, llmCallsUsed: 1, llmCallsBudget: 2 }, activeInterrupts: [], recentErrors: [], summary: "running", generatedAt: now }),
    getEvidence: async (runId) => ({ schemaVersion: "1.0", runId, artifacts: [], assertions: [], summary: "none", generatedAt: now }),
    getFailureHistory: async (projectId) => ({ schemaVersion: "1.0", projectId, failures: [], statistics: { total: 0, resolved: 0, open: 0 }, summary: "none", generatedAt: now }),
    getRepairHistory: async (projectId) => ({ schemaVersion: "1.0", projectId, repairs: [], statistics: { total: 0, applied: 0, successRate: 0 }, summary: "none", generatedAt: now })
  });
  const policy = { schemaVersion: "1.0" as const, policyId: "test", subject: "test", projectId: "p1", runId: "r1", allowedNamespaces: ["project_context", "run_status"] as const, maxContextTokens: 2000, redactSecrets: true, redactPII: true, allowRawPaths: false, expiresAt: new Date(Date.now() + 10_000).toISOString(), issuedAt: now };
  assert.equal(contextLayerOutputSchema.parse(await context.build(policy)).results.run_status?.runId, "r1");
  await assert.rejects(() => context.build({ ...policy, expiresAt: new Date(Date.now() - 1).toISOString() }), /context_policy_expired/);

  const memory = new MemoryService();
  const entry = experienceMemoryEntrySchema.parse({ schemaVersion: "1.0", entryId: "e1", projectId: "p1", runId: "r1", failureType: "timeout", rootCauseCategory: "environment", rootCauseDescription: "slow", contributingFactors: [], repairStrategy: "wait_strategy", repairDescription: "wait", validationResult: "passed", successCount: 1, failureCount: 0, tags: ["slow"], severity: "minor", createdAt: now, updatedAt: now });
  await memory.upsertExperienceEntry(entry);
  assert.equal((await memory.queryExperienceEntries({ projectId: "p1", includeUnvalidated: true, limit: 10, semanticLimit: 10, semanticThreshold: 0, offset: 0 })).length, 1);
  assert.equal((await memory.getStatistics("p1")).overallSuccessRate, 1);

  const tracer = new Tracer();
  const traceId = tracer.startTrace("r1", "p1", "test");
  const span = tracer.traceAgentDecision("r1", "plan", { ok: true });
  tracer.endSpan(span, { selected: true });
  assert.equal(traceChainSchema.parse(tracer.getChain(traceId)).statistics.totalSpans, 1);

  const safety = new WriteSafetyLayer();
  const action = writeActionSchema.parse({ actionId: "a1", proposedBy: "user", capability: "save_fixture", params: {}, reason: "test", sourceClaimIds: ["claim"], riskLevel: "low", requiresConfirmation: false, idempotencyKey: "a1", runId: "r1", proposedAt: now });
  const workflow = await safety.createApprovalWorkflow(action);
  const result = await safety.executeApproved(action, async () => ({ executionId: "x", actionId: "a1", status: "executed", affectedTables: [], affectedRows: 0, durationMs: 1, executedAt: now, executorId: "test" }));
  assert.equal(workflow.status, "approved");
  assert.equal(result.status, "executed");
}
