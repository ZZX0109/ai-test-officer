import { randomUUID } from "node:crypto";
import { knowledgeBoundaryOutputSchema } from "@ai-test-officer/contracts";

export const assistantFallbackActions = [
  "none",
  "revise-plan",
  "start-run",
  "pause-run",
  "resume-run",
  "cancel-run",
  "resume-interrupt",
  "create-repair",
  "retry-failed-path",
  "continue-safe-paths",
  "open-evidence"
] as const;

export type AssistantFallbackAction = typeof assistantFallbackActions[number];

export interface AssistantFailureContext {
  userMessage: string;
  projectName?: string;
  runState?: string;
  finalStatus?: string;
  summary?: string;
  currentStep?: string;
  latestLog?: string;
  evidenceCount?: number;
  pageObservation?: {
    id?: string;
    requestedUrl: string;
    finalUrl: string;
    stage: string;
    status: "ready" | "degraded" | "failed";
    navigation: { documentCommitted: boolean; httpStatus?: number };
    document: {
      interactiveElementCount: number;
      bodyTextSample?: string;
      controls?: Array<{
        kind: string;
        accessibleName?: string;
        testId?: string;
        inputType?: string;
        visible: boolean;
        disabled: boolean;
      }>;
    };
    console: Array<{ type: string; text: string }>;
    pageErrors: string[];
    failedRequests: Array<{
      method: string;
      url: string;
      status?: number;
      resourceType?: string;
      failure?: string;
    }>;
    screenshot?: { storageUri: string; capturedAt: string };
    diagnosis: {
      summary: string;
      likelyCauses: string[];
      retryable: boolean;
      userActionRequired: boolean;
    };
  };
  failedAssertions?: Array<{ name: string; expected: string; actual: string }>;
  projectDiagnostic?: {
    runtimeStatus?: string;
    runtimePhase?: string;
    failureReason?: string;
    runtimeMessage?: string;
    failedStages?: Array<{
      stage: string;
      reason: string;
      humanMessage: string;
      missingEnv?: string[];
      portConflicts?: Array<{ port: number; process?: string; fix: string }>;
    }>;
    recoverySummary?: string;
  };
  planning?: {
    discovered: number;
    executable: number;
    autoBindable: number;
    confirmed: boolean;
    failures?: Array<{
      title?: string;
      target?: string;
      stage?: "binding" | "execution";
      detail: string;
      requiredInformation?: string[];
    }>;
    blockingQuestions?: string[];
  };
}

type AssistantPageObservation = NonNullable<AssistantFailureContext["pageObservation"]>;

function authenticationUrlObserved(value: string) {
  try {
    const url = new URL(value);
    return /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|sso)(?:\/|$)/i.test(url.pathname);
  } catch {
    return /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|sso)(?:[/?#]|$)/i.test(value);
  }
}

export function pageObservationHasAuthenticationEvidence(
  observation: AssistantPageObservation | undefined
) {
  if (!observation) return false;
  if ([401, 403].includes(observation.navigation.httpStatus ?? 0)) return true;
  if (observation.failedRequests.some((request) => [401, 403].includes(request.status ?? 0))) {
    return true;
  }
  if (authenticationUrlObserved(observation.finalUrl)) return true;
  return (observation.document.controls ?? []).some((control) => {
    if (!control.visible) return false;
    if (control.kind === "input" && control.inputType?.toLowerCase() === "password") return true;
    const label = `${control.accessibleName ?? ""} ${control.testId ?? ""}`;
    return /(?:登录|登陆|sign[\s_-]*in|log[\s_-]*in|password|密码)/i.test(label);
  });
}

function savedPageObservationKinds(observation: AssistantPageObservation) {
  const kinds = ["DOM", "console", "网络"];
  if (observation.screenshot) kinds.splice(1, 0, "截图");
  return kinds.join("、");
}

function isAutomaticBlankPageRecovery(observation: AssistantPageObservation | undefined) {
  const httpStatus = observation?.navigation.httpStatus;
  return Boolean(
    observation
    && observation.navigation.documentCommitted
    && observation.document.interactiveElementCount === 0
    && httpStatus !== undefined
    && httpStatus >= 200
    && httpStatus < 400
    && !observation.diagnosis.userActionRequired
  );
}

function asksForAuthentication(value: string) {
  return /(?:请|需要你|是否|能否).{0,24}(?:账号|密码|登录凭据|测试凭据|credential)/i.test(value);
}

function claimsSavedScreenshot(value: string) {
  return /(?:已|已经|成功)(?:保存|采集|生成).{0,16}截图|截图.{0,12}(?:已|已经)(?:保存|采集|生成)/i.test(value);
}

function startupFailureReply(input: AssistantFailureContext) {
  const diagnostic = input.projectDiagnostic!;
  const firstStage = diagnostic.failedStages?.[0];
  const missingEnv = diagnostic.failedStages
    ?.flatMap((stage) => stage.missingEnv ?? [])
    .filter(Boolean) ?? [];
  const portConflicts = diagnostic.failedStages
    ?.flatMap((stage) => stage.portConflicts ?? [])
    .map((item) => item.port) ?? [];
  const raw = firstStage?.humanMessage
    || firstStage?.reason
    || diagnostic.runtimeMessage
    || diagnostic.failureReason
    || "项目启动或连接检查没有通过";
  const problem = `项目尚未进入可测试状态：${humanizeFailureDetail(raw)}。`
    + (missingEnv.length ? ` 当前缺少运行变量：${missingEnv.slice(0, 4).join("、")}。` : "")
    + (portConflicts.length ? ` 检测到端口 ${portConflicts.slice(0, 4).join("、")} 被占用。` : "");
  const systemAction = diagnostic.recoverySummary
    ? `系统已保存启动阶段、健康检查和脱敏日志，并完成 AI 诊断：${compact(diagnostic.recoverySummary, 220)}。`
    : "系统已保存启动阶段、健康检查和脱敏日志；正式测试尚未开始，因此不会把启动失败误报为产品缺陷或测试通过。";
  const userAction = missingEnv.length
    ? "请通过项目凭据配置补齐这些变量，不要在对话中粘贴密钥；保存后可再次“诊断并运行”。"
    : portConflicts.length
      ? "可以让系统重新分配沙盒端口后重试；如果冲突进程属于当前项目，无需手动结束它。"
      : diagnostic.failureReason === "container_runtime_unavailable"
        ? "请允许系统启动 Docker Desktop/Podman；沙盒就绪后会重新尝试，不会降级到宿主机执行。"
        : "你可以再次“诊断并运行”；如果仍失败，可继续问我具体失败阶段，系统会依据已保存日志说明，而不是让你猜。";
  return {
    problem,
    systemAction,
    userAction,
    action: "none" as const
  };
}

function compact(value: string | undefined, limit = 260) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function humanizeFailureDetail(value: string) {
  const detail = compact(value, 220);
  if (/proof_bundle_missing_artifact|proof_invalid|evidence.*(?:missing|invalid)|artifact.*(?:missing|invalid)/i.test(detail)) {
    return "测试步骤已经执行并保存了证据，但步骤、断言与证据文件之间的关联校验没有通过";
  }
  if (/probe\.page_unavailable|page\.waitForFunction/i.test(detail)) {
    return "目标页面在等待时间内没有出现可操作内容，页面入口或加载状态尚未确认";
  }
  if (/page\.screenshot|taking page screenshot|截图.*(?:timeout|超时)/i.test(detail)) {
    return "页面截图没有在等待时间内完成，已有页面证据仍然保留";
  }
  if (/action_binding_failure|selector|locator/i.test(detail)) {
    return "当前页面没有找到与计划匹配的可验证控件";
  }
  if (/ERR_CONNECTION_REFUSED|connection refused|连接失败|无法访问/i.test(detail)) {
    return "目标服务暂时没有响应，需要确认项目是否已成功启动";
  }
  if (/timeout|timed out|超时/i.test(detail)) {
    return "当前操作在等待时间内没有完成";
  }
  return detail
    .replace(/\b(?:probe|page|locator)\.[\w.:-]+/gi, "页面检查")
    .replace(/\b(?:Timeout|Error):?\s*/gi, "")
    .replace(/\s*Call log:.*$/i, "")
    .trim();
}

export function requestedAssistantAction(message: string): AssistantFallbackAction | undefined {
  const normalized = message.replace(/\s+/g, "");
  const asksAQuestion = /(?:能否|是否|为什么|怎么|如何|是什么|可以吗|该怎么办|需要做什么|\?|？)/i.test(normalized);
  if (/查看.*(证据|截图|日志|trace)|打开.*(证据|截图|日志)/i.test(normalized)) return "open-evidence";
  if (/重试.*失败|重新.*失败|修复.*失败|重新绑定/i.test(normalized)) return "retry-failed-path";
  if (/继续.*(其他|剩余|安全|可执行)|跳过.*继续/i.test(normalized)) return "continue-safe-paths";
  if (/修改.*(计划|范围)|调整.*(计划|范围)/i.test(normalized)) return "revise-plan";
  if (!asksAQuestion && /暂停|先停一下/i.test(normalized)) return "pause-run";
  if (!asksAQuestion && /恢复|继续测试/i.test(normalized)) return "resume-run";
  if (!asksAQuestion && /取消|终止|停止测试/i.test(normalized)) return "cancel-run";
  if (!asksAQuestion && /开始测试|执行计划|开始执行/i.test(normalized)) return "start-run";
  return undefined;
}

function bindingFailureReply(input: AssistantFailureContext) {
  const failures = input.planning?.failures ?? [];
  const names = failures
    .map((item) => item.title ?? item.target)
    .filter((item): item is string => Boolean(item))
    .slice(0, 3);
  const details = failures
    .map((item) => humanizeFailureDetail(item.detail))
    .filter(Boolean)
    .slice(0, 2);
  const count = failures.length || Number(input.summary?.match(/(\d+)\s*条候选路径/)?.[1] ?? 0);
  const observation = input.pageObservation;
  const authenticationEvidence = pageObservationHasAuthenticationEvidence(observation);
  if (isAutomaticBlankPageRecovery(observation)) {
    const errorSummary = [
      observation!.pageErrors.length
        ? `${observation!.pageErrors.length} 个页面脚本异常`
        : "",
      observation!.failedRequests.length
        ? `${observation!.failedRequests.length} 个失败请求`
        : ""
    ].filter(Boolean).join("、");
    return {
      problem: `页面已返回 HTTP ${observation!.navigation.httpStatus}，但前端在当前等待窗口内尚未形成可操作界面，测试还没有进入业务步骤。`,
      systemAction: `系统已保存${savedPageObservationKinds(observation!)}观测`
        + (errorSummary ? `，发现 ${errorSummary}` : "")
        + "；没有发现 401/403、登录地址或登录控件，将按冷加载策略进行有限重试。",
      userAction: "无需操作，也无需提供账号密码。只有后续出现明确认证证据时，系统才会请求绑定测试凭据。",
      action: "none" as const
    };
  }
  const observedDetail = observation
    ? `${observation.diagnosis.summary}`
      + (observation.navigation.httpStatus ? ` HTTP ${observation.navigation.httpStatus}。` : "")
      + (observation.pageErrors.length ? ` 发现 ${observation.pageErrors.length} 个页面脚本异常。` : "")
      + (observation.failedRequests.length ? ` 发现 ${observation.failedRequests.length} 个失败请求。` : "")
    : "";
  const problem = `${count || "部分"}条候选测试路径在“页面入口、可操作控件、可验证结果”三项绑定中没有全部通过`
    + (names.length ? `，涉及${names.join("、")}` : "")
    + `。${observedDetail}`;
  const systemAction = observation
    ? `系统已保存当前 DOM 摘要、console、页面异常和网络失败信息`
      + (observation.screenshot ? "以及页面截图" : "")
      + "；将只重建失败路径。"
    : "系统已经保留页面扫描结果和失败诊断；可以重新读取当前 DOM、路由和网络请求，只重建失败路径。";
  const blockingQuestion = input.planning?.blockingQuestions?.find((question) =>
    authenticationEvidence || !asksForAuthentication(question)
  );
  const userAction = authenticationEvidence
    ? "页面观测已发现明确认证证据。请通过凭据配置绑定测试账号，不要在对话中发送密码；保存后可恢复当前测试。"
    : observation?.diagnosis.userActionRequired
      ? `请确认目标页面可在测试环境访问。观测提示：${observation.diagnosis.likelyCauses[0] ?? "页面入口或运行条件未就绪"}。当前没有认证证据，无需提供账号密码。`
    : blockingQuestion
    ? `需要你先确认：${blockingQuestion}`
    : "无需补充账号或猜测原因；可以直接重试失败链路，系统会使用已保存的页面观测数据重新绑定。";
  return {
    problem: details.length ? `${problem} 当前诊断：${details.join("；")}。` : problem,
    systemAction,
    userAction,
    action: "retry-failed-path" as const
  };
}

function executionFailureReply(input: AssistantFailureContext) {
  const assertion = input.failedAssertions?.[0];
  const problem = assertion
    ? `测试已经执行，但“${compact(assertion.name, 100)}”没有达到预期：期望${compact(assertion.expected, 120)}，实际${compact(assertion.actual, 120)}。`
    : `测试在“${compact(input.currentStep, 100) || "当前步骤"}”未能继续：${compact(input.latestLog || input.summary, 220) || "执行器没有返回可验证结果"}。`;
  return {
    problem,
    systemAction: "系统已保存失败步骤和已有证据，其他独立路径可以继续；失败链路可在沙盒中单独复现、诊断并重新验证。",
    userAction: "你可以先打开证据确认现象，或确认重试失败链路。涉及源码修改时，系统会另行展示 Diff 并再次征求确认。",
    action: "open-evidence" as const
  };
}

function blockedReply(input: AssistantFailureContext) {
  const rawDetail = compact(input.summary || input.latestLog, 260);
  const proofLinkFailure = /proof_bundle_missing_artifact|proof_invalid|evidence.*(?:missing|invalid)|artifact.*(?:missing|invalid)/i.test(rawDetail);
  if (proofLinkFailure) {
    return {
      problem: `当前测试处于${input.finalStatus === "blocked" ? "阻塞" : "等待确认"}状态：${humanizeFailureDetail(rawDetail)}。这表示可信度门禁没有放行，不代表被测项目本身存在缺陷。`,
      systemAction: "系统已经保留本次执行、截图、DOM、网络和 Trace；重新执行失败路径时会重建步骤到证据的关联，并再次校验完整性。",
      userAction: "确认“重试失败链路”即可。无需上传附件，也不需要修改项目源码。",
      action: "retry-failed-path" as const
    };
  }
  const problem = `当前测试处于${input.finalStatus === "blocked" ? "阻塞" : "等待确认"}状态：${humanizeFailureDetail(rawDetail) || "缺少继续执行所需的可验证条件"}。`;
  return {
    problem,
    systemAction: "系统保留了现有机器结论和证据，不会把调度完成误当成测试通过。",
    userAction: "请查看下方建议操作；如果你不知道如何选择，可以继续问“具体缺什么”，系统会结合当前项目状态回答。",
    action: "open-evidence" as const
  };
}

function neutralReply(input: AssistantFailureContext) {
  const state = input.runState || input.finalStatus;
  const statusText = state
    ? `当前机器状态是 ${humanizeFailureDetail(state)}`
    : "当前还没有可核验的正式运行结果";
  return {
    problem: `${statusText}；模型解释暂时不可用，但系统没有因此把测试标成失败或通过。`,
    systemAction: "系统保留了现有项目状态、计划和证据；确定性控制命令仍可继续使用。",
    userAction: "你可以继续询问状态或选择下一步操作；需要语义分析时，待模型恢复后可重新提问。",
    action: "none" as const
  };
}

export function assistantReplyNeedsNormalization(input: {
  reply?: string;
  reasoningSummary?: {
    observations?: string[];
    assessment?: string;
    nextStep?: string;
    userAction?: string;
  };
  pageObservation?: AssistantFailureContext["pageObservation"];
}) {
  const text = [
    input.reply,
    ...(input.reasoningSummary?.observations ?? []),
    input.reasoningSummary?.assessment,
    input.reasoningSummary?.nextStep,
    input.reasoningSummary?.userAction
  ].filter(Boolean).join(" ");
  const contradictsAuthenticationEvidence = Boolean(
    input.pageObservation
    && !pageObservationHasAuthenticationEvidence(input.pageObservation)
    && asksForAuthentication(text)
  );
  const inventsScreenshot = Boolean(
    input.pageObservation
    && !input.pageObservation.screenshot
    && claimsSavedScreenshot(text)
  );
  return /\b(?:proof_bundle_missing_artifact|proof_invalid|operation_[a-z0-9_-]+|conclusion_[a-z0-9_-]+|evidence_[a-z0-9_-]+)\b/i.test(text)
    || /上传.*(?:缺失|证明|证据).*(?:附件|文件)/i.test(text)
    || contradictsAuthenticationEvidence
    || inventsScreenshot;
}

export function buildDeterministicAssistantFallback(input: AssistantFailureContext) {
  const failures = input.planning?.failures ?? [];
  const startupFailure = Boolean(
    input.projectDiagnostic
    && (
      input.projectDiagnostic.runtimeStatus === "failed"
      || input.projectDiagnostic.failedStages?.length
    )
  );
  const bindingFailure = failures.some((item) => item.stage === "binding")
    || /页面绑定|候选路径|入口.*控件|安全执行的路径|无法形成.*路径/i.test(`${input.summary ?? ""} ${input.latestLog ?? ""}`)
    || Boolean(
      input.pageObservation?.navigation.documentCommitted
      && input.pageObservation.document.interactiveElementCount === 0
    );
  const executionFailure = Boolean(input.failedAssertions?.length)
    || /执行失败|断言|timeout|超时|无法访问|连接失败/i.test(`${input.summary ?? ""} ${input.latestLog ?? ""}`);
  const explicitlyBlocked = ["blocked", "needs-human-review", "awaiting-human-review", "failed", "fail"]
    .includes(input.finalStatus ?? input.runState ?? "");
  const explanation = startupFailure
    ? startupFailureReply(input)
    : bindingFailure
      ? bindingFailureReply(input)
      : executionFailure
        ? executionFailureReply(input)
        : explicitlyBlocked
          ? blockedReply(input)
          : neutralReply(input);
  const explicitAction = requestedAssistantAction(input.userMessage);
  const action = explicitAction ?? explanation.action;
  const intent = ["pause-run", "resume-run", "cancel-run", "start-run"].includes(action)
    ? "execution-control"
    : action === "revise-plan"
      ? "plan-change"
      : startupFailure || bindingFailure || executionFailure
        ? "failure-question"
        : "status-question";
  const reply = [
    `遇到的问题：${explanation.problem}`,
    `系统已经做了什么：${explanation.systemAction}`,
    `需要你做什么：${explanation.userAction}`
    ].join("\n");
  return {
    reply,
    intent,
    reasoningSummary: {
      phase: "waiting-user" as const,
      observations: [
        humanizeFailureDetail(input.summary ?? "") || explanation.problem,
        input.evidenceCount !== undefined ? `当前已保存 ${input.evidenceCount} 条证据。` : "当前诊断状态已保留。"
      ],
      assessment: explanation.problem,
      nextStep: explanation.systemAction,
      userAction: explanation.userAction,
      confidence: "high" as const
    },
    suggestedAction: action,
    requiresConfirmation: !["none", "open-evidence"].includes(action),
    knowledge: knowledgeBoundaryOutputSchema.parse({
      schemaVersion: "2.0",
      factsUsed: [],
      inferences: [],
      assumptions: [],
      unknowns: [],
      toolRequests: [],
      blockingQuestions: input.planning?.blockingQuestions ?? [],
      proposedActions: []
    })
  };
}

export function deterministicAssistantCall(error: unknown, input: {
  provider?: string;
  model?: string;
  durationMs?: number;
}) {
  const raw = error instanceof Error ? error.message : "assistant_model_failed";
  const errorCode = /not_configured/i.test(raw)
    ? "assistant_model_not_configured"
    : /401|403|credential|api[_ ]?key/i.test(raw)
      ? "assistant_credential_invalid"
      : /output_truncated|truncated/i.test(raw)
        ? "assistant_output_truncated"
        : /timeout|incomplete|network|fetch/i.test(raw)
          ? "assistant_provider_timeout"
          : /validation|schema|json/i.test(raw)
            ? "assistant_output_invalid"
            : "assistant_model_failed";
  return {
    id: `assistant_fallback_${randomUUID()}`,
    provider: input.provider ?? "deterministic",
    model: input.model ?? "evidence-interpreter",
    status: "failed",
    durationMs: input.durationMs ?? 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    semanticRepairApplied: false,
    fallbackApplied: true,
    errorCode
  };
}

export function deterministicAssistantCommandCall() {
  return {
    id: `assistant_command_${randomUUID()}`,
    provider: "deterministic",
    model: "command-router-v1",
    status: "passed",
    durationMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    semanticRepairApplied: false,
    fallbackApplied: false
  };
}
