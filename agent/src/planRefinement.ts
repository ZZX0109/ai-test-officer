import { fixedGrayPlan } from "./plan.js";
import type { GrayPlan } from "./types.js";

export interface PlanRefinementInput {
  currentPlan?: GrayPlan;
  feedback: string;
  failedAssertionNames: string[];
}

export function proposePlanRefinement(input: PlanRefinementInput) {
  const suggestedPath = {
    id: "replay_completed_filter_with_network_focus",
    title: "重放已完成筛选并优先检查 network query",
    riskReason: "执行反馈显示 completed 筛选请求缺少 status=completed，需要把 network oracle 提升为显式检查。",
    expectedFrom: "requirement" as const,
    retry: 1,
    steps: [
      "重新打开任务列表页",
      "点击已完成",
      "优先检查 network 请求是否包含 status=completed",
      "再检查 DOM 中任务状态是否全为 completed"
    ]
  };
  const nextPlan = structuredClone(input.currentPlan ?? fixedGrayPlan);
  const core = nextPlan.levels.find((level) => level.id === "core_path");
  if (core && !core.paths.some((path) => path.id === suggestedPath.id)) {
    core.paths.push(suggestedPath);
  }
  return {
    proposalId: `proposal_${Date.now()}`,
    status: "needs_user_confirmation",
    rationale: "这是 plan change proposal，不会直接修改执行结果；需要用户确认后才可应用。",
    feedback: input.feedback,
    failedAssertionNames: input.failedAssertionNames,
    changes: [
      {
        type: "add_path",
        targetLevel: "core_path",
        pathId: suggestedPath.id,
        reason: "根据失败反馈补强 network oracle。"
      }
    ],
    proposedPlan: nextPlan
  };
}
