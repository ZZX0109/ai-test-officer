import { createHash } from "node:crypto";
import type {
  KnowledgeClaim,
  KnowledgeConflict,
  LlmKnowledgeContext
} from "@ai-test-officer/contracts";
import { listRunKnowledge, persistKnowledgeConflict } from "./store.js";

type LocatedClaim = { contextId: string; claim: KnowledgeClaim };

function comparable(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function precedence(claim: KnowledgeClaim, domain: KnowledgeConflict["domain"]) {
  if (domain === "expected-behavior") {
    if (claim.status === "user-provided") return 600;
    if (claim.domain === "external-documentation" && claim.status === "retrieved") return 500;
    if (claim.status === "retrieved") return 400;
    if (claim.status === "observed") return 300;
    if (claim.status === "inferred") return 100;
    return 0;
  }
  if (claim.domain === "runtime" && claim.status === "observed") return 600;
  if (claim.domain === "runtime" && claim.status === "retrieved") return 500;
  if (claim.domain === "project-static" && claim.status === "retrieved") return 400;
  if (claim.status === "user-provided") return 300;
  if (claim.status === "inferred") return 100;
  return 0;
}

function stableConflictId(contextId: string, claimIds: string[]) {
  const digest = createHash("sha256")
    .update([contextId, ...claimIds.slice().sort()].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `knowledge_conflict_${digest}`;
}

export async function applySupersedingClaims(context: LlmKnowledgeContext) {
  if (!context.runId) return context;
  const previous = (await listRunKnowledge(context.runId)).contexts;
  return {
    ...context,
    claims: context.claims.map((claim) => {
      if (
        claim.supersedesClaimId
        || claim.status !== "user-provided"
        || !claim.subject
      ) return claim;
      const prior = previous
        .slice()
        .reverse()
        .flatMap((item) => item.claims
          .filter((candidate) =>
            candidate.subject === claim.subject
            && candidate.status === "user-provided"
            && comparable(candidate.statement) !== comparable(claim.statement)
          )
          .map((candidate) => ({ contextId: item.id!, claim: candidate })))
        .at(0);
      return prior
        ? { ...claim, supersedesClaimId: `${prior.contextId}:${prior.claim.id}` }
        : claim;
    })
  } satisfies LlmKnowledgeContext;
}

/**
 * Conflicts are only inferred for explicitly named subjects. This prevents
 * unrelated facts in the same domain from being treated as contradictory.
 */
export async function detectAndPersistKnowledgeConflicts(context: LlmKnowledgeContext) {
  const previous: LocatedClaim[] = context.runId
    ? (await listRunKnowledge(context.runId)).contexts.flatMap((item) =>
        item.claims.map((claim) => ({ contextId: item.id!, claim }))
      )
    : [];
  const located: LocatedClaim[] = [
    ...previous,
    ...context.claims.map((claim) => ({ contextId: context.id!, claim }))
  ];
  const bySubject = new Map<string, LocatedClaim[]>();
  for (const item of located) {
    const { claim } = item;
    if (!claim.subject || ["assumed", "unknown"].includes(claim.status)) continue;
    const key = `${claim.domain}:${claim.subject}`;
    const current = bySubject.get(key) ?? [];
    if (!current.some((candidate) =>
      candidate.contextId === item.contextId && candidate.claim.id === claim.id
    )) current.push(item);
    bySubject.set(key, current);
  }

  const conflicts: KnowledgeConflict[] = [];
  for (const locatedClaims of bySubject.values()) {
    if (locatedClaims.length < 2) continue;
    const live = locatedClaims.filter((item) =>
      !locatedClaims.some((candidate) =>
        candidate.claim.supersedesClaimId === item.claim.id
        || candidate.claim.supersedesClaimId === `${item.contextId}:${item.claim.id}`
      )
    );
    if (new Set(live.map(({ claim }) => comparable(claim.statement))).size < 2) continue;
    const domain: KnowledgeConflict["domain"] = live.some(({ claim }) => claim.domain === "user-intent")
      ? "expected-behavior"
      : "actual-state";
    const ranked = live
      .map((item) => ({ ...item, rank: precedence(item.claim, domain) }))
      .sort((left, right) =>
        right.rank - left.rank
        || Date.parse(right.claim.observedAt ?? "") - Date.parse(left.claim.observedAt ?? "")
      );
    const uniqueWinner = ranked.length > 1 && (
      ranked[0].rank > ranked[1].rank
      || (
        ranked[0].claim.status === "observed"
        && Boolean(ranked[0].claim.observedAt)
        && ranked[0].claim.observedAt !== ranked[1].claim.observedAt
      )
    );
    const claimIds = live.map((item) => `${item.contextId}:${item.claim.id}`);
    const id = stableConflictId(context.id!, claimIds);
    conflicts.push(await persistKnowledgeConflict({
      id,
      runId: context.runId,
      contextId: context.id!,
      domain,
      claimIds,
      status: uniqueWinner ? "resolved" : "open",
      resolution: uniqueWinner ? {
        winningClaimId: `${ranked[0].contextId}:${ranked[0].claim.id}`,
        reason: domain === "expected-behavior"
          ? "Resolved using expected-behavior source precedence."
          : "Resolved using actual-state source precedence.",
        resolvedBy: "policy",
        resolvedAt: new Date().toISOString()
      } : undefined
    }));
  }
  return conflicts;
}
