import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type LaunchOptions,
  type Page
} from "playwright";
import { artifactV2Schema, type ArtifactOrigin, type ArtifactV2 } from "@ai-test-officer/contracts";

export interface AttemptIdentity {
  runId: string;
  scenarioId: string;
  attemptId: string;
  attempt: number;
}

export class AttemptClock {
  private readonly wallStart = Date.now();
  private readonly monotonicStart = performance.now();
  private sequence = 0;

  next() {
    this.sequence += 1;
    return {
      sequence: this.sequence,
      capturedAt: new Date(this.wallStart + (performance.now() - this.monotonicStart)).toISOString(),
      monotonicOffsetMs: Math.max(0, performance.now() - this.monotonicStart)
    };
  }
}

async function sha256File(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function commitCapturedFile(input: {
  temporaryPath: string;
  finalPath: string;
  id: string;
  identity: AttemptIdentity;
  stepId?: string;
  kind: ArtifactV2["kind"];
  origin?: ArtifactOrigin;
  mediaType: string;
  storageUri: string;
  clock: AttemptClock;
  collectorVersion: string;
  fixtureManifestSha256?: string;
}) {
  await mkdir(path.dirname(input.finalPath), { recursive: true });
  if (path.resolve(input.temporaryPath) !== path.resolve(input.finalPath)) await rename(input.temporaryPath, input.finalPath);
  const fileStat = await stat(input.finalPath);
  const timestamp = input.clock.next();
  return artifactV2Schema.parse({
    schemaVersion: "2.0",
    id: input.id,
    ...input.identity,
    stepId: input.stepId,
    kind: input.kind,
    origin: input.origin ?? "runtime-captured",
    storageUri: input.storageUri,
    sequence: timestamp.sequence,
    monotonicOffsetMs: timestamp.monotonicOffsetMs,
    fixtureManifestSha256: input.fixtureManifestSha256,
    integrity: {
      sha256: await sha256File(input.finalPath),
      sizeBytes: fileStat.size,
      mediaType: input.mediaType,
      capturedAt: timestamp.capturedAt,
      collector: { name: "@ai-test-officer/playwright-runtime", version: input.collectorVersion }
    }
  });
}

export async function captureScreenshotAtomic(input: {
  page: Page;
  finalPath: string;
  id: string;
  identity: AttemptIdentity;
  stepId: string;
  storageUri: string;
  clock: AttemptClock;
  collectorVersion?: string;
}) {
  const temporaryPath = `${input.finalPath}.partial`;
  await mkdir(path.dirname(temporaryPath), { recursive: true });
  // Font loading can remain pending forever on a broken/partially loaded SPA.
  // Keep screenshots bounded so evidence collection cannot block the actual
  // action executor; callers record a degraded evidence item on timeout.
  await input.page.screenshot({ path: temporaryPath, fullPage: true, type: "png", timeout: 5_000, animations: "disabled" });
  return commitCapturedFile({
    ...input,
    temporaryPath,
    kind: "screenshot",
    mediaType: "image/png",
    collectorVersion: input.collectorVersion ?? "0.2.0"
  });
}

export class PlaywrightAttemptTrace {
  private started = false;
  constructor(private readonly context: BrowserContext) {}

  async start() {
    if (this.started) throw new Error("Attempt trace already started");
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.started = true;
  }

  async stop(temporaryPath: string) {
    if (!this.started) throw new Error("Attempt trace was not started");
    await mkdir(path.dirname(temporaryPath), { recursive: true });
    await this.context.tracing.stop({ path: temporaryPath });
    this.started = false;
  }
}

export interface PlaywrightRuntimeSessionOptions {
  headless: boolean;
  contextOptions?: BrowserContextOptions;
  signal?: AbortSignal;
  launcher?: Pick<BrowserType, "launch">;
  launchOptions?: Omit<LaunchOptions, "headless">;
  onLifecycle?: (event: {
    type: "browser_launch" | "context_create" | "page_new";
    status: "started" | "succeeded" | "failed";
    error?: string;
  }) => void;
}

export async function isPlaywrightChromiumInstalled() {
  try {
    await access(chromium.executablePath());
    return true;
  } catch {
    return false;
  }
}

/**
 * Development machines do not always run `playwright install` after a clean
 * checkout. Keep the browser dependency explicit and self-healing for local
 * execution, while leaving CI free to install it in its normal setup step.
 */
export async function ensurePlaywrightChromium() {
  if (await isPlaywrightChromiumInstalled()) return { installed: true, downloaded: false };
  const npmCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["playwright", "install", "chromium"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright_browser_install_failed:${code ?? signal ?? "unknown"}`));
    });
  });
  if (!(await isPlaywrightChromiumInstalled())) {
    throw new Error("playwright_browser_install_incomplete");
  }
  return { installed: true, downloaded: true };
}

type LaunchStage = "browser_launch" | "context_create" | "page_new";
type LaunchStatus = "started" | "succeeded" | "failed";
type LifecycleSink = PlaywrightRuntimeSessionOptions["onLifecycle"];

/**
 * Abort checkpoint between launch stages.
 *
 * Extracted so `create` reads as a linear sequence of stages instead of
 * interleaving cancellation branches with resource acquisition.
 */
function assertLaunchNotAborted(signal: AbortSignal | undefined, phase: string) {
  if (signal?.aborted) throw new Error(`playwright_runtime_cancelled_${phase}`);
}

/** Curries the optional lifecycle sink so each stage emit is a single call. */
function launchStageEmitter(sink: LifecycleSink) {
  return (type: LaunchStage, status: LaunchStatus, error?: string) => {
    sink?.({ type, status, ...(error ? { error } : {}) });
  };
}

/** First stage that never produced a handle is the one that actually failed. */
function failedLaunchStage(browser?: Browser, context?: BrowserContext): LaunchStage {
  if (!browser) return "browser_launch";
  if (!context) return "context_create";
  return "page_new";
}

function launchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the complete Playwright lifecycle for one execution attempt.
 *
 * The session is intentionally idempotent: cancellation, an executor finally
 * block and shutdown recovery may all race to close the same resources.
 */
export class PlaywrightRuntimeSession {
  private contextClosed = false;
  private browserClosed = false;
  private abortListener?: () => void;
  private readonly signal?: AbortSignal;

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    signal?: AbortSignal
  ) {
    this.signal = signal;
    if (signal) {
      this.abortListener = () => {
        void this.close();
      };
      signal.addEventListener("abort", this.abortListener, { once: true });
    }
  }

  static async create(options: PlaywrightRuntimeSessionOptions) {
    assertLaunchNotAborted(options.signal, "before_launch");
    const launcher = options.launcher ?? chromium;
    const emit = launchStageEmitter(options.onLifecycle);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      if (!options.launcher) await ensurePlaywrightChromium();
      emit("browser_launch", "started");
      browser = await launcher.launch({ ...options.launchOptions, headless: options.headless });
      emit("browser_launch", "succeeded");
      assertLaunchNotAborted(options.signal, "after_launch");
      emit("context_create", "started");
      context = await browser.newContext(options.contextOptions);
      emit("context_create", "succeeded");
      assertLaunchNotAborted(options.signal, "after_context");
      emit("page_new", "started");
      const page = await context.newPage();
      emit("page_new", "succeeded");
      return new PlaywrightRuntimeSession(browser, context, page, options.signal);
    } catch (error) {
      emit(failedLaunchStage(browser, context), "failed", launchErrorMessage(error));
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      throw error;
    }
  }

  async closeContext() {
    if (this.contextClosed) return;
    this.contextClosed = true;
    await this.context.close().catch(() => undefined);
  }

  async closeBrowser() {
    if (this.browserClosed) return;
    this.browserClosed = true;
    await this.browser.close().catch(() => undefined);
  }

  async close() {
    await this.closeContext();
    await this.closeBrowser();
    if (this.abortListener && this.signal) {
      // AbortSignal permits removal after dispatch; doing so also prevents the
      // session retaining the caller's signal for its full process lifetime.
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = undefined;
    }
  }
}

export function createPlaywrightRuntimeSession(options: PlaywrightRuntimeSessionOptions) {
  return PlaywrightRuntimeSession.create(options);
}

export function bindAttemptTelemetry(input: {
  context: BrowserContext;
  clock: AttemptClock;
  onEvent: (event: { type: "page" | "dialog" | "download"; sequence: number; capturedAt: string; monotonicOffsetMs: number; payload: Record<string, unknown> }) => void;
}) {
  const bindPage = (page: Page) => {
    const stamp = input.clock.next();
    input.onEvent({ type: "page", ...stamp, payload: { url: page.url() } });
    page.on("dialog", (dialog) => input.onEvent({ type: "dialog", ...input.clock.next(), payload: { type: dialog.type(), message: dialog.message() } }));
    page.on("download", (download) => input.onEvent({ type: "download", ...input.clock.next(), payload: { suggestedFilename: download.suggestedFilename() } }));
  };
  input.context.pages().forEach(bindPage);
  input.context.on("page", bindPage);
  return () => input.context.off("page", bindPage);
}
