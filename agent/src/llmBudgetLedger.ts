import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
  llmBudgetLedgerSchema,
  llmBudgetSchema,
  type LlmBudget,
  type LlmBudgetLedger,
  type LlmCall
} from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const ledgerRoot = path.join(rootDir, "reports", "llm-budgets");
const localLocks = new Map<string, Promise<void>>();

function counterFor(purpose: LlmCall["purpose"]): keyof LlmBudgetLedger["reserved"] | undefined {
  if (purpose === "planning") return "plannerCalls";
  if (purpose === "browser-action") return "browserActionCalls";
  if (purpose === "judging") return "judgeCalls";
  if (purpose === "triage") return "triageCalls";
  if (purpose === "repairing") return "repairCalls";
  return undefined;
}

function emptyUsage() {
  return {
    plannerCalls: 0,
    browserActionCalls: 0,
    judgeCalls: 0,
    triageCalls: 0,
    repairCalls: 0,
    tokens: 0,
    wallClockMs: 0,
    estimatedCostUsd: 0
  };
}

function createLedger(runId: string, budget: LlmBudget): LlmBudgetLedger {
  return llmBudgetLedgerSchema.parse({
    schemaVersion: "1.0",
    runId,
    budget,
    reserved: emptyUsage(),
    consumed: emptyUsage(),
    scopes: {},
    updatedAt: new Date().toISOString()
  });
}

function assertCapacity(
  ledger: LlmBudgetLedger,
  purpose: LlmCall["purpose"],
  estimate: { tokens: number; wallClockMs: number; estimatedCostUsd?: number | null },
  countLogicalCall: boolean,
  budget: LlmBudget,
  scopeId?: string
) {
  const usage = scopeId
    ? ledger.scopes[scopeId] ?? { reserved: emptyUsage(), consumed: emptyUsage() }
    : { reserved: ledger.reserved, consumed: ledger.consumed };
  const key = counterFor(purpose);
  if (key && countLogicalCall) {
    const maximum = purpose === "planning" ? budget.maxPlannerCalls
      : purpose === "browser-action" ? budget.maxBrowserActionCalls
        : purpose === "judging" ? budget.maxJudgeCalls
        : purpose === "triage" ? budget.maxTriageCalls
          : budget.maxRepairCallsPerRound * budget.maxRepairRounds;
    if ((usage.reserved[key] ?? 0) + (usage.consumed[key] ?? 0) + 1 > maximum) {
      throw new Error(`llm_budget_exceeded:${purpose}_calls`);
    }
  }
  if (usage.reserved.tokens + usage.consumed.tokens + estimate.tokens > budget.maxTotalTokens) {
    throw new Error("llm_budget_exceeded:total_tokens");
  }
  if (usage.reserved.wallClockMs + usage.consumed.wallClockMs + estimate.wallClockMs > budget.totalTimeoutMs) {
    throw new Error("llm_budget_exceeded:wall_clock");
  }
  if (
    budget.maxEstimatedCostUsd !== undefined
    && estimate.estimatedCostUsd !== null
    && estimate.estimatedCostUsd !== undefined
    && (usage.reserved.estimatedCostUsd ?? 0) + (usage.consumed.estimatedCostUsd ?? 0) + estimate.estimatedCostUsd > budget.maxEstimatedCostUsd
  ) {
    throw new Error("llm_budget_exceeded:estimated_cost");
  }
}

function reserveInLedger(
  ledger: LlmBudgetLedger,
  purpose: LlmCall["purpose"],
  estimate: { tokens: number; wallClockMs: number; estimatedCostUsd?: number | null },
  countLogicalCall: boolean,
  budget: LlmBudget,
  scopeId?: string
) {
  assertCapacity(ledger, purpose, estimate, countLogicalCall, budget, scopeId);
  const reserved = { ...ledger.reserved };
  const key = counterFor(purpose);
  if (key && countLogicalCall) reserved[key] += 1;
  reserved.tokens += estimate.tokens;
  reserved.wallClockMs += estimate.wallClockMs;
  reserved.estimatedCostUsd = estimate.estimatedCostUsd === null || reserved.estimatedCostUsd === null
    ? null
    : (reserved.estimatedCostUsd ?? 0) + (estimate.estimatedCostUsd ?? 0);
  const scopes = { ...ledger.scopes };
  if (scopeId) {
    const current = scopes[scopeId] ?? { reserved: emptyUsage(), consumed: emptyUsage() };
    const scopedReserved = { ...current.reserved };
    if (key && countLogicalCall) scopedReserved[key] += 1;
    scopedReserved.tokens += estimate.tokens;
    scopedReserved.wallClockMs += estimate.wallClockMs;
    scopedReserved.estimatedCostUsd = estimate.estimatedCostUsd === null || scopedReserved.estimatedCostUsd === null
      ? null
      : (scopedReserved.estimatedCostUsd ?? 0) + (estimate.estimatedCostUsd ?? 0);
    scopes[scopeId] = { ...current, reserved: scopedReserved };
  }
  return llmBudgetLedgerSchema.parse({ ...ledger, reserved, scopes, updatedAt: new Date().toISOString() });
}

function finalizeInLedger(
  ledger: LlmBudgetLedger,
  purpose: LlmCall["purpose"],
  estimate: { tokens: number; wallClockMs: number; estimatedCostUsd?: number | null },
  actual: { tokens: number; wallClockMs: number; estimatedCostUsd?: number | null },
  countLogicalCall: boolean,
  scopeId?: string
) {
  const reserved = { ...ledger.reserved };
  const consumed = { ...ledger.consumed };
  const key = counterFor(purpose);
  if (key && countLogicalCall) {
    reserved[key] = Math.max(0, (reserved[key] ?? 0) - 1);
    consumed[key] = (consumed[key] ?? 0) + 1;
  }
  reserved.tokens = Math.max(0, reserved.tokens - estimate.tokens);
  reserved.wallClockMs = Math.max(0, reserved.wallClockMs - estimate.wallClockMs);
  if (reserved.estimatedCostUsd !== null && estimate.estimatedCostUsd !== null) {
    reserved.estimatedCostUsd = Math.max(0, reserved.estimatedCostUsd - (estimate.estimatedCostUsd ?? 0));
  }
  consumed.tokens += actual.tokens;
  consumed.wallClockMs += actual.wallClockMs;
  consumed.estimatedCostUsd = actual.estimatedCostUsd === null || consumed.estimatedCostUsd === null
    ? null
    : (consumed.estimatedCostUsd ?? 0) + (actual.estimatedCostUsd ?? 0);
  const scopes = { ...ledger.scopes };
  if (scopeId) {
    const current = scopes[scopeId] ?? { reserved: emptyUsage(), consumed: emptyUsage() };
    const scopedReserved = { ...current.reserved };
    const scopedConsumed = { ...current.consumed };
    if (key && countLogicalCall) {
      scopedReserved[key] = Math.max(0, (scopedReserved[key] ?? 0) - 1);
      scopedConsumed[key] = (scopedConsumed[key] ?? 0) + 1;
    }
    scopedReserved.tokens = Math.max(0, scopedReserved.tokens - estimate.tokens);
    scopedReserved.wallClockMs = Math.max(0, scopedReserved.wallClockMs - estimate.wallClockMs);
    if (scopedReserved.estimatedCostUsd !== null && estimate.estimatedCostUsd !== null) {
      scopedReserved.estimatedCostUsd = Math.max(0, scopedReserved.estimatedCostUsd - (estimate.estimatedCostUsd ?? 0));
    }
    scopedConsumed.tokens += actual.tokens;
    scopedConsumed.wallClockMs += actual.wallClockMs;
    scopedConsumed.estimatedCostUsd = actual.estimatedCostUsd === null || scopedConsumed.estimatedCostUsd === null
      ? null
      : (scopedConsumed.estimatedCostUsd ?? 0) + (actual.estimatedCostUsd ?? 0);
    scopes[scopeId] = { reserved: scopedReserved, consumed: scopedConsumed };
  }
  return llmBudgetLedgerSchema.parse({ ...ledger, reserved, consumed, scopes, updatedAt: new Date().toISOString() });
}

async function withLocalLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
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

async function readLocal(runId: string, budget: LlmBudget) {
  try {
    return llmBudgetLedgerSchema.parse(JSON.parse(await readFile(path.join(ledgerRoot, `${runId}.json`), "utf8")));
  } catch {
    return createLedger(runId, budget);
  }
}

async function writeLocal(ledger: LlmBudgetLedger) {
  await mkdir(ledgerRoot, { recursive: true });
  await writeFile(path.join(ledgerRoot, `${ledger.runId}.json`), JSON.stringify(ledger, null, 2));
}

export interface LlmBudgetReservation {
  runId: string;
  purpose: LlmCall["purpose"];
  estimate: { tokens: number; wallClockMs: number; estimatedCostUsd?: number | null };
  budget: LlmBudget;
  countLogicalCall: boolean;
  scopeId?: string;
}

export async function reserveLlmBudget(input: {
  runId: string;
  purpose: LlmCall["purpose"];
  scopeId?: string;
  budget?: LlmBudget;
  estimatedTokens: number;
  estimatedWallClockMs: number;
  estimatedCostUsd?: number | null;
  countLogicalCall?: boolean;
}): Promise<LlmBudgetReservation> {
  const budget = llmBudgetSchema.parse(input.budget ?? {});
  const reservation: LlmBudgetReservation = {
    runId: input.runId,
    purpose: input.purpose,
    budget,
    estimate: {
      tokens: input.estimatedTokens,
      wallClockMs: input.estimatedWallClockMs,
      estimatedCostUsd: input.estimatedCostUsd
    },
    countLogicalCall: input.countLogicalCall !== false,
    ...(input.scopeId ? { scopeId: input.scopeId } : {})
  };
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM llm_budget_ledger_v1 WHERE run_id=$1 FOR UPDATE",
        [input.runId]
      );
      const current = result.rows[0] ? llmBudgetLedgerSchema.parse(result.rows[0].payload) : createLedger(input.runId, budget);
      const next = reserveInLedger(current, input.purpose, reservation.estimate, reservation.countLogicalCall, budget, reservation.scopeId);
      await client.query(
        `INSERT INTO llm_budget_ledger_v1 (run_id,payload,updated_at) VALUES ($1,$2::jsonb,$3)
         ON CONFLICT (run_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,
        [input.runId, JSON.stringify(next), next.updatedAt]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  } else {
    await withLocalLock(input.runId, async () => {
      const next = reserveInLedger(await readLocal(input.runId, budget), input.purpose, reservation.estimate, reservation.countLogicalCall, budget, reservation.scopeId);
      await writeLocal(next);
    });
  }
  return reservation;
}

export async function finalizeLlmBudget(
  reservation: LlmBudgetReservation,
  actual: { tokens?: number; wallClockMs: number; estimatedCostUsd?: number | null }
) {
  const value = {
    tokens: actual.tokens ?? 0,
    wallClockMs: actual.wallClockMs,
    estimatedCostUsd: actual.estimatedCostUsd
  };
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ payload: unknown }>(
        "SELECT payload FROM llm_budget_ledger_v1 WHERE run_id=$1 FOR UPDATE",
        [reservation.runId]
      );
      const current = result.rows[0] ? llmBudgetLedgerSchema.parse(result.rows[0].payload) : createLedger(reservation.runId, reservation.budget);
      const next = finalizeInLedger(current, reservation.purpose, reservation.estimate, value, reservation.countLogicalCall, reservation.scopeId);
      await client.query("UPDATE llm_budget_ledger_v1 SET payload=$2::jsonb,updated_at=$3 WHERE run_id=$1", [reservation.runId, JSON.stringify(next), next.updatedAt]);
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
  return withLocalLock(reservation.runId, async () => {
    const next = finalizeInLedger(
      await readLocal(reservation.runId, reservation.budget),
      reservation.purpose,
      reservation.estimate,
      value,
      reservation.countLogicalCall,
      reservation.scopeId
    );
    await writeLocal(next);
    return next;
  });
}

export async function readLlmBudgetLedger(runId: string, budget?: LlmBudget) {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const result = await pool.query<{ payload: unknown }>("SELECT payload FROM llm_budget_ledger_v1 WHERE run_id=$1", [runId]);
      return result.rows[0] ? llmBudgetLedgerSchema.parse(result.rows[0].payload) : createLedger(runId, llmBudgetSchema.parse(budget ?? {}));
    } finally {
      await pool.end();
    }
  }
  return readLocal(runId, llmBudgetSchema.parse(budget ?? {}));
}
