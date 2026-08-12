import { createHash, randomUUID } from "node:crypto";
import type { Frame, Page } from "playwright";
import {
  browserObservationSchema,
  type BrowserControl,
  type BrowserObservation
} from "@ai-test-officer/contracts";

type Telemetry = {
  consoleErrors?: string[];
  pageErrors?: string[];
  failedRequests?: Array<{ method: string; url: string; status?: number; failure?: string }>;
};

type RawControl = {
  kind: BrowserControl["kind"];
  role?: string;
  accessibleName?: string;
  label?: string;
  testId?: string;
  inputType?: string;
  valueState?: "empty" | "nonempty";
  visible: boolean;
  disabled: boolean;
  obscured: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number };
  candidates: BrowserControl["locatorCandidates"];
  semanticKey: string;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(value: string | undefined, limit: number) {
  if (!value) return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|session|auth/i.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function frameControls(frame: Frame): Promise<RawControl[]> {
  // tsx/esbuild decorates nested functions with a private `__name` helper.
  // Playwright serializes only the callback body, so that helper does not
  // otherwise exist inside the target page. Install a tiny identity helper in
  // the isolated evaluation world before scanning; it carries no project data
  // and prevents a valid page from being misreported as an empty DOM.
  await frame.evaluate("globalThis.__name ??= (value) => value");
  return frame.evaluate(() => {
    type Candidate = { strategy: "test-id" | "role-name" | "label" | "text" | "css-safe"; value: string; unique: boolean };
    const roots: Array<Document | ShadowRoot> = [document];
    const allElements: Element[] = [];
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      for (const element of Array.from(root.querySelectorAll("*"))) {
        allElements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const interactive = allElements.filter((element) => {
      const tag = element.tagName.toLowerCase();
      return ["a", "button", "input", "textarea", "select", "summary"].includes(tag)
        || ["button", "link", "checkbox", "radio", "textbox", "combobox", "tab", "menuitem", "option", "switch"].includes(element.getAttribute("role") ?? "")
        || element.hasAttribute("data-testid");
    });
    const textValue = (element: Element) => (element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.textContent
      || "").replace(/\s+/g, " ").trim();
    const inferredRole = (element: Element) => {
      const declared = element.getAttribute("role");
      if (declared) return declared;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (element as HTMLInputElement).type;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        return "textbox";
      }
      return undefined;
    };
    const kindFor = (element: Element) => {
      const tag = element.tagName.toLowerCase();
      const type = element instanceof HTMLInputElement ? element.type : "";
      if (type === "checkbox") return "checkbox" as const;
      if (type === "radio") return "radio" as const;
      // DOM tag names are not the public browser-control vocabulary.  In
      // particular <a> must be normalised to "link"; casting the raw tag let
      // the value "a" reach Zod and crashed observation before the LLM could
      // receive any page facts.
      if (tag === "a") return "link" as const;
      if (["button", "input", "textarea", "select"].includes(tag)) return tag as "button" | "input" | "textarea" | "select";
      return "other" as const;
    };
    return interactive.slice(0, 200).map((element, ordinal) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const box = html.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && box.width > 0 && box.height > 0;
      const center = visible ? document.elementFromPoint(Math.max(0, box.x + box.width / 2), Math.max(0, box.y + box.height / 2)) : null;
      const obscured = Boolean(center && center !== element && !element.contains(center) && !center.contains(element));
      const disabled = "disabled" in element
        ? Boolean((element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement).disabled)
        : element.getAttribute("aria-disabled") === "true";
      const role = inferredRole(element);
      const name = textValue(element);
      const testId = element.getAttribute("data-testid") ?? undefined;
      const explicitLabel = element.getAttribute("aria-label")
        || (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent : undefined)
        || element.closest("label")?.textContent
        || undefined;
      const candidates: Candidate[] = [];
      if (testId) candidates.push({ strategy: "test-id", value: testId, unique: document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1 });
      if (role && name) candidates.push({ strategy: "role-name", value: JSON.stringify({ role, name }), unique: interactive.filter((item) => inferredRole(item) === role && textValue(item) === name).length === 1 });
      if (explicitLabel?.trim()) {
        const label = explicitLabel.replace(/\s+/g, " ").trim();
        candidates.push({ strategy: "label", value: label, unique: interactive.filter((item) => {
          const value = item.getAttribute("aria-label") || (item.id ? document.querySelector(`label[for="${CSS.escape(item.id)}"]`)?.textContent : undefined) || item.closest("label")?.textContent || "";
          return value.replace(/\s+/g, " ").trim() === label;
        }).length === 1 });
      }
      if (name && ["button", "link", "tab", "menuitem"].includes(role ?? "")) candidates.push({ strategy: "text", value: name, unique: interactive.filter((item) => textValue(item) === name).length === 1 });
      const safeParts = [element.tagName.toLowerCase()];
      const inputName = element.getAttribute("name");
      const inputType = element.getAttribute("type");
      if (inputName) safeParts.push(`[name="${CSS.escape(inputName)}"]`);
      if (inputType) safeParts.push(`[type="${CSS.escape(inputType)}"]`);
      const safeCss = safeParts.join("");
      candidates.push({ strategy: "css-safe", value: safeCss, unique: document.querySelectorAll(safeCss).length === 1 });
      return {
        kind: kindFor(element), role, accessibleName: name || undefined,
        label: explicitLabel?.replace(/\s+/g, " ").trim() || undefined,
        testId, inputType: element instanceof HTMLInputElement ? element.type : undefined,
        // The page model deliberately exposes only empty/nonempty state.  It
        // enables a deterministic fill Oracle without placing test data or a
        // credential value in an Artifact, prompt, report, or model context.
        valueState: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ? "nonempty" : "empty")
          : undefined,
        visible, disabled, obscured,
        boundingBox: visible ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined,
        candidates,
        semanticKey: [role, name, testId, inputName, inputType, ordinal].filter(Boolean).join("|")
      };
    });
  });
}

export async function observeBrowserPage(input: {
  page: Page;
  runId: string;
  attemptId: string;
  coverageItemId?: string;
  requestedUrl?: string;
  telemetry?: Telemetry;
  screenshotArtifactId?: string;
  evidenceRefs?: string[];
}): Promise<BrowserObservation> {
  const observationId = `browser_observation_${randomUUID()}`;
  const frames = input.page.frames();
  const bodyText = await input.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const accessibilityTree = await input.page.locator("body").ariaSnapshot({ timeout: 2_000 }).catch(() => undefined);
  const frameResults = await Promise.all(frames.map(async (frame) => ({
    framePath: frame === input.page.mainFrame() ? [] : [redactUrl(frame.url())],
    // A failed DOM scan is not an empty page. Propagate the failure so the
    // Graph records a real observation error instead of telling the LLM that
    // no controls exist and sending it into a misleading retry loop.
    controls: await frameControls(frame)
  })));
  const fingerprintSource = JSON.stringify({
    url: redactUrl(input.page.url()),
    title: await input.page.title().catch(() => ""),
    body: bounded(bodyText, 4_000),
    controls: frameResults.flatMap((item) => item.controls.map((control) => ({ frame: item.framePath, key: control.semanticKey, visible: control.visible, disabled: control.disabled })))
  });
  const pageFingerprint = digest(fingerprintSource);
  const controls = frameResults.flatMap(({ framePath, controls: rawControls }) => rawControls.map((control) => browserControlSchema.parse({
    controlId: `control_${digest(`${input.runId}|${input.attemptId}|${framePath.join("|")}|${control.semanticKey}`).slice(0, 24)}`,
    observationId,
    runId: input.runId,
    attemptId: input.attemptId,
    pageFingerprint,
    kind: control.kind,
    role: bounded(control.role, 80),
    accessibleName: bounded(control.accessibleName, 240),
    label: bounded(control.label, 240),
    testId: bounded(control.testId, 240),
    inputType: bounded(control.inputType, 80),
    valueState: control.valueState,
    framePath,
    shadowPath: [],
    locatorCandidates: control.candidates.filter((candidate, index, array) => array.findIndex((item) => item.strategy === candidate.strategy && item.value === candidate.value) === index).slice(0, 6),
    boundingBox: control.boundingBox,
    visible: control.visible,
    disabled: control.disabled,
    obscured: control.obscured
  })));
  const readyState = await input.page.evaluate(() => document.readyState).catch(() => "unknown");
  return browserObservationSchema.parse({
    schemaVersion: "1.0",
    observationId,
    runId: input.runId,
    attemptId: input.attemptId,
    coverageItemId: input.coverageItemId,
    requestedUrl: redactUrl(input.requestedUrl ?? input.page.url()),
    finalUrl: redactUrl(input.page.url()),
    title: bounded(await input.page.title().catch(() => ""), 500) ?? "",
    readyState: ["loading", "interactive", "complete"].includes(readyState) ? readyState : "unknown",
    pageFingerprint,
    bodyTextSample: bounded(bodyText, 4_000) ?? "",
    accessibilityTree: bounded(accessibilityTree, 12_000),
    controls,
    consoleErrors: (input.telemetry?.consoleErrors ?? []).slice(-50).map((item) => bounded(item, 1_000) ?? ""),
    pageErrors: (input.telemetry?.pageErrors ?? []).slice(-50).map((item) => bounded(item, 1_000) ?? ""),
    failedRequests: (input.telemetry?.failedRequests ?? []).slice(-100).map((item) => ({ ...item, url: redactUrl(item.url), failure: bounded(item.failure, 500) })),
    screenshotArtifactId: input.screenshotArtifactId,
    evidenceRefs: input.evidenceRefs ?? [],
    createdAt: new Date().toISOString()
  });
}

// Kept local to avoid letting callers construct unvalidated controls.
const browserControlSchema = browserObservationSchema.shape.controls.element;
