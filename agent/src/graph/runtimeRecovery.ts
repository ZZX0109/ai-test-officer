import { randomUUID } from "node:crypto";
import type { AgentGraphState } from "@ai-test-officer/agent-orchestration";
import { finalizeProofBundle } from "../proof/proofBundleService.js";
import { getProject } from "../projectAdapter.js";
import { getProjectLoginSummary } from "../projectLoginStore.js";
import { observationShowsAuthenticationBoundary } from "../browser-agent/login.js";
import { runSmokeFirstDiscovery } from "../smokeFirstDiscovery.js";
import type { RunProjection } from "../runEventStore.js";
import type { EvidenceItem, SourceReadEnvelope } from "../types.js";
import type { MachineGate, RecoveryDecision } from "@ai-test-officer/contracts";

export function requiresFullCoverage(run: RunProjection) {
  return run.runKind === "parent" && (
    run.input.coverageMode === "full"
    || /全面|灰度|full[\s_-]*(scan|coverage)|all[\s_-]*(paths|flows)/i.test(String(run.input.requirement ?? ""))
  );
}

export function requiresActiveBrowserDiscovery(
  run: RunProjection,
  manifestBrowserCapability = true
) {
  const requestedCapabilities = Array.isArray(run.input.capabilities)
    ? run.input.capabilities.filter((item): item is string => typeof item === "string")
    : ["browser"];
  return requiresFullCoverage(run)
    && requestedCapabilities.includes("browser")
    && manifestBrowserCapability;
}

export function discoveryCanHandOffToDynamicBrowser(input: {
  dynamicBrowser: boolean;
  documentCommitted: boolean;
  httpStatus?: number;
}) {
  const status = input.httpStatus ?? 200;
  return input.dynamicBrowser
    && input.documentCommitted
    && status >= 200
    && status < 400;
}

const MAX_RECOVERY_ATTEMPTS = {
  "retry-runtime": 2,
  "retry-discovery": 2,
  "retry-path": 2
} as const;

export function recoveryEvidenceRefs(state: AgentGraphState): string[] {
  const refs = new Set<string>();
  const discovery = state.coverageMap?.discovery;
  if (discovery && typeof discovery === "object" && Array.isArray((discovery as Record<string, unknown>).evidence)) {
    for (const item of (discovery as { evidence: Array<{ id?: string }> }).evidence) {
      if (item.id) refs.add(item.id);
    }
  }
  const failureRefs = state.failure && Array.isArray(state.failure.evidenceRefs) ? state.failure.evidenceRefs : [];
  for (const ref of failureRefs) if (typeof ref === "string") refs.add(ref);
  return [...refs].slice(0, 20);
}

export async function credentialInterruptMeta(projectId?: string): Promise<{ hasSavedCredential: boolean; usernameMasked?: string }> {
  if (!projectId) return { hasSavedCredential: false };
  try {
    const project = await getProject(projectId);
    const credentialId = project?.login?.credentialId;
    if (!credentialId) return { hasSavedCredential: false };
    const summary = await getProjectLoginSummary(credentialId);
    if (!summary) return { hasSavedCredential: false };
    return { hasSavedCredential: true, usernameMasked: summary.usernameMasked };
  } catch {
    return { hasSavedCredential: false };
  }
}

export function deterministicRecoveryDecision(state: AgentGraphState): RecoveryDecision {
  const now = new Date().toISOString();
  const discovery = state.coverageMap?.discovery;
  const discoveryReason = discovery && typeof discovery === "object"
    ? String((discovery as Record<string, unknown>).reason ?? "")
    : "";
  const failureReason = Array.isArray(state.failure?.reasons)
    ? state.failure.reasons.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("; ")
    : "";
  const reason = (discoveryReason.trim() || failureReason.trim() || "测试路径未完成，已保留失败证据并等待下一步处理");
  const lower = reason.toLowerCase();
  const evidenceRefs = recoveryEvidenceRefs(state);
  let action: RecoveryDecision["action"] = "blocked";
  let userQuestion: string | undefined;
  const expectedFixtureFault = state.failure?.expectedFixtureFault === true;
  if (expectedFixtureFault) {
    action = "blocked";
    userQuestion = "已按测试场景触发接口故障并采集网络与页面证据；这不是沙盒启动故障，因此不会重启项目或覆盖该 Attempt。";
  } else if (/artifact[_-]?object|object[ _-]?store|minio|\bs3\b|econnrefused|fetch failed/i.test(lower)) {
    action = "blocked";
    userQuestion = "测试步骤已执行，但证据对象存储当前不可用；系统已阻止正式提交，不会将此问题归为被测项目缺陷。请恢复对象存储后新建或重试该路径。";
  } else if (observationShowsAuthenticationBoundary(state.browserObservation)
    || (/credential|凭据|401|403|unauthorized|未登录/i.test(lower) && Boolean(state.browserObservation))) {
    action = "request-credentials";
    userQuestion = "页面要求登录，请配置测试账号后继续 Discovery。";
  } else if (state.discoveryTerminal === true) {
    action = /port|health|docker|sandbox|启动|连接|unreachable|timeout/i.test(lower)
      ? "retry-runtime"
      : "retry-discovery";
  } else if (state.failure?.status && state.failure.status !== "pass") {
    if (state.failure.failureClass === "evidence") {
      action = "blocked";
      userQuestion = "测试步骤已完成，但 AI 测试官自身的证据账本校验异常；系统不会把它当作外部项目缺陷，也不会修改你的项目。";
    } else action = state.failure.failureClass === "environment" ? "retry-runtime"
      : state.failure.failureClass === "test-script" ? "repair-harness"
        : state.failure.failureClass === "product-bug" ? "repair-product"
          : "retry-path";
  }
  const attempts = state.recoveryAttempts?.[action] ?? 0;
  const max = action in MAX_RECOVERY_ATTEMPTS ? MAX_RECOVERY_ATTEMPTS[action as keyof typeof MAX_RECOVERY_ATTEMPTS] : 1;
  if (attempts >= max && action !== "blocked") {
    action = "blocked";
    userQuestion = `恢复动作已达到上限（${max} 次），请查看运行详情后决定下一步。`;
  }
  return {
    schemaVersion: "1.0",
    id: `recovery_${randomUUID()}`,
    runId: state.runId,
    attemptId: state.currentAttemptId,
    action,
    reason,
    confidence: evidenceRefs.length ? "high" : "low",
    evidenceRefs,
    preconditions: action === "retry-runtime" ? ["项目路径和启动配置存在"] : [],
    expectedState: action === "request-credentials" ? "等待用户配置测试账号" : action === "blocked" ? "等待人工处理" : "重新进入可执行测试阶段",
    ...(userQuestion ? { userQuestion } : {}),
    createdAt: now,
    policyVersion: "recovery-policy-v1"
  };
}

export function discoverySourceContexts(run: RunProjection): SourceReadEnvelope[] {
  const now = new Date().toISOString();
  const sources: SourceReadEnvelope[] = [];
  if (typeof run.input.requirement === "string" && run.input.requirement.trim()) {
    sources.push({
      id: "run_requirement", kind: "manual", title: "Run requirement", status: "connected",
      summary: run.input.requirement, permissionState: "not_required", isSimulated: false,
      evidenceUse: "primary_requirement", displayStatus: "ready", readAt: now, trustLevel: "medium"
    });
  }
  if (typeof run.input.diff === "string" && run.input.diff.trim()) {
    sources.push({
      id: "run_diff", kind: "git_diff", title: "Run diff", status: "connected",
      summary: run.input.diff, permissionState: "not_required", isSimulated: false,
      evidenceUse: "change_context", displayStatus: "ready", readAt: now, trustLevel: "high"
    });
  }
  return sources;
}

export function discoveryState(result: Awaited<ReturnType<typeof runSmokeFirstDiscovery>>) {
  const orchestration = result.orchestration;
  const status = orchestration?.status ?? (result.status === "passed" ? "ready" : "failed");
  return {
    status,
    reason: orchestration?.reason ?? result.observation.diagnosis.summary ?? result.message,
    retryable: orchestration?.retryable ?? result.observation.diagnosis.retryable,
    checkedUrl: orchestration?.checkedUrl ?? result.target.frontendUrl,
    attempts: orchestration?.attempts ?? 0,
    maxAttempts: orchestration?.maxAttempts ?? 0,
    discoveryAttempts: orchestration?.discoveryAttempts ?? 0,
    observationId: result.observation.id,
    documentCommitted: result.observation.navigation.documentCommitted,
    interactiveElementCount: result.observation.document.interactiveElementCount
  };
}

export function buildDiscoveryEvidence(
  scan: Awaited<ReturnType<typeof runSmokeFirstDiscovery>>,
  runId: string
): EvidenceItem[] {
  const obs = scan.observation;
  if (!obs) return [];
  const now = new Date().toISOString();
  const base = { runId, timestamp: now, attempt: 0, sequence: 0 } as const;
  const items: EvidenceItem[] = [];
  items.push({
    ...base,
    id: `discovery-page-${obs.id}`,
    type: "network",
    title: `页面观测：${obs.finalUrl || (scan.orchestration?.checkedUrl ?? "unknown")}`,
    url: obs.finalUrl,
    locator: {
      pageUrl: obs.finalUrl,
      sourceLocation: `httpStatus=${obs.navigation.httpStatus ?? "n/a"}`,
      lineStart: obs.navigation.documentCommitted ? undefined : 0
    },
    payload: {
      httpStatus: obs.navigation.httpStatus,
      documentCommitted: obs.navigation.documentCommitted,
      interactiveElementCount: obs.document.interactiveElementCount,
      stage: obs.stage,
      bodyTextSample: obs.document.bodyTextSample?.slice(0, 500)
    }
  });
  if (obs.failedRequests.length) {
    items.push({
      ...base,
      id: `discovery-network-${obs.id}`,
      type: "network",
      title: `失败请求（${obs.failedRequests.length}）`,
      url: obs.finalUrl,
      payload: { failedRequests: obs.failedRequests.slice(0, 12) }
    });
  }
  const errors = [
    ...obs.pageErrors,
    ...obs.console.filter((entry) => /error|exception|failed/i.test(entry.type)).map((entry) => entry.text)
  ];
  if (errors.length) {
    items.push({
      ...base,
      id: `discovery-console-${obs.id}`,
      type: "console",
      title: `控制台与页面错误（${errors.length}）`,
      url: obs.finalUrl,
      payload: { errors: errors.slice(0, 20) }
    });
  }
  if (obs.screenshot) {
    items.push({
      ...base,
      id: `discovery-screenshot-${obs.id}`,
      type: "screenshot",
      title: "Discovery 截图",
      file: obs.screenshot.storageUri,
      url: obs.finalUrl,
      locator: { pageUrl: obs.finalUrl },
      payload: { storageUri: obs.screenshot.storageUri }
    });
  }
  if (obs.document.accessibilityTree) {
    items.push({
      ...base,
      id: `discovery-dom-${obs.id}`,
      type: "dom",
      title: "DOM 摘要（ARIA）",
      url: obs.finalUrl,
      payload: { accessibilityTree: obs.document.accessibilityTree.slice(0, 2000) }
    });
  }
  if (obs.browserLifecycle?.length) {
    items.push({
      ...base,
      id: `discovery-lifecycle-${obs.id}`,
      type: "console",
      title: "浏览器启动与端口探测",
      payload: { browserLifecycle: obs.browserLifecycle }
    });
  }
  return items;
}

export function discoveryBlockedGate(
  discovery: Record<string, unknown>,
  runId: string,
  evidence: EvidenceItem[] = []
): MachineGate {
  const status = String(discovery.status ?? "failed");
  const reason = String(discovery.reason ?? "discovery_smoke_failed");
  const evidenceRefs = evidence.map((item) => item.id);
  const reasonDetails = evidenceRefs.length
    ? [{
        code: "environment_unavailable",
        summary: `discovery_${status}:${reason}`,
        evidenceRefs: evidenceRefs.slice(0, 8)
      }]
    : [];
  return finalizeProofBundle({
    draft: {
      status: "blocked",
      reasons: [`discovery_${status}:${reason}`],
      reasonDetails,
      assertionFailures: []
    },
    runId,
    evidence,
    machineGate: {
      status: "blocked",
      reasons: [`discovery_${status}:${reason}`],
      reasonDetails,
      assertionFailures: []
    }
  }).machineGate;
}
