import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { ArtifactIntegrityReport, EvidenceItem, RunBundle, RunRequest, RunStepEvidence, VisualRunResult } from "./types.js";
import { compiledPlanSchema, resolveFinalStatus, runOutcomeSummaryV2Schema, type ActionDsl, type ArtifactV2, type CompiledPlan, type JudgeRecommendation } from "@ai-test-officer/contracts";
import {
  AttemptClock,
  PlaywrightAttemptTrace,
  bindAttemptTelemetry,
  captureScreenshotAtomic,
  commitCapturedFile,
  createPlaywrightRuntimeSession
} from "@ai-test-officer/playwright-runtime";
import { appendAudit } from "./auditLog.js";
import { requireBrowserControl } from "./permissionGate.js";
import {
  appendEvidence as appendEvidenceToStore,
  finalizeEvidenceArtifactLinks,
  readEvidence,
  writeRunBundle
} from "./evidenceStore.js";
import { appendLoopEvent, readLoopEvents } from "./loopEventStore.js";
import { buildScenarioOracles } from "./oracleBuilder.js";
import { buildRiskCoverageMatrix } from "./riskCoverage.js";
import { buildEvidenceQualityReport } from "./evidenceQuality.js";
import { appendRunHistory } from "./runHistory.js";
import { buildConflictPacket } from "./conflictReplay.js";
import { getScenario, type ScenarioAction, type ScenarioOracle } from "./scenarios.js";
import { buildLayeredJudgeReport } from "./judgeEngine.js";
import { routeJudge } from "./llmRoutingPolicy.js";
import { assertCompiledPlanSemanticContract } from "./compiledPlanContract.js";
import { buildLlmJudgeReport } from "./llmJudge.js";
import { writeReadableReports } from "./reportRenderer.js";
import { getProject, getProjectRuntimeStatus, resolveProjectTarget, startProject, stopProject, testProjectConnection } from "./projectAdapter.js";
import { buildFailureAttributions } from "./failureAttribution.js";
import { decideRepair } from "./repairDecision.js";
import { persistRepairPlan, selectRepairableAttribution } from "./repairPlan.js";
import { artifactKindToIntegrityKind, writeArtifactIntegrityReport } from "./artifactIntegrity.js";
import { assertExecutablePlan } from "./executablePlan.js";
import { withProjectRunLock } from "./runLock.js";
import { assessArtifactGate, enforceMachineGate } from "./evidencePolicy.js";
import { BudgetTracker } from "@ai-test-officer/execution-worker";
import { classifyRetry } from "./retryPolicy.js";
import { mirrorArtifactsToConfiguredStore } from "./artifactObjectStore.js";
import { getProjectLoginSecret } from "./projectLoginStore.js";
import { buildProofGraph, writeProofArtifacts } from "./proofGraph.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "./proof/proofBundleService.js";
import { linkCommittedAttemptArtifacts } from "./proof/evidenceArtifactLinker.js";
import {
  executeStructuredAction,
  type StructuredAction,
  type StructuredActionResult
} from "./structuredActionExecutors.js";
import {
  classifyExecutionError,
  envFlag,
  navigateToUsablePage,
  redactPageObservationText,
  redactPageObservationUrl,
  reloadUsablePage,
  resolveBrowserHeadlessMode
} from "./executionRuntime.js";
export { resolveBrowserHeadlessMode } from "./executionRuntime.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

function scenarioFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

async function ensureReportDirs(runId: string) {
  await mkdir(path.join(reportsDir, "screenshots", runId), { recursive: true });
  await mkdir(path.join(reportsDir, "runs", runId), { recursive: true });
  await mkdir(path.join(reportsDir, "videos"), { recursive: true });
  await mkdir(path.join(reportsDir, "traces"), { recursive: true });
}

function artifactUrl(filePath: string) {
  const relative = path.relative(reportsDir, filePath).split(path.sep).join("/");
  return `/artifacts/${relative}`;
}

export function shouldAutoStopProjectRuntime(input: {
  projectWasStartedByRunner: boolean;
  keepProjectRunning?: boolean;
  runtimeStatus?: { status: string };
}) {
  return Boolean(
    input.projectWasStartedByRunner &&
    !input.keepProjectRunning &&
    input.runtimeStatus?.status === "running"
  );
}

export function assertRunRequestExecutablePlan(input: Pick<RunRequest, "scenarioId" | "executablePlan">) {
  if (!input.executablePlan) return;
  assertExecutablePlan(input.executablePlan);
  if (!input.scenarioId) {
    throw new Error("Run request with executablePlan must declare scenarioId.");
  }
  const matchingStep = input.executablePlan.steps.find((step) => step.scenarioId === input.scenarioId);
  if (!matchingStep) {
    throw new Error(`Run request scenarioId ${input.scenarioId} is not present in executablePlan ${input.executablePlan.id}.`);
  }
}

function scenarioSelectorRefs(scenario: ReturnType<typeof getScenario>) {
  return new Set([
    ...Object.keys(scenario.corePath).filter((key) => /ButtonName|Label|Locator/.test(key)),
    ...(scenario.regressionPath?.triggerButtonName ? ["regressionTriggerButtonName"] : [])
  ]);
}

function scenarioValueRefs(scenario: ReturnType<typeof getScenario>) {
  const refs = new Set(Object.keys(scenario.corePath).filter((key) =>
    /^(input|selectValue)$/.test(key) && typeof scenario.corePath[key as keyof typeof scenario.corePath] === "string"
  ));
  if (["login_as_test_user", "login_invalid_user"].includes(scenario.corePath.action)) {
    refs.add("projectLoginUsername");
    refs.add("projectLoginPassword");
  }
  return refs;
}

/** Runtime validation is intentional: persisted plans and internal callers must not bypass the compiler boundary. */
export function assertCompiledPlanBinding(compiledPlan: CompiledPlan, scenario: ReturnType<typeof getScenario>) {
  const parsed = compiledPlanSchema.parse(compiledPlan);
  if (parsed.scenarioId !== scenario.id) throw new Error(`compiled_plan_scenario_mismatch:${parsed.scenarioId}:${scenario.id}`);
  const selectors = scenarioSelectorRefs(scenario);
  const values = scenarioValueRefs(scenario);
  const oracleIds = new Set(scenario.corePath.oracles.map((oracle) => oracle.id));
  const allowedPathIds = new Set([scenario.smoke.pathId, scenario.corePath.pathId, ...(scenario.regressionPath ? [scenario.regressionPath.stepId] : [])]);
  const fixtureRefs = new Set(scenario.corePath.action === "file_upload_validate" ? ["scenarioFixture"] : []);
  const capturableKinds = new Set(["screenshot", "dom", "network", "console", "trace", "video", "operation-log"]);
  for (const kind of parsed.requiredEvidenceKinds) {
    if (!capturableKinds.has(kind)) throw new Error(`compiled_plan_unsupported_evidence_kind:${kind}`);
  }
  const containsBrowserAction = parsed.steps.some((step) =>
    ["navigate", "click", "fill", "select", "upload", "assert", "wait"].includes(step.action.action)
  );
  if (containsBrowserAction && parsed.steps[0]?.action.action !== "navigate") {
    throw new Error("compiled_plan_browser_path_must_start_with_navigate");
  }
  const asserted = new Set<string>();
  for (const step of parsed.steps) {
    if (step.pathId && !allowedPathIds.has(step.pathId)) throw new Error(`compiled_plan_unknown_path:${step.pathId}`);
    const action = step.action;
    if ("selectorRef" in action && !selectors.has(action.selectorRef)) throw new Error(`compiled_plan_unknown_selector:${action.selectorRef}`);
    if (action.action === "click" && !(action.selectorRef.endsWith("ButtonName") || action.selectorRef === "regressionTriggerButtonName")) throw new Error(`compiled_plan_click_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "fill"
      && !["inputLabel", "usernameLabel", "passwordLabel", "usernameLocator", "passwordLocator"].includes(action.selectorRef)) {
      throw new Error(`compiled_plan_fill_selector_not_actionable:${action.selectorRef}`);
    }
    if (action.action === "select" && action.selectorRef !== "selectLabel") throw new Error(`compiled_plan_select_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "upload" && !action.selectorRef.endsWith("Label")) throw new Error(`compiled_plan_upload_selector_not_actionable:${action.selectorRef}`);
    if (action.action === "fill" && !values.has(action.valueRef)) throw new Error(`compiled_plan_unknown_value:${action.valueRef}`);
    if (action.action === "select" && (action.valueRef !== "selectValue" || !values.has(action.valueRef))) throw new Error(`compiled_plan_unknown_select_value:${action.valueRef}`);
    if (action.action === "upload" && !fixtureRefs.has(action.fixtureRef)) throw new Error(`compiled_plan_unknown_fixture:${action.fixtureRef}`);
    if (action.action === "assert") {
      if (!oracleIds.has(action.oracleId)) throw new Error(`compiled_plan_unknown_oracle:${action.oracleId}`);
      if (step.pathId && step.pathId !== scenario.corePath.pathId) throw new Error(`compiled_plan_assert_outside_core_path:${step.pathId}`);
      asserted.add(action.oracleId);
    }
    if (action.action === "click" && action.selectorRef === "regressionTriggerButtonName" && step.pathId !== scenario.regressionPath?.stepId) throw new Error(`compiled_plan_regression_selector_wrong_path:${step.pathId ?? "missing"}`);
  }
  const clickKeys = parsed.steps.filter((step) => step.action.action === "click").map((step) => `${step.pathId ?? scenario.corePath.pathId}:${step.action.action === "click" ? step.action.selectorRef : ""}`);
  if (new Set(clickKeys).size !== clickKeys.length) throw new Error("compiled_plan_duplicate_click");
  for (const required of parsed.requiredOracleIds) {
    if (!oracleIds.has(required)) throw new Error(`compiled_plan_unknown_required_oracle:${required}`);
    if (!asserted.has(required)) throw new Error(`compiled_plan_oracle_not_executed:${required}`);
  }
  return assertCompiledPlanSemanticContract(parsed, scenario);
}

function resolveApprovedLocator(page: Page, scenario: ReturnType<typeof getScenario>, selectorRef: string): Locator {
  if (!scenarioSelectorRefs(scenario).has(selectorRef)) throw new Error(`compiled_plan_unknown_selector:${selectorRef}`);
  const selector = selectorRef === "regressionTriggerButtonName"
    ? scenario.regressionPath?.triggerButtonName
    : scenario.corePath[selectorRef as keyof typeof scenario.corePath];
  if (typeof selector !== "string" || !selector) throw new Error(`compiled_plan_empty_selector:${selectorRef}`);
  if (selectorRef.endsWith("ButtonName")) return page.getByRole("button", { name: selector, exact: true });
  if (selectorRef.endsWith("Label")) return page.getByLabel(selector);
  if (selectorRef.endsWith("Locator")) return page.locator(selector);
  throw new Error(`compiled_plan_unsupported_selector:${selectorRef}`);
}

export interface CompiledActionExecutionContext {
  page: Page;
  scenario: ReturnType<typeof getScenario>;
  targetFrontendUrl: string;
  evaluateOracle: (oracle: ScenarioOracle, stepId: string) => Promise<unknown>;
  resolveFixture: (fixtureRef: string) => Promise<string>;
  resolveValue?: (valueRef: string) => Promise<string>;
  executeStructured?: (action: StructuredAction, stepId: string) => Promise<StructuredActionResult>;
  onNavigation?: (event: { status: "started" | "succeeded" | "failed"; url: string; httpStatus?: number; error?: string }) => void;
}

/** Execute one already-bound DSL action without accepting raw selectors, URLs, values, or commands. */
export async function executeCompiledAction(action: ActionDsl, stepId: string, context: CompiledActionExecutionContext) {
  const { page, scenario } = context;
  if (action.action === "navigate") {
    const base = new URL(context.targetFrontendUrl);
    const destination = new URL(action.path, base);
    if (destination.origin !== base.origin) throw new Error("compiled_plan_cross_origin_navigation");
    if (!destination.search && base.search) destination.search = base.search;
    await navigateToUsablePage(page, destination.toString(), context.onNavigation);
    return;
  }
  if (action.action === "click") {
    await resolveApprovedLocator(page, scenario, action.selectorRef).click();
    return;
  }
  if (action.action === "fill") {
    if (!scenarioValueRefs(scenario).has(action.valueRef)) throw new Error(`compiled_plan_unknown_value:${action.valueRef}`);
    const value = action.valueRef.startsWith("projectLogin")
      ? await context.resolveValue?.(action.valueRef)
      : scenario.corePath[action.valueRef as keyof typeof scenario.corePath];
    if (typeof value !== "string") throw new Error(`compiled_plan_empty_value:${action.valueRef}`);
    await resolveApprovedLocator(page, scenario, action.selectorRef).fill(value);
    return;
  }
  if (action.action === "select") {
    if (action.selectorRef !== "selectLabel" || action.valueRef !== "selectValue") throw new Error("compiled_plan_select_binding_invalid");
    const value = scenario.corePath[action.valueRef as keyof typeof scenario.corePath];
    if (typeof value !== "string") throw new Error(`compiled_plan_empty_value:${action.valueRef}`);
    await resolveApprovedLocator(page, scenario, action.selectorRef).selectOption(value);
    return;
  }
  if (action.action === "upload") {
    await resolveApprovedLocator(page, scenario, action.selectorRef).setInputFiles(await context.resolveFixture(action.fixtureRef));
    return;
  }
  if (action.action === "assert") {
    const oracle = scenario.corePath.oracles.find((item) => item.id === action.oracleId);
    if (!oracle) throw new Error(`compiled_plan_unknown_oracle:${action.oracleId}`);
    await context.evaluateOracle(oracle, stepId);
    return;
  }
  if (action.action === "wait") {
    await page.waitForTimeout(action.durationMs);
    return;
  }
  if (!context.executeStructured) throw new Error(`compiled_plan_structured_action_executor_missing:${action.action}`);
  return context.executeStructured(action, stepId);
}

/** Bind an opaque benchmark fixture to either a managed local target or a container target. */
export function targetFrontendUrl(frontendUrl: string, fixtureVariantId?: string) {
  const url = new URL(frontendUrl);
  if (fixtureVariantId) url.searchParams.set("fixtureVariantId", fixtureVariantId);
  return url.toString();
}

/**
 * Discovery drafts can outlive an OCI runtime allocation.  Their human
 * readable smoke text may therefore contain the previous host port even
 * though the actual target was re-resolved safely before Playwright starts.
 * Keep the assertion text aligned with the runtime URL without changing the
 * scenario contract or treating a stale port as a browser failure.
 */
function runtimeSmokeExpectation(expected: string, frontendUrl: string) {
  const runtimeUrl = frontendUrl.replace(/\/$/, "");
  return expected.replace(/https?:\/\/[^\s]+/g, runtimeUrl);
}

export async function runVisualGrayTest(input: RunRequest): Promise<VisualRunResult> {
  const lockProjectId = input.projectId ?? input.target?.projectId;
  if (!lockProjectId) return runVisualGrayTestUnlocked(input);
  return withProjectRunLock(lockProjectId, () => runVisualGrayTestUnlocked(input));
}

async function runVisualGrayTestUnlocked(input: RunRequest): Promise<VisualRunResult> {
  await requireBrowserControl(input);
  assertRunRequestExecutablePlan(input);
  const scenario = getScenario(input.scenarioId);
  const compiledPlan = input.compiledPlan ? assertCompiledPlanBinding(input.compiledPlan, scenario) : undefined;
  // Benchmark fixtures run in a dedicated service group with an ephemeral
  // port.  Do not let a saved project runtime (for example :6183) overwrite
  // the runner-provided target. Interactive runs retain managed OCI runtime
  // resolution, where an appUrl may indeed be stale after a container restart.
  const useBenchmarkTarget = input.executionProfile === "benchmark" && Boolean(input.appUrl);
  let targetRuntime = await resolveProjectTarget({ ...input, preferAppUrl: useBenchmarkTarget });
  let frontendUrl = targetFrontendUrl(targetRuntime.frontendUrl, input.fixtureVariantId);
  const id = input.runId ?? `run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const attemptClock = new AttemptClock();
  const artifactsV2: ArtifactV2[] = [];
  let activeAttempt = 1;
  const initialAttemptId = input.attemptId ?? `${id}_attempt_1`;
  const attempts: NonNullable<VisualRunResult["attempts"]> = [{
    id: initialAttemptId,
    runId: id,
    scenarioId: scenario.id,
    attempt: 1,
    startedAt,
    status: "running",
    artifactIds: []
  }];
  const attemptIdentity = () => ({
    runId: id,
    scenarioId: scenario.id,
    attemptId: activeAttempt === 1 ? initialAttemptId : `${id}_attempt_${activeAttempt}`,
    attempt: activeAttempt
  });
  const appendEvidence = (runId: string, evidence: Omit<EvidenceItem, "id" | "runId" | "timestamp">) => {
    const stamp = attemptClock.next();
    return appendEvidenceToStore(runId, {
      scenarioId: scenario.id,
      attemptId: attemptIdentity().attemptId,
      attempt: activeAttempt,
      sequence: stamp.sequence,
      ...evidence
    });
  };
  await ensureReportDirs(id);

  const steps: RunStepEvidence[] = [];
  const network: VisualRunResult["network"] = [];
  const consoleEvents: VisualRunResult["console"] = [];
  const assertions: VisualRunResult["assertions"] = [];
  const screenshotDir = path.join(reportsDir, "screenshots", id);
  const runDir = path.join(reportsDir, "runs", id);
  const evidenceWrites: Promise<unknown>[] = [];
  const browserLifecycleEvents: Array<Record<string, unknown>> = [];
  // Product runs are rendered inside the Workbench live view. Launching an
  // extra OS browser window steals focus from the user and is not part of the
  // sandbox boundary. Keep execution headless unless a developer explicitly
  // opts into a visible debugging browser with HEADLESS=0.
  const headless = resolveBrowserHeadlessMode();
  const recordVideo = envFlag("RECORD_VIDEO") || compiledPlan?.requiredEvidenceKinds.includes("video") === true;
  // Evidence degradation is selected by an opaque evaluator-owned variant. The
  // semantic failure class is intentionally absent from the Agent-visible input.
  // A browser attempt without a Trace cannot explain navigation, timing,
  // popup or network failures after the fact. Product runs therefore always
  // capture one complete attempt Trace. The two evaluator-owned variants
  // intentionally remove it so the evidence Gate can prove that degradation
  // is blocked rather than silently accepted.
  const recordTrace = input.fixtureVariantId !== "fxv_a6d2c904f7b138e5"
    && input.fixtureVariantId !== "fxv_c8b3e157d0a624f9";
  const configuredProject = input.projectId ? await getProject(input.projectId) : undefined;
  const projectLoginSecret = configuredProject?.login?.credentialId?.startsWith("login_")
    ? await getProjectLoginSecret(configuredProject.login.credentialId)
    : undefined;
  const budgetTracker = new BudgetTracker(configuredProject?.budget);
  let capturedScreenshotCount = 0;
  const runDeadline = Date.now() + (configuredProject?.budget?.runTimeoutMs ?? budgetTracker.budget.runTimeoutMs);
  const assertWithinRunBudget = () => {
    if (input.signal?.aborted) throw new Error("cancelled:run_abort_requested");
    if (Date.now() > runDeadline) throw new Error("budget_exceeded:run_timeout");
  };
  let projectWasStartedByRunner = false;
  let runtimeStatus: VisualRunResult["runtimeStatus"];
  const healthResult = configuredProject && !useBenchmarkTarget
    ? await testProjectConnection(configuredProject)
    : input.target
      ? await testProjectConnection({
        id: targetRuntime.projectId ?? "ad_hoc_target",
        name: targetRuntime.projectId ?? "Ad hoc target",
        projectPath: ".",
        frontendUrl: targetRuntime.frontendUrl,
        backendUrl: targetRuntime.backendUrl,
        healthCheckUrl: targetRuntime.healthCheckUrl,
        login: { method: "none" },
        createdAt: startedAt,
        updatedAt: startedAt
      })
      : undefined;
  if (configuredProject && !useBenchmarkTarget) {
    if (healthResult?.ok) {
      targetRuntime = await resolveProjectTarget({ projectId: configuredProject.id });
      runtimeStatus = {
        projectId: configuredProject.id,
        status: "running",
        frontendUrl: targetRuntime.frontendUrl,
        backendUrl: targetRuntime.backendUrl,
        healthCheckUrl: targetRuntime.healthCheckUrl,
        failureReason: "none",
        message: "Project is already healthy."
      };
    } else {
      const beforeStart = getProjectRuntimeStatus(configuredProject.id);
      runtimeStatus = await startProject(configuredProject.id);
      projectWasStartedByRunner = beforeStart.status === "idle" && runtimeStatus.status === "running";
    }
  } else if (healthResult) {
    runtimeStatus = {
      projectId: targetRuntime.projectId ?? "ad_hoc_target",
      status: healthResult.ok ? "running" : "failed",
      frontendUrl: targetRuntime.frontendUrl,
      backendUrl: targetRuntime.backendUrl,
      healthCheckUrl: targetRuntime.healthCheckUrl,
      failureReason: healthResult.reason,
      message: healthResult.message
    };
  }
  if (runtimeStatus?.status === "failed") {
    throw new Error(`runtime_unavailable:${runtimeStatus.failureReason ?? "unknown"}:${runtimeStatus.message ?? "Project runtime failed."}`);
  }
  if (configuredProject && !useBenchmarkTarget) {
    // Starting or recovering an OCI sandbox can allocate a new host port.
    // Resolve the target again only after the runtime is healthy so Playwright
    // never navigates to the persisted container URL.
    targetRuntime = await resolveProjectTarget({ projectId: configuredProject.id });
    frontendUrl = targetFrontendUrl(targetRuntime.frontendUrl, input.fixtureVariantId);
  }

  await appendLoopEvent(id, {
    loopType: "plan_loop",
    iteration: 1,
    status: "passed",
    title: `${scenario.title} plan 已载入`,
    action: "load_scenario_plan",
    observation: scenario.planObservation,
    decision: "进入权限确认",
    decisionReason: "执行浏览器操作前需要 browser_control",
    evidenceRefs: []
  });
  const permissionEvidence = await appendEvidence(id, {
    type: "permission",
    title: "浏览器控制权限快照",
    payload: {
      ...input.permissionProfile,
      headless,
      recordVideo,
      recordTrace,
      runtimeStatus,
      executionOrigin: {
        executor: "@ai-test-officer/playwright-runtime",
        host: hostname(),
        processId: process.pid,
        browserContext: "isolated-playwright-context",
        workbenchView: "passive-live-view-mirror",
        targetFrontendUrl: frontendUrl,
        targetBackendUrl: targetRuntime.backendUrl,
        targetHealthCheckUrl: targetRuntime.healthCheckUrl
      }
    }
  });
  await appendLoopEvent(id, {
    loopType: "approval_loop",
    iteration: 1,
    status: "passed",
    title: "browser_control 权限已确认",
    action: "permission_check",
    observation: input.permissionProfile.browserControl ? "用户允许接管指定浏览器窗口" : "用户未授权",
    decision: "执行显式灰度测试",
    decisionReason: "权限检查通过",
    evidenceRefs: [permissionEvidence.id],
    permissionRef: permissionEvidence.id
  });

  const browserSession = await createPlaywrightRuntimeSession({
    headless,
    signal: input.signal,
    onLifecycle: (event) => browserLifecycleEvents.push({ ...event, capturedAt: new Date().toISOString() }),
    contextOptions: {
      viewport: { width: 1280, height: 820 },
      ...(recordVideo ? { recordVideo: { dir: path.join(reportsDir, "videos") } } : {})
    }
  });
  const { context, page } = browserSession;
  const recordBrowserLifecycle = () => {
    for (const event of browserLifecycleEvents.splice(0)) {
      evidenceWrites.push(appendEvidence(id, {
        type: "operation",
        title: `Playwright ${String(event.type)} ${String(event.status)}`,
        payload: event
      }));
    }
  };
  recordBrowserLifecycle();
  let attemptTrace: PlaywrightAttemptTrace | undefined;
  const startAttemptTrace = async () => {
    if (!recordTrace) return;
    attemptTrace = new PlaywrightAttemptTrace(context);
    await attemptTrace.start();
  };
  const finishAttemptTrace = async () => {
    if (!attemptTrace) return;
    const finalPath = path.join(reportsDir, "traces", id, `attempt-${activeAttempt}.zip`);
    const temporaryPath = `${finalPath}.partial`;
    try {
      await attemptTrace.stop(temporaryPath);
      const artifact = await commitCapturedFile({
        temporaryPath,
        finalPath,
        id: `${id}_trace_attempt_${activeAttempt}`,
        identity: attemptIdentity(),
        stepId: `attempt-${activeAttempt}-finalize`,
        kind: "trace",
        mediaType: "application/zip",
        storageUri: artifactUrl(finalPath),
        clock: attemptClock,
        collectorVersion: "0.2.0"
      });
      const locatedArtifact: ArtifactV2 = {
        ...artifact,
        locator: {
          timeRange: {
            from: attempts[activeAttempt - 1]?.startedAt ?? startedAt,
            to: artifact.integrity.capturedAt
          }
        }
      };
      artifactsV2.push(locatedArtifact);
      budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
      attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
      await appendEvidence(id, {
        type: "trace",
        title: `Playwright trace attempt ${activeAttempt}`,
        file: artifact.storageUri,
        artifactIds: [artifact.id],
        payload: { file: artifact.storageUri, attempt: activeAttempt }
      });
    } finally {
      attemptTrace = undefined;
    }
  };
  await startAttemptTrace().catch(async (error) => {
    await browserSession.close();
    throw error;
  });
  page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_ACTION_TIMEOUT_MS ?? 30_000));
  const pageVideo = page.video();
  const unbindTelemetry = bindAttemptTelemetry({
    context,
    clock: attemptClock,
    onEvent: (event) => {
      evidenceWrites.push(appendEvidence(id, {
        type: "operation",
        title: `Browser ${event.type}`,
        payload: { ...event.payload, eventType: event.type, capturedAt: event.capturedAt, monotonicOffsetMs: event.monotonicOffsetMs }
      }));
    }
  });

  page.on("console", (event) => {
    const item = { type: event.type(), text: event.text() };
    consoleEvents.push(item);
    evidenceWrites.push(appendEvidence(id, {
      type: "console",
      title: `Console ${item.type}`,
      locator: {
        pageUrl: page.url(),
        lineStart: consoleEvents.length,
        lineEnd: consoleEvents.length
      },
      payload: item
    }));
  });
  page.on("response", (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    const persistable = ["document", "xhr", "fetch", "websocket", "eventsource"].includes(resourceType)
      || response.status() >= 400;
    // A large Vite application can load thousands of JS chunks. Persisting
    // every static asset as an individual evidence item rewrites the run
    // bundle repeatedly and makes a healthy run appear frozen. Runtime APIs,
    // documents and failures remain first-class evidence.
    if (!persistable) return;
    const item = {
      method: request.method(),
      url: response.url(),
      status: response.status()
    };
    if (network.length < 1_000) network.push(item);
    if (evidenceWrites.length < 500) {
      const requestId = `request_${createHash("sha256").update(`${item.method}:${item.url}:${request.timing().startTime}`).digest("hex").slice(0, 20)}`;
      evidenceWrites.push(appendEvidence(id, {
        type: "network",
        title: `Network ${item.method} ${item.status}`,
        url: item.url,
        locator: {
          requestId,
          method: item.method,
          pageUrl: page.url(),
          statusCode: item.status
        },
        payload: { ...item, resourceType }
      }));
    }
  });
  page.on("requestfailed", (request) => {
    const item = { method: request.method(), url: request.url() };
    if (network.length < 1_000) network.push(item);
    if (evidenceWrites.length < 500) {
      evidenceWrites.push(appendEvidence(id, {
        type: "network",
        title: `Network failed ${item.method}`,
        url: item.url,
        locator: {
          requestId: `request_${createHash("sha256").update(`${item.method}:${item.url}:failed`).digest("hex").slice(0, 20)}`,
          method: item.method,
          pageUrl: page.url()
        },
        payload: { ...item, resourceType: request.resourceType() }
      }));
    }
  });

  async function screenshot(stepId: string) {
    assertWithinRunBudget();
    budgetTracker.consume({ screenshots: 1 });
    capturedScreenshotCount += 1;
    const file = path.join(screenshotDir, `${stepId}.png`);
    const url = artifactUrl(file);
    let artifact: ArtifactV2;
    try {
      // A broken webfont or a page that keeps its font-loading promise open
      // must not turn a real browser action into a fake selector failure. A
      // screenshot is useful evidence, but it is supplementary; the DOM,
      // network and Trace collectors remain authoritative when capture times
      // out. The runtime also applies its own bounded timeout.
      artifact = await captureScreenshotAtomic({
        page,
        finalPath: file,
        id: `${id}_screenshot_${activeAttempt}_${stepId}`,
        identity: attemptIdentity(),
        stepId,
        storageUri: url,
        clock: attemptClock
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidenceWrites.push(appendEvidence(id, {
        type: "operation",
        title: `Screenshot ${stepId} unavailable`,
        stepId,
        payload: {
          code: "screenshot_capture_failed",
          failureClass: "insufficient_evidence",
          message: message.slice(0, 500)
        }
      }));
      return undefined;
    }
    const viewport = page.viewportSize();
    const locatedArtifact: ArtifactV2 = {
      ...artifact,
      locator: {
        pageUrl: page.url(),
        viewport: viewport ?? undefined
      }
    };
    artifactsV2.push(locatedArtifact);
    budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
    attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
    await appendEvidence(id, {
      type: "screenshot",
      title: `Screenshot ${stepId}`,
      stepId,
      file: url,
      artifactIds: [artifact.id],
      locator: {
        pageUrl: page.url(),
        viewport: viewport ?? undefined
      },
      payload: { file: url }
    });
    return url;
  }

  type StepPageSnapshot = {
    phase: "before" | "after" | "failure";
    url: string;
    title: string;
    readyState: string;
    bodyTextSample: string;
    bodyHash: string;
    interactiveElementCount: number;
    controls: Array<{
      kind: string;
      name?: string;
      testId?: string;
      visible: boolean;
      disabled: boolean;
    }>;
    alerts: string[];
    consoleErrors: string[];
    failedRequests: Array<{ method: string; url: string; status?: number }>;
    capturedAt: string;
    changes?: string[];
  };

  async function captureStepPageObservation(
    stepId: string,
    pathId: string,
    phase: StepPageSnapshot["phase"],
    telemetryStart: { network: number; console: number },
    before?: StepPageSnapshot
  ) {
    const raw = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll(
        "a,button,input,textarea,select,[role='button'],[data-testid]"
      )).slice(0, 40).map((element) => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const bounds = html.getBoundingClientRect();
        const disabled = element instanceof HTMLButtonElement
          || element instanceof HTMLInputElement
          || element instanceof HTMLTextAreaElement
          || element instanceof HTMLSelectElement
          ? element.disabled
          : element.getAttribute("aria-disabled") === "true";
        return {
          kind: element.tagName.toLowerCase(),
          name: element.getAttribute("aria-label")
            || element.getAttribute("placeholder")
            || element.textContent
            || undefined,
          testId: element.getAttribute("data-testid") || undefined,
          visible: style.display !== "none"
            && style.visibility !== "hidden"
            && bounds.width > 0
            && bounds.height > 0,
          disabled
        };
      });
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim(),
        interactiveElementCount: controls.filter((item) => item.visible).length,
        controls: controls.filter((item) => item.visible),
        alerts: Array.from(document.querySelectorAll(
          "[role='alert'],[role='status'],[aria-live],dialog[open]"
        )).map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean).slice(0, 12)
      };
    });
    const bodyTextSample = redactPageObservationText(raw.bodyText);
    const snapshot: StepPageSnapshot = {
      phase,
      url: redactPageObservationUrl(raw.url),
      title: redactPageObservationText(raw.title, 300),
      readyState: raw.readyState,
      bodyTextSample,
      bodyHash: createHash("sha256").update(bodyTextSample).digest("hex"),
      interactiveElementCount: raw.interactiveElementCount,
      controls: raw.controls.map((control) => ({
        ...control,
        name: control.name ? redactPageObservationText(control.name, 240) : undefined,
        testId: control.testId ? redactPageObservationText(control.testId, 160) : undefined
      })),
      alerts: raw.alerts.map((item) => redactPageObservationText(item, 400)),
      consoleErrors: consoleEvents
        .slice(telemetryStart.console)
        .filter((item) => /error|exception|failed/i.test(`${item.type} ${item.text}`))
        .slice(-12)
        .map((item) => redactPageObservationText(item.text, 500)),
      failedRequests: network
        .slice(telemetryStart.network)
        .filter((item) => item.status === undefined || item.status >= 400)
        .slice(-12)
        .map((item) => ({
          method: item.method,
          url: redactPageObservationUrl(item.url),
          status: item.status
        })),
      capturedAt: new Date().toISOString()
    };
    if (before) {
      snapshot.changes = [
        ...(before.url !== snapshot.url ? [`URL: ${before.url} → ${snapshot.url}`] : []),
        ...(before.title !== snapshot.title ? [`标题: ${before.title} → ${snapshot.title}`] : []),
        ...(before.bodyHash !== snapshot.bodyHash ? ["页面可见文本发生变化"] : []),
        ...(before.interactiveElementCount !== snapshot.interactiveElementCount
          ? [`可操作控件: ${before.interactiveElementCount} → ${snapshot.interactiveElementCount}`]
          : []),
        ...snapshot.alerts.filter((item) => !before.alerts.includes(item)).map((item) => `新增页面提示: ${item}`)
      ].slice(0, 20);
    }
    const finalPath = path.join(runDir, `${stepId}.${phase}.page-observation.json`);
    const temporaryPath = `${finalPath}.partial`;
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2));
    const artifact = await commitCapturedFile({
      temporaryPath,
      finalPath,
      id: `${id}_dom_${activeAttempt}_${stepId}_${phase}`,
      identity: attemptIdentity(),
      stepId,
      kind: "dom",
      mediaType: "application/json",
      storageUri: artifactUrl(finalPath),
      clock: attemptClock,
      collectorVersion: "0.3.0"
    });
    artifactsV2.push({
      ...artifact,
      locator: { pageUrl: snapshot.url, selector: "body" }
    });
    budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
    attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
    const evidence = await appendEvidence(id, {
      type: "dom",
      title: `${phase === "before" ? "操作前" : phase === "after" ? "操作后" : "失败时"}页面观测 ${stepId}`,
      pathId,
      stepId,
      file: artifact.storageUri,
      artifactIds: [artifact.id],
      locator: { pageUrl: snapshot.url, selector: "body", snapshotSha256: snapshot.bodyHash },
      payload: {
        phase,
        readyState: snapshot.readyState,
        interactiveElementCount: snapshot.interactiveElementCount,
        controls: snapshot.controls,
        alerts: snapshot.alerts,
        consoleErrors: snapshot.consoleErrors,
        failedRequests: snapshot.failedRequests,
        changes: snapshot.changes ?? []
      }
    });
    return { snapshot, evidence };
  }

  async function recordAssertion(assertion: VisualRunResult["assertions"][number], pathId: string, stepId?: string) {
    assertWithinRunBudget();
    const evidence = await appendEvidence(id, {
      type: "assertion",
      title: assertion.name,
      pathId,
      stepId,
      payload: { assertion }
    });
    if (assertion.fact) {
      assertion.fact.evidenceRefs = Array.from(new Set([...assertion.fact.evidenceRefs, evidence.id]));
    }
    assertions.push(assertion);
    return evidence;
  }

  async function recordDomEvidence(title: string, locator: string, pathId: string, stepId: string) {
    const texts = await page.locator(locator).allTextContents();
    const evidence = await appendEvidence(id, {
      type: "dom",
      title,
      pathId,
      stepId,
      locator: { pageUrl: page.url(), selector: locator },
      payload: { locator, texts }
    });
    return { texts, evidence };
  }

  async function isSmokeAnchorVisible() {
    const expected = scenario.smoke.headingName.trim();
    if (await page.getByRole("heading", { name: expected, exact: true }).isVisible().catch(() => false)) return true;
    const title = await page.title().catch(() => "");
    if (title.includes(expected)) return true;
    return page.locator("body").evaluate((body, value) =>
      (body as HTMLElement).innerText.includes(String(value)), expected
    ).catch(() => false);
  }

  async function evaluateOracle(oracle: ScenarioOracle, stepId: string, pathId = scenario.corePath.pathId) {
    if (oracle.type === "network_query") {
      const passed = network.some(
        (entry) =>
          entry.url.includes(oracle.networkUrlIncludes ?? "") &&
          entry.url.includes(oracle.expectedQueryFragment ?? "")
      );
      return recordAssertion({
        name: oracle.name,
        passed,
        expected: oracle.expected,
        actual: passed
          ? `请求包含 ${oracle.expectedQueryFragment}`
          : `请求缺少 ${oracle.expectedQueryFragment}`,
        fact: {
          kind: "network.url_contains",
          target: oracle.networkUrlIncludes ?? "",
          operator: "contains",
          expected: oracle.expectedQueryFragment ?? "",
          actual: network.map((entry) => entry.url).join("\n"),
          severity: "high",
          evidenceRefs: [],
          failureClass: passed ? undefined : "product_bug"
        }
      }, pathId, stepId);
    }
    if (oracle.type === "console_no_error") {
      const consoleErrors = consoleEvents.filter((entry) => /error|exception|failed/i.test(`${entry.type} ${entry.text}`));
      return recordAssertion({
        name: oracle.name,
        passed: consoleErrors.length === 0,
        expected: oracle.expected,
        actual: consoleErrors.length ? consoleErrors.map((entry) => entry.text).join("\n") : "未发现 console error",
        fact: {
          kind: "console.no_error",
          target: "browser_console",
          operator: "not_present",
          expected: "no console error",
          actual: consoleErrors.length ? consoleErrors.map((entry) => entry.text).join("\n") : "no console error",
          severity: "medium",
          evidenceRefs: [],
          failureClass: consoleErrors.length ? "product_bug" : undefined
        }
      }, pathId, stepId);
    }
    if (oracle.type === "api_schema" && !oracle.locator) {
      const expectedPath = oracle.networkUrlIncludes ?? "";
      const matched = network.filter((entry) => entry.url.includes(expectedPath));
      const successful = matched.find((entry) =>
        typeof entry.status === "number" && entry.status >= 200 && entry.status < 400
      );
      return recordAssertion({
        name: oracle.name,
        passed: Boolean(successful),
        expected: oracle.expected,
        actual: successful
          ? `${successful.method} ${successful.url} -> ${successful.status}`
          : matched.length
            ? matched.map((entry) => `${entry.method} ${entry.url} -> ${entry.status ?? "failed"}`).join("\n")
            : `未观察到 ${expectedPath} 的运行时请求`,
        fact: {
          kind: "network.url_contains",
          target: expectedPath,
          operator: "contains",
          expected: `${expectedPath} returns 2xx/3xx`,
          actual: matched.map((entry) => `${entry.url}:${entry.status ?? "failed"}`).join("\n"),
          severity: "high",
          evidenceRefs: [],
          failureClass: matched.length ? "product_bug" : "insufficient_evidence"
        }
      }, pathId, stepId);
    }
    if (oracle.type === "url_not_contains") {
      const excluded = oracle.excludedUrlIncludes ?? "";
      const actualUrl = page.url();
      const { evidence } = await recordDomEvidence(`${oracle.name} 页面状态`, "body", pathId, stepId);
      const passed = Boolean(excluded) && !actualUrl.includes(excluded);
      return recordAssertion({
        name: oracle.name,
        passed,
        expected: oracle.expected,
        actual: actualUrl,
        fact: {
          kind: "state.equals",
          target: "page.url",
          operator: "not_present",
          expected: excluded,
          actual: actualUrl,
          severity: "high",
          evidenceRefs: [evidence.id],
          failureClass: passed ? undefined : "product_bug"
        }
      }, pathId, stepId);
    }

    const locator =
      oracle.locator ??
      scenario.corePath.targetLocator ??
      scenario.corePath.statusLocator ??
      scenario.corePath.validationLocator ??
      scenario.corePath.emptyStateLocator ??
      scenario.corePath.errorLocator ??
      "[data-testid='task-list']";
    const { texts, evidence } = await recordDomEvidence(`${oracle.name} DOM`, locator, pathId, stepId);
    const text = texts.join(" ");
    const expectedText = oracle.expectedTextIncludes ?? oracle.expectedStatusText ?? scenario.corePath.expectedTextIncludes ?? "";
    const passed =
      oracle.type === "dom_all_text"
        ? texts.length > 0 && texts.every((item) => item.includes(oracle.expectedStatusText ?? expectedText))
        : text.includes(expectedText);
    const assertionEvidence = await recordAssertion({
      name: oracle.name,
      passed,
      expected: oracle.expected,
      actual: text || "没有读取到 DOM 文本",
      fact: {
        kind: oracle.type === "dom_all_text" ? "text.all_contains" : "text.contains",
        target: locator,
        operator: oracle.type === "dom_all_text" ? "all_contains" : "contains",
        expected: oracle.expectedTextIncludes ?? oracle.expectedStatusText ?? scenario.corePath.expectedTextIncludes ?? "",
        actual: text || "没有读取到 DOM 文本",
        severity: oracle.type === "error_text" ? "medium" : "high",
        evidenceRefs: [evidence.id],
        failureClass: passed ? undefined : texts.length === 0 ? "test_script_issue" : "product_bug"
      }
    }, pathId, stepId);
    return {
      ...assertionEvidence,
      evidenceRefs: [evidence.id, assertionEvidence.id]
    };
  }

  async function evaluateCompiledSmokePath(stepId: string) {
    const visible = await isSmokeAnchorVisible();
    return recordAssertion({
      name: scenario.smoke.assertionName,
      passed: visible,
      expected: runtimeSmokeExpectation(scenario.smoke.expected, frontendUrl),
      actual: visible ? "visible" : "hidden",
      fact: {
        kind: "element.visible",
        target: `heading:${scenario.smoke.headingName}`,
        operator: "exists",
        expected: scenario.smoke.headingName,
        actual: visible ? "visible" : "hidden",
        severity: "high",
        evidenceRefs: [],
        failureClass: visible ? undefined : "environment_issue"
      }
    }, scenario.smoke.pathId, stepId);
  }

  async function evaluateCompiledRegressionPath(stepId: string, pathId: string, telemetryStart: { network: number; console: number }) {
    const headingVisible = await isSmokeAnchorVisible();
    const consoleErrors = consoleEvents.slice(telemetryStart.console).filter((entry) => /error|exception|failed/i.test(`${entry.type} ${entry.text}`));
    const networkErrors = network.slice(telemetryStart.network).filter((entry) => typeof entry.status === "number" && entry.status >= 500);
    const passed = headingVisible && consoleErrors.length === 0 && networkErrors.length === 0;
    return recordAssertion({
      name: `${scenario.regressionPath?.title ?? "回归路径"}执行后页面保持可用`,
      passed,
      expected: "页面标题仍可见，且没有 console error 或 5xx 网络响应",
      actual: `heading=${headingVisible ? "visible" : "hidden"}; consoleErrors=${consoleErrors.length}; network5xx=${networkErrors.length}`,
      fact: {
        kind: "element.visible",
        target: `heading:${scenario.smoke.headingName}`,
        operator: "exists",
        expected: `${scenario.smoke.headingName}; no console error; no network 5xx`,
        actual: `heading=${headingVisible}; consoleErrors=${consoleErrors.length}; network5xx=${networkErrors.length}`,
        severity: "medium",
        evidenceRefs: [],
        failureClass: passed ? undefined : networkErrors.length || !headingVisible ? "environment_issue" : "product_bug"
      }
    }, pathId, stepId);
  }

  async function clickButton(name: string | undefined, options: { allowObservedAuthButton?: boolean } = {}) {
    if (!name) throw new Error(`Scenario ${scenario.id} 缺少按钮名称`);
    const exact = page.getByRole("button", { name, exact: true }).first();
    if (await exact.count().catch(() => 0)) {
      await exact.click();
      return;
    }
    // Uploaded projects frequently use a different locale or wording for
    // their login submit button. Only auth scenarios may use this fallback,
    // and only after the declared selector was proven absent. The observed
    // role/name still comes from the current page DOM; no arbitrary selector
    // or command is accepted.
    if (options.allowObservedAuthButton) {
      const observed = page.getByRole("button", { name: /^(login|sign[ -]?in|登录|登录测试账号)$/i }).first();
      if (await observed.count().catch(() => 0)) {
        await observed.click();
        return;
      }
    }
    await exact.click();
  }

  async function resolveObservedLoginField(
    declaredLocator: string | undefined,
    declaredLabel: string | undefined,
    kind: "username" | "password"
  ) {
    const declared = declaredLocator
      ? page.locator(declaredLocator).first()
      : declaredLabel
        ? page.getByLabel(declaredLabel, { exact: true }).first()
        : undefined;
    if (declared && await declared.count().catch(() => 0)) return declared;
    // Keep the fallback constrained to conventional login inputs. It is
    // useful for real projects whose labels/locales differ from a registry
    // template, while remaining auditable in the DOM and inaccessible to
    // arbitrary model-generated selectors.
    const candidates = kind === "password"
      ? page.locator("input[type='password'], input[autocomplete='current-password']")
      : page.locator("input[type='email'], input[name='username'], input[autocomplete='username'], input[type='text']");
    const fallback = candidates.first();
    if (await fallback.count().catch(() => 0)) return fallback;
    if (declared) return declared;
    throw new Error(`login_${kind}_field_not_found`);
  }

  async function runCoreAction(action: ScenarioAction) {
    assertWithinRunBudget();
    budgetTracker.consume({ steps: 1 });
    const core = scenario.corePath;
    if (action === "click_filter") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "change_task_status") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "login_as_test_user") {
      if ((core.usernameLocator || core.usernameLabel) && (core.passwordLocator || core.passwordLabel)) {
        if (!projectLoginSecret) throw new Error("credential_missing:project_login_credential");
        const username = await resolveObservedLoginField(core.usernameLocator, core.usernameLabel, "username");
        const password = await resolveObservedLoginField(core.passwordLocator, core.passwordLabel, "password");
        await username.fill(projectLoginSecret.username);
        await password.fill(projectLoginSecret.password);
        await clickButton(core.submitButtonName, { allowObservedAuthButton: true });
        return;
      }
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      await clickButton(core.submitButtonName, { allowObservedAuthButton: true });
      return;
    }
    if (action === "login_invalid_user") {
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "require_permission") {
      if (core.triggerButtonName) {
        const logout = page.getByRole("button", { name: core.triggerButtonName, exact: true });
        if (await logout.isVisible().catch(() => false)) {
          await logout.click();
        }
      }
      return;
    }
    if (action === "submit_empty_form") {
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "fill_and_submit") {
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "search_keyword" || action === "expect_empty_state") {
      if (!core.inputLabel) throw new Error(`Scenario ${scenario.id} 缺少输入框 label`);
      await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "edit_task_title") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "simulate_error_and_retry") {
      await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "visual_check") {
      if (core.triggerButtonName) await clickButton(core.triggerButtonName);
      return;
    }
    if (action === "table_sort_filter_paginate") {
      if (core.triggerButtonName) await clickButton(core.triggerButtonName);
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      if (core.retryButtonName) await clickButton(core.retryButtonName);
      return;
    }
    if (action === "complex_form_validate") {
      await clickButton(core.submitButtonName);
      return;
    }
    if (action === "file_upload_validate") {
      if (!core.inputLabel) throw new Error(`Scenario ${scenario.id} 缺少文件上传 label`);
      const uploadFile = path.join(runDir, "invoice-fixture.txt");
      await writeFile(uploadFile, "Invoice fixture for AI Test Officer upload validation.\n");
      await page.getByLabel(core.inputLabel).setInputFiles(uploadFile);
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      return;
    }
    if (action === "approval_flow_transition") {
      if (core.inputLabel) await page.getByLabel(core.inputLabel).fill(core.input ?? "");
      await clickButton(core.triggerButtonName ?? core.submitButtonName);
      return;
    }
    if (action === "openapi_schema_contract") {
      if (core.triggerButtonName || core.submitButtonName) {
        await clickButton(core.triggerButtonName ?? core.submitButtonName);
      } else {
        await page.waitForTimeout(Math.min(Math.max(core.waitMs ?? 250, 0), 2_000));
      }
      return;
    }
    if (action === "role_permission_matrix") {
      if (core.selectLabel && core.selectValue) await page.getByLabel(core.selectLabel).selectOption(core.selectValue);
      if (core.submitButtonName) await clickButton(core.submitButtonName);
      return;
    }
    if (action === "authenticated_onboarding_workflow") {
      const email = projectLoginSecret?.username
        || process.env[core.usernameEnv ?? "TEST_WORKFLOW_USERNAME"]?.trim()
        || `ai-test-officer-${Date.now()}@example.com`;
      const password = projectLoginSecret?.password
        || process.env[core.passwordEnv ?? "TEST_WORKFLOW_PASSWORD"]?.trim()
        || "InvestmentAgent123!";
      await page.getByRole("button", { name: core.registerButtonName ?? "注册", exact: true }).click();
      await page.getByLabel(core.usernameLabel ?? "邮箱").fill(email);
      await page.getByLabel(core.passwordLabel ?? "密码").fill(password);
      await page.getByRole("button", { name: core.createAccountButtonName ?? "创建账户", exact: true }).click();

      const setupHeading = page.getByRole("heading", { name: core.setupHeadingName ?? "完成前测和持仓录入", exact: true });
      const duplicateAccount = page.getByText(/Email already registered|already registered|已注册/i);
      await Promise.race([
        setupHeading.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined),
        duplicateAccount.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined)
      ]);
      if (await duplicateAccount.isVisible().catch(() => false)) {
        await page.getByRole("button", { name: core.loginButtonName ?? "登录", exact: true }).click();
        await page.getByLabel(core.usernameLabel ?? "邮箱").fill(email);
        await page.getByLabel(core.passwordLabel ?? "密码").fill(password);
        await page.getByRole("button", { name: core.loginSubmitButtonName ?? "进入系统", exact: true }).click();
      }

      await page.getByRole("heading", { name: core.setupHeadingName ?? "完成前测和持仓录入", exact: true }).waitFor({ state: "visible", timeout: 15_000 });
      await page.getByRole("button", { name: new RegExp(core.setupSubmitButtonPattern ?? "保存并生成投研面板") }).click();
      await page.getByRole("heading", { name: "组合风险与 Agent 投研闭环", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      const auditTab = page.getByRole("button", { name: /审稿复盘/ });
      if (await auditTab.isVisible().catch(() => false)) {
        await auditTab.click();
        const refreshButton = page.getByRole("button", { name: /刷新证据/ }).first();
        if (await refreshButton.isVisible().catch(() => false)) {
          await refreshButton.click().catch(() => undefined);
          await page.waitForTimeout(1200);
        }
      }
      return;
    }
  }

  async function executeCorePath() {
    const core = scenario.corePath;
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "Core Path 开始执行",
      action: `${core.action}_${core.pathId}`,
      decisionReason: core.riskReason,
      evidenceRefs: []
    });
    await runCoreAction(core.action);
    await appendAudit({
      type: "agent_action",
      action: `${core.action}_${core.pathId}`,
      result: "recorded",
      details: { runId: id, scenarioId: scenario.id, action: core.action }
    });
    await page.waitForTimeout(core.waitMs ?? 700);
    const firstScreenshot = await screenshot(`after_${core.stepId}`);
    const operationEvidence = await appendEvidence(id, {
      type: "operation",
      title: core.title,
      pathId: core.pathId,
      stepId: core.stepId,
      ...(firstScreenshot ? {
        file: firstScreenshot,
        artifactIds: [`${id}_screenshot_${activeAttempt}_after_${core.stepId}`]
      } : {}),
      payload: {
        action: core.action,
        target: core.triggerButtonName ?? core.submitButtonName ?? core.inputLabel,
        input: core.input,
        screenshotCaptured: Boolean(firstScreenshot)
      }
    });

    const preRetryOracles =
      core.action === "simulate_error_and_retry"
        ? core.oracles.filter((oracle) => oracle.type === "network_query" || oracle.type === "error_text")
        : core.oracles;
    const postRetryOracles =
      core.action === "simulate_error_and_retry"
        ? core.oracles.filter((oracle) => oracle.type !== "network_query" && oracle.type !== "error_text")
        : [];

    const coreEvidenceRefs: string[] = [operationEvidence.id];
    for (const oracle of preRetryOracles) {
      const evidence = await evaluateOracle(oracle, core.stepId);
      coreEvidenceRefs.push(evidence.id);
    }

    let retryScreenshot: string | undefined;
    if (core.action === "simulate_error_and_retry") {
      await appendLoopEvent(id, {
        loopType: "failure_recovery_loop",
        iteration: 1,
        status: "retrying",
        title: "异常路径执行重试恢复",
        action: "click_retry",
        observation: "接口错误提示已采集，继续点击重试验证恢复。",
        decision: "执行恢复路径",
        decisionReason: "错误恢复场景要求同一轮采集失败态和恢复态证据。",
        evidenceRefs: coreEvidenceRefs
      });
      await clickButton(core.retryButtonName);
      await page.waitForTimeout(core.waitMs ?? 700);
      retryScreenshot = await screenshot(core.retryStepId ?? `retry_${core.stepId}`);
      for (const oracle of postRetryOracles) {
        const evidence = await evaluateOracle(oracle, core.retryStepId ?? core.stepId);
        coreEvidenceRefs.push(evidence.id);
      }
    }

    const oracleNames = core.oracles.map((oracle) => oracle.name);
    const coreAssertions = assertions.filter((assertion) => oracleNames.includes(assertion.name));
    const corePassed = coreAssertions.length > 0 && coreAssertions.every((assertion) => assertion.passed);
    steps.push({
      stepId: core.pathId,
      title: core.title,
      status: corePassed ? "passed" : "failed",
      action: core.action,
      screenshot: retryScreenshot ?? firstScreenshot,
      details: corePassed
        ? `${core.title} 通过。`
        : `${core.title} 失败：至少一个验证条件未满足。`
    });
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: corePassed ? "passed" : "failed",
      title: "Core Path 断言完成",
      action: `verify_${core.pathId}`,
      observation: corePassed
        ? "所有验证条件均已通过"
        : coreAssertions.map((assertion) => `${assertion.name}=${assertion.passed}`).join("；"),
      decision: corePassed ? "继续回归路径" : "进入失败恢复循环",
      decisionReason: corePassed ? "核心路径通过" : "retry_budget=1",
      evidenceRefs: coreEvidenceRefs
    });
    return corePassed;
  }

  async function runFailureRetry() {
    const core = scenario.corePath;
    await finishAttemptTrace();
    attempts[activeAttempt - 1] = {
      ...attempts[activeAttempt - 1],
      status: "failed",
      finishedAt: new Date().toISOString(),
      retryReason: "retryable_execution_failure"
    };
    activeAttempt += 1;
    attempts.push({
      id: `${id}_attempt_${activeAttempt}`,
      runId: id,
      scenarioId: scenario.id,
      attempt: activeAttempt,
      startedAt: new Date().toISOString(),
      status: "running",
      retryReason: "retryable_execution_failure",
      artifactIds: []
    });
    await startAttemptTrace();
    await appendLoopEvent(id, {
      loopType: "failure_recovery_loop",
      iteration: 1,
      status: "retrying",
      title: "失败路径自动重试",
      action: `retry_${core.pathId}`,
      observation: "核心路径首次执行失败",
      decision: "重放同一路径并保留截图",
      decisionReason: "retry_budget=1",
      evidenceRefs: assertions.filter((item) => !item.passed).map((item) => item.name)
    });
    await reloadUsablePage(page);
    const assertionStart = assertions.length;
    await runCoreAction(core.action);
    await page.waitForTimeout(core.waitMs ?? 700);
    for (const oracle of core.oracles) await evaluateOracle(oracle, core.retryStepId ?? core.stepId);
    const retryPassed = assertions.slice(assertionStart).length > 0 && assertions.slice(assertionStart).every((assertion) => assertion.passed);
    steps.push({
      stepId: core.retryStepId ?? `retry_${core.pathId}`,
      title: "失败路径自动重试",
      status: retryPassed ? "warning" : "failed",
      action: "retry",
      screenshot: await screenshot(core.retryStepId ?? `retry_${core.pathId}`),
      details: retryPassed ? "重试通过，但首轮失败仍保留并标记 flaky/timing-sensitive。" : "重试仍失败，首轮与重试证据均已保留。"
    });
    await appendLoopEvent(id, {
      loopType: "failure_recovery_loop",
      iteration: 2,
      status: "failed",
      title: "重试完成，失败证据保留",
      action: "record_retry_result",
      observation: "核心路径失败后已重试，证据包保留给用户复核。",
      decision: "继续执行回归路径",
      decisionReason: "fail_fast=false，需要收集更多证据",
      evidenceRefs: []
    });
    attempts[activeAttempt - 1] = { ...attempts[activeAttempt - 1], status: retryPassed ? "passed" : "failed", finishedAt: new Date().toISOString() };
  }

  async function runRegressionPath() {
    if (!scenario.regressionPath) return;
    if (scenario.regressionPath.triggerButtonName) {
      await clickButton(scenario.regressionPath.triggerButtonName);
      await page.waitForTimeout(400);
    }
    await appendAudit({
      type: "agent_action",
      action: `continue_regression_${scenario.regressionPath.stepId}`,
      result: "recorded",
      details: { runId: id, target: scenario.regressionPath.triggerButtonName }
    });
    steps.push({
      stepId: scenario.regressionPath.stepId,
      title: scenario.regressionPath.title,
      status: "passed",
      action: scenario.regressionPath.action ?? "click_filter",
      screenshot: await screenshot(scenario.regressionPath.stepId),
      details: "单路径失败后未终止整轮测试，已继续执行回归路径。"
    });
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 2,
      status: "passed",
      title: "回归路径继续执行",
      action: `continue_regression_${scenario.regressionPath.stepId}`,
      observation: scenario.regressionPath.triggerButtonName
        ? `已执行 ${scenario.regressionPath.triggerButtonName}`
        : "已执行回归路径",
      decision: "生成测试报告",
      decisionReason: "所有配置路径执行完成",
      evidenceRefs: []
    });
  }

  async function executeCompiledPlan() {
    if (!compiledPlan) throw new Error("compiled_plan_missing");
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "LLM Action DSL 开始执行",
      action: "execute_compiled_plan",
      decisionReason: "计划已经通过 contracts 与场景 capability 绑定校验",
      evidenceRefs: []
    });
    let regressionTelemetryStart: { network: number; console: number } | undefined;
    const failedPathIds = new Set<string>();
    for (const [stepIndex, step] of compiledPlan.steps.entries()) {
      if (step.pathId && failedPathIds.has(step.pathId)) {
        steps.push({
          stepId: step.id,
          title: `跳过依赖步骤：${step.action.action}`,
          status: "warning",
          action: "dependency_skipped",
          details: `同一路径 ${step.pathId} 的前置动作已经失败；该依赖步骤未执行，其他独立路径继续。`
        });
        await appendLoopEvent(id, {
          loopType: "failure_recovery_loop",
          iteration: steps.length,
          status: "stopped",
          title: `Skipped dependent step ${step.id}`,
          action: "skip_failed_path_dependency",
          observation: `path=${step.pathId}`,
          decision: "继续执行其他独立路径",
          decisionReason: "fail_fast=false; dependency_scope=path",
          evidenceRefs: []
        });
        continue;
      }
      activeCompiledStepId = step.id;
      let beforeObservation: Awaited<ReturnType<typeof captureStepPageObservation>> | undefined;
      let stepScreenshot: string | undefined;
      const stepTelemetryStart = { network: network.length, console: consoleEvents.length };
      try {
        assertWithinRunBudget();
        budgetTracker.consume({ steps: 1 });
        const assertionStart = assertions.length;
        const pathId = step.pathId ?? scenario.corePath.pathId;
        beforeObservation = await captureStepPageObservation(
          step.id,
          pathId,
          "before",
          stepTelemetryStart
        );
        const remainingRequiredScreenshots = compiledPlan.steps.length - stepIndex;
        const canCaptureBeforeScreenshot = capturedScreenshotCount + remainingRequiredScreenshots + 2
          <= budgetTracker.budget.maxScreenshots;
        if (canCaptureBeforeScreenshot
          && ["navigate", "click", "fill", "select", "upload"].includes(step.action.action)) {
          await screenshot(`${step.id}_before`);
        }
        const fixturePath = path.join(runDir, "invoice-fixture.txt");
        if (scenario.regressionPath && step.pathId === scenario.regressionPath.stepId && !regressionTelemetryStart) {
          regressionTelemetryStart = { network: network.length, console: consoleEvents.length };
        }
        const structuredResult = await executeCompiledAction(step.action, step.id, {
          page,
          scenario,
          targetFrontendUrl: frontendUrl,
          evaluateOracle: (oracle, stepId) => evaluateOracle(oracle, stepId, step.pathId ?? scenario.corePath.pathId),
          resolveFixture: async (fixtureRef) => {
            if (fixtureRef !== "scenarioFixture" || scenario.corePath.action !== "file_upload_validate") {
              throw new Error(`compiled_plan_unknown_fixture:${fixtureRef}`);
            }
            await writeFile(fixturePath, "AI Test Officer scenario fixture.\n");
            return fixturePath;
          },
          resolveValue: async (valueRef) => {
            if (!projectLoginSecret) throw new Error("credential_missing:project_login_credential");
            if (valueRef === "projectLoginUsername") return projectLoginSecret.username;
            if (valueRef === "projectLoginPassword") return projectLoginSecret.password;
            throw new Error(`compiled_plan_unknown_dynamic_value:${valueRef}`);
          },
          executeStructured: async (action) => {
            if (!configuredProject?.manifest) throw new Error("structured_action_project_manifest_missing");
            return executeStructuredAction({
              action,
              manifest: configuredProject.manifest,
              project: configuredProject,
              target: targetRuntime,
              signal: input.signal
            });
          },
          onNavigation: (event) => browserLifecycleEvents.push({ type: "page_goto", ...event, capturedAt: new Date().toISOString() })
        });
        recordBrowserLifecycle();
        if (step.pathId === scenario.smoke.pathId && step.action.action === "navigate") {
          await evaluateCompiledSmokePath(step.id);
        }
        if (scenario.regressionPath && step.pathId === scenario.regressionPath.stepId
          && !compiledPlan.steps.slice(stepIndex + 1).some((candidate) => candidate.pathId === step.pathId)) {
          await evaluateCompiledRegressionPath(step.id, step.pathId, regressionTelemetryStart ?? { network: network.length, console: consoleEvents.length });
        }
        const afterObservation = await captureStepPageObservation(
          step.id,
          pathId,
          "after",
          stepTelemetryStart,
          beforeObservation.snapshot
        );
        stepScreenshot = await screenshot(step.id);
        let operationEvidence: EvidenceItem;
        if (structuredResult) {
          const finalPath = path.join(runDir, `${step.id}.operation.json`);
          const temporaryPath = `${finalPath}.partial`;
          await writeFile(temporaryPath, JSON.stringify({
            action: step.action,
            result: structuredResult
          }, null, 2));
          const artifact = await commitCapturedFile({
            temporaryPath,
            finalPath,
            id: `${id}_operation_${activeAttempt}_${step.id}`,
            identity: attemptIdentity(),
            stepId: step.id,
            kind: "operation-log",
            mediaType: "application/json",
            storageUri: artifactUrl(finalPath),
            clock: attemptClock,
            collectorVersion: "0.2.0"
          });
          const locatedArtifact: ArtifactV2 = {
            ...artifact,
            locator: structuredResult.locator
          };
          artifactsV2.push(locatedArtifact);
          budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
          attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
          operationEvidence = await appendEvidence(id, {
            type: "operation",
            title: `Structured action ${step.action.action}`,
            pathId: step.pathId ?? scenario.corePath.pathId,
            stepId: step.id,
            file: artifact.storageUri,
            artifactIds: [artifact.id],
            locator: structuredResult.locator,
            payload: {
              action: step.action.action,
              observationEvidenceRefs: [beforeObservation.evidence.id, afterObservation.evidence.id],
              changes: afterObservation.snapshot.changes ?? [],
              ...structuredResult.payload
            }
          });
          const oracleId = "oracleId" in step.action ? step.action.oracleId : step.action.action;
          await recordAssertion({
            name: `${oracleId}: ${step.action.action}`,
            passed: structuredResult.passed,
            expected: "Declared manifest operation and oracle succeed.",
            actual: structuredResult.summary,
            fact: {
              kind: "state.equals",
              target: oracleId,
              operator: "equals",
              expected: "passed",
              actual: structuredResult.passed ? "passed" : "failed",
              severity: "high",
              evidenceRefs: [operationEvidence.id],
              failureClass: structuredResult.passed ? undefined : "product_bug"
            }
          }, step.pathId ?? scenario.corePath.pathId, step.id);
        } else {
          operationEvidence = await appendEvidence(id, {
            type: "operation",
            title: `Compiled action ${step.action.action}`,
            pathId: step.pathId ?? scenario.corePath.pathId,
            stepId: step.id,
            ...(stepScreenshot ? {
              file: stepScreenshot,
              artifactIds: [`${id}_screenshot_${activeAttempt}_${step.id}`]
            } : {}),
            payload: {
              action: step.action.action,
              observationEvidenceRefs: [beforeObservation.evidence.id, afterObservation.evidence.id],
              changes: afterObservation.snapshot.changes ?? [],
              ...(step.action.action === "click" || step.action.action === "fill" || step.action.action === "select" || step.action.action === "upload"
                ? { selectorRef: step.action.selectorRef }
                : {}),
              ...(step.action.action === "assert" ? { oracleId: step.action.oracleId } : {})
            }
          });
        }
        const newAssertions = assertions.slice(assertionStart);
        const passed = newAssertions.every((assertion) => assertion.passed);
        steps.push({
          stepId: step.id,
          title: `LLM plan: ${step.action.action}`,
          status: passed ? "passed" : "failed",
          action: step.action.action,
          screenshot: stepScreenshot,
          details: passed ? "受控测试步骤执行完成。" : "该步骤的验证条件未通过。"
        });
        await appendLoopEvent(id, {
          loopType: "gray_execution_loop",
          iteration: steps.length,
          status: passed ? "passed" : "failed",
          title: `Compiled step ${step.id}`,
          action: step.action.action,
          observation: passed ? "动作完成且绑定断言通过" : "绑定断言失败",
          decision: "继续执行下一条已编译动作",
          decisionReason: "fail_fast=false，保留完整计划证据",
          evidenceRefs: [beforeObservation.evidence.id, operationEvidence.id, afterObservation.evidence.id]
        });
      } catch (error) {
        const classified = classifyExecutionError(error, step.id);
        executionError ??= classified;
        if (step.pathId) failedPathIds.add(step.pathId);
        const failureScreenshot = stepScreenshot ?? await screenshot(step.id).catch(() => undefined);
        const failureObservation = await captureStepPageObservation(
          step.id,
          step.pathId ?? scenario.corePath.pathId,
          "failure",
          stepTelemetryStart,
          beforeObservation?.snapshot
        ).catch(() => undefined);
        const errorEvidence = await appendEvidence(id, {
          type: "operation",
          title: `Compiled action ${step.action.action} failed`,
          pathId: step.pathId ?? scenario.corePath.pathId,
          stepId: step.id,
          ...(failureScreenshot ? {
            file: failureScreenshot,
            artifactIds: [`${id}_screenshot_${activeAttempt}_${step.id}`]
          } : {}),
          payload: {
            action: step.action.action,
            code: classified.code,
            failureClass: classified.failureClass,
            message: classified.message,
            observationEvidenceRefs: [
              beforeObservation?.evidence.id,
              failureObservation?.evidence.id
            ].filter((item): item is string => Boolean(item)),
            changes: failureObservation?.snapshot.changes ?? []
          }
        });
        steps.push({
          stepId: step.id,
          title: `动作失败：${step.action.action}`,
          status: "failed",
          action: step.action.action,
          screenshot: failureScreenshot,
          details: `${classified.code}: ${classified.message}`
        });
        await appendLoopEvent(id, {
          loopType: "failure_recovery_loop",
          iteration: steps.length,
          status: "failed",
          title: `Compiled step ${step.id} failed`,
          action: "persist_failure_and_continue",
          observation: classified.code,
          decision: "跳过同路径依赖步骤，继续其他独立路径",
          decisionReason: classified.failureClass,
          evidenceRefs: [
            beforeObservation?.evidence.id,
            errorEvidence.id,
            failureObservation?.evidence.id
          ].filter((item): item is string => Boolean(item))
        });
      } finally {
        activeCompiledStepId = undefined;
      }
    }
  }

  let activeCompiledStepId: string | undefined;
  let executionError: NonNullable<VisualRunResult["executionError"]> | undefined;
  try {
    if (compiledPlan) {
      await executeCompiledPlan();
    } else {
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: "running",
      title: "Smoke 路径开始执行",
      action: "open_page",
      decisionReason: "先确认页面基础可用",
      evidenceRefs: []
    });
    await navigateToUsablePage(page, frontendUrl, (event) => browserLifecycleEvents.push({ type: "page_goto", ...event, capturedAt: new Date().toISOString() }));
    recordBrowserLifecycle();
    await appendAudit({
      type: "agent_action",
      action: "browser_open",
      result: "recorded",
      details: { runId: id, appUrl: frontendUrl }
    });
    const openScreenshot = await screenshot(scenario.smoke.stepId);
    const operationEvidence = await appendEvidence(id, {
      type: "operation",
      title: scenario.smoke.title,
      stepId: scenario.smoke.stepId,
      ...(openScreenshot ? {
        file: openScreenshot,
        artifactIds: [`${id}_screenshot_${activeAttempt}_${scenario.smoke.stepId}`]
      } : {}),
      payload: { action: "browser_open", appUrl: frontendUrl }
    });
    steps.push({
      stepId: scenario.smoke.stepId,
      title: scenario.smoke.title,
      status: "passed",
      action: "browser_open",
      screenshot: openScreenshot,
      details: `已打开 ${frontendUrl}`
    });

    const titleVisible = await isSmokeAnchorVisible();
    const pageAssertionEvidence = await recordAssertion({
      name: scenario.smoke.assertionName,
      passed: titleVisible,
      expected: runtimeSmokeExpectation(scenario.smoke.expected, frontendUrl),
      actual: titleVisible ? "标题可见" : "标题不可见",
      fact: {
        kind: "element.visible",
        target: `heading:${scenario.smoke.headingName}`,
        operator: "exists",
        expected: scenario.smoke.headingName,
        actual: titleVisible ? "visible" : "hidden",
        severity: "high",
        evidenceRefs: [],
        failureClass: titleVisible ? undefined : "environment_issue"
      }
    }, scenario.smoke.pathId);
    await appendLoopEvent(id, {
      loopType: "gray_execution_loop",
      iteration: 1,
      status: titleVisible ? "passed" : "failed",
      title: "Smoke 断言完成",
      action: "assert_page_loaded",
      observation: titleVisible ? "页面标题可见" : "页面标题不可见",
      decision: titleVisible ? "进入核心路径" : "记录失败并继续核心路径",
      decisionReason: "fail_fast=false，继续收集更多证据",
      evidenceRefs: [operationEvidence.id, pageAssertionEvidence.id]
    });

    const corePassed = await executeCorePath();
    const retryDecision = classifyRetry({ assertions: assertions.filter((assertion) => !assertion.passed), attempt: activeAttempt, maxAttempts: budgetTracker.budget.maxAttempts });
    if (!corePassed && scenario.corePath.action !== "simulate_error_and_retry" && retryDecision.retryable) {
      await runFailureRetry();
    }
    await runRegressionPath();
    }
  } catch (error) {
    executionError = classifyExecutionError(error, activeCompiledStepId);
    const failedStepId = executionError.stepId ?? `execution-error-${activeAttempt}`;
    const failureScreenshot = await screenshot(failedStepId).catch(() => undefined);
    const errorEvidence = await appendEvidence(id, {
      type: "operation",
      title: "Compiled action execution failed",
      stepId: failedStepId,
      ...(failureScreenshot ? {
        file: failureScreenshot,
        artifactIds: [`${id}_screenshot_${activeAttempt}_${failedStepId}`]
      } : {}),
      payload: { code: executionError.code, failureClass: executionError.failureClass, message: executionError.message }
    });
    steps.push({
      stepId: failedStepId,
      title: "Compiled action execution failed",
      status: "failed",
      action: "execution_error",
      screenshot: failureScreenshot,
      details: `${executionError.code}: ${executionError.message}`
    });
    await appendLoopEvent(id, {
      loopType: "failure_recovery_loop",
      iteration: steps.length,
      status: "stopped",
      title: "执行动作失败，停止依赖步骤",
      action: "persist_partial_execution",
      observation: executionError.code,
      decision: "先持久化证据，再进入机器门禁",
      decisionReason: executionError.failureClass,
      evidenceRefs: [errorEvidence.id]
    });
  } finally {
    try {
      try {
        const html = await page.content();
        const finalPath = path.join(runDir, `attempt-${activeAttempt}-dom.html`);
        const temporaryPath = `${finalPath}.partial`;
        await writeFile(temporaryPath, html);
        const artifact = await commitCapturedFile({
          temporaryPath,
          finalPath,
          id: `${id}_dom_attempt_${activeAttempt}`,
          identity: attemptIdentity(),
          stepId: `attempt-${activeAttempt}-finalize`,
          kind: "dom",
          mediaType: "text/html",
          storageUri: artifactUrl(finalPath),
          clock: attemptClock,
          collectorVersion: "0.2.0"
        });
        const locatedArtifact: ArtifactV2 = {
          ...artifact,
          locator: {
            pageUrl: page.url(),
            snapshotSha256: artifact.integrity.sha256
          }
        };
        artifactsV2.push(locatedArtifact);
        budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
        attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
        await appendEvidence(id, {
          type: "dom",
          title: "Full DOM snapshot",
          file: artifact.storageUri,
          artifactIds: [artifact.id],
          locator: {
            pageUrl: page.url(),
            snapshotSha256: artifact.integrity.sha256
          },
          payload: { file: artifact.storageUri, html: html.slice(0, 60_000), truncated: html.length > 60_000 }
        });
      } catch {
        // Page may already be closed after a hard browser failure; other evidence remains available.
      }
      await finishAttemptTrace().catch(() => undefined);
      unbindTelemetry();
      await browserSession.closeContext();
      if (recordVideo && pageVideo) {
        try {
          const videoPath = await pageVideo.path();
          const finalPath = path.join(runDir, `attempt-${activeAttempt}.webm`);
          const artifact = await commitCapturedFile({
            temporaryPath: videoPath,
            finalPath,
            id: `${id}_video_attempt_${activeAttempt}`,
            identity: attemptIdentity(),
            stepId: `attempt-${activeAttempt}-finalize`,
            kind: "video",
            mediaType: "video/webm",
            storageUri: artifactUrl(finalPath),
            clock: attemptClock,
            collectorVersion: "0.2.0"
          });
          artifactsV2.push(artifact);
          if (artifact.integrity.sizeBytes > budgetTracker.budget.maxVideoBytes) throw new Error("budget_exceeded:video_size");
          budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
          attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
          await appendEvidence(id, {
            type: "video",
            title: "Playwright video",
            file: artifact.storageUri,
            artifactIds: [artifact.id],
            payload: { file: artifact.storageUri }
          });
        } catch {
          // Video is optional; screenshots and trace remain authoritative evidence.
        }
      }
      await browserSession.closeBrowser();
    } finally {
      if (configuredProject && shouldAutoStopProjectRuntime({ projectWasStartedByRunner, keepProjectRunning: input.keepProjectRunning, runtimeStatus })) {
        const stopped = await stopProject(configuredProject.id);
        runtimeStatus = {
          ...stopped,
          message: `Project auto-stopped after run because the runner started it. ${stopped.message}`
        };
        const stopEvidence = await appendEvidence(id, {
          type: "operation",
          title: "Project runtime auto-stop",
          payload: {
            projectId: configuredProject.id,
            projectWasStartedByRunner,
            keepProjectRunning: Boolean(input.keepProjectRunning),
            runtimeStatus
          }
        });
        await appendLoopEvent(id, {
          loopType: "report_loop",
          iteration: 0,
          status: "stopped",
          title: "runner 启动的项目已自动停止",
          action: "project_runtime_auto_stop",
          observation: runtimeStatus.message,
          decision: "继续生成 run bundle",
          decisionReason: "避免真实项目接入 smoke 后遗留 dev server 或子进程。",
          evidenceRefs: [stopEvidence.id]
        });
      }
    }
  }

  const failed = assertions.some((assertion) => !assertion.passed);
  const runFailed = failed || Boolean(executionError);
  const finishedAt = new Date().toISOString();
  await Promise.allSettled(evidenceWrites);
  for (const [kind, value, mediaType] of [
    ["network", network, "application/json"],
    ["console", consoleEvents, "application/json"]
  ] as const) {
    const finalPath = path.join(runDir, `attempt-${activeAttempt}-${kind}.json`);
    const temporaryPath = `${finalPath}.partial`;
    await writeFile(temporaryPath, JSON.stringify(value, null, 2));
    const artifact = await commitCapturedFile({
      temporaryPath,
      finalPath,
      id: `${id}_${kind}_attempt_${activeAttempt}`,
      identity: attemptIdentity(),
      stepId: `attempt-${activeAttempt}-finalize`,
      kind,
      mediaType,
      storageUri: artifactUrl(finalPath),
      clock: attemptClock,
      collectorVersion: "0.2.0"
    });
    const locatedArtifact: ArtifactV2 = {
      ...artifact,
      locator: {
        timeRange: {
          from: attempts[activeAttempt - 1]?.startedAt ?? startedAt,
          to: artifact.integrity.capturedAt
        }
      }
    };
    artifactsV2.push(locatedArtifact);
    budgetTracker.consume({ artifactBytes: artifact.integrity.sizeBytes });
    attempts[activeAttempt - 1]?.artifactIds.push(artifact.id);
    await appendEvidence(id, {
      type: kind,
      title: `${kind} artifact attempt ${activeAttempt}`,
      file: artifact.storageUri,
      artifactIds: [artifact.id],
      payload: { file: artifact.storageUri, count: value.length }
    });
  }
  attempts[activeAttempt - 1] = {
    ...attempts[activeAttempt - 1],
    status: attempts.length > 1 ? attempts[activeAttempt - 1].status : failed || executionError ? "failed" : "passed",
    finishedAt
  };
  let latestEvidence: EvidenceItem[] = await readEvidence(id);
  const declaredRequiredKinds = (compiledPlan?.requiredEvidenceKinds
    ?? input.executablePlan?.steps.find((step) => step.scenarioId === scenario.id)?.evidenceRequirements
    ?? ["screenshot", "dom", "network", "console"])
    .filter((kind) => ["screenshot", "dom", "network", "console", "trace", "video"].includes(kind)) as ArtifactV2["kind"][];
  const requiredKinds = Array.from(new Set<ArtifactV2["kind"]>([
    ...declaredRequiredKinds,
    "trace"
  ]));
  const mirroredArtifacts = await mirrorArtifactsToConfiguredStore(artifactsV2, reportsDir);
  artifactsV2.splice(0, artifactsV2.length, ...mirroredArtifacts);
  latestEvidence = linkCommittedAttemptArtifacts(latestEvidence, artifactsV2);
  const evidenceQuality = buildEvidenceQualityReport({ assertions, evidence: latestEvidence, artifacts: artifactsV2 });
  // Materialize the proof bundle on the Evidence records themselves. The
  // quality evaluator already chose same-attempt artifacts of the required
  // kinds; copying those immutable IDs onto Evidence makes the proof chain
  // explicit instead of relying on a report-time proximity heuristic.
  for (const quality of evidenceQuality.assertions) {
    for (const evidenceRef of quality.evidenceRefs) {
      const evidence = latestEvidence.find((item) => item.id === evidenceRef);
      if (!evidence) continue;
      evidence.artifactIds = Array.from(new Set([...(evidence.artifactIds ?? []), ...quality.artifactIds]));
    }
  }
  // Persist final same-attempt associations before Judge and Proof Graph
  // generation. A service restart must reproduce the exact same proof chain.
  latestEvidence = await finalizeEvidenceArtifactLinks(id, latestEvidence);
  const artifactGate = assessArtifactGate({ artifacts: artifactsV2, requiredKinds });
  const partialResult = {
    assertions,
    steps,
    verdict: runFailed ? "hold_for_review" : "continue"
  } as Pick<VisualRunResult, "assertions" | "steps" | "verdict">;
  const oracles = buildScenarioOracles(scenario, latestEvidence);
  const riskCoverageMatrix = buildRiskCoverageMatrix({ assertions }, latestEvidence, scenario);
  const conflictPacket = buildConflictPacket({ assertions, steps }, latestEvidence);
  const runScenarioFingerprint = scenarioFingerprint({
    id: scenario.id,
    action: scenario.corePath.action,
    oracles: scenario.corePath.oracles
  });
  const historicalVerdict = await appendRunHistory({
    runId: id,
    appUrl: frontendUrl,
    projectId: targetRuntime.projectId ?? configuredProject?.id,
    scenarioId: scenario.id,
    scenarioFingerprint: runScenarioFingerprint,
    result: partialResult
  });
  const retryRecovered = attempts.length > 1 && attempts[0]?.status === "failed" && attempts.at(-1)?.status === "passed";
  const aggregatedVerdict = retryRecovered
    ? { ...historicalVerdict, flaky: true, verdict: "needs_review" as const, reason: "First attempt failed and a retry passed; marked timing-sensitive." }
    : historicalVerdict;
  const baselineJudgeReport = buildLayeredJudgeReport({
    plan: input.plan,
    requirement: input.requirement,
    diff: input.diff,
    result: {
      steps,
      assertions,
      network,
      console: consoleEvents,
      riskCoverageMatrix,
      aggregatedVerdict,
      conflictPacket,
      verdict: runFailed ? "hold_for_review" : "continue"
    },
    evidence: latestEvidence
  });
  const judgeRouting = input.judgeMode === "adaptive"
    ? executionError?.failureClass === "test_script_issue"
      ? { route: "deterministic" as const, reason: "test_script_failure_is_actionable", signals: ["test_script_failure"] }
      : routeJudge({
      baseline: baselineJudgeReport,
      conflictStatus: conflictPacket.status,
      failedAssertionCount: assertions.filter((item) => !item.passed).length,
      insufficientEvidenceCount: evidenceQuality.assertions.filter((item) => item.status === "insufficient").length,
      knownEnvironmentFailureCount: network.filter((item) => {
        const candidate = item as unknown as Record<string, unknown>;
        return (typeof candidate.status === "number" && candidate.status >= 500)
          || candidate.failed === true || Boolean(candidate.error);
      }).length
      })
    : { route: input.judgeMode === "llm-assisted" ? "llm" as const : "deterministic" as const, reason: "explicit_mode", signals: [`mode:${input.judgeMode ?? "deterministic"}`] };
  const assistedJudgeReport = judgeRouting.route === "llm"
    ? await buildLlmJudgeReport({
      credentialId: input.credentialId,
      baseline: baselineJudgeReport,
      plan: input.plan,
      requirement: input.requirement,
      diff: input.diff,
      result: {
        steps,
        assertions,
        network,
        console: consoleEvents,
        riskCoverageMatrix,
        aggregatedVerdict,
        conflictPacket,
        verdict: runFailed ? "hold_for_review" : "continue"
      },
      evidence: latestEvidence,
      runId: id,
      experimentId: input.experimentId,
      requireLlm: true,
      llmBudget: input.llmBudget,
      priorLlmTokens: input.priorLlmTokens
    })
    : baselineJudgeReport;
  const qualityReasons = evidenceQuality.assertions
    .filter((item) => item.passed && item.status !== "grounded")
    .flatMap((item) => [`assertion_evidence_incomplete:${item.assertionName}`, ...item.reasons.map((reason) => `${item.assertionName}:${reason}`)]);
  // A non-empty coverage matrix is not enough: every required oracle must
  // have been executed. Otherwise a scheduling-complete run could be shown as
  // a pass even though the requirement was never exercised.
  const uncoveredRequirementRisks = riskCoverageMatrix
    .filter((item) => !item.covered)
    .map((item) => `requirement_not_covered:${item.riskId}`);
  const environmentFailures = network.filter((item) => {
    const candidate = item as unknown as Record<string, unknown>;
    return (typeof candidate.status === "number" && candidate.status >= 500)
      || candidate.failed === true || Boolean(candidate.error);
  });
  const environmentFailureObserved = environmentFailures.length > 0;
  const environmentReasons = environmentFailures.slice(0, 3).map((item) => {
    const candidate = item as unknown as Record<string, unknown>;
    const method = typeof candidate.method === "string" ? candidate.method : "request";
    const url = typeof candidate.url === "string" ? candidate.url : "unknown-url";
    const status = typeof candidate.status === "number" ? candidate.status : "network-error";
    return `environment_network_failure:${method}:${url}:${status}`;
  });
  const machineGateStatus = artifactGate.status !== "pass"
    ? artifactGate.status
    : executionError?.failureClass === "environment_issue"
      ? "blocked" as const
      : environmentFailureObserved
        ? "blocked" as const
      : executionError
        ? "needs-human-review" as const
    : failed
      ? "fail" as const
      : qualityReasons.length || uncoveredRequirementRisks.length
        ? "needs-human-review" as const
      : attempts.length > 1
        ? "needs-human-review" as const
        : "pass" as const;
  const machineGateEvidenceRefs = latestEvidence
    .filter((item) => item.type === "assertion" || item.artifactIds?.some((id) =>
      artifactGate.rejectedArtifactIds.includes(id) || artifactGate.eligibleArtifactIds.includes(id)
    ))
    .map((item) => item.id)
    .slice(-20);
  const judgeReport = enforceMachineGate({
    report: assistedJudgeReport,
    status: machineGateStatus,
    assessment: artifactGate,
    evidenceRefs: machineGateEvidenceRefs.length ? machineGateEvidenceRefs : latestEvidence.slice(-5).map((item) => item.id)
  });
  const machineGateDraft: MachineGateDraft = {
    status: machineGateStatus,
    reasons: [
      ...artifactGate.reasons,
      ...(executionError ? [`execution_error:${executionError.code}:${executionError.stepId ?? "unknown"}`] : []),
      ...environmentReasons,
      ...qualityReasons,
      ...uncoveredRequirementRisks
    ],
    reasonDetails: [
      ...artifactGate.reasons,
      ...(executionError ? [`execution_error:${executionError.code}:${executionError.stepId ?? "unknown"}`] : []),
      ...environmentReasons,
      ...qualityReasons,
      ...uncoveredRequirementRisks
    ].map((reason) => ({
      code: reason.split(":")[0] || "machine_gate_reason",
      summary: reason,
      evidenceRefs: reason.startsWith("environment_network_failure:")
        ? latestEvidence.filter((item) => item.type === "network" || item.type === "console").slice(-6).map((item) => item.id)
        : machineGateEvidenceRefs.length
          ? machineGateEvidenceRefs
          : latestEvidence.slice(-5).map((item) => item.id)
    })).filter((item) => item.evidenceRefs.length > 0),
    assertionFailures: assertions.filter((item) => !item.passed).map((item) => item.name)
  };
  // Proof credibility (evidenceComplete / artifactIntegrityVerified /
  // evidenceGrounded / gateEligible) is recomputed by the Proof Bundle Service
  // from the actually-committed artifacts + evidence. A clean integrity report
  // is derived from the gate assessment and the committed artifact digests.
  const artifactIntegrityReport: ArtifactIntegrityReport = {
    id: `${id}_artifact_integrity`,
    runId: id,
    generatedAt: new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: {
      total: artifactsV2.length,
      present: artifactGate.status === "pass" ? artifactsV2.length : 0,
      missing: 0,
      unreadable: 0,
      pathEscapes: 0,
      selfReferences: 0,
      hashMismatches: artifactGate.status === "pass" ? 0 : artifactsV2.length,
      hashed: artifactsV2.length
    },
    items: artifactsV2.map((artifact) => ({
      id: artifact.id,
      artifactUri: artifact.storageUri,
      kind: artifactKindToIntegrityKind(artifact.kind),
      status: artifactGate.status === "pass" ? "present" : "hash_mismatch",
      sha256: artifact.integrity.sha256,
      sizeBytes: artifact.integrity.sizeBytes
    }))
  };
  const requirementCovered = riskCoverageMatrix.length > 0 && riskCoverageMatrix.every((item) => item.covered);
  const requirementPassed = requirementCovered && riskCoverageMatrix.every((item) => item.passed);
  const executionSucceeded = !executionError && attempts.length > 0;
  const { machineGate, verdict, issues, gateEligible } = finalizeProofBundle({
    draft: machineGateDraft,
    runId: id,
    scenarioId: scenario.id,
    attemptId: attemptIdentity().attemptId,
    evidence: latestEvidence,
    artifactsV2,
    artifactIntegrity: artifactIntegrityReport,
    requiredArtifactKinds: requiredKinds,
    machineGate: machineGateDraft,
    judgeReport,
    gateEligibleFacts: { executionSucceeded, requirementCovered }
  });
  const judgeRecommendation: JudgeRecommendation = {
    status: judgeReport.releaseJudge.verdict === "needs_review" ? "needs-human-review" : judgeReport.releaseJudge.verdict,
    summary: judgeReport.releaseJudge.summary,
    evidenceRefs: Array.from(new Set(judgeReport.releaseJudge.findings.flatMap((finding) => finding.evidenceRefs)))
  };
  const finalStatus = resolveFinalStatus({ machineGate, judgeRecommendation });
  const outcomeSummary = runOutcomeSummaryV2Schema.parse({
    schemaVersion: "2.0",
    schedulingCompleted: true,
    executionStarted: attempts.length > 0,
    executionSucceeded,
    requirementCovered,
    requirementPassed,
    ...proofCredibility(verdict, machineGate, gateEligible),
    proofValidationIssues: issues,
    machineGate,
    judgeRecommendation,
    finalStatus
  });
  const failureAttributions = buildFailureAttributions({
    assertions,
    steps,
    network,
    console: consoleEvents,
    evidence: latestEvidence,
    sourceContexts: input.sourceContexts ?? [],
    impactAnalysis: input.impactAnalysis,
    diff: input.diff
  });
  // Persist the owner-aware repair plan alongside the attribution. A failure
  // that nobody owns is exactly the dead end this chain exists to remove.
  const topAttribution = selectRepairableAttribution(failureAttributions);
  if (runFailed && topAttribution) {
    await persistRepairPlan({
      runId: id,
      projectId: targetRuntime.projectId ?? configuredProject?.id,
      attributionId: topAttribution.id,
      failureType: topAttribution.failureClass,
      problem: topAttribution.title,
      decision: decideRepair(topAttribution)
    });
  }
  const failedNames = assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.name);
  const reflectionNote = runFailed
    ? `本次失败集中在 ${scenario.corePath.title}：${failedNames.join("、") || executionError?.code}。下一轮应优先检查对应 evidence ID 的 network、DOM 和截图是否一致。`
    : `本次 ${scenario.title} 显式灰度路径通过，证据包包含 ${latestEvidence.length} 条 evidence。`;
  await appendLoopEvent(id, {
    loopType: conflictPacket.status === "not_triggered" ? "report_loop" : "evidence_conflict_loop",
    iteration: 1,
    status: conflictPacket.status === "not_triggered" ? "passed" : "waiting_for_user",
    title: conflictPacket.status === "not_triggered" ? "未触发证据冲突复现" : "失败证据需要用户复核",
    action: "build_conflict_packet",
    observation: conflictPacket.reason,
    decision: "生成报告",
    decisionReason: "当前运行已完成证据包构建",
    evidenceRefs: conflictPacket.evidenceRefs
  });
  await appendLoopEvent(id, {
    loopType: "report_loop",
    iteration: 1,
    status: "waiting_for_user",
    title: "报告已生成，等待用户裁决",
    action: "generate_report",
    observation: runFailed ? "核心路径存在失败断言或执行错误" : "未发现阻塞断言",
    decision: runFailed ? "建议 hold_for_review" : "建议 continue",
    decisionReason: executionError ? executionError.code : failed ? `${scenario.corePath.title} 存在未通过的验证条件` : "所有断言通过",
    evidenceRefs: latestEvidence.map((item) => item.id).slice(-8)
  });
  const loopEvents = await readLoopEvents(id);
  const result: VisualRunResult = {
    id,
    startedAt,
    finishedAt,
    scenarioFingerprint: runScenarioFingerprint,
    verdict: runFailed ? "hold_for_review" : "continue",
    summary: runFailed
      ? "核心路径存在失败证据，建议用户复核并阻塞合并。"
      : "显式灰度路径未发现阻塞问题。",
    steps,
    network,
    console: consoleEvents,
    assertions,
    evidence: latestEvidence,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    aggregatedVerdict,
    reflectionNote,
    conflictPacket,
    failureAttributions,
    attempts,
    artifactsV2,
    gateStatus: finalStatus,
    machineGate,
    judgeRecommendation,
    finalStatus,
    outcomeSummary,
    executionError,
    repairAttempts: loopEvents
      .filter((event) => event.loopType === "failure_recovery_loop" && event.status === "retrying")
      .slice(0, Math.max(0, Math.min(input.maxAutoRepairs ?? 2, 2)))
      .map((event, index) => ({
        attempt: index + 1,
        kind: "execution_retry" as const,
        status: "completed" as const,
        reason: event.decisionReason ?? "受控执行重试",
        evidenceRefs: event.evidenceRefs
      })),
    runtimeStatus,
    evidenceQuality,
    judgeReport,
    judgeRouting,
    reportFile: artifactUrl(path.join(runDir, "report.json")),
    runBundleFile: artifactUrl(path.join(runDir, "run_bundle.json"))
  };
  const proofGraph = buildProofGraph(result);
  result.coverageItems = proofGraph.coverageItems;
  result.conclusions = proofGraph.conclusions;
  result.proofNodes = proofGraph.proofNodes;
  result.proofEdges = proofGraph.proofEdges;
  if (proofGraph.errors.length > 0 && result.finalStatus === "pass") {
    // A proof-graph inconsistency must downgrade the gate *through* the Proof
    // Bundle Service — never by re-assigning credibility flags directly.
    const degradedDraft: MachineGateDraft = {
      status: "needs-human-review",
      reasons: [
        ...new Set([
          ...(result.machineGate?.reasons ?? machineGate.reasons),
          ...proofGraph.errors.map((error) => `proof_invalid:${error}`)
        ])
      ],
      reasonDetails: result.machineGate?.reasonDetails ?? machineGate.reasonDetails,
      assertionFailures: result.machineGate?.assertionFailures ?? machineGate.assertionFailures
    };
    const degraded = finalizeProofBundle({
      draft: degradedDraft,
      runId: id,
      scenarioId: scenario.id,
      attemptId: attemptIdentity().attemptId,
      evidence: latestEvidence,
      artifactsV2,
      artifactIntegrity: artifactIntegrityReport,
      requiredArtifactKinds: requiredKinds,
      machineGate: degradedDraft,
      judgeReport
    });
    result.machineGate = degraded.machineGate;
    result.finalStatus = "needs-human-review";
    result.gateStatus = "needs-human-review";
    result.outcomeSummary = runOutcomeSummaryV2Schema.parse({
      ...(result.outcomeSummary ?? outcomeSummary),
      ...proofCredibility(degraded.verdict, degraded.machineGate, degraded.gateEligible),
      finalStatus: "needs-human-review"
    });
  }
  const readableReports = await writeReadableReports({
    runDir,
    artifactBaseUrl: `/artifacts/runs/${id}`,
    result
  });
  result.markdownReportFile = readableReports.markdownReportFile;
  result.htmlReportFile = readableReports.htmlReportFile;
  result.artifactIntegrityReportFile = artifactUrl(path.join(runDir, "artifact_integrity.json"));
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  const bundle: RunBundle = {
    runId: id,
    startedAt,
    finishedAt,
    input,
    result,
    evidence: latestEvidence,
    artifactsV2,
    attempts,
    loopEvents,
    oracles,
    riskCoverageMatrix,
    conflictPacket,
    judgeReport,
    failureAttributions,
    runtimeStatus,
    project: configuredProject,
    sourceContexts: input.sourceContexts,
    impactAnalysis: input.impactAnalysis,
    executablePlan: input.executablePlan
  };
  bundle.coverageItems = result.coverageItems;
  bundle.conclusions = result.conclusions;
  bundle.proofNodes = result.proofNodes;
  bundle.proofEdges = result.proofEdges;
  const artifactIntegrity = await writeArtifactIntegrityReport({
    result,
    reportsDir,
    outputFile: path.join(runDir, "artifact_integrity.json")
  });
  result.artifactIntegrity = artifactIntegrity;
  bundle.artifactIntegrity = artifactIntegrity;
  const evidenceManifest = await writeProofArtifacts(bundle);
  result.evidenceManifest = evidenceManifest;
  bundle.evidenceManifest = evidenceManifest;
  await writeReadableReports({
    runDir,
    artifactBaseUrl: `/artifacts/runs/${id}`,
    result
  });
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(result, null, 2));
  result.runBundleFile = await writeRunBundle(bundle);
  return result;
}
