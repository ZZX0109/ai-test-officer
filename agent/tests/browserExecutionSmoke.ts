import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ensurePlaywrightChromium } from "@ai-test-officer/playwright-runtime";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const targetUrl = process.env.APP_URL ?? "http://127.0.0.1:6173";
const runId = `browser-smoke-${Date.now()}`;
const reportDir = path.join(rootDir, "reports", "browser-smoke", runId);

type BrowserSmokeReport = {
  runId: string;
  targetUrl: string;
  lifecycle: string[];
  navigation: { status?: number; finalUrl: string; title: string; readyState: string; durationMs: number };
  controls: Array<{ role: string; name: string; visible: boolean; disabled: boolean }>;
  auth: { loginControlsPresent: boolean; authenticatedMarkerPresent: boolean };
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; error?: string }>;
  screenshot: string;
};

await mkdir(reportDir, { recursive: true });
await ensurePlaywrightChromium();
const lifecycle: string[] = ["browser_launch:started"];
const browser = await chromium.launch({ headless: true });
lifecycle.push("browser_launch:succeeded");
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
lifecycle.push("context_create:succeeded");
const page = await context.newPage();
lifecycle.push("page_new:succeeded");
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const failedRequests: Array<{ url: string; error?: string }> = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
const started = Date.now();
try {
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  lifecycle.push("page_goto:succeeded");
  const controls = await page.locator("button,input,a,select,textarea").evaluateAll((elements) => elements.map((element) => {
    const html = element as HTMLElement;
    const style = getComputedStyle(html);
    const visible = style.display !== "none" && style.visibility !== "hidden" && Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
    const name = element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.textContent?.replace(/\s+/g, " ").trim() || "";
    return { role: element.getAttribute("role") || element.tagName.toLowerCase(), name: name.slice(0, 200), visible, disabled: (element as HTMLButtonElement).disabled === true };
  }));
  const bodyText = await page.locator("body").innerText();
  const loginControlsPresent = /email|e-mail|password|sign in|log in|登录|密码/i.test(`${bodyText} ${controls.map((item) => item.name).join(" ")}`);
  const authenticatedMarkerPresent = /已登录|authenticated|sign out|退出登录|logout/i.test(bodyText);
  const screenshotPath = path.join(reportDir, "page.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const report: BrowserSmokeReport = {
    runId,
    targetUrl,
    lifecycle,
    navigation: { status: response?.status(), finalUrl: page.url(), title: await page.title(), readyState: await page.evaluate(() => document.readyState), durationMs: Date.now() - started },
    controls: controls.slice(0, 80),
    auth: { loginControlsPresent, authenticatedMarkerPresent },
    consoleErrors,
    pageErrors,
    failedRequests,
    screenshot: screenshotPath
  };
  await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(response?.ok(), true, `target returned HTTP ${response?.status()}`);
  assert.notEqual(report.navigation.readyState, "loading", "document never became ready");
  assert.ok(bodyText.trim().length > 0, "target page has no body content");
  assert.ok(loginControlsPresent || authenticatedMarkerPresent, "neither login controls nor authenticated state was observed");
  console.log(JSON.stringify({ ...report, bodyText: bodyText.slice(0, 800) }, null, 2));
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
