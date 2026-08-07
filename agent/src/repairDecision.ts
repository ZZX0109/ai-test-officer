import type {
  FailureAttribution,
  FailureClass,
  RepairAction,
  RepairDecision
} from "./types.js";
import { buildRepairAction } from "./failureAttribution.js";

/**
 * Repair Decision service.
 *
 * Turns a structured failure attribution into a single, owner-aware decision:
 * who is responsible (agent / user / environment / developer), whether the
 * agent may act autonomously, what to tell the user, and the concrete
 * next action. This is the linchpin that stops every failure from being funnelled
 * into blind "auto-repair".
 */

export function generateUserMessage(action: RepairAction): string {
  switch (action.type) {
    case "provide_credential":
    case "credential_required":
      return [
        "当前页面需要登录。",
        "",
        "请进入凭据管理配置测试账号。",
        "不要直接发送密码。",
        "",
        "配置完成后重新执行 Discovery。"
      ].join("\n");
    case "fix_environment":
    case "runtime_unavailable":
      return [
        "测试环境不可访问。",
        "",
        "请检查：",
        "1. Docker 状态",
        "2. APP_URL",
        "3. 端口映射",
        "",
        "完成后重新诊断。"
      ].join("\n");
    case "update_selector":
    case "selector_drift":
      return [
        "测试规则与当前页面结构不一致。",
        "",
        "系统可以自动更新 selector。"
      ].join("\n");
    case "discovery_incomplete":
      return [
        "Discovery 没有发现可安全执行的路径。",
        "",
        "请补充入口、运行条件或预期结果，系统会据此重新规划。"
      ].join("\n");
    case "product_bug":
    case "modify_code":
      return [
        "失败由产品行为（疑似缺陷）导致。",
        "",
        "系统可以在沙盒中复现并生成修复方案，涉及源码修改时会先展示 Diff 并征求确认。"
      ].join("\n");
    case "evidence_missing":
      return [
        "当前失败缺少可验证证据。",
        "",
        "请补充证据来源（trace / 网络 / 截图）或确认采集配置，然后重新执行。"
      ].join("\n");
    default:
      return [
        "需要人工确认失败原因。",
        "",
        ...action.steps.map((step, index) => `${index + 1}. ${step}`),
        "",
        `验证：${action.validation}`
      ].join("\n");
  }
}

export function decideRepair(attribution: FailureAttribution): RepairDecision {
  const action: RepairAction =
    attribution.repairAction ?? buildRepairAction(attribution.failureClass, attribution.reasoning);
  return {
    owner: action.owner,
    type: action.type,
    executable: action.owner === "agent",
    userMessage: generateUserMessage(action),
    steps: action.steps,
    validation: action.validation,
    nextAction: action.type
  };
}

/**
 * The graph's `triageFailure` derives a simplified class literal
 * ("environment" / "test-script" / "product-bug" / "unknown") that does not use
 * the `FailureClass` enum, so map it before building a decision from it.
 */
export function mapDeterministicClassToFailureClass(value: string): FailureClass {
  if (value === "environment") return "environment_issue";
  if (value === "test-script") return "test_script_issue";
  if (value === "product-bug") return "product_bug";
  return "unknown";
}

/** Build a repair decision from the graph's simplified triage class. */
export function decideRepairFromDeterministic(
  failureClass: FailureClass,
  reasoning: string
): RepairDecision {
  return decideRepair({
    id: "synthetic",
    rank: 1,
    failureClass,
    title: "",
    reasoning,
    suggestedFix: "",
    reproductionSteps: [],
    evidenceRefs: [],
    sourceContextIds: [],
    confidence: "low"
  });
}
