import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(rootDir, "reports");
const projectDir = path.join(rootDir, "data", "projects");
const stateFile = path.join(reportsDir, "reliability-assets", "state.json");
const runStateFile = path.join(reportsDir, "run-state.sqlite");
const auditStateFile = path.join(reportsDir, "audit", "audit.sqlite");
const backgroundDir = path.join(reportsDir, "background");
const workbenchUrl = process.env.WORKBENCH_URL ?? "http://127.0.0.1:6174";
const agentUrl = process.env.AGENT_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4317"}`;
const agentToken = process.env.AGENT_API_TOKEN ?? "dev-local-token";
const sourceRunId = `run_reliability_e2e_${Date.now()}`;
const projectId = `reliability_e2e_${Date.now()}`;

function now() {
  return new Date().toISOString();
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function git(repository, args) {
  const result = await execFileAsync("git", ["-C", repository, ...args], { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

async function assertNotRunning() {
  const urls = [
    `${agentUrl}/api/health`,
    `${workbenchUrl}/agent-api/api/health`
  ];
  const live = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) live.push(url);
    } catch {
      // Expected when this test owns service startup.
    }
  }
  if (live.length) throw new Error(`reliability_e2e_refuses_existing_services:${live.join(",")}`);
}

async function waitForServices(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [agent, workbench] = await Promise.all([
        fetch(`${agentUrl}/api/health`, { signal: AbortSignal.timeout(2_000) }),
        fetch(`${workbenchUrl}/agent-api/api/health`, { signal: AbortSignal.timeout(2_000) })
      ]);
      if (agent.ok && workbench.ok) return;
    } catch {
      // Keep polling until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`reliability_e2e_services_not_ready:${agentUrl}:${workbenchUrl}`);
}

async function runNpm(script) {
  const { stdout, stderr } = await execFileAsync("npm", ["run", script], {
    cwd: rootDir,
    env: { ...process.env, HEADLESS: process.env.HEADLESS ?? "1" },
    maxBuffer: 16 * 1024 * 1024
  });
  return `${stdout}\n${stderr}`;
}

async function snapshotFiles(files) {
  const snapshot = new Map();
  for (const file of files) {
    snapshot.set(file, {
      exists: await exists(file),
      content: await readFile(file).catch(() => undefined)
    });
  }
  return snapshot;
}

async function restoreFiles(snapshot) {
  for (const [file, value] of snapshot) {
    if (value.exists && value.content !== undefined) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, value.content, { mode: 0o600 });
    } else {
      await rm(file, { force: true });
    }
  }
}

function event(runId, type, version, payload = {}) {
  return {
    schemaVersion: "1.0",
    id: `event_${sourceRunId}_${runId}_${version}`,
    runId,
    type,
    version,
    createdAt: new Date(Date.now() + version).toISOString(),
    actor: "reliability-assets-e2e",
    idempotencyKey: `reliability-assets-e2e:${runId}:${version}`,
    payload
  };
}

async function seedRun(runId, fixtureProjectId, databaseFile) {
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS run_projections (
      run_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, projection_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_control_events (
      event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, event_type TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
      UNIQUE(run_id, version)
    );
  `);
  const summary = {
    schemaVersion: "2.0",
    executionStatus: "completed",
    schedulingCompleted: true,
    executionStarted: true,
    executionSucceeded: true,
    requirementCovered: true,
    requirementPassed: true,
    artifactIntegrityVerified: true,
    evidenceGrounded: true,
    gateEligible: true,
    machineGate: { status: "pass", reasons: [], reasonDetails: [], assertionFailures: [], evidenceComplete: true },
    finalStatus: "pass"
  };
  const input = {
    organizationId: "local",
    projectId: fixtureProjectId,
    appUrl: "http://127.0.0.1:6173",
    runKind: "parent",
    requirement: "验证可信验收和测试资产链路"
  };
  const events = [
    event(runId, "run_created", 1, input),
    event(runId, "plan_generated", 2, { provenance: { source: "reliability-assets-e2e", compilationStatus: "validated", promptVersion: "e2e" } }),
    event(runId, "plan_approved", 3, { source: "reliability-assets-e2e" }),
    event(runId, "permission_granted", 4, { source: "reliability-assets-e2e" }),
    event(runId, "run_preparing", 5),
    event(runId, "run_started", 6, { workerAttemptId: `${runId}_attempt_1`, executionGeneration: 1 }),
    event(runId, "evidence_collecting", 7),
    event(runId, "run_judging", 8),
    event(runId, "run_completed", 9, { finalStatus: "pass", executionStatus: "completed", outcomeSummary: summary })
  ];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO run_control_events
      (event_id, run_id, event_type, version, created_at, actor, idempotency_key, event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of events) insert.run(item.id, item.runId, item.type, item.version, item.createdAt, item.actor, item.idempotencyKey, JSON.stringify(item));
  database.close();
}

async function seedCoverage(runId) {
  const coverageDir = path.join(reportsDir, "runs", runId);
  await mkdir(coverageDir, { recursive: true });
  const item = {
    schemaVersion: "1.0",
    id: `coverage_${runId}`,
    runId,
    flowId: "reliability-asset-flow",
    module: "可靠性资产链路",
    surface: "api",
    risk: "high",
    preconditions: [],
    permissions: ["targetNetwork"],
    testDataRefs: [],
    actionPathIds: ["reliability-asset-flow"],
    oracleIds: [`oracle_${runId}`],
    requiredEvidenceKinds: ["operation-log"],
    disposition: "executed",
    scenarioId: "reliability-asset-flow",
    createdAt: now(),
    updatedAt: now()
  };
  await writeFile(path.join(coverageDir, "coverage.json"), JSON.stringify([item], null, 2), { mode: 0o600 });
  return item;
}

async function seedProject(repositoryRoot, fixturePort) {
  await mkdir(path.join(repositoryRoot, "scripts"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({ name: "reliability-assets-e2e-fixture", private: true }, null, 2));
  await writeFile(path.join(repositoryRoot, "server.mjs"), [
    "import { createServer } from \"node:http\";",
    `const port = ${fixturePort};`,
    "const server = createServer((_request, response) => {",
    "  response.writeHead(200, { \"content-type\": \"text/plain\" });",
    "  response.end(\"reliability-assets-e2e-fixture\");",
    "});",
    "server.on(\"error\", (error) => { console.error(`fixture error: ${error.message}`); process.exitCode = 1; });",
    "server.listen(port, \"127.0.0.1\", () => console.log(`fixture listening on ${port}`));",
    ""
  ].join("\n"));
  await writeFile(path.join(repositoryRoot, "scripts", "verify-asset.mjs"), [
    "import { readFileSync } from \"node:fs\";",
    "const files = process.argv.slice(2);",
    "const contents = files.map((file) => readFileSync(file, \"utf8\"));",
    "if (contents.some((content) => content.includes(\"__ATO_MUTATION_UNREACHABLE__\"))) process.exit(1);",
    "process.exit(0);",
    ""
  ].join("\n"));
  await writeFile(path.join(repositoryRoot, "README.md"), "reliability-assets-e2e\n");
  await git(repositoryRoot, ["init", "-q"]);
  await git(repositoryRoot, ["config", "user.email", "reliability-assets-e2e@example.invalid"]);
  await git(repositoryRoot, ["config", "user.name", "Reliability Assets E2E"]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-q", "-m", "fixture initial"]);
  const baseRevision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "reliability-assets-e2e\nhead revision\n");
  await git(repositoryRoot, ["add", "README.md"]);
  await git(repositoryRoot, ["commit", "-q", "-m", "fixture head"]);
  const headRevision = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  await git(repositoryRoot, ["branch", "-M", "main"]);
  return { baseRevision, headRevision, originalBranch: "main", originalHead: headRevision };
}

async function seedReliabilityState(coverageItem, repositoryRoot) {
  const timestamp = now();
  const evidenceId = `${sourceRunId}_evidence`;
  const oracle = {
    schemaVersion: "2.0",
    id: `oracle_${sourceRunId}`,
    projectId,
    coverageItemId: coverageItem.id,
    type: "api-schema",
    description: "验证测试资产候选命令成功执行",
    preconditions: [],
    observationWindow: { start: "after-action", timeoutMs: 20_000, pollIntervalMs: 500 },
    comparison: { operator: "equals", expected: true, actualPath: "testResult.ok" },
    source: { kind: "formal-contract", id: `contract_${projectId}`, version: "1.0", sha256: "a".repeat(64) },
    decisionUse: "release",
    conflictRefs: [],
    humanConfirmation: { status: "confirmed", actor: "reliability-assets-e2e", confirmedAt: timestamp },
    lifecycle: { status: "active" },
    runEvidence: { runId: sourceRunId, evidenceRefs: [evidenceId], artifactIds: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const dataContract = {
    schemaVersion: "1.0",
    id: `tdc_${sourceRunId}`,
    projectId,
    coverageItemIds: [coverageItem.id],
    dataSources: [{ id: "fixture-db", kind: "sqlite", readOnly: true }],
    credentialRefs: [],
    namespace: { strategy: "run-child-seed", prefix: "ato" },
    randomSeed: 17,
    testTime: timestamp,
    roles: [],
    stages: ["prepare", "namespace", "migrate", "seed", "snapshot", "execute", "cleanup", "rollback", "verify-clean"].map((stage) => ({ stage, required: stage !== "rollback" })),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const sourceEvidence = {
    id: evidenceId,
    runId: sourceRunId,
    type: "operation",
    title: "可信来源 Run 已完成并通过正式契约",
    timestamp,
    payload: { source: "reliability-assets-e2e", repositoryRoot, credentialRefOnly: true }
  };
  const current = await readFile(stateFile, "utf8").then((value) => JSON.parse(value)).catch(() => ({
    oracles: [], dataContracts: [], dataReceipts: [], differentialRuns: [], testAssets: [], reliabilityEvidence: [], reliabilityOutbox: []
  }));
  current.oracles = [...(current.oracles ?? []), oracle];
  current.dataContracts = [...(current.dataContracts ?? []), dataContract];
  current.reliabilityEvidence = [...(current.reliabilityEvidence ?? []), sourceEvidence];
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(current, null, 2), { mode: 0o600 });
  return { oracle, dataContract, sourceEvidence };
}

async function apiRequest(endpoint, options = {}) {
  const response = await fetch(`${agentUrl}${endpoint}`, {
    ...options,
    headers: { "content-type": "application/json", "x-agent-token": agentToken, ...(options.headers ?? {}) }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) throw new Error(`reliability_e2e_api_${response.status}:${endpoint}:${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function exerciseWorkbench(revisions) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1_000 } });
    await page.goto(workbenchUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.getByText("测试官工作台", { exact: true }).waitFor();
    await page.getByRole("button", { name: "配置与证据" }).click();
    await page.getByRole("button", { name: "项目与运行配置" }).click();
    const projectPicker = page.getByLabel("之前接入的项目");
    await projectPicker.locator(`option[value="${projectId}"]`).waitFor({ state: "attached", timeout: 15_000 });
    await projectPicker.selectOption(projectId);
    await page.locator(".drawer-left.open").getByTitle("关闭").click();
    await page.locator(".drawer-overlay.open").waitFor({ state: "hidden" });

    const reliability = page.locator('[aria-label="可信验收与测试资产"]');
    await page.locator(".reliability-assets-details > summary").click();
    await reliability.getByLabel("可信来源 Run ID").fill(sourceRunId);
    await reliability.getByRole("button", { name: "载入来源 Run" }).click();
    await reliability.getByText(new RegExp(`项目 ${projectId}`)).waitFor({ timeout: 20_000 });
    await reliability.getByPlaceholder("commit / tag").nth(0).fill(revisions.baseRevision);
    await reliability.getByPlaceholder("commit / tag").nth(1).fill(revisions.headRevision);

    let capturedDifferentialRequest;
    page.on("request", (request) => {
      if (request.method() !== "POST" || !request.url().includes("/v1/differential-runs")) return;
      try { capturedDifferentialRequest = request.postDataJSON(); } catch { /* the API assertion below reports a missing payload */ }
    });
    await reliability.getByRole("button", { name: "创建并执行 Base/Head" }).click();
    const differential = await pollDifferentialFromApi();
    if (!capturedDifferentialRequest
      || capturedDifferentialRequest.projectId !== projectId
      || capturedDifferentialRequest.baseRevision !== revisions.baseRevision
      || capturedDifferentialRequest.headRevision !== revisions.headRevision
      || capturedDifferentialRequest.dataContractId !== `tdc_${sourceRunId}`
      || !capturedDifferentialRequest.oracleSpecIds?.includes(`oracle_${sourceRunId}`)
      || !capturedDifferentialRequest.plan?.coverageItemIds?.includes(`coverage_${sourceRunId}`)
      || !capturedDifferentialRequest.environmentHash
      || !capturedDifferentialRequest.idempotencyKey) {
      throw new Error(`reliability_e2e_workbench_request_incomplete:${JSON.stringify(capturedDifferentialRequest)}`);
    }
    if (differential.differentialRun.status !== "completed" || differential.parentRun?.state !== "completed") {
      const parentEvents = await apiRequest(`/v1/runs/${encodeURIComponent(differential.differentialRun.id)}/events`).catch((error) => ({ error: String(error) }));
      throw new Error(`reliability_e2e_parent_not_terminal:${JSON.stringify({ differential, parentEvents })}`);
    }
    if (differential.differentialRun.base.state !== "completed" || differential.differentialRun.head.state !== "completed") {
      throw new Error(`reliability_e2e_side_not_terminal:${JSON.stringify({
        ...differential,
        fixtureSource: await readFile(path.join(temporaryRoot, "server.mjs"), "utf8").catch(() => "missing"),
        fixtureProject: await readFile(projectFile, "utf8").then((value) => JSON.parse(value)).catch(() => "missing")
      })}`);
    }
    await reliability.getByText(/分类：expected-change/).waitFor({ timeout: 30_000 });
    await reliability.getByText(/Parent .*completed/).waitFor();

    const assetForm = reliability.getByText("生成和验证测试资产", { exact: true });
    await assetForm.click();
    await reliability.getByRole("button", { name: "生成 TypeScript 候选" }).click();
    const assetIdInput = reliability.getByPlaceholder("asset_…");
    try {
      await page.waitForFunction((input) => Boolean(input?.value), await assetIdInput.elementHandle(), { timeout: 30_000 });
    } catch (error) {
      const panelText = (await reliability.textContent().catch(() => ""))?.slice(-2_000);
      throw new Error(`reliability_e2e_asset_generation_timeout:${error instanceof Error ? error.message : String(error)}:${panelText}`);
    }
    const assetId = await assetIdInput.inputValue();
    if (!assetId) throw new Error("reliability_e2e_asset_id_missing");

    await reliability.getByRole("button", { name: "验证 3 次 + Mutation" }).click();
    try {
      await reliability.getByText(/重复：3\/3/).waitFor({ timeout: 120_000 });
    } catch (error) {
      const panelText = (await reliability.textContent().catch(() => ""))?.slice(-2_000);
      const failedAssetId = await reliability.getByPlaceholder("asset_…").inputValue().catch(() => "");
      const failedAsset = failedAssetId
        ? await apiRequest(`/v1/test-assets/${encodeURIComponent(failedAssetId)}`).catch((detail) => ({ error: String(detail) }))
        : undefined;
      const validationRuns = failedAsset?.asset?.validation?.runIds
        ? await Promise.all(failedAsset.asset.validation.runIds.map(async (runId) => ({
          run: await apiRequest(`/v1/runs/${encodeURIComponent(runId)}`).catch((detail) => ({ error: String(detail), runId })),
          evidence: await apiRequest(`/api/runs/${encodeURIComponent(runId)}/evidence`).catch((detail) => ({ error: String(detail), runId }))
        })))
        : [];
      throw new Error(`reliability_e2e_validation_failed:${JSON.stringify({ panelText, validation: failedAsset?.asset?.validation, validationRuns })}`, { cause: error });
    }
    await reliability.getByText(/Mutation：1\/1/).waitFor();
    await reliability.getByLabel("Capability Grant ID").fill("reliability-e2e-grant");
    await reliability.getByLabel("确认人").fill("reliability-e2e-user");
    await reliability.getByRole("button", { name: "安全写入新分支" }).click();
    await reliability.getByText(/已写入新分支 codex\/ai-test-assets-/).waitFor({ timeout: 60_000 });
    const applied = await apiRequest(`/v1/test-assets/${encodeURIComponent(assetId)}`);
    if (applied.asset.status !== "applied") throw new Error(`reliability_e2e_asset_not_applied:${applied.asset.status}`);
    return { differentialId: differential.differentialRun.id, assetId, applied };

    async function pollDifferentialFromApi() {
      const deadline = Date.now() + 120_000;
      let latest;
      while (Date.now() < deadline) {
        latest = await apiRequest(`/v1/differential-runs/${encodeURIComponent(await readDifferentialId())}`);
        const value = latest.differentialRun;
        if (["completed", "blocked", "failed"].includes(value.status)
          && ["completed", "failed", "blocked", "cancelled"].includes(value.base.state)
          && ["completed", "failed", "blocked", "cancelled"].includes(value.head.state)
          && ["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(latest.parentRun?.state)) return latest;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("reliability_e2e_ui_differential_timeout");
    }

    async function readDifferentialId() {
      const input = reliability.getByPlaceholder("diff_…");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = await input.inputValue();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const error = await reliability.locator('[role="alert"]').textContent().catch(() => "");
      throw new Error(`reliability_e2e_differential_create_failed:${error ?? "no UI error"}`);
    }
  } finally {
    await browser.close();
  }
}

let temporaryRoot;
let startedServices = false;
let fixtureServer;
let projectFile;
let initialRunDirectories = new Set();
const restoreSnapshot = await snapshotFiles([
  stateFile,
  ...["", "-wal", "-shm"].map((suffix) => `${runStateFile}${suffix}`),
  ...["", "-wal", "-shm"].map((suffix) => `${auditStateFile}${suffix}`),
  path.join(backgroundDir, "dev-supervisor.stdout.log"),
  path.join(backgroundDir, "dev-supervisor.pid")
]);

try {
  await assertNotRunning();
  initialRunDirectories = new Set((await readdir(path.join(reportsDir, "runs"), { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).map((item) => item.name));
  temporaryRoot = await mkdtemp(path.join(rootDir, ".ato-reliability-e2e-"));
  fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("reliability-assets-e2e-fixture");
  });
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.1", resolve);
  });
  const fixturePort = fixtureServer.address()?.port;
  if (!fixturePort) throw new Error("reliability_e2e_fixture_server_failed");
  const fixtureServerUrl = `http://127.0.0.1:${fixturePort}`;
  await new Promise((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
  fixtureServer = undefined;
  const revisions = await seedProject(temporaryRoot, fixturePort);
  projectFile = path.join(projectDir, `${projectId}.json`);
  const timestamp = now();
  const manifest = {
    schemaVersion: "1.0",
    projectId,
    workspaceRoot: temporaryRoot,
    commands: {
      targetedTest: { executable: "node", args: ["scripts/verify-asset.mjs"] },
      test: { executable: "node", args: ["scripts/verify-asset.mjs"] }
    },
    commandAllowlist: ["node"],
    ports: [],
    environmentAllowlist: ["ATO_APP_URL", "PLAYWRIGHT_BASE_URL", "BASE_URL", "ATO_TEST_DATA_NAMESPACE", "ATO_TEST_DATA_RUN_ID"],
    dataSources: [{ id: "fixture-db", kind: "sqlite", readOnly: true }],
    capabilities: { browser: true, desktop: false, allowedBundleIds: [] },
    execution: { mode: "trusted-local" },
    budget: { runTimeoutMs: 120_000, prepareTimeoutMs: 30_000, scenarioTimeoutMs: 30_000, stepTimeoutMs: 10_000, maxSteps: 10, maxAttempts: 1, maxScreenshots: 2, maxVideoBytes: 1_000_000, maxLogBytes: 1_000_000, maxArtifactBytes: 10_000_000, maxConcurrency: 1 }
  };
  await mkdir(projectDir, { recursive: true });
  await writeFile(projectFile, JSON.stringify({
    id: projectId,
    name: "Reliability Assets E2E Fixture",
    projectPath: temporaryRoot,
    allowExternalProjectPath: false,
    installCommand: "",
    startCommand: "node server.mjs",
    startCommandSpec: { executable: "node", args: ["server.mjs"] },
    processes: [{
      name: "fixture",
      command: "node server.mjs",
      commandSpec: { executable: "node", args: ["server.mjs"] },
      healthCheckUrl: fixtureServerUrl,
      required: true
    }],
    frontendUrl: fixtureServerUrl,
    testCommandSpec: { executable: "node", args: ["scripts/verify-asset.mjs"] },
    env: { RELIABILITY_FIXTURE_PORT: String(fixturePort) },
    manifest,
    createdAt: timestamp,
    updatedAt: timestamp
  }, null, 2), { mode: 0o600 });
  const coverageItem = await seedCoverage(sourceRunId);
  const expected = await seedReliabilityState(coverageItem, temporaryRoot);
  await seedRun(sourceRunId, projectId, runStateFile);
  await runNpm("dev:background");
  startedServices = true;
  await waitForServices();

  const contextResponse = await apiRequest(`/v1/reliability-assets/context?projectId=${encodeURIComponent(projectId)}&sourceRunId=${encodeURIComponent(sourceRunId)}`);
  const context = contextResponse.context;
  const fixtureStatus = await git(temporaryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (fixtureStatus) throw new Error(`reliability_e2e_fixture_not_clean:${fixtureStatus}`);
  if (!/^[a-f0-9]{64}$/.test(context.repositorySha256)) throw new Error("reliability_e2e_context_hash_missing");
  const contextText = JSON.stringify(context).toLowerCase();
  if (/(password|api[-_]?key|secret|credentialvalue)/i.test(contextText)) throw new Error("reliability_e2e_context_leaked_secret");
  if (!context.dataContracts.some((item) => item.id === expected.dataContract.id)
    || !context.oracleSpecs.some((item) => item.id === expected.oracle.id)
    || !context.coverageItems.some((item) => item.id === coverageItem.id)
    || !context.evidenceRefs.some((item) => item.id === expected.sourceEvidence.id)) {
    throw new Error(`reliability_e2e_context_missing_reference:${JSON.stringify({
      dataContracts: context.dataContracts.map((item) => item.id),
      oracleSpecs: context.oracleSpecs.map((item) => item.id),
      coverageItems: context.coverageItems.map((item) => item.id),
      evidenceRefs: context.evidenceRefs.map((item) => item.id),
      expected: { dataContract: expected.dataContract.id, oracle: expected.oracle.id, coverage: coverageItem.id, evidence: expected.sourceEvidence.id },
      rawState: await readFile(stateFile, "utf8").then((value) => JSON.parse(value)).catch((error) => ({ readError: String(error) }))
    })}`);
  }

  const result = await exerciseWorkbench(revisions);
  const finalDiff = await apiRequest(`/v1/differential-runs/${encodeURIComponent(result.differentialId)}`);
  if (finalDiff.differentialRun.pairManifest.baseRunId !== `${result.differentialId}_base`
    || finalDiff.differentialRun.pairManifest.headRunId !== `${result.differentialId}_head`
    || finalDiff.parentRun?.state !== "completed") throw new Error("reliability_e2e_pair_manifest_or_parent_invalid");

  const currentBranch = await git(temporaryRoot, ["branch", "--show-current"]);
  const currentHead = await git(temporaryRoot, ["rev-parse", "HEAD"]);
  const status = await git(temporaryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!currentBranch.startsWith("codex/ai-test-assets-") || currentHead !== revisions.originalHead || !status.includes("tests/")) {
    throw new Error(`reliability_e2e_git_safety_failed:${JSON.stringify({ currentBranch, currentHead, status })}`);
  }
  console.log(JSON.stringify({
    ok: true,
    projectId,
    sourceRunId,
    differentialId: result.differentialId,
    assetId: result.assetId,
    parentState: finalDiff.parentRun.state,
    classification: finalDiff.differentialRun.pairManifest.classification,
    branch: currentBranch,
    automaticCommit: false,
    automaticPush: false
  }, null, 2));
} finally {
  if (startedServices) await runNpm("stop:dev").catch(() => undefined);
  const runDirectories = await readdir(path.join(reportsDir, "runs"), { withFileTypes: true }).catch(() => []);
  for (const item of runDirectories) {
    if (item.isDirectory() && !initialRunDirectories.has(item.name)) await rm(path.join(reportsDir, "runs", item.name), { recursive: true, force: true });
  }
  await restoreFiles(restoreSnapshot);
  await rm(projectFile ?? "", { force: true }).catch(() => undefined);
  await rm(temporaryRoot ?? "", { recursive: true, force: true });
  if (fixtureServer) await new Promise((resolve) => fixtureServer.close(() => resolve()));
}
