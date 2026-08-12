import assert from "node:assert/strict";
import {
  agentPermissionProfileSchema,
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema
} from "@ai-test-officer/contracts";
import { MemorySaver } from "@langchain/langgraph";
import { assertAgentGraphNodes, createAgentOrchestrationGraph } from "../src/index.js";

assert.deepEqual(assertAgentGraphNodes(), [
  "intake",
  "discover",
  "diagnose-runtime",
  "choose-recovery",
  "recover",
  "verify-recovery",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities",
  "observe-browser",
  "decide-browser-action",
  "authorize-browser-action",
  "execute-browser-action",
  "verify-browser-action",
  "decide-next-step",
  "execute",
  "collect-and-gate",
  "triage-failure",
  "selective-judge",
  "repair",
  "retry-path",
  "continue-paths",
  "finalize"
]);

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
let plannedBeforeRecovery = false;
let recoveryCalls = 0;
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
    diagnoseRuntime: async () => ({ observation: { summary: "项目仍在启动" } }),
    chooseRecovery: async (state) => ({ recoveryDecision: {
      schemaVersion: "1.0", id: "recovery_waiting_test", runId: state.runId,
      action: "retry-discovery", reason: "project_runtime_starting", confidence: "high",
      evidenceRefs: [], preconditions: [], expectedState: "重新 Discovery", createdAt: new Date().toISOString(), policyVersion: "test"
    } }),
    recover: async (state) => {
      recoveryCalls += 1;
      return { recoveryResult: {
        schemaVersion: "1.0", actionId: "action_waiting_test", runId: state.runId,
        action: "retry-discovery", status: "completed", evidenceRefs: [], nextState: "verify-recovery",
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
      } };
    },
    plan: async () => {
      plannedAfterSmoke = true;
      if (recoveryCalls === 0) plannedBeforeRecovery = true;
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
assert.equal(plannedBeforeRecovery, true, "static planning must remain visible while runtime discovery is waiting");
assert.equal(recoveryCalls, 1);
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
assert.equal(blockedPlanCalls, 1, "blocked runtime Discovery must not hide the code-derived static plan");
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

const browserLoopNodes: string[] = [];
const browserRunId = "run_active_browser_loop";
const browserAttemptId = "attempt_browser_loop";
const browserObservation = browserObservationSchema.parse({
  schemaVersion: "1.0",
  observationId: "observation_browser_loop",
  runId: browserRunId,
  attemptId: browserAttemptId,
  coverageItemId: "coverage_browser_loop",
  requestedUrl: "http://127.0.0.1:4173/",
  finalUrl: "http://127.0.0.1:4173/",
  title: "Browser loop test",
  readyState: "complete",
  pageFingerprint: "a".repeat(64),
  bodyTextSample: "Ready",
  controls: [],
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  evidenceRefs: ["evidence_browser_loop"],
  createdAt: new Date().toISOString()
});
const browserSession = browserSessionSchema.parse({
  schemaVersion: "1.0",
  sessionId: "session_browser_loop",
  runId: browserRunId,
  attemptId: browserAttemptId,
  status: "ready",
  owner: "agent",
  currentUrl: browserObservation.finalUrl,
  lastObservationId: browserObservation.observationId,
  actionCount: 0,
  decisionCount: 1,
  rebindCount: 0,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});
const browserDecision = browserActionDecisionSchema.parse({
  schemaVersion: "1.0",
  decisionId: "decision_browser_loop",
  runId: browserRunId,
  attemptId: browserAttemptId,
  observationId: browserObservation.observationId,
  status: "act",
  summary: "Collect a fresh observation.",
  actions: [{
    actionId: "action_browser_loop",
    runId: browserRunId,
    attemptId: browserAttemptId,
    coverageItemId: "coverage_browser_loop",
    sourceObservationId: browserObservation.observationId,
    sourcePageFingerprint: browserObservation.pageFingerprint,
    action: "observe-page",
    purpose: "Verify the live browser action loop.",
    expectedChange: "A fresh observation is available.",
    oracleIds: [],
    risk: "low",
    timeoutMs: 1_000
  }],
  oracles: [],
  evidenceRefs: browserObservation.evidenceRefs,
  createdAt: new Date().toISOString()
});
const browserActionResult = browserActionResultSchema.parse({
  schemaVersion: "1.0",
  resultId: "result_browser_loop",
  actionId: browserDecision.actions[0]!.actionId,
  runId: browserRunId,
  attemptId: browserAttemptId,
  coverageItemId: "coverage_browser_loop",
  status: "completed",
  summary: "Observation completed.",
  beforeObservationId: browserObservation.observationId,
  afterObservationId: browserObservation.observationId,
  evidenceRefs: browserObservation.evidenceRefs,
  oracleResults: [],
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString()
});
const browserLoopService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    plan: async () => ({
      browserAgentRequired: true,
      currentCoverageItemId: "coverage_browser_loop",
      currentAttemptId: browserAttemptId
    }),
    observeBrowser: async () => ({ browserSession, browserObservation }),
    decideBrowserAction: async () => ({ browserDecision }),
    authorizeBrowserAction: async () => ({ browserActionAuthorized: true }),
    executeBrowserAction: async () => ({ browserActionResult }),
    decideNextStep: async () => ({ browserLoopComplete: true }),
    collectAndGate: async () => ({ gate: { machineGate: { status: "pass" } }, failure: {} }),
    onProjection: async (item) => {
      if (item.currentNode) browserLoopNodes.push(item.currentNode);
    }
  }
});
await browserLoopService.start({
  runId: browserRunId,
  mode: "active",
  planApproved: true,
  capabilitiesApproved: true,
  permissionProfile: agentPermissionProfileSchema.parse({ browserControl: true })
});
for (const expected of [
  "observe-browser",
  "decide-browser-action",
  "authorize-browser-action",
  "execute-browser-action",
  "verify-browser-action",
  "decide-next-step",
  "collect-and-gate",
  "finalize"
]) assert.ok(browserLoopNodes.includes(expected), `browser loop did not visit ${expected}`);
assert.equal((await browserLoopService.state(browserRunId))?.status, "completed");

// A full-scan run can contain page paths plus manifest-bound API/data/job
// paths. Finishing the browser loop must hand the remaining structured paths
// to the Worker instead of jumping directly to the gate.
const mixedNodes: string[] = [];
const mixedRunId = "run_active_mixed_browser_structured";
const mixedService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    plan: async () => ({
      browserAgentRequired: true,
      currentCoverageItemId: "coverage_browser_loop",
      currentAttemptId: browserAttemptId
    }),
    observeBrowser: async () => ({
      browserSession: { ...browserSession, runId: mixedRunId },
      browserObservation: { ...browserObservation, runId: mixedRunId }
    }),
    decideBrowserAction: async () => ({
      browserDecision: { ...browserDecision, runId: mixedRunId }
    }),
    authorizeBrowserAction: async () => ({ browserActionAuthorized: true }),
    executeBrowserAction: async () => ({
      browserActionResult: { ...browserActionResult, runId: mixedRunId }
    }),
    decideNextStep: async () => ({ browserLoopComplete: true, remainingPathCount: 2 }),
    collectAndGate: async () => ({ gate: { machineGate: { status: "pass" } }, failure: {} }),
    onProjection: async (item) => {
      if (item.currentNode) mixedNodes.push(item.currentNode);
    }
  }
});
await mixedService.start({
  runId: mixedRunId,
  mode: "active",
  planApproved: true,
  capabilitiesApproved: true,
  permissionProfile: agentPermissionProfileSchema.parse({ browserControl: true })
});
assert.ok(mixedNodes.includes("execute"), "mixed full-scan did not hand structured paths to the Worker");
assert.equal((await mixedService.state(mixedRunId))?.pendingInterrupt?.kind, "execution-result");
await mixedService.resume(mixedRunId, { execution: { aggregate: true, childRunIds: ["path_api", "path_job"] } });
assert.equal((await mixedService.state(mixedRunId))?.status, "completed");

console.log("agent orchestration tests passed");
