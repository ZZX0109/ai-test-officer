/**
 * Small, contract-first memory service.
 *
 * The production adapter can persist these records in PostgreSQL. Keeping the
 * service behind this interface means the planner, diagnosis and repair loops
 * do not need to know where memory is stored.
 */
import type {
  ProjectMemoryEntry,
  ProjectMemoryQuery,
  ExperienceMemoryEntry,
  ExperienceMemoryQuery,
  MemoryStatistics
} from "@ai-test-officer/contracts";
import { createHash } from "node:crypto";

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

  constructor(store?: MemoryStore) {
    this.store = store ?? createStore();
  }

  async upsertProjectEntry(entry: ProjectMemoryEntry): Promise<void> {
    this.store.projectEntries.set(entry.entryId, { ...entry });
  }

  async getProjectEntry(entryId: string): Promise<ProjectMemoryEntry | undefined> {
    return this.store.projectEntries.get(entryId);
  }

  async queryProjectEntries(query: ProjectMemoryQuery): Promise<ProjectMemoryEntry[]> {
    let entries = [...this.store.projectEntries.values()]
      .filter((entry) => entry.projectId === query.projectId);
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
    const normalized: ExperienceMemoryEntry = {
      ...entry,
      embeddingText,
      embeddingVector: entry.embeddingVector?.length ? entry.embeddingVector : textToEmbedding(embeddingText)
    };
    this.store.experienceEntries.set(normalized.entryId, normalized);
  }

  async getExperienceEntry(entryId: string): Promise<ExperienceMemoryEntry | undefined> {
    return this.store.experienceEntries.get(entryId);
  }

  async queryExperienceEntries(query: ExperienceMemoryQuery): Promise<ExperienceMemoryEntry[]> {
    let entries = [...this.store.experienceEntries.values()];
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
    const entries = [...this.store.experienceEntries.values()].filter((entry) => entry.projectId === projectId);
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
}

let instance: MemoryService | undefined;
export function getMemoryService(): MemoryService {
  instance ??= new MemoryService();
  return instance;
}
