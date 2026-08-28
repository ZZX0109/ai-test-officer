import type { AuditStoreStatus, PlanningConversationResult } from "./types";

export type PlanningAutomationPhase =
  | "idle"
  | "preparing-project"
  | "discovering"
  | "binding"
  | "starting-run"
  | "running"
  | "ready"
  | "needs-permission"
  | "needs-credentials"
  | "blocked";

export function auditStoreClass(auditStore: AuditStoreStatus | null) {
  if (!auditStore) return "warning";
  if (auditStore.schemaVersionMatches === false || auditStore.migrationComplete === false || auditStore.integrityOk === false) {
    return "failed";
  }
  return "passed";
}

export function hasBlockingPlanningQuestions(result: PlanningConversationResult) {
  return result.clarificationQuestions.some((question) =>
    /可能修改数据|沙盒测试数据|哪些操作禁止|暂未识别到页面|最重要的入口页面/.test(question)
  );
}

export function isPlanningAutomationBusy(phase: PlanningAutomationPhase) {
  return ["preparing-project", "discovering", "binding", "starting-run", "running"].includes(phase);
}

export function userFacingAutomationError(raw: string) {
  if (/coverage_(?:blocked|failed|excluded):/i.test(raw)) {
    return userFacingCoverageText(raw);
  }
  if (/browser[_ -]?(?:control|permission)|permission.*browser|浏览器.*权限/i.test(raw)) {
    return "还没有允许本次内置浏览器操作。点击“允许本次浏览器操作并继续”后，系统才会开始真实点击页面。";
  }
  if (/project[_ -]?(?:not[_ -]?ready|runtime)|项目.*(?:未准备|未启动|不可运行)/i.test(raw)) {
    return "项目还没有准备好。请先完成项目诊断，确认页面可以打开后再开始测试。";
  }
  if (/frontend[_ -]?(?:unreachable|health)|页面.*(?:无法|打不开)/i.test(raw)) {
    return "测试页面暂时无法打开。系统已保留启动和连接诊断，可以重新运行项目准备。";
  }
  if (/Scenario draft probe failed|fix missingInfo|probe\.page_|selectorProbeStatus/i.test(raw)) {
    return "真实页面路径暂未通过可执行性校验。缺少的入口、控件或预期结果已交给左侧 AI 测试助手处理。";
  }
  if (/compiled_plan_missing|plan(?:ning)?[_ -](?:contract|schema|validation)|action[_ -]?dsl|invalid[_ -]?(?:plan|dsl)|zod/i.test(raw)) {
    return "测试运行没有成功创建：计划数据未通过契约校验。系统不会把它误报为浏览器安全拦截，请重新生成计划后继续。";
  }
  let detail = raw;
  if (/^\s*[\[{]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = [parsed.message, parsed.detail, parsed.reason, parsed.error]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      detail = candidate ?? "自动化执行未完成；系统已保留当前阶段和证据，请查看处理依据。";
    } catch {
      detail = "自动化执行未完成；后端返回了无法解析的错误信息，系统已保留原始诊断。";
    }
  }
  return detail.length > 260 ? `${detail.slice(0, 257)}…` : detail;
}

/** Translate proof-graph identifiers into a user-facing coverage explanation.
 * The original identifiers remain available in technical details and exports,
 * but should never be the primary error copy in a narrow assistant rail. */
export function userFacingCoverageText(value: string | undefined) {
  if (!value) return "";
  const blocked = value.match(/coverage_blocked:[^;；\s。.!！?？]+/gi) ?? [];
  const failed = value.match(/coverage_failed:[^;；\s。.!！?？]+/gi) ?? [];
  const excluded = value.match(/coverage_excluded:[^;；\s。.!！?？]+/gi) ?? [];
  if (!blocked.length && !failed.length && !excluded.length) return value;
  const parts = [
    failed.length ? `${failed.length} 条路径验证失败` : undefined,
    blocked.length ? `${blocked.length} 条路径缺少可执行入口、操作条件或验证条件` : undefined,
    excluded.length ? `${excluded.length} 条路径不适用于本次运行` : undefined
  ].filter(Boolean);
  const explanation = parts.join("；");
  // Result summaries can be made entirely from coverage references, while an
  // assistant reply can contain those same references inside a fuller answer.
  // Do not replace the latter wholesale: that was discarding the answer the
  // user actually asked for and leaving only the generic coverage sentence.
  const technicalRef = /coverage_(?:blocked|failed|excluded):[^;；\s。.!！?？]+/gi;
  const nonTechnicalRemainder = value
    .replace(technicalRef, "")
    .replace(/[\s,，;；:：、.。\-—|()[\]{}]/g, "")
    .trim();
  if (!nonTechnicalRemainder) {
    return `本次业务功能没有全部验证完成：${explanation}。系统已保留已执行路径的页面、断言和证据，因此不会误判为通过。`;
  }
  let insertedExplanation = false;
  return value
    .replace(technicalRef, () => {
      if (insertedExplanation) return "";
      insertedExplanation = true;
      return `（${explanation}）`;
    })
    .replace(/[；;]\s*[；;]+/g, "；")
    .replace(/[；;]\s*(?=[。.!！?？]|$)/g, "");
}

export function coverageTechnicalRefs(value: string | undefined) {
  if (!value) return [];
  return [...new Set(value.match(/coverage_(?:blocked|failed|excluded):[^;；\s。.!！?？]+/gi) ?? [])];
}

export function boundedAssistantText(value: unknown, limit: number) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const compact = text
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|afk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

export function userFacingPlanningText(value: string) {
  return value
    .replace(/\boracle\b/gi, "验证条件")
    .replace(/页面绑定/g, "页面确认");
}

export function userFacingAssistantError(error: unknown) {
  const detail = error instanceof Error ? error.message : "模型调用失败";
  if (/llm_budget_exceeded|assistant_budget_exceeded/i.test(detail)) {
    return "这次对话在发送给模型前被预算检查拦下，没有产生模型回答。系统不会再用固定测试模板冒充回复；可精简上下文后重试。";
  }
  if (/Validation failed|fieldErrors|provider_http_400/i.test(detail)) {
    return "模型解释请求没有通过格式校验。系统已压缩上下文，你可以直接重新发送问题；机器结论和证据不受影响。";
  }
  if (/output_truncated|assistant_output_truncated/i.test(detail)) {
    return "模型已经返回回答，但结构化内容在结尾被截断。系统会保留当前诊断并使用更大的输出预算重试，不会清除机器结论或证据。";
  }
  if (/401|403|credential|api[_ ]?key|model_not_configured/i.test(detail)) {
    return "当前模型凭据不可用。请在右上角 API Key 配置中检查凭据后重新发送；现有测试不会被放行或清除。";
  }
  if (/timeout|incomplete|network|fetch/i.test(detail)) {
    return "模型服务本次没有在时限内完成回答。可以直接重试，机器结论和已保存证据不会变化。";
  }
  return "AI 测试官本次没有返回有效回答。系统已保留运行状态和证据，你可以重新发送问题或查看技术详情。";
}

export function auditStoreSummary(auditStore: AuditStoreStatus | null) {
  if (!auditStore) return "—";
  const version = auditStore.userVersion !== undefined
    ? `schema ${auditStore.schemaVersion}/user ${auditStore.userVersion}`
    : `schema ${auditStore.schemaVersion}`;
  const health = [
    auditStore.schemaVersionMatches === false ? "version mismatch" : undefined,
    auditStore.migrationComplete === false ? `missing migrations ${(auditStore.missingMigrations ?? []).join(",") || "unknown"}` : undefined,
    auditStore.integrityOk === false ? `integrity ${auditStore.integrityCheck ?? "failed"}` : undefined
  ].filter(Boolean);
  return `${auditStore.journalMode} · ${version} · ${health.length ? health.join(" · ") : "healthy"} · runs ${auditStore.runs}`;
}
