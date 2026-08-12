/**
 * Small, contract-first memory service.
 *
 * The production adapter can persist these records in PostgreSQL. Keeping the
 * service behind this interface means the planner, diagnosis and repair loops
 * do not need to know where memory is stored.
 */
import {
  experienceMemoryEntrySchema,
  projectMemoryEntrySchema,
  type ProjectMemoryEntry,
  type ProjectMemoryQuery,
  type ExperienceMemoryEntry,
  type ExperienceMemoryQuery,
  type MemoryStatistics
} from "@ai-test-officer/contracts";
import { createHash } from "node:crypto";
import { Pool } from "pg";

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function textToEmbedding(text: string, dims = 64): number[] {
  const hash = createHash("sha256").update(text).digest();
  return Array.from({ length: dims }, (_, index) => (hash[index % hash.length] - 128) / 128);
}

interface MemoryStore {
  projectEntries: Map<string, ProjectMemoryEntry>;
  experienceEntries: Map<string, ExperienceMemoryEntry>;
}

function createStore(): MemoryStore {
  return { projectEntries: new Map(), experienceEntries: new Map() };
}

export class MemoryService {
  private readonly store: MemoryStore;
  private readonly pool?: Pool;

  constructor(store?: MemoryStore, connectionString = process.env.DATABASE_URL) {
    this.store = store ?? createStore();
    this.pool = !store && connectionString ? new Pool({ connectionString, max: 2 }) : undefined;
  }

  async upsertProjectEntry(entry: ProjectMemoryEntry): Promise<void> {
    const parsed = projectMemoryEntrySchema.parse(entry);
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO project_memory_entries_v1
          (entry_id,project_id,category,memory_key,verified,payload,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (entry_id) DO UPDATE SET
           project_id=EXCLUDED.project_id,category=EXCLUDED.category,
           memory_key=EXCLUDED.memory_key,verified=EXCLUDED.verified,
           payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,
        [parsed.entryId, parsed.projectId, parsed.category, parsed.key, parsed.verified, parsed, parsed.updatedAt]
      );
      return;
    }
    this.store.projectEntries.set(parsed.entryId, { ...parsed });
  }

  async getProjectEntry(entryId: string): Promise<ProjectMemoryEntry | undefined> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM project_memory_entries_v1 WHERE entry_id=$1", [entryId]);
      return result.rows[0] ? projectMemoryEntrySchema.parse(result.rows[0].payload) : undefined;
    }
    return this.store.projectEntries.get(entryId);
  }

  async queryProjectEntries(query: ProjectMemoryQuery): Promise<ProjectMemoryEntry[]> {
    let entries = this.pool
      ? (await this.pool.query<{ payload: unknown }>("SELECT payload FROM project_memory_entries_v1 WHERE project_id=$1 ORDER BY updated_at DESC", [query.projectId])).rows.map((row) => projectMemoryEntrySchema.parse(row.payload))
      : [...this.store.projectEntries.values()].filter((entry) => entry.projectId === query.projectId);
    if (query.category) entries = entries.filter((entry) => entry.category === query.category);
    if (query.keys?.length) entries = entries.filter((entry) => query.keys!.includes(entry.key));
    if (!query.includeUnverified) entries = entries.filter((entry) => entry.verified);
    return entries.slice(0, query.limit);
  }

  async upsertExperienceEntry(entry: ExperienceMemoryEntry): Promise<void> {
    const embeddingText = entry.embeddingText ?? [
      entry.failureType,
      entry.rootCauseCategory,
      entry.rootCauseDescription,
      entry.repairDescription
    ].join(" ");
    const normalized = experienceMemoryEntrySchema.parse({
      ...entry,
      embeddingText,
      embeddingVector: entry.embeddingVector?.length ? entry.embeddingVector : textToEmbedding(embeddingText)
    });
    if (this.pool) {
      await this.pool.query(
        `INSERT INTO experience_memory_entries_v1
          (entry_id,project_id,failure_type,repair_strategy,validation_result,payload,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (entry_id) DO UPDATE SET
           project_id=EXCLUDED.project_id,failure_type=EXCLUDED.failure_type,
           repair_strategy=EXCLUDED.repair_strategy,validation_result=EXCLUDED.validation_result,
           payload=EXCLUDED.payload,updated_at=EXCLUDED.updated_at`,
        [normalized.entryId, normalized.projectId, normalized.failureType, normalized.repairStrategy, normalized.validationResult, normalized, normalized.updatedAt]
      );
      return;
    }
    this.store.experienceEntries.set(normalized.entryId, normalized);
  }

  async getExperienceEntry(entryId: string): Promise<ExperienceMemoryEntry | undefined> {
    if (this.pool) {
      const result = await this.pool.query<{ payload: unknown }>("SELECT payload FROM experience_memory_entries_v1 WHERE entry_id=$1", [entryId]);
      return result.rows[0] ? experienceMemoryEntrySchema.parse(result.rows[0].payload) : undefined;
    }
    return this.store.experienceEntries.get(entryId);
  }

  async queryExperienceEntries(query: ExperienceMemoryQuery): Promise<ExperienceMemoryEntry[]> {
    let entries = this.pool
      ? (await this.pool.query<{ payload: unknown }>(
          "SELECT payload FROM experience_memory_entries_v1 WHERE ($1::text IS NULL OR project_id=$1) ORDER BY updated_at DESC",
          [query.projectId ?? null]
        )).rows.map((row) => experienceMemoryEntrySchema.parse(row.payload))
      : [...this.store.experienceEntries.values()];
    if (query.projectId) entries = entries.filter((entry) => entry.projectId === query.projectId);
    if (query.failureType?.length) entries = entries.filter((entry) => query.failureType!.includes(entry.failureType));
    if (query.rootCauseCategory?.length) entries = entries.filter((entry) => query.rootCauseCategory!.includes(entry.rootCauseCategory));
    if (query.repairStrategy?.length) entries = entries.filter((entry) => query.repairStrategy!.includes(entry.repairStrategy));
    if (query.validationResult?.length) entries = entries.filter((entry) => query.validationResult!.includes(entry.validationResult));
    if (query.tags?.length) entries = entries.filter((entry) => query.tags!.some((tag) => entry.tags.includes(tag)));
    if (query.severity?.length) entries = entries.filter((entry) => query.severity!.includes(entry.severity));
    if (!query.includeUnvalidated) entries = entries.filter((entry) => entry.validationResult !== "pending");

    if (query.semanticQuery) {
      const vector = textToEmbedding(query.semanticQuery);
      entries = entries
        .map((entry) => ({ entry, score: cosineSimilarity(vector, entry.embeddingVector ?? []) }))
        .filter((item) => item.score >= query.semanticThreshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, query.semanticLimit)
        .map((item) => item.entry);
    }
    return entries.slice(query.offset, query.offset + query.limit);
  }

  async searchByEmbedding(queryText: string, projectId?: string, limit = 5, threshold = 0.3): Promise<ExperienceMemoryEntry[]> {
    return this.queryExperienceEntries({
      projectId,
      semanticQuery: queryText,
      semanticLimit: limit,
      semanticThreshold: threshold,
      includeUnvalidated: false,
      limit,
      offset: 0
    });
  }

  async getStatistics(projectId: string): Promise<MemoryStatistics> {
    const entries = await this.queryExperienceEntries({
      projectId,
      includeUnvalidated: true,
      limit: 100_000,
      offset: 0,
      semanticLimit: 10,
      semanticThreshold: 0
    });
    const byFailureType: Record<string, number> = {};
    const byRepairStrategy: Record<string, number> = {};
    const strategyTotals = new Map<string, { success: number; total: number }>();
    let success = 0;
    let total = 0;
    for (const entry of entries) {
      byFailureType[entry.failureType] = (byFailureType[entry.failureType] ?? 0) + 1;
      byRepairStrategy[entry.repairStrategy] = (byRepairStrategy[entry.repairStrategy] ?? 0) + 1;
      const count = entry.successCount + entry.failureCount;
      success += entry.successCount;
      total += count;
      const current = strategyTotals.get(entry.repairStrategy) ?? { success: 0, total: 0 };
      current.success += entry.successCount;
      current.total += count;
      strategyTotals.set(entry.repairStrategy, current);
    }
    const strategySuccessRates: Record<string, number> = {};
    for (const [strategy, stats] of strategyTotals) strategySuccessRates[strategy] = stats.total ? stats.success / stats.total : 0;
    const mostEffectiveStrategies = [...strategyTotals.entries()]
      .map(([strategy, stats]) => ({ strategy, successRate: stats.total ? stats.success / stats.total : 0, sampleSize: stats.total }))
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10);
    return {
      schemaVersion: "1.0",
      projectId,
      totalEntries: entries.length,
      byFailureType,
      byRepairStrategy,
      overallSuccessRate: total ? success / total : 0,
      strategySuccessRates,
      mostEffectiveStrategies,
      generatedAt: new Date().toISOString()
    };
  }

  async close(): Promise<void> { await this.pool?.end(); }
}

let instance: MemoryService | undefined;
export function getMemoryService(): MemoryService {
  instance ??= new MemoryService();
  return instance;
}
