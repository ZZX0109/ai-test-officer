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

  const projectPicker = page.locator("select").first();
  await projectPicker.locator("option").nth(1).waitFor({ state: "attached", timeout: 15_000 });
  const options = await projectPicker.locator("option").evaluateAll((items) =>
    items.map((item) => ({ value: (item).value, label: item.textContent?.trim() ?? "" }))
  );
  const candidates = options.filter((item) => item.value);
  if (!candidates.length) throw new Error("workbench_e2e_requires_project");

  await projectPicker.selectOption(candidates[0].value);
  const activeProjectSummary = page.locator(".topbar-run-summary strong");
  await activeProjectSummary.filter({ hasText: candidates[0].label }).waitFor();
  if (await projectPicker.inputValue() !== candidates[0].value) {
    throw new Error("workbench_e2e_first_project_not_selected");
  }
  const activeCandidate = candidates[0];
  if (candidates[1]) {
    await projectPicker.selectOption(candidates[1].value);
    await activeProjectSummary.filter({ hasText: candidates[1].label }).waitFor();
    if (await projectPicker.inputValue() !== candidates[1].value) {
      throw new Error("workbench_e2e_second_project_not_selected");
    }
    if ((await activeProjectSummary.textContent())?.includes(candidates[0].label)) {
      throw new Error("workbench_e2e_stale_project_state");
    }
    await projectPicker.selectOption(activeCandidate.value);
    await activeProjectSummary.filter({ hasText: activeCandidate.label }).waitFor();
  }

  // The central surface is intentionally a workspace switch, not an external
  // editor. With no failed run selected it must show the safe sandbox entry
  // point and return to preview without changing the selected project.
  await page.getByRole("tab", { name: "代码" }).click();
  await page.getByText("资源管理器", { exact: true })
    .or(page.getByRole("heading", { name: "先创建可审阅的沙盒副本" }))
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
  }, { projectId: activeCandidate.value, token: agentToken });
  if (generation.status !== 200) throw new Error(`workbench_e2e_generation_http_${generation.status}`);
  if (!generation.body?.plan?.levels?.length) throw new Error("workbench_e2e_generation_empty");
  if (generation.body.source !== "rules") throw new Error(`workbench_e2e_generation_source:${generation.body.source}`);

  console.log(JSON.stringify({
    ok: true,
    selectedProjects: candidates.slice(0, 2).map((item) => item.value),
    generationSource: generation.body.source,
    generatedLevels: generation.body.plan.levels.length
  }, null, 2));
} finally {
  await browser.close();
}
