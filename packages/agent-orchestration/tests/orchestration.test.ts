import assert from "node:assert/strict";
import {
  agentPermissionProfileSchema,
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema
} from "@ai-test-officer/contracts";
import { MemorySaver } from "@langchain/langgraph";
import {
  assertAgentGraphNodes,
  createAgentOrchestrationGraph,
  createBrowserExecutionSubgraph,
  createDiscoverySubgraph,
  createEvidenceGateSubgraph,
  createFailureTriageSubgraph,
  createFinalizationSubgraph,
  createNonBrowserExecutionSubgraph,
  createPlanningSubgraph,
  createRepairValidationSubgraph,
  createRuntimeRecoverySubgraph
} from "../src/index.js";
import { assertTypedSubgraphCoverage, subgraphForNode } from "../src/subgraphs.js";

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
assert.equal(assertTypedSubgraphCoverage(assertAgentGraphNodes()).length, 9);
assert.equal(subgraphForNode("collect-and-gate")?.name, "evidence-gate");

// Discovery is a complete two-step child graph. It accepts no planning,
// execution, repair or gate state and can be invoked independently.
const isolatedDiscoveryNodes: string[] = [];
let isolatedDiscoveryInput: Record<string, unknown> | undefined;
const isolatedDiscovery = createDiscoverySubgraph({
  intake: async (state) => {
    isolatedDiscoveryNodes.push("intake");
    isolatedDiscoveryInput = state as Record<string, unknown>;
    return { observation: { stage: "intake", status: "ready" } };
  },
  discover: async () => {
    isolatedDiscoveryNodes.push("discover");
    return { coverageMap: { status: "ready" }, discoveryTerminal: false };
  }
});
const isolatedDiscoveryResult = await isolatedDiscovery.invoke({
  runId: "run_isolated_discovery",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({}),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString()
});
assert.deepEqual(isolatedDiscoveryNodes, ["intake", "discover"]);
assert.equal(isolatedDiscoveryResult.coverageMap?.status, "ready");
assert.equal("planData" in (isolatedDiscoveryInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedDiscoveryInput ?? {}), false);

// Planning is independently compiled up to the durable human approval. Its
// child state cannot reach execution, evidence, recovery or repair fields.
const isolatedPlanningNodes: string[] = [];
let isolatedPlanningInput: Record<string, unknown> | undefined;
const isolatedPlanning = createPlanningSubgraph({
  buildCoverageMap: async (state) => {
    isolatedPlanningNodes.push("build-coverage-map");
    isolatedPlanningInput = state as Record<string, unknown>;
    return { coverageMap: { status: "ready", items: [{ id: "coverage_isolated_planning" }] } };
  },
  plan: async () => {
    isolatedPlanningNodes.push("plan");
    return { planData: { plan: { source: "deterministic" } }, browserAgentRequired: true };
  },
  compile: async () => {
    isolatedPlanningNodes.push("compile");
    return { compiledPlan: { compiledPlan: { valid: true } } };
  }
});
const isolatedPlanningResult = await isolatedPlanning.invoke({
  runId: "run_isolated_planning",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({}),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString()
});
assert.deepEqual(isolatedPlanningNodes, ["build-coverage-map", "plan", "compile"]);
assert.equal(isolatedPlanningResult.compiledPlan?.compiledPlan?.valid, true);
assert.equal(isolatedPlanningResult.browserAgentRequired, true);
assert.equal("execution" in (isolatedPlanningInput ?? {}), false);
assert.equal("gate" in (isolatedPlanningInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedPlanningInput ?? {}), false);

// Runtime Recovery runs as one compiled transaction. It can decide, recover,
// verify and create a retry without getting access to planning or gate state.
const isolatedRecoveryNodes: string[] = [];
let isolatedRecoveryInput: Record<string, unknown> | undefined;
const isolatedRuntimeRecovery = createRuntimeRecoverySubgraph({
  diagnoseRuntime: async (state) => {
    isolatedRecoveryNodes.push("diagnose-runtime");
    isolatedRecoveryInput = state as Record<string, unknown>;
    return { observation: { stage: "recovery", status: "failed" } };
  },
  chooseRecovery: async (state) => {
    isolatedRecoveryNodes.push("choose-recovery");
    return {
      recoveryDecision: {
        schemaVersion: "1.0",
        id: "recovery_isolated",
        runId: state.runId,
        action: "retry-path",
        reason: "isolated retry",
        confidence: "high",
        evidenceRefs: [],
        preconditions: [],
        expectedState: "queued",
        createdAt: new Date().toISOString(),
        policyVersion: "test"
      }
    };
  },
  recover: async (state) => {
    isolatedRecoveryNodes.push("recover");
    return {
      recoveryResult: {
        schemaVersion: "1.0",
        actionId: "action_recovery_isolated",
        runId: state.runId,
        action: "retry-path",
        status: "completed",
        evidenceRefs: [],
        nextState: "verify-recovery",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      }
    };
  },
  verifyRecovery: async () => {
    isolatedRecoveryNodes.push("verify-recovery");
    return {};
  },
  retryPath: async () => {
    isolatedRecoveryNodes.push("retry-path");
    return { currentAttemptId: "attempt_recovery_isolated" };
  }
});
const isolatedRecoveryResult = await isolatedRuntimeRecovery.invoke({
  runId: "run_isolated_recovery",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({}),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString(),
  failure: { status: "fail", reason: "isolated retry" }
});
assert.deepEqual(isolatedRecoveryNodes, ["diagnose-runtime", "choose-recovery", "recover", "verify-recovery", "retry-path"]);
assert.equal(isolatedRecoveryResult.currentAttemptId, "attempt_recovery_isolated");
assert.equal("compiledPlan" in (isolatedRecoveryInput ?? {}), false);
assert.equal("gate" in (isolatedRecoveryInput ?? {}), false);
assert.equal("browserSession" in (isolatedRecoveryInput ?? {}), false);

// Browser execution has an independently compiled no-action completion path.
// The child only sees browser-loop fields, never verdict or recovery state.
const isolatedBrowserNodes: string[] = [];
let isolatedBrowserInput: Record<string, unknown> | undefined;
const isolatedBrowser = createBrowserExecutionSubgraph({
  prepareSandbox: async (state) => {
    isolatedBrowserNodes.push("prepare-sandbox");
    isolatedBrowserInput = state as Record<string, unknown>;
    return { browserAgentRequired: true };
  },
  approveCapabilities: async () => {
    isolatedBrowserNodes.push("approve-capabilities");
    return { capabilitiesApproved: true };
  },
  observeBrowser: async () => {
    isolatedBrowserNodes.push("observe-browser");
    return {};
  },
  decideBrowserAction: async (state) => {
    isolatedBrowserNodes.push("decide-browser-action");
    return {
      browserDecision: browserActionDecisionSchema.parse({
        schemaVersion: "1.0",
        decisionId: "browser_decision_isolated",
        runId: state.runId,
        attemptId: "attempt_browser_isolated",
        observationId: "observation_browser_isolated",
        status: "complete",
        summary: "No further browser action is needed.",
        actions: [],
        oracles: [],
        createdAt: new Date().toISOString()
      })
    };
  },
  decideNextStep: async () => {
    isolatedBrowserNodes.push("decide-next-step");
    return { browserLoopComplete: true, remainingPathCount: 0 };
  }
});
const isolatedBrowserResult = await isolatedBrowser.invoke({
  runId: "run_isolated_browser",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({ browserControl: true }),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString()
});
assert.deepEqual(isolatedBrowserNodes, ["prepare-sandbox", "approve-capabilities", "observe-browser", "decide-browser-action", "decide-next-step"]);
assert.equal(isolatedBrowserResult.browserLoopComplete, true);
assert.equal("gate" in (isolatedBrowserInput ?? {}), false);
assert.equal("failure" in (isolatedBrowserInput ?? {}), false);
assert.equal("recoveryDecision" in (isolatedBrowserInput ?? {}), false);

// Non-browser execution includes the one bounded continuation after Repair.
// It receives execution inputs and cannot inspect verdict, failure or repair
// payloads beyond the entry-node marker.
const isolatedNonBrowserNodes: string[] = [];
let isolatedNonBrowserInput: Record<string, unknown> | undefined;
const isolatedNonBrowser = createNonBrowserExecutionSubgraph({
  continuePaths: async (state) => {
    isolatedNonBrowserNodes.push("continue-paths");
    isolatedNonBrowserInput = state as Record<string, unknown>;
    return { remainingPathCount: 1, continuationPasses: 0 };
  },
  execute: async () => {
    isolatedNonBrowserNodes.push("execute");
    return { execution: { finalStatus: "pass" }, remainingPathCount: 0 };
  }
});
const isolatedNonBrowserResult = await isolatedNonBrowser.invoke({
  runId: "run_isolated_non_browser",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({ targetNetwork: true }),
  status: "running",
  currentNode: "repair",
  completedNodes: ["repair"],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString()
});
assert.deepEqual(isolatedNonBrowserNodes, ["continue-paths", "execute"]);
assert.equal(isolatedNonBrowserResult.execution?.finalStatus, "pass");
assert.equal("gate" in (isolatedNonBrowserInput ?? {}), false);
assert.equal("failure" in (isolatedNonBrowserInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedNonBrowserInput ?? {}), false);

// Failure triage is independently compiled. It receives only current evidence
// facts and may ask the Judge for advice without gaining plan or repair access.
const isolatedTriageNodes: string[] = [];
let isolatedTriageInput: Record<string, unknown> | undefined;
const isolatedTriage = createFailureTriageSubgraph({
  triageFailure: async (state) => {
    isolatedTriageNodes.push("triage-failure");
    isolatedTriageInput = state as Record<string, unknown>;
    return { failure: { status: "fail", needsLlmJudge: true } };
  },
  selectiveJudge: async () => {
    isolatedTriageNodes.push("selective-judge");
    return {
      gate: { finalStatus: "fail", judgeRecommendation: { status: "fail" } },
      judge: { impact: "machine-gate-preserved" }
    };
  }
});
const isolatedTriageResult = await isolatedTriage.invoke({
  runId: "run_isolated_triage",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({}),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString(),
  gate: { finalStatus: "fail" }
});
assert.deepEqual(isolatedTriageNodes, ["triage-failure", "selective-judge"]);
assert.equal(isolatedTriageResult.judge?.impact, "machine-gate-preserved");
assert.equal(isolatedTriageResult.gate?.finalStatus, "fail");
assert.equal("compiledPlan" in (isolatedTriageInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedTriageInput ?? {}), false);

// Recovery has priority over LLM advice. The child must preserve the parent
// routing rule instead of spending Judge budget before a bounded retry.
const recoveryPriorityNodes: string[] = [];
const recoveryPriorityTriage = createFailureTriageSubgraph({
  triageFailure: async (state) => {
    recoveryPriorityNodes.push("triage-failure");
    return {
      failure: { status: "blocked", needsLlmJudge: true },
      recoveryDecision: {
        schemaVersion: "1.0",
        id: "recovery_triage_priority",
        runId: state.runId,
        action: "retry-path",
        reason: "retry before judging",
        confidence: "high",
        evidenceRefs: [],
        preconditions: [],
        expectedState: "queued",
        createdAt: new Date().toISOString(),
        policyVersion: "test"
      }
    };
  },
  selectiveJudge: async () => {
    recoveryPriorityNodes.push("selective-judge");
    return { judge: { error: "must_not_run" } };
  }
});
await recoveryPriorityTriage.invoke({
  runId: "run_triage_recovery_priority",
  mode: "shadow",
  permissionProfile: agentPermissionProfileSchema.parse({}),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString()
});
assert.deepEqual(recoveryPriorityNodes, ["triage-failure"]);

// Repair is a native compiled child because it may emit a durable human
// interrupt. Its direct contract deliberately excludes executable-plan, gate
// and browser-control state.
let isolatedRepairInput: Record<string, unknown> | undefined;
const isolatedRepair = createRepairValidationSubgraph({
  repair: async (state) => {
    isolatedRepairInput = state as Record<string, unknown>;
    return {
      repairSessionId: `repair_${state.runId}`,
      observation: { stage: "repair", status: "ready" }
    };
  }
});
const isolatedRepairResult = await isolatedRepair.invoke({
  runId: "run_isolated_repair",
  mode: "active",
  permissionProfile: agentPermissionProfileSchema.parse({ sandboxCommand: true }),
  status: "running",
  completedNodes: [],
  progress: 0,
  tokenUsage: 0,
  updatedAt: new Date().toISOString(),
  failure: { status: "fail", reason: "isolated repair" }
});
assert.equal(isolatedRepairResult.repairSessionId, "repair_run_isolated_repair");
assert.equal(isolatedRepairResult.observation?.stage, "repair");
assert.equal("compiledPlan" in (isolatedRepairInput ?? {}), false);
assert.equal("gate" in (isolatedRepairInput ?? {}), false);
assert.equal("browserSession" in (isolatedRepairInput ?? {}), false);

// Evidence/Gate is independently compiled with a deliberately narrow state
// surface. Planning, repair and arbitrary parent graph values cannot cross the
// boundary into a collector by accident.
let isolatedEvidenceInput: Record<string, unknown> | undefined;
const isolatedEvidenceGate = createEvidenceGateSubgraph({
  collectAndGate: async (state) => {
    isolatedEvidenceInput = state as Record<string, unknown>;
    return {
      execution: { resultRunId: state.runId },
      gate: { finalStatus: "pass" }
    };
  }
});
const isolatedEvidenceResult = await isolatedEvidenceGate.invoke({
  runId: "run_isolated_evidence_gate",
  mode: "shadow",
  execution: { attemptId: "attempt_isolated_evidence_gate" }
});
assert.equal(isolatedEvidenceResult.gate?.finalStatus, "pass");
assert.equal(isolatedEvidenceResult.execution?.resultRunId, "run_isolated_evidence_gate");
assert.equal("coverageMap" in (isolatedEvidenceInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedEvidenceInput ?? {}), false);

let isolatedFinalizationInput: Record<string, unknown> | undefined;
const isolatedFinalization = createFinalizationSubgraph({
  finalize: async (state) => {
    isolatedFinalizationInput = state as Record<string, unknown>;
    return { status: "completed", execution: { ...(state.execution ?? {}), finalStatus: "pass" } };
  }
});
const isolatedFinalizationResult = await isolatedFinalization.invoke({
  runId: "run_isolated_finalization",
  mode: "shadow",
  execution: { resultRunId: "run_isolated_finalization" }
});
assert.equal(isolatedFinalizationResult.status, "completed");
assert.equal(isolatedFinalizationResult.execution?.finalStatus, "pass");
assert.equal("planData" in (isolatedFinalizationInput ?? {}), false);
assert.equal("repairSessionId" in (isolatedFinalizationInput ?? {}), false);

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
for (const node of [
  "intake",
  "discover",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities",
  "execute",
  "collect-and-gate",
  "triage-failure",
  "finalize"
] as const) assert.ok(state?.completedNodes.includes(node), `completed node projection missing ${node}`);
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

// A delegated dynamic parent may still be checkpointed at capability approval
// when its path children finish. The aggregate resume must carry both the
// approval and aggregate payload, then route directly to the Gate subgraph
// instead of opening the parent's browser session.
const delegatedNodes: string[] = [];
const delegatedService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    plan: async () => ({ browserAgentRequired: true }),
    collectAndGate: async () => ({ gate: { machineGate: { status: "blocked" } }, failure: {} }),
    onProjection: async (item) => { if (item.currentNode) delegatedNodes.push(item.currentNode); }
  }
});
await delegatedService.start({
  runId: "run_delegated_dynamic_parent",
  mode: "active",
  planApproved: true,
  permissionProfile: agentPermissionProfileSchema.parse({ browserControl: true })
});
assert.equal((await delegatedService.state("run_delegated_dynamic_parent"))?.pendingInterrupt?.kind, "browser-permission");
await delegatedService.resume("run_delegated_dynamic_parent", {
  approved: true,
  execution: { aggregate: true, dynamicBrowserChildren: true, childRunIds: ["path_1"] }
});
assert.ok(delegatedNodes.includes("collect-and-gate"));
assert.equal(delegatedNodes.includes("observe-browser"), false);
assert.equal((await delegatedService.state("run_delegated_dynamic_parent"))?.status, "completed");

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
  summary: "Evaluate the declared page state.",
  actions: [{
    actionId: "action_browser_loop",
    runId: browserRunId,
    attemptId: browserAttemptId,
    coverageItemId: "coverage_browser_loop",
    sourceObservationId: browserObservation.observationId,
    sourcePageFingerprint: browserObservation.pageFingerprint,
    action: "evaluate-oracle",
    purpose: "Verify the live browser action loop without a no-op observation action.",
    expectedChange: "The declared page state is evaluated.",
    oracleIds: ["oracle_browser_loop"],
    risk: "low",
    timeoutMs: 1_000
  }],
  oracles: [{ id: "oracle_browser_loop", type: "text", operator: "contains", expected: "Ready", description: "Page reports ready." }],
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
  summary: "Oracle evaluation completed.",
  beforeObservationId: browserObservation.observationId,
  afterObservationId: browserObservation.observationId,
  evidenceRefs: browserObservation.evidenceRefs,
  oracleResults: [{ oracleId: "oracle_browser_loop", passed: true, actual: "Ready", evidenceRefs: browserObservation.evidenceRefs }],
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

// A large full scan must not put every dynamic page path into a single graph
// invocation. The browser batch handshake checkpoints after a bounded group,
// then resumes the same thread before continuing the loop.
const browserBatchNodes: string[] = [];
let browserBatchSteps = 0;
const browserBatchRunId = "run_active_browser_batch";
const browserBatchService = createAgentOrchestrationGraph({
  checkpointer: new MemorySaver(),
  hooks: {
    plan: async () => ({
      browserAgentRequired: true,
      currentCoverageItemId: "coverage_browser_batch",
      currentAttemptId: browserAttemptId
    }),
    observeBrowser: async () => ({
      browserSession: { ...browserSession, runId: browserBatchRunId },
      browserObservation: { ...browserObservation, runId: browserBatchRunId }
    }),
    decideBrowserAction: async () => ({ browserDecision: { ...browserDecision, runId: browserBatchRunId } }),
    authorizeBrowserAction: async () => ({ browserActionAuthorized: true }),
    executeBrowserAction: async () => ({ browserActionResult: { ...browserActionResult, runId: browserBatchRunId } }),
    decideNextStep: async () => {
      browserBatchSteps += 1;
      return browserBatchSteps === 1
        ? { browserBatchPending: true, browserBatchDelayMs: 5_000, browserLoopComplete: false, browserBatchPathCount: 3 }
        : { browserBatchPending: false, browserLoopComplete: true };
    },
    collectAndGate: async () => ({ gate: { machineGate: { status: "pass" } }, failure: {} }),
    onProjection: async (item) => {
      if (item.currentNode) browserBatchNodes.push(item.currentNode);
    }
  }
});
await browserBatchService.start({
  runId: browserBatchRunId,
  mode: "active",
  planApproved: true,
  capabilitiesApproved: true,
  permissionProfile: agentPermissionProfileSchema.parse({ browserControl: true })
});
const browserBatchPaused = await browserBatchService.state(browserBatchRunId);
assert.equal(browserBatchPaused?.pendingInterrupt?.kind, "execution-result");
assert.equal(browserBatchPaused?.pendingInterrupt?.payload.phase, "browser-batch");
assert.equal(browserBatchPaused?.pendingInterrupt?.payload.delayMs, 5_000);
await browserBatchService.resume(browserBatchRunId, { execution: { phase: "browser-batch" } });
assert.equal((await browserBatchService.state(browserBatchRunId))?.status, "completed");
assert.equal(browserBatchSteps, 2);
assert.ok(browserBatchNodes.filter((node) => node === "observe-browser").length >= 2);

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
