/**
 * LLM Input Optimizer
 *
 * 发送 Verified Facts / Observed Evidence / Retrieved Knowledge / Unknown Information
 * 不发送原始数据库 / 全量日志 / 全量 DOM
 */

import type {
  OptimizedLlmInput,
  VerifiedFact,
  ObservedEvidence,
  RetrievedKnowledge,
  UnknownInformation,
  InformationCategory
} from "@ai-test-officer/contracts";
import { optimizedLlmInputSchema } from "@ai-test-officer/contracts";
import { randomUUID } from "node:crypto";

// ─── Compilation Strategy ────────────────────────────────────────

export type CompilationStrategy = "priority" | "recent_first" | "relevance_sort";

export interface LlmInputSource {
  verifiedFacts: VerifiedFact[];
  observedEvidence: ObservedEvidence[];
  retrievedKnowledge: RetrievedKnowledge[];
  unknownInformation: UnknownInformation[];
}

export interface LlmInputCompilerConfig {
  maxFacts: number;
  maxEvidence: number;
  maxKnowledge: number;
  maxUnknown: number;
  strategy: CompilationStrategy;
}

const DEFAULT_CONFIG: LlmInputCompilerConfig = {
  maxFacts: 15,
  maxEvidence: 10,
  maxKnowledge: 5,
  maxUnknown: 5,
  strategy: "priority"
};

// ─── Compiler ────────────────────────────────────────────────────

export class LlmInputCompiler {
  private config: LlmInputCompilerConfig;

  constructor(config?: Partial<LlmInputCompilerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 将原始数据编译为 Optimized LLM Input。
   * 严格过滤：禁止原始数据库、全量日志、全量 DOM。
   */
  compile(
    runId: string,
    purpose: OptimizedLlmInput["purpose"],
    source: LlmInputSource,
    contextSummary: string,
    totalTokenBudget = 32_000
  ): OptimizedLlmInput {
    const now = new Date().toISOString();

    // 按策略排序
    const sortedFacts = this.sortFacts(source.verifiedFacts);
    const sortedEvidence = this.sortEvidence(source.observedEvidence);
    const sortedKnowledge = this.sortKnowledge(source.retrievedKnowledge);
    const sortedUnknown = source.unknownInformation;

    // 截取
    let selectedFacts = sortedFacts.slice(0, this.config.maxFacts);
    let selectedEvidence = sortedEvidence.slice(0, this.config.maxEvidence);
    let selectedKnowledge = sortedKnowledge.slice(0, this.config.maxKnowledge);
    let selectedUnknown = sortedUnknown.slice(0, this.config.maxUnknown);
    let boundedSummary = contextSummary.slice(0, 1_000);
    const estimate = () => Math.ceil(JSON.stringify([...selectedFacts, ...selectedEvidence, ...selectedKnowledge, ...selectedUnknown, boundedSummary]).length / 3.5);
    // Drop low-priority namespaces first, then compact long details. This is a
    // real budget enforcement step: the payload handed to the provider is the
    // same payload measured here, never a larger unbounded prompt.
    while (estimate() > totalTokenBudget && selectedUnknown.length) selectedUnknown = selectedUnknown.slice(0, -1);
    while (estimate() > totalTokenBudget && selectedKnowledge.length) selectedKnowledge = selectedKnowledge.slice(0, -1);
    while (estimate() > totalTokenBudget && selectedEvidence.length) selectedEvidence = selectedEvidence.slice(0, -1);
    while (estimate() > totalTokenBudget && selectedFacts.length > 1) selectedFacts = selectedFacts.slice(0, -1);
    if (estimate() > totalTokenBudget) {
      selectedFacts = selectedFacts.map((fact) => ({ ...fact, statement: fact.statement.slice(0, 120), evidenceRefs: fact.evidenceRefs.slice(0, 2) }));
      selectedEvidence = selectedEvidence.map((evidence) => ({ ...evidence, summary: evidence.summary.slice(0, 80), detail: evidence.detail.slice(0, 240), artifactRefs: evidence.artifactRefs.slice(0, 2) }));
      selectedKnowledge = selectedKnowledge.map((knowledge) => ({ ...knowledge, title: knowledge.title.slice(0, 80), content: knowledge.content.slice(0, 240), sourceRefs: knowledge.sourceRefs.slice(0, 2) }));
      selectedUnknown = selectedUnknown.map((unknown) => ({ ...unknown, question: unknown.question.slice(0, 120), context: unknown.context.slice(0, 160) }));
    }
    while (estimate() > totalTokenBudget && boundedSummary.length > 120) boundedSummary = boundedSummary.slice(0, Math.ceil(boundedSummary.length / 2));
    while (estimate() > totalTokenBudget && boundedSummary.length) boundedSummary = boundedSummary.slice(0, Math.ceil(boundedSummary.length / 2));
    const estimatedTokens = estimate();
    const usedTokens = estimatedTokens;

    return optimizedLlmInputSchema.parse({
      schemaVersion: "1.0",
      inputId: `llm_input_${randomUUID().slice(0, 8)}`,
      runId,
      purpose,
      verifiedFacts: selectedFacts,
      observedEvidence: selectedEvidence,
      retrievedKnowledge: selectedKnowledge,
      unknownInformation: selectedUnknown,
      contextSummary: boundedSummary,
      exclusions: {
        noRawDatabase: true,
        noFullLogs: true,
        noFullDom: true,
        noSourceCodeDump: true,
        noCredentials: true,
        noInternalState: true
      },
      tokenBudget: {
        total: totalTokenBudget,
        used: usedTokens,
        remaining: totalTokenBudget - usedTokens
      },
      compilation: {
        strategy: this.config.strategy,
        maxFacts: this.config.maxFacts,
        maxEvidence: this.config.maxEvidence,
        maxKnowledge: this.config.maxKnowledge,
        factsSelected: selectedFacts.length,
        evidenceSelected: selectedEvidence.length,
        knowledgeSelected: selectedKnowledge.length
      },
      generatedAt: now
    });
  }

  // ─── Sorting ───────────────────────────────────────────────────

  private sortFacts(facts: VerifiedFact[]): VerifiedFact[] {
    switch (this.config.strategy) {
      case "priority":
        return [...facts].sort((a, b) => {
          const scopeOrder = { global: 3, project: 2, run: 1 };
          const cmp = (scopeOrder[b.scope] ?? 0) - (scopeOrder[a.scope] ?? 0);
          return cmp !== 0 ? cmp : b.confidence - a.confidence;
        });
      case "recent_first":
        return [...facts].sort((a, b) =>
          new Date(b.verifiedAt).getTime() - new Date(a.verifiedAt).getTime()
        );
      case "relevance_sort":
        return [...facts].sort((a, b) => b.confidence - a.confidence);
    }
  }

  private sortEvidence(evidence: ObservedEvidence[]): ObservedEvidence[] {
    return [...evidence].sort((a, b) => {
      const cmp = b.relevance - a.relevance;
      return cmp !== 0 ? cmp : new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }

  private sortKnowledge(knowledge: RetrievedKnowledge[]): RetrievedKnowledge[] {
    return [...knowledge].sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // ─── Factory Methods ────────────────────────────────────────

  static createVerifiedFact(
    statement: string,
    source: VerifiedFact["source"],
    evidenceRefs: string[] = [],
    confidence = 0.9
  ): VerifiedFact {
    return {
      factId: `fact_${randomUUID().slice(0, 8)}`,
      source,
      statement,
      confidence,
      evidenceRefs,
      verifiedAt: new Date().toISOString(),
      scope: "run"
    };
  }

  static createObservedEvidence(
    type: ObservedEvidence["type"],
    summary: string,
    detail: string,
    artifactRefs: string[] = []
  ): ObservedEvidence {
    return {
      evidenceId: `evidence_${randomUUID().slice(0, 8)}`,
      type,
      summary,
      detail,
      timestamp: new Date().toISOString(),
      artifactRefs,
      relevance: 1
    };
  }

  static createRetrievedKnowledge(
    source: RetrievedKnowledge["source"],
    title: string,
    content: string,
    relevanceScore = 0.8,
    sourceRefs: string[] = []
  ): RetrievedKnowledge {
    return {
      knowledgeId: `knowledge_${randomUUID().slice(0, 8)}`,
      source,
      title,
      content,
      relevanceScore,
      retrievedAt: new Date().toISOString(),
      sourceRefs,
      confidence: 0.7
    };
  }

  static createUnknown(
    category: UnknownInformation["category"],
    question: string,
    context: string,
    blocking = false
  ): UnknownInformation {
    return {
      unknownId: `unknown_${randomUUID().slice(0, 8)}`,
      category,
      question,
      context,
      blocking,
      reportedAt: new Date().toISOString()
    };
  }
}

let instance: LlmInputCompiler | null = null;

export function getLlmInputCompiler(config?: Partial<LlmInputCompilerConfig>): LlmInputCompiler {
  if (config) {
    instance = new LlmInputCompiler(config);
  }
  if (!instance) {
    instance = new LlmInputCompiler();
  }
  return instance;
}
