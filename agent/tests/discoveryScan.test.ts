import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { runDiscoveryScan } from "../src/discoveryScan.js";
import {
  probeDiscoveryConnectivity,
  runSmokeFirstDiscovery,
  type DiscoveryConnectivityResult
} from "../src/smokeFirstDiscovery.js";
import { approveScenarioDraft, probeScenarioDraft, writeScenarioDraft } from "../src/harnessGapStore.js";
import { getScenario } from "../src/scenarios.js";
import { runVisualGrayTest } from "../src/testRunner.js";
import type { SourceReadEnvelope } from "../src/types.js";
import { readDiscoveryPageObservation } from "../src/pageObservationStore.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

function localArtifactPath(storageUri: string) {
  assert.match(storageUri, /^\/artifacts\//);
  return path.join(rootDir, "reports", storageUri.slice("/artifacts/".length));
}

function mockDiscoveryResult(input: {
  status: "passed" | "failed";
  retryable: boolean;
  userActionRequired?: boolean;
  interactiveElementCount?: number;
}) {
  const createdAt = new Date().toISOString();
  return {
    id: `mock_discovery_${Date.now()}`,
    createdAt,
    target: { frontendUrl: "http://127.0.0.1:5173" },
    page: {
      url: "http://127.0.0.1:5173",
      headings: [],
      links: [],
      buttons: [],
      inputs: [],
      forms: [],
      testIds: []
    },
    networkEndpoints: [],
    openApiOperations: [],
    observation: {
      requestedUrl: "http://127.0.0.1:5173",
      finalUrl: "http://127.0.0.1:5173",
      startedAt: createdAt,
      capturedAt: createdAt,
      durationMs: 1,
      stage: input.status === "passed" ? "completed" as const : "navigation" as const,
      status: input.status === "passed" ? "ready" as const : "failed" as const,
      navigation: {
        documentCommitted: input.status === "passed",
        httpStatus: input.status === "passed" ? 200 : undefined
      },
      document: {
        interactiveElementCount: input.interactiveElementCount ?? (input.status === "passed" ? 1 : 0),
        controls: []
      },
      console: [],
      pageErrors: [],
      failedRequests: [],
      diagnosis: {
        summary: input.status === "passed" ? "ready" : "not ready",
        likelyCauses: input.status === "passed" ? [] : ["unreachable"],
        retryable: input.retryable,
        userActionRequired: input.userActionRequired ?? false
      }
    },
    suggestions: [],
    drafts: [],
    status: input.status,
    message: input.status === "passed" ? "passed" : "failed"
  };
}

export async function testSmokeFirstDiscoveryOrchestration() {
  const target = { frontendUrl: "http://127.0.0.1:5173" };
  let fetchCalls = 0;
  const waiting = await probeDiscoveryConnectivity({
    target,
    runtimeStatus: {
      projectId: "project",
      status: "starting",
      phase: "waiting_for_health",
      message: "still starting"
    },
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("ok");
    }) as typeof fetch
  });
  assert.equal(waiting.status, "waiting");
  assert.equal(fetchCalls, 0, "starting runtime must not start a full discovery probe");

  const responses = [503, 200];
  const recovered = await probeDiscoveryConnectivity({
    target,
    runtimeStatus: { projectId: "project", status: "running", message: "ready" },
    maxAttempts: 2,
    fetchImpl: (async () => new Response("ok", { status: responses.shift() ?? 500 })) as typeof fetch,
    sleep: async () => undefined
  });
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.attempts, 2);

  const authBlocked = await probeDiscoveryConnectivity({
    target,
    runtimeStatus: { projectId: "project", status: "running", message: "ready" },
    maxAttempts: 3,
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("login required", { status: 401 });
    }) as typeof fetch
  });
  assert.equal(authBlocked.status, "blocked");
  assert.equal(authBlocked.attempts, 1, "non-retryable auth block must fail fast");

  const readySmoke: DiscoveryConnectivityResult = {
    status: "ready",
    checkedUrl: target.frontendUrl,
    attempts: 1,
    maxAttempts: 2,
    reason: "connectivity_smoke_passed:http_200",
    retryable: false,
    runtimeStatus: "running",
    httpStatus: 200
  };
  let discoveryCalls = 0;
  const retried = await runSmokeFirstDiscovery(
    { target, discoveryAttempts: 2 },
    {
      probe: async () => readySmoke,
      scan: async () => {
        discoveryCalls += 1;
        return mockDiscoveryResult({
          status: discoveryCalls === 1 ? "failed" : "passed",
          retryable: true
        });
      },
      sleep: async () => undefined
    }
  );
  assert.equal(retried.status, "passed");
  assert.equal(discoveryCalls, 2);
  assert.equal(retried.orchestration?.discoveryAttempts, 2);

  discoveryCalls = 0;
  const noControls = await runSmokeFirstDiscovery(
    { target, discoveryAttempts: 2 },
    {
      probe: async () => readySmoke,
      scan: async () => {
        discoveryCalls += 1;
        return mockDiscoveryResult({
          status: "passed",
          retryable: false,
          interactiveElementCount: 0
        });
      },
      sleep: async () => undefined
    }
  );
  assert.equal(noControls.status, "failed");
  assert.equal(noControls.orchestration?.status, "failed");
  assert.equal(discoveryCalls, 2, "a blank HTTP 200 page gets one bounded retry before planning is blocked");
  assert.match(noControls.message, /未发现可操作控件/);
  assert.match(noControls.message, /冷加载/);
  assert.match(noControls.message, /无需用户操作/);
  assert.doesNotMatch(noControls.message, /已保存.*截图/);
  assert.equal(noControls.observation.diagnosis.retryable, true);
  assert.equal(noControls.observation.diagnosis.userActionRequired, false);
  assert.match(noControls.observation.diagnosis.summary, /HTTP 200/);

  discoveryCalls = 0;
  const blockedSmoke: DiscoveryConnectivityResult = {
    ...readySmoke,
    status: "blocked",
    reason: "credential_missing",
    retryable: false
  };
  const blocked = await runSmokeFirstDiscovery(
    { target },
    {
      probe: async () => blockedSmoke,
      scan: async () => {
        discoveryCalls += 1;
        return mockDiscoveryResult({ status: "passed", retryable: false });
      }
    }
  );
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.orchestration?.status, "blocked");
  assert.equal(discoveryCalls, 0, "blocked smoke must not expand into a full discovery scan");
}

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

export async function testDiscoveryScanDrafts() {
  await withHttpServer((req, res) => {
    if (req.url === "/api/items") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: 1, name: "Alpha" }]));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Fixture Discovery</title></head>
        <body>
          <h1>Fixture Discovery</h1>
          <form>
            <label for="title">任务标题</label>
            <input id="title" name="title" data-testid="task-title-input" />
            <button type="button" data-testid="submit-task">创建</button>
          </form>
          <button type="button" data-testid="sort-table">排序</button>
          <div data-testid="task-table">Alpha</div>
          <script>fetch("/api/items").catch(() => undefined)</script>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const sourceContexts: SourceReadEnvelope[] = [{
      id: "src_openapi_discovery",
      kind: "openapi",
      title: "OpenAPI",
      uri: `${baseUrl}/openapi.json`,
      status: "connected",
      summary: "Fixture API contract",
      permissionState: "read_allowed",
      isSimulated: false,
      readAt: new Date().toISOString(),
      trustLevel: "high",
      readMeta: {
        openApi: {
          operationCount: 1,
          operations: [{
            method: "GET",
            path: "/api/items",
            operationId: "listItems",
            summary: "List items"
          }]
        }
      }
    }];
    const discovery = await runDiscoveryScan({ appUrl: baseUrl, sourceContexts, goal: "全面灰度测试" });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.observation.navigation.documentCommitted, true);
    assert.equal(discovery.observation.id, discovery.id);
    assert.equal(discovery.observation.stage, "completed");
    assert.ok(discovery.observation.document.interactiveElementCount >= 3);
    assert.equal(
      discovery.observation.document.controls.some((control) => control.testId === "submit-task"),
      true
    );
    assert.match(discovery.observation.document.bodyTextSample ?? "", /Fixture Discovery/);
    assert.ok(discovery.observation.screenshot?.storageUri);
    assert.match(discovery.observation.screenshot?.storageUri ?? "", /^\/artifacts\/discovery\//);
    const persistedObservation = await readDiscoveryPageObservation(discovery.id);
    assert.equal(persistedObservation?.observation.id, discovery.id);
    assert.equal(persistedObservation?.observation.document.bodyTextSample?.includes("<html"), false);
    assert.equal(discovery.page.testIds.includes("task-table"), true);
    assert.equal(discovery.openApiOperations[0]?.operationId, "listItems");
    assert.equal(discovery.suggestions[0]?.riskKind, "navigation");
    assert.deepEqual(discovery.suggestions[0]?.actions, ["visual_check"]);
    assert.equal(discovery.recommendedScenarioId, discovery.suggestions[0]?.suggestedScenarioId);
    assert.deepEqual(
      discovery.recommendedScenarioIds,
      discovery.suggestions.map((suggestion) => suggestion.suggestedScenarioId),
      "a comprehensive scan must keep every discovered path; budgets limit execution concurrency, not discovery visibility"
    );
    assert.equal(discovery.selectionProvenance?.mode, "deterministic");
    assert.equal(
      discovery.suggestions.some((suggestion) => suggestion.riskKind === "form"),
      true,
      `expected form suggestion for ${JSON.stringify({ inputs: discovery.page.inputs, buttons: discovery.page.buttons })}`
    );
    assert.equal(
      discovery.suggestions.some((suggestion) => suggestion.riskKind === "table"),
      true,
      `expected table suggestion for ${JSON.stringify(discovery.page.buttons)}`
    );
    assert.equal(discovery.drafts.length, discovery.suggestions.length);
    assert.equal(discovery.drafts.every((draft) => draft.draftReviewStatus === "draft"), true);
    const apiDraft = discovery.drafts.find((draft) => draft.riskKind === "api_contract");
    assert.ok(apiDraft, "runtime fetch must produce an API contract draft");
    const probed = await probeScenarioDraft(apiDraft.scenarioId);
    assert.equal(probed?.selectorProbeStatus, "passed");
    const approved = await approveScenarioDraft(apiDraft.scenarioId);
    assert.equal(approved?.draftReviewStatus, "approved");
    const apiScenario = getScenario(apiDraft.scenarioId);
    assert.equal(apiScenario.corePath.triggerButtonName, undefined, "observed API traffic must not invent a button");
    assert.equal(
      apiScenario.compiledPlanContract?.requiredSteps.some((step) => step.action.action === "click"),
      false,
      "a passive runtime API contract must not compile to a click"
    );
    const result = await runVisualGrayTest({
      appUrl: baseUrl,
      scenarioId: apiDraft.scenarioId,
      permissionProfile: {
        observe: true,
        browserControl: true,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    });
    assert.equal(result.executionError, undefined);
    assert.equal(result.assertions.find((item) => item.name === "接口请求符合契约")?.passed, true);
    if (approved?.installedFile) {
      await rm(path.join(rootDir, approved.installedFile), { force: true });
    }
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryRecognizesLoginAfterNonFormControls() {
  await withHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Auth Fixture</title></head>
        <body>
          <h1>Sign In</h1>
          <input type="checkbox" aria-label="Theme" />
          <form>
            <input name="username" type="email" placeholder="user@company.com" />
            <input name="password" type="password" placeholder="********" />
            <button type="submit">Login</button>
          </form>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const discovery = await runDiscoveryScan({
      appUrl: baseUrl,
      projectId: "auth_fixture",
      goal: "验证登录"
    });
    const suggestion = discovery.suggestions.find((item) => item.riskKind === "auth");
    assert.ok(suggestion, "a leading checkbox must not hide the real authentication form");
    assert.deepEqual(suggestion.actions, ["login_as_test_user"]);
    const draft = discovery.drafts.find((item) => item.scenarioId === suggestion.suggestedScenarioId);
    assert.ok(draft);
    const core = draft.scenario.corePath as Record<string, unknown>;
    assert.equal(core.usernameLocator, "[name='username']");
    assert.equal(core.passwordLocator, "[name='password']");
    const probed = await probeScenarioDraft(draft.scenarioId);
    assert.equal(probed?.selectorProbeStatus, "passed", probed?.missingInfo?.join(","));
    const approved = await approveScenarioDraft(draft.scenarioId);
    assert.equal(approved?.draftReviewStatus, "approved");
    const installed = getScenario(draft.scenarioId);
    assert.equal(
      installed.compiledPlanContract?.requiredSteps.some((step) =>
        step.action.action === "fill" && step.action.valueRef === "projectLoginUsername"
      ),
      true
    );
    if (approved?.installedFile) {
      await rm(path.join(rootDir, approved.installedFile), { force: true });
    }
    await rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true });
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryScanAcceptsVisibleStreamingDom() {
  await withHttpServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "transfer-encoding": "chunked"
    });
    res.write(`
      <!doctype html>
      <html>
        <head><title>Streaming Fixture</title></head>
        <body>
          <h1>Streaming App Ready</h1>
          <button type="button" data-testid="streaming-action">继续</button>
    `);
    // Keep the initial document open longer than Discovery's lifecycle grace.
    // The visible DOM is still valid and should be scanned successfully.
    setTimeout(() => {
      if (!res.destroyed) res.end("</body></html>");
    }, 2_000).unref();
  }, async (baseUrl) => {
    const discovery = await runDiscoveryScan({ appUrl: baseUrl });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.observation.navigation.documentCommitted, true);
    assert.ok(discovery.observation.document.interactiveElementCount >= 1);
    assert.equal(discovery.page.headings.includes("Streaming App Ready"), true);
    assert.equal(discovery.page.testIds.includes("streaming-action"), true);
    assert.equal(discovery.suggestions.some((suggestion) => suggestion.riskKind === "api_contract"), false);
    assert.match(discovery.message, /Discovery Scan 完成/);
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryScanWaitsForProgressingModuleGraph() {
  await withHttpServer((req, res) => {
    if (req.url === "/stage-one.js") {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end('import "/stage-two.js";');
      }, 650).unref();
      return;
    }
    if (req.url === "/stage-two.js") {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(`
          const button = document.createElement("button");
          button.dataset.testid = "late-module-action";
          button.textContent = "模块加载完成";
          document.body.append(button);
        `);
      }, 650).unref();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Progressive Module Fixture</title></head>
        <body>
          <h1>Progressive Module Fixture</h1>
          <script type="module" src="/stage-one.js"></script>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const discovery = await runDiscoveryScan({
      appUrl: baseUrl,
      observationBudgetMs: 5_000,
      noProgressTimeoutMs: 500
    });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.page.testIds.includes("late-module-action"), true);
    assert.equal(
      discovery.observation.document.controls.some((control) =>
        control.testId === "late-module-action"
      ),
      true,
      "the final observation must be sampled after the progressing module graph settles"
    );
    assert.ok((discovery.observation.network?.totalRequests ?? 0) >= 3);
    assert.equal(
      discovery.observation.network?.completedRequests,
      discovery.observation.network?.totalRequests
    );
    assert.equal(discovery.observation.network?.activeRequests, 0);
    assert.ok((discovery.observation.network?.peakActiveRequests ?? 0) >= 1);
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryScanPreservesActiveNetworkAtBudgetBoundary() {
  await withHttpServer((req, res) => {
    if (req.url === "/slow-background") {
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      }, 30_000).unref();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Active Network Fixture</title></head>
        <body>
          <h1>Active Network Fixture</h1>
          <button data-testid="ready-action">继续</button>
          <script>fetch("/slow-background").catch(() => undefined)</script>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const discovery = await runDiscoveryScan({
      appUrl: baseUrl,
      observationBudgetMs: 3_000,
      noProgressTimeoutMs: 500
    });
    assert.equal(discovery.status, "passed", JSON.stringify({
      message: discovery.message,
      observation: discovery.observation
    }));
    assert.equal(discovery.page.testIds.includes("ready-action"), true);
    assert.ok((discovery.observation.network?.totalRequests ?? 0) >= 2);
    assert.ok((discovery.observation.network?.activeRequests ?? 0) >= 1);
    assert.match(discovery.observation.navigation.warning ?? "", /requests=\d+,active=\d+/);
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryObservationBoundsAndRedactsRuntimeFacts() {
  await withHttpServer((req, res) => {
    if (req.url?.startsWith("/api/private")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "temporary" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Bounded Observation</title></head>
        <body>
          <h1>Bounded Observation</h1>
          <label for="password">密码</label>
          <input id="password" type="password" value="must-not-be-observed" />
          <button data-testid="submit-secret">提交</button>
          <script>
            console.error("api_key=must-not-leak");
            fetch("/api/private?access_token=must-not-leak").catch(() => undefined);
          </script>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const discovery = await runDiscoveryScan({ appUrl: baseUrl });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.observation.status, "degraded");
    assert.equal(
      discovery.observation.document.controls.some((control) =>
        control.inputType === "password" && control.accessibleName === "密码"
      ),
      true
    );
    const serialized = JSON.stringify(discovery.observation);
    assert.doesNotMatch(serialized, /must-not-be-observed|must-not-leak/);
    assert.equal((discovery.observation.document.bodyTextSample?.length ?? 0) <= 1_200, true);
    assert.equal(discovery.observation.document.controls.length <= 40, true);
    assert.equal(discovery.observation.failedRequests.length <= 20, true);
    assert.equal(
      discovery.observation.failedRequests.some((request) =>
        request.status === 503
        && request.url.includes("access_token=[REDACTED]")
      ),
      true
    );
    assert.equal(
      discovery.observation.diagnosis.likelyCauses.includes("页面存在失败的网络请求"),
      true
    );
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
    if (discovery.observation.screenshot?.storageUri) {
      await rm(localArtifactPath(discovery.observation.screenshot.storageUri), { force: true });
    }
    await rm(path.join(rootDir, "reports", "discovery", "observations", `${discovery.id}.json`), { force: true });
  });
}

export async function testDiscoveryProbeExecutesActionBeforeOracle() {
  await withHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html>
      <html>
        <head><title>Action Probe Fixture</title></head>
        <body>
          <h1>Action Probe Fixture</h1>
          <button type="button" onclick="document.querySelector('#result').textContent='面板已打开'">打开面板</button>
          <div id="result">尚未打开</div>
        </body>
      </html>
    `);
  }, async (baseUrl) => {
    const scenarioId = `discovered_action_probe_${Date.now()}`;
    await writeScenarioDraft({
      gapId: `discovery_${scenarioId}`,
      createdAt: new Date().toISOString(),
      scenarioId,
      draftReviewStatus: "draft",
      selectorProbeStatus: "not_run",
      riskKind: "navigation",
      probeUrl: baseUrl,
      scenario: {
        id: scenarioId,
        title: "Action probe",
        planObservation: "discovery_scan -> selector_probe -> oracle_dry_run",
        smoke: {
          pathId: "open",
          stepId: "open",
          title: "open",
          headingName: "Action Probe Fixture",
          assertionName: "visible",
          expected: "Action Probe Fixture"
        },
        corePath: {
          pathId: "open_panel",
          stepId: "open_panel",
          title: "open panel",
          action: "visual_check",
          triggerButtonName: "打开面板",
          targetLocator: "#result",
          riskReason: "test",
          oracles: [{
            id: "panel_opened",
            name: "panel opened",
            type: "dom_text",
            locator: "#result",
            expectedTextIncludes: "面板已打开",
            expected: "面板已打开"
          }]
        }
      }
    });
    const probed = await probeScenarioDraft(scenarioId);
    assert.equal(probed?.selectorProbeStatus, "passed");
    assert.equal(probed?.probeTrace?.actionExecuted, true);
    assert.equal(probed?.probeTrace?.action, "visual_check");
    assert.equal(probed?.missingInfo?.length, 0);
    await rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${scenarioId}.json`), { force: true });
  });
}
