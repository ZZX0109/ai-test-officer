import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema,
  artifactV2Schema,
  type ArtifactV2,
  type BrowserActionDecision,
  type BrowserActionResult,
  type BrowserObservation,
  type BrowserSession
} from "@ai-test-officer/contracts";
import { getReportsDir } from "../evidenceStore.js";

export type BrowserAgentLifecycleEvent = {
  runId: string;
  type:
    | "browser.session.started" | "browser.session.recovered" | "browser.session.closed"
    | "browser.observation.created"
    | "browser.action.proposed" | "browser.action.authorized" | "browser.action.started" | "browser.action.completed" | "browser.action.failed"
    | "browser.control.changed" | "browser.oracle.evaluated"
    | "browser.loop.blocked" | "browser.loop.completed";
  payload: Record<string, unknown>;
  createdAt: string;
};

const events = new EventEmitter();
events.setMaxListeners(200);
const queues = new Map<string, Promise<unknown>>();
let pool: Pool | undefined;

function database() {
  return process.env.DATABASE_URL ? pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) : undefined;
}

async function persistDatabase(query: string, values: unknown[]) {
  const db = database();
  if (!db) return;
  try { await db.query(query, values); } catch {
    // The append-only files remain the compatibility store until the additive
    // browser-agent migration is installed. Production acceptance verifies
    // the table-backed path separately.
  }
}

async function readDatabasePayloads(query: string, values: unknown[]) {
  const db = database();
  if (!db) return [] as unknown[];
  try {
    const result = await db.query<{ payload: unknown }>(query, values);
    return result.rows.map((row) => row.payload);
  } catch {
    return [] as unknown[];
  }
}

function directory(runId: string) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(runId)) throw new Error("browser_agent_run_id_invalid");
  return path.join(getReportsDir(), "runs", runId, "browser-agent");
}

async function atomicWrite(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.partial`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, file);
}

async function readArray<T>(file: string): Promise<T[]> {
  try { return JSON.parse(await readFile(file, "utf8")) as T[]; } catch { return []; }
}

function serialize<T>(runId: string, operation: () => Promise<T>) {
  const previous = queues.get(runId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(runId, next);
  return next.finally(() => { if (queues.get(runId) === next) queues.delete(runId); });
}

export function publishBrowserAgentLifecycle(event: Omit<BrowserAgentLifecycleEvent, "createdAt">) {
  const complete = { ...event, createdAt: new Date().toISOString() } satisfies BrowserAgentLifecycleEvent;
  events.emit(event.runId, complete);
  return complete;
}

export function subscribeBrowserAgentLifecycle(runId: string, listener: (event: BrowserAgentLifecycleEvent) => void) {
  events.on(runId, listener);
  return () => events.off(runId, listener);
}

export async function writeBrowserSession(input: BrowserSession) {
  const session = browserSessionSchema.parse(input);
  await serialize(session.runId, () => atomicWrite(path.join(directory(session.runId), "session.json"), session));
  await persistDatabase(
    `INSERT INTO browser_sessions_v1 (id,run_id,attempt_id,owner,status,payload,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (run_id) DO UPDATE SET id=EXCLUDED.id,attempt_id=EXCLUDED.attempt_id,owner=EXCLUDED.owner,status=EXCLUDED.status,payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,
    [session.sessionId, session.runId, session.attemptId, session.owner, session.status, session, session.updatedAt]
  );
  return session;
}

export async function readBrowserSession(runId: string): Promise<BrowserSession | undefined> {
  const [persisted] = await readDatabasePayloads("SELECT payload FROM browser_sessions_v1 WHERE run_id=$1", [runId]);
  if (persisted) return browserSessionSchema.parse(persisted);
  try { return browserSessionSchema.parse(JSON.parse(await readFile(path.join(directory(runId), "session.json"), "utf8"))); } catch { return undefined; }
}

export async function appendBrowserObservation(input: BrowserObservation) {
  const observation = browserObservationSchema.parse(input);
  await serialize(observation.runId, async () => {
    const file = path.join(directory(observation.runId), "observations.json");
    const current = await readArray<BrowserObservation>(file);
    current.push(observation);
    await atomicWrite(file, current.slice(-200));
    await atomicWrite(path.join(directory(observation.runId), "latest-observation.json"), observation);
  });
  await persistDatabase(
    `INSERT INTO browser_observations_v1 (id,run_id,attempt_id,coverage_item_id,page_fingerprint,payload,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
    [observation.observationId, observation.runId, observation.attemptId, observation.coverageItemId ?? null, observation.pageFingerprint, observation, observation.createdAt]
  );
  publishBrowserAgentLifecycle({ runId: observation.runId, type: "browser.observation.created", payload: observation });
  return observation;
}

export async function readBrowserObservations(runId: string) {
  const persisted = await readDatabasePayloads("SELECT payload FROM browser_observations_v1 WHERE run_id=$1 ORDER BY created_at", [runId]);
  if (persisted.length) return persisted.map((item) => browserObservationSchema.parse(item));
  const values = await readArray<unknown>(path.join(directory(runId), "observations.json"));
  return values.map((item) => browserObservationSchema.parse(item));
}

export async function readBrowserObservation(runId: string, observationId?: string) {
  if (!observationId) {
    try { return browserObservationSchema.parse(JSON.parse(await readFile(path.join(directory(runId), "latest-observation.json"), "utf8"))); } catch { return undefined; }
  }
  return (await readBrowserObservations(runId)).find((item) => item.observationId === observationId);
}

export async function appendBrowserDecision(input: BrowserActionDecision) {
  const decision = browserActionDecisionSchema.parse(input);
  await serialize(decision.runId, async () => {
    const file = path.join(directory(decision.runId), "decisions.json");
    const current = await readArray<BrowserActionDecision>(file);
    if (!current.some((item) => item.decisionId === decision.decisionId)) current.push(decision);
    await atomicWrite(file, current.slice(-100));
  });
  await persistDatabase(
    `INSERT INTO browser_action_decisions_v1 (id,run_id,attempt_id,observation_id,status,payload,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
    [decision.decisionId, decision.runId, decision.attemptId, decision.observationId, decision.status, decision, decision.createdAt]
  );
  publishBrowserAgentLifecycle({ runId: decision.runId, type: "browser.action.proposed", payload: decision });
  return decision;
}

export async function readBrowserDecisions(runId: string) {
  const persisted = await readDatabasePayloads("SELECT payload FROM browser_action_decisions_v1 WHERE run_id=$1 ORDER BY created_at", [runId]);
  if (persisted.length) return persisted.map((item) => browserActionDecisionSchema.parse(item));
  const values = await readArray<unknown>(path.join(directory(runId), "decisions.json"));
  return values.map((item) => browserActionDecisionSchema.parse(item));
}

export async function appendBrowserActionResult(input: BrowserActionResult) {
  const result = browserActionResultSchema.parse(input);
  await serialize(result.runId, async () => {
    const file = path.join(directory(result.runId), "actions.json");
    const current = await readArray<BrowserActionResult>(file);
    if (!current.some((item) => item.actionId === result.actionId)) current.push(result);
    await atomicWrite(file, current.slice(-200));
  });
  await persistDatabase(
    `INSERT INTO browser_action_results_v1 (id,run_id,attempt_id,coverage_item_id,action_id,status,payload,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
    [result.resultId, result.runId, result.attemptId, result.coverageItemId, result.actionId, result.status, result, result.completedAt]
  );
  publishBrowserAgentLifecycle({
    runId: result.runId,
    type: result.status === "completed" ? "browser.action.completed" : "browser.action.failed",
    payload: result
  });
  return result;
}

export async function readBrowserActionResults(runId: string) {
  const persisted = await readDatabasePayloads("SELECT payload FROM browser_action_results_v1 WHERE run_id=$1 ORDER BY completed_at", [runId]);
  if (persisted.length) return persisted.map((item) => browserActionResultSchema.parse(item));
  const values = await readArray<unknown>(path.join(directory(runId), "actions.json"));
  return values.map((item) => browserActionResultSchema.parse(item));
}

export async function appendBrowserArtifact(input: ArtifactV2) {
  const artifact = artifactV2Schema.parse(input);
  await serialize(artifact.runId, async () => {
    const file = path.join(directory(artifact.runId), "artifacts.json");
    const current = await readArray<ArtifactV2>(file);
    if (!current.some((item) => item.id === artifact.id)) current.push(artifact);
    await atomicWrite(file, current);
  });
  return artifact;
}

export async function readBrowserArtifacts(runId: string) {
  const values = await readArray<unknown>(path.join(directory(runId), "artifacts.json"));
  return values.map((item) => artifactV2Schema.parse(item));
}

export function browserSessionFramePath(runId: string) {
  return path.join(directory(runId), "live-frame.jpeg");
}
