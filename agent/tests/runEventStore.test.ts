import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runEventStore } from "../src/runEventStore.js";

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
  await assert.rejects(() => runEventStore.append({ runId, type: "run_preparing", expectedVersion: 2, actor: "tester", idempotencyKey: `stale-${suffix}` }), /version_conflict/);
  run = await runEventStore.append({ runId, type: "run_preparing", expectedVersion: 4, actor: "worker", idempotencyKey: `prepare-${suffix}` });
  run = await runEventStore.append({ runId, type: "run_started", expectedVersion: 5, actor: "worker", idempotencyKey: `start-${suffix}` });
  run = await runEventStore.append({ runId, type: "run_paused", expectedVersion: 6, actor: "tester", idempotencyKey: `pause-${suffix}` });
  assert.equal(run.state, "paused");
  run = await runEventStore.append({ runId, type: "run_resumed", expectedVersion: 7, actor: "tester", idempotencyKey: `resume-${suffix}` });
  assert.equal(run.state, "running");
  assert.equal((await runEventStore.events(runId)).length, 8);
}
