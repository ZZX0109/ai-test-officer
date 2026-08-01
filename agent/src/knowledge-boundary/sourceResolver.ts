import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  llmKnowledgeContextSchema,
  type KnowledgeClaim,
  type LlmKnowledgeContext
} from "@ai-test-officer/contracts";
import { readRunBundle } from "../evidenceStore.js";
import { getProject } from "../projectAdapter.js";
import { readDiscoveryPageObservation } from "../pageObservationStore.js";
import { listRepairSessions } from "../repairWorkspace.js";
import { runEventStore } from "../runEventStore.js";
import { hasScenario } from "../scenarios.js";
import { buildProjectKnowledgeSnapshot } from "./projectSnapshot.js";
import { assertModelSafePath } from "./redaction.js";

export interface KnowledgeSourceResolution {
  context: LlmKnowledgeContext;
  verifiedClaimIds: string[];
  expiredClaimIds: string[];
  rejected: Array<{ claimId: string; sourceRef?: string; errorCode: string }>;
}

function splitRef(sourceRef: string) {
  const separator = sourceRef.indexOf(":");
  return separator < 0
    ? { kind: "evidence-or-artifact", value: sourceRef }
    : { kind: sourceRef.slice(0, separator), value: sourceRef.slice(separator + 1) };
}

async function loadBundle(runId: string | undefined) {
  if (!runId) return undefined;
  try {
    return await readRunBundle(runId);
  } catch {
    return undefined;
  }
}

function registeredProjectRoot(projectPath: string) {
  const repositoryRoot = path.basename(process.cwd()) === "agent"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
  return path.isAbsolute(projectPath)
    ? path.resolve(projectPath)
    : path.resolve(repositoryRoot, projectPath);
}

async function assertProjectClaimSnapshot(
  claim: KnowledgeClaim,
  context: LlmKnowledgeContext,
  projectId: string
) {
  const actual = await buildProjectKnowledgeSnapshot(projectId);
  const expected = {
    commitSha: claim.scope.commitSha ?? context.projectSnapshot?.commitSha,
    projectDigest: claim.scope.projectDigest ?? context.projectSnapshot?.projectDigest,
    manifestSha256: claim.scope.manifestHash ?? context.projectSnapshot?.manifestSha256,
    lockfileSha256: claim.scope.lockfileHash ?? context.projectSnapshot?.lockfileSha256,
    registrySha256: claim.scope.registryHash ?? context.projectSnapshot?.registrySha256
  };
  for (const key of [
    "commitSha",
    "projectDigest",
    "manifestSha256",
    "lockfileSha256",
    "registrySha256"
  ] as const) {
    if (expected[key] && expected[key] !== actual[key]) {
      throw new Error(`knowledge_project_snapshot_expired:${key}`);
    }
  }
}

async function resolveSource(
  sourceRef: string,
  claim: KnowledgeClaim,
  context: LlmKnowledgeContext
) {
  const { kind, value } = splitRef(sourceRef);
  const runId = claim.scope.runId ?? context.runId;
  const projectId = claim.scope.projectId ?? context.projectSnapshot?.projectId;

  if (claim.scope.runId && context.runId && claim.scope.runId !== context.runId) {
    throw new Error("knowledge_source_cross_run");
  }
  if (
    claim.scope.projectId
    && context.projectSnapshot?.projectId
    && claim.scope.projectId !== context.projectSnapshot.projectId
  ) {
    throw new Error("knowledge_source_cross_project");
  }
  if (runId) {
    const run = await runEventStore.get(runId);
    if (run && (
      projectId
      && run.input.projectId
      && String(run.input.projectId) !== projectId
    )) {
      throw new Error("knowledge_source_cross_project");
    }
    if (run && (
      claim.scope.organizationId
      && run.input.organizationId
      && String(run.input.organizationId) !== claim.scope.organizationId
    )) {
      throw new Error("knowledge_source_cross_organization");
    }
  }

  if (kind === "request" || kind === "user-message" || kind === "credential") {
    if (claim.status !== "user-provided") throw new Error("knowledge_source_status_mismatch");
    if (!value) throw new Error("knowledge_source_missing_identifier");
    return;
  }
  if (kind === "input") {
    if (
      claim.status !== "user-provided"
      && claim.status !== "retrieved"
      && claim.status !== "observed"
      && claim.status !== "inferred"
    ) {
      throw new Error("knowledge_source_status_mismatch");
    }
    if (!value) throw new Error("knowledge_source_missing_identifier");
    return;
  }
  if (kind === "external-doc") {
    if (!/^[^@]+@[a-f0-9]{40,64}$/i.test(value)) throw new Error("knowledge_external_doc_not_locked");
    return;
  }
  if (kind === "project" || kind === "project-manifest" || kind === "project-file") {
    const [referencedProjectIdValue, ...pathParts] = value.split(":");
    const referencedProjectId = referencedProjectIdValue || projectId;
    if (!referencedProjectId || (projectId && referencedProjectId !== projectId)) {
      throw new Error("knowledge_source_cross_project");
    }
    const project = await getProject(referencedProjectId);
    if (!project) throw new Error("knowledge_project_not_found");
    await assertProjectClaimSnapshot(claim, context, referencedProjectId);
    if (kind === "project-file") {
      const relative = assertModelSafePath(claim.scope.filePath ?? pathParts.join(":"));
      const root = registeredProjectRoot(project.projectPath);
      const absolute = path.resolve(root, relative);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        throw new Error("knowledge_path_escape");
      }
      const content = await readFile(absolute).catch(() => undefined);
      if (!content) throw new Error("knowledge_project_file_not_found");
      const actualHash = createHash("sha256").update(content).digest("hex");
      if (claim.scope.fileSha256 && claim.scope.fileSha256 !== actualHash) {
        throw new Error("knowledge_project_file_snapshot_expired");
      }
    }
    return;
  }
  if (kind === "scenario-registry") {
    if (!hasScenario(value)) throw new Error("knowledge_scenario_not_found");
    return;
  }
  if (kind === "discovery") {
    const observation = await readDiscoveryPageObservation(value);
    if (!observation) throw new Error("knowledge_discovery_observation_not_found");
    if (projectId && observation.projectId !== projectId) {
      throw new Error("knowledge_source_cross_project");
    }
    if (
      claim.observedAt
      && Date.parse(claim.observedAt) !== Date.parse(observation.observation.capturedAt)
    ) {
      throw new Error("knowledge_discovery_observation_snapshot_expired");
    }
    return;
  }
  if (kind === "run-event") {
    const [referencedRunId, eventId] = value.split(":");
    if (!referencedRunId || (runId && referencedRunId !== runId)) throw new Error("knowledge_source_cross_run");
    const events = await runEventStore.events(referencedRunId);
    if (eventId && !events.some((event) => event.id === eventId)) throw new Error("knowledge_run_event_not_found");
    if (!eventId && events.length === 0) throw new Error("knowledge_run_event_not_found");
    return;
  }
  if (kind === "attempt") {
    const [referencedRunId, attemptId] = value.split(":");
    if (!referencedRunId || !attemptId || (runId && referencedRunId !== runId)) {
      throw new Error("knowledge_source_cross_attempt");
    }
    const bundle = await loadBundle(referencedRunId);
    if (!bundle?.attempts?.some((attempt) => attempt.id === attemptId)) {
      throw new Error("knowledge_attempt_not_found");
    }
    if (claim.scope.attemptId && claim.scope.attemptId !== attemptId) {
      throw new Error("knowledge_source_cross_attempt");
    }
    return;
  }
  if (kind === "step") {
    const [referencedRunId, attemptId, stepId] = value.split(":");
    if (
      !referencedRunId
      || !attemptId
      || !stepId
      || (runId && referencedRunId !== runId)
    ) {
      throw new Error("knowledge_source_cross_step");
    }
    const bundle = await loadBundle(referencedRunId);
    const attempt = bundle?.attempts?.find((item) => item.id === attemptId);
    const step = bundle?.result.steps.find((item) => item.stepId === stepId);
    const linkedEvidence = bundle?.evidence.some((item) =>
      item.attemptId === attemptId && item.stepId === stepId
    );
    if (!attempt || !step || !linkedEvidence) throw new Error("knowledge_step_not_found");
    if (claim.scope.attemptId && claim.scope.attemptId !== attemptId) {
      throw new Error("knowledge_source_cross_attempt");
    }
    if (claim.scope.stepId && claim.scope.stepId !== stepId) {
      throw new Error("knowledge_source_cross_step");
    }
    return;
  }
  if (kind === "evidence" || kind === "artifact" || kind === "evidence-or-artifact") {
    const bundle = await loadBundle(runId);
    if (!bundle) throw new Error("knowledge_run_bundle_not_found");
    const id = value;
    const evidence = bundle.evidence.find((item) => item.id === id);
    const artifact = bundle.artifactsV2?.find((item) => item.id === id);
    if (!evidence && !artifact) throw new Error("knowledge_evidence_not_found");
    const scoped = evidence ?? artifact;
    if (!scoped) throw new Error("knowledge_evidence_not_found");
    if (scoped.runId !== runId) throw new Error("knowledge_source_cross_run");
    if (claim.scope.scenarioId && scoped.scenarioId !== claim.scope.scenarioId) {
      throw new Error("knowledge_source_cross_scenario");
    }
    if (claim.scope.attemptId && scoped.attemptId !== claim.scope.attemptId) {
      throw new Error("knowledge_source_cross_attempt");
    }
    const linkedArtifacts = evidence
      ? (evidence.artifactIds ?? []).map((artifactId) =>
          bundle.artifactsV2?.find((item) => item.id === artifactId)
        )
      : [artifact];
    if (linkedArtifacts.some((item) => !item)) {
      throw new Error("knowledge_artifact_uncommitted");
    }
    for (const linkedArtifact of linkedArtifacts) {
      if (!linkedArtifact) continue;
      if (linkedArtifact.runId !== scoped.runId) throw new Error("knowledge_source_cross_run");
      if (linkedArtifact.scenarioId !== scoped.scenarioId) {
        throw new Error("knowledge_source_cross_scenario");
      }
      if (linkedArtifact.attemptId !== scoped.attemptId) {
        throw new Error("knowledge_source_cross_attempt");
      }
      if (linkedArtifact.origin === "legacy-unverified" || linkedArtifact.origin === "simulated") {
        throw new Error("knowledge_artifact_unverified");
      }
    }
    return;
  }
  if (kind === "repair") {
    if (!runId) throw new Error("knowledge_run_scope_missing");
    const sessions = await listRepairSessions(runId);
    if (!sessions.some((session) => session.id === value)) throw new Error("knowledge_repair_not_found");
    return;
  }
  if (kind === "run-result" || kind === "impact-analysis" || kind === "judge-baseline") {
    const referencedRunId = value.split(":")[0] || runId;
    if (!referencedRunId) throw new Error("knowledge_run_scope_missing");
    if (runId && referencedRunId !== runId) throw new Error("knowledge_source_cross_run");
    if (!await runEventStore.get(referencedRunId)) throw new Error("knowledge_run_not_found");
    return;
  }
  throw new Error(`knowledge_source_kind_not_allowed:${kind}`);
}

export async function resolveKnowledgeSources(
  contextInput: LlmKnowledgeContext
): Promise<KnowledgeSourceResolution> {
  const context = llmKnowledgeContextSchema.parse(contextInput);
  const rejected: KnowledgeSourceResolution["rejected"] = [];
  const verifiedClaimIds: string[] = [];
  const expiredClaimIds: string[] = [];
  const now = Date.now();
  const claims: KnowledgeClaim[] = [];

  for (const claim of context.claims) {
    if (claim.expiresAt && Date.parse(claim.expiresAt) <= now) {
      expiredClaimIds.push(claim.id);
      claims.push({ ...claim, status: "unknown" });
      continue;
    }
    if (claim.status === "assumed" || claim.status === "unknown") {
      claims.push(claim);
      continue;
    }
    if (claim.sourceRefs.length === 0) {
      rejected.push({ claimId: claim.id, errorCode: "knowledge_claim_source_missing" });
      claims.push({ ...claim, status: "unknown" });
      continue;
    }
    let error: { sourceRef?: string; errorCode: string } | undefined;
    for (const sourceRef of claim.sourceRefs) {
      try {
        await resolveSource(sourceRef, claim, context);
      } catch (cause) {
        error = {
          sourceRef,
          errorCode: cause instanceof Error ? cause.message : "knowledge_source_resolution_failed"
        };
        break;
      }
    }
    if (error) {
      rejected.push({ claimId: claim.id, ...error });
      claims.push({ ...claim, status: "unknown" });
    } else {
      verifiedClaimIds.push(claim.id);
      claims.push(claim);
    }
  }

  return {
    context: llmKnowledgeContextSchema.parse({ ...context, claims }),
    verifiedClaimIds,
    expiredClaimIds,
    rejected
  };
}
