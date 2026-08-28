import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemoryTrajectoryEventStore, SqliteTrajectoryEventStore } from "../src/trajectoryEventStore.js";
import { TrajectoryEmitter } from "../src/trajectoryEmitter.js";
import { appendTrajectoryEvent, prependTrajectoryEvents, projectTrajectoryEvents, replayTrajectory } from "../src/trajectoryProjector.js";

const eventInput = (runId: string, type: "run.created" | "run.failed" | "tool.call.started" | "tool.call.completed" | "evidence.created", key: string, payload: Record<string, unknown> = {}) => ({
  schemaVersion: "1.0" as const, runId, type, actor: "test", idempotencyKey: key, payload
});

export async function testTrajectoryEventStore() {
  const runId = `trajectory_${randomUUID()}`;
  const store = new MemoryTrajectoryEventStore();
  const first = await store.append(eventInput(runId, "run.created", "one"));
  const started = await store.append(eventInput(runId, "tool.call.started", "two", { callId: "call-1", toolName: "browser.observe" }));
  const completed = await store.append(eventInput(runId, "tool.call.completed", "three", { callId: "call-1", toolName: "browser.observe", durationMs: 12 }));
  assert.deepEqual([first.seq, started.seq, completed.seq], [1, 2, 3]);
  assert.equal((await store.append(eventInput(runId, "tool.call.completed", "three"))).id, completed.id, "idempotent appends replay the same event");
  assert.deepEqual((await store.read(runId, { afterSeq: 1, limit: 1 })).map((item) => item.seq), [2]);

  const projector = projectTrajectoryEvents([first, started, completed]);
  const appended = appendTrajectoryEvent(appendTrajectoryEvent(appendTrajectoryEvent(undefined, first), started), completed);
  const prepended = prependTrajectoryEvents(prependTrajectoryEvents(prependTrajectoryEvents(undefined, completed), started), [first]);
  assert.deepEqual(replayTrajectory(projector.events), projector);
  assert.deepEqual(appended, projector, "full replay equals incremental append projection");
  assert.deepEqual(prepended, projector, "full replay equals out-of-order prepend projection");
  assert.equal(projector.tools[0]?.status, "completed");

  const interruptedRun = `trajectory_interrupted_${randomUUID()}`;
  const interrupted = projectTrajectoryEvents([
    await store.append(eventInput(interruptedRun, "tool.call.started", "i-start", { callId: "call-i", toolName: "api.request", apiKey: "do-not-persist" })),
    await store.append(eventInput(interruptedRun, "run.failed", "i-fail", { error: "timeout" }))
  ]);
  assert.equal(interrupted.tools[0]?.status, "interrupted");
  assert.equal(JSON.stringify(interrupted.events).includes("do-not-persist"), false, "trajectory payloads are redacted before persistence");

  const emitted: number[] = [];
  const emitter = new TrajectoryEmitter(store);
  const unsubscribe = emitter.subscribe(runId, (event) => emitted.push(event.seq));
  await emitter.emit(eventInput(runId, "evidence.created", "four", { evidenceId: "e-1" }));
  await emitter.emit(eventInput(runId, "evidence.created", "four", { evidenceId: "e-1" }));
  unsubscribe();
  assert.deepEqual(emitted, [4], "replayed idempotent events are not emitted twice in one process");

  const orderedEmitter = new TrajectoryEmitter(new MemoryTrajectoryEventStore());
  await Promise.all([
    orderedEmitter.emit(eventInput("ordered-run", "run.created", "ordered-1")),
    orderedEmitter.emit(eventInput("ordered-run", "run.failed", "ordered-2"))
  ]);
  assert.deepEqual((await orderedEmitter.read("ordered-run")).map((event) => event.seq), [1, 2], "concurrent emitter writes keep source order");

  const directory = await mkdtemp(path.join(tmpdir(), "ato-trajectory-"));
  try {
    const sqlite = new SqliteTrajectoryEventStore(path.join(directory, "trajectory.sqlite"));
    await sqlite.append(eventInput(runId, "run.created", "sqlite-one"));
    await sqlite.append(eventInput(runId, "evidence.created", "sqlite-two"));
    assert.deepEqual((await sqlite.read(runId)).map((item) => item.seq), [1, 2]);
    await sqlite.append({ ...eventInput("sqlite-child", "evidence.created", "sqlite-child-one", { parentRunId: runId }), parentRunId: runId });
    const reopened = new SqliteTrajectoryEventStore(path.join(directory, "trajectory.sqlite"));
    await reopened.append(eventInput("sqlite-child", "evidence.created", "sqlite-child-two", { parentRunId: runId }));
    assert.deepEqual((await reopened.readTree(runId)).map((item) => item.rootSeq), [1, 2, 3, 4]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const treeStore = new MemoryTrajectoryEventStore();
  await treeStore.append(eventInput("root-run", "run.created", "root-created", { rootRunId: "root-run" }));
  await treeStore.append({ ...eventInput("child-a", "tool.call.started", "child-start", { callId: "child-call", toolName: "browser.observe", parentRunId: "root-run" }), parentRunId: "root-run", rootRunId: "root-run" });
  await treeStore.append({ ...eventInput("child-b", "tool.call.completed", "child-complete", { callId: "child-b-call", toolName: "assert.evaluate", parentRunId: "root-run" }), parentRunId: "root-run", rootRunId: "root-run" });
  const tree = await treeStore.readTree("root-run");
  assert.deepEqual(tree.map((item) => item.rootSeq), [1, 2, 3]);
  assert.deepEqual(tree.map((item) => item.runSeq), [1, 1, 1]);
  assert.equal(projectTrajectoryEvents(tree, "root-run").events.length, 3);

  // SSE reconnect contract: the client persists the global root cursor and
  // asks the append-only store for only events after that cursor. A reconnect
  // therefore neither drops child-run events nor replays an already delivered
  // event.
  const reconnectEmitter = new TrajectoryEmitter(treeStore);
  const deliveredAfterReconnect: number[] = [];
  const lastDeliveredRootSeq = tree.at(-1)?.rootSeq ?? 0;
  const unsubscribeReconnect = reconnectEmitter.subscribe("child-a", (event) => {
    const rootSeq = event.rootSeq ?? event.seq;
    if (rootSeq > lastDeliveredRootSeq) deliveredAfterReconnect.push(rootSeq);
  });
  await reconnectEmitter.emit({
    ...eventInput("child-a", "tool.call.completed", "child-reconnect", { callId: "child-call", toolName: "browser.observe" }),
    parentRunId: "root-run",
    rootRunId: "root-run"
  });
  unsubscribeReconnect();
  assert.deepEqual(deliveredAfterReconnect, [4]);
  const resumed = await treeStore.readTree("root-run", { afterRootSeq: lastDeliveredRootSeq });
  assert.deepEqual(resumed.map((item) => item.rootSeq), [4]);
  assert.equal((await treeStore.readTree("root-run", { afterRootSeq: 4 })).length, 0);
}
