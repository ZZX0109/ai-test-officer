import assert from "node:assert/strict";
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
  process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL = previousEmail ?? `ai-test-officer-${Date.now()}@example.com`;
  process.env.INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD = previousPassword ?? "InvestmentAgent123!";
  process.env.HEADLESS = previousHeadless ?? "1";

  let startedByTest = false;
  try {
    const project = await getProject(projectId);
    assert.ok(project, "investment_agent_workflow_external project profile must exist");
    const before = await testProjectConnection(project);
    if (!before.ok) {
      const runtime = await startProject(projectId);
      assert.equal(runtime.status, "running", runtime.message);
      assert.equal(runtime.processes?.every((process) => process.status === "running"), true);
      startedByTest = true;
    }

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
        uri: "/Users/afa/Desktop/Hack/project-01-investment-agent-workflow",
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
  } finally {
    if (startedByTest) await stopProject(projectId);
    restoreEnv("INVESTMENT_AGENT_WORKFLOW_SMOKE_EMAIL", previousEmail);
    restoreEnv("INVESTMENT_AGENT_WORKFLOW_SMOKE_PASSWORD", previousPassword);
    restoreEnv("HEADLESS", previousHeadless);
  }
}
