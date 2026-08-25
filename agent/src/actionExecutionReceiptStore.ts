import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getDatabasePool } from "./databaseRuntime.js";

const schemaReadyByDatabase = new WeakMap<object, Promise<void>>();

export interface ActionExecutionReceipt {
  runId: string;
  actionId: string;
  operationId: string;
  idempotencyKey: string;
  status: "pending" | "completed";
  result?: unknown;
}

function actionKey(input: { runId: string; actionId: string; operationId: string }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([input.runId, input.actionId, input.operationId]))
    .digest("hex");
  return `ato_${digest}`;
}

async function ensureSchema(database: Pool) {
  let ready = schemaReadyByDatabase.get(database);
  if (!ready) {
    ready = database.query(`
      CREATE TABLE IF NOT EXISTS action_execution_receipts_v1 (
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending','completed')),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, action_id)
      );
      CREATE INDEX IF NOT EXISTS action_execution_receipts_v1_run_idx
        ON action_execution_receipts_v1 (run_id, status);
    `).then(() => undefined);
    schemaReadyByDatabase.set(database, ready);
  }
  await ready;
}

/**
 * Claim the one durable logical execution of a mutable API action. The
 * database row is intentionally created before any network I/O. If a process
 * dies after the target applies the request but before this receipt is marked
 * complete, a retry uses exactly the same target idempotency key.
 */
export async function claimActionExecutionReceipt(input: {
  runId?: string;
  actionId?: string;
  operationId: string;
}): Promise<ActionExecutionReceipt> {
  if (!input.runId || !input.actionId) throw new Error("mutable_api_action_identity_missing");
  const database = getDatabasePool();
  if (!database) throw new Error("mutable_api_action_receipt_store_unavailable");
  await ensureSchema(database);
  const idempotencyKey = actionKey({ runId: input.runId, actionId: input.actionId, operationId: input.operationId });
  const inserted = await database.query(
    `INSERT INTO action_execution_receipts_v1 (run_id,action_id,operation_id,idempotency_key,status)
     VALUES ($1,$2,$3,$4,'pending')
     ON CONFLICT (run_id,action_id) DO NOTHING
     RETURNING run_id,action_id,operation_id,idempotency_key,status,result`,
    [input.runId, input.actionId, input.operationId, idempotencyKey]
  );
  if (inserted.rows[0]) {
    return {
      runId: inserted.rows[0].run_id,
      actionId: inserted.rows[0].action_id,
      operationId: inserted.rows[0].operation_id,
      idempotencyKey: inserted.rows[0].idempotency_key,
      status: inserted.rows[0].status,
      result: inserted.rows[0].result ?? undefined
    } as ActionExecutionReceipt;
  }
  const existing = await database.query(
    `SELECT run_id,action_id,operation_id,idempotency_key,status,result
       FROM action_execution_receipts_v1
      WHERE run_id=$1 AND action_id=$2`,
    [input.runId, input.actionId]
  );
  const row = existing.rows[0];
  if (!row || row.operation_id !== input.operationId) throw new Error("mutable_api_action_receipt_conflict");
  return {
    runId: row.run_id,
    actionId: row.action_id,
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    result: row.result ?? undefined
  } as ActionExecutionReceipt;
}

export async function completeActionExecutionReceipt(input: {
  receipt: Pick<ActionExecutionReceipt, "runId" | "actionId" | "operationId" | "idempotencyKey">;
  result: unknown;
}) {
  const database = getDatabasePool();
  if (!database) throw new Error("mutable_api_action_receipt_store_unavailable");
  await ensureSchema(database);
  const updated = await database.query(
    `UPDATE action_execution_receipts_v1
        SET status='completed',result=$5::jsonb,updated_at=now()
      WHERE run_id=$1 AND action_id=$2 AND operation_id=$3 AND idempotency_key=$4
      RETURNING run_id`,
    [input.receipt.runId, input.receipt.actionId, input.receipt.operationId, input.receipt.idempotencyKey, JSON.stringify(input.result)]
  );
  if (updated.rowCount !== 1) throw new Error("mutable_api_action_receipt_completion_conflict");
}
