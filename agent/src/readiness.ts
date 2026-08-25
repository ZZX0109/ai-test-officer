import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  readinessReportSchema,
  type ReadinessCheck,
  type ReadinessReport,
  type ReadinessStatus
} from "@ai-test-officer/contracts";
import { isPlaywrightChromiumInstalled, ensurePlaywrightChromium } from "@ai-test-officer/playwright-runtime";
import type { ProjectConfig, ProjectRuntimeStatus } from "./types.js";
import { detectPrivateDependencyBlocker } from "./dependencyReadiness.js";
import { getDatabasePool } from "./databaseRuntime.js";
import { createDefaultReadinessRegistry, type ReadinessRegistry } from "./readinessRegistry.js";

export interface ReadinessContext {
  getProject: (id: string) => Promise<ProjectConfig | undefined>;
  getRuntime: (id: string) => Promise<ProjectRuntimeStatus>;
  startProject?: (id: string) => Promise<ProjectRuntimeStatus>;
  containerEngineIsReady: () => Promise<boolean>;
  checkUrl: (url: string) => Promise<{ ok: boolean; status: number; latencyMs: number }>;
  listCredentials: () => Promise<Array<{ id: string; provider: string; model: string; isDefault: boolean }>>;
  getProjectLoginSummary?: (id: string) => Promise<{ id: string; usernameMasked: string } | undefined>;
  audit?: (event: { type: "agent_action"; action: string; result: "allowed" | "denied" | "recorded"; details: Record<string, unknown> }) => Promise<void>;
  now?: () => string;
  registry?: ReadinessRegistry;
}

export interface BootstrapResult {
  bootstrapId: string;
  status: "running" | "completed" | "blocked" | "failed";
  report: ReadinessReport;
  steps: Array<{ id: string; status: "running" | "completed" | "blocked" | "failed"; message: string; updatedAt: string }>;
}

function statusFor(passed: boolean, repairable: boolean): ReadinessStatus {
  return passed ? "ready" : repairable ? "repairable" : "blocked";
}

function check(input: Omit<ReadinessCheck, "updatedAt" | "evidence"> & { evidence?: string[] }, now: string): ReadinessCheck {
  return { ...input, evidence: input.evidence ?? [], updatedAt: now };
}

function reportStatus(checks: ReadinessCheck[]): ReadinessStatus {
  if (checks.some((item) => item.status === "blocked")) return "blocked";
  if (checks.some((item) => item.status === "repairable")) return "repairable";
  return "ready";
}

export function createReadinessService(context: ReadinessContext) {
  const now = context.now ?? (() => new Date().toISOString());
  const bootstrapTasks = new Map<string, Promise<BootstrapResult>>();

  async function inspect(projectId: string): Promise<ReadinessReport> {
    const project = await context.getProject(projectId);
    const generatedAt = now();
    if (!project) {
      const registry = (context.registry ?? createDefaultReadinessRegistry()).fork();
      const missingReport = readinessReportSchema.parse({
        projectId,
        status: "blocked",
        generatedAt,
        checks: [check({
          id: "project.exists",
          status: "blocked",
          severity: "error",
          message: "项目不存在或当前账号无权访问。",
          remediation: "重新选择项目或授予项目访问权限。",
          requiredBy: ["bootstrap", "execution"]
        }, generatedAt)]
      });
      registry.record(missingReport.checks[0]);
      return readinessReportSchema.parse({ ...missingReport, checks: registry.values() });
    }

    const registry = (context.registry ?? createDefaultReadinessRegistry()).fork();
    const addCheck = (value: ReadinessCheck) => { registry.record(value); };
    const engineReady = project.manifest?.execution.mode !== "oci" || await context.containerEngineIsReady();
    addCheck(check({
      id: "runtime.container-engine",
      status: statusFor(engineReady, true),
      severity: engineReady ? "info" : "error",
      message: engineReady ? "Docker runtime 可用。" : "Docker daemon 不可用。",
      evidence: ["engine:docker"],
      remediation: engineReady ? undefined : "启动 Docker daemon 后重试。",
      requiredBy: ["sandbox", "execution"]
    }, generatedAt));

    const browserReady = await isPlaywrightChromiumInstalled();
    addCheck(check({
      id: "runtime.playwright-chromium",
      status: statusFor(browserReady, true),
      severity: browserReady ? "info" : "warning",
      message: browserReady ? "Playwright Chromium 已安装。" : "Playwright Chromium 尚未安装。",
      remediation: browserReady ? undefined : "执行 bootstrap 自动安装 Chromium。",
      requiredBy: ["browser", "execution"]
    }, generatedAt));

    const credentials = await context.listCredentials();
    addCheck(check({
      id: "credentials.model",
      status: statusFor(credentials.length > 0, false),
      severity: credentials.length > 0 ? "info" : "error",
      message: credentials.length > 0 ? `已配置 ${credentials.length} 个模型凭据。` : "未配置模型凭据。",
      evidence: credentials.map((item) => `${item.provider}:${item.model}`),
      remediation: credentials.length > 0 ? undefined : "通过凭据配置向导添加模型凭据。",
      requiredBy: ["planning", "judge"]
    }, generatedAt));

    const loginRequired = Boolean(project.login && project.login.method !== "none");
    const login = loginRequired && project.login?.credentialId && context.getProjectLoginSummary
      ? await context.getProjectLoginSummary(project.login.credentialId)
      : undefined;
    const loginReady = !loginRequired || Boolean(login) || (project.login?.method === "env"
      && Boolean(project.login.usernameEnv && process.env[project.login.usernameEnv])
      && Boolean(project.login.passwordEnv && process.env[project.login.passwordEnv]));
    addCheck(check({
      id: "credentials.project-login",
      status: statusFor(loginReady, false),
      severity: loginReady ? "info" : "error",
      message: !loginRequired
        ? "项目未声明登录要求。"
        : loginReady ? `项目登录凭据已配置（${login?.usernameMasked ?? "环境变量"}）。` : "项目需要登录凭据，但尚未配置可用测试账号。",
      evidence: !loginRequired ? ["login: not-required"] : login ? [`credential:${login.id}`] : [`method:${project.login?.method ?? "unknown"}`],
      remediation: loginReady ? undefined : "通过项目凭据向导保存测试账号后重试。",
      requiredBy: ["discovery", "browser", "execution"]
    }, generatedAt));

    const dependencyFinding = await detectPrivateDependencyBlocker({
      readProjectFile: async (relativePath) => {
        try { return await readFile(path.join(project.projectPath, relativePath), "utf8"); } catch { return undefined; }
      }
    }).catch(() => undefined);
    addCheck(check({
      id: "project.dependencies",
      status: statusFor(!dependencyFinding, false),
      severity: dependencyFinding ? "error" : "info",
      message: dependencyFinding ? dependencyFinding.reason : "未发现缺少凭据的私有依赖。",
      evidence: dependencyFinding ? [`stack:${dependencyFinding.stack}`] : ["dependency-preflight:passed"],
      remediation: dependencyFinding ? "配置对应 registry、SSH 或项目依赖凭据后重新执行。" : undefined,
      requiredBy: ["sandbox", "execution"]
    }, generatedAt));

    const network = project.manifest?.network;
    const proxyUrl = process.env.ATO_EGRESS_PROXY_URL;
    const proxyHealth = proxyUrl
      ? await context.checkUrl(`${proxyUrl.replace(/\/$/, "")}/healthz`).then((result) => result.ok).catch(() => false)
      : false;
    const networkReady = !network || network.mode === "deny" || (
      network.enforcement === "external-egress-proxy"
      && Boolean(process.env.ATO_EGRESS_NETWORK_NAME)
      && Boolean(proxyUrl)
      && Boolean(process.env.ATO_EGRESS_PROXY_CONTAINER_NAME)
      && Boolean(process.env.ATO_EGRESS_POLICY_SECRET)
      && proxyHealth
      && network.allowedHosts.length > 0
    );
    addCheck(check({
      id: "network.egress",
      status: statusFor(networkReady, false),
      severity: networkReady ? "info" : "error",
      message: networkReady ? "egress 策略已配置。" : "非隔离网络缺少可执行的 egress proxy 配置。",
      evidence: network ? [`mode:${network.mode}`, `allowedHosts:${network.allowedHosts.length}`, `proxyHealth:${proxyHealth}`] : ["manifest-network:none"],
      remediation: networkReady ? undefined : "配置网络名、proxy URL、proxy 容器、策略密钥和 allowedHosts，并确认 proxy /healthz 可达。",
      requiredBy: ["sandbox", "network"]
    }, generatedAt));

    const dataSources = project.manifest?.dataSources ?? [];
    if (dataSources.length > 0) {
      const postgresSources = dataSources.filter((source) => source.kind === "postgres" && source.connectionEnv);
      const missing = postgresSources.filter((source) => !process.env[source.connectionEnv!]);
      const unreachable: string[] = [];
      for (const source of postgresSources.filter((item) => process.env[item.connectionEnv!])) {
        const connectionString = process.env[source.connectionEnv!];
        if (!connectionString) continue;
        const pool = getDatabasePool(connectionString);
        if (!pool) {
          unreachable.push(source.id);
          continue;
        }
        try {
          const client = await pool.connect();
          try { await client.query("select 1"); } finally { client.release(); }
        } catch {
          unreachable.push(source.id);
        }
      }
      const databaseBlocked = missing.length > 0 || unreachable.length > 0;
      addCheck(check({
        id: "database.connections",
        status: statusFor(!databaseBlocked, false),
        severity: databaseBlocked ? "error" : "info",
        message: !databaseBlocked ? `${dataSources.length} 个数据源连接检查通过。` : `数据库连接检查失败：${[...missing.map((source) => source.connectionEnv), ...unreachable].join(", ")}`,
        evidence: dataSources.map((source) => `${source.id}:${source.kind}`),
        remediation: databaseBlocked ? "配置连接环境变量并确认数据库可达后重新执行 bootstrap。" : undefined,
        requiredBy: ["data-oracle", "execution"]
      }, generatedAt));
    } else {
      addCheck(check({
        id: "database.connections",
        status: "ready",
        severity: "info",
        message: "项目未声明数据库数据源。",
        evidence: ["dataSources:none"],
        requiredBy: ["data-oracle", "execution"]
      }, generatedAt));
    }

    const runtime = await context.getRuntime(projectId);
    const runtimeReady = runtime.status === "running";
    addCheck(check({
      id: "project.runtime",
      status: statusFor(runtimeReady, runtime.status !== "failed"),
      severity: runtimeReady ? "info" : "warning",
      message: runtimeReady ? "项目沙盒正在运行。" : runtime.message,
      evidence: [runtime.status, runtime.phase ?? "unknown"],
      remediation: runtimeReady ? undefined : "执行 bootstrap 自动准备并启动项目。",
      requiredBy: ["browser", "execution"]
    }, generatedAt));

    if (project.frontendUrl) {
      const health = await context.checkUrl(project.frontendUrl).catch(() => ({ ok: false, status: 0, latencyMs: 0 }));
      addCheck(check({
        id: "project.frontend-health",
        status: statusFor(health.ok, true),
        severity: health.ok ? "info" : "warning",
        message: health.ok ? `前端健康检查通过（HTTP ${health.status}，${health.latencyMs}ms）。` : "前端地址不可访问。",
        evidence: [`url:${project.frontendUrl}`, `status:${health.status}`],
        remediation: health.ok ? undefined : "确认项目已启动并检查健康检查地址。",
        requiredBy: ["browser", "discovery"]
      }, generatedAt));
    } else {
      addCheck(check({
        id: "project.frontend-health",
        status: "ready",
        severity: "info",
        message: "项目未声明前端健康检查地址。",
        evidence: ["frontendUrl:none"],
        requiredBy: ["browser", "discovery"]
      }, generatedAt));
    }
    if (project.backendUrl) {
      const health = await context.checkUrl(project.backendUrl).catch(() => ({ ok: false, status: 0, latencyMs: 0 }));
      addCheck(check({
        id: "project.backend-health",
        status: statusFor(health.ok, true),
        severity: health.ok ? "info" : "warning",
        message: health.ok ? `后端健康检查通过（HTTP ${health.status}，${health.latencyMs}ms）。` : "后端地址不可访问。",
        evidence: [`url:${project.backendUrl}`, `status:${health.status}`],
        remediation: health.ok ? undefined : "确认后端服务已启动并检查数据库或外部服务依赖。",
        requiredBy: ["api", "database", "execution"]
      }, generatedAt));
    } else {
      addCheck(check({
        id: "project.backend-health",
        status: "ready",
        severity: "info",
        message: "项目未声明后端健康检查地址。",
        evidence: ["backendUrl:none"],
        requiredBy: ["api", "database", "execution"]
      }, generatedAt));
    }

    const checks = registry.values();
    return readinessReportSchema.parse({ projectId, status: reportStatus(checks), checks, generatedAt });
  }

  async function bootstrap(projectId: string): Promise<BootstrapResult> {
    const existing = bootstrapTasks.get(projectId);
    if (existing) return existing;
    const task: Promise<BootstrapResult> = (async (): Promise<BootstrapResult> => {
      const bootstrapId = `bootstrap_${createHash("sha256").update(`${projectId}:${now()}`).digest("hex").slice(0, 16)}`;
      const steps: BootstrapResult["steps"] = [];
      const addStep = async (id: string, status: BootstrapResult["steps"][number]["status"], message: string) => {
        steps.push({ id, status, message, updatedAt: now() });
        await context.audit?.({ type: "agent_action", action: `bootstrap.${id}`, result: status === "failed" || status === "blocked" ? "denied" : "recorded", details: { projectId, status, message } });
      };
      try {
        let report = await inspect(projectId);
        const project = await context.getProject(projectId);
        if (!project) return { bootstrapId, status: "blocked", report, steps };

        const browser = report.checks.find((item) => item.id === "runtime.playwright-chromium");
        if (browser?.status !== "ready") {
          await addStep("playwright", "running", "正在准备 Playwright Chromium。");
          await ensurePlaywrightChromium();
          await addStep("playwright", "completed", "Playwright Chromium 已准备完成。");
        }

        const runtime = report.checks.find((item) => item.id === "project.runtime");
        if (runtime?.status !== "ready") {
          await addStep("project-runtime", "running", "正在准备项目沙盒和健康检查。");
          if (context.startProject) {
            const started = await context.startProject(projectId);
            if (started.status === "failed") {
              await addStep("project-runtime", "failed", started.message || "项目启动失败。");
              const failedReport = await inspect(projectId);
              return { bootstrapId, status: "failed", report: { ...failedReport, bootstrapId }, steps };
            }
            const deadline = Date.now() + 30_000;
            let current = await context.getRuntime(projectId);
            while (["installing", "starting"].includes(current.status) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              current = await context.getRuntime(projectId);
            }
          }
          const current = await context.getRuntime(projectId);
          if (current.status !== "running") {
            await addStep("project-runtime", "blocked", current.message || "项目未通过健康检查。");
            const blockedReport = await inspect(projectId);
            return { bootstrapId, status: "blocked", report: { ...blockedReport, bootstrapId }, steps };
          }
          await addStep("project-runtime", "completed", "项目已启动并通过健康检查。");
        }
        report = await inspect(projectId);
        const status: BootstrapResult["status"] = report.status === "ready" ? "completed" : "blocked";
        return { bootstrapId, status, report: { ...report, bootstrapId }, steps };
      } catch (error) {
        const report = await inspect(projectId).catch(() => readinessReportSchema.parse({ projectId, status: "blocked", checks: [], generatedAt: now() }));
        await addStep("bootstrap", "failed", error instanceof Error ? error.message : "bootstrap_failed");
        return { bootstrapId, status: "failed", report: { ...report, bootstrapId }, steps };
      }
    })().finally(() => bootstrapTasks.delete(projectId));
    bootstrapTasks.set(projectId, task);
    return task;
  }

  return { inspect, bootstrap };
}
