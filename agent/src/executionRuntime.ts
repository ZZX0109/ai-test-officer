import type { Page } from "playwright";
import type { VisualRunResult } from "./types.js";

export function redactPageObservationText(value: unknown, limit = 2_000) {
  const text = String(value ?? "")
    .replace(/\b(?:sk|afk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_KEY]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function redactPageObservationUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
    return url.toString();
  } catch {
    return redactPageObservationText(value, 800);
  }
}

export function classifyExecutionError(error: unknown, stepId?: string): NonNullable<VisualRunResult["executionError"]> {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/[\r\n]+/g, " ").slice(0, 1_000);
  if (/locator\.|waiting for|getByRole|getByLabel|selector/i.test(raw)) return { code: "action_binding_failure", stepId, message, failureClass: "test_script_issue" };
  if (/target page.*closed|browser.*closed|context.*closed|crash/i.test(raw)) return { code: "browser_runtime_failure", stepId, message, failureClass: "environment_issue" };
  if (/net::|ECONN|ERR_CONNECTION|health|timeout.*navigation/i.test(raw)) return { code: "environment_failure", stepId, message, failureClass: "environment_issue" };
  return { code: "execution_failure", stepId, message, failureClass: "unknown" };
}

export function envFlag(name: string) {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").toLowerCase());
}

export function resolveBrowserHeadlessMode(value = process.env.HEADLESS) {
  return value !== "0";
}

export async function waitForUsablePageDom(page: Page) {
  if (typeof page.waitForFunction !== "function") return true;
  return page.waitForFunction(() => {
    const body = document.body;
    if (!body) return false;
    const visibleText = (body.innerText || "").replace(/\s+/g, " ").trim();
    return visibleText.length > 0 || Boolean(body.querySelector("a,button,input,textarea,select,[role='button'],[data-testid],canvas,svg"));
  }, undefined, { timeout: 15_000 }).then(() => true).catch(() => false);
}

export async function navigateToUsablePage(page: Page, url: string, onNavigation?: (event: { status: "started" | "succeeded" | "failed"; url: string; httpStatus?: number; error?: string }) => void) {
  onNavigation?.({ status: "started", url });
  try {
    const response = await page.goto(url, { waitUntil: "commit", timeout: 15_000 });
    onNavigation?.({ status: "succeeded", url: page.url(), httpStatus: response?.status() });
  } catch (error) {
    onNavigation?.({ status: "failed", url: page.url() || url, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return waitForUsablePageDom(page);
}

export async function reloadUsablePage(page: Page) {
  await page.reload({ waitUntil: "commit", timeout: 15_000 });
  return waitForUsablePageDom(page);
}
