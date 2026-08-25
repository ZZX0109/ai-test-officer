import type { Dispatch, SetStateAction } from "react";
import { acquireRunBrowserControl, releaseRunBrowserControl, sendRunBrowserInput } from "../api";
import type { BrowserSession } from "../types";
import type { PagePoint } from "../sharedBrowserGeometry";

interface SharedBrowserInteractionOptions {
  activeRunId: string | null;
  browserSession: BrowserSession | null;
  browserManualInput: string;
  browserControlBusy: boolean;
  setBrowserSession: Dispatch<SetStateAction<BrowserSession | null>>;
  setBrowserControlBusy: Dispatch<SetStateAction<boolean>>;
  setBrowserFrameRevision: Dispatch<SetStateAction<number>>;
  setBrowserManualInput: Dispatch<SetStateAction<string>>;
  setMessage: (message: string) => void;
}

/**
 * All user-driven browser actions travel through the same run-scoped session
 * API. This hook deliberately does not own session state: the server remains
 * authoritative and callers refresh projections after reconnects.
 */
export function useSharedBrowserInteractions({
  activeRunId, browserSession, browserManualInput, browserControlBusy, setBrowserSession,
  setBrowserControlBusy, setBrowserFrameRevision, setBrowserManualInput, setMessage
}: SharedBrowserInteractionOptions) {
  async function acquireUserControl() {
    if (!activeRunId || !browserSession || browserSession.owner === "user") return true;
    const acquired = await acquireRunBrowserControl(activeRunId);
    setBrowserSession(acquired.session);
    return true;
  }

  async function toggleBrowserControl() {
    if (!activeRunId || !browserSession || ["closed", "failed"].includes(browserSession.status) || browserControlBusy) return;
    setBrowserControlBusy(true);
    try {
      const response = browserSession.owner === "user"
        ? await releaseRunBrowserControl(activeRunId)
        : await acquireRunBrowserControl(activeRunId);
      setBrowserSession(response.session);
      setBrowserFrameRevision((current) => current + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "浏览器控制权切换失败");
    } finally {
      setBrowserControlBusy(false);
    }
  }

  async function clickSharedBrowser(input: PagePoint) {
    if (!activeRunId || !browserSession || ["closed", "failed"].includes(browserSession.status)) return;
    try {
      await acquireUserControl();
      await sendRunBrowserInput(activeRunId, {
        kind: "click",
        x: Math.max(0, Math.min(Math.round(input.x), Math.round(input.imageWidth) - 1)),
        y: Math.max(0, Math.min(Math.round(input.y), Math.round(input.imageHeight) - 1))
      });
      setBrowserFrameRevision((current) => current + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "页面操作失败");
    }
  }

  async function pressSharedBrowserKey(key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space") {
    if (!activeRunId || !browserSession || ["closed", "failed"].includes(browserSession.status)) return;
    try {
      await acquireUserControl();
      await sendRunBrowserInput(activeRunId, { kind: "press", key });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "键盘操作失败");
    }
  }

  async function typeSharedBrowserText(text: string) {
    if (!activeRunId || !browserSession || !text || ["closed", "failed"].includes(browserSession.status)) return;
    try {
      await acquireUserControl();
      await sendRunBrowserInput(activeRunId, { kind: "type", text });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "页面输入失败");
    }
  }

  async function typeIntoSharedBrowser() {
    if (!activeRunId || browserSession?.owner !== "user" || !browserManualInput) return;
    try {
      await sendRunBrowserInput(activeRunId, { kind: "type", text: browserManualInput });
      setBrowserManualInput("");
      setBrowserFrameRevision((current) => current + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "页面输入失败");
    }
  }

  // The workbench canvas deliberately uses a fixed Playwright viewport. Its
  // CSS size is a presentation detail and must not reflow the target project.
  async function syncSharedBrowserViewport(_viewport: { width: number; height: number }) {}

  return {
    toggleBrowserControl,
    clickSharedBrowser,
    pressSharedBrowserKey,
    typeSharedBrowserText,
    typeIntoSharedBrowser,
    syncSharedBrowserViewport
  };
}
