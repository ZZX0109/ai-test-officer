import { reviewCaseSchema, type ReviewCase } from "@ai-test-officer/contracts";

export interface ReviewCaseInput {
  id: string;
  state?: string;
  status?: string;
  reason?: string;
  summary?: string;
  evidenceRefs?: string[];
  canRetry?: boolean;
  canResume?: boolean;
}

export function createReviewCase(input: ReviewCaseInput): ReviewCase | undefined {
  const reviewState = input.state === "awaiting-human-review"
    || input.status === "needs-human-review"
    || input.status === "blocked"
    || input.status === "fail";
  if (!reviewState) return undefined;
  const reason = input.reason || input.summary || "系统无法在当前条件下安全完成测试。";
  const category = /credential|login|账号|凭据|密码/i.test(reason)
    ? "credentials"
    : /network|proxy|egress|域名|网络/i.test(reason)
      ? "network"
      : /proof|evidence|artifact|证据/i.test(reason)
        ? "proof"
        : /runtime|docker|container|启动|沙盒/i.test(reason)
          ? "runtime"
          : input.status === "fail" ? "repair" : "unknown";
  return reviewCaseSchema.parse({
    id: input.id,
    category,
    severity: input.status === "blocked" ? "high" : input.status === "fail" ? "medium" : "high",
    title: input.status === "fail" ? "测试失败，需要处理失败原因" : "测试暂停，需要人工决定",
    explanation: reason,
    whatWasTried: ["系统已执行受限动作并收集可用运行证据。", "系统未绕过权限、网络或证据完整性边界。"],
    evidenceRefs: input.evidenceRefs ?? [],
    requiredDecision: category === "credentials" ? "提供或选择可用凭据" : category === "repair" ? "确认修复或重试路径" : "确认下一步处理方式",
    nextAction: category === "credentials" ? "打开凭据配置向导并重新执行" : input.canRetry ? "检查原因后点击重试" : "查看证据并选择继续、修复或终止",
    cta: category === "credentials" ? "配置凭据" : input.canRetry ? "重试" : "查看详情",
    canRetry: input.canRetry ?? false,
    canResume: input.canResume ?? false,
    createdAt: new Date().toISOString()
  });
}
