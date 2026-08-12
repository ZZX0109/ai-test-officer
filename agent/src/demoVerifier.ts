import { createServer, type IncomingMessage } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { readConnectorContext } from "./sourceConnectors.js";
import { runCommitCheck } from "./commitCheckOrchestrator.js";
import { runRequirementAcceptance } from "./requirementAcceptanceOrchestrator.js";
import { runPatrolNow } from "./patrolScheduler.js";
import { runVisualGrayTest } from "./testRunner.js";
import { executeQueuedRun } from "./runOrchestrator.js";
import { runEventStore } from "./runEventStore.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { getScenario } from "./scenarios.js";
import { readRunBundle } from "./evidenceStore.js";
import { saveProject, startProject, stopProject, testProjectConnection } from "./projectAdapter.js";
import { detectProject } from "./projectDetection.js";
import type { DemoVerificationResult, PermissionProfile } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const verificationDir = path.join(rootDir, "reports", "demo-verification");
const latestFile = path.join(verificationDir, "latest.json");
const appUrl = process.env.APP_URL ?? "http://localhost:6173";

const allowBrowser: PermissionProfile = {
  observe: true,
  browserControl: true,
  workspaceControl: false,
  ideTerminalControl: false,
  systemControl: false
};

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startFixtureServer() {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/wecom") {
      const body = await readBody(req);
      requests.push(JSON.parse(body) as unknown);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      return;
    }

    res.setHeader("content-type", "text/plain; charset=utf-8");
    if (req.url === "/req") {
      res.end("需求：任务列表点击进行中时，系统必须只展示 status=active 的任务，并且接口请求需要携带 status=active 查询参数。");
    } else if (req.url === "/bug") {
      res.end("TAPD-2048：进行中任务筛选返回已完成任务，需回归 active 筛选核心路径。");
    } else if (req.url === "/diff") {
      res.end("diff --git a/app-under-test/src/api/tasks.ts b/app-under-test/src/api/tasks.ts\n+ fetchTasks changed status=active query handling");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function isHttpReady(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureAppServer() {
  if (await isHttpReady(appUrl)) return undefined;
  const child = spawn("npm", ["--workspace", "app-under-test", "run", "dev"], {
    cwd: rootDir,
    detached: process.platform !== "win32",
    stdio: "ignore",
    env: { ...process.env }
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 25_000) {
    if (await isHttpReady(appUrl)) return child;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill();
  throw new Error(`APP_URL 未就绪，且自动启动 app-under-test 超时：${appUrl}`);
}

async function stopAppServer(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch { return; }
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode === null) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch { /* already stopped */ }
  }
}

function resultShell(): DemoVerificationResult {
  return {
    id: `demo_verification_${Date.now()}`,
    createdAt: new Date().toISOString(),
    ok: true,
    checks: [],
    artifacts: {},
    stages: []
  };
}

function addRunStages(result: DemoVerificationResult, run: Awaited<ReturnType<typeof runVisualGrayTest>>) {
  const summary = run.outcomeSummary;
  result.stages.push({
    runId: run.id,
    scenarioId: run.attempts?.[0]?.scenarioId,
    schemaVersion: "2.0",
    schedulingCompleted: summary?.schedulingCompleted ?? Boolean(run.finishedAt),
    executionStarted: summary?.executionStarted ?? Boolean(run.attempts?.length),
    executionSucceeded: summary?.executionSucceeded ?? false,
    requirementCovered: summary?.requirementCovered ?? false,
    requirementPassed: summary?.requirementPassed ?? false,
    artifactIntegrityVerified: summary?.artifactIntegrityVerified ?? false,
    evidenceGrounded: summary?.evidenceGrounded ?? false,
    gateEligible: summary?.gateEligible ?? false,
    machineGate: run.machineGate?.status,
    judgeRecommendation: run.judgeRecommendation?.status,
    finalStatus: run.finalStatus
  });
}

function addCheck(
  result: DemoVerificationResult,
  input: { id: string; title: string; status: "passed" | "failed"; details: string; artifact?: string }
) {
  result.checks.push(input);
  if (input.status === "failed") result.ok = false;
}

function assertReleaseJudgeRefs(run: {
  judgeReport: { releaseJudge: { findings: Array<{ evidenceRefs: string[] }> } };
}) {
  return run.judgeReport.releaseJudge.findings.length > 0 &&
    run.judgeReport.releaseJudge.findings.every((finding) => finding.evidenceRefs.length > 0);
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function fileExists(artifactPath: string | undefined) {
  if (!artifactPath) return false;
  const localPath = path.join(rootDir, artifactPath.replace(/^\/artifacts\//, "reports/"));
  try {
    await readFile(localPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number | undefined) {
  if (!bytes || bytes <= 0) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function runRetentionJob() {
  if (process.env.SKIP_REPORT_RETENTION === "1") {
    return { skipped: true, details: "SKIP_REPORT_RETENTION=1，已跳过报告归档清理。" };
  }

  const script = path.join(rootDir, "scripts", "reports-retention.mjs");
  const child = spawn(process.execPath, [script, "--apply", "--archive"], {
    cwd: rootDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`reports retention failed with exit=${exitCode}: ${stderr || stdout}`);
  }

  const manifest = JSON.parse(stdout) as {
    actionCount?: number;
    plannedBytes?: number;
    totalBytesBefore?: number;
    projectedBytesAfter?: number;
    archiveDir?: string;
  };
  return {
    skipped: false,
    details: `归档 ${manifest.actionCount ?? 0} 项，active reports ${formatBytes(manifest.totalBytesBefore)} -> ${formatBytes(manifest.projectedBytesAfter)}，archiveDir=${manifest.archiveDir ?? "n/a"}`,
    manifest
  };
}

async function runExternalProjectSmoke(result: DemoVerificationResult) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-test-officer-customer-portal-"));
  const tempProjectPath = path.join(tempRoot, "customer-portal-lite");
  const projectId = `external_customer_portal_${Date.now()}`;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectFile = path.join(rootDir, "data", "projects", `${projectId}.json`);
  const scenarioIds = [
    "generic_table_sort_filter_pagination",
    "generic_complex_form_validation",
    "generic_approval_flow_transition"
  ];
  let started = false;

  try {
    await cp(path.join(rootDir, "fixtures", "customer-portal-lite"), tempProjectPath, { recursive: true });
    const now = new Date().toISOString();
    const detection = await detectProject(tempProjectPath);
    const detected = detection.suggestedConfig;
    const manifest = detected.manifest
      ? {
        ...detected.manifest,
        projectId,
        environmentAllowlist: Array.from(new Set([...detected.manifest.environmentAllowlist, "PORT"]))
      }
      : undefined;
    const project = await saveProject({
      ...detected,
      id: projectId,
      name: "External Customer Portal Lite Smoke",
      projectPath: tempProjectPath,
      allowExternalProjectPath: true,
      installCommand: "",
      installCommandSpec: undefined,
      healthCheckUrl: `${baseUrl}/health`,
      frontendUrl: baseUrl,
      backendUrl: `${baseUrl}/health`,
      processes: detected.processes?.map((processConfig) => ({
        ...processConfig,
        healthCheckUrl: `${baseUrl}/health`
      })),
      login: { method: "none" },
      env: { PORT: String(port) },
      manifest,
      cleanupCommand: "",
      timeoutMs: 15_000,
      externalSmokeProfile: {
        login: { expectedText: "signed in qa.customer@example.com" },
        keyPages: [{ id: "home", path: "/", expectedHeading: "Customer Portal Lite" }],
        form: {
          inputLabel: "客户名称",
          inputValue: "Acme",
          submitButton: "提交订单",
          expectedText: "请填写客户名称和订单金额"
        },
        table: {
          sortButton: "按金额排序",
          filterLabel: "客户筛选",
          filterValue: "Acme",
          nextButton: "下一页",
          expectedText: "Acme Renewal"
        },
        permission: {
          roleControlLabel: "切换角色",
          roleValue: "viewer",
          expectedText: "viewer: read-only"
        }
      },
      createdAt: now,
      updatedAt: now
    });

    const runtime = await startProject(projectId);
    started = runtime.status === "running";
    const health = await testProjectConnection(project);
    const runs = [];
    if (started && health.ok) {
      for (const scenarioId of scenarioIds) {
        runs.push(await runVisualGrayTest({
          projectId,
          scenarioId,
          requirement: "外部真实项目 smoke：验证表格、复杂表单和审批状态变更能力可以通过 Project Adapter 在项目根目录外执行。",
          diff: "external customer portal lite fixture copied to os.tmpdir()",
          trigger: "manual",
          keepProjectRunning: true,
          permissionProfile: allowBrowser
        }));
      }
    }
    const passed =
      started &&
      health.ok &&
      runs.length === scenarioIds.length &&
      runs.every((run) => run.evidence.length > 0 && run.runtimeStatus?.projectId === projectId && assertReleaseJudgeRefs(run));
    result.artifacts.externalProjectSmoke = runs.at(-1)?.runBundleFile ?? "";
    addCheck(result, {
      id: "external_project_smoke",
      title: "外部真实项目 Project Adapter smoke",
      status: passed ? "passed" : "failed",
      details: passed
        ? `临时外部项目 ${tempProjectPath} 通过 ${scenarioIds.length} 个通用 scenario，runtime=${runtime.status}。`
        : `runtime=${runtime.status} health=${health.status} runs=${runs.length}/${scenarioIds.length} reason=${runtime.failureReason ?? health.reason}`,
      artifact: runs.at(-1)?.runBundleFile
    });
  } finally {
    if (started) await stopProject(projectId);
    await rm(projectFile, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function writeDemoVerification(result: DemoVerificationResult) {
  await mkdir(verificationDir, { recursive: true });
  const file = path.join(verificationDir, `${result.id}.json`);
  const resultWithFile = {
    ...result,
    demoVerificationFile: `/artifacts/demo-verification/${result.id}.json`
  };
  await writeFile(file, JSON.stringify(resultWithFile, null, 2));
  await writeFile(latestFile, JSON.stringify(resultWithFile, null, 2));
  return resultWithFile;
}

export async function runDemoVerification() {
  const result = resultShell();
  const fixture = await startFixtureServer();
  let appProcess: ChildProcess | undefined;
  const previousProvider = process.env.BOT_PROVIDER;
  const previousWebhook = process.env.BOT_WEBHOOK_URL;
  const previousAllowPrivateConnectors = process.env.ALLOW_PRIVATE_CONNECTOR_URLS;
  process.env.BOT_PROVIDER = "wecom";
  process.env.BOT_WEBHOOK_URL = `${fixture.baseUrl}/wecom`;
  process.env.ALLOW_PRIVATE_CONNECTOR_URLS = "1";

  try {
    appProcess = await ensureAppServer();
    addCheck(result, {
      id: "app_ready",
      title: "被测应用可访问",
      status: "passed",
      details: appProcess ? `已自动启动 ${appUrl}` : `已连接现有 ${appUrl}`
    });

    const context = await readConnectorContext({
      requirementUrl: `${fixture.baseUrl}/req`,
      bugTicketUrl: `${fixture.baseUrl}/bug`,
      prDiffUrl: `${fixture.baseUrl}/diff`
    });
    const analysis = analyzeIntake({
      requirement: context.requirement,
      diff: context.diff,
      bugTicket: context.bugTicket,
      prUrl: context.prUrl,
      sources: context.sources
    });
    const activeMatched = analysis.scenarioCandidates.some((candidate) => candidate.mappedScenarioId === "task_filter_active");
    addCheck(result, {
      id: "remote_connector_active_match",
      title: "远程连接器读取并拆出 active 场景",
      status: activeMatched ? "passed" : "failed",
      details: activeMatched ? "远程需求/Bug/diff 命中 task_filter_active。" : "未命中 task_filter_active。"
    });

    const unifiedKey = `demo-unified-${Date.now()}`;
    let unified = await runEventStore.create({ actor: "demo-verifier", idempotencyKey: unifiedKey, payload: { appUrl, scenarioId: "task_filter_active", requirement: context.requirement, diff: context.diff, plannerMode: "deterministic", judgeMode: "deterministic", permissionProfile: allowBrowser } });
    const unifiedPlan = buildScenarioGrayPlan(getScenario("task_filter_active"));
    unified = await runEventStore.append({ runId: unified.id, type: "plan_generated", expectedVersion: unified.version, actor: "planner", idempotencyKey: `${unifiedKey}:generated`, payload: { plan: unifiedPlan, compiledPlan: unifiedPlan, scenarioId: "task_filter_active", provenance: { source: "deterministic", promptVersion: "demo-freeze-v1", compilationStatus: "validated" }, impactAnalysis: analysis.impactAnalysis } });
    unified = await runEventStore.append({ runId: unified.id, type: "plan_approved", expectedVersion: unified.version, actor: "demo-verifier", idempotencyKey: `${unifiedKey}:approved`, payload: {} });
    unified = await runEventStore.append({ runId: unified.id, type: "permission_granted", expectedVersion: unified.version, actor: "demo-verifier", idempotencyKey: `${unifiedKey}:permission`, payload: {} });
    unified = (await executeQueuedRun(unified.id))!;
    // Active Graph finalization resumes asynchronously after the worker has
    // committed its evidence. Wait for that durable projection before reading
    // the bundle; otherwise a collecting run has no resultRunId yet.
    const graphDeadline = Date.now() + 30_000;
    while (!unified.resultRunId && Date.now() < graphDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      unified = (await runEventStore.get(unified.id)) ?? unified;
    }
    if (!unified.resultRunId) throw new Error("demo_graph_finalization_timeout");
    const unifiedEvents = await runEventStore.events(unified.id);
    const unifiedBundle = await readRunBundle(unified.resultRunId!);
    const unifiedResult = { ...unifiedBundle.result, evidence: unifiedBundle.evidence, loopEvents: unifiedBundle.loopEvents, oracles: unifiedBundle.oracles, riskCoverageMatrix: unifiedBundle.riskCoverageMatrix };
    addRunStages(result, unifiedResult);
    addCheck(result, {
      id: "unified_run_state_machine",
      title: "统一运行入口完成计划审批、权限和执行状态链",
      status: ["plan_generated", "plan_approved", "permission_granted", "run_started", "evidence_collecting", "run_judging"].every((type) => unifiedEvents.some((event) => event.type === type)) && Boolean(unifiedResult.finalStatus) ? "passed" : "failed",
      details: `run=${unified.id} state=${unified.state} machine=${unifiedResult.machineGate?.status} judge=${unifiedResult.judgeRecommendation?.status} final=${unifiedResult.finalStatus}`,
      artifact: unifiedResult.runBundleFile
    });

    const commitCheck = await runCommitCheck({
      appUrl,
      prUrl: "local://demo-verification/commit",
      // The repository can contain in-progress changes for several fixtures.
      // A demo backed by the Todo application must keep its explicit executable
      // scenario bound to that application rather than accidentally selecting an
      // Order Portal change from the ambient working-tree diff.
      scenarioId: "task_filter_completed",
      fallbackDiff: "fetchTasks changed completed filter query handling and may drop status=completed",
      notify: ["oncall"],
      permissionProfile: allowBrowser
    });
    if (commitCheck.run) addRunStages(result, commitCheck.run);
    result.artifacts.commitCheck = commitCheck.commitCheckFile ?? "";
    addCheck(result, {
      id: "commit_check_artifacts",
      title: "提交检查生成报告和 Judge",
      status: commitCheck.run &&
        commitCheck.commitCheckFile &&
        await fileExists(commitCheck.commitCheckFile) &&
        assertReleaseJudgeRefs(commitCheck.run)
        ? "passed"
        : "failed",
      details: `selected=${commitCheck.selectedScenarioId ?? "none"} release=${commitCheck.run?.judgeReport.releaseJudge.verdict ?? "skipped"}`,
      artifact: commitCheck.commitCheckFile
    });

    const acceptance = await runRequirementAcceptance({
      appUrl,
      requirementUrl: `${fixture.baseUrl}/req`,
      bugTicketUrl: `${fixture.baseUrl}/bug`,
      prDiffUrl: `${fixture.baseUrl}/diff`,
      notify: ["product-owner", "qa-oncall"],
      permissionProfile: allowBrowser
    });
    if (acceptance.run) addRunStages(result, acceptance.run);
    result.artifacts.requirementAcceptance = acceptance.acceptanceFile ?? "";
    addCheck(result, {
      id: "requirement_acceptance_artifacts",
      title: "需求验收生成报告和 Judge",
      status: acceptance.run &&
        acceptance.selectedScenarioId === "task_filter_active" &&
        acceptance.acceptanceFile &&
        await fileExists(acceptance.acceptanceFile) &&
        assertReleaseJudgeRefs(acceptance.run)
        ? "passed"
        : "failed",
      details: `selected=${acceptance.selectedScenarioId ?? "none"} release=${acceptance.run?.judgeReport.releaseJudge.verdict ?? "skipped"}`,
      artifact: acceptance.acceptanceFile
    });

    const patrol = await runPatrolNow({
      appUrl,
      jobId: "demo_verification_patrol",
      scenarioId: "task_filter_completed",
      requirement: "核心路径巡检：任务筛选功能必须保持可用。",
      diff: "patrol baseline",
      notify: ["oncall"],
      permissionProfile: allowBrowser
    });
    addRunStages(result, patrol.run);
    result.artifacts.patrol = patrol.patrol.patrolFile ?? "";
    addCheck(result, {
      id: "patrol_artifacts",
      title: "巡检生成报告和值班推送",
      status: patrol.patrol.patrolFile &&
        await fileExists(patrol.patrol.patrolFile) &&
        assertReleaseJudgeRefs(patrol.run)
        ? "passed"
        : "failed",
      details: `release=${patrol.run.judgeReport.releaseJudge.verdict} delivery=${patrol.delivery.status}`,
      artifact: patrol.patrol.patrolFile
    });

    const realProjectScenarios = [
      {
        id: "auth_login_permission",
        title: "登录/权限流程生成 evidence、finding 和 judge report",
        requirement: "真实项目接入必须验证测试账号登录后才能操作受保护业务页面。"
      },
      {
        id: "task_create_success",
        title: "表单成功提交流程生成 evidence、finding 和 judge report",
        requirement: "用户填写有效任务标题并提交后，新任务必须出现在列表中。"
      },
      {
        id: "task_state_transition",
        title: "复杂列表状态变更流程生成 evidence、finding 和 judge report",
        requirement: "用户把进行中任务标记为已完成后，列表状态必须更新为 completed。"
      }
    ];
    for (const scenario of realProjectScenarios) {
      const run = await runVisualGrayTest({
        appUrl,
        scenarioId: scenario.id,
        requirement: scenario.requirement,
        diff: `demo verification scenario=${scenario.id}`,
        trigger: "manual",
        permissionProfile: allowBrowser
      });
      addRunStages(result, run);
      addCheck(result, {
        id: `real_project_${scenario.id}`,
        title: scenario.title,
        status: run.evidence.length > 0 && run.judgeReport.releaseJudge.findings.length > 0 && assertReleaseJudgeRefs(run)
          ? "passed"
          : "failed",
        details: `run=${run.id} evidence=${run.evidence.length} release=${run.judgeReport.releaseJudge.verdict}`,
        artifact: run.runBundleFile
      });
    }

    await runExternalProjectSmoke(result);

    const wecomPayload = fixture.requests.find((item) => {
      const candidate = item as { msgtype?: string; markdown?: { content?: string } };
      return candidate.msgtype === "markdown" && Boolean(candidate.markdown?.content?.includes("releaseJudge="));
    });
    addCheck(result, {
      id: "wecom_payload",
      title: "企业微信 markdown webhook payload 可验证",
      status: wecomPayload ? "passed" : "failed",
      details: wecomPayload ? `mock 收到 ${fixture.requests.length} 条企业微信请求。` : "mock 未收到企业微信 markdown payload。"
    });
  } catch (error) {
    addCheck(result, {
      id: "demo_verification_exception",
      title: "Demo 验证异常",
      status: "failed",
      details: error instanceof Error ? error.message : String(error)
    });
  } finally {
    restoreEnv("BOT_PROVIDER", previousProvider);
    restoreEnv("BOT_WEBHOOK_URL", previousWebhook);
    restoreEnv("ALLOW_PRIVATE_CONNECTOR_URLS", previousAllowPrivateConnectors);
    await fixture.close();
    if (appProcess) await stopAppServer(appProcess);
  }

  let resultWithFile = await writeDemoVerification(result);
  try {
    const retention = await runRetentionJob();
    resultWithFile.artifacts.retention = "/artifacts/retention-manifest.json";
    addCheck(resultWithFile, {
      id: "reports_retention",
      title: "报告产物归档清理可审计",
      status: "passed",
      details: retention.details,
      artifact: "/artifacts/retention-manifest.json"
    });
  } catch (error) {
    addCheck(resultWithFile, {
      id: "reports_retention",
      title: "报告产物归档清理可审计",
      status: "failed",
      details: error instanceof Error ? error.message : String(error)
    });
  }
  resultWithFile = await writeDemoVerification(resultWithFile);
  return resultWithFile;
}

runDemoVerification()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
