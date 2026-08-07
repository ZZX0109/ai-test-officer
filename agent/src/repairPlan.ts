import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { assistantActionForRepairDecision } from "./assistantFallback.js";
import { readRunBundle } from "./evidenceStore.js";
import { decideRepair } from "./repairDecision.js";
import type { FailureAttribution, RepairDecision } from "./types.js";

/**
 * Run-scoped repair plan resolution.
 *
 * A single place that turns a persisted run's failure attributions into the
 * owner-aware repair plan consumed by:
 *  - `GET /v1/runs/:id/repair-plan` (workbench polling / deep link)
 *  - the deterministic assistant fallback (so the chat reply carries the same
 *    canonical instruction instead of improvising one)
 *
 * Keeping one resolver guarantees the API and the chat never disagree about
 * who owns the failure.
 */

export interface RunRepairPlan {
  runId: string;
  /** Human-readable failure title taken from the top-ranked attribution. */
  problem: string;
  decision: RepairDecision;
  /**
   * Binding to the persisted plan (`repair_plans_v1`). Present whenever the
   * graph already stored a plan for this run; absent only for the derive-only
   * path (no persistence yet). Without these the UI can render text but cannot
   * act on it — no plan to update, no attempt to retry, no evidence to open.
   */
  planId?: string;
  attemptId?: string;
  scenarioId?: string;
  status?: RepairPlanStatus;
  evidenceRefs?: string[];
  policyVersion?: string;
  idempotencyKey?: string;
  /** True when the plan was read back from storage rather than recomputed. */
  persisted?: boolean;
}

export type RepairPlanStatus = "pending" | "applied" | "resolved" | "dismissed";

export interface PersistedRepairPlan {
  id: string;
  runId: string;
  projectId?: string;
  attributionId?: string;
  attemptId?: string;
  scenarioId?: string;
  failureType: string;
  owner: RepairDecision["owner"];
  repairType: RepairDecision["type"];
  executable: boolean;
  problem: string;
  userMessage: string;
  steps: string[];
  validation: string;
  status: RepairPlanStatus;
  evidenceRefs?: string[];
  policyVersion?: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

const rootDir = path.basename(process.cwd()) === "agent"
  ? path.resolve(process.cwd(), "..")
  : process.cwd();
const repairPlansRoot = path.join(rootDir, "reports", "repair-plans");
let postgresPool: Pool | undefined;

function pool() {
  if (!process.env.DATABASE_URL) return undefined;
  postgresPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return postgresPool;
}

function planFile(runId: string) {
  return path.join(repairPlansRoot, `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function canonicalDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Pick the attribution the repair plan should be built from (lowest rank). */
export function selectRepairableAttribution(
  attributions: FailureAttribution[] | undefined
): FailureAttribution | undefined {
  if (!attributions?.length) return undefined;
  return [...attributions].sort((left, right) => left.rank - right.rank)[0];
}

/**
 * Resolve the repair plan for a persisted run. Returns `undefined` (never
 * throws) when the run is missing or carries no failure attribution, so callers
 * can treat "no plan" as a normal state rather than an error path.
 */
export async function resolveRunRepairPlan(
  runId: string | undefined
): Promise<RunRepairPlan | undefined> {
  if (!runId) return undefined;
  // Persisted plans win: the graph already committed a decision (with its
  // attempt/scenario binding, evidence refs and lifecycle status), and the API
  // must not silently disagree with the row the feedback loop learns from.
  const persisted = await readRepairPlans(runId);
  const latest = persisted.at(-1);
  if (latest) {
    return {
      runId,
      problem: latest.problem,
      decision: {
        owner: latest.owner,
        type: latest.repairType,
        executable: latest.executable,
        userMessage: latest.userMessage,
        steps: latest.steps,
        validation: latest.validation,
        nextAction: latest.repairType
      },
      planId: latest.id,
      attemptId: latest.attemptId,
      scenarioId: latest.scenarioId,
      status: latest.status,
      evidenceRefs: latest.evidenceRefs,
      policyVersion: latest.policyVersion,
      idempotencyKey: latest.idempotencyKey,
      persisted: true
    };
  }
  let bundle;
  try {
    bundle = await readRunBundle(runId);
  } catch {
    return undefined;
  }
  const attributions = bundle?.failureAttributions
    ?? bundle?.result?.failureAttributions
    ?? [];
  const top = selectRepairableAttribution(attributions);
  if (!top) return undefined;
  return {
    runId,
    problem: top.title,
    decision: decideRepair(top),
    evidenceRefs: top.evidenceRefs?.length ? top.evidenceRefs : undefined,
    persisted: false
  };
}

/**
 * Shape expected by `AssistantFailureContext.repairDecision`. Kept structural
 * (not a direct type import) so assistantFallback stays free of run-store deps.
 */
export function toAssistantRepairDecision(plan: RunRepairPlan | undefined) {
  if (!plan) return undefined;
  return {
    owner: plan.decision.owner,
    // `type` + `executable` are what let the assistant offer the action the
    // decision actually implies instead of a hard-coded "retry".
    type: plan.decision.type,
    executable: plan.decision.executable,
    userMessage: plan.decision.userMessage,
    steps: plan.decision.steps,
    validation: plan.decision.validation,
    problem: plan.problem
  };
}

/**
 * Wire shape persisted on the agent message and rendered by
 * `RepairPlanPanel`. Matches `agentMessageSchema.repairPlan`.
 */
export function toRepairPlanPayload(plan: RunRepairPlan | undefined) {
  if (!plan) return undefined;
  return {
    owner: plan.decision.owner,
    problem: plan.problem,
    // `type` + `executable` tell the panel whether the agent may act; the
    // binding fields tell it *what* it would act on. Dropping them here is what
    // used to reduce the panel to un-actionable prose.
    type: plan.decision.type,
    executable: plan.decision.executable,
    steps: plan.decision.steps,
    validation: plan.decision.validation,
    message: plan.decision.userMessage,
    planId: plan.planId,
    runId: plan.runId,
    attemptId: plan.attemptId,
    scenarioId: plan.scenarioId,
    status: plan.status,
    evidenceRefs: plan.evidenceRefs,
    policyVersion: plan.policyVersion,
    // Derived from the same mapping the chat fallback uses, so the panel button
    // and the chat suggestion can never diverge.
    action: assistantActionForRepairDecision(plan.decision)
  };
}

/**
 * Persist the repair plan for a run (`repair_plans_v1` + a file mirror so the
 * workbench keeps working without Postgres). Storing the decision — not just the
 * failure text — is what lets the feedback loop later ask "which repair type
 * actually cleared this failure class for this project?".
 *
 * Never throws: a persistence outage must not turn an explained failure back
 * into an unexplained one.
 */
export async function persistRepairPlan(input: {
  runId: string;
  projectId?: string;
  attributionId?: string;
  failureType: string;
  problem: string;
  decision: RepairDecision;
  status?: RepairPlanStatus;
  attemptId?: string;
  scenarioId?: string;
  evidenceRefs?: string[];
  policyVersion?: string;
  /** Stable key so a graph re-run / restart cannot create a duplicate plan. */
  idempotencyKey?: string;
}): Promise<PersistedRepairPlan | undefined> {
  const now = new Date().toISOString();
  const record: PersistedRepairPlan = {
    id: input.idempotencyKey ?? `repair_plan_${randomUUID()}`,
    runId: input.runId,
    projectId: input.projectId,
    attributionId: input.attributionId,
    attemptId: input.attemptId,
    scenarioId: input.scenarioId,
    failureType: input.failureType,
    owner: input.decision.owner,
    repairType: input.decision.type,
    executable: input.decision.executable,
    problem: input.problem,
    userMessage: input.decision.userMessage,
    steps: input.decision.steps,
    validation: input.decision.validation,
    status: input.status ?? "pending",
    evidenceRefs: input.evidenceRefs,
    policyVersion: input.policyVersion,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now
  };
  try {
    const database = pool();
    if (database) {
      await database.query(
        `INSERT INTO repair_plans_v1
         (id, run_id, project_id, attribution_id, attempt_id, scenario_id, failure_type, owner, repair_type,
          executable, problem, user_message, steps, validation, status, evidence_refs, policy_version,
          idempotency_key, canonical_sha256, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17,$18,$19,$20,$21)
         ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          record.runId,
          record.projectId ?? null,
          record.attributionId ?? null,
          record.attemptId ?? null,
          record.scenarioId ?? null,
          record.failureType,
          record.owner,
          record.repairType,
          record.executable,
          record.problem,
          record.userMessage,
          JSON.stringify(record.steps),
          JSON.stringify({ expectation: record.validation }),
          record.status,
          JSON.stringify(record.evidenceRefs ?? []),
          record.policyVersion ?? null,
          record.idempotencyKey ?? null,
          canonicalDigest(record),
          record.createdAt,
          record.updatedAt
        ]
      );
    }
    await mkdir(repairPlansRoot, { recursive: true });
    const existing = await readRepairPlans(record.runId);
    // The file mirror must honour the same idempotency the SQL write does
    // (`ON CONFLICT (id) DO NOTHING`). A re-entered graph recomputes the same
    // plan; appending it again would make one failure look like two repairs and
    // skew what the feedback loop learns.
    const alreadyStored = existing.find((plan) => plan.id === record.id);
    if (alreadyStored) return alreadyStored;
    await writeFile(
      planFile(record.runId),
      JSON.stringify([...existing, record], null, 2)
    );
    return record;
  } catch {
    return undefined;
  }
}

/** Read persisted repair plans for a run, newest last. Never throws. */
export async function readRepairPlans(runId: string): Promise<PersistedRepairPlan[]> {
  const database = pool();
  if (database) {
    try {
      const result = await database.query<{ payload: PersistedRepairPlan }>(
        `SELECT jsonb_build_object(
           'id', id, 'runId', run_id, 'projectId', project_id, 'attributionId', attribution_id,
           'attemptId', attempt_id, 'scenarioId', scenario_id,
           'failureType', failure_type, 'owner', owner, 'repairType', repair_type,
           'executable', executable, 'problem', problem, 'userMessage', user_message,
           'steps', steps, 'validation', validation->>'expectation', 'status', status,
           'evidenceRefs', evidence_refs, 'policyVersion', policy_version,
           'idempotencyKey', idempotency_key,
           'createdAt', created_at, 'updatedAt', updated_at
         ) AS payload
         FROM repair_plans_v1 WHERE run_id=$1 ORDER BY created_at ASC`,
        [runId]
      );
      if (result.rows.length) return result.rows.map((row) => row.payload);
    } catch {
      // fall through to the file mirror
    }
  }
  try {
    const raw = JSON.parse(await readFile(planFile(runId), "utf8"));
    return Array.isArray(raw) ? (raw as PersistedRepairPlan[]) : [];
  } catch {
    return [];
  }
}

/**
 * Advance a persisted repair plan's lifecycle status (`pending` → `applied` →
 * `resolved` | `dismissed`). The append-only trigger on `repair_plans_v1` only
 * permits `status` / `updated_at` to change, so this can never rewrite the
 * decision itself. Writes the DB row and keeps the file mirror in sync so the
 * workbench still works without Postgres. `status` may be omitted when the
 * caller only wants to record a transition event (e.g. an actions failed) without
 * moving the row.
 *
 * Never throws: a persistence outage must not turn an explained failure back
 * into an unexplained one.
 */
export async function updateRepairPlanStatus(
  runId: string,
  planId: string,
  status?: RepairPlanStatus
): Promise<PersistedRepairPlan | undefined> {
  if (status && !["pending", "applied", "resolved", "dismissed"].includes(status)) {
    throw new Error(`invalid_repair_plan_status:${status}`);
  }
  const now = new Date().toISOString();
  try {
    const database = pool();
    if (database && status) {
      await database.query(
        "UPDATE repair_plans_v1 SET status=$1, updated_at=$2 WHERE id=$3 AND run_id=$4",
        [status, now, planId, runId]
      );
    }
    const existing = await readRepairPlans(runId);
    const index = existing.findIndex((plan) => plan.id === planId);
    if (index < 0) return undefined;
    if (status) existing[index] = { ...existing[index], status, updatedAt: now };
    await writeFile(planFile(runId), JSON.stringify(existing, null, 2));
    return existing[index];
  } catch {
    return undefined;
  }
}
