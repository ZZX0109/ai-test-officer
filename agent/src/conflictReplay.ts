import type { ConflictPacket, EvidenceItem, VisualRunResult } from "./types.js";

export function buildConflictPacket(result: Pick<VisualRunResult, "assertions" | "steps">, evidence: EvidenceItem[]): ConflictPacket {
  const failedAssertions = result.assertions.filter((item) => !item.passed);
  const retryStep = result.steps.find((item) => item.action === "retry");
  if (failedAssertions.length > 0 && retryStep) {
    return {
      status: "needs_user_review",
      reason: "核心路径失败后已自动重试，仍存在失败断言。当前没有截图/DOM 冲突，但需要用户复核失败证据。",
      evidenceRefs: evidence
        .filter((item) => item.type === "screenshot" || item.type === "assertion" || item.type === "network")
        .map((item) => item.id)
    };
  }
  return {
    status: "not_triggered",
    reason: "未检测到截图与结构化证据冲突。",
    evidenceRefs: []
  };
}

