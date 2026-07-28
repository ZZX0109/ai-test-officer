import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectManifestSchema } from "@ai-test-officer/contracts";
import { executeStructuredAction } from "../src/structuredActionExecutors.js";
import { createManifestCoverageItems } from "../src/coverageStore.js";
import type { ProjectConfig } from "../src/types.js";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function testStructuredActionExecutors() {
  const directory = await mkdtemp(path.join(tmpdir(), "ato-structured-"));
  const databasePath = path.join(directory, "fixture.sqlite");
  const fixtureText = JSON.stringify({ query: "active" });
  const apiFixtureText = JSON.stringify({ id: 1 });
  await writeFile(path.join(directory, "params.json"), fixtureText);
  await writeFile(path.join(directory, "api-params.json"), apiFixtureText);
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO tasks(status) VALUES ('active');");
  database.close();
  let jobPolls = 0;
  const server = createServer((request, response) => {
    if (request.url === "/api/tasks" || request.url === "/api/tasks/1") {
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "request_tasks" });
      response.end(JSON.stringify([{ id: 1, status: "active" }]));
      return;
    }
    if (request.url === "/api/job") {
      jobPolls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: jobPolls >= 2 ? "completed" : "running" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const manifest = projectManifestSchema.parse({
    schemaVersion: "1.0",
    projectId: "structured-fixture",
    workspaceRoot: ".",
    commands: {},
    commandAllowlist: ["node"],
    network: { mode: "allow-target", allowedHosts: ["127.0.0.1"] },
    fixtures: [
      { id: "query-params", path: "params.json", sha256: sha256(fixtureText) },
      { id: "api-params", path: "api-params.json", sha256: sha256(apiFixtureText) }
    ],
    apiOperations: [
      { operationId: "listTasks", method: "GET", pathTemplate: "/api/tasks", baseUrlRef: "backend", allowedStatusCodes: [200] },
      { operationId: "getTask", method: "GET", pathTemplate: "/api/tasks/{id}", baseUrlRef: "backend", allowedStatusCodes: [200], fixtureRef: "api-params" },
      { operationId: "jobStatus", method: "GET", pathTemplate: "/api/job", baseUrlRef: "backend", allowedStatusCodes: [200] }
    ],
    dataSources: [{
      id: "fixture-db",
      kind: "sqlite",
      connectionEnv: "FIXTURE_DB",
      readOnly: true,
      queryTemplates: [{
        id: "active-tasks",
        statement: "SELECT id, status FROM tasks WHERE status = ?",
        parameterNames: ["query"],
        expectation: { kind: "row-count", value: 1 }
      }]
    }],
    backgroundTasks: [{
      id: "analysis-job",
      statusOperationId: "jobStatus",
      statusField: "state",
      terminalStates: ["completed", "failed"],
      successStates: ["completed"],
      pollIntervalMs: 100,
      timeoutMs: 2_000
    }],
    execution: { mode: "oci", image: "node:22-bookworm-slim", engine: "docker" }
  });
  const project: ProjectConfig = {
    id: "structured-fixture",
    name: "Structured fixture",
    projectPath: directory,
    allowExternalProjectPath: true,
    frontendUrl: baseUrl,
    backendUrl: baseUrl,
    login: { method: "none" },
    env: { FIXTURE_DB: databasePath },
    manifest,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  try {
    const coverage = createManifestCoverageItems({
      runId: "run-structured-coverage",
      manifest: projectManifestSchema.parse({
        ...manifest,
        apiOperations: [
          ...manifest.apiOperations,
          { operationId: "deleteTask", method: "DELETE", pathTemplate: "/api/tasks/1", allowedStatusCodes: [204], destructive: true }
        ]
      })
    });
    assert.equal(coverage.some((item) => item.flowId === "api:listTasks" && item.disposition === "pending" && item.structuredPlan), true);
    assert.equal(coverage.some((item) => item.flowId === "api:getTask" && item.disposition === "pending"), true);
    assert.equal(coverage.some((item) => item.flowId === "api:deleteTask" && item.disposition === "blocked"), true);
    assert.equal(coverage.some((item) => item.flowId === "data:fixture-db:active-tasks" && item.disposition === "blocked"), true);
    assert.equal(coverage.some((item) => item.flowId === "job:analysis-job" && item.disposition === "pending"), true);
    assert.equal(coverage.every((item) => item.requiredEvidenceKinds.includes("operation-log")), true);

    const api = await executeStructuredAction({
      action: { action: "api-request", operationId: "listTasks", oracleId: "api-ok" },
      manifest,
      project,
      target: { frontendUrl: baseUrl, backendUrl: baseUrl }
    });
    assert.equal(api.passed, true);
    assert.equal(api.locator.operationId, "listTasks");
    const parameterizedApi = await executeStructuredAction({
      action: { action: "api-request", operationId: "getTask", oracleId: "api-parameter-ok" },
      manifest,
      project,
      target: { frontendUrl: baseUrl, backendUrl: baseUrl }
    });
    assert.equal(parameterizedApi.passed, true);
    assert.equal(parameterizedApi.payload.path, "/api/tasks/1");
    await assert.rejects(
      executeStructuredAction({
        action: { action: "api-request", operationId: "arbitraryUrl", oracleId: "forbidden" },
        manifest,
        project,
        target: { frontendUrl: baseUrl, backendUrl: baseUrl }
      }),
      /api_operation_not_allowed/
    );
    const data = await executeStructuredAction({
      action: {
        action: "data-assert",
        dataSourceId: "fixture-db",
        queryTemplateId: "active-tasks",
        parameterFixtureRef: "query-params",
        oracleId: "one-active-task"
      },
      manifest,
      project,
      target: { frontendUrl: baseUrl, backendUrl: baseUrl }
    });
    assert.equal(data.passed, true);
    assert.equal(data.payload.rollbackVerified, true);
    const job = await executeStructuredAction({
      action: { action: "wait-job", backgroundTaskId: "analysis-job", oracleId: "job-completes" },
      manifest,
      project,
      target: { frontendUrl: baseUrl, backendUrl: baseUrl }
    });
    assert.equal(job.passed, true);
    assert.equal(job.payload.state, "completed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
