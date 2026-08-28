import { chromium } from "playwright";

const workbenchUrl = process.env.WORKBENCH_URL ?? "http://127.0.0.1:6174";
const agentToken = process.env.AGENT_API_TOKEN ?? "dev-local-token";

async function assertHealthy(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`workbench_e2e_service_unhealthy:${url}:${response.status}`);
}

await Promise.all([
  assertHealthy(workbenchUrl),
  assertHealthy(`${workbenchUrl}/agent-api/api/health`)
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1_000 } });
  let officialDemoRun;
  let officialDemoRequest;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const pathname = new URL(request.url()).pathname;
    if (!pathname.endsWith("/v1/runs")) return;
    try {
      const payload = JSON.parse(request.postData() ?? "{}");
      if (
        payload.projectId === "local_demo_app"
        && payload.input?.dynamicBrowser === true
        && payload.input?.requireModelExecution === true
      ) officialDemoRequest = payload;
    } catch {
      // The API contract validation below gives the actionable failure. Never
      // make an E2E listener itself decide a test result.
    }
  });
  page.on("response", (response) => {
    if (!officialDemoRequest || response.request().method() !== "POST") return;
    if (!new URL(response.url()).pathname.endsWith("/v1/runs")) return;
    void response.json()
      .then((payload) => {
        if (payload?.run?.id) officialDemoRun = { id: payload.run.id, input: officialDemoRequest.input };
      })
      .catch(() => undefined);
  });
  await page.goto(workbenchUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByText("测试官工作台", { exact: true }).waitFor();

  // Project intake lives in the explicitly opened configuration drawer. The
  // first visible <select> is not a reliable project control after the
  // workbench's compact-layout redesign.
  await page.getByRole("button", { name: "配置与证据" }).click();
  await page.getByRole("button", { name: "项目与运行配置" }).click();

  const officialDemoStart = page.getByTestId("official-demo-start");
  await officialDemoStart.waitFor({ state: "visible", timeout: 15_000 });
  await officialDemoStart.click();
  await page.locator(".topbar-run-summary strong").filter({ hasText: "官方演示：任务管理系统" }).waitFor();
  const officialDemoGoal = await page.locator(".drawer-left.open").getByLabel("描述测试目标").inputValue();
  if (!officialDemoGoal.includes("已完成") || !officialDemoGoal.includes("任务管理系统")) {
    throw new Error(`workbench_e2e_official_demo_goal_not_prefilled:${officialDemoGoal}`);
  }
  const credentials = await page.evaluate(async (token) => {
    const response = await fetch("/agent-api/api/credentials", {
      credentials: "include",
      headers: { "x-agent-token": token }
    });
    if (!response.ok) throw new Error(`credential_list_http_${response.status}`);
    return response.json();
  }, agentToken);
  if (!credentials.credentials?.some((credential) => credential.isDefault)) {
    throw new Error("workbench_e2e_model_demo_requires_default_credential");
  }

  // The official demo must exercise the real confirmation, Worker and
  // evidence path, not only the form prefill. The run closes the configuration
  // drawer when execution starts, so the assertions below target the central
  // human-readable workspace surface.
  await page.locator(".drawer-left.open").getByRole("button", { name: "准备演示页面" }).click();
  await page.getByText("项目已准备好测试", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "发送给 AI 测试助手" }).click();
  // The planning summary can be rendered by either the compact assistant
  // sidebar or the full planning panel, depending on the active workspace
  // layout. Use the visible action itself as the contract so this E2E test
  // does not depend on an implementation-only wrapper class.
  const confirmPlanButton = page.locator('button:visible').filter({ hasText: /确认并执行/ });
  await confirmPlanButton.first().waitFor({ state: "visible", timeout: 60_000 });
  await confirmPlanButton.first().click();
  await page.getByText("测试结论", { exact: true }).waitFor({ state: "visible", timeout: 180_000 });
  await page.locator('[aria-label="测试结论"]').waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText("项目浏览器现场", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByText(/^证据 \d+$/, { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
  if (!officialDemoRun?.id || officialDemoRun.input?.dynamicBrowser !== true || officialDemoRun.input?.requireModelExecution !== true) {
    throw new Error("workbench_e2e_official_demo_not_model_driven");
  }
  const modelDemoAcceptance = await page.evaluate(async ({ runId, token }) => {
    const headers = { "x-agent-token": token };
    const read = async (suffix) => {
      const response = await fetch(`/agent-api/v1/runs/${encodeURIComponent(runId)}${suffix}`, { credentials: "include", headers });
      if (!response.ok) throw new Error(`${suffix}_http_${response.status}`);
      return response.json();
    };
    const [llm, browserActions, artifacts, report] = await Promise.all([
      read("/llm-calls"), read("/browser-actions"), read("/artifacts"), read("/report")
    ]);
    return {
      successfulBrowserActionCalls: llm.calls.filter((call) => call.purpose === "browser-action" && call.status === "passed").length,
      completedBrowserActions: browserActions.actions.filter((action) => action.status === "completed").length,
      artifactKinds: artifacts.artifacts.map((artifact) => artifact.kind),
      finalStatus: report.report.finalStatus ?? report.report.gateStatus,
      modelExecution: report.report.modelExecution,
      judgeLlmStatus: report.report.judgeReport?.llmStatus
    };
  }, { runId: officialDemoRun.id, token: agentToken });
  if (
    modelDemoAcceptance.successfulBrowserActionCalls < 1
    || modelDemoAcceptance.completedBrowserActions < 1
    || !modelDemoAcceptance.artifactKinds.includes("screenshot")
    || !modelDemoAcceptance.artifactKinds.includes("operation-log")
    || (modelDemoAcceptance.modelExecution?.successfulBrowserActionCallCount ?? 0) < 1
    || (modelDemoAcceptance.modelExecution?.completedBrowserActionCount ?? 0) < 1
    || modelDemoAcceptance.judgeLlmStatus !== "passed"
    || modelDemoAcceptance.finalStatus !== "pass"
  ) {
    throw new Error(`workbench_e2e_model_demo_evidence_incomplete:${JSON.stringify(modelDemoAcceptance)}`);
  }

  // Execution closes the left drawer. Reopen it to verify that the compact
  // project picker still keeps the official card prominent and other examples
  // collapsed for technical users.
  await page.getByRole("button", { name: "配置与证据" }).click();
  await page.getByRole("button", { name: "项目与运行配置" }).click();

  await page.locator(".system-projects-details > summary").click();
  const sampleProjects = page.getByRole("region", { name: "系统示例项目" }).getByRole("button");
  await sampleProjects.first().waitFor({ state: "visible", timeout: 15_000 });
  const candidates = await sampleProjects.evaluateAll((items) => items.map((item) => ({
    id: item.getAttribute("data-project-id") ?? "",
    label: item.querySelector("strong")?.textContent?.trim() ?? "",
    selected: item.getAttribute("aria-pressed") === "true"
  })));
  if (!candidates.length || !candidates[0]?.id || !candidates[0]?.label) throw new Error("workbench_e2e_requires_system_fixture");

  await sampleProjects.nth(0).click();
  const activeProjectSummary = page.locator(".topbar-run-summary strong");
  await activeProjectSummary.filter({ hasText: candidates[0].label }).waitFor();
  const activeCandidate = candidates[0];
  if (candidates[1]) {
    await sampleProjects.nth(1).click();
    await activeProjectSummary.filter({ hasText: candidates[1].label }).waitFor();
    if ((await activeProjectSummary.textContent())?.includes(candidates[0].label)) {
      throw new Error("workbench_e2e_stale_project_state");
    }
    await sampleProjects.nth(0).click();
    await activeProjectSummary.filter({ hasText: activeCandidate.label }).waitFor();
  }

  // The configuration drawer deliberately uses a modal overlay. Close it
  // before exercising the main workspace through its real close control. The
  // drawer itself is above the overlay, so clicking the overlay at a fixed
  // coordinate can land inside the open panel on wide viewports.
  await page.locator(".drawer-left.open").getByTitle("关闭").click();
  await page.locator(".drawer-overlay.open").waitFor({ state: "hidden" });

  // The central surface is intentionally a workspace switch, not an external
  // editor. With no failed run selected it must show the safe sandbox entry
  // point and return to the live preview without changing the selected project.
  await page.getByRole("tab", { name: "代码" }).click();
  await page.getByText("资源管理器", { exact: true })
    .or(page.getByText("选择项目后即可在这里查看受控代码副本。", { exact: true }))
    .first()
    .waitFor();
  await page.getByRole("tab", { name: "现场" }).click();
  await page.getByRole("tab", { name: "现场", selected: true }).waitFor();

  const generation = await page.evaluate(async ({ projectId, token }) => {
    const response = await fetch("/agent-api/api/generate-plan", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-agent-token": token },
      body: JSON.stringify({
        projectId,
        requirement: "全面扫描关键用户流程",
        diff: "",
        plannerMode: "rules"
      })
    });
    return { status: response.status, body: await response.json() };
  }, { projectId: activeCandidate.id, token: agentToken });
  if (generation.status !== 200) throw new Error(`workbench_e2e_generation_http_${generation.status}`);
  if (!generation.body?.plan?.levels?.length) throw new Error("workbench_e2e_generation_empty");
  if (generation.body.source !== "rules") throw new Error(`workbench_e2e_generation_source:${generation.body.source}`);

  console.log(JSON.stringify({
    ok: true,
    selectedProjects: candidates.slice(0, 2).map((item) => item.label),
    modelDemoAcceptance,
    generationSource: generation.body.source,
    generatedLevels: generation.body.plan.levels.length
  }, null, 2));
} finally {
  await browser.close();
}
