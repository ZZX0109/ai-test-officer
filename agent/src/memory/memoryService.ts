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
import type { Pool } from "pg";
import { getDatabasePool } from "../databaseRuntime.js";

export interface EmbeddingProvider {
  model: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

/** OpenAI-compatible embeddings endpoint; configured explicitly, never guessed. */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly endpoint: string, private readonly apiKey: string, public readonly model: string) {}
  async embed(text: string, signal?: AbortSignal) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: text }),
      signal: signal ?? AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`embedding_provider_http_${response.status}`);
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== "number")) throw new Error("embedding_provider_invalid_response");
    return vector;
  }
}

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

function keywordTokens(text: string) {
  return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1));
}

function keywordSimilarity(query: string, candidate: string) {
  const left = keywordTokens(query);
  const right = keywordTokens(candidate);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
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
  private readonly embeddingProvider?: EmbeddingProvider;
  private embeddingProviderDegraded = false;

  constructor(store?: MemoryStore, connectionString = process.env.DATABASE_URL, embeddingProvider?: EmbeddingProvider) {
    this.store = store ?? createStore();
    this.pool = !store ? getDatabasePool(connectionString) : undefined;
    this.embeddingProvider = embeddingProvider ?? (() => {
      const endpoint = process.env.MEMORY_EMBEDDING_URL;
      const apiKey = process.env.MEMORY_EMBEDDING_API_KEY;
      const model = process.env.MEMORY_EMBEDDING_MODEL;
      return endpoint && apiKey && model ? new HttpEmbeddingProvider(endpoint, apiKey, model) : undefined;
    })();
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
    let embeddingVector = entry.embeddingVector;
    let embeddingModel = entry.embeddingModel;
    if (!embeddingVector?.length && this.embeddingProvider) {
      try {
        embeddingVector = await this.embeddingProvider.embed(embeddingText);
        embeddingModel = this.embeddingProvider.model;
        this.embeddingProviderDegraded = false;
      } catch {
        // Retrieval remains keyword-only and explicitly reports that fact.
        embeddingVector = undefined;
        embeddingModel = undefined;
        this.embeddingProviderDegraded = true;
      }
    }
    const normalized = experienceMemoryEntrySchema.parse({
      ...entry,
      embeddingText,
      embeddingVector,
      embeddingModel
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
    if (query.businessDomain) entries = entries.filter((entry) => entry.businessDomain === query.businessDomain);
    if (query.projectVersion) entries = entries.filter((entry) => entry.projectVersion === query.projectVersion);
    if (!query.includeUnvalidated) entries = entries.filter((entry) => entry.validationResult !== "pending");

    if (query.semanticQuery) {
      let queryVector: number[] | undefined;
      if (this.embeddingProvider) {
        try {
          queryVector = await this.embeddingProvider.embed(query.semanticQuery);
          this.embeddingProviderDegraded = false;
        } catch {
          queryVector = undefined;
          this.embeddingProviderDegraded = true;
        }
      }
      entries = entries
        .map((entry) => {
          const lexical = keywordSimilarity(query.semanticQuery!, `${entry.failureType} ${entry.rootCauseCategory} ${entry.rootCauseDescription} ${entry.repairDescription} ${entry.tags.join(" ")}`);
          const semantic = queryVector && entry.embeddingVector ? cosineSimilarity(queryVector, entry.embeddingVector) : 0;
          return { entry, score: queryVector && entry.embeddingVector ? semantic * 0.7 + lexical * 0.3 : lexical, lexical, semantic };
        })
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

  /** Explicitly exposes whether a real provider is active; keyword fallback is never
   * presented as semantic RAG. */
  retrievalDescriptor() {
    return {
      mode: this.embeddingProvider && !this.embeddingProviderDegraded ? "hybrid-embedding-v1" as const : "keyword-v1" as const,
      label: this.embeddingProvider && !this.embeddingProviderDegraded
        ? "Embedding + Keyword Hybrid Retrieval"
        : this.embeddingProvider
          ? "Keyword Retrieval (embedding provider unavailable)"
          : "Keyword Retrieval (embedding provider not configured)",
      semantic: Boolean(this.embeddingProvider && !this.embeddingProviderDegraded),
      evaluationRequired: ["Recall@5", "Recall@10", "MRR", "false-recall-rate", "source-traceability"],
      ...(this.embeddingProvider && !this.embeddingProviderDegraded ? { providerModel: this.embeddingProvider.model } : {})
    } as const;
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
      retrievalMode: this.embeddingProvider && !this.embeddingProviderDegraded ? "hybrid-embedding-v1" : "keyword-v1",
      generatedAt: new Date().toISOString()
    };
  }

  /** The process-wide database runtime owns pool shutdown. */
  async close(): Promise<void> { return Promise.resolve(); }
}

let instance: MemoryService | undefined;
export function getMemoryService(): MemoryService {
  instance ??= new MemoryService();
  return instance;
}
