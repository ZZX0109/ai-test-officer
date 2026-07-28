import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  artifactGateEligibility,
  conclusionSchema,
  coverageItemSchema,
  proofEdgeSchema,
  proofNodeSchema,
  runEvidenceManifestSchema,
  type Conclusion,
  type CoverageItem,
  type ProofEdge,
  type ProofNode,
  type RunEvidenceManifest
} from "@ai-test-officer/contracts";
import type { AssertionResult, EvidenceItem, RunBundle, VisualRunResult } from "./types.js";
import { readRunBundle, writeRunBundle } from "./evidenceStore.js";
import { persistExecutionResult } from "./executionPersistence.js";

const POLICY_VERSION = "proof-policy-1.0";
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["canonicalSha256", "signature", "evidenceManifest"].includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${canonicalSha256(parts).slice(0, 24)}`;
}

function latestAttempt(result: VisualRunResult) {
  return [...(result.attempts ?? [])].sort((a, b) => b.attempt - a.attempt)[0];
}

function evidenceForAttempt(result: VisualRunResult, attemptId: string) {
  return result.evidence.filter((item) => item.attemptId === attemptId);
}

function assertionId(runId: string, assertion: AssertionResult, index: number) {
  return stableId("assertion", runId, String(index), assertion.name);
}

function evidenceRefsForAssertion(
  assertion: AssertionResult,
  evidence: EvidenceItem[]
) {
  const allowed = new Set(evidence.map((item) => item.id));
  const direct = (assertion.fact?.evidenceRefs ?? []).filter((id) => allowed.has(id));
  if (direct.length) return direct;
  const titleMatches = evidence
    .filter((item) => item.type === "assertion" && (
      item.title === assertion.name
      || String(item.payload.assertionName ?? item.payload.name ?? "") === assertion.name
    ))
    .map((item) => item.id);
  return titleMatches;
}

function buildCoverageItems(result: VisualRunResult, scenarioId: string, attemptId: string): CoverageItem[] {
  const now = result.finishedAt;
  return result.riskCoverageMatrix.map((item) => coverageItemSchema.parse({
    schemaVersion: "1.0",
    id: stableId("coverage", result.id, item.riskId),
    runId: result.id,
    flowId: item.riskId,
    module: item.riskTitle,
    surface: "page",
    risk: "high",
    actionPathIds: item.pathIds,
    oracleIds: result.oracles.filter((oracle) => item.pathIds.includes(oracle.pathId)).map((oracle) => oracle.id),
    requiredEvidenceKinds: ["screenshot", "dom", "trace"],
    disposition: item.covered ? "executed" : "blocked",
    dispositionReason: item.notes,
    scenarioId,
    attemptId,
    createdAt: now,
    updatedAt: now
  }));
}

function addEdge(
  edges: ProofEdge[],
  input: Omit<ProofEdge, "schemaVersion" | "id" | "canonicalSha256" | "createdAt">
) {
  const edge = {
    schemaVersion: "1.0" as const,
    id: stableId("proof", input.runId, input.fromType, input.fromId, input.toType, input.toId, input.relation),
    ...input,
    createdAt: new Date().toISOString()
  };
  edges.push(proofEdgeSchema.parse({ ...edge, canonicalSha256: canonicalSha256(edge) }));
}

export type ProofGraphBuild = {
  coverageItems: CoverageItem[];
  conclusions: Conclusion[];
  proofNodes: ProofNode[];
  proofEdges: ProofEdge[];
  errors: string[];
};

export function buildProofGraph(result: VisualRunResult): ProofGraphBuild {
  const attempt = latestAttempt(result);
  const errors: string[] = [];
  if (!attempt) return { coverageItems: [], conclusions: [], proofNodes: [], proofEdges: [], errors: ["attempt_missing"] };
  const scenarioId = attempt.scenarioId;
  const attemptEvidence = evidenceForAttempt(result, attempt.id);
  const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
  const artifactById = new Map((result.artifactsV2 ?? []).map((item) => [item.id, item]));
  const conclusions: Conclusion[] = [];
  const proofNodes: ProofNode[] = [];
  const proofEdges: ProofEdge[] = [];
  const assertionConclusions: Array<{ assertion: AssertionResult; id: string; evidenceRefs: string[] }> = [];

  result.assertions.forEach((assertion, index) => {
    const id = assertionId(result.id, assertion, index);
    const evidenceRefs = evidenceRefsForAssertion(assertion, attemptEvidence);
    if (!evidenceRefs.length) errors.push(`${id}:evidence_missing`);
    assertionConclusions.push({ assertion, id, evidenceRefs });
    if (!evidenceRefs.length) return;
    const base = {
      schemaVersion: "1.0" as const,
      conclusionId: stableId("conclusion", result.id, id),
      runId: result.id,
      scenarioId,
      attemptId: attempt.id,
      claimType: "assertion" as const,
      status: assertion.passed ? "pass" : "fail",
      source: "deterministic" as const,
      assertionIds: [id],
      evidenceRefs,
      proofStatus: "verified" as const,
      createdAt: result.finishedAt,
      policyVersion: POLICY_VERSION
    };
    const conclusion = conclusionSchema.parse({ ...base, canonicalSha256: canonicalSha256(base) });
    conclusions.push(conclusion);
    addEdge(proofEdges, {
      runId: result.id, scenarioId, attemptId: attempt.id,
      fromType: "conclusion", fromId: conclusion.conclusionId,
      toType: "assertion", toId: id, relation: "supported-by-assertion"
    });
    const oracle = result.oracles.find((item) => item.assertionName === assertion.name);
    if (oracle) {
      addEdge(proofEdges, {
        runId: result.id, scenarioId, attemptId: attempt.id,
        fromType: "assertion", fromId: id,
        toType: "oracle", toId: oracle.id, relation: "evaluates-oracle"
      });
    }
    for (const evidenceId of evidenceRefs) {
      addEdge(proofEdges, {
        runId: result.id, scenarioId, attemptId: attempt.id,
        fromType: oracle ? "oracle" : "assertion", fromId: oracle?.id ?? id,
        toType: "evidence", toId: evidenceId, relation: "supported-by-evidence"
      });
    }
  });

  const referencesForAssertions = (items: typeof assertionConclusions) =>
    Array.from(new Set(items.flatMap((item) => item.evidenceRefs)));
  const failingAssertions = assertionConclusions.filter((item) => !item.assertion.passed);
  const passingAssertions = assertionConclusions.filter((item) => item.assertion.passed);
  const addAggregate = (
    claimType: "machine-gate" | "judge-finding" | "final-status",
    status: string,
    source: "deterministic" | "llm-advisory",
    requestedRefs: string[]
  ) => {
    const allowedRefs = new Set(attemptEvidence.map((item) => item.id));
    const evidenceRefs = Array.from(new Set(requestedRefs.filter((ref) => allowedRefs.has(ref))));
    const supportedAssertions = assertionConclusions.filter((item) => item.evidenceRefs.some((ref) => evidenceRefs.includes(ref)));
    if (!evidenceRefs.length) {
      errors.push(`${claimType}:evidence_missing`);
      return;
    }
    const base = {
      schemaVersion: "1.0" as const,
      conclusionId: stableId("conclusion", result.id, claimType, status),
      runId: result.id,
      scenarioId,
      attemptId: attempt.id,
      claimType,
      status,
      source,
      assertionIds: supportedAssertions.map((item) => item.id),
      evidenceRefs,
      proofStatus: errors.length ? "invalid" as const : "verified" as const,
      createdAt: result.finishedAt,
      policyVersion: POLICY_VERSION
    };
    const conclusion = conclusionSchema.parse({ ...base, canonicalSha256: canonicalSha256(base) });
    conclusions.push(conclusion);
    for (const item of supportedAssertions) {
      addEdge(proofEdges, {
        runId: result.id, scenarioId, attemptId: attempt.id,
        fromType: "conclusion", fromId: conclusion.conclusionId,
        toType: "assertion", toId: item.id, relation: "supported-by-assertion"
      });
    }
  };
  const machineRefs = Array.from(new Set(
    result.machineGate?.reasonDetails.flatMap((reason) => reason.evidenceRefs) ?? []
  ));
  const defaultMachineRefs = referencesForAssertions(
    result.machineGate?.status === "pass" ? passingAssertions : failingAssertions.length ? failingAssertions : assertionConclusions
  );
  const effectiveMachineRefs = machineRefs.length ? machineRefs : defaultMachineRefs;
  addAggregate("machine-gate", result.machineGate?.status ?? "needs-human-review", "deterministic", effectiveMachineRefs);
  if (result.judgeRecommendation) {
    addAggregate("judge-finding", result.judgeRecommendation.status, "llm-advisory", result.judgeRecommendation.evidenceRefs);
  }
  addAggregate(
    "final-status",
    result.finalStatus ?? "needs-human-review",
    "deterministic",
    [...effectiveMachineRefs, ...(result.judgeRecommendation?.evidenceRefs ?? [])]
  );

  for (const evidence of attemptEvidence) {
    for (const artifactId of evidence.artifactIds ?? []) {
      const artifact = artifactById.get(artifactId);
      if (!artifact) {
        errors.push(`${evidence.id}:${artifactId}:artifact_missing`);
        continue;
      }
      if (artifact.runId !== result.id || artifact.scenarioId !== scenarioId || artifact.attemptId !== attempt.id) {
        errors.push(`${evidence.id}:${artifactId}:association_mismatch`);
        continue;
      }
      const eligibility = artifactGateEligibility(artifact);
      if (!eligibility.eligible) errors.push(`${evidence.id}:${artifactId}:${eligibility.reason}`);
      addEdge(proofEdges, {
        runId: result.id, scenarioId, attemptId: attempt.id,
        fromType: "evidence", fromId: evidence.id,
        toType: "artifact", toId: artifact.id, relation: "materialized-by-artifact"
      });
      addEdge(proofEdges, {
        runId: result.id, scenarioId, attemptId: attempt.id,
        fromType: "artifact", fromId: artifact.id,
        toType: "attempt", toId: attempt.id, relation: "captured-in-attempt"
      });
      const stepId = artifact.stepId ?? evidence.stepId;
      if (stepId) {
        addEdge(proofEdges, {
          runId: result.id, scenarioId, attemptId: attempt.id,
          fromType: "attempt", fromId: attempt.id,
          toType: "step", toId: stepId, relation: "produced-by-step"
        });
      }
    }
  }
  for (const conclusion of conclusions) {
    for (const ref of conclusion.evidenceRefs) {
      const evidence = evidenceById.get(ref);
      if (!evidence) errors.push(`${conclusion.conclusionId}:${ref}:evidence_missing`);
      else if (evidence.runId !== result.id || evidence.scenarioId !== scenarioId || evidence.attemptId !== attempt.id) {
        errors.push(`${conclusion.conclusionId}:${ref}:evidence_association_mismatch`);
      } else if (!(evidence.artifactIds ?? []).length) {
        errors.push(`${conclusion.conclusionId}:${ref}:proof_bundle_missing_artifact`);
      } else if (!(evidence.artifactIds ?? []).some((artifactId) => {
        const artifact = artifactById.get(artifactId);
        return Boolean(artifact && artifact.attemptId === attempt.id && artifactGateEligibility(artifact).eligible);
      })) {
        errors.push(`${conclusion.conclusionId}:${ref}:proof_bundle_has_no_eligible_artifact`);
      }
    }
  }
  const addNode = (
    nodeType: ProofNode["nodeType"],
    id: string,
    payload: Record<string, unknown>
  ) => {
    if (proofNodes.some((node) => node.nodeType === nodeType && node.id === id)) return;
    const base = {
      schemaVersion: "1.0" as const,
      id,
      runId: result.id,
      scenarioId,
      attemptId: attempt.id,
      nodeType,
      payload,
      createdAt: result.finishedAt
    };
    proofNodes.push(proofNodeSchema.parse({ ...base, canonicalSha256: canonicalSha256(base) }));
  };
  for (const conclusion of conclusions) addNode("conclusion", conclusion.conclusionId, { conclusion });
  for (const [index, assertion] of result.assertions.entries()) {
    addNode("assertion", assertionId(result.id, assertion, index), { assertion });
  }
  for (const oracle of result.oracles) addNode("oracle", oracle.id, { oracle });
  for (const evidence of attemptEvidence) addNode("evidence", evidence.id, { evidence });
  for (const artifact of result.artifactsV2 ?? []) {
    if (artifact.attemptId === attempt.id) addNode("artifact", artifact.id, { artifact });
  }
  addNode("attempt", attempt.id, { attempt });
  const declaredStepIds = new Set<string>();
  for (const step of result.steps) {
    declaredStepIds.add(step.stepId);
    addNode("step", step.stepId, { step, provenance: "run-step" });
  }
  // Capture collectors use finer-grained step identifiers than the scenario
  // timeline (for example `after_<action>` and `attempt-1-finalize`).  Those
  // identifiers are intentionally retained so a screenshot/Trace can be
  // located precisely, but they still need first-class ProofNodes before the
  // database will accept Artifact -> Attempt -> Step edges.  Persist a derived
  // capture step instead of weakening the composite foreign key.
  const derivedStepIds = new Set<string>();
  for (const artifact of result.artifactsV2 ?? []) {
    if (artifact.attemptId === attempt.id && artifact.stepId) derivedStepIds.add(artifact.stepId);
  }
  for (const evidence of attemptEvidence) {
    if (evidence.stepId) derivedStepIds.add(evidence.stepId);
  }
  for (const stepId of derivedStepIds) {
    if (declaredStepIds.has(stepId)) continue;
    addNode("step", stepId, {
      step: {
        stepId,
        title: `Evidence capture: ${stepId}`,
        status: "captured"
      },
      provenance: "evidence-collector"
    });
  }
  for (const edge of proofEdges) {
    if (!proofNodes.some((node) => node.nodeType === edge.fromType && node.id === edge.fromId)) {
      errors.push(`${edge.id}:from_node_missing`);
    }
    if (!proofNodes.some((node) => node.nodeType === edge.toType && node.id === edge.toId)) {
      errors.push(`${edge.id}:to_node_missing`);
    }
  }
  return {
    coverageItems: buildCoverageItems(result, scenarioId, attempt.id),
    conclusions,
    proofNodes,
    proofEdges,
    errors: Array.from(new Set(errors))
  };
}

export function createEvidenceManifest(bundle: RunBundle): RunEvidenceManifest {
  const artifactHashes = Object.fromEntries((bundle.artifactsV2 ?? []).map((item) => [item.id, item.integrity.sha256]));
  const evidenceHashes = Object.fromEntries(bundle.evidence.map((item) => [item.id, canonicalSha256(item)]));
  const conclusionHashes = Object.fromEntries((bundle.conclusions ?? []).map((item) => [item.conclusionId, item.canonicalSha256 ?? canonicalSha256(item)]));
  const proofNodeHashes = Object.fromEntries((bundle.proofNodes ?? []).map((item) => [item.id, item.canonicalSha256]));
  const proofEdgeHashes = Object.fromEntries((bundle.proofEdges ?? []).map((item) => [item.id, item.canonicalSha256 ?? canonicalSha256(item)]));
  const reportSha256 = canonicalSha256(bundle.result);
  const evidenceSetRoot = canonicalSha256({ artifactHashes, evidenceHashes, conclusionHashes, proofNodeHashes, proofEdgeHashes, reportSha256 });
  const ed25519PrivateKey = process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY;
  const hmacKey = process.env.RUN_EVIDENCE_SIGNING_KEY;
  const signature = ed25519PrivateKey ? {
    algorithm: "ed25519" as const,
    keyId: process.env.RUN_EVIDENCE_SIGNING_KEY_ID ?? "deployment-ed25519",
    value: sign(null, Buffer.from(evidenceSetRoot), createPrivateKey(ed25519PrivateKey)).toString("base64url")
  } : hmacKey ? {
    algorithm: "hmac-sha256" as const,
    keyId: process.env.RUN_EVIDENCE_SIGNING_KEY_ID ?? "deployment-default",
    value: createHmac("sha256", hmacKey).update(evidenceSetRoot).digest("base64url")
  } : undefined;
  return runEvidenceManifestSchema.parse({
    schemaVersion: "1.0",
    runId: bundle.runId,
    artifactHashes,
    evidenceHashes,
    conclusionHashes,
    proofNodeHashes,
    proofEdgeHashes,
    reportSha256,
    evidenceSetRoot,
    generatedAt: new Date().toISOString(),
    signature,
    integrityStatus: signature ? "verified" : "unsigned"
  });
}

export function verifyEvidenceManifest(bundle: RunBundle, manifest: RunEvidenceManifest) {
  const rebuilt = createEvidenceManifest({ ...bundle, evidenceManifest: undefined });
  const errors: string[] = [];
  if (rebuilt.evidenceSetRoot !== manifest.evidenceSetRoot) errors.push("evidence_set_root_mismatch");
  if (manifest.signature) {
    if (manifest.signature.algorithm === "ed25519") {
      const publicKey = process.env.RUN_EVIDENCE_ED25519_PUBLIC_KEY;
      const privateKey = process.env.RUN_EVIDENCE_ED25519_PRIVATE_KEY;
      if (!publicKey && !privateKey) errors.push("signature_key_unavailable");
      else if (!verify(
        null,
        Buffer.from(manifest.evidenceSetRoot),
        publicKey ? createPublicKey(publicKey) : createPublicKey(createPrivateKey(privateKey!)),
        Buffer.from(manifest.signature.value, "base64url")
      )) errors.push("signature_invalid");
    } else {
      const key = process.env.RUN_EVIDENCE_SIGNING_KEY;
      if (!key) errors.push("signature_key_unavailable");
      else {
      const expected = createHmac("sha256", key).update(manifest.evidenceSetRoot).digest("base64url");
      const actualBuffer = Buffer.from(manifest.signature.value);
      const expectedBuffer = Buffer.from(expected);
      if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) errors.push("signature_invalid");
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function writeProofArtifacts(bundle: RunBundle) {
  const directory = path.join(rootDir, "reports", "runs", bundle.runId);
  await mkdir(directory, { recursive: true });
  const manifest = createEvidenceManifest(bundle);
  if (process.env.NODE_ENV === "production" && manifest.signature?.algorithm !== "ed25519") {
    throw new Error("evidence_manifest_ed25519_signature_required");
  }
  await Promise.all([
    writeFile(path.join(directory, "coverage.json"), JSON.stringify(bundle.coverageItems ?? [], null, 2)),
    writeFile(path.join(directory, "conclusions.json"), JSON.stringify(bundle.conclusions ?? [], null, 2)),
    writeFile(path.join(directory, "proof_nodes.json"), JSON.stringify(bundle.proofNodes ?? [], null, 2)),
    writeFile(path.join(directory, "proof_edges.json"), JSON.stringify(bundle.proofEdges ?? [], null, 2)),
    writeFile(path.join(directory, "evidence_manifest.json"), JSON.stringify(manifest, null, 2))
  ]);
  return manifest;
}

export async function readProofArtifacts(runId: string) {
  const directory = path.join(rootDir, "reports", "runs", runId);
  const read = async <T>(name: string, fallback: T): Promise<T> => {
    try { return JSON.parse(await readFile(path.join(directory, name), "utf8")) as T; } catch { return fallback; }
  };
  return {
    coverageItems: await read<CoverageItem[]>("coverage.json", []),
    conclusions: await read<Conclusion[]>("conclusions.json", []),
    proofNodes: await read<ProofNode[]>("proof_nodes.json", []),
    proofEdges: await read<ProofEdge[]>("proof_edges.json", []),
    manifest: await read<RunEvidenceManifest | undefined>("evidence_manifest.json", undefined)
  };
}

export async function appendHumanOverrideConclusion(input: {
  resultRunId: string;
  actor: string;
  reason: string;
  status: string;
}) {
  const bundle = await readRunBundle(input.resultRunId);
  const previous = [...(bundle.conclusions ?? [])]
    .reverse()
    .find((item) => item.claimType === "final-status");
  if (!previous) throw new Error("human_override_original_conclusion_missing");
  const createdAt = new Date().toISOString();
  const base = {
    schemaVersion: "1.0" as const,
    conclusionId: stableId("conclusion", bundle.runId, "human-override", createdAt, input.actor),
    runId: previous.runId,
    scenarioId: previous.scenarioId,
    attemptId: previous.attemptId,
    claimType: "human-override" as const,
    status: input.status,
    source: "human" as const,
    assertionIds: previous.assertionIds,
    evidenceRefs: previous.evidenceRefs,
    proofStatus: previous.proofStatus,
    createdAt,
    policyVersion: POLICY_VERSION,
    supersedesConclusionId: previous.conclusionId
  };
  const conclusion = conclusionSchema.parse({
    ...base,
    canonicalSha256: canonicalSha256(base)
  });
  const nodeBase = {
    schemaVersion: "1.0" as const,
    id: conclusion.conclusionId,
    runId: conclusion.runId,
    scenarioId: conclusion.scenarioId,
    attemptId: conclusion.attemptId,
    nodeType: "conclusion" as const,
    payload: {
      conclusion,
      actor: input.actor,
      reason: input.reason
    },
    createdAt
  };
  const node = proofNodeSchema.parse({
    ...nodeBase,
    canonicalSha256: canonicalSha256(nodeBase)
  });
  const supersedesBase = {
    schemaVersion: "1.0" as const,
    id: stableId("proof", conclusion.runId, conclusion.conclusionId, previous.conclusionId, "supersedes"),
    runId: conclusion.runId,
    scenarioId: conclusion.scenarioId,
    attemptId: conclusion.attemptId,
    fromType: "conclusion" as const,
    fromId: conclusion.conclusionId,
    toType: "conclusion" as const,
    toId: previous.conclusionId,
    relation: "supersedes" as const,
    createdAt
  };
  const supersedes = proofEdgeSchema.parse({
    ...supersedesBase,
    canonicalSha256: canonicalSha256(supersedesBase)
  });
  bundle.conclusions = [...(bundle.conclusions ?? []), conclusion];
  bundle.proofNodes = [...(bundle.proofNodes ?? []), node];
  bundle.proofEdges = [...(bundle.proofEdges ?? []), supersedes];
  bundle.result.humanDecision = {
    status: input.status === "blocked" ? "blocked" : input.status === "accepted-risk" ? "accepted-risk" : "approved",
    actor: input.actor,
    reason: input.reason,
    decidedAt: createdAt
  };
  const manifest = await writeProofArtifacts(bundle);
  bundle.evidenceManifest = manifest;
  bundle.result.evidenceManifest = manifest;
  await writeRunBundle(bundle);
  await persistExecutionResult(bundle.runId, {
    ...bundle.result,
    evidence: bundle.evidence,
    artifactsV2: bundle.artifactsV2,
    attempts: bundle.attempts,
    loopEvents: bundle.loopEvents,
    oracles: bundle.oracles,
    riskCoverageMatrix: bundle.riskCoverageMatrix,
    conflictPacket: bundle.conflictPacket,
    failureAttributions: bundle.failureAttributions ?? [],
    conclusions: bundle.conclusions,
    proofNodes: bundle.proofNodes,
    proofEdges: bundle.proofEdges,
    evidenceManifest: manifest
  });
  return { conclusion, manifest };
}
