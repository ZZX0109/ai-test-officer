import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { runDiscoveryScan } from "../src/discoveryScan.js";
import { approveScenarioDraft, probeScenarioDraft, writeScenarioDraft } from "../src/harnessGapStore.js";
import { getScenario } from "../src/scenarios.js";
import { runVisualGrayTest } from "../src/testRunner.js";
import type { SourceReadEnvelope } from "../src/types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

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
    assert.equal(discovery.page.headings.includes("Streaming App Ready"), true);
    assert.equal(discovery.page.testIds.includes("streaming-action"), true);
    assert.equal(discovery.suggestions.some((suggestion) => suggestion.riskKind === "api_contract"), false);
    assert.match(discovery.message, /页面已渲染/);
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
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
