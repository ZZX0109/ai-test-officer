import type { DiscoveryScanResult } from "./types";

export interface DiscoveryOrchestrationCopy {
  tone: "waiting" | "ready" | "blocked" | "failed";
  status: string;
  reason: string;
  completed: string;
  nextStep: string;
}

export function discoveryOrchestrationCopy(discovery: DiscoveryScanResult): DiscoveryOrchestrationCopy | null {
  const orchestration = discovery.orchestration;
  if (!orchestration) return null;

  if (orchestration.status === "ready") {
    return {
      tone: "ready",
      status: "页面已就绪",
      reason: orchestration.reason || "页面已经打开并发现可操作控件。",
      completed: `页面预检已完成（${orchestration.discoveryAttempts || 1} 次 Discovery）。`,
      nextStep: "系统可以继续生成并执行正式测试清单。"
    };
  }
  if (orchestration.status === "waiting") {
    return {
      tone: "waiting",
      status: "正在等待测试页面",
      reason: orchestration.reason || "项目服务仍在启动，页面暂时不能稳定访问。",
      completed: `已完成 ${orchestration.attempts}/${orchestration.maxAttempts} 次连通性检查；业务测试尚未生成。`,
      nextStep: orchestration.retryable
        ? "无需操作，等待项目服务就绪后重新预检。"
        : "请检查项目启动状态后重试。"
    };
  }
  if (orchestration.status === "blocked") {
    const authenticationBlocked = orchestration.httpStatus === 401 || orchestration.httpStatus === 403;
    return {
      tone: "blocked",
      status: "测试尚未开始",
      reason: orchestration.reason || "页面预检遇到必须先处理的条件。",
      completed: "只完成了页面预检，没有把调度完成当成测试通过。",
      nextStep: authenticationBlocked
        ? "页面明确返回认证或权限错误，请绑定测试凭据后重试。"
        : "请按阻塞原因处理项目运行条件后重试。"
    };
  }
  return {
    tone: "failed",
    status: "测试尚未开始",
    reason: orchestration.reason || discovery.observation.diagnosis.summary || "页面没有进入可测试状态。",
    completed: `页面预检已停止（连通性 ${orchestration.attempts}/${orchestration.maxAttempts}，Discovery ${orchestration.discoveryAttempts} 次）；没有生成大批不可执行流程。`,
    nextStep: orchestration.retryable
      ? "系统已保存当前页面观测；确认服务地址后可有限重试。"
      : "请确认项目服务和测试地址正确，再重新预检。"
  };
}
