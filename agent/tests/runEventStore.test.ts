import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acceptsExecutionResult, isIdempotentReplay, runEventStore, SqliteRunEventStore } from "../src/runEventStore.js";

export async function testRunEventStore() {
  const suffix = randomUUID();
  const runId = `state_test_${suffix}`;
  let run = await runEventStore.create({ runId, actor: "tester", idempotencyKey: `create-${suffix}`, payload: { requirement: "test" } });
  assert.equal(run.state, "planning");
  assert.equal(run.version, 1);
  run = await runEventStore.append({ runId, type: "plan_generated", expectedVersion: 1, actor: "planner", idempotencyKey: `generated-${suffix}` });
  run = await runEventStore.append({ runId, type: "plan_approved", expectedVersion: 2, actor: "tester", idempotencyKey: `plan-${suffix}` });
  run = await runEventStore.append({ runId, type: "permission_granted", expectedVersion: 3, actor: "tester", idempotencyKey: `permission-${suffix}` });
  assert.equal(run.state, "queued");
  const duplicate = await runEventStore.append({ runId, type: "permission_granted", expectedVersion: 3, actor: "tester", idempotencyKey: `permission-${suffix}` });
  assert.equal(duplicate.version, 4);
  assert.equal(isIdempotentReplay(duplicate), true);
  await assert.rejects(() => runEventStore.append({ runId, type: "run_preparing", expectedVersion: 2, actor: "tester", idempotencyKey: `stale-${suffix}` }), /version_conflict/);
  run = await runEventStore.append({ runId, type: "run_preparing", expectedVersion: 4, actor: "worker", idempotencyKey: `prepare-${suffix}` });
  run = await runEventStore.append({
    runId,
    type: "run_started",
    expectedVersion: 5,
    actor: "worker",
    idempotencyKey: `start-${suffix}`,
    payload: { workerAttemptId: `attempt-${suffix}`, executionGeneration: 4 }
  });
  assert.equal(run.activeExecutionAttemptId, `attempt-${suffix}`);
  assert.equal(run.executionGeneration, 4);
  const collectingProjection = { ...run, state: "collecting" as const };
  assert.equal(acceptsExecutionResult(collectingProjection, { workerAttemptId: `attempt-${suffix}`, executionGeneration: 4 }), true);
  assert.equal(acceptsExecutionResult(collectingProjection, { workerAttemptId: "late-attempt", executionGeneration: 4 }), false);
  assert.equal(acceptsExecutionResult(collectingProjection, { workerAttemptId: `attempt-${suffix}`, executionGeneration: 3 }), false);
  assert.equal(acceptsExecutionResult(run, { workerAttemptId: `attempt-${suffix}`, executionGeneration: 4 }), false, "a Worker result is accepted only after evidence collection is durably published");
  run = await runEventStore.append({ runId, type: "run_paused", expectedVersion: 6, actor: "tester", idempotencyKey: `pause-${suffix}` });
  assert.equal(run.state, "paused");
  run = await runEventStore.append({ runId, type: "run_resumed", expectedVersion: 7, actor: "tester", idempotencyKey: `resume-${suffix}` });
  assert.equal(run.state, "running");
  assert.equal((await runEventStore.events(runId)).length, 8);

  const legacyCompletedId = `legacy_completed_${suffix}`;
  let legacyCompleted = await runEventStore.create({ runId: legacyCompletedId, actor: "tester", idempotencyKey: `legacy-create-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "plan_generated", expectedVersion: legacyCompleted.version, actor: "planner", idempotencyKey: `legacy-plan-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "plan_approved", expectedVersion: legacyCompleted.version, actor: "tester", idempotencyKey: `legacy-approve-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "permission_granted", expectedVersion: legacyCompleted.version, actor: "tester", idempotencyKey: `legacy-permission-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "run_preparing", expectedVersion: legacyCompleted.version, actor: "worker", idempotencyKey: `legacy-prepare-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "run_started", expectedVersion: legacyCompleted.version, actor: "worker", idempotencyKey: `legacy-start-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "evidence_collecting", expectedVersion: legacyCompleted.version, actor: "worker", idempotencyKey: `legacy-evidence-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "run_judging", expectedVersion: legacyCompleted.version, actor: "worker", idempotencyKey: `legacy-judge-${suffix}` });
  legacyCompleted = await runEventStore.append({ runId: legacyCompletedId, type: "run_completed", expectedVersion: legacyCompleted.version, actor: "worker", idempotencyKey: `legacy-complete-${suffix}`, payload: {} });
  assert.equal(legacyCompleted.gateStatus, "needs-human-review", "legacy completion without an explicit final status must not replay as pass");

  const queuedPauseId = `queued_pause_${suffix}`;
  let queuedPause = await runEventStore.create({ runId: queuedPauseId, actor: "tester", idempotencyKey: `queued-create-${suffix}` });
  queuedPause = await runEventStore.append({ runId: queuedPauseId, type: "plan_generated", expectedVersion: queuedPause.version, actor: "planner", idempotencyKey: `queued-plan-${suffix}` });
  queuedPause = await runEventStore.append({ runId: queuedPauseId, type: "plan_approved", expectedVersion: queuedPause.version, actor: "tester", idempotencyKey: `queued-approve-${suffix}` });
  queuedPause = await runEventStore.append({ runId: queuedPauseId, type: "permission_granted", expectedVersion: queuedPause.version, actor: "tester", idempotencyKey: `queued-permission-${suffix}` });
  assert.equal(queuedPause.state, "queued");
  await assert.rejects(
    () => runEventStore.append({
      runId: queuedPauseId,
      type: "evidence_collecting",
      expectedVersion: queuedPause.version,
      actor: "late-worker",
      idempotencyKey: `queued-stale-evidence-${suffix}`
    }),
    /Invalid run transition: queued \+ evidence_collecting/,
    "a late Worker result must not write evidence into a newly queued generation"
  );
  queuedPause = await runEventStore.append({ runId: queuedPauseId, type: "run_paused", expectedVersion: queuedPause.version, actor: "tester", idempotencyKey: `queued-pause-${suffix}` });
  assert.equal(queuedPause.state, "paused");
  queuedPause = await runEventStore.append({ runId: queuedPauseId, type: "run_resumed", expectedVersion: queuedPause.version, actor: "tester", idempotencyKey: `queued-resume-${suffix}` });
  assert.equal(queuedPause.state, "queued", "a queued pause resumes to queued so a Worker can bind a fresh attempt");
  assert.equal(queuedPause.activeExecutionAttemptId, undefined);

  for (const [eventType, expectedState, expectedGate] of [
    ["human_review_requested", "awaiting-human-review", "needs-human-review"],
    ["run_blocked", "blocked", "blocked"]
  ] as const) {
    const rejectedId = `planner_rejected_${eventType}_${suffix}`;
    const created = await runEventStore.create({ runId: rejectedId, actor: "tester", idempotencyKey: `create-${eventType}-${suffix}` });
    const llmCall = {
      id: `llm_${eventType}_${suffix}`,
      runId: rejectedId,
      purpose: "planning" as const,
      provider: "openai-compatible" as const,
      model: "test-model",
      startedAt: new Date().toISOString(),
      durationMs: 12,
      status: "passed" as const,
      usage: { totalTokens: 42 }
    };
    const rejected = await runEventStore.append({
      runId: rejectedId,
      type: eventType,
      expectedVersion: created.version,
      actor: "planner",
      idempotencyKey: `reject-${eventType}-${suffix}`,
      payload: {
        provenance: { source: "llm", promptVersion: "plan-test", model: llmCall.model, llmCallId: llmCall.id, compilationStatus: "rejected", fallbackReason: "invalid_dsl" },
        llmCall,
        llmCalls: [llmCall],
        impactAnalysis: { nodes: [], edges: [], changedFiles: [], affectedRoutes: [], affectedPages: [], recommendedScenarioIds: [], explanationChains: [], lowConfidenceEdges: [], harnessGaps: [] }
      }
    });
    assert.equal(rejected.state, expectedState);
    assert.equal(rejected.gateStatus, expectedGate);
    assert.equal(rejected.planProvenance?.compilationStatus, "rejected");
    assert.equal(rejected.planProvenance?.fallbackReason, "invalid_dsl");
    assert.equal(rejected.plannerCall?.id, llmCall.id);
    assert.deepEqual(rejected.plannerCalls?.map((call) => call.id), [llmCall.id]);
    assert.ok(rejected.impactAnalysis);
  }

  // A restart must rebuild from the append-only events, even when the cached
  // projection was produced by an older reducer that omitted rejection audit
  // fields. This is the same replay path used by PostgreSQL get/append.
  const directory = await mkdtemp(path.join(tmpdir(), "ato-event-replay-"));
  const databaseFile = path.join(directory, "runs.sqlite");
  try {
    const beforeRestart = new SqliteRunEventStore(databaseFile);
    const replayRunId = `planner_replay_${suffix}`;
    const created = await beforeRestart.create({
      runId: replayRunId,
      actor: "tester",
      idempotencyKey: `replay-create-${suffix}`,
      payload: { requirement: "replay a rejected LLM plan" }
    });
    const llmCall = {
      id: `llm_replay_${suffix}`,
      runId: replayRunId,
      purpose: "planning" as const,
      provider: "openai-compatible" as const,
      model: "test-model",
      startedAt: new Date().toISOString(),
      durationMs: 8,
      status: "failed" as const,
      error: "invalid action DSL"
    };
    await beforeRestart.append({
      runId: replayRunId,
      type: "human_review_requested",
      expectedVersion: created.version,
      actor: "planner",
      idempotencyKey: `replay-rejected-${suffix}`,
      payload: {
        provenance: {
          source: "llm",
          promptVersion: "plan-replay-test",
          model: llmCall.model,
          llmCallId: llmCall.id,
          compilationStatus: "rejected",
          fallbackReason: "invalid_dsl"
        },
        llmCall,
        llmCalls: [llmCall]
      }
    });

    const database = new DatabaseSync(databaseFile);
    const stale = database.prepare("SELECT projection_json FROM run_projections WHERE run_id = ?").get(replayRunId) as { projection_json: string };
    const staleProjection = JSON.parse(stale.projection_json) as Record<string, unknown>;
    delete staleProjection.planProvenance;
    delete staleProjection.plannerCall;
    delete staleProjection.plannerCalls;
    database.prepare("UPDATE run_projections SET projection_json = ? WHERE run_id = ?").run(JSON.stringify(staleProjection), replayRunId);
    database.close();

    const afterRestart = new SqliteRunEventStore(databaseFile);
    const recovered = await afterRestart.get(replayRunId);
    assert.equal(recovered?.input.requirement, "replay a rejected LLM plan");
    assert.equal(recovered?.state, "awaiting-human-review");
    assert.equal(recovered?.gateStatus, "needs-human-review");
    assert.equal(recovered?.planProvenance?.compilationStatus, "rejected");
    assert.equal(recovered?.planProvenance?.fallbackReason, "invalid_dsl");
    assert.equal(recovered?.plannerCall?.id, llmCall.id);
    assert.deepEqual(recovered?.plannerCalls?.map((call) => call.id), [llmCall.id]);

    const idempotencyRunId = `idempotency_replay_${suffix}`;
    let idempotencyRun = await afterRestart.create({
      runId: idempotencyRunId,
      actor: "tester",
      idempotencyKey: `idempotency-create-${suffix}`
    });
    idempotencyRun = await afterRestart.append({
      runId: idempotencyRunId,
      type: "plan_generated",
      expectedVersion: idempotencyRun.version,
      actor: "planner",
      idempotencyKey: `idempotency-plan-${suffix}`
    });
    const approved = await afterRestart.append({
      runId: idempotencyRunId,
      type: "plan_approved",
      expectedVersion: idempotencyRun.version,
      actor: "tester",
      idempotencyKey: `idempotency-approval-${suffix}`
    });
    await afterRestart.append({
      runId: idempotencyRunId,
      type: "permission_granted",
      expectedVersion: approved.version,
      actor: "tester",
      idempotencyKey: `idempotency-permission-${suffix}`
    });
    const replayedApproval = await afterRestart.append({
      runId: idempotencyRunId,
      type: "plan_approved",
      expectedVersion: idempotencyRun.version,
      actor: "tester",
      idempotencyKey: `idempotency-approval-${suffix}`
    });
    assert.equal(replayedApproval.version, approved.version);
    assert.equal(replayedApproval.state, approved.state);
    assert.equal(isIdempotentReplay(replayedApproval), true);

    const continued = await afterRestart.append({
      runId: replayRunId,
      type: "decision_overridden",
      expectedVersion: recovered!.version,
      actor: "reviewer",
      idempotencyKey: `replay-review-${suffix}`,
      payload: { status: "blocked", originalDecision: "needs-human-review", newLabel: "invalid-plan", reason: "planner output did not compile" }
    });
    assert.equal(continued.version, 3);
    assert.equal(continued.planProvenance?.compilationStatus, "rejected");
    assert.equal(continued.plannerCall?.id, llmCall.id);
    assert.deepEqual(continued.plannerCalls?.map((call) => call.id), [llmCall.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
