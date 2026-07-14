import path from "node:path";
import { MacOSWindowDesktopAdapter, UnsupportedDesktopAdapter } from "@ai-test-officer/desktop-runtime";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

function configuredAdapter(allowedBundleIds?: string[]) {
  if (process.platform !== "darwin") return new UnsupportedDesktopAdapter();
  return new MacOSWindowDesktopAdapter({
    helperPath: process.env.AI_TEST_OFFICER_DESKTOP_HELPER ?? path.join(rootDir, "bin", "ai-test-officer-desktop-helper"),
    allowedBundleIds: allowedBundleIds ?? (process.env.DESKTOP_ALLOWED_BUNDLE_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    helperSignatureSha256: process.env.DESKTOP_HELPER_SHA256
  });
}

export async function desktopCaptureStatus() {
  const status = await configuredAdapter().status();
  return {
    ...status,
    platform: process.platform,
    mode: "window-scoped-native-helper",
    privacyNote: "Only an explicitly approved, allowlisted window can be captured. Unsupported or missing permissions fail closed."
  };
}

export async function captureDesktopScreenshot(input: {
  bundleId: string;
  windowId: string;
  approvalEventId: string;
  outputPath: string;
  allowedBundleIds?: string[];
}) {
  const outputPath = path.resolve(rootDir, input.outputPath);
  const reportsRoot = path.resolve(rootDir, "reports");
  if (outputPath !== reportsRoot && !outputPath.startsWith(`${reportsRoot}${path.sep}`)) throw new Error("desktop_capture_path_escape");
  return configuredAdapter(input.allowedBundleIds).execute({
    type: "capture-window",
    bundleId: input.bundleId,
    windowId: input.windowId,
    outputPath
  }, input.approvalEventId);
}
