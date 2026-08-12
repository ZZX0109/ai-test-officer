import assert from "node:assert/strict";
import { MemorySaver } from "@langchain/langgraph";
import {
  createAgentOrchestrationGraph,
  type AgentGraphHooks,
  type AgentGraphState
} from "@ai-test-officer/agent-orchestration";
import type {
  AgentGraphProjection,
  AgentInterrupt,
  AgentPermissionProfile,
  RepairDecisionAnswer
} from "@ai-test-officer/contracts";

/**
 * Human-in-the-loop E2E.
 *
 * These tests drive the *real* LangGraph runtime (not a stub) so a regression
 * that silently drops the interrupt — the exact P0 defect this suite was
 * written for — fails loudly. The graph must genuinely pause at `repair`,
 * survive a checkpoint round-trip, and only continue once the caller resumes
 * the same `thread_id` with `Command({ resume })`.
 */

const permissionProfile: AgentPermissionProfile = {
  observe: true,
  browserControl: true,
  sourceRead: true,
  sandboxWrite: false,
  sandboxCommand: false,
  networkInstall: false,
  hostApply: false,
  artifactExport: false,
  systemControl: false,
  workspaceControl: false,
  ideTerminalControl: false
};

type RepairOwner = "agent" | "user" | "environment" | "developer";

interface HarnessOptions {
  owner: RepairOwner;
  failureClass: string;
  /** Options offered to the human, mirrors what the workbench renders. */
  options: { value: string; label: string }[];
}

interface Harness {
  hooks: AgentGraphHooks;
  /** Every projection the graph emitted, in order. */
  projections: AgentGraphProjection[];
  /** Decisions actually applied by the repair hook (proves resume ran). */
  applied: RepairDecisionAnswer[];
  /** How many times the assessment pass ran (replays are expected). */
  assessments: number;
  /** Interrupt ids produced by each assessment pass — must stay stable. */
  interruptIds: string[];
  /** True once finalize executed — must never happen while pending. */
  finalized: boolean;
}

/**
 * Builds hooks that walk the graph straight to `repair` with a failure owned
 * by `owner`, then raise the unified `repair-decision` interrupt.
 */
function buildHarness(options: HarnessOptions): Harness {
  const harness: Harness = {
    hooks: {},
    projections: [],
    applied: [],
    assessments: 0,
    interruptIds: [],
    finalized: false
  };

  const pass = async () => ({});

  harness.hooks = {
    intake: pass,
    discover: async () => ({ coverageMap: { discovery: { status: "completed" }, items: [{ surface: "page" }] } }),
    buildCoverageMap: pass,
    plan: pass,
    compile: pass,
    prepareSandbox: pass,
    execute: pass,
    collectAndGate: async () => ({ gate: { verdict: "fail" } }),
    triageFailure: async () => ({
      failure: {
        failureClass: options.failureClass,
        reasons: [`${options.failureClass} detected`],
        repairable: true,
        owner: options.owner
      }
    }),
    repair: async (state: AgentGraphState, resume?: RepairDecisionAnswer) => {
      // Resume pass: apply the human's answer.
      if (resume) {
        harness.applied.push(resume);
        return resume.decision === "repair" || resume.decision === "create-session"
          ? { repairSessionId: `repair_${state.runId}` }
          : {};
      }
      // Assessment pass: raise a real interrupt.
      harness.assessments += 1;
      const pending: AgentInterrupt = {
        id: `interrupt_${state.runId}`,
        runId: state.runId,
        kind: "repair-decision",
        status: "pending",
        title: `需要你决定：${options.failureClass}`,
        detail: `系统已定位失败归属为 ${options.owner}，请选择后续处理方式。`,
        requestedCapabilities: [],
        payload: {},
        owner: options.owner,
        context: { failureClass: options.failureClass, runId: state.runId },
        options: options.options,
        diagnoses: [`${options.failureClass} detected`],
        evidenceRefs: [`evidence_${state.runId}_1`],
        attemptId: `attempt_${state.runId}`,
        createdAt: new Date().toISOString()
      };
      harness.interruptIds.push(pending.id);
      return { repairInterrupt: pending };
    },
    finalize: async () => {
      harness.finalized = true;
      return { status: "completed" as const };
    },
    onProjection: async (projection) => {
      harness.projections.push(projection);
    }
  };

  return harness;
}

function makeGraph(harness: Harness, checkpointer: MemorySaver) {
  return createAgentOrchestrationGraph({ checkpointer, hooks: harness.hooks });
}

/**
 * Drives a fresh run all the way to the repair interrupt.
 *
 * In active mode `execute` also suspends (waiting for the worker result), so
 * the harness resumes that hop with a synthetic failed execution before the
 * graph can reach triage and then repair.
 */
async function startToInterrupt(
  runner: ReturnType<typeof createAgentOrchestrationGraph>,
  runId: string,
  permissions?: Partial<AgentPermissionProfile>
) {
  await runner.start({
    runId,
    mode: "active",
    requirement: "human-in-the-loop e2e",
    projectId: "hil-project",
    permissionProfile: { ...permissionProfile, ...permissions },
    // Skip the two approval gates: this suite targets the repair interrupt.
    planApproved: true,
    capabilitiesApproved: true
  });

  let state = await runner.state(runId);
  // Bounded so a regression that never advances fails instead of hanging.
  for (let hop = 0; hop < 4 && state?.pendingInterrupt?.kind === "execution-result"; hop += 1) {
    await runner.resume(runId, { execution: { verdict: "fail", attemptId: `attempt_${runId}` } });
    state = await runner.state(runId);
  }
  return state;
}

/** 1. 产品断言失败 → LLM 解释 → 用户选择修复。 */
async function testProductBugUserChoosesRepair() {
  const harness = buildHarness({
    owner: "user",
    failureClass: "product-bug",
    options: [
      { value: "repair", label: "创建修复会话" },
      { value: "dismiss", label: "保留失败结论" }
    ]
  });
  const checkpointer = new MemorySaver();
  const runner = makeGraph(harness, checkpointer);
  const runId = "hil_product_bug";

  const paused = await startToInterrupt(runner, runId);
  assert.equal(paused?.status, "interrupted", "graph must actually pause at repair");
  assert.ok(paused?.pendingInterrupt, "pendingInterrupt must be checkpointed");
  assert.equal(paused?.pendingInterrupt?.kind, "repair-decision");
  assert.equal(paused?.interruptOwner, "user", "owner must reach the projection");
  assert.equal(harness.finalized, false, "finalize must not run while a decision is pending");

  // The interrupt must carry everything the workbench needs to render a choice.
  const pending = paused!.pendingInterrupt!;
  assert.ok(pending.diagnoses?.length, "diagnosis must be attached");
  assert.ok(pending.options?.length, "actionable options must be attached");
  assert.ok(pending.evidenceRefs?.length, "evidence refs must be attached");
  assert.equal(pending.attemptId, `attempt_${runId}`, "interrupt must bind the attempt");

  const resumed = await runner.resume(runId, { decision: "repair" });
  assert.ok(resumed, "resume must return a state");
  assert.equal(harness.applied.length, 1, "the decision must be applied exactly once");
  assert.equal(harness.applied[0]?.decision, "repair");
  // LangGraph replays a resumed node from the top, so the assessment pass runs
  // again before `interrupt()` hands back the answer. That is by design and the
  // reason the assessment must stay idempotent (the real hook keys it through
  // `executeAgentNodeIdempotently`). What must never double-run is the *apply*
  // pass, asserted above.
  assert.equal(harness.assessments, 2, "assessment replays once on resume (LangGraph semantics)");
  assert.equal(harness.interruptIds.length, 2, "the replay must rebuild the interrupt payload");
  assert.equal(
    harness.interruptIds[0],
    harness.interruptIds[1],
    "the interrupt id must be stable across replay so the resume route can match it"
  );

  const final = await runner.state(runId);
  assert.equal(final?.status, "completed", "graph must continue past repair after resume");
  assert.equal(final?.pendingInterrupt, undefined, "pending interrupt must be cleared");
  assert.equal(harness.finalized, true, "finalize must run after the decision is applied");
}

/** 2. 缺少登录凭据 → 用户配置账号 → 同一 Graph 恢复。 */
async function testMissingCredentialResumesSameGraph() {
  const harness = buildHarness({
    owner: "user",
    failureClass: "missing-credential",
    options: [
      { value: "configure-credential", label: "配置账号" },
      { value: "dismiss", label: "跳过" }
    ]
  });
  const runner = makeGraph(harness, new MemorySaver());
  const runId = "hil_missing_credential";

  const paused = await startToInterrupt(runner, runId);
  assert.equal(paused?.status, "interrupted");
  assert.equal(paused?.interruptContext?.failureClass, "missing-credential");

  await runner.resume(runId, { decision: "configure-credential", message: "已配置测试账号" });
  assert.equal(harness.applied[0]?.decision, "configure-credential");
  assert.equal(harness.applied[0]?.message, "已配置测试账号", "user supplied context must reach the hook");

  const final = await runner.state(runId);
  assert.equal(final?.status, "completed", "the same graph thread must continue, not a new run");
}

/** 3. 环境失败 → 用户确认恢复沙盒。 */
async function testEnvironmentFailureUserConfirmsRecovery() {
  const harness = buildHarness({
    owner: "environment",
    failureClass: "environment",
    options: [
      { value: "recover-sandbox", label: "恢复沙盒并重试" },
      { value: "dismiss", label: "终止" }
    ]
  });
  const runner = makeGraph(harness, new MemorySaver());
  const runId = "hil_environment";

  const paused = await startToInterrupt(runner, runId);
  assert.equal(paused?.interruptOwner, "environment", "environment failures use the same interrupt structure");

  await runner.resume(runId, { decision: "recover-sandbox" });
  assert.equal(harness.applied[0]?.decision, "recover-sandbox");
  assert.equal((await runner.state(runId))?.status, "completed");
}

/** 4. 开发者确认代码修复 → 进入修复工作区。 */
async function testDeveloperConfirmsCodeRepair() {
  const harness = buildHarness({
    owner: "developer",
    failureClass: "product-bug",
    options: [
      { value: "create-session", label: "进入修复工作区" },
      { value: "dismiss", label: "仅记录" }
    ]
  });
  const runner = makeGraph(harness, new MemorySaver());
  const runId = "hil_developer";

  const paused = await startToInterrupt(runner, runId, { sandboxWrite: true });
  assert.equal(paused?.interruptOwner, "developer");

  await runner.resume(runId, { decision: "create-session" });
  const final = await runner.state(runId);
  assert.equal(harness.applied[0]?.decision, "create-session");
  assert.equal(final?.status, "completed");
}

/** 5. 即使是 agent-owned 的 selector/harness 问题，也必须由用户授权沙盒写入。 */
async function testAgentOwnedRepairStillRequiresConsent() {
  const harness = buildHarness({
    owner: "agent",
    failureClass: "test-script",
    options: [
      { value: "repair", label: "在沙盒中生成补丁" },
      { value: "dismiss", label: "仅保留失败结论" }
    ]
  });
  const runner = makeGraph(harness, new MemorySaver());
  const runId = "hil_agent_owned";

  const paused = await startToInterrupt(runner, runId, { sandboxWrite: true });
  assert.equal(paused?.status, "interrupted", "agent-owned repair must not write a sandbox automatically");
  assert.equal(paused?.interruptOwner, "agent");
  assert.equal(harness.applied.length, 0, "no patch decision may be applied before user consent");

  await runner.resume(runId, { decision: "repair" });
  assert.equal(harness.applied[0]?.decision, "repair");
  assert.equal((await runner.state(runId))?.status, "completed");
}

/** 6. 用户拒绝修复 → 保留失败结论。 */
async function testUserRejectionKeepsFailure() {
  const harness = buildHarness({
    owner: "user",
    failureClass: "product-bug",
    options: [
      { value: "repair", label: "修复" },
      { value: "dismiss", label: "保留失败结论" }
    ]
  });
  const runner = makeGraph(harness, new MemorySaver());
  const runId = "hil_rejected";

  await startToInterrupt(runner, runId);
  await runner.resume(runId, { decision: "dismiss", message: "确认为已知问题" });

  const final = await runner.state(runId);
  assert.equal(harness.applied[0]?.decision, "dismiss");
  assert.equal(final?.status, "completed", "a rejection still finalizes the run");
  // A rejection must not fabricate a repair session — the failure stands.
  const finalProjection = harness.projections.at(-1);
  assert.ok(finalProjection, "at least one projection must be emitted");
  assert.equal(harness.finalized, true, "the failing conclusion must be finalized, not discarded");
}

/**
 * 7. 服务重启后仍能恢复 pending interrupt。
 *
 * Simulated by discarding the graph object and rebuilding it against the same
 * checkpointer — exactly what a process restart does with PostgresSaver.
 */
async function testPendingInterruptSurvivesRestart() {
  const checkpointer = new MemorySaver();
  const runId = "hil_restart";

  const before = buildHarness({
    owner: "user",
    failureClass: "product-bug",
    options: [{ value: "repair", label: "修复" }, { value: "dismiss", label: "忽略" }]
  });
  const firstRunner = makeGraph(before, checkpointer);
  const paused = await startToInterrupt(firstRunner, runId);
  assert.equal(paused?.status, "interrupted");
  assert.equal(before.finalized, false);

  // ---- process restart: new graph instance, same checkpoint store ----
  const after = buildHarness({
    owner: "user",
    failureClass: "product-bug",
    options: [{ value: "repair", label: "修复" }, { value: "dismiss", label: "忽略" }]
  });
  const secondRunner = makeGraph(after, checkpointer);

  const recovered = await secondRunner.state(runId);
  assert.equal(recovered?.status, "interrupted", "a restarted process must still see the pending interrupt");
  assert.equal(recovered?.pendingInterrupt?.id, `interrupt_${runId}`, "the same interrupt must be recovered");

  await secondRunner.resume(runId, { decision: "repair" });
  assert.equal(after.applied.length, 1, "the restarted process must apply the decision exactly once");
  assert.equal(after.applied[0]?.decision, "repair", "the restarted process must be able to resume");
  // The restarted process replays the node body once (LangGraph semantics) and
  // must rebuild an identical interrupt so the resume matches the id the user
  // was shown before the restart.
  assert.equal(after.assessments, 1, "restart-resume replays the assessment exactly once");
  assert.equal(
    after.interruptIds[0],
    `interrupt_${runId}`,
    "the rebuilt interrupt must match the one persisted before the restart"
  );
  assert.equal(before.applied.length, 0, "the pre-restart instance must not have applied anything");
  assert.equal((await secondRunner.state(runId))?.status, "completed");
}

export async function testHumanInLoopInterrupt() {
  await testProductBugUserChoosesRepair();
  await testMissingCredentialResumesSameGraph();
  await testEnvironmentFailureUserConfirmsRecovery();
  await testDeveloperConfirmsCodeRepair();
  await testAgentOwnedRepairStillRequiresConsent();
  await testUserRejectionKeepsFailure();
  await testPendingInterruptSurvivesRestart();
  console.log("HUMAN_IN_LOOP_INTERRUPT_OK");
}
