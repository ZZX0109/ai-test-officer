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
  const options = await projectPicker.locator("option").evaluateAll((items) =>
    items.map((item) => ({ value: (item).value, label: item.textContent?.trim() ?? "" }))
  );
  const candidates = options.filter((item) => item.value);
  if (candidates.length < 2) throw new Error("workbench_e2e_requires_two_projects");

  await projectPicker.selectOption(candidates[0].value);
  await page.getByText(`测试对象：${candidates[0].label}`, { exact: false }).waitFor();
  if (await projectPicker.inputValue() !== candidates[0].value) {
    throw new Error("workbench_e2e_first_project_not_selected");
  }
  await projectPicker.selectOption(candidates[1].value);
  await page.getByText(`测试对象：${candidates[1].label}`, { exact: false }).waitFor();
  if (await projectPicker.inputValue() !== candidates[1].value) {
    throw new Error("workbench_e2e_second_project_not_selected");
  }
  if (await page.getByText(`测试对象：${candidates[0].label}`, { exact: false }).count()) {
    throw new Error("workbench_e2e_stale_project_state");
  }

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
  }, { projectId: candidates[1].value, token: agentToken });
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
