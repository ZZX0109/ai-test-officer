import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { EvidenceItem, JudgeFinding, JudgeResult, RunBundle, RunStepEvidence, VisualRunResult } from "./types.js";

type StatementSync = {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Array<Record<string, unknown>>;
};

type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
};

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSync };
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const auditDir = path.join(rootDir, "reports", "audit");
const auditDbFile = path.join(auditDir, "audit.sqlite");
const schemaVersion = 5;
const migrations = [
  {
    version: 1,
    description: "Initial SQLite run store with run bundle, source context, plan, impact, and attribution indexes."
  },
  {
    version: 2,
    description: "Add scenario fingerprint to SQLite run history and keep run store schema versioned."
  },
  {
    version: 3,
    description: "Make source context audit records unique per run instead of globally replacing stable source IDs."
  },
  {
    version: 4,
    description: "Expose audit store user_version, migration records, and integrity check in health status."
  },
  {
    version: 5,
    description: "Persist immutable scenario, attempt, sequence, and artifact links for every evidence record."
  }
];

export interface AuditRunHistoryRow {
  runId: string;
  timestamp: string;
  verdict: VisualRunResult["verdict"];
  failedAssertionCount: number;
  appUrl: string;
  projectId?: string;
  scenarioId?: string;
  scenarioFingerprint?: string;
}

let db: DatabaseSync | undefined;

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function hash(value: unknown) {
  return createHash("sha256").update(json(value)).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function openDb() {
  if (db) return db;
  mkdirSync(auditDir, { recursive: true });
  db = new DatabaseSync(auditDbFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'local',
      app_url TEXT,
      scenario_id TEXT,
      scenario_fingerprint TEXT,
      trigger TEXT,
      verdict TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      bundle_uri TEXT,
      report_uri TEXT,
      schema_version INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      description TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      run_id TEXT,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      frontend_url TEXT NOT NULL,
      backend_url TEXT,
      health_check_url TEXT,
      runtime_status TEXT,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      action TEXT NOT NULL,
      artifact_uri TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      scenario_id TEXT,
      attempt_id TEXT,
      attempt INTEGER,
      sequence INTEGER,
      artifact_ids_json TEXT,
      path_id TEXT,
      step_id TEXT,
      created_at TEXT NOT NULL,
      artifact_uri TEXT,
      url TEXT,
      producer TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      evidence_id TEXT,
      kind TEXT NOT NULL,
      uri TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      uri TEXT,
      status TEXT NOT NULL,
      permission_state TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      is_simulated INTEGER NOT NULL,
      failure_reason TEXT,
      content_hash TEXT,
      read_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      UNIQUE(run_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS plans (
      plan_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_steps (
      plan_step_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      title TEXT NOT NULL,
      step_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS impact_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      analysis_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_kind TEXT NOT NULL,
      target TEXT NOT NULL,
      confidence TEXT,
      item_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS failure_attributions (
      attribution_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      failure_class TEXT NOT NULL,
      title TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      source_context_ids_json TEXT NOT NULL,
      attribution_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS judge_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL,
      execution_mode TEXT,
      llm_status TEXT,
      llm_error TEXT,
      policy_version TEXT,
      layer TEXT NOT NULL,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      judge_layer TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      evidence_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_bundles (
      run_id TEXT PRIMARY KEY,
      bundle_uri TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_evidence_run_id ON evidence(run_id);
    CREATE INDEX IF NOT EXISTS idx_source_contexts_run_id ON source_contexts(run_id);
    CREATE INDEX IF NOT EXISTS idx_plan_steps_run_id ON plan_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_impact_items_run_id ON impact_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_failure_attributions_run_id ON failure_attributions(run_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_findings_run_id ON findings(run_id);
  `);
  ensureJudgeResultColumns(db);
  ensureEvidenceColumns(db);
  ensureRunColumns(db);
  ensureSourceContextTable(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_source_contexts_run_id_v3 ON source_contexts(run_id);");
  const recordMigration = db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)");
  for (const migration of migrations) {
    recordMigration.run(migration.version, now(), migration.description);
  }
  db.exec(`PRAGMA user_version = ${schemaVersion};`);
  return db;
}

function createSourceContextTable(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      uri TEXT,
      status TEXT NOT NULL,
      permission_state TEXT NOT NULL,
      trust_level TEXT NOT NULL,
      is_simulated INTEGER NOT NULL,
      failure_reason TEXT,
      content_hash TEXT,
      read_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_json TEXT NOT NULL,
      hash TEXT NOT NULL,
      UNIQUE(run_id, source_id)
    );
  `);
}

function ensureSourceContextTable(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(source_contexts)").all();
  const sourceId = rows.find((row) => String(row.name) === "source_id");
  const isLegacyGlobalSourcePrimaryKey = Number(sourceId?.pk ?? 0) > 0;
  if (!isLegacyGlobalSourcePrimaryKey) return;
  database.exec("ALTER TABLE source_contexts RENAME TO source_contexts_legacy_global_source_id;");
  createSourceContextTable(database);
  database.exec(`
    INSERT OR IGNORE INTO source_contexts
      (source_id, run_id, kind, title, uri, status, permission_state, trust_level, is_simulated, failure_reason, content_hash, read_at, summary, source_json, hash)
    SELECT source_id, run_id, kind, title, uri, status, permission_state, trust_level, is_simulated, failure_reason, content_hash, read_at, summary, source_json, hash
    FROM source_contexts_legacy_global_source_id;
  `);
}

function ensureRunColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(runs)").all();
  const columns = new Set(rows.map((row) => String(row.name)));
  if (!columns.has("project_id")) {
    database.exec("ALTER TABLE runs ADD COLUMN project_id TEXT NOT NULL DEFAULT 'local';");
  }
  if (!columns.has("scenario_fingerprint")) {
    database.exec("ALTER TABLE runs ADD COLUMN scenario_fingerprint TEXT;");
  }
}

function ensureJudgeResultColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(judge_results)").all();
  const columns = new Set(rows.map((row) => String(row.name)));
  const additions = [
    ["execution_mode", "TEXT"],
    ["llm_status", "TEXT"],
    ["llm_error", "TEXT"],
    ["policy_version", "TEXT"]
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE judge_results ADD COLUMN ${name} ${type};`);
    }
  }
}

function ensureEvidenceColumns(database: DatabaseSync) {
  const rows = database.prepare("PRAGMA table_info(evidence)").all();
  const columns = new Set(rows.map((row) => String(row.name)));
  const additions = [
    ["title", "TEXT"],
    ["scenario_id", "TEXT"],
    ["attempt_id", "TEXT"],
    ["attempt", "INTEGER"],
    ["sequence", "INTEGER"],
    ["artifact_ids_json", "TEXT"]
  ];
  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE evidence ADD COLUMN ${name} ${type};`);
    }
  }
}

function appendAuditEvent(input: { runId?: string; eventType: string; payload: unknown }) {
  const database = openDb();
  const createdAt = now();
  const payloadJson = json(input.payload);
  database.prepare(`
    INSERT INTO audit_events (run_id, event_type, created_at, payload_json, hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.runId ?? null, input.eventType, createdAt, payloadJson, hash(input));
}

export function appendEvidenceToAuditStore(item: EvidenceItem) {
  const database = openDb();
  const payloadJson = json(item.payload);
  const evidenceHash = hash({
    id: item.id,
    runId: item.runId,
    type: item.type,
    timestamp: item.timestamp,
    scenarioId: item.scenarioId,
    attemptId: item.attemptId,
    attempt: item.attempt,
    sequence: item.sequence,
    artifactIds: item.artifactIds,
    pathId: item.pathId,
    stepId: item.stepId,
    url: item.url,
    file: item.file,
    payload: item.payload
  });
  database.prepare(`
    INSERT OR IGNORE INTO evidence
      (evidence_id, run_id, type, title, scenario_id, attempt_id, attempt, sequence, artifact_ids_json, path_id, step_id, created_at, artifact_uri, url, producer, schema_version, payload_json, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    item.runId,
    item.type,
    item.title,
    item.scenarioId ?? null,
    item.attemptId ?? null,
    item.attempt ?? null,
    item.sequence ?? null,
    json(item.artifactIds ?? []),
    item.pathId ?? null,
    item.stepId ?? null,
    item.timestamp,
    item.file ?? null,
    item.url ?? null,
    "agent",
    schemaVersion,
    payloadJson,
    evidenceHash
  );
  if (item.file) {
    database.prepare(`
      INSERT INTO artifacts (run_id, evidence_id, kind, uri, hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(item.runId, item.id, item.type, item.file, evidenceHash, item.timestamp);
  }
  appendAuditEvent({ runId: item.runId, eventType: `evidence.${item.type}`, payload: item });
}

function insertStep(runId: string, step: RunStepEvidence, createdAt: string) {
  const database = openDb();
  const stepHash = hash({ runId, step, createdAt, schemaVersion });
  database.prepare(`
    INSERT INTO run_steps
      (run_id, step_id, title, status, action, artifact_uri, details, created_at, schema_version, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    step.stepId,
    step.title,
    step.status,
    step.action,
    step.screenshot ?? null,
    step.details,
    createdAt,
    schemaVersion,
    stepHash
  );
}

function insertJudge(
  runId: string,
  source: string,
  meta: { executionMode: string; llmStatus: string; llmError?: string; policyVersion: string },
  judge: JudgeResult,
  findingCreatedAt: string
) {
  const database = openDb();
  const judgeHash = hash({ runId, source, judge, schemaVersion });
  database.prepare(`
    INSERT INTO judge_results
      (run_id, source, execution_mode, llm_status, llm_error, policy_version, layer, verdict, summary, created_at, schema_version, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    source,
    meta.executionMode,
    meta.llmStatus,
    meta.llmError ?? null,
    meta.policyVersion,
    judge.layer,
    judge.verdict,
    judge.summary,
    findingCreatedAt,
    schemaVersion,
    judgeHash
  );

  const insertFinding = database.prepare(`
    INSERT INTO findings
      (run_id, judge_layer, finding_id, severity, title, reasoning, evidence_refs_json, created_at, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const finding of judge.findings as JudgeFinding[]) {
    insertFinding.run(
      runId,
      judge.layer,
      finding.id,
      finding.severity,
      finding.title,
      finding.reasoning,
      json(finding.evidenceRefs),
      findingCreatedAt,
      hash({ runId, layer: judge.layer, finding })
    );
  }
}

export function recordRunBundleInAuditStore(bundle: RunBundle, bundleUri: string) {
  const database = openDb();
  const createdAt = now();
  const appUrl =
    bundle.input.target?.frontendUrl ??
    bundle.input.appUrl ??
    bundle.project?.frontendUrl ??
    bundle.runtimeStatus?.frontendUrl ??
    bundle.result.runtimeStatus?.frontendUrl ??
    "unknown";
  const projectId = bundle.input.projectId ?? bundle.project?.id ?? bundle.input.target?.projectId ?? "local";
  const scenarioFingerprint = bundle.result.scenarioFingerprint ?? null;
  const runHash = hash({
    runId: bundle.runId,
    startedAt: bundle.startedAt,
    finishedAt: bundle.finishedAt,
    input: bundle.input,
    result: bundle.result,
    schemaVersion
  });
  database.prepare(`
    INSERT OR REPLACE INTO runs
      (run_id, project_id, app_url, scenario_id, scenario_fingerprint, trigger, verdict, started_at, finished_at, created_at, bundle_uri, report_uri, schema_version, input_json, result_json, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bundle.runId,
    projectId,
    appUrl,
    bundle.input.scenarioId ?? null,
    scenarioFingerprint,
    bundle.input.trigger ?? null,
    bundle.result.verdict,
    bundle.startedAt,
    bundle.finishedAt,
    createdAt,
    bundleUri,
    bundle.result.reportFile,
    schemaVersion,
    json(bundle.input),
    json(bundle.result),
    runHash
  );
  for (const step of bundle.result.steps) {
    insertStep(bundle.runId, step, createdAt);
  }
  if (bundle.project) {
    database.prepare(`
      INSERT OR REPLACE INTO projects
        (project_id, run_id, name, project_path, frontend_url, backend_url, health_check_url, runtime_status, config_json, created_at, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bundle.project.id,
      bundle.runId,
      bundle.project.name,
      bundle.project.projectPath,
      bundle.project.frontendUrl,
      bundle.project.backendUrl ?? null,
      bundle.project.healthCheckUrl ?? null,
      bundle.runtimeStatus?.status ?? null,
      json(bundle.project),
      createdAt,
      hash({ project: bundle.project, runId: bundle.runId })
    );
  }
  const insertSourceContext = database.prepare(`
    INSERT OR REPLACE INTO source_contexts
      (source_id, run_id, kind, title, uri, status, permission_state, trust_level, is_simulated, failure_reason, content_hash, read_at, summary, source_json, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const source of bundle.sourceContexts ?? []) {
    insertSourceContext.run(
      source.id,
      bundle.runId,
      source.kind,
      source.title,
      source.uri ?? null,
      source.status,
      source.permissionState,
      source.trustLevel,
      source.isSimulated ? 1 : 0,
      source.failureReason ?? null,
      source.contentHash ?? null,
      source.readAt,
      source.summary,
      json(source),
      hash({ runId: bundle.runId, source })
    );
  }
  if (bundle.executablePlan) {
    database.prepare(`
      INSERT OR REPLACE INTO plans
        (plan_id, run_id, source, status, created_at, plan_json, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      bundle.executablePlan.id,
      bundle.runId,
      bundle.executablePlan.source,
      bundle.executablePlan.status,
      bundle.executablePlan.createdAt,
      json(bundle.executablePlan),
      hash({ runId: bundle.runId, executablePlan: bundle.executablePlan })
    );
    const insertPlanStep = database.prepare(`
      INSERT OR REPLACE INTO plan_steps
        (plan_step_id, run_id, plan_id, scenario_id, title, step_json, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const step of bundle.executablePlan.steps) {
      insertPlanStep.run(
        step.id,
        bundle.runId,
        bundle.executablePlan.id,
        step.scenarioId,
        step.title,
        json(step),
        hash({ runId: bundle.runId, planId: bundle.executablePlan.id, step })
      );
    }
  }
  if (bundle.impactAnalysis) {
    const insertImpact = database.prepare(`
      INSERT INTO impact_items
        (run_id, analysis_id, item_id, item_kind, target, confidence, item_json, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const impactItems = [
      ...bundle.impactAnalysis.affectedPages,
      ...bundle.impactAnalysis.affectedApis,
      ...bundle.impactAnalysis.affectedComponents,
      ...bundle.impactAnalysis.recommendedScenarios.map((item) => ({
        ...item,
        id: `recommended_${item.scenarioId}`,
        kind: "scenario" as const,
        target: item.scenarioId
      })),
      ...bundle.impactAnalysis.uncoveredRisks.map((item) => ({
        ...item,
        kind: "unknown" as const,
        target: item.title,
        confidence: "medium" as const
      }))
    ];
    for (const item of impactItems) {
      insertImpact.run(
        bundle.runId,
        bundle.impactAnalysis.id,
        item.id,
        item.kind,
        item.target,
        "confidence" in item ? item.confidence : null,
        json(item),
        hash({ runId: bundle.runId, analysisId: bundle.impactAnalysis.id, item })
      );
    }
  }
  const insertAttribution = database.prepare(`
    INSERT OR REPLACE INTO failure_attributions
      (attribution_id, run_id, rank, failure_class, title, confidence, evidence_refs_json, source_context_ids_json, attribution_json, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const attribution of bundle.failureAttributions ?? bundle.result.failureAttributions ?? []) {
    insertAttribution.run(
      attribution.id,
      bundle.runId,
      attribution.rank,
      attribution.failureClass,
      attribution.title,
      attribution.confidence,
      json(attribution.evidenceRefs),
      json(attribution.sourceContextIds),
      json(attribution),
      hash({ runId: bundle.runId, attribution })
    );
  }
  const judgeMeta = {
    executionMode: bundle.judgeReport.executionMode,
    llmStatus: bundle.judgeReport.llmStatus,
    llmError: bundle.judgeReport.llmError,
    policyVersion: bundle.judgeReport.policyVersion
  };
  insertJudge(bundle.runId, bundle.judgeReport.source, judgeMeta, bundle.judgeReport.planJudge, createdAt);
  insertJudge(bundle.runId, bundle.judgeReport.source, judgeMeta, bundle.judgeReport.evidenceJudge, createdAt);
  insertJudge(bundle.runId, bundle.judgeReport.source, judgeMeta, bundle.judgeReport.releaseJudge, createdAt);
  appendAuditEvent({ runId: bundle.runId, eventType: "run.completed", payload: { bundleUri, runHash } });
  database.prepare(`
    INSERT OR REPLACE INTO run_bundles
      (run_id, bundle_uri, bundle_json, created_at, schema_version, hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    bundle.runId,
    bundleUri,
    json(bundle),
    createdAt,
    schemaVersion,
    hash({ runId: bundle.runId, bundleUri, bundle })
  );
}

export function readLatestRunIdFromAuditStore() {
  const row = openDb().prepare("SELECT run_id FROM runs ORDER BY created_at DESC LIMIT 1").get();
  return typeof row?.run_id === "string" ? row.run_id : null;
}

function runVerdict(value: unknown): VisualRunResult["verdict"] {
  if (value === "continue" || value === "hold_for_review" || value === "stop_and_fix") return value;
  return "hold_for_review";
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function readRunBundleFromAuditStore(runId: string) {
  const row = openDb()
    .prepare("SELECT bundle_json FROM run_bundles WHERE run_id = ?")
    .get(runId);
  if (typeof row?.bundle_json !== "string") return null;
  return parseJson<RunBundle | null>(row.bundle_json, null);
}

export function readRunHistoryFromAuditStore(): AuditRunHistoryRow[] {
  const rows = openDb()
    .prepare(`
      SELECT run_id, project_id, app_url, scenario_id, scenario_fingerprint, verdict, created_at, result_json
      FROM runs
      ORDER BY created_at ASC
    `)
    .all();
  return rows.map((row) => {
    const result = parseJson<Partial<VisualRunResult>>(row.result_json, {});
    return {
      runId: String(row.run_id),
      timestamp: typeof result.finishedAt === "string" ? result.finishedAt : String(row.created_at),
      verdict: runVerdict(result.verdict ?? row.verdict),
      failedAssertionCount: Array.isArray(result.assertions)
        ? result.assertions.filter((item) => !item.passed).length
        : 0,
      appUrl: typeof row.app_url === "string" ? row.app_url : "unknown",
      projectId: typeof row.project_id === "string" ? row.project_id : undefined,
      scenarioId: typeof row.scenario_id === "string" ? row.scenario_id : undefined,
      scenarioFingerprint: typeof row.scenario_fingerprint === "string" ? row.scenario_fingerprint : result.scenarioFingerprint
    };
  });
}

export function readSourceContextsFromAuditStore(runId: string) {
  return openDb()
    .prepare(`
      SELECT source_id, run_id, kind, title, uri, status, permission_state, trust_level, is_simulated, failure_reason, content_hash, read_at, summary, source_json
      FROM source_contexts
      WHERE run_id = ?
      ORDER BY id ASC
    `)
    .all(runId)
    .map((row) => ({
      id: String(row.source_id),
      runId: String(row.run_id),
      kind: String(row.kind),
      title: String(row.title),
      uri: typeof row.uri === "string" ? row.uri : undefined,
      status: String(row.status),
      permissionState: String(row.permission_state),
      trustLevel: String(row.trust_level),
      isSimulated: Number(row.is_simulated) === 1,
      failureReason: typeof row.failure_reason === "string" ? row.failure_reason : undefined,
      contentHash: typeof row.content_hash === "string" ? row.content_hash : undefined,
      readAt: String(row.read_at),
      summary: String(row.summary),
      source: parseJson(row.source_json, {})
    }));
}

export function readEvidenceFromAuditStore(runId: string) {
  const rows = openDb()
    .prepare(`
      SELECT evidence_id, run_id, type, title, scenario_id, attempt_id, attempt, sequence, artifact_ids_json, path_id, step_id, created_at, artifact_uri, url, payload_json
      FROM evidence
      WHERE run_id = ?
      ORDER BY created_at ASC
    `)
    .all(runId);
  return rows.map((row) => ({
    id: String(row.evidence_id),
    runId: String(row.run_id),
    type: String(row.type) as EvidenceItem["type"],
    title: typeof row.title === "string" && row.title ? row.title : `${String(row.type)} evidence`,
    timestamp: String(row.created_at),
    scenarioId: typeof row.scenario_id === "string" ? row.scenario_id : undefined,
    attemptId: typeof row.attempt_id === "string" ? row.attempt_id : undefined,
    attempt: typeof row.attempt === "number" ? row.attempt : undefined,
    sequence: typeof row.sequence === "number" ? row.sequence : undefined,
    artifactIds: parseJson<string[]>(row.artifact_ids_json, []),
    pathId: typeof row.path_id === "string" ? row.path_id : undefined,
    stepId: typeof row.step_id === "string" ? row.step_id : undefined,
    url: typeof row.url === "string" ? row.url : undefined,
    file: typeof row.artifact_uri === "string" ? row.artifact_uri : undefined,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {})
  }));
}

export function readFindingsFromAuditStore(runId: string) {
  return openDb()
    .prepare(`
      SELECT judge_layer, finding_id, severity, title, reasoning, evidence_refs_json, created_at
      FROM findings
      WHERE run_id = ?
      ORDER BY id ASC
    `)
    .all(runId)
    .map((row) => ({
      layer: String(row.judge_layer),
      id: String(row.finding_id),
      severity: String(row.severity),
      title: String(row.title),
      reasoning: String(row.reasoning),
      evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []),
      createdAt: String(row.created_at)
    }));
}

export function readJudgeSummaryFromAuditStore(runId: string) {
  return openDb()
    .prepare(`
      SELECT source, execution_mode, llm_status, policy_version, layer, verdict, summary, created_at
      FROM judge_results
      WHERE run_id = ?
      ORDER BY id ASC
    `)
    .all(runId)
    .map((row) => ({
      source: String(row.source),
      executionMode: typeof row.execution_mode === "string" ? row.execution_mode : "unknown",
      llmStatus: typeof row.llm_status === "string" ? row.llm_status : "unknown",
      policyVersion: typeof row.policy_version === "string" ? row.policy_version : "unknown",
      layer: String(row.layer),
      verdict: String(row.verdict),
      summary: String(row.summary),
      createdAt: String(row.created_at)
    }));
}

export function auditStoreStatus() {
  const database = openDb();
  const runRow = database.prepare("SELECT count(*) AS count FROM runs").get();
  const evidenceRow = database.prepare("SELECT count(*) AS count FROM evidence").get();
  const eventRow = database.prepare("SELECT count(*) AS count FROM audit_events").get();
  const userVersionRow = database.prepare("PRAGMA user_version").get();
  const integrityRow = database.prepare("PRAGMA integrity_check").get();
  const migrationRows = database
    .prepare("SELECT version, applied_at, description FROM schema_migrations ORDER BY version ASC")
    .all();
  const appliedVersions = new Set(migrationRows.map((row) => Number(row.version)));
  const expectedVersions = migrations.map((migration) => migration.version);
  const missingMigrations = expectedVersions.filter((version) => !appliedVersions.has(version));
  const userVersion = Number(userVersionRow?.user_version ?? 0);
  const integrityCheck = String(integrityRow?.integrity_check ?? "unknown");
  return {
    database: auditDbFile,
    schemaVersion,
    userVersion,
    schemaVersionMatches: userVersion === schemaVersion,
    migrations: migrationRows.map((row) => ({
      version: Number(row.version),
      appliedAt: String(row.applied_at),
      description: String(row.description)
    })),
    expectedMigrationVersions: expectedVersions,
    missingMigrations,
    migrationComplete: missingMigrations.length === 0,
    integrityCheck,
    integrityOk: integrityCheck === "ok",
    runs: Number(runRow?.count ?? 0),
    evidence: Number(evidenceRow?.count ?? 0),
    events: Number(eventRow?.count ?? 0),
    journalMode: "WAL"
  };
}
