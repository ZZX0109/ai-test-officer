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
  await page.goto(workbenchUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByText("测试官工作台", { exact: true }).waitFor();

  // Project intake lives in the explicitly opened configuration drawer. The
  // first visible <select> is not a reliable project control after the
  // workbench's compact-layout redesign.
  await page.getByRole("button", { name: "配置与证据" }).click();
  await page.getByRole("button", { name: "项目与运行配置" }).click();
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
  // point and return to preview without changing the selected project.
  await page.getByRole("tab", { name: "代码" }).click();
  await page.getByText("资源管理器", { exact: true })
    .or(page.getByText("选择项目后即可在这里查看受控代码副本。", { exact: true }))
    .first()
    .waitFor();
  await page.getByRole("tab", { name: "预览" }).click();
  await page.getByRole("tab", { name: "预览", selected: true }).waitFor();

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
    generationSource: generation.body.source,
    generatedLevels: generation.body.plan.levels.length
  }, null, 2));
} finally {
  await browser.close();
}
