import assert from "node:assert/strict";
import { agentPermissionProfileSchema } from "@ai-test-officer/contracts";
import { MemorySaver } from "@langchain/langgraph";
import { assertAgentGraphNodes, createAgentOrchestrationGraph } from "../src/index.js";

assert.equal(assertAgentGraphNodes().length, 14);

const projections: string[] = [];
const service = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    discover: async () => ({ coverageMap: { routes: 2 } }),
    plan: async () => ({ planData: { source: "deterministic" } }),
    compile: async () => ({ compiledPlan: { valid: true } }),
    onProjection: async (item) => { projections.push(`${item.currentNode}:${item.status}`); }
  }
});
await service.start({
  runId: "run_shadow_test",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({})
});
const state = await service.state("run_shadow_test");
assert.equal(state?.status, "completed");
assert.equal(state?.progress, 1);
assert.ok(projections.some((item) => item.startsWith("discover:")));

const activeProjections: Array<{ status: string; kind?: string }> = [];
const activeService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    onProjection: async (item) => {
      activeProjections.push({ status: item.status, kind: item.pendingInterrupt?.kind });
    }
  }
});
await activeService.start({
  runId: "run_active_interrupt_test",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({
    browserControl: true,
    sandboxCommand: true
  })
});
assert.ok(activeProjections.some((item) => item.status === "interrupted" && item.kind === "plan-approval"));
await activeService.resume("run_active_interrupt_test", { approved: true });
assert.ok(activeProjections.some((item) => item.status === "interrupted" && item.kind === "browser-permission"));
await activeService.resume("run_active_interrupt_test", { approved: true });
assert.ok(activeProjections.some((item) => item.status === "interrupted" && item.kind === "execution-result"));
await activeService.resume("run_active_interrupt_test", { execution: { finalStatus: "pass" } });
assert.equal((await activeService.state("run_active_interrupt_test"))?.status, "completed");

console.log("agent orchestration tests passed");
