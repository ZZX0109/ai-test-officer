import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryService } from "../src/memory/memoryService.js";
import { Tracer } from "../src/tracing/tracer.js";
import { FeedbackLoop } from "../src/feedback-loop/feedbackLoop.js";

/**
 * Optional PostgreSQL restart proof. The normal unit suite has no database;
 * production/Compose runs enable this test with DATABASE_URL after migrations.
 */
export async function testDurableSustainabilityRestart() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return;
  const suffix = randomUUID().slice(0, 8);
  const projectId = `durable_project_${suffix}`;
  const runId = `durable_run_${suffix}`;
  const now = new Date().toISOString();

  const memoryWriter = new MemoryService(undefined, connectionString);
  await memoryWriter.upsertProjectEntry({
    schemaVersion: "1.0",
    entryId: `project_memory_${suffix}`,
    projectId,
    category: "startup_config",
    key: "runtime",
    value: { command: "npm run dev" },
    confidence: 1,
    verified: true,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now
  });
  await memoryWriter.close();
  const memoryReader = new MemoryService(undefined, connectionString);
  assert.equal((await memoryReader.queryProjectEntries({ projectId, includeUnverified: false, limit: 10 })).length, 1);
  await memoryReader.close();

  const traceWriter = new Tracer(undefined, connectionString);
  const traceId = await traceWriter.startTrace(runId, projectId, "restart proof");
  const spanId = await traceWriter.traceExecution(runId, "persist", { ok: true });
  await traceWriter.endSpan(spanId, { persisted: true });
  await traceWriter.close();
  const traceReader = new Tracer(undefined, connectionString);
  assert.equal((await traceReader.getChain(traceId))?.statistics.totalSpans, 1);
  await traceReader.endChain(runId);
  await traceReader.close();

  const feedbackWriter = new FeedbackLoop(undefined, connectionString);
  const session = await feedbackWriter.startSession(projectId, {
    runId,
    failureType: "environment_issue",
    title: "restart proof",
    description: "durable feedback",
    severity: "minor"
  });
  await feedbackWriter.close();
  const feedbackReader = new FeedbackLoop(undefined, connectionString);
  assert.equal((await feedbackReader.getSession(session.sessionId))?.detection?.runId, runId);
  assert.equal((await feedbackReader.getActiveSessions()).some((item) => item.sessionId === session.sessionId), true);
  await feedbackReader.close();
}
