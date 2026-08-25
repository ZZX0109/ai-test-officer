import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import type { EvidenceItem, RunBundle, RunRequest, RunStepEvidence, VisualRunResult } from "./types.js";
import { runOutcomeSummaryV2Schema, type ArtifactV2 } from "@ai-test-officer/contracts";
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
import { buildLlmJudgeReport } from "./llmJudge.js";
import { writeReadableReports } from "./reportRenderer.js";
import { getProject, getProjectRuntimeStatus, resolveProjectTarget, startProject, stopProject, testProjectConnection } from "./projectAdapter.js";
import { buildFailureAttributions } from "./failureAttribution.js";
import { decideRepair } from "./repairDecision.js";
import { persistRepairPlan, selectRepairableAttribution } from "./repairPlan.js";
import { writeArtifactIntegrityReport } from "./artifactIntegrity.js";
import { assertExecutablePlan } from "./executablePlan.js";
import { withProjectRunLock } from "./runLock.js";
import { BudgetTracker } from "@ai-test-officer/execution-worker";
import { createRunnerExecutionEnvironment } from "./runnerExecutionEnvironment.js";
import { classifyRetry } from "./retryPolicy.js";
import { mirrorArtifactsToConfiguredStore } from "./artifactObjectStore.js";
import { getProjectLoginSecret } from "./projectLoginStore.js";
import { buildProofGraph, writeProofArtifacts } from "./proofGraph.js";
import { finalizeProofBundle, proofCredibility, type MachineGateDraft } from "./proof/proofBundleService.js";
import { finalizeMachineGate } from "./runner/machineGateFinalization.js";
import { finalizeVisualRun } from "./runner/runFinalization.js";
import { createScenarioExecutor } from "./runner/scenarioExecution.js";
import { linkCommittedAttemptArtifacts } from "./proof/evidenceArtifactLinker.js";
import { executeStructuredAction } from "./structuredActionExecutors.js";
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
import { assertCompiledPlanBinding, executeCompiledAction } from "./runner/compiledPlanBinding.js";
import type { CompiledActionExecutionContext } from "./runner/compiledPlanBinding.js";
export { assertCompiledPlanBinding, executeCompiledAction } from "./runner/compiledPlanBinding.js";
export type { CompiledActionExecutionContext } from "./runner/compiledPlanBinding.js";

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
      runtimeStatus = await startProject(configuredProject.id, { runId: id, attemptId: input.attemptId });
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

  let browserSession: Awaited<ReturnType<typeof createPlaywrightRuntimeSession>> | undefined; const executionEnvironment = createRunnerExecutionEnvironment({
    projectId: configuredProject?.id ?? targetRuntime.projectId ?? "ad_hoc_target", runtimeStatus, target: targetRuntime,
    launchBrowser: async () => (browserSession = await createPlaywrightRuntimeSession({ headless, signal: input.signal, onLifecycle: (event) => browserLifecycleEvents.push({ ...event, capturedAt: new Date().toISOString() }), contextOptions: { viewport: { width: 1280, height: 820 }, ...(recordVideo ? { recordVideo: { dir: path.join(reportsDir, "videos") } } : {}) } })),
    collectArtifacts: async () => readEvidence(id), teardown: async () => { if (browserSession) await browserSession.closeBrowser(); }
  });
  await executionEnvironment.prepare(); await executionEnvironment.launchTarget(); await executionEnvironment.launchBrowser();
  if (!browserSession) throw new Error("execution_environment_browser_missing");
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
    await executionEnvironment.teardown();
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
  const scenarioExecutor = createScenarioExecutor({
    input,
    page,
    scenario,
    compiledPlan,
    configuredProject,
    targetRuntime,
    projectLoginSecret,
    runDir,
    frontendUrl,
    artifactUrl,
    attemptClock,
    id,
    getActiveAttempt: () => activeAttempt,
    setActiveAttempt: (attempt) => { activeAttempt = attempt; },
    getCapturedScreenshotCount: () => capturedScreenshotCount,
    attemptIdentity,
    attempts,
    artifactsV2,
    budgetTracker,
    steps,
    network,
    consoleEvents,
    assertions,
    browserLifecycleEvents,
    appendEvidence,
    screenshot,
    captureStepPageObservation,
    recordAssertion,
    evaluateOracle,
    evaluateCompiledSmokePath,
    evaluateCompiledRegressionPath,
    isSmokeAnchorVisible,
    assertWithinRunBudget,
    recordBrowserLifecycle,
    startAttemptTrace,
    finishAttemptTrace
  });

  let executionError: NonNullable<VisualRunResult["executionError"]> | undefined;
  try {
    if (compiledPlan) {
      await scenarioExecutor.executeCompiledPlan();
      executionError = scenarioExecutor.getExecutionError();
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

    const corePassed = await scenarioExecutor.executeCorePath();
    const retryDecision = classifyRetry({ assertions: assertions.filter((assertion) => !assertion.passed), attempt: activeAttempt, maxAttempts: budgetTracker.budget.maxAttempts });
    if (!corePassed && scenario.corePath.action !== "simulate_error_and_retry" && retryDecision.retryable) {
      await scenarioExecutor.runFailureRetry();
    }
    await scenarioExecutor.runRegressionPath();
    }
  } catch (error) {
    executionError = classifyExecutionError(error, scenarioExecutor.getActiveCompiledStepId());
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
      await executionEnvironment.collectArtifacts().catch(() => undefined);
      await executionEnvironment.teardown();
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

  return finalizeVisualRun({
    input,
    reportsDir,
    runDir,
    artifactUrl,
    scenarioFingerprint,
    id,
    startedAt,
    frontendUrl,
    targetRuntime,
    configuredProject,
    runtimeStatus,
    scenario,
    compiledPlan,
    attemptClock,
    activeAttempt,
    attemptIdentity,
    attempts,
    artifactsV2,
    budgetTracker,
    evidenceWrites,
    appendEvidence,
    steps,
    network,
    consoleEvents,
    assertions,
    executionError
  });
}
