/**
 * Experience Feedback Loop
 *
 * Failure → 原因分析 → 修复方案 → 验证结果 → 写入 Experience Memory → 下一次测试调用
 */

import type {
  FeedbackLoopSession,
  FeedbackStage,
  FailureDetection,
  RootCauseAnalysis,
  RepairProposal,
  FeedbackRepairValidation,
  ExperienceMemoryEntry
} from "@ai-test-officer/contracts";
import { getMemoryService } from "../memory/index.js";
import { randomUUID } from "node:crypto";

// ─── Repair experience recall ────────────────────────────────────

/** Compact, presentation-ready projection of a validated experience entry. */
export interface RepairExperienceHint {
  entryId: string;
  failureType: ExperienceMemoryEntry["failureType"];
  rootCauseCategory: string;
  repairStrategy: ExperienceMemoryEntry["repairStrategy"];
  repairDescription: string;
  /** Observed success rate (0–1) across recorded attempts, 0 when untested. */
  successRate: number;
  lastTestedAt?: string;
}

/**
 * Map a `RepairActionType` from the repair-decision chain onto the experience
 * memory's repair-strategy vocabulary, so a decision can be looked up against
 * what previously worked.
 */
export function repairTypeToMemoryStrategy(
  type: string
): ExperienceMemoryEntry["repairStrategy"] {
  switch (type) {
    case "update_selector":
    case "selector_drift":
      return "selector_fix";
    case "provide_credential":
    case "credential_required":
      return "auth_fix";
    case "fix_environment":
    case "runtime_unavailable":
      return "config_change";
    case "modify_code":
    case "product_bug":
      return "code_patch";
    // `discovery_incomplete`, `evidence_missing` and `manual_review` carry no
    // repeatable repair recipe, so they stay "other" instead of polluting the
    // strategy success statistics.
    default:
      return "other";
  }
}

// ─── Session Store ───────────────────────────────────────────────

interface FeedbackStore {
  sessions: Map<string, FeedbackLoopSession>;
  activeSessionIds: Set<string>;
}

function createStore(): FeedbackStore {
  return {
    sessions: new Map(),
    activeSessionIds: new Set()
  };
}

// ─── Feedback Loop ───────────────────────────────────────────────

export class FeedbackLoop {
  private store: FeedbackStore;

  constructor(store?: FeedbackStore) {
    this.store = store ?? createStore();
  }

  // ─── Step 1: Detect Failure ──────────────────────────────────

  startSession(projectId: string, detection?: Partial<FailureDetection>): FeedbackLoopSession {
    const sessionId = `fbl_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    const session: FeedbackLoopSession = {
      sessionId,
      projectId,
      stage: detection ? "failure_detected" : "failure_detected",
      detection: detection
        ? {
            detectionId: `det_${randomUUID().slice(0, 8)}`,
            runId: detection.runId ?? "unknown",
            failureType: detection.failureType ?? "other",
            title: detection.title ?? "Untitled Failure",
            description: detection.description ?? "",
            severity: detection.severity ?? "major",
            detectedAt: now,
            artifactRefs: detection.artifactRefs ?? [],
            traceId: detection.traceId
          }
        : undefined,
      closed: false,
      createdAt: now,
      updatedAt: now
    };

    this.store.sessions.set(sessionId, session);
    this.store.activeSessionIds.add(sessionId);
    return session;
  }

  // ─── Step 2: Root Cause Analysis ─────────────────────────────

  analyze(
    sessionId: string,
    analysis: Omit<RootCauseAnalysis, "analysisId" | "detectionId" | "analyzedAt">
  ): FeedbackLoopSession {
    const session = this.mustGetSession(sessionId);
    const now = new Date().toISOString();

    const fullAnalysis: RootCauseAnalysis = {
      ...analysis,
      analysisId: `rca_${randomUUID().slice(0, 8)}`,
      detectionId: session.detection?.detectionId ?? "unknown",
      analyzedAt: now
    };

    const updated: FeedbackLoopSession = {
      ...session,
      stage: "root_cause_analyzed",
      analysis: fullAnalysis,
      updatedAt: now
    };

    this.store.sessions.set(sessionId, updated);
    return updated;
  }

  // ─── Step 3: Propose Repair ──────────────────────────────────

  propose(
    sessionId: string,
    proposal: Omit<RepairProposal, "proposalId" | "analysisId" | "proposedAt">
  ): FeedbackLoopSession {
    const session = this.mustGetSession(sessionId);
    if (!session.analysis) {
      throw new Error("Must complete root cause analysis before proposing repair");
    }
    const now = new Date().toISOString();

    const fullProposal: RepairProposal = {
      ...proposal,
      proposalId: `rp_${randomUUID().slice(0, 8)}`,
      analysisId: session.analysis.analysisId,
      proposedAt: now
    };

    const updated: FeedbackLoopSession = {
      ...session,
      stage: "repair_proposed",
      proposal: fullProposal,
      updatedAt: now
    };

    this.store.sessions.set(sessionId, updated);
    return updated;
  }

  // ─── Step 4: Validate ────────────────────────────────────────

  validate(
    sessionId: string,
    validation: Omit<FeedbackRepairValidation, "validationId" | "proposalId" | "validatedAt">
  ): FeedbackLoopSession {
    const session = this.mustGetSession(sessionId);
    if (!session.proposal) {
      throw new Error("Must propose repair before validating");
    }
    const now = new Date().toISOString();

    const fullValidation: FeedbackRepairValidation = {
      ...validation,
      validationId: `val_${randomUUID().slice(0, 8)}`,
      proposalId: session.proposal.proposalId,
      validatedAt: now
    };

    const updated: FeedbackLoopSession = {
      ...session,
      stage: "repair_validated",
      validation: fullValidation,
      updatedAt: now
    };

    this.store.sessions.set(sessionId, updated);
    return updated;
  }

  // ─── Step 5: Write to Experience Memory ─────────────────────

  async commitToMemory(sessionId: string): Promise<{ session: FeedbackLoopSession; memoryEntry: ExperienceMemoryEntry }> {
    const session = this.mustGetSession(sessionId);

    if (!session.analysis || !session.proposal || !session.validation) {
      throw new Error("Incomplete feedback loop: missing analysis, proposal, or validation");
    }

    const now = new Date().toISOString();
    const memory = getMemoryService();

    const wasSuccessful = session.validation.result === "passed";
    const successCount = wasSuccessful ? 1 : 0;
    const failureCount = wasSuccessful ? 0 : 1;

    const entry: ExperienceMemoryEntry = {
      schemaVersion: "1.0",
      entryId: `exp_${randomUUID().slice(0, 12)}`,
      projectId: session.projectId,
      runId: session.detection?.runId ?? "unknown",
      failureType: session.detection?.failureType ?? "other",
      rootCauseCategory: session.analysis.rootCauseCategory,
      rootCauseDescription: session.analysis.rootCauseDescription,
      contributingFactors: session.analysis.contributingFactors.map((factor) => factor.factor),
      repairStrategy: session.proposal.strategy,
      repairDescription: session.proposal.description,
      successCount,
      failureCount,
      validationResult: session.validation.result,
      validationRunId: session.validation.validationRunId,
      tags: [session.analysis.rootCauseCategory, session.proposal.strategy],
      severity: session.detection?.severity ?? "major",
      createdAt: now,
      updatedAt: now,
      lastTestedAt: now,
      validatedAt: now
    };

    await memory.upsertExperienceEntry(entry);

    const updated: FeedbackLoopSession = {
      ...session,
      stage: "memory_written",
      closed: true,
      closedAt: now,
      memoryEntryId: entry.entryId,
      totalDurationMs: new Date(now).getTime() - new Date(session.createdAt).getTime(),
      updatedAt: now
    };

    this.store.sessions.set(sessionId, updated);
    this.store.activeSessionIds.delete(sessionId);

    return { session: updated, memoryEntry: entry };
  }

  // ─── 全链路便捷方法 ───────────────────────────────────────

  async runFullLoop(
    projectId: string,
    detection: Partial<FailureDetection>,
    analysis: Omit<RootCauseAnalysis, "analysisId" | "detectionId" | "analyzedAt">,
    proposal: Omit<RepairProposal, "proposalId" | "analysisId" | "proposedAt">,
    validation: Omit<FeedbackRepairValidation, "validationId" | "proposalId" | "validatedAt">
  ): Promise<{ session: FeedbackLoopSession; memoryEntry: ExperienceMemoryEntry }> {
    let session = this.startSession(projectId, detection);
    session = this.analyze(session.sessionId, analysis);
    session = this.propose(session.sessionId, proposal);
    session = this.validate(session.sessionId, validation);
    return this.commitToMemory(session.sessionId);
  }

  // ─── Query ──────────────────────────────────────────────────

  getSession(sessionId: string): FeedbackLoopSession | undefined {
    return this.store.sessions.get(sessionId);
  }

  getActiveSessions(): FeedbackLoopSession[] {
    return Array.from(this.store.activeSessionIds)
      .map((id) => this.store.sessions.get(id))
      .filter(Boolean) as FeedbackLoopSession[];
  }

  getProjectSessions(projectId: string): FeedbackLoopSession[] {
    return Array.from(this.store.sessions.values())
      .filter((s) => s.projectId === projectId);
  }

  // ─── Step 0: Recall before the next test ────────────────────

  /**
   * Recall validated repair experience for a project before Discovery runs.
   *
   * The loop is only closed when the memory written at step 5 is read back at
   * step 0. Without this, every run rediscovers the same blocker (a login wall,
   * a stale selector) and asks the user the same question again.
   *
   * Only validated entries are returned, and each carries its observed success
   * rate so callers can present it as prior experience rather than as fact.
   */
  async queryRepairExperience(input: {
    projectId: string;
    repairStrategy?: ExperienceMemoryEntry["repairStrategy"][];
    failureType?: ExperienceMemoryEntry["failureType"][];
    semanticQuery?: string;
    limit?: number;
  }): Promise<RepairExperienceHint[]> {
    const memory = getMemoryService();
    const entries = await memory.queryExperienceEntries({
      projectId: input.projectId,
      repairStrategy: input.repairStrategy,
      failureType: input.failureType,
      validationResult: ["passed", "partial"],
      semanticQuery: input.semanticQuery,
      semanticLimit: 10,
      semanticThreshold: 0.6,
      includeUnvalidated: false,
      limit: input.limit ?? 5,
      offset: 0
    });
    return entries
      .map((entry) => {
        const attempts = entry.successCount + entry.failureCount;
        return {
          entryId: entry.entryId,
          failureType: entry.failureType,
          rootCauseCategory: entry.rootCauseCategory,
          repairStrategy: entry.repairStrategy,
          repairDescription: entry.repairDescription,
          successRate: attempts > 0 ? entry.successCount / attempts : 0,
          lastTestedAt: entry.lastTestedAt
        };
      })
      .sort((left, right) => right.successRate - left.successRate);
  }

  getStageCounts(projectId?: string): Record<FeedbackStage, number> {
    const sessions = projectId
      ? this.getProjectSessions(projectId)
      : Array.from(this.store.sessions.values());

    const counts: Record<FeedbackStage, number> = {
      failure_detected: 0,
      root_cause_analyzing: 0,
      root_cause_analyzed: 0,
      repair_proposed: 0,
      repair_validating: 0,
      repair_validated: 0,
      memory_written: 0,
      feedback_closed: 0
    };

    for (const session of sessions) {
      counts[session.stage] = (counts[session.stage] ?? 0) + 1;
    }

    return counts;
  }

  // ─── Private ────────────────────────────────────────────────

  private mustGetSession(sessionId: string): FeedbackLoopSession {
    const session = this.store.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Feedback loop session ${sessionId} not found`);
    }
    return session;
  }
}

let instance: FeedbackLoop | null = null;

export function getFeedbackLoop(): FeedbackLoop {
  if (!instance) {
    instance = new FeedbackLoop();
  }
  return instance;
}

/**
 * Module-level recall helper for callers that only need prior experience and
 * should not own a feedback-loop session (Discovery, repair decision ranking).
 * Never throws: missing memory must not block a scan.
 */
export async function queryRepairExperience(input: {
  projectId: string;
  repairStrategy?: ExperienceMemoryEntry["repairStrategy"][];
  failureType?: ExperienceMemoryEntry["failureType"][];
  semanticQuery?: string;
  limit?: number;
}): Promise<RepairExperienceHint[]> {
  try {
    return await getFeedbackLoop().queryRepairExperience(input);
  } catch {
    return [];
  }
}
