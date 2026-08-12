import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContextOptions } from "playwright";
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
  await managed.runtime.page.screenshot({ path: temporary, type: "jpeg", quality: 75, timeout: 5_000, animations: "disabled" });
  await rename(temporary, finalPath);
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
      viewport: { width: 1280, height: 820 },
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
    traceFinalized: false
  };
  sessions.set(input.runId, managed);
  bindTelemetry(managed);
  try {
    await managed.trace.start();
    await runtime.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await runtime.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
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
    await managed.runtime.page.screenshot({
      path: screenshotTemporary,
      type: "png",
      animations: "disabled",
      timeout: 5_000
    });
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
