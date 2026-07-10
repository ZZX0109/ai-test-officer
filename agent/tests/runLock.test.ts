import assert from "node:assert/strict";
import { listRunLocks, withProjectRunLock } from "../src/runLock.js";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function testRunLockGovernance() {
  const projectId = "run_lock_contract_project";
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = withProjectRunLock(projectId, async () => {
    order.push("start:first");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    order.push("end:first");
    return "first";
  });

  while (!order.includes("start:first")) {
    await delay(5);
  }

  let secondStarted = false;
  const second = withProjectRunLock(projectId, async () => {
    secondStarted = true;
    order.push("start:second");
    order.push("end:second");
    return "second";
  });

  await delay(40);
  assert.equal(secondStarted, false, "second run should wait for the per-project lock");
  assert.equal(listRunLocks().some((lock) => lock.projectId === projectId), true);

  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
  assert.equal(listRunLocks().some((lock) => lock.projectId === projectId), false);
}
