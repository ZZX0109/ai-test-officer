import { Pool, type PoolConfig } from "pg";

/**
 * Process-wide PostgreSQL runtime.
 *
 * Business modules must borrow this pool and must never call `end()` on it.
 * A single owner closes all pools during process shutdown. Keeping the
 * connection policy here makes pool sizing, timeouts and error telemetry
 * observable instead of silently multiplying one pool per repository.
 */
const pools = new Map<string, Pool>();

function positiveEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function poolKey(connectionString: string) {
  return connectionString.trim();
}

function sharedConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: positiveEnv("DATABASE_POOL_MAX", 20),
    min: 0,
    idleTimeoutMillis: positiveEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: positiveEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 10_000),
    maxUses: positiveEnv("DATABASE_POOL_MAX_USES", 0) || undefined,
    application_name: process.env.DATABASE_APPLICATION_NAME ?? "ai-test-officer"
  };
}

/** Return the shared application pool, or undefined in local file-only mode. */
export function getDatabasePool(connectionString = process.env.DATABASE_URL): Pool | undefined {
  if (!connectionString) return undefined;
  const key = poolKey(connectionString);
  const existing = pools.get(key);
  if (existing) return existing;
  const pool = new Pool(sharedConfig(connectionString));
  pool.on("error", (error) => {
    // Do not crash the process from an idle-client error. The next query will
    // receive the actual connection failure and the health endpoint can report
    // it with the same process-wide pool identity.
    console.error("database_pool_idle_client_error", error instanceof Error ? error.message : String(error));
  });
  pools.set(key, pool);
  return pool;
}

export function databasePoolStats() {
  return [...pools.entries()].map(([connectionString, pool]) => ({
    connectionHash: Buffer.from(connectionString).toString("base64url").slice(0, 16),
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount
  }));
}

/** Test and process shutdown hook. Business modules must not call this. */
export async function closeDatabasePools() {
  const closing = [...pools.values()].map((pool) => pool.end());
  pools.clear();
  await Promise.all(closing);
}
