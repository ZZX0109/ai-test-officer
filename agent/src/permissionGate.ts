import type { RunRequest } from "./types.js";
import { appendAudit } from "./auditLog.js";

export async function requireBrowserControl(input: RunRequest) {
  const allowed = Boolean(input.permissionProfile.observe && input.permissionProfile.browserControl);
  await appendAudit({
    type: "permission_check",
    action: "browser_control",
    result: allowed ? "allowed" : "denied",
    details: {
      appUrl: input.appUrl,
      permissionProfile: input.permissionProfile
    }
  });
  if (!allowed) {
    throw new Error("需要用户授权 observe 和 browser_control 后才能接管浏览器执行测试。");
  }
}

