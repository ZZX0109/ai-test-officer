import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProject, startProject, stopProject, testProjectConnection } from "../src/projectAdapter.js";
import { runVisualGrayTest } from "../src/testRunner.js";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function testInvestmentAgentWorkflowExternalSmoke() {
  if (process.env.RUN_INVESTMENT_AGENT_WORKFLOW_SMOKE !== "1") return;

  const projectId = "investment_agent_workflow_external";
  const previousEmail = process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL;
  const previousPassword = process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD;
  const previousHeadless = process.env.HEADLESS;
  const previousDatabasePath = process.env.INVESTMENT_RESEARCH_DB_PATH;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-investment-challenge-"));
  process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL = previousEmail ?? `ai-test-officer-${Date.now()}@example.com`;
  process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD = previousPassword ?? "InvestmentAgent123!";
  process.env.INVESTMENT_RESEARCH_DB_PATH = path.join(tempRoot, "investment-research.sqlite3");
  process.env.HEADLESS = previousHeadless ?? "1";

  let startedByTest = false;
  try {
    const project = await getProject(projectId);
    assert.ok(project, "investment_agent_workflow_external project profile must exist");
    const before = await testProjectConnection(project);
    // Do not attach a challenge to an already-running target: it could point
    // at a developer's real SQLite data instead of this test's temp database.
    assert.equal(before.ok, false, "investment challenge requires an isolated target process");
    const runtime = await startProject(projectId);
    assert.equal(runtime.status, "running", runtime.message);
    assert.equal(runtime.processes?.every((process) => process.status === "running"), true);
    startedByTest = true;

    const run = await runVisualGrayTest({
      projectId,
      scenarioId: "investment_agent_workflow_auth_portfolio_research",
      requirement: "真实复杂外部项目 smoke：注册登录、前测持仓、portfolio/research dashboard 和刷新恢复入口必须可审计。",
      diff: "diff --git a/frontend/src/features/workbench/WorkbenchPage.tsx b/frontend/src/features/workbench/WorkbenchPage.tsx\n+ portfolio/research dashboard smoke",
      trigger: "manual",
      keepProjectRunning: true,
      sourceContexts: [{
        id: "source_investment_agent_workflow_smoke",
        kind: "local_file",
        title: "Investment agent workflow smoke source",
        uri: "/workspace/project-01-investment-agent-workflow",
        status: "connected",
        summary: "真实外部 AI Agent 工作流平台样例，含 Vite 前端、FastAPI 后端、SQLite、登录和投研业务流；不代表任何第三方同名产品。",
        permissionState: "not_required",
        isSimulated: false,
        readAt: new Date().toISOString(),
        trustLevel: "high"
      }],
      permissionProfile: {
        observe: true,
        browserControl: true,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    });
    assert.equal(run.runtimeStatus?.projectId, projectId);
    assert.ok(run.evidence.some((item) => item.type === "screenshot"));
    assert.ok(run.evidence.some((item) => item.type === "dom"));
    assert.ok(run.evidence.some((item) => item.type === "network"));
    assert.ok(run.network.some((item) => item.url.includes("/api/portfolio")));
    assert.ok(run.network.some((item) => item.url.includes("/api/research/")));
    assert.equal(run.judgeReport.releaseJudge.findings.every((finding) => finding.evidenceRefs.length > 0), true);
    assert.ok(run.runBundleFile);

    const apiBase = "http://127.0.0.1:8000";
    const request = async (pathname: string, token?: string, init: RequestInit = {}) => {
      const response = await fetch(`${apiBase}${pathname}`, {
        ...init,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
      });
      return { response, payload: await response.json().catch(() => undefined) as Record<string, unknown> | undefined };
    };
    const user = await request("/api/auth/register", undefined, { method: "POST", body: JSON.stringify({ email: `challenge-${Date.now()}@example.com`, password: "InvestmentAgent123!" }) });
    assert.equal(user.response.status, 200);
    const token = String(user.payload?.token ?? "");
    assert.ok(token);
    const unauthenticatedPortfolio = await request("/api/portfolio?preference=balanced");
    assert.equal(unauthenticatedPortfolio.response.status, 401, "portfolio data must not fall back to a sample user");
    const onboarding = await request("/api/onboarding", token, { method: "POST", body: JSON.stringify({ preference: "balanced", riskAnswers: { horizon: "1y", drawdownTolerance: "medium" }, holdings: [{ symbol: "NVDA", market: "us", name: "NVIDIA", shares: 1 }] }) });
    assert.equal(onboarding.response.status, 200);
    const refreshed = await request("/api/refresh/daily", token, { method: "POST", body: "{}" });
    assert.equal(refreshed.response.status, 200, "controlled fixture refresh must complete");
    const research = await request("/api/research/NVDA?preference=balanced", token);
    assert.equal(research.response.status, 200);
    const runId = String((research.payload?.run as Record<string, unknown> | undefined)?.runId ?? "");
    assert.ok(runId, "research must create a run-bound report snapshot");
    const report = await fetch(`${apiBase}/api/reports/NVDA.md?preference=balanced&run_id=${encodeURIComponent(runId)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(report.status, 200);
    assert.match(await report.text(), new RegExp(runId));
    const unapprovedPrediction = await request("/api/ml/infer/NVDA", token, { method: "POST", body: JSON.stringify({ allowSynthetic: false, modelId: "unapproved-fixture" }) });
    assert.notEqual(unapprovedPrediction.response.status, 200, "unapproved model must not expose a production prediction");
  } finally {
    if (startedByTest) await stopProject(projectId);
    restoreEnv("INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL", previousEmail);
    restoreEnv("INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD", previousPassword);
    restoreEnv("INVESTMENT_RESEARCH_DB_PATH", previousDatabasePath);
    restoreEnv("HEADLESS", previousHeadless);
    await rm(tempRoot, { recursive: true, force: true });
  }
}
