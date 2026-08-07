import type {
  DiscoveryScanResult,
  DiscoveryLifecycleEvent,
  ProjectRuntimeStatus,
  SourceReadEnvelope,
  TargetAppRuntime
} from "./types.js";
import { getProjectRuntimeStatusWithRecovery, resolveProjectTarget } from "./projectAdapter.js";
import { runDiscoveryScan } from "./discoveryScan.js";
import {
  sanitizeDiscoveryPageObservation,
  writeDiscoveryPageObservation
} from "./pageObservationStore.js";

export type DiscoveryOrchestrationStatus = "waiting" | "ready" | "blocked" | "failed";

export interface DiscoveryConnectivityResult {
  status: DiscoveryOrchestrationStatus;
  checkedUrl: string;
  attempts: number;
  maxAttempts: number;
  reason: string;
  retryable: boolean;
  runtimeStatus?: ProjectRuntimeStatus["status"];
  httpStatus?: number;
}

export interface SmokeFirstDiscoveryMetadata extends DiscoveryConnectivityResult {
  discoveryAttempts: number;
}

type FetchLike = typeof fetch;

const DEFAULT_SMOKE_ATTEMPTS = 2;
const DEFAULT_SMOKE_TIMEOUT_MS = 3_000;
const DEFAULT_DISCOVERY_ATTEMPTS = 2;

function wait(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function savedObservationKinds(result: DiscoveryScanResult) {
  const kinds = ["DOM", "console", "网络"];
  if (result.observation.screenshot) kinds.splice(1, 0, "截图");
  return kinds.join("、");
}

function isAutomaticBlankPageRecovery(result: DiscoveryScanResult) {
  const status = result.observation.navigation.httpStatus;
  return result.observation.navigation.documentCommitted
    && result.observation.document.interactiveElementCount === 0
    && status !== undefined
    && status >= 200
    && status < 400
    && !result.observation.diagnosis.userActionRequired;
}

function normalizeAutomaticBlankPageObservation(result: DiscoveryScanResult) {
  if (!isAutomaticBlankPageRecovery(result)) return result.observation;
  return {
    ...result.observation,
    status: "degraded" as const,
    diagnosis: {
      ...result.observation.diagnosis,
      summary: `页面已返回 HTTP ${result.observation.navigation.httpStatus}，但前端在当前等待窗口内尚未形成可操作界面。`,
      likelyCauses: Array.from(new Set([
        ...result.observation.diagnosis.likelyCauses,
        "前端可能仍在冷加载或初始化"
      ])).slice(0, 4),
      retryable: true,
      userActionRequired: false
    }
  };
}

function blockedRuntimeReason(reason: ProjectRuntimeStatus["failureReason"]) {
  return new Set([
    "config_missing",
    "project_path_missing",
    "credential_missing",
    "permission_denied",
    "container_runtime_unavailable",
    "command_not_found",
    "dependency_missing",
    "port_conflict"
  ]).has(reason ?? "unknown");
}

function runtimeGate(runtime: ProjectRuntimeStatus | undefined, checkedUrl: string): DiscoveryConnectivityResult | undefined {
  if (!runtime || runtime.status === "running") return undefined;
  // An idle trusted-local project may already be served by another managed
  // process, so still probe its declared URL. OCI recovery explicitly reports
  // that its sandbox inspection is in progress and must stay in waiting.
  const recoveringSandbox = runtime.status === "idle" && /后台检查|checking.*sandbox/i.test(runtime.message);
  if (recoveringSandbox || ["installing", "starting", "stopped"].includes(runtime.status)) {
    return {
      status: "waiting",
      checkedUrl,
      attempts: 0,
      maxAttempts: DEFAULT_SMOKE_ATTEMPTS,
      reason: runtime.message || "项目仍在准备运行环境，Discovery 尚未开始。",
      retryable: true,
      runtimeStatus: runtime.status
    };
  }
  if (runtime.status === "failed") {
    const blocked = blockedRuntimeReason(runtime.failureReason);
    return {
      status: blocked ? "blocked" : "failed",
      checkedUrl,
      attempts: 0,
      maxAttempts: DEFAULT_SMOKE_ATTEMPTS,
      reason: runtime.message || runtime.failureReason || "项目运行环境未通过检查。",
      retryable: !blocked,
      runtimeStatus: runtime.status
    };
  }
  return undefined;
}

function connectivityErrorReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return "connectivity_smoke_timeout";
  if (/fetch failed|connection|refused|reset|unreachable/i.test(message)) return "connectivity_smoke_unreachable";
  return `connectivity_smoke_failed:${message.replace(/\s+/g, "_").slice(0, 120)}`;
}

export async function probeDiscoveryConnectivity(input: {
  projectId?: string;
  appUrl?: string;
  target?: TargetAppRuntime;
  runtimeStatus?: ProjectRuntimeStatus;
  maxAttempts?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<DiscoveryConnectivityResult> {
  const target = input.target ?? await resolveProjectTarget(input);
  const checkedUrl = input.projectId ? target.frontendUrl : input.appUrl ?? target.frontendUrl;
  const maxAttempts = Math.max(1, Math.min(3, input.maxAttempts ?? DEFAULT_SMOKE_ATTEMPTS));
  const timeoutMs = Math.max(250, Math.min(10_000, input.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS));
  const runtime = input.runtimeStatus
    ?? (input.projectId ? await getProjectRuntimeStatusWithRecovery(input.projectId) : undefined);
  const gated = runtimeGate(runtime, checkedUrl);
  if (gated) return { ...gated, maxAttempts };

  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? wait;
  let lastReason = "connectivity_smoke_failed";
  let lastHttpStatus: number | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(checkedUrl, {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.5" },
        redirect: "follow",
        signal: controller.signal
      });
      lastHttpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 400) {
        return {
          status: "ready",
          checkedUrl,
          attempts: attempt,
          maxAttempts,
          reason: `connectivity_smoke_passed:http_${response.status}`,
          retryable: false,
          runtimeStatus: runtime?.status,
          httpStatus: response.status
        };
      }
      if ([401, 403].includes(response.status)) {
        return {
          status: "blocked",
          checkedUrl,
          attempts: attempt,
          maxAttempts,
          reason: `connectivity_smoke_auth_required:http_${response.status}`,
          retryable: false,
          runtimeStatus: runtime?.status,
          httpStatus: response.status
        };
      }
      if (response.status >= 400 && response.status < 500) {
        return {
          status: "blocked",
          checkedUrl,
          attempts: attempt,
          maxAttempts,
          reason: `connectivity_smoke_invalid_target:http_${response.status}`,
          retryable: false,
          runtimeStatus: runtime?.status,
          httpStatus: response.status
        };
      }
      lastReason = `connectivity_smoke_upstream_error:http_${response.status}`;
    } catch (error) {
      lastReason = connectivityErrorReason(error);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < maxAttempts) await sleep(attempt === 1 ? 250 : 1_000);
  }
  return {
    status: "failed",
    checkedUrl,
    attempts: maxAttempts,
    maxAttempts,
    reason: lastReason,
    retryable: true,
    runtimeStatus: runtime?.status,
    httpStatus: lastHttpStatus
  };
}

function deferredDiscoveryResult(
  target: TargetAppRuntime,
  smoke: DiscoveryConnectivityResult
): DiscoveryScanResult {
  const createdAt = new Date().toISOString();
  const id = `discovery_smoke_${Date.now()}`;
  const waiting = smoke.status === "waiting";
  const blocked = smoke.status === "blocked";
  const message = waiting
    ? `Discovery 等待项目就绪：${smoke.reason}`
    : blocked
      ? `Discovery 被运行前置条件阻塞：${smoke.reason}`
      : `Discovery 连通性检查失败：${smoke.reason}`;
  const lifecycle: DiscoveryLifecycleEvent[] = [
    { stage: "project_started", status: "passed", at: createdAt, message: "已解析项目运行目标。", url: smoke.checkedUrl },
    {
      stage: "health_checked",
      status: smoke.status === "blocked" ? "blocked" : smoke.status === "failed" ? "failed" : "pending",
      at: createdAt,
      message: smoke.reason,
      url: smoke.checkedUrl
    },
    ...(["browser_ready", "page_loaded", "authenticated", "discovery_completed", "plan_generated"] as const).map((stage) => ({
      stage,
      status: "pending" as const,
      at: createdAt,
      message: "等待运行前置条件通过。",
      url: smoke.checkedUrl
    }))
  ];
  return {
    id,
    createdAt,
    target,
    page: {
      url: smoke.checkedUrl,
      headings: [],
      links: [],
      buttons: [],
      inputs: [],
      forms: [],
      testIds: []
    },
    networkEndpoints: [],
    openApiOperations: [],
    observation: sanitizeDiscoveryPageObservation({
      id,
      requestedUrl: smoke.checkedUrl,
      finalUrl: smoke.checkedUrl,
      startedAt: createdAt,
      capturedAt: createdAt,
      durationMs: 0,
      stage: "launch",
      status: "failed",
      navigation: { documentCommitted: false, httpStatus: smoke.httpStatus },
      document: { interactiveElementCount: 0, controls: [] },
      console: [],
      pageErrors: [],
      failedRequests: [],
      diagnosis: {
        summary: message,
        likelyCauses: [smoke.reason],
        retryable: smoke.retryable,
        userActionRequired: blocked
      }
    }),
    suggestions: [],
    drafts: [],
    lifecycle,
    status: "failed",
    message,
    orchestration: {
      ...smoke,
      discoveryAttempts: 0
    }
  };
}

function discoveryTerminalStatus(result: DiscoveryScanResult): DiscoveryOrchestrationStatus {
  if (
    result.status === "passed"
    && result.observation.navigation.documentCommitted
    && result.observation.document.interactiveElementCount > 0
  ) return "ready";
  if (result.observation.diagnosis.userActionRequired) return "blocked";
  return "failed";
}

function lifecycleForResult(
  smoke: DiscoveryConnectivityResult,
  result: DiscoveryScanResult,
  discoveryAttempts: number
): DiscoveryLifecycleEvent[] {
  const at = new Date().toISOString();
  const url = result.observation.finalUrl || smoke.checkedUrl;
  const pageLoaded = result.observation.navigation.documentCommitted;
  const browserReady = pageLoaded || result.observation.stage !== "launch";
  const loginPage = /(?:\/signin|\/login)(?:[/?#]|$)/i.test(url)
    || result.page.inputs.some((input) => /password|邮箱|email|用户名|username/i.test(`${input.label ?? ""} ${input.name ?? ""}`));
  const discoveryStatus = result.status === "passed" ? "passed" : result.observation.diagnosis.userActionRequired ? "blocked" : "failed";
  return [
    { stage: "project_started", status: "passed", at, message: "已解析项目运行目标。", url: smoke.checkedUrl },
    {
      stage: "health_checked",
      status: smoke.status === "ready" ? "passed" : smoke.status === "blocked" ? "blocked" : "failed",
      at,
      message: smoke.reason,
      url: smoke.checkedUrl
    },
    {
      stage: "browser_ready",
      status: browserReady ? "passed" : "failed",
      at,
      message: browserReady ? "Playwright 已创建浏览器页面。" : "Playwright 页面未创建或未提交文档。",
      url
    },
    {
      stage: "page_loaded",
      status: pageLoaded ? "passed" : "failed",
      at,
      message: pageLoaded ? `页面已提交：${url}` : "页面未提交可观测文档。",
      url
    },
    {
      stage: "authenticated",
      status: loginPage ? "blocked" : "skipped",
      at,
      message: loginPage ? "页面显示登录入口，尚未声明登录成功。" : "未发现需要登录的页面证据，跳过认证阶段。",
      url
    },
    {
      stage: "discovery_completed",
      status: discoveryStatus,
      at,
      message: result.message,
      url
    },
    {
      stage: "plan_generated",
      status: "pending",
      at,
      message: `Discovery 尝试 ${discoveryAttempts} 次；测试计划由后续 planning 阶段生成。`,
      url
    }
  ];
}

export async function runSmokeFirstDiscovery(input: {
  appUrl?: string;
  projectId?: string;
  target?: TargetAppRuntime;
  sourceContexts?: SourceReadEnvelope[];
  goal?: string;
  credentialId?: string;
  smokeAttempts?: number;
  discoveryAttempts?: number;
}, dependencies: {
  probe?: typeof probeDiscoveryConnectivity;
  scan?: typeof runDiscoveryScan;
  sleep?: (delayMs: number) => Promise<void>;
} = {}): Promise<DiscoveryScanResult> {
  const target = await resolveProjectTarget(input);
  const probe = dependencies.probe ?? probeDiscoveryConnectivity;
  const scan = dependencies.scan ?? runDiscoveryScan;
  const sleep = dependencies.sleep ?? wait;
  const smoke = await probe({
    projectId: input.projectId,
    appUrl: input.appUrl,
    target,
    maxAttempts: input.smokeAttempts
  });
  if (smoke.status !== "ready") {
    const deferred = deferredDiscoveryResult(target, smoke);
    await writeDiscoveryPageObservation({
      projectId: target.projectId ?? input.projectId,
      observation: deferred.observation
    }).catch(() => undefined);
    return deferred;
  }

  const maxDiscoveryAttempts = Math.max(
    1,
    Math.min(3, input.discoveryAttempts ?? DEFAULT_DISCOVERY_ATTEMPTS)
  );
  let latest: DiscoveryScanResult | undefined;
  for (let attempt = 1; attempt <= maxDiscoveryAttempts; attempt += 1) {
    latest = await scan(input);
    if (
      latest.status === "passed"
      && latest.observation.navigation.documentCommitted
      && latest.observation.document.interactiveElementCount > 0
    ) {
      return {
        ...latest,
        lifecycle: lifecycleForResult(smoke, latest, attempt),
        orchestration: {
          ...smoke,
          status: "ready",
          discoveryAttempts: attempt
        }
      };
    }
    const missingInteractiveSurface = latest.observation.navigation.documentCommitted
      && latest.observation.document.interactiveElementCount === 0;
    if ((!latest.observation.diagnosis.retryable && !missingInteractiveSurface) || attempt === maxDiscoveryAttempts) {
      const status = discoveryTerminalStatus(latest);
      const automaticBlankPageRecovery = isAutomaticBlankPageRecovery(latest);
      const observation = normalizeAutomaticBlankPageObservation(latest);
      const terminalResult: DiscoveryScanResult = {
        ...latest,
        lifecycle: lifecycleForResult(smoke, latest, attempt),
        observation,
        status: "failed",
        message: status === "blocked"
          ? `Discovery 被页面前置条件阻塞：${latest.message}`
          : automaticBlankPageRecovery
            ? `页面已返回 HTTP ${latest.observation.navigation.httpStatus}，但在 ${attempt} 次有限尝试后仍未发现可操作控件，前端可能尚未完成冷加载。已保存${savedObservationKinds(latest)}观测；当前没有认证证据，无需用户操作或提供账号，系统应按冷加载策略继续有限重试。`
            : missingInteractiveSurface
              ? `Discovery 在 ${attempt} 次有限尝试后仍未发现可操作控件；已保存${savedObservationKinds(latest)}观测。`
            : `Discovery 在 ${attempt} 次有限尝试后失败：${latest.message}`,
        orchestration: {
          ...smoke,
          status,
          reason: automaticBlankPageRecovery
            ? "页面 HTTP 成功，但前端仍在冷加载且尚未形成可操作控件；无需用户操作，应执行有限冷加载重试。"
            : missingInteractiveSurface
              ? "页面已打开，但未发现可操作控件，不能展开自动化路径。"
            : latest.observation.diagnosis.summary || latest.message,
          retryable: observation.diagnosis.retryable || missingInteractiveSurface,
          discoveryAttempts: attempt
        }
      };
      await writeDiscoveryPageObservation({
        projectId: target.projectId ?? input.projectId,
        observation: terminalResult.observation
      }).catch(() => undefined);
      return terminalResult;
    }
    await sleep(attempt === 1 ? 250 : 1_000);
  }
  const deferred = deferredDiscoveryResult(target, {
    ...smoke,
    status: "failed",
    reason: "discovery_scan_not_started",
    retryable: true
  });
  await writeDiscoveryPageObservation({
    projectId: target.projectId ?? input.projectId,
    observation: deferred.observation
  }).catch(() => undefined);
  return latest ?? deferred;
}
