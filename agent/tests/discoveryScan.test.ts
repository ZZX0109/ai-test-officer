import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { runDiscoveryScan } from "../src/discoveryScan.js";
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
    const discovery = await runDiscoveryScan({ appUrl: baseUrl, sourceContexts });
    assert.equal(discovery.status, "passed");
    assert.equal(discovery.page.testIds.includes("task-table"), true);
    assert.equal(discovery.openApiOperations[0]?.operationId, "listItems");
    assert.equal(discovery.suggestions[0]?.riskKind, "navigation");
    assert.deepEqual(discovery.suggestions[0]?.actions, ["visual_check"]);
    assert.equal(discovery.suggestions.some((suggestion) => suggestion.riskKind === "form"), true);
    assert.equal(discovery.suggestions.some((suggestion) => suggestion.riskKind === "table"), true);
    assert.equal(discovery.drafts.length, discovery.suggestions.length);
    assert.equal(discovery.drafts.every((draft) => draft.draftReviewStatus === "draft"), true);
    await Promise.all(discovery.drafts.map((draft) =>
      rm(path.join(rootDir, "reports", "harness-gaps", "drafts", `${draft.scenarioId}.json`), { force: true })
    ));
  });
}
