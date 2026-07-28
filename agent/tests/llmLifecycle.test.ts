import assert from "node:assert/strict";
import { publishLlmLifecycle, subscribeLlmLifecycle } from "../src/llmLifecycle.js";

export function testLlmLifecycle() {
  const received: string[] = [];
  const unsubscribe = subscribeLlmLifecycle("run_lifecycle_test", (event) => {
    received.push(`${event.name}:${event.callId}`);
  });
  publishLlmLifecycle({
    name: "llm.call.started",
    runId: "run_lifecycle_test",
    callId: "llm_test",
    at: new Date().toISOString(),
    payload: { purpose: "planning" }
  });
  publishLlmLifecycle({
    name: "llm.call.retried",
    runId: "run_lifecycle_test",
    callId: "llm_test",
    at: new Date().toISOString(),
    payload: { attempt: 1 }
  });
  unsubscribe();
  publishLlmLifecycle({
    name: "llm.call.completed",
    runId: "run_lifecycle_test",
    callId: "llm_test",
    at: new Date().toISOString(),
    payload: {}
  });
  assert.deepEqual(received, [
    "llm.call.started:llm_test",
    "llm.call.retried:llm_test"
  ]);
}
