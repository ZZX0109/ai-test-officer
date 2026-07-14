import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
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
  await input.page.screenshot({ path: temporaryPath, fullPage: true, type: "png" });
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
