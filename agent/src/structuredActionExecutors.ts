import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  type ActionDsl,
  type EvidenceLocator,
  type ProjectManifest
} from "@ai-test-officer/contracts";
import {
  buildOciInvocation,
  runAllowlistedCommand
} from "@ai-test-officer/execution-worker";
import { redactText } from "./redaction.js";
import { testProjectConnection } from "./projectAdapter.js";
import type { ProjectConfig, TargetAppRuntime } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type StructuredAction = Extract<
  ActionDsl,
  { action: "api-request" | "data-assert" | "wait-job" | "command-check" }
>;

export interface StructuredActionResult {
  passed: boolean;
  summary: string;
  locator: EvidenceLocator;
  payload: Record<string, unknown>;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function resolveProjectRoot(project: ProjectConfig) {
  return path.isAbsolute(project.projectPath)
    ? path.resolve(project.projectPath)
    : path.resolve(rootDir, project.projectPath);
}

async function fixturePayload(
  manifest: ProjectManifest,
  project: ProjectConfig,
  fixtureRef?: string
): Promise<unknown> {
  if (!fixtureRef) return undefined;
  const fixture = manifest.fixtures.find((candidate) => candidate.id === fixtureRef);
  if (!fixture) throw new Error(`structured_action_unknown_fixture:${fixtureRef}`);
  const root = resolveProjectRoot(project);
  const file = path.resolve(root, manifest.workspaceRoot, fixture.path);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    throw new Error("structured_action_fixture_path_escape");
  }
  const bytes = await readFile(file);
  if (sha256(bytes) !== fixture.sha256) throw new Error(`structured_action_fixture_digest_mismatch:${fixtureRef}`);
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(`structured_action_fixture_too_large:${fixtureRef}`);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function boundedResponse(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("api_response_too_large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("api_response_too_large");
  const text = bytes.toString("utf8");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { bytes, text, json };
}

function allowedOperation(manifest: ProjectManifest, operationId: string) {
  const operation = manifest.apiOperations.find((candidate) => candidate.operationId === operationId);
  if (!operation) throw new Error(`api_operation_not_allowed:${operationId}`);
  return operation;
}

async function requestOperation(input: {
  manifest: ProjectManifest;
  project: ProjectConfig;
  target: TargetAppRuntime;
  operationId: string;
  fixtureRef?: string;
  signal?: AbortSignal;
}) {
  const operation = allowedOperation(input.manifest, input.operationId);
  const baseValue = operation.baseUrlRef === "backend"
    ? input.target.backendUrl
    : input.target.frontendUrl;
  if (!baseValue) throw new Error(`api_operation_base_unavailable:${operation.operationId}`);
  const base = new URL(baseValue);
  const fixture = await fixturePayload(input.manifest, input.project, input.fixtureRef ?? operation.fixtureRef);
  const fixtureRecord = fixture && typeof fixture === "object" && !Array.isArray(fixture)
    ? fixture as Record<string, unknown>
    : {};
  const boundPath = operation.pathTemplate.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = fixtureRecord[name];
    if (!["string", "number"].includes(typeof value)) {
      throw new Error(`api_path_parameter_missing:${operation.operationId}:${name}`);
    }
    return encodeURIComponent(String(value));
  });
  if (/\{[^}]+\}/.test(boundPath)) throw new Error(`api_path_parameter_unresolved:${operation.operationId}`);
  const destination = new URL(boundPath, base);
  if (destination.origin !== base.origin) throw new Error(`api_operation_cross_origin:${operation.operationId}`);
  const body = fixture === undefined || ["GET", "HEAD"].includes(operation.method)
    ? undefined
    : JSON.stringify(fixture);
  const response = await fetch(destination, {
    method: operation.method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
    signal: input.signal
  });
  const content = await boundedResponse(response);
  return {
    operation,
    destination,
    response,
    content,
    passed: operation.allowedStatusCodes.includes(response.status)
  };
}

function valueAtPath(value: unknown, pathExpression: string): unknown {
  return pathExpression.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function readConnection(project: ProjectConfig, envName?: string) {
  if (!envName) throw new Error("data_source_connection_env_missing");
  const configured = project.env?.[envName];
  const value = configured && configured !== "[REDACTED]" ? configured : process.env[envName];
  if (!value) throw new Error(`data_source_credential_missing:${envName}`);
  return value;
}

function queryExpectation(
  rows: Array<Record<string, unknown>>,
  expectation: ProjectManifest["dataSources"][number]["queryTemplates"][number]["expectation"]
) {
  if (expectation.kind === "non-empty") return rows.length > 0;
  if (expectation.kind === "empty") return rows.length === 0;
  if (expectation.kind === "row-count") return rows.length === expectation.value;
  const first = rows[0] ? Object.values(rows[0])[0] : undefined;
  return first === expectation.value;
}

function sqliteValue(value: unknown): null | string | number | bigint | Uint8Array {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

async function executeDataAssert(input: {
  manifest: ProjectManifest;
  project: ProjectConfig;
  action: Extract<StructuredAction, { action: "data-assert" }>;
}) {
  const source = input.manifest.dataSources.find((candidate) => candidate.id === input.action.dataSourceId);
  if (!source) throw new Error(`data_source_not_allowed:${input.action.dataSourceId}`);
  if (!source.readOnly) throw new Error(`data_source_not_read_only:${source.id}`);
  const template = source.queryTemplates.find((candidate) => candidate.id === input.action.queryTemplateId);
  if (!template) throw new Error(`data_query_template_not_allowed:${input.action.queryTemplateId}`);
  if (!/^\s*(select|with)\b/i.test(template.statement) || /;\s*\S/.test(template.statement)) {
    throw new Error(`data_query_template_not_read_only:${template.id}`);
  }
  const fixture = await fixturePayload(input.manifest, input.project, input.action.parameterFixtureRef);
  const parameters = fixture && typeof fixture === "object"
    ? fixture as Record<string, unknown>
    : {};
  const values = template.parameterNames.map((name) => {
    if (!(name in parameters)) throw new Error(`data_query_parameter_missing:${name}`);
    return parameters[name];
  });
  let rows: Array<Record<string, unknown>>;
  let rollbackVerified = false;
  const connection = readConnection(input.project, source.connectionEnv);
  if (source.kind === "postgres") {
    const pool = new Pool({ connectionString: connection, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      rows = (await client.query(template.statement, values)).rows as Array<Record<string, unknown>>;
      await client.query("ROLLBACK");
      rollbackVerified = true;
    } finally {
      client.release();
      await pool.end();
    }
  } else if (source.kind === "sqlite") {
    const database = new DatabaseSync(connection, { readOnly: true });
    try {
      rows = database.prepare(template.statement).all(...values.map(sqliteValue)) as Array<Record<string, unknown>>;
      rollbackVerified = true;
    } finally {
      database.close();
    }
  } else {
    const response = await fetch(connection);
    const content = await boundedResponse(response);
    const candidate = Array.isArray(content.json) ? content.json : [content.json];
    rows = candidate.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
    rollbackVerified = true;
  }
  const passed = queryExpectation(rows, template.expectation);
  const assertionHash = sha256(JSON.stringify({
    dataSourceId: source.id,
    queryTemplateId: template.id,
    expectation: template.expectation,
    passed
  }));
  return {
    passed,
    summary: passed
      ? `Data assertion ${template.id} satisfied its declared expectation.`
      : `Data assertion ${template.id} did not satisfy its declared expectation.`,
    locator: {
      dataSnapshotId: `snapshot_${sha256(JSON.stringify(rows)).slice(0, 20)}`,
      assertionSha256: assertionHash
    },
    payload: {
      dataSourceId: source.id,
      queryTemplateId: template.id,
      rowCount: rows.length,
      resultSha256: sha256(JSON.stringify(rows)),
      expectation: template.expectation,
      rollbackVerified
    }
  } satisfies StructuredActionResult;
}

async function executeCommandCheck(input: {
  manifest: ProjectManifest;
  project: ProjectConfig;
  action: Extract<StructuredAction, { action: "command-check" }>;
  signal?: AbortSignal;
}) {
  if (input.action.commandId === "health") {
    const result = await testProjectConnection(input.project);
    return {
      passed: result.ok,
      summary: result.message,
      locator: {
        executable: "health-check",
        commandConfigSha256: sha256(JSON.stringify(input.project.healthCheckUrl ?? input.manifest.healthCheck ?? null)),
        exitCode: result.ok ? 0 : 1
      },
      payload: {
        commandId: "health",
        durationMs: result.durationMs,
        checkedAt: result.checkedAt,
        ok: result.ok
      }
    } satisfies StructuredActionResult;
  }
  const command = input.manifest.commands.test;
  if (!command) throw new Error("command_check_not_declared:test");
  if (input.manifest.execution.mode !== "oci") throw new Error("command_check_requires_oci");
  const projectRoot = resolveProjectRoot(input.project);
  const invocation = buildOciInvocation({
    engine: input.manifest.execution.engine,
    image: input.manifest.execution.image!,
    manifest: input.manifest,
    repositoryRoot: projectRoot,
    command,
    prepareCommand: input.manifest.commands.install
  });
  const result = await runAllowlistedCommand({
    command: {
      executable: invocation.executable,
      args: invocation.args,
      timeoutMs: command.timeoutMs ?? input.manifest.budget.stepTimeoutMs
    },
    cwd: projectRoot,
    env: {},
    allowedExecutables: [invocation.executable],
    signal: input.signal,
    maxLogBytes: input.manifest.budget.maxLogBytes
  });
  const safeStdout = redactText(result.stdout);
  const safeStderr = redactText(result.stderr);
  return {
    passed: result.exitCode === 0,
    summary: result.exitCode === 0
      ? "Allowlisted test command completed successfully inside the OCI sandbox."
      : `Allowlisted test command failed: ${result.failureReason ?? "non_zero_exit"}.`,
    locator: {
      executable: command.executable,
      argsSha256: sha256(JSON.stringify(command.args)),
      commandConfigSha256: sha256(JSON.stringify(command)),
      exitCode: result.exitCode ?? -1
    },
    payload: {
      commandId: "test",
      exitCode: result.exitCode,
      failureReason: result.failureReason,
      stdoutSha256: sha256(safeStdout),
      stderrSha256: sha256(safeStderr),
      stdoutExcerpt: safeStdout.slice(-4_000),
      stderrExcerpt: safeStderr.slice(-4_000)
    }
  } satisfies StructuredActionResult;
}

export async function executeStructuredAction(input: {
  action: StructuredAction;
  manifest: ProjectManifest;
  project: ProjectConfig;
  target: TargetAppRuntime;
  signal?: AbortSignal;
}): Promise<StructuredActionResult> {
  const action = input.action;
  if (action.action === "api-request") {
    const result = await requestOperation({
      manifest: input.manifest,
      project: input.project,
      target: input.target,
      operationId: action.operationId,
      fixtureRef: action.fixtureRef,
      signal: input.signal
    });
    return {
      passed: result.passed,
      summary: result.passed
        ? `API operation ${result.operation.operationId} returned ${result.response.status}.`
        : `API operation ${result.operation.operationId} returned disallowed status ${result.response.status}.`,
      locator: {
        requestId: result.response.headers.get("x-request-id") ?? `request_${sha256(`${result.operation.operationId}:${Date.now()}`).slice(0, 20)}`,
        method: result.operation.method,
        statusCode: result.response.status,
        operationId: result.operation.operationId,
        bodySha256: sha256(result.content.bytes)
      },
      payload: {
        operationId: result.operation.operationId,
        method: result.operation.method,
        pathTemplate: result.operation.pathTemplate,
        path: `${result.destination.pathname}${result.destination.search}`,
        status: result.response.status,
        responseBytes: result.content.bytes.byteLength,
        responseSha256: sha256(result.content.bytes),
        responseExcerpt: redactText(result.content.text).slice(0, 4_000)
      }
    };
  }
  if (action.action === "data-assert") {
    return executeDataAssert({ manifest: input.manifest, project: input.project, action });
  }
  if (action.action === "command-check") {
    return executeCommandCheck({
      manifest: input.manifest,
      project: input.project,
      action,
      signal: input.signal
    });
  }
  const task = input.manifest.backgroundTasks.find((candidate) => candidate.id === action.backgroundTaskId);
  if (!task) throw new Error(`background_task_not_allowed:${action.backgroundTaskId}`);
  const deadline = Date.now() + Math.min(action.timeoutMs ?? task.timeoutMs, task.timeoutMs);
  let lastState: unknown;
  let attempts = 0;
  let lastLocator: EvidenceLocator = {};
  do {
    attempts += 1;
    const result = await requestOperation({
      manifest: input.manifest,
      project: input.project,
      target: input.target,
      operationId: task.statusOperationId,
      signal: input.signal
    });
    lastLocator = {
      requestId: result.response.headers.get("x-request-id") ?? `request_${sha256(`${task.id}:${attempts}`).slice(0, 20)}`,
      method: result.operation.method,
      statusCode: result.response.status,
      operationId: result.operation.operationId,
      bodySha256: sha256(result.content.bytes)
    };
    lastState = valueAtPath(result.content.json, task.statusField);
    if (typeof lastState === "string" && task.terminalStates.includes(lastState)) {
      const passed = task.successStates.includes(lastState);
      return {
        passed,
        summary: passed
          ? `Background task ${task.id} reached success state ${lastState}.`
          : `Background task ${task.id} reached terminal failure state ${lastState}.`,
        locator: lastLocator,
        payload: { backgroundTaskId: task.id, state: lastState, pollingAttempts: attempts }
      };
    }
    await new Promise((resolve) => setTimeout(resolve, task.pollIntervalMs));
  } while (Date.now() < deadline && !input.signal?.aborted);
  return {
    passed: false,
    summary: `Background task ${task.id} did not reach a declared terminal state before timeout.`,
    locator: lastLocator,
    payload: { backgroundTaskId: task.id, state: lastState, pollingAttempts: attempts, timedOut: true }
  };
}
