import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  compiledPlanSchema,
  coverageItemSchema,
  type ActionDsl,
  type CoverageItem,
  type ProjectManifest
} from "@ai-test-officer/contracts";
import { getScenario, hasScenario } from "./scenarios.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const localLocks = new Map<string, Promise<void>>();

function coverageFile(runId: string) {
  return path.join(rootDir, "reports", "runs", runId, "coverage.json");
}

function stableId(runId: string, flowId: string) {
  return `coverage_${createHash("sha256").update(`${runId}:${flowId}`).digest("hex").slice(0, 24)}`;
}

async function withLock<T>(runId: string, operation: () => Promise<T>) {
  const previous = localLocks.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  localLocks.set(runId, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localLocks.get(runId) === chained) localLocks.delete(runId);
  }
}

export function createCoverageItems(input: {
  runId: string;
  scenarioIds: string[];
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  return Array.from(new Set(input.scenarioIds)).map((scenarioId) => {
    if (!hasScenario(scenarioId)) {
      return coverageItemSchema.parse({
        schemaVersion: "1.0",
        id: stableId(input.runId, scenarioId),
        runId: input.runId,
        flowId: scenarioId,
        module: scenarioId,
        surface: "page",
        risk: "high",
        disposition: "blocked",
        dispositionReason: "scenario_not_registered",
        scenarioId,
        createdAt: now,
        updatedAt: now
      });
    }
    const scenario = getScenario(scenarioId);
    const actions = scenario.compiledPlanContract?.requiredSteps ?? [];
    const surface = actions.some((step) => step.action.action === "data-assert") ? "data"
      : actions.some((step) => step.action.action === "wait-job") ? "background-task"
        : actions.some((step) => step.action.action === "api-request") ? "api"
          : "page";
    return coverageItemSchema.parse({
      schemaVersion: "1.0",
      id: stableId(input.runId, scenarioId),
      runId: input.runId,
      flowId: scenario.id,
      module: scenario.title,
      surface,
      route: scenario.compiledPlanContract?.routePath,
      risk: scenario.capabilityKind === "approval_flow" || scenario.capabilityKind === "role_permission_matrix" ? "high" : "medium",
      preconditions: [],
      permissions: surface === "page" ? ["browserControl"] : [],
      actionPathIds: Array.from(new Set(actions.map((step) => step.pathId))),
      oracleIds: Array.from(new Set(actions.flatMap((step) => step.action.action === "assert"
        || step.action.action === "api-request"
        || step.action.action === "data-assert"
        || step.action.action === "wait-job"
        || step.action.action === "command-check"
        ? [step.action.oracleId]
        : []))),
      requiredEvidenceKinds: scenario.compiledPlanContract?.requiredEvidenceKinds ?? [],
      disposition: scenario.compiledPlanContract ? "pending" : "blocked",
      dispositionReason: scenario.compiledPlanContract ? undefined : "compiled_plan_contract_missing",
      scenarioId: scenario.id,
      createdAt: now,
      updatedAt: now
    });
  });
}

export function createDynamicBrowserCoverageItems(input: {
  runId: string;
  paths: Array<{
    id: string;
    title: string;
    riskReason?: string;
    surface?: CoverageItem["surface"];
    preconditions?: string[];
    requiredEvidenceKinds?: CoverageItem["requiredEvidenceKinds"];
  }>;
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  return input.paths.map((path) => {
    const surface = path.surface ?? "page";
    const browserPath = surface === "page";
    return coverageItemSchema.parse({
    schemaVersion: "1.0",
    id: stableId(input.runId, path.id),
    runId: input.runId,
    flowId: path.id,
    module: path.title,
    surface,
    risk: "high",
    preconditions: path.preconditions ?? [],
    permissions: browserPath ? ["browserControl"] : [],
    actionPathIds: [path.id],
    oracleIds: [],
    requiredEvidenceKinds: path.requiredEvidenceKinds?.length
      ? path.requiredEvidenceKinds
      : browserPath ? ["screenshot", "dom", "trace", "operation-log"] : ["operation-log"],
    // Dynamic controls are presently a browser executor contract. API/data/
    // job entries must be rebound to their allow-listed manifest executor;
    // retaining them as blocked is safer than silently passing or pretending
    // a browser click exercised a backend-only path.
    disposition: browserPath ? "pending" : "blocked",
    dispositionReason: browserPath ? path.riskReason : "static_business_path_requires_manifest_executor_binding",
    scenarioId: `dynamic_${path.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}`,
    createdAt: now,
    updatedAt: now
    });
  });
}

function structuredCoverageItem(input: {
  runId: string;
  flowId: string;
  module: string;
  surface: CoverageItem["surface"];
  action: ActionDsl;
  risk?: CoverageItem["risk"];
  route?: string;
  operationId?: string;
  dataEntity?: string;
  blockedReason?: string;
  now: string;
}) {
  const scenarioId = `manifest_${input.flowId.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
  const oracleId = "oracleId" in input.action ? input.action.oracleId : `${input.flowId}_oracle`;
  const structuredPlan = compiledPlanSchema.parse({
    scenarioId,
    steps: [{
      id: `${scenarioId}_step_1`,
      pathId: input.flowId,
      action: input.action
    }],
    requiredOracleIds: [oracleId],
    requiredEvidenceKinds: ["operation-log"]
  });
  return coverageItemSchema.parse({
    schemaVersion: "1.0",
    id: stableId(input.runId, input.flowId),
    runId: input.runId,
    flowId: input.flowId,
    module: input.module,
    surface: input.surface,
    route: input.route,
    operationId: input.operationId,
    dataEntity: input.dataEntity,
    risk: input.risk ?? "medium",
    preconditions: [],
    permissions: input.surface === "data" ? ["dataRead"] : input.surface === "api" || input.surface === "background-task" ? ["targetNetwork"] : ["sandboxCommand"],
    actionPathIds: [input.flowId],
    oracleIds: [oracleId],
    requiredEvidenceKinds: ["operation-log"],
    structuredPlan,
    disposition: input.blockedReason ? "blocked" : "pending",
    dispositionReason: input.blockedReason,
    scenarioId,
    createdAt: input.now,
    updatedAt: input.now
  });
}

/**
 * Turn every allow-listed manifest capability into an explicit coverage
 * disposition. Unsafe or incomplete entries remain visible as blocked rather
 * than disappearing from a "full scan".
 */
export function createManifestCoverageItems(input: {
  runId: string;
  manifest: ProjectManifest;
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  const items: CoverageItem[] = [];
  for (const operation of input.manifest.apiOperations) {
    const flowId = `api:${operation.operationId}`;
    items.push(structuredCoverageItem({
      runId: input.runId,
      flowId,
      module: `API ${operation.operationId}`,
      surface: "api",
      route: operation.pathTemplate,
      operationId: operation.operationId,
      risk: operation.destructive ? "high" : "medium",
      action: {
        action: "api-request",
        operationId: operation.operationId,
        oracleId: `${flowId}:status`,
        fixtureRef: operation.fixtureRef
      },
      blockedReason: operation.destructive
        ? "destructive_operation_requires_explicit_fixture_and_approval"
        : (/\{[^}]+\}/.test(operation.pathTemplate) || !["GET", "HEAD", "OPTIONS"].includes(operation.method)) && !operation.fixtureRef
          ? "api_operation_requires_declared_fixture"
          : undefined,
      now
    }));
  }
  for (const source of input.manifest.dataSources) {
    for (const query of source.queryTemplates) {
      const flowId = `data:${source.id}:${query.id}`;
      items.push(structuredCoverageItem({
        runId: input.runId,
        flowId,
        module: `Data ${source.id} / ${query.id}`,
        surface: "data",
        dataEntity: source.id,
        risk: "high",
        action: {
          action: "data-assert",
          dataSourceId: source.id,
          queryTemplateId: query.id,
          oracleId: `${flowId}:expectation`
        },
        blockedReason: !source.readOnly
          ? "data_source_not_read_only"
          : query.parameterNames.length
            ? "data_query_parameters_require_declared_fixture"
            : undefined,
        now
      }));
    }
  }
  for (const task of input.manifest.backgroundTasks) {
    const flowId = `job:${task.id}`;
    const statusOperation = input.manifest.apiOperations.find((operation) => operation.operationId === task.statusOperationId);
    items.push(structuredCoverageItem({
      runId: input.runId,
      flowId,
      module: `Background task ${task.id}`,
      surface: "background-task",
      operationId: task.statusOperationId,
      risk: "high",
      action: {
        action: "wait-job",
        backgroundTaskId: task.id,
        oracleId: `${flowId}:terminal-state`,
        timeoutMs: task.timeoutMs
      },
      blockedReason: !statusOperation
        ? "background_status_operation_missing"
        : statusOperation.destructive
          ? "background_status_operation_must_be_read_only"
          : undefined,
      now
    }));
  }
  if (input.manifest.commands.test) {
    items.push(structuredCoverageItem({
      runId: input.runId,
      flowId: "command:test",
      module: "Declared test command",
      surface: "api",
      risk: "medium",
      action: {
        action: "command-check",
        commandId: "test",
        oracleId: "command:test:exit-code"
      },
      blockedReason: input.manifest.execution.mode !== "oci"
        ? "test_command_requires_oci_sandbox"
        : undefined,
      now
    }));
  }
  return items;
}

export async function readCoverageItems(runId: string): Promise<CoverageItem[]> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const result = await pool.query<{ payload: unknown }>(
        "SELECT payload FROM coverage_items_v1 WHERE run_id=$1 ORDER BY created_at,id",
        [runId]
      );
      return result.rows.map((row) => coverageItemSchema.parse(row.payload));
    } finally {
      await pool.end();
    }
  }
  try {
    return coverageItemSchema.array().parse(JSON.parse(await readFile(coverageFile(runId), "utf8")));
  } catch {
    return [];
  }
}

export async function saveCoverageItems(runId: string, items: CoverageItem[]) {
  const parsed = coverageItemSchema.array().parse(items);
  if (parsed.some((item) => item.runId !== runId)) throw new Error("coverage_run_mismatch");
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of parsed) {
        await client.query(
          `INSERT INTO coverage_items_v1 (id,run_id,flow_id,disposition,payload)
           VALUES ($1,$2,$3,$4,$5::jsonb)
           ON CONFLICT (id) DO UPDATE SET disposition=EXCLUDED.disposition,payload=EXCLUDED.payload`,
          [item.id, runId, item.flowId, item.disposition, JSON.stringify(item)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
  await withLock(runId, async () => {
    await mkdir(path.dirname(coverageFile(runId)), { recursive: true });
    await writeFile(coverageFile(runId), JSON.stringify(parsed, null, 2));
  });
  return parsed;
}

export async function updateCoverageDisposition(input: {
  runId: string;
  coverageItemId: string;
  disposition: CoverageItem["disposition"];
  reason?: string;
  attemptId?: string;
  childRunId?: string;
}) {
  const items = await readCoverageItems(input.runId);
  const now = new Date().toISOString();
  const next = items.map((item) => item.id === input.coverageItemId ? coverageItemSchema.parse({
    ...item,
    disposition: input.disposition,
    dispositionReason: input.reason,
    attemptId: input.attemptId,
    childRunId: input.childRunId ?? item.childRunId,
    updatedAt: now
  }) : item);
  if (!next.some((item) => item.id === input.coverageItemId)) throw new Error("coverage_item_not_found");
  await saveCoverageItems(input.runId, next);
  return next;
}
