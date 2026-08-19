import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions, CDPSession } from "playwright";
import {
  browserObservationSchema,
  browserSessionSchema,
  type BrowserObservation,
  type BrowserSession
} from "@ai-test-officer/contracts";
import {
  AttemptClock,
  PlaywrightAttemptTrace,
  commitCapturedFile,
  createPlaywrightRuntimeSession,
  type PlaywrightRuntimeSession
} from "@ai-test-officer/playwright-runtime";
import { observeBrowserPage } from "./pageObserver.js";
import {
  appendBrowserObservation,
  appendBrowserArtifact,
  browserSessionFramePath,
  publishBrowserAgentLifecycle,
  readBrowserSession,
  writeBrowserSession
} from "./store.js";
import { appendEvidence, getReportsDir } from "../evidenceStore.js";
import { decrypt, encrypt } from "../credentialStore.js";

type ManagedSession = {
  runtime: PlaywrightRuntimeSession;
  state: BrowserSession;
  requestedUrl: string;
  allowedOrigins: Set<string>;
  routes: Map<string, string>;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ method: string; url: string; status?: number; failure?: string }>;
  operation: Promise<unknown>;
  clock: AttemptClock;
  trace: PlaywrightAttemptTrace;
  traceFinalized: boolean;
  liveSubscribers: Set<(frame: Buffer) => void>;
  liveCdp?: CDPSession;
  liveCdpStarting?: Promise<void>;
  lastLiveFrame?: Buffer;
};

const sessions = new Map<string, ManagedSession>();

export function dynamicBrowserScenarioId(runId: string) {
  return `dynamic_browser_${runId.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function isoAfter(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function serialize<T>(managed: ManagedSession, operation: () => Promise<T>) {
  const pending = managed.operation.catch(() => undefined).then(operation);
  managed.operation = pending;
  return pending;
}

async function saveLiveFrame(managed: ManagedSession) {
  const finalPath = browserSessionFramePath(managed.state.runId);
  const temporary = `${finalPath}.${process.pid}.partial`;
  await mkdir(path.dirname(finalPath), { recursive: true });
  await capturePageImage(managed, temporary, "jpeg", 92);
  await rename(temporary, finalPath);
}

async function capturePageImage(managed: ManagedSession, outputPath: string, format: "png" | "jpeg", quality?: number) {
  try {
    await managed.runtime.page.screenshot({
      path: outputPath,
      type: format,
      ...(format === "jpeg" ? { quality } : {}),
      timeout: 5_000,
      animations: "disabled"
    });
    return;
  } catch (playwrightError) {
    // Playwright waits for web fonts before screenshotting. A broken font or
    // Vite dependency request can therefore time out even though Chromium has
    // already painted a useful frame. CDP captures that actual compositor
    // frame without converting an observability delay into a Graph failure.
    try {
      const cdp = await managed.runtime.context.newCDPSession(managed.runtime.page);
      const captured = await cdp.send("Page.captureScreenshot", {
        format,
        ...(format === "jpeg" ? { quality } : {}),
        fromSurface: true,
        captureBeyondViewport: false
      });
      await cdp.detach().catch(() => undefined);
      await writeFile(outputPath, Buffer.from(captured.data, "base64"));
    } catch {
      throw playwrightError;
    }
  }
}

async function startBrowserScreencast(managed: ManagedSession) {
  if (managed.liveCdp || managed.liveCdpStarting) return managed.liveCdpStarting;
  managed.liveCdpStarting = (async () => {
    const cdp = await managed.runtime.context.newCDPSession(managed.runtime.page);
    cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      const frame = Buffer.from(event.data, "base64");
      managed.lastLiveFrame = frame;
      for (const subscriber of managed.liveSubscribers) subscriber(frame);
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    await cdp.send("Page.startScreencast", {
      // Text-heavy application UIs visibly degrade when Chromium's JPEG frame
      // is scaled into the Workbench canvas. PNG preserves the compositor
      // pixels, while the length-prefixed stream protocol remains unchanged.
      format: "png",
      // The context renders at deviceScaleFactor=2. Do not cap the compositor
      // back to CSS-pixel dimensions or Chromium will downsample before the
      // lossless canvas scaling stage in Workbench.
      maxWidth: 3840,
      maxHeight: 2160,
      everyNthFrame: 1
    });
    managed.liveCdp = cdp;
  })().finally(() => {
    managed.liveCdpStarting = undefined;
  });
  return managed.liveCdpStarting;
}

async function stopBrowserScreencast(managed: ManagedSession) {
  const cdp = managed.liveCdp;
  managed.liveCdp = undefined;
  if (!cdp) return;
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await cdp.detach().catch(() => undefined);
}

/** Subscribe to Chromium's compositor stream for the Workbench canvas. These
 * transient frames are never registered as Artifacts and cannot satisfy a
 * Gate; formal before/after screenshots continue through the evidence path. */
export async function subscribeBrowserLiveFrames(runId: string, subscriber: (frame: Buffer) => void) {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  managed.liveSubscribers.add(subscriber);
  if (managed.lastLiveFrame) subscriber(managed.lastLiveFrame);
  try {
    await startBrowserScreencast(managed);
  } catch (error) {
    managed.liveSubscribers.delete(subscriber);
    throw error;
  }
  return async () => {
    managed.liveSubscribers.delete(subscriber);
    if (!managed.liveSubscribers.size) await stopBrowserScreencast(managed);
  };
}

function encryptedStorageStatePath(runId: string) {
  return path.join(getReportsDir(), "runs", runId, "browser-agent", "storage-state.enc");
}

async function saveEncryptedStorageState(managed: ManagedSession) {
  const file = encryptedStorageStatePath(managed.state.runId);
  await mkdir(path.dirname(file), { recursive: true });
  const state = await managed.runtime.context.storageState();
  await writeFile(file, await encrypt(JSON.stringify(state)), { mode: 0o600 });
}

async function readEncryptedStorageState(runId: string): Promise<BrowserContextOptions["storageState"] | undefined> {
  try {
    const value = JSON.parse(await decrypt(await readFile(encryptedStorageStatePath(runId), "utf8"))) as BrowserContextOptions["storageState"];
    return value;
  } catch {
    return undefined;
  }
}

function bindTelemetry(managed: ManagedSession) {
  const page = managed.runtime.page;
  page.on("console", (event) => {
    if (event.type() === "error") managed.consoleErrors.push(event.text().slice(0, 1_000));
    if (managed.consoleErrors.length > 100) managed.consoleErrors.shift();
  });
  page.on("pageerror", (error) => {
    managed.pageErrors.push(error.message.slice(0, 1_000));
    if (managed.pageErrors.length > 100) managed.pageErrors.shift();
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    managed.failedRequests.push({ method: response.request().method(), url: response.url(), status: response.status() });
    if (managed.failedRequests.length > 200) managed.failedRequests.shift();
  });
  page.on("requestfailed", (request) => {
    managed.failedRequests.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText });
    if (managed.failedRequests.length > 200) managed.failedRequests.shift();
  });
}

/** Wait until the framework has painted an observable page.  Navigation
 * readiness alone is not enough for SPA login redirects: the HTML shell can
 * be committed while React is still mounting the authenticated screen. */
export async function waitForObservableDocument(runtime: PlaywrightRuntimeSession) {
  // `domcontentloaded` only proves that the HTML shell exists. React/Vue/Next
  // applications commonly mount their first useful controls afterwards. If
  // the first Agent observation is taken in that gap, the LLM sees an empty
  // page and can incorrectly block an otherwise healthy run.
  // This is an IIFE string on purpose. Passing the textual arrow function
  // itself makes Playwright evaluate the function object (truthy) instead of
  // invoking it, so the wait would finish immediately on an empty SPA shell.
  await runtime.page.waitForFunction(`(() => {
    const body = document.body;
    if (!body || document.readyState === "loading") return false;
    const interactive = body.querySelector(
      "a,button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[role=combobox],[role=tab],[data-testid],canvas,iframe"
    );
    // textContent includes inline script source and can make an empty SPA
    // shell appear meaningful. innerText only represents rendered text.
    const text = (body.innerText || "").replace(/\\s+/g, "").trim();
    // Script/style/root shell nodes are implementation scaffolding, not an
    // observable application. Counting body children made an empty Vite or
    // Next shell look ready before the framework mounted its first screen.
    return Boolean(interactive) || text.length > 0;
  })()`, undefined, { timeout: 10_000 }).catch(() => undefined);
  await runtime.page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => undefined);
  // Give the framework one paint after the observable state is reached so
  // the DOM model and the screenshot describe the same page generation.
  await runtime.page.waitForTimeout(100);
}

export async function ensureBrowserAgentSession(input: {
  runId: string;
  attemptId: string;
  projectId?: string;
  url: string;
  allowedOrigins?: string[];
  routes?: Array<{ id: string; path: string }>;
  storageState?: BrowserContextOptions["storageState"];
  headless?: boolean;
}) {
  const current = sessions.get(input.runId);
  if (current) {
    if (current.state.attemptId !== input.attemptId) throw new Error("browser_session_cross_attempt_reuse");
    return current.state;
  }
  const target = new URL(input.url);
  const previous = await readBrowserSession(input.runId);
  const recoveredStorageState = input.storageState ?? await readEncryptedStorageState(input.runId);
  const runtime = await createPlaywrightRuntimeSession({
    headless: input.headless ?? true,
    contextOptions: {
      // Keep a desktop-sized compositor surface so the shared Workbench canvas
      // remains crisp on Retina/high-DPI displays. Matching the common 2x
      // device scale is essential: otherwise a CSS-pixel frame is enlarged by
      // the Workbench's 2x canvas and becomes visibly soft as soon as testing
      // switches from the local iframe to the authoritative Playwright view.
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      ...(recoveredStorageState ? { storageState: recoveredStorageState } : {})
    }
  });
  const now = new Date().toISOString();
  const state = browserSessionSchema.parse({
    schemaVersion: "1.0",
    sessionId: `browser_session_${randomUUID()}`,
    runId: input.runId,
    attemptId: input.attemptId,
    projectId: input.projectId,
    status: "starting",
    owner: "agent",
    actionCount: 0,
    decisionCount: 0,
    rebindCount: 0,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    leaseExpiresAt: isoAfter(30_000)
  });
  const managed: ManagedSession = {
    runtime,
    state,
    requestedUrl: input.url,
    allowedOrigins: new Set([target.origin, ...(input.allowedOrigins ?? [])]),
    routes: new Map((input.routes ?? []).map((route) => [route.id, route.path])),
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    operation: Promise.resolve(),
    clock: new AttemptClock(),
    trace: new PlaywrightAttemptTrace(runtime.context),
    traceFinalized: false,
    liveSubscribers: new Set()
  };
  sessions.set(input.runId, managed);
  bindTelemetry(managed);
  try {
    await managed.trace.start();
    let navigationError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runtime.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        navigationError = undefined;
        break;
      } catch (error) {
        navigationError = error;
        // Vite/large apps can commit a usable document while a dependency
        // request keeps Playwright's navigation promise open. Preserve that
        // observable page instead of terminating the Graph on a clock edge.
        const committed = await runtime.page.evaluate(() => ({
          readyState: document.readyState,
          hasDocument: Boolean(document.documentElement),
          hasHeadOrBody: Boolean(document.head || document.body)
        })).then((value) => value.hasDocument && value.hasHeadOrBody && value.readyState !== "loading").catch(() => false);
        if (committed) {
          navigationError = undefined;
          break;
        }
        if (attempt === 0) await runtime.page.waitForTimeout(350);
      }
    }
    if (navigationError) throw navigationError;
    await waitForObservableDocument(runtime);
    managed.state = browserSessionSchema.parse({ ...managed.state, status: "ready", currentUrl: runtime.page.url(), updatedAt: new Date().toISOString() });
    await writeBrowserSession(managed.state);
    await saveLiveFrame(managed).catch(() => undefined);
    await saveEncryptedStorageState(managed).catch(() => undefined);
    publishBrowserAgentLifecycle({ runId: input.runId, type: previous ? "browser.session.recovered" : "browser.session.started", payload: managed.state });
    return managed.state;
  } catch (error) {
    managed.state = browserSessionSchema.parse({ ...managed.state, status: "failed", currentUrl: runtime.page.url() || undefined, updatedAt: new Date().toISOString() });
    await writeBrowserSession(managed.state);
    await runtime.close();
    sessions.delete(input.runId);
    throw error;
  }
}

export async function commitBrowserAgentArtifact(input: {
  runId: string;
  filePath: string;
  id: string;
  stepId?: string;
  kind: "screenshot" | "dom" | "trace" | "operation-log";
  mediaType: string;
}) {
  const managed = sessions.get(input.runId);
  if (!managed) throw new Error("browser_session_not_active");
  const artifact = await commitCapturedFile({
    temporaryPath: input.filePath,
    finalPath: input.filePath,
    id: input.id,
    identity: {
      runId: managed.state.runId,
      scenarioId: dynamicBrowserScenarioId(managed.state.runId),
      attemptId: managed.state.attemptId,
      attempt: 1
    },
    stepId: input.stepId,
    kind: input.kind,
    mediaType: input.mediaType,
    storageUri: `/artifacts/runs/${input.runId}/browser-agent/${path.relative(path.join(getReportsDirForSession(), "runs", input.runId, "browser-agent"), input.filePath)}`,
    clock: managed.clock,
    collectorVersion: "0.3.0"
  });
  return appendBrowserArtifact(artifact);
}

function getReportsDirForSession() {
  return getReportsDir();
}

export async function finalizeBrowserAgentTrace(runId: string) {
  const managed = sessions.get(runId);
  if (!managed || managed.traceFinalized) return;
  const finalPath = path.join(getReportsDirForSession(), "runs", runId, "browser-agent", "attempt.trace.zip");
  await managed.trace.stop(finalPath);
  managed.traceFinalized = true;
  return commitBrowserAgentArtifact({ runId, filePath: finalPath, id: `${runId}_dynamic_trace`, kind: "trace", mediaType: "application/zip" });
}

export function getManagedBrowserSession(runId: string) {
  return sessions.get(runId);
}

export async function observeManagedBrowserSession(input: { runId: string; coverageItemId?: string; evidenceRefs?: string[] }): Promise<BrowserObservation> {
  const managed = sessions.get(input.runId);
  if (!managed) throw new Error("browser_session_not_active");
  return serialize(managed, async () => {
    const observed = await observeBrowserPage({
      page: managed.runtime.page,
      runId: managed.state.runId,
      attemptId: managed.state.attemptId,
      coverageItemId: input.coverageItemId,
      requestedUrl: managed.requestedUrl,
      telemetry: {
        consoleErrors: managed.consoleErrors,
        pageErrors: managed.pageErrors,
        failedRequests: managed.failedRequests
      },
      evidenceRefs: input.evidenceRefs
    });
    // A page observation is a first-class execution step, not merely an LLM
    // prompt.  Persist its screenshot and DOM even if the model later fails or
    // asks for credentials, so the blocked conclusion remains independently
    // auditable.
    const observationDirectory = path.join(getReportsDirForSession(), "runs", input.runId, "browser-agent", "observations");
    await mkdir(observationDirectory, { recursive: true });
    const screenshotPath = path.join(observationDirectory, `${observed.observationId}.png`);
    const screenshotTemporary = `${screenshotPath}.${process.pid}.partial`;
    await capturePageImage(managed, screenshotTemporary, "png");
    await rename(screenshotTemporary, screenshotPath);
    const screenshotArtifact = await commitBrowserAgentArtifact({
      runId: input.runId,
      filePath: screenshotPath,
      id: `${input.runId}_${observed.observationId}_screenshot`,
      stepId: observed.observationId,
      kind: "screenshot",
      mediaType: "image/png"
    });
    const domPath = path.join(observationDirectory, `${observed.observationId}.json`);
    await writeFile(domPath, JSON.stringify(observed, null, 2));
    const domArtifact = await commitBrowserAgentArtifact({
      runId: input.runId,
      filePath: domPath,
      id: `${input.runId}_${observed.observationId}_dom`,
      stepId: observed.observationId,
      kind: "dom",
      mediaType: "application/json"
    });
    const screenshotEvidence = await appendEvidence(input.runId, {
      type: "screenshot",
      title: "Dynamic browser page observation",
      scenarioId: dynamicBrowserScenarioId(input.runId),
      attemptId: managed.state.attemptId,
      pathId: input.coverageItemId,
      stepId: observed.observationId,
      url: observed.finalUrl,
      file: screenshotArtifact.storageUri,
      artifactIds: [screenshotArtifact.id],
      locator: {
        pageUrl: observed.finalUrl,
        viewport: managed.runtime.page.viewportSize() ?? undefined
      },
      payload: { observationId: observed.observationId, pageFingerprint: observed.pageFingerprint }
    });
    const domEvidence = await appendEvidence(input.runId, {
      type: "dom",
      title: "Dynamic browser DOM observation",
      scenarioId: dynamicBrowserScenarioId(input.runId),
      attemptId: managed.state.attemptId,
      pathId: input.coverageItemId,
      stepId: observed.observationId,
      url: observed.finalUrl,
      file: domArtifact.storageUri,
      artifactIds: [domArtifact.id],
      locator: {
        pageUrl: observed.finalUrl,
        selector: "body",
        snapshotSha256: observed.pageFingerprint
      },
      payload: {
        observationId: observed.observationId,
        title: observed.title,
        readyState: observed.readyState,
        controlCount: observed.controls.length,
        consoleErrors: observed.consoleErrors,
        pageErrors: observed.pageErrors,
        failedRequests: observed.failedRequests
      }
    });
    const observation = browserObservationSchema.parse({
      ...observed,
      screenshotArtifactId: screenshotArtifact.id,
      evidenceRefs: Array.from(new Set([
        ...(input.evidenceRefs ?? []),
        screenshotEvidence.id,
        domEvidence.id
      ]))
    });
    await appendBrowserObservation(observation);
    await saveLiveFrame(managed).catch(() => undefined);
    managed.state = browserSessionSchema.parse({
      ...managed.state,
      status: managed.state.owner === "waiting-user" ? "waiting-user" : "ready",
      currentUrl: observation.finalUrl,
      lastObservationId: observation.observationId,
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: isoAfter(30_000)
    });
    await writeBrowserSession(managed.state);
    await saveEncryptedStorageState(managed).catch(() => undefined);
    return observation;
  });
}

export async function updateManagedBrowserSession(runId: string, update: Partial<Pick<BrowserSession, "status" | "owner" | "actionCount" | "decisionCount" | "rebindCount">>) {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  managed.state = browserSessionSchema.parse({ ...managed.state, ...update, currentUrl: managed.runtime.page.url(), updatedAt: new Date().toISOString(), leaseExpiresAt: isoAfter(30_000) });
  await writeBrowserSession(managed.state);
  return managed.state;
}

/** Keep the Playwright CSS viewport aligned with the Workbench surface.
 *
 * Before this is called the project preview is a responsive iframe, while the
 * live Agent session historically used a fixed 1920x1080 viewport. Drawing
 * that fixed desktop onto a smaller Workbench canvas made the entire tested
 * application appear to shrink as soon as a Run started. Viewport changes are
 * serialized with browser actions so a resize can never race a click or an
 * observation.
 */
export async function resizeManagedBrowserViewport(runId: string, viewport: { width: number; height: number }) {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  const width = Math.max(640, Math.min(1920, Math.round(viewport.width)));
  const height = Math.max(480, Math.min(1080, Math.round(viewport.height)));
  return serialize(managed, async () => {
    const current = managed.runtime.page.viewportSize();
    if (!current || Math.abs(current.width - width) > 8 || Math.abs(current.height - height) > 8) {
      await managed.runtime.page.setViewportSize({ width, height });
      await managed.runtime.page.waitForTimeout(50);
    }
    managed.state = browserSessionSchema.parse({
      ...managed.state,
      currentUrl: managed.runtime.page.url(),
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: isoAfter(30_000)
    });
    await writeBrowserSession(managed.state);
    return managed.state;
  });
}

/** Reload the current managed page after a transient browser/network fault.
 * This stays inside the same BrowserContext so cookies and encrypted
 * storageState survive, while stale request errors do not poison the next
 * observation. */
export async function reloadManagedBrowserSession(runId: string) {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  return serialize(managed, async () => {
    managed.consoleErrors.length = 0;
    managed.pageErrors.length = 0;
    managed.failedRequests.length = 0;
    await managed.runtime.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForObservableDocument(managed.runtime);
    managed.state = browserSessionSchema.parse({
      ...managed.state,
      status: "ready",
      currentUrl: managed.runtime.page.url(),
      rebindCount: managed.state.rebindCount + 1,
      updatedAt: new Date().toISOString(),
      leaseExpiresAt: isoAfter(30_000)
    });
    await writeBrowserSession(managed.state);
    await saveLiveFrame(managed).catch(() => undefined);
    return managed.state;
  });
}

export async function acquireBrowserControl(runId: string, owner: "agent" | "user", options: { force?: boolean } = {}) {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  if (!options.force && managed.state.owner !== owner && managed.state.leaseExpiresAt && Date.parse(managed.state.leaseExpiresAt) > Date.now() && managed.state.owner !== "waiting-user") {
    throw new Error(`browser_control_owned_by_${managed.state.owner}`);
  }
  const session = await updateManagedBrowserSession(runId, { owner, status: owner === "user" ? "waiting-user" : "ready" });
  publishBrowserAgentLifecycle({ runId, type: "browser.control.changed", payload: { owner, reason: options.force ? "explicit_user_takeover" : "lease_acquired" } });
  return session;
}

/**
 * An explicit user takeover is a pause in the browser action loop, not a test
 * failure. The Agent waits for the operator to click "交还 AI" and then
 * continues the exact pending action in the same BrowserContext. Keeping this
 * wait here also closes the race where authorization completed immediately
 * before the operator acquired the lease.
 */
export async function acquireBrowserControlWhenAvailable(
  runId: string,
  owner: "agent",
  options: { timeoutMs?: number; pollMs?: number } = {}
) {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (true) {
    const managed = sessions.get(runId);
    if (!managed) throw new Error("browser_session_not_active");
    // A user takeover is explicit and must end explicitly. Do not use the
    // short Agent lease expiry to steal control back while the operator is
    // still completing a login, consent screen or manual inspection.
    if (managed.state.owner === "user") {
      if (!announced) {
        announced = true;
        publishBrowserAgentLifecycle({
          runId,
          type: "browser.control.changed",
          payload: { owner: "user", reason: "agent_waiting_for_user_release" }
        });
      }
      if (Date.now() >= deadline) throw new Error("browser_control_wait_timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      return await acquireBrowserControl(runId, owner);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "browser_control_owned_by_user") throw error;
      if (!announced) {
        announced = true;
        publishBrowserAgentLifecycle({
          runId,
          type: "browser.control.changed",
          payload: { owner: "user", reason: "agent_waiting_for_user_release" }
        });
      }
      if (Date.now() >= deadline) throw new Error("browser_control_wait_timeout");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

export async function releaseBrowserControl(runId: string, owner: "agent" | "user") {
  const managed = sessions.get(runId);
  if (!managed) throw new Error("browser_session_not_active");
  if (managed.state.owner !== owner) throw new Error("browser_control_release_owner_mismatch");
  const nextOwner = owner === "user" ? "agent" : "waiting-user";
  const session = await updateManagedBrowserSession(runId, { owner: nextOwner, status: owner === "user" ? "ready" : "waiting-user" });
  publishBrowserAgentLifecycle({ runId, type: "browser.control.changed", payload: { owner: nextOwner, reason: "lease_released" } });
  return session;
}

export async function executeUserBrowserInput(input: {
  runId: string;
  kind: "click" | "type" | "press" | "scroll";
  x?: number;
  y?: number;
  text?: string;
  key?: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space";
  deltaY?: number;
}) {
  const managed = sessions.get(input.runId);
  if (!managed) throw new Error("browser_session_not_active");
  if (managed.state.owner !== "user") throw new Error("browser_control_not_owned_by_user");
  await serialize(managed, async () => {
    if (input.kind === "click") {
      if (typeof input.x !== "number" || typeof input.y !== "number") throw new Error("browser_input_coordinates_required");
      await managed.runtime.page.mouse.click(input.x, input.y);
    } else if (input.kind === "type") {
      if (typeof input.text !== "string") throw new Error("browser_input_text_required");
      await managed.runtime.page.keyboard.type(input.text);
    } else if (input.kind === "press") {
      if (!input.key) throw new Error("browser_input_key_required");
      await managed.runtime.page.keyboard.press(input.key);
    } else {
      await managed.runtime.page.mouse.wheel(0, input.deltaY ?? 500);
    }
    await managed.runtime.page.waitForTimeout(200);
    await saveEncryptedStorageState(managed).catch(() => undefined);
  });
  return observeManagedBrowserSession({ runId: input.runId });
}

export async function closeBrowserAgentSession(runId: string) {
  const managed = sessions.get(runId);
  if (!managed) return readBrowserSession(runId);
  await stopBrowserScreencast(managed).catch(() => undefined);
  await finalizeBrowserAgentTrace(runId).catch(() => undefined);
  await saveEncryptedStorageState(managed).catch(() => undefined);
  await managed.runtime.close();
  sessions.delete(runId);
  managed.state = browserSessionSchema.parse({ ...managed.state, status: "closed", updatedAt: new Date().toISOString(), leaseExpiresAt: undefined });
  await writeBrowserSession(managed.state);
  publishBrowserAgentLifecycle({ runId, type: "browser.session.closed", payload: managed.state });
  return managed.state;
}

export async function closeAllBrowserAgentSessions() {
  await Promise.allSettled([...sessions.keys()].map((runId) => closeBrowserAgentSession(runId)));
}

// Terminate every live browser context bound to a project. Called when the
// project runtime itself is stopped: the project process is gone, so any
// Playwright session still pointing at it is residue and must be closed
// (otherwise it leaks until its lease expires against a dead origin).
export async function closeBrowserSessionsForProject(projectId: string) {
  const runIds = [...sessions.entries()]
    .filter(([, managed]) => managed.state.projectId === projectId)
    .map(([runId]) => runId);
  await Promise.allSettled(runIds.map((runId) => closeBrowserAgentSession(runId)));
}
