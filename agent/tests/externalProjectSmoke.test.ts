import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveProject, startProject, stopProject, testProjectConnection } from "../src/projectAdapter.js";
import { detectProject } from "../src/projectDetection.js";
import { runVisualGrayTest } from "../src/testRunner.js";
import { runSmokeFirstDiscovery } from "../src/smokeFirstDiscovery.js";
import { approveScenarioDraft, probeScenarioDraft } from "../src/harnessGapStore.js";

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
  const generatedScenarioFiles: string[] = [];
  const generatedDraftFiles: string[] = [];
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

    // This mirrors the interactive upload path: only after the OCI runtime is
    // healthy do we discover the live page, bind a generated scenario against
    // its real DOM and execute it.  It guards against regressing to a UI that
    // merely lists static code-graph flows without ever producing a runnable
    // browser path for an uploaded project.
    const discovery = await runSmokeFirstDiscovery({
      projectId,
      goal: "全面扫描",
      smokeAttempts: 2,
      discoveryAttempts: 2
    });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.orchestration?.status, "ready");
    assert.ok(discovery.suggestions.length > 0, "live page discovery should yield testable candidates");
    assert.ok((discovery.recommendedScenarioIds?.length ?? 0) > 0, "comprehensive discovery should retain every selected candidate");
    for (const item of discovery.drafts) {
      generatedDraftFiles.push(path.join(rootDir, "reports", "harness-gaps", "drafts", `${item.scenarioId}.json`));
    }

    const draft = discovery.drafts.find((item) => {
      const core = item.scenario.corePath as { action?: unknown } | undefined;
      return core?.action === "table_sort_filter_paginate";
    }) ?? discovery.drafts[0];
    assert.ok(draft, "discovery should produce at least one bindable scenario draft");
    generatedScenarioFiles.push(path.join(rootDir, "data", "scenarios", `${draft.scenarioId}.json`));
    const probed = await probeScenarioDraft(draft.scenarioId);
    assert.equal(
      probed.selectorProbeStatus,
      "passed",
      `generated scenario must bind to the live project DOM before execution: ${(probed.missingInfo ?? []).join(", ")}`
    );
    const approvedDraft = await approveScenarioDraft(draft.scenarioId);
    assert.equal(approvedDraft.draftReviewStatus, "approved");

    const dynamicRun = await runVisualGrayTest({
      projectId,
      scenarioId: draft.scenarioId,
      requirement: "上传项目的全面扫描动态路径验证",
      diff: "generated after live page discovery",
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
    assert.ok(dynamicRun.evidence.some((item) => item.type === "screenshot"));
    assert.ok(dynamicRun.evidence.some((item) => item.type === "dom"));
    assert.ok(dynamicRun.evidence.some((item) => item.type === "network"));
    assert.equal(dynamicRun.outcomeSummary?.requirementCovered, true);
    assert.equal(dynamicRun.outcomeSummary?.artifactIntegrityVerified, true);

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
    await Promise.all(generatedScenarioFiles.map((file) => rm(file, { force: true })));
    await Promise.all(generatedDraftFiles.map((file) => rm(file, { force: true })));
    await rm(projectFile, { force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }
}
