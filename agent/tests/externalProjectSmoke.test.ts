import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveProject, startProject, stopProject, testProjectConnection } from "../src/projectAdapter.js";
import { detectProject } from "../src/projectDetection.js";
import { runVisualGrayTest } from "../src/testRunner.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function testExternalProjectSmoke() {
  if (process.env.RUN_EXTERNAL_PROJECT_SMOKE !== "1") return;

  const tempRoot = await mkdtemp(path.join(tmpdir(), "ai-test-officer-external-smoke-"));
  const projectPath = path.join(tempRoot, "customer-portal-lite");
  const projectId = `external_project_smoke_${Date.now()}`;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectFile = path.join(rootDir, "data", "projects", `${projectId}.json`);
  const previousHeadless = process.env.HEADLESS;
  process.env.HEADLESS = "1";

  try {
    await cp(path.join(rootDir, "fixtures", "customer-portal-lite"), projectPath, { recursive: true });
    const timestamp = new Date().toISOString();
    const detection = await detectProject(projectPath);
    const detected = detection.suggestedConfig;
    const project = await saveProject({
      ...detected,
      id: projectId,
      name: "External Project Smoke Test",
      projectPath,
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
      manifest: detected.manifest
        ? {
          ...detected.manifest,
          projectId,
          environmentAllowlist: Array.from(new Set([...detected.manifest.environmentAllowlist, "PORT"]))
        }
        : undefined,
      cleanupCommand: "",
      timeoutMs: 15_000,
      createdAt: timestamp,
      updatedAt: timestamp,
      externalSmokeProfile: {
        keyPages: [{ id: "home", path: "/", expectedHeading: "Customer Portal Lite" }],
        table: {
          sortButton: "按金额排序",
          filterLabel: "客户筛选",
          filterValue: "Acme",
          nextButton: "下一页",
          expectedText: "Acme Renewal"
        }
      }
    });

    const runtime = await startProject(projectId);
    assert.equal(runtime.status, "running");
    const health = await testProjectConnection(project);
    assert.equal(health.ok, true);

    const run = await runVisualGrayTest({
      projectId,
      scenarioId: "generic_table_sort_filter_pagination",
      requirement: "外部项目表格排序筛选分页 smoke",
      diff: "external project fixture copied outside repository root",
      trigger: "manual",
      keepProjectRunning: true,
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
    assert.equal(run.assertions.every((assertion) => assertion.passed), true);
    assert.equal(run.judgeReport.releaseJudge.findings.every((finding) => finding.evidenceRefs.length > 0), true);
    assert.ok(run.runBundleFile);
  } finally {
    restoreEnv("HEADLESS", previousHeadless);
    await stopProject(projectId);
    await rm(projectFile, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}
