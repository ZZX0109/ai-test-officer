import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page
} from "playwright";
import {
  AttemptClock,
  bindAttemptTelemetry,
  createPlaywrightRuntimeSession,
  PlaywrightAttemptTrace
} from "../src/index.js";

const clock = new AttemptClock();
const first = clock.next();
const second = clock.next();
assert.equal(first.sequence, 1);
assert.equal(second.sequence, 2);
assert.ok(second.monotonicOffsetMs >= first.monotonicOffsetMs);

const server = createServer((request, response) => {
  if (request.url === "/frame") { response.end("<button id='inside'>Frame action</button>"); return; }
  if (request.url === "/download") { response.setHeader("content-disposition", "attachment; filename=evidence.txt"); response.end("evidence"); return; }
  if (request.url === "/popup") { response.end("<h1>Popup</h1>"); return; }
  response.end(`<!doctype html><input type="file" id="upload"><iframe src="/frame"></iframe><a id="popup" target="_blank" href="/popup">Popup</a><a id="download" href="/download">Download</a><button id="dialog" onclick="alert('approved dialog')">Dialog</button>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server missing address");
const directory = await mkdtemp(path.join(tmpdir(), "ato-playwright-"));
try {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const events: string[] = [];
  const unbind = bindAttemptTelemetry({ context, clock: new AttemptClock(), onEvent: (event) => events.push(event.type) });
  const trace = new PlaywrightAttemptTrace(context);
  await trace.start();
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.frameLocator("iframe").locator("#inside").click();
  const upload = path.join(directory, "upload.txt"); await writeFile(upload, "fixture");
  await page.locator("#upload").setInputFiles(upload);
  const popupPromise = page.waitForEvent("popup"); await page.locator("#popup").click(); await (await popupPromise).waitForLoadState();
  const downloadPromise = page.waitForEvent("download"); await page.locator("#download").click(); await (await downloadPromise).saveAs(path.join(directory, "evidence.txt"));
  await page.locator("#dialog").click();
  await context.setOffline(true);
  await assert.rejects(() => page.evaluate(() => fetch("/offline-check")));
  await context.setOffline(false);
  const tracePath = path.join(directory, "attempt.trace.zip"); await trace.stop(tracePath);
  assert.ok((await stat(tracePath)).size > 0);
  assert.ok(events.includes("page") && events.includes("download") && events.includes("dialog"));
  unbind(); await context.close(); await browser.close();
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}

{
  let contextCloseCount = 0;
  let browserCloseCount = 0;
  const page = {} as Page;
  const context = {
    newPage: async () => page,
    close: async () => { contextCloseCount += 1; }
  } as unknown as BrowserContext;
  const browser = {
    newContext: async () => context,
    close: async () => { browserCloseCount += 1; }
  } as unknown as Browser;
  const launcher = {
    launch: async () => browser
  } as unknown as Pick<BrowserType, "launch">;
  const session = await createPlaywrightRuntimeSession({ headless: true, launcher });
  await Promise.all([session.close(), session.close(), session.closeContext()]);
  assert.equal(contextCloseCount, 1);
  assert.equal(browserCloseCount, 1);
}

{
  let contextCloseCount = 0;
  let browserCloseCount = 0;
  const context = {
    newPage: async () => { throw new Error("page_start_failed"); },
    close: async () => { contextCloseCount += 1; }
  } as unknown as BrowserContext;
  const browser = {
    newContext: async () => context,
    close: async () => { browserCloseCount += 1; }
  } as unknown as Browser;
  const launcher = {
    launch: async () => browser
  } as unknown as Pick<BrowserType, "launch">;
  await assert.rejects(
    () => createPlaywrightRuntimeSession({ headless: true, launcher }),
    /page_start_failed/
  );
  assert.equal(contextCloseCount, 1);
  assert.equal(browserCloseCount, 1);
}

{
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => createPlaywrightRuntimeSession({ headless: true, signal: controller.signal }),
    /cancelled_before_launch/
  );
}
console.log("playwright runtime tests passed");
