import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { buildImpactAnalysis } from "../src/impactAnalysis.js";
import { readConnectorContext } from "../src/sourceConnectors.js";

type EnvPatch = Record<string, string | undefined>;

async function withEnv<T>(patch: EnvPatch, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

function sendJson(res: ServerResponse, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

export async function testConnectorEnvelope() {
  const connectorInput = {
    fallbackDiff: "diff --git a/app-under-test/src/main.tsx b/app-under-test/src/main.tsx\n+ login auth change",
    requirementPath: "data/fixtures/task-filter-requirement.md",
    bugTicketPath: "data/fixtures/tapd-task-filter-bug.md",
    openApiPath: "data/fixtures/missing-openapi.json"
  };
  const context = await readConnectorContext(connectorInput);
  assert.ok(context.sourceContexts.length >= 5);
  assert.ok(context.sourceContexts.some((source) => source.kind === "git_diff"));
  assert.ok(context.sourceContexts.some((source) => source.kind === "openapi" && source.status === "missing"));
  assert.equal(context.sources.length, context.sourceContexts.length);
  assert.equal(context.sourceContexts.some((source) => source.isSimulated && source.status === "connected"), false);
  const fixtureSources = context.sourceContexts.filter((source) =>
    ["requirement_doc", "tapd_bug"].includes(source.kind) && /data\/fixtures\//.test(source.uri ?? "")
  );
  assert.equal(fixtureSources.length >= 2, true);
  assert.equal(fixtureSources.every((source) => source.status === "simulated"), true);
  assert.equal(fixtureSources.every((source) => source.isSimulated), true);
  assert.equal(fixtureSources.every((source) => source.trustLevel === "low"), true);
  const repeated = await readConnectorContext(connectorInput);
  assert.deepEqual(
    repeated.sourceContexts.map((source) => source.id),
    context.sourceContexts.map((source) => source.id)
  );
  const strict = await readConnectorContext({ strictInput: true, fallbackDiff: connectorInput.fallbackDiff });
  assert.equal(strict.sourceContexts.some((source) => source.status === "connected" && /fixture/i.test(source.uri ?? "")), false);
  assert.equal(strict.sourceContexts.some((source) => source.isSimulated), false);

  const externalDocRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-external-docs-"));
  const externalRequirement = path.join(externalDocRoot, "requirements.md");
  try {
    await writeFile(externalRequirement, "# External Requirement\nLogin should require a valid session.");
    const blockedExternal = await readConnectorContext({ requirementPath: externalRequirement, strictInput: true });
    const blockedRequirement = blockedExternal.sourceContexts.find((source) => source.kind === "requirement_doc");
    assert.equal(blockedRequirement?.status, "missing");
    assert.match(blockedRequirement?.failureReason ?? "", /CONNECTOR_FILE_ROOTS/);
    await withEnv({ CONNECTOR_FILE_ROOTS: externalDocRoot }, async () => {
      const allowedExternal = await readConnectorContext({ requirementPath: externalRequirement, strictInput: true });
      const requirement = allowedExternal.sourceContexts.find((source) => source.kind === "requirement_doc");
      assert.equal(requirement?.status, "connected");
      assert.equal(requirement?.isSimulated, false);
      assert.equal(requirement?.trustLevel, "high");
      assert.match(requirement?.summary ?? "", /requirements\.md/);
    });
  } finally {
    await rm(externalDocRoot, { recursive: true, force: true });
  }

  await withEnv({
    ALLOW_PRIVATE_CONNECTOR_URLS: "1",
    CONNECTOR_FETCH_RETRIES: "1",
    CONNECTOR_RETRY_DELAY_MS: "1",
    CONNECTOR_CACHE_TTL_MS: "60000"
  }, async () => {
    let requestCount = 0;
    await withHttpServer((req, res) => {
      if (req.url === "/requirement.md") {
        requestCount += 1;
        if (requestCount === 1) {
          res.writeHead(503, { "retry-after": "0" });
          res.end("try later");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/markdown",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "42"
        });
        res.end("# Requirement\nAuth flow should stay stable.");
        return;
      }
      res.writeHead(404);
      res.end("missing");
    }, async (baseUrl) => {
      const first = await readConnectorContext({ requirementUrl: `${baseUrl}/requirement.md`, strictInput: true });
      const requirement = first.sourceContexts.find((source) => source.kind === "requirement_doc");
      assert.equal(requirement?.status, "connected");
      assert.equal(requirement?.readMeta?.attempts, 2);
      assert.equal(requirement?.readMeta?.cacheStatus, "miss");
      assert.equal(requirement?.readMeta?.httpStatus, 200);
      assert.equal(requirement?.readMeta?.rateLimit?.remaining, 42);
      const second = await readConnectorContext({ requirementUrl: `${baseUrl}/requirement.md`, strictInput: true });
      const cached = second.sourceContexts.find((source) => source.kind === "requirement_doc");
      assert.equal(cached?.readMeta?.cacheStatus, "hit");
      assert.equal(cached?.readMeta?.attempts, 0);
      assert.equal(requestCount, 2);
    });
  });

  await withEnv({
    ALLOW_PRIVATE_CONNECTOR_URLS: "1",
    GITHUB_API_BASE_URL: "",
    GITHUB_MAX_FILE_PAGES: "5",
    CONNECTOR_FETCH_RETRIES: "0",
    CONNECTOR_CACHE_TTL_MS: "0"
  }, async () => {
    await withHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/diff") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("diff --git a/src/Auth.tsx b/src/Auth.tsx\n+ session change");
        return;
      }
      if (url.pathname === "/repos/acme/web/pulls/7") {
        sendJson(res, { title: "Fix auth flow", body: "fixes #11" });
        return;
      }
      if (url.pathname === "/repos/acme/web/pulls/7/files" && url.searchParams.get("page") === "1") {
        sendJson(
          res,
          Array.from({ length: 100 }, (_item, index) => ({ filename: `src/page-${index}.tsx` })),
          { link: `<${url.origin}/repos/acme/web/pulls/7/files?per_page=100&page=2>; rel="next"` }
        );
        return;
      }
      if (url.pathname === "/repos/acme/web/pulls/7/files" && url.searchParams.get("page") === "2") {
        sendJson(res, [{ filename: "src/Auth.tsx" }, { filename: "src/session.ts" }]);
        return;
      }
      if (url.pathname === "/repos/acme/web/issues/11") {
        sendJson(res, { title: "Auth bug", body: "Session should not be dropped." });
        return;
      }
      res.writeHead(404);
      res.end("missing");
    }, async (baseUrl) => {
      process.env.GITHUB_API_BASE_URL = baseUrl;
      const github = await readConnectorContext({
        prUrl: "https://github.com/acme/web/pull/7",
        prDiffUrl: `${baseUrl}/diff`,
        strictInput: true
      });
      const pr = github.sourceContexts.find((source) => source.kind === "github_pr");
      assert.equal(github.prMeta?.changedFiles.length, 102);
      assert.equal(github.prMeta?.linkedIssues[0]?.number, 11);
      assert.equal(pr?.readMeta?.pagination?.pagesRead, 2);
      assert.equal(pr?.readMeta?.pagination?.itemCount, 102);
      assert.equal(pr?.readMeta?.pagination?.hasMore, false);
    });
  });

  await withEnv({
    ALLOW_PRIVATE_CONNECTOR_URLS: "1",
    GITHUB_API_BASE_URL: "",
    CONNECTOR_FETCH_RETRIES: "0",
    CONNECTOR_CACHE_TTL_MS: "0"
  }, async () => {
    await withHttpServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/repos/acme/web/issues/13") {
        sendJson(res, {
          title: "Login permission regression",
          body: "Guest users can still edit tasks after logout.",
          state: "open",
          labels: [{ name: "bug" }, { name: "auth" }],
          user: { login: "qa-user" },
          html_url: "https://github.com/acme/web/issues/13"
        });
        return;
      }
      res.writeHead(404);
      res.end("missing");
    }, async (baseUrl) => {
      process.env.GITHUB_API_BASE_URL = baseUrl;
      const githubIssue = await readConnectorContext({
        bugTicketUrl: "https://github.com/acme/web/issues/13",
        strictInput: true
      });
      const issue = githubIssue.sourceContexts.find((source) => source.kind === "github_issue");
      assert.equal(issue?.status, "connected");
      assert.equal(issue?.readMeta?.httpStatus, 200);
      assert.equal(issue?.summary.includes("Login permission regression"), true);
      assert.equal(githubIssue.bugTicket.includes("Guest users can still edit tasks"), true);
    });
  });

  await withEnv({
    ALLOW_PRIVATE_CONNECTOR_URLS: "1",
    CONNECTOR_FETCH_RETRIES: "0",
    CONNECTOR_CACHE_TTL_MS: "0"
  }, async () => {
    await withHttpServer((req, res) => {
      if (req.url === "/rest/api/2/issue/QA-2048") {
        sendJson(res, {
          key: "QA-2048",
          fields: {
            summary: "Task create form drops required validation",
            description: "Submitting an empty title should show validation text.",
            status: { name: "To Do" },
            issuetype: { name: "Bug" },
            priority: { name: "High" },
            labels: ["form", "validation"]
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("missing");
    }, async (baseUrl) => {
      const jiraIssue = await readConnectorContext({
        bugTicketUrl: `${baseUrl}/browse/QA-2048`,
        strictInput: true
      });
      const issue = jiraIssue.sourceContexts.find((source) => source.kind === "jira_issue");
      assert.equal(issue?.status, "connected");
      assert.equal(issue?.readMeta?.httpStatus, 200);
      assert.equal(issue?.summary.includes("Task create form"), true);
      assert.equal(jiraIssue.bugTicket.includes("Submitting an empty title"), true);
    });
  });

  await withEnv({
    ALLOW_PRIVATE_CONNECTOR_URLS: "1",
    CONNECTOR_CACHE_TTL_MS: "0"
  }, async () => {
    await withHttpServer((req, res) => {
      if (req.url === "/openapi.json") {
        sendJson(res, {
          openapi: "3.1.0",
          info: { title: "Task API", version: "2026.07" },
          paths: {
            "/api/tasks": {
              get: {
                operationId: "listTasks",
                summary: "List tasks with status and keyword filters",
                tags: ["tasks"]
              },
              post: {
                operationId: "createTask",
                summary: "Create a task",
                tags: ["tasks"]
              }
            },
            "/api/auth/session": {
              post: {
                operationId: "loginSession",
                summary: "Create login session",
                tags: ["auth"]
              }
            }
          }
        });
        return;
      }
      if (req.url === "/openapi.yaml") {
        res.writeHead(200, { "content-type": "application/yaml" });
        res.end([
          "openapi: 3.1.0",
          "info:",
          "  title: Task API YAML",
          "  version: 2026.08",
          "paths:",
          "  /api/tasks:",
          "    get:",
          "      operationId: listTasksYaml",
          "      summary: List tasks from YAML",
          "      tags: [tasks]",
          "  /api/tasks/{id}:",
          "    patch:",
          "      operationId: updateTaskYaml",
          "      summary: Update task from YAML"
        ].join("\n"));
        return;
      }
      res.writeHead(404);
      res.end("missing");
    }, async (baseUrl) => {
      const jsonContext = await readConnectorContext({
        openApiUrl: `${baseUrl}/openapi.json`,
        strictInput: true
      });
      const jsonOpenApi = jsonContext.sourceContexts.find((source) => source.kind === "openapi");
      assert.equal(jsonOpenApi?.status, "connected");
      assert.equal(jsonOpenApi?.readMeta?.documentVersion, "2026.07");
      assert.equal(jsonOpenApi?.readMeta?.openApi?.operationCount, 3);
      assert.ok(jsonContext.requirement.includes("GET /api/tasks operationId=listTasks"));
      const impact = buildImpactAnalysis(jsonContext);
      assert.ok(impact.affectedApis.some((api) => api.target === "GET /api/tasks" && api.confidence === "high"));
      assert.ok(impact.affectedApis.some((api) => api.target === "POST /api/auth/session"));

      const yamlContext = await readConnectorContext({
        openApiUrl: `${baseUrl}/openapi.yaml`,
        strictInput: true
      });
      const yamlOpenApi = yamlContext.sourceContexts.find((source) => source.kind === "openapi");
      assert.equal(yamlOpenApi?.status, "connected");
      assert.equal(yamlOpenApi?.readMeta?.documentVersion, "2026.08");
      assert.equal(yamlOpenApi?.readMeta?.openApi?.operations.some((operation) => operation.operationId === "updateTaskYaml"), true);
    });
  });
}
