import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(process.cwd(), "..");
const reportsDir = path.join(rootDir, "reports");

export function desktopCaptureStatus() {
  return {
    supported: process.platform === "darwin",
    platform: process.platform,
    mode: "manual",
    privacyNote: "桌面级截图需要用户主动触发；MVP 默认只使用浏览器窗口截图。"
  };
}

export async function captureDesktopScreenshot() {
  if (process.platform !== "darwin") {
    throw new Error("Desktop capture MVP currently supports macOS screencapture only.");
  }
  const dir = path.join(reportsDir, "screenshots", "desktop");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `desktop_${Date.now()}.png`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("screencapture", ["-x", file], { stdio: "ignore" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`screencapture failed with code ${code}`));
    });
    child.on("error", reject);
  });
  return {
    file: `/artifacts/screenshots/desktop/${path.basename(file)}`,
    warning: "该截图可能包含桌面其它内容，只应用于用户主动触发的复核场景。"
  };
}

