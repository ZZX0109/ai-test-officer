import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextLayerOutputSchema, experienceMemoryEntrySchema, traceChainSchema, writeActionSchema } from "@ai-test-officer/contracts";
import { ContextLayer } from "../src/context-layer/contextLayer.js";
import { MemoryService } from "../src/memory/memoryService.js";
import { Tracer } from "../src/tracing/tracer.js";
import { FeedbackLoop } from "../src/feedback-loop/feedbackLoop.js";
import { FileWriteSafetyStore, WriteSafetyLayer } from "../src/write-safety/writeSafety.js";
import { evaluateMemoryRetrieval } from "../src/memory/memoryRetrievalEval.js";

const repositoryRoot = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

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

  const memory = new MemoryService(undefined, "");
  const entry = experienceMemoryEntrySchema.parse({ schemaVersion: "1.0", entryId: "e1", projectId: "p1", runId: "r1", failureType: "timeout", rootCauseCategory: "environment", rootCauseDescription: "slow", contributingFactors: [], repairStrategy: "wait_strategy", repairDescription: "wait", validationResult: "passed", successCount: 1, failureCount: 0, tags: ["slow"], severity: "minor", createdAt: now, updatedAt: now });
  await memory.upsertExperienceEntry(entry);
  assert.deepEqual(memory.retrievalDescriptor(), {
    mode: "deterministic-hash-v0",
    label: "Deterministic Hash Retrieval Placeholder",
    semantic: false,
    evaluationRequired: ["Recall@5", "Recall@10", "MRR", "false-recall-rate", "source-traceability"]
  });
  assert.equal((await memory.queryExperienceEntries({ projectId: "p1", includeUnvalidated: true, limit: 10, semanticLimit: 10, semanticThreshold: 0, offset: 0 })).length, 1);
  const memoryStats = await memory.getStatistics("p1");
  assert.equal(memoryStats.overallSuccessRate, 1);
  assert.equal(memoryStats.retrievalMode, "deterministic-hash-v0");
  const retrievalEval = evaluateMemoryRetrieval([
    {
      queryId: "q1",
      relevantEntryIds: ["e1"],
      rankedResults: [{ entryId: "e1", sourceRefs: ["run:r1"] }, { entryId: "unrelated", sourceRefs: [] }]
    }
  ]);
  assert.equal(retrievalEval.recallAt5, 1);
  assert.equal(retrievalEval.recallAt10, 1);
  assert.equal(retrievalEval.meanReciprocalRank, 1);
  assert.equal(retrievalEval.falseRecallRateAt10, 0.5);
  assert.equal(retrievalEval.sourceTraceabilityRate, 0.5);
  const memoryDataset = JSON.parse(await readFile(path.join(repositoryRoot, "data", "memory", "retrieval-eval-v1.json"), "utf8")) as {
    status?: string;
    queryCount?: number;
    cases?: Array<{ queryId?: string; relevantEntryIds?: string[]; distractorEntryIds?: string[] }>;
  };
  assert.equal(memoryDataset.status, "labels-ready-provider-run-required");
  assert.equal(memoryDataset.queryCount, 50);
  assert.equal(memoryDataset.cases?.length, 50);
  assert.equal(new Set(memoryDataset.cases?.map((item) => item.queryId)).size, 50);
  assert.equal(memoryDataset.cases?.every((item) => item.relevantEntryIds?.length && item.distractorEntryIds?.length
    && item.distractorEntryIds.every((id) => !item.relevantEntryIds?.includes(id))), true);

  const tracer = new Tracer(undefined, "");
  const traceId = await tracer.startTrace("r1", "p1", "test");
  const span = await tracer.traceAgentDecision("r1", "plan", { ok: true }, undefined, {
    projectId: "p1",
    scenarioId: "scenario-1",
    attemptId: "attempt-1",
    stepId: "step-1",
    decision: { decisionType: "route", confidence: 0.9 },
    telemetry: { model: "test-model", promptVersion: "prompt-v1", codeCommit: "abcdef1", tokenCount: 12, costUsd: 0.01, latencyMs: 8 }
  });
  await tracer.endSpan(span, { selected: true });
  const trace = traceChainSchema.parse(await tracer.getChain(traceId));
  assert.equal(trace.statistics.totalSpans, 1);
  assert.deepEqual(trace.spans[0]?.telemetry, { model: "test-model", promptVersion: "prompt-v1", codeCommit: "abcdef1", tokenCount: 12, costUsd: 0.01, latencyMs: 8 });
  assert.deepEqual({ projectId: trace.spans[0]?.projectId, scenarioId: trace.spans[0]?.scenarioId, attemptId: trace.spans[0]?.attemptId, stepId: trace.spans[0]?.stepId }, { projectId: "p1", scenarioId: "scenario-1", attemptId: "attempt-1", stepId: "step-1" });

  const feedback = new FeedbackLoop(undefined, "");
  const feedbackSession = await feedback.startSession("p1", {
    runId: "r1",
    failureType: "timeout",
    title: "fixture timeout",
    description: "fixture",
    severity: "minor"
  });
  assert.equal((await feedback.getSession(feedbackSession.sessionId))?.stage, "failure_detected");
  assert.equal((await feedback.getStageCounts("p1")).failure_detected, 1);

  const safety = new WriteSafetyLayer();
  const action = writeActionSchema.parse({ actionId: "a1", proposedBy: "user", capability: "save_fixture", params: {}, reason: "test", sourceClaimIds: ["claim"], riskLevel: "low", requiresConfirmation: false, idempotencyKey: "a1", runId: "r1", proposedAt: now });
  const workflow = await safety.createApprovalWorkflow(action);
  const result = await safety.executeApproved(action, async () => ({ executionId: "x", actionId: "a1", status: "executed", affectedTables: [], affectedRows: 0, durationMs: 1, executedAt: now, executorId: "test" }));
  assert.equal(workflow.status, "approved");
  assert.equal(result.status, "executed");

  const oversized = writeActionSchema.parse({ ...action, actionId: "a2", idempotencyKey: "a2", params: { estimatedAffectedRows: 20_000 } });
  assert.equal((await safety.policyCheck(oversized)).allowed, false);
  const guarded = new WriteSafetyLayer({ policyRules: [{
    ruleId: "guarded", description: "custom validation", capabilityPattern: /.*/, minRiskLevel: "medium",
    requireParamsValidation: true, requiredApprovals: 0, maxAffectedRows: 10,
    validateParams: () => ["fixture is immutable"]
  }] });
  const suspicious = writeActionSchema.parse({ ...action, actionId: "a3", idempotencyKey: "a3", riskLevel: "medium", capability: "update_fixture" });
  assert.equal((await guarded.policyCheck(suspicious)).allowed, false);

  const dir = await mkdtemp(path.join(os.tmpdir(), "ato-write-safety-"));
  try {
    const store = new FileWriteSafetyStore(path.join(dir, "state.json"));
    const durable = new WriteSafetyLayer({ store });
    const durableAction = writeActionSchema.parse({ ...action, actionId: "durable", idempotencyKey: "durable" });
    await durable.createApprovalWorkflow(durableAction);
    let calls = 0;
    await durable.executeApproved(durableAction, async () => {
      calls += 1;
      return { executionId: "durable-exec", actionId: "durable", status: "executed", affectedTables: [], affectedRows: 0, durationMs: 1, executedAt: now, executorId: "test" };
    });
    const replayed = new WriteSafetyLayer({ store: new FileWriteSafetyStore(path.join(dir, "state.json")) });
    const loadedWorkflow = await replayed.createApprovalWorkflow(durableAction);
    assert.equal(loadedWorkflow.status, "approved");
    await replayed.executeApproved(durableAction, async () => {
      calls += 1;
      return { executionId: "should-not-run", actionId: "durable", status: "executed", affectedTables: [], affectedRows: 0, durationMs: 1, executedAt: now, executorId: "test" };
    });
    assert.equal(calls, 1, "idempotency key must prevent duplicate execution after restart");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
