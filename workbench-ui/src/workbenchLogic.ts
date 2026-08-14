import type { AgentGraphProjection, AssistantSuggestedAction, PlanningMessage } from "./types";

export function upsertAssistantProgress(messages: PlanningMessage[], message: PlanningMessage, progressKey: string) {
  const id = `progress:${progressKey}`;
  const next = { ...message, id };
  const index = messages.findIndex((item) => item.id === id);
  if (index < 0) return [...messages, next];
  const current = messages[index];
  if (current.content === next.content && current.streaming === next.streaming) return messages;
  return messages.map((item, itemIndex) => itemIndex === index ? next : item);
}

export function commandFallbackAction(message: string, runState?: string): Exclude<AssistantSuggestedAction, "none"> | undefined {
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  if (/查看.*(证据|截图|日志|trace)|打开.*(证据|截图|日志)/i.test(normalized)) return "open-evidence";
  if (/docker|podman|沙盒|启动.*项目|前端.*打不开|端口.*不可达/i.test(normalized)) return "retry-runtime";
  if (/重新扫描|扫描页面|discovery/i.test(normalized)) return "retry-discovery";
  if (/暂停|先停一下|等一下/i.test(normalized)) return "pause-run";
  if (/取消|终止|停止测试/i.test(normalized)) return "cancel-run";
  if (/重试.*失败|重新.*失败|修复.*失败|重新绑定/i.test(normalized)) return "retry-failed-path";
  if (/继续.*(其他|剩余|安全|可执行)|跳过.*继续/i.test(normalized)) return "continue-safe-paths";
  if (/修改.*计划|调整.*计划|修改.*范围|调整.*范围/i.test(normalized)) return "revise-plan";
  if (/恢复|继续测试/i.test(normalized) && runState === "paused") return "resume-run";
  if (/开始测试|执行计划|开始执行/i.test(normalized)) return "start-run";
  return undefined;
}

/** Worker rendezvous interrupts are resumed only by execution results. */
export function isUserActionableInterrupt(interrupt: AgentGraphProjection["pendingInterrupt"] | undefined): boolean {
  return Boolean(interrupt?.status === "pending" && interrupt.kind !== "execution-result");
}

const terminalRunStates = new Set(["completed", "failed", "blocked", "cancelled", "awaiting-human-review"]);
const graphNodeActivity: Record<string, string> = {
  intake: "理解测试目标", discover: "识别当前页面和项目入口", "diagnose-runtime": "检查项目运行环境",
  "choose-recovery": "判断可自动恢复的方案", recover: "恢复项目运行环境", "verify-recovery": "验证恢复结果",
  "build-coverage-map": "整理业务路径和覆盖范围", plan: "规划测试步骤", compile: "校验动作、断言和证据要求",
  "approve-plan": "等待测试计划确认", "prepare-sandbox": "准备隔离测试环境", "approve-capabilities": "检查本次操作权限",
  "observe-browser": "读取页面、控件和运行错误", "decide-browser-action": "分析页面并决定下一步操作",
  "authorize-browser-action": "校验下一步页面操作", "execute-browser-action": "操作当前页面",
  "verify-browser-action": "检查页面变化和断言结果", "decide-next-step": "判断下一条测试动作",
  execute: "执行测试路径", "collect-and-gate": "整理证据并计算机器结论", "triage-failure": "分析失败原因",
  "selective-judge": "核对有冲突的证据", repair: "准备沙盒修复方案", "retry-path": "重试失败路径",
  "continue-paths": "继续其余测试路径", finalize: "生成最终测试结论"
};

export function describeRunActivity(input: {
  runId?: string | null;
  runState?: string;
  isRunning: boolean;
  planningPhase: "idle" | "preparing-project" | "discovering" | "binding" | "starting-run" | "running" | "ready" | "needs-permission" | "needs-credentials" | "blocked";
  projection?: AgentGraphProjection | null;
}) {
  if (!input.runId) return null;
  const projectionTerminal = input.projection && ["completed", "failed", "cancelled"].includes(input.projection.status);
  if (terminalRunStates.has(input.runState ?? "") || projectionTerminal) return null;
  const waitingForUser = isUserActionableInterrupt(input.projection?.pendingInterrupt);
  const node = input.projection?.currentNode;
  const rawFailure = `${input.projection?.lastError?.code ?? ""} ${input.projection?.lastError?.message ?? ""} ${input.projection?.recoveryResult?.errorCode ?? ""} ${input.projection?.recoveryResult?.userMessage ?? ""}`;
  const rateLimited = /rate limit|429/i.test(rawFailure);
  const action = waitingForUser
    ? input.projection?.pendingInterrupt?.title ?? "等待你的确认"
    : rateLimited ? "等待模型限流窗口恢复后重试"
      : node ? graphNodeActivity[node] ?? node
        : input.planningPhase === "starting-run" ? "启动测试运行"
          : input.planningPhase === "running" || input.isRunning ? "执行测试" : "准备下一步测试";
  return {
    action,
    streaming: !waitingForUser,
    content: waitingForUser
      ? `测试尚未结束 · 当前暂停\n当前动作：${action}\n需要你做什么：请完成上面的确认，系统会从同一测试进度继续。`
      : `正在思考 · ${action}\n测试尚未结束。当前页面、已执行动作和证据会持续保留；${rateLimited ? "系统正在退避，恢复后会继续当前步骤。" : "完成当前步骤后会自动进入下一条路径。"}`,
    phase: waitingForUser ? "waiting-user" as const : "acting" as const,
    signature: `${waitingForUser ? "waiting" : "working"}:${node ?? input.planningPhase}:${rateLimited ? "rate-limited" : "normal"}:${action}`
  };
}

export function isExplicitAssistantActionConfirmation(message: string, action: Exclude<AssistantSuggestedAction, "none"> | undefined) {
  if (!action || !["retry-runtime", "retry-discovery", "retry-failed-path", "continue-safe-paths"].includes(action)) return false;
  const normalized = message.replace(/\s+/g, "").toLowerCase();
  if (/(?:为什么|怎么|如何|是什么|能否|是否|可以吗|需要做什么|该怎么办|\?|？)/i.test(normalized)) return false;
  return /^(?:请)?(?:确认|同意|可以|继续|执行|重试|重新|再试|修复|扫描|启动)/i.test(normalized)
    || /(?:重新尝试即可|继续处理|继续执行|重试失败链路|重新扫描页面|重新绑定路径)/i.test(normalized);
}
