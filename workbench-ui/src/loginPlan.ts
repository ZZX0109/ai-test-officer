/**
 * Returns whether a confirmed test plan actually requires a project login.
 *
 * This intentionally looks for executable login actions first.  A project
 * having an auth-related file or a flow mentioning permissions is not enough:
 * credentials should be requested only when the plan contains a login step
 * that will run in the browser.
 */
export function planRequiresLoginCredentials(value: unknown): boolean {
  const loginActions = new Set([
    "login_as_test_user",
    "login_invalid_user",
    "login",
    "authenticate",
    "sign_in",
    "signin"
  ]);
  const loginPattern = /(?:^|[_\-\s])(login|sign[\s_-]*in|authenticate)(?:$|[_\-\s])/i;
  const chineseLoginPattern = /登录|登入|身份认证|认证登录/;
  const visited = new Set<object>();

  function visit(node: unknown, key?: string): boolean {
    if (typeof node === "string") {
      const normalized = node.trim().toLowerCase();
      // Only treat a string as an action when it is under an action/step
      // field. Titles and explanations are handled below with stricter
      // signals, so “权限测试” alone cannot trigger a password prompt.
      if (key && /action|actions|step|steps|operation|operations|capability/i.test(key)) {
        return loginActions.has(normalized) || loginPattern.test(normalized) || chineseLoginPattern.test(node);
      }
      return false;
    }
    if (!node || typeof node !== "object") return false;
    if (visited.has(node)) return false;
    visited.add(node);
    if (Array.isArray(node)) return node.some((item) => visit(item, key));
    const record = node as Record<string, unknown>;
    const executionContext = ["scenarioId", "steps", "pathId", "requiredInformation", "browserActions"]
      .some((field) => field in record);
    if (executionContext) {
      const semanticText = [record.scenarioId, record.title, record.target, record.reason, record.riskReason]
        .filter((item): item is string => typeof item === "string")
        .join(" ");
      if (/(?:login|sign[\s_-]*in|authenticate|登录|登入|身份认证|visitor[_-]permission)/i.test(semanticText)) return true;
    }
    return Object.entries(node).some(([entryKey, entryValue]) => {
      if (entryKey === "action" && typeof entryValue === "string") {
        const normalized = entryValue.trim().toLowerCase();
        return loginActions.has(normalized) || loginPattern.test(normalized) || chineseLoginPattern.test(entryValue);
      }
      return visit(entryValue, entryKey);
    });
  }

  return visit(value);
}
