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

const waitingProjections: Array<{ status: string; node?: string; title?: string }> = [];
let discoveryAttempts = 0;
let plannedAfterSmoke = false;
const waitingService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    discover: async () => {
      discoveryAttempts += 1;
      return {
        coverageMap: {
          discovery: discoveryAttempts === 1
            ? { status: "waiting", reason: "project_runtime_starting" }
            : { status: "ready", reason: "browser_smoke_ready" }
        }
      };
    },
    plan: async () => {
      plannedAfterSmoke = true;
      return { planData: { source: "deterministic" } };
    },
    compile: async () => ({ compiledPlan: { valid: true } }),
    onProjection: async (item) => {
      waitingProjections.push({
        status: item.status,
        node: item.currentNode,
        title: item.pendingInterrupt?.title
      });
    }
  }
});
await waitingService.start({
  runId: "run_active_discovery_waiting",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({})
});
assert.equal(plannedAfterSmoke, false, "planning must not run before the browser smoke is ready");
assert.ok(waitingProjections.some((item) =>
  item.status === "interrupted"
  && item.node === "discover"
  && item.title === "等待项目页面就绪"
));
await waitingService.resume("run_active_discovery_waiting", { retry: true });
assert.equal(discoveryAttempts >= 2, true);
assert.equal(plannedAfterSmoke, true, "planning may continue only after a fresh ready smoke");

let blockedPlanCalls = 0;
let blockedFinalizeCalls = 0;
const blockedService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    discover: async () => ({
      coverageMap: {
        discovery: {
          status: "failed",
          reason: "page_opened_without_interactive_controls"
        }
      },
      discoveryTerminal: true,
      gate: {
        machineGate: {
          status: "blocked",
          reasons: ["discovery_failed:page_opened_without_interactive_controls"],
          reasonDetails: [],
          assertionFailures: [],
          evidenceComplete: false
        }
      }
    }),
    plan: async () => {
      blockedPlanCalls += 1;
      return {};
    },
    finalize: async () => {
      blockedFinalizeCalls += 1;
      return { status: "completed" };
    }
  }
});
await blockedService.start({
  runId: "run_active_discovery_blocked",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({})
});
assert.equal(blockedPlanCalls, 0, "blocked Discovery must not reach coverage expansion or planning");
assert.equal(blockedFinalizeCalls, 1);
assert.equal((await blockedService.state("run_active_discovery_blocked"))?.status, "completed");

let shadowPlanCalls = 0;
const shadowCompatibilityService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    discover: async () => ({
      coverageMap: { discovery: { status: "waiting" } },
      // A historical shadow hook may expose diagnostics, but shadow mode must
      // preserve its existing linear comparison path.
      discoveryTerminal: true
    }),
    plan: async () => {
      shadowPlanCalls += 1;
      return {};
    }
  }
});
await shadowCompatibilityService.start({
  runId: "run_shadow_discovery_compatibility",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({})
});
assert.equal(shadowPlanCalls, 1, "shadow behavior must remain linear and non-authoritative");

console.log("agent orchestration tests passed");
