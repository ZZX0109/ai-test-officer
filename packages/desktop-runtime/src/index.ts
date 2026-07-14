import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

export type DesktopPermission = "accessibility" | "screen-recording";
export type DesktopAction =
  | { type: "focus-window"; bundleId: string; windowId: string }
  | { type: "mouse-click"; bundleId: string; windowId: string; x: number; y: number }
  | { type: "keyboard-input"; bundleId: string; windowId: string; text: string; sensitive?: boolean }
  | { type: "capture-window"; bundleId: string; windowId: string; outputPath: string }
  | { type: "start-recording"; bundleId: string; windowId: string; outputPath: string }
  | { type: "stop-recording"; bundleId: string; windowId: string };

export interface DesktopAdapter {
  status(): Promise<{ supported: boolean; permissions: Record<DesktopPermission, boolean>; reason?: string }>;
  execute(action: DesktopAction, approvalEventId: string): Promise<{ capturedAt: string; payload: Record<string, unknown> }>;
}

function redactAction(action: DesktopAction) {
  if (action.type !== "keyboard-input") return action;
  return { ...action, text: action.sensitive ? `[REDACTED:${action.text.length}]` : action.text };
}

export class MacOSWindowDesktopAdapter implements DesktopAdapter {
  constructor(
    private readonly options: {
      helperPath: string;
      allowedBundleIds: string[];
      helperSignatureSha256?: string;
    }
  ) {}

  private async helperAvailable() {
    if (process.platform !== "darwin") return false;
    try {
      await access(this.options.helperPath, constants.X_OK);
      if (this.options.helperSignatureSha256) {
        const actual = createHash("sha256").update(await readFile(this.options.helperPath)).digest("hex");
        if (actual !== this.options.helperSignatureSha256) throw new Error("desktop_helper_signature_mismatch");
      }
      return true;
    } catch {
      return false;
    }
  }

  private async callHelper(payload: Record<string, unknown>) {
    if (!(await this.helperAvailable())) throw new Error("desktop_helper_unavailable");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(this.options.helperPath, ["--json"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) return reject(new Error(`desktop_helper_failed:${code}:${stderr.slice(0, 500)}`));
        try { resolve(JSON.parse(stdout) as Record<string, unknown>); } catch { reject(new Error("desktop_helper_invalid_json")); }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async status() {
    if (!(await this.helperAvailable())) {
      return { supported: false, permissions: { accessibility: false, "screen-recording": false }, reason: process.platform === "darwin" ? "signed_helper_missing" : "unsupported_platform" };
    }
    const result = await this.callHelper({ action: "status" });
    return {
      supported: true,
      permissions: {
        accessibility: result.accessibility === true,
        "screen-recording": result.screenRecording === true
      }
    };
  }

  async execute(action: DesktopAction, approvalEventId: string) {
    if (!approvalEventId.trim()) throw new Error("permission_event_required");
    if (!this.options.allowedBundleIds.includes(action.bundleId)) throw new Error(`desktop_bundle_not_allowed:${action.bundleId}`);
    if (action.type === "keyboard-input" && action.sensitive) {
      throw new Error("secure_input_capture_forbidden");
    }
    const result = await this.callHelper({ action: redactAction(action), approvalEventId, signatureSha256: this.options.helperSignatureSha256 });
    return { capturedAt: new Date().toISOString(), payload: result };
  }
}

export class UnsupportedDesktopAdapter implements DesktopAdapter {
  async status() { return { supported: false, permissions: { accessibility: false, "screen-recording": false }, reason: "unsupported_platform" }; }
  async execute(_action: DesktopAction, _approvalEventId: string): Promise<{ capturedAt: string; payload: Record<string, unknown> }> {
    throw new Error("desktop_capability_blocked");
  }
}
