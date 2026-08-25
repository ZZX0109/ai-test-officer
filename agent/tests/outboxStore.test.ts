import assert from "node:assert/strict";
import type { Pool } from "pg";
import { publishPendingOutboxWithDatabase, type OutboxJob } from "../src/outboxStore.js";

class FakeOutboxDatabase {
  readonly jobs: Array<OutboxJob & { status: "pending" | "publishing" | "published"; lastError?: string }> = [{
    id: "outbox_1",
    topic: "run.execute",
    aggregateId: "run_1",
    idempotencyKey: "permission:run_1:v4",
    payload: { runId: "run_1", version: 4, jobId: "job_1" },
    attempts: 0,
    status: "pending"
  }];

  async query<T = unknown>(sql: string, params: unknown[] = []) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS event_outbox_v1")) return { rows: [] as T[], rowCount: 0 };
    if (sql.includes("WITH candidates AS")) {
      const limit = Number(params[0] ?? 25);
      const rows = this.jobs
        .filter((job) => job.status === "pending")
        .slice(0, limit)
        .map((job) => {
          job.status = "publishing";
          job.attempts += 1;
          return {
            id: job.id,
            topic: job.topic,
            aggregate_id: job.aggregateId,
            idempotency_key: job.idempotencyKey,
            payload: job.payload,
            attempts: job.attempts
          };
        });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.includes("SET status='published'")) {
      const job = this.jobs.find((item) => item.id === params[0]);
      if (job) {
        job.status = "published";
        delete job.lastError;
      }
      return { rows: [] as T[], rowCount: job ? 1 : 0 };
    }
    if (sql.includes("SET status='pending'")) {
      const job = this.jobs.find((item) => item.id === params[0]);
      if (job) {
        job.status = "pending";
        job.lastError = String(params[1]);
      }
      return { rows: [] as T[], rowCount: job ? 1 : 0 };
    }
    throw new Error(`unexpected_outbox_sql:${sql.slice(0, 48)}`);
  }
}

export async function testOutboxRetryAndDeduplication() {
  const database = new FakeOutboxDatabase();
  let deliveries = 0;
  const publish = async () => {
    deliveries += 1;
    if (deliveries === 1) throw new Error("queue_unavailable");
  };

  const firstAttempt = await publishPendingOutboxWithDatabase(database as unknown as Pool, { publish });
  assert.equal(firstAttempt, 0, "a queue failure must not mark the outbox record published");
  assert.equal(database.jobs[0]?.status, "pending");
  assert.equal(database.jobs[0]?.attempts, 1);
  assert.equal(database.jobs[0]?.lastError, "queue_unavailable");

  const retry = await publishPendingOutboxWithDatabase(database as unknown as Pool, { publish });
  assert.equal(retry, 1);
  assert.equal(database.jobs[0]?.status, "published");
  assert.equal(database.jobs[0]?.attempts, 2);

  const replay = await publishPendingOutboxWithDatabase(database as unknown as Pool, { publish });
  assert.equal(replay, 0, "a published outbox record must not be delivered twice");
  assert.equal(deliveries, 2);
}
