import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getDatabasePool } from "./databaseRuntime.js";

export type OutboxTopic = "run.execute" | "parent.aggregate";

export interface OutboxJob {
  id: string;
  topic: OutboxTopic;
  aggregateId: string;
  idempotencyKey: string;
  payload: { runId: string; version?: number; jobId: string };
  attempts: number;
}

const schemaReadyByDatabase = new WeakMap<object, Promise<void>>();

function pool() {
  return getDatabasePool();
}

function outboxId(idempotencyKey: string) {
  return `outbox_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40)}`;
}

export async function ensureOutboxSchema(database = pool()) {
  if (!database) return;
  let schemaReady = schemaReadyByDatabase.get(database);
  if (!schemaReady) {
    schemaReady = database.query(`
    CREATE TABLE IF NOT EXISTS event_outbox_v1 (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS event_outbox_v1_pending_idx
      ON event_outbox_v1 (status, available_at, created_at);
    `).then(() => undefined);
    schemaReadyByDatabase.set(database, schemaReady);
  }
  await schemaReady;
}

export async function insertOutboxInTransaction(
  client: PoolClient,
  input: {
    topic: OutboxTopic;
    aggregateId: string;
    idempotencyKey: string;
    payload: { runId: string; version?: number; jobId: string };
  }
) {
  await client.query(
    `INSERT INTO event_outbox_v1
       (id,topic,aggregate_id,idempotency_key,payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [outboxId(input.idempotencyKey), input.topic, input.aggregateId, input.idempotencyKey, JSON.stringify(input.payload)]
  );
}

export async function recordOutboxJob(input: {
  topic: OutboxTopic;
  aggregateId: string;
  idempotencyKey: string;
  payload: { runId: string; version?: number; jobId: string };
}) {
  const database = pool();
  if (!database) return undefined;
  await ensureOutboxSchema(database);
  await database.query(
    `INSERT INTO event_outbox_v1
       (id,topic,aggregate_id,idempotency_key,payload)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [outboxId(input.idempotencyKey), input.topic, input.aggregateId, input.idempotencyKey, JSON.stringify(input.payload)]
  );
  return outboxId(input.idempotencyKey);
}

async function claim(database: Pool, limit: number) {
  const result = await database.query<{
    id: string;
    topic: OutboxTopic;
    aggregate_id: string;
    idempotency_key: string;
    payload: OutboxJob["payload"];
    attempts: number;
  }>(
    `WITH candidates AS (
       SELECT id
       FROM event_outbox_v1
       WHERE (status='pending' OR (status='publishing' AND updated_at < now() - interval '1 minute'))
         AND available_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE event_outbox_v1 AS outbox
     SET status='publishing', attempts=outbox.attempts + 1, updated_at=now()
     FROM candidates
     WHERE outbox.id=candidates.id
     RETURNING outbox.id,outbox.topic,outbox.aggregate_id,outbox.idempotency_key,outbox.payload,outbox.attempts`,
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    attempts: row.attempts
  } satisfies OutboxJob));
}

export async function publishPendingOutboxWithDatabase(database: Pool, input: {
  limit?: number;
  publish: (job: OutboxJob) => Promise<void>;
}) {
  await ensureOutboxSchema(database);
  const jobs = await claim(database, input.limit ?? 25);
  let published = 0;
  for (const job of jobs) {
    try {
      await input.publish(job);
      await database.query(
        "UPDATE event_outbox_v1 SET status='published',published_at=now(),updated_at=now(),last_error=NULL WHERE id=$1",
        [job.id]
      );
      published += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await database.query(
        `UPDATE event_outbox_v1
         SET status='pending',available_at=now() + (LEAST(attempts,30) * interval '1 second'),updated_at=now(),last_error=$2
         WHERE id=$1`,
        [job.id, message.slice(0, 1_000)]
      );
    }
  }
  return published;
}

export async function publishPendingOutbox(input: {
  limit?: number;
  publish: (job: OutboxJob) => Promise<void>;
}) {
  const database = pool();
  if (!database) return 0;
  return publishPendingOutboxWithDatabase(database, input);
}
