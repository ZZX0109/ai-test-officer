export interface MemoryRetrievalResult {
  entryId: string;
  /** A result is traceable only when it carries a durable source reference. */
  sourceRefs: string[];
}

export interface MemoryRetrievalEvalCase {
  queryId: string;
  relevantEntryIds: string[];
  rankedResults: MemoryRetrievalResult[];
}

export interface MemoryRetrievalEvaluation {
  queryCount: number;
  recallAt5: number;
  recallAt10: number;
  meanReciprocalRank: number;
  falseRecallRateAt10: number;
  sourceTraceabilityRate: number;
}

function recallAt(results: MemoryRetrievalResult[], relevant: Set<string>, limit: number) {
  if (relevant.size === 0) return 0;
  const hits = results.slice(0, limit).filter((result) => relevant.has(result.entryId)).length;
  return hits / relevant.size;
}

/**
 * Offline retrieval evaluation. It accepts ranked IDs instead of reaching
 * into a provider so the same metrics work for a real embedding service, the
 * deterministic compatibility mode, or a sealed replay fixture.
 */
export function evaluateMemoryRetrieval(cases: MemoryRetrievalEvalCase[]): MemoryRetrievalEvaluation {
  if (cases.length === 0) {
    return { queryCount: 0, recallAt5: 0, recallAt10: 0, meanReciprocalRank: 0, falseRecallRateAt10: 0, sourceTraceabilityRate: 0 };
  }
  let recall5 = 0;
  let recall10 = 0;
  let mrr = 0;
  let falseRecall = 0;
  let returned = 0;
  let traceable = 0;
  for (const testCase of cases) {
    const relevant = new Set(testCase.relevantEntryIds);
    const top10 = testCase.rankedResults.slice(0, 10);
    recall5 += recallAt(testCase.rankedResults, relevant, 5);
    recall10 += recallAt(testCase.rankedResults, relevant, 10);
    const firstRelevant = testCase.rankedResults.findIndex((result) => relevant.has(result.entryId));
    if (firstRelevant >= 0) mrr += 1 / (firstRelevant + 1);
    falseRecall += top10.filter((result) => !relevant.has(result.entryId)).length;
    returned += top10.length;
    traceable += testCase.rankedResults.filter((result) => result.sourceRefs.length > 0).length;
  }
  const allResults = cases.reduce((sum, testCase) => sum + testCase.rankedResults.length, 0);
  return {
    queryCount: cases.length,
    recallAt5: recall5 / cases.length,
    recallAt10: recall10 / cases.length,
    meanReciprocalRank: mrr / cases.length,
    falseRecallRateAt10: returned ? falseRecall / returned : 0,
    sourceTraceabilityRate: allResults ? traceable / allResults : 0
  };
}
