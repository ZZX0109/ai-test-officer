import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  recoveryActionSchema,
  type RecoveryAction,
  type RecoveryDecision
} from "@ai-test-officer/contracts";
import { decrypt, getCredential } from "./credentialStore.js";
import {
  createKnowledgeContext,
  knowledgeBoundaryJsonSchemaV2,
  knowledgeBoundarySystemPolicy
} from "./knowledgeBoundary.js";
import { executeKnowledgeBoundedLlm } from "./knowledge-boundary/executeKnowledgeBoundedLlm.js";

const outputSchema = z.object({
  action: recoveryActionSchema,
  reason: z.string().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceRefs: z.array(z.string().min(1)).max(20),
  userQuestion: z.string().max(1_000).nullable(),
  knowledge: z.unknown()
}).strict();

const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "reason", "confidence", "evidenceRefs", "userQuestion", "knowledge"],
  properties: {
    action: { type: "string", enum: recoveryActionSchema.options },
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidenceRefs: { type: "array", maxItems: 20, items: { type: "string" } },
    userQuestion: { type: ["string", "null"], maxLength: 1_000 },
    knowledge: knowledgeBoundaryJsonSchemaV2
  }
} as const;

function allowedActions(input: {
  baseline: RecoveryDecision;
  failureClass?: string;
}): RecoveryAction[] {
  const actions = new Set<RecoveryAction>([
    input.baseline.action,
    "request-user-confirmation",
    "blocked"
  ]);
  if (input.failureClass === "environment") {
    actions.add("retry-runtime");
    actions.add("retry-discovery");
  }
  if (input.failureClass === "test-script") {
    actions.add("repair-harness");
    actions.add("retry-path");
  }
  if (input.failureClass === "product-bug") {
    actions.add("repair-product");
    actions.add("retry-path");
  }
  if (/login|credential|auth|401|403|登录|凭据/i.test(input.baseline.reason)) {
    actions.add("request-credentials");
  }
  return [...actions];
}

/**
 * Select among policy-approved recovery actions. The model is advisory: it
 * cannot expand the action set, invent Evidence IDs, or execute anything.
 */
export async function chooseLlmRecoveryDecision(input: {
  baseline: RecoveryDecision;
  credentialId?: string;
  projectId?: string;
  failureClass?: string;
  observation?: unknown;
}): Promise<RecoveryDecision> {
  if (!input.credentialId) return input.baseline;
  const credential = await getCredential(input.credentialId);
  if (!credential) return input.baseline;
  const candidates = allowedActions(input);
  // High-confidence deterministic environment/auth routes do not need model
  // latency. The LLM is valuable for ambiguous triage and repair ownership.
  if (input.baseline.confidence === "high" && !["retry-path", "repair-harness", "repair-product", "blocked"].includes(input.baseline.action)) {
    return input.baseline;
  }
  const evidence = new Set(input.baseline.evidenceRefs);
  const knowledgeContext = createKnowledgeContext({
    purpose: "triage",
    runId: input.baseline.runId,
    projectSnapshot: input.projectId ? { projectId: input.projectId } : undefined,
    claims: [
      {
        id: "baseline-recovery-fact",
        subject: "recovery-baseline",
        statement: `Deterministic recovery classified the failure as ${input.failureClass ?? "unknown"} and proposed ${input.baseline.action}: ${input.baseline.reason}`,
        status: "observed",
        domain: "runtime",
        sourceRefs: input.baseline.evidenceRefs.length
          ? input.baseline.evidenceRefs.map((id) => `evidence:${id}`)
          : [`run-event:${input.baseline.runId}`],
        scope: { runId: input.baseline.runId, projectId: input.projectId },
        confidence: input.baseline.confidence === "high" ? 1 : input.baseline.confidence === "medium" ? 0.75 : 0.5
      }
    ],
    allowedCapabilities: candidates,
    allowedTools: ["read-run-evidence", "read-page-observation", "read-runtime-log"],
    unknowns: [],
    untrustedInputKinds: ["console", "dom", "network", "prior-model-output"]
  });
  const prompt = JSON.stringify({
    task: "Choose the safest next recovery action for an automated test run.",
    allowedActions: candidates,
    deterministicBaseline: input.baseline,
    failureClass: input.failureClass ?? "unknown",
    observation: input.observation,
    rules: [
      "Use only allowedActions.",
      "Use only evidenceRefs already present in deterministicBaseline.",
      "Prefer automatic retry for transient runtime/discovery failures.",
      "Use repair-harness or repair-product only when the failure class supports it; repair remains user-authorized.",
      "When facts are insufficient choose request-user-confirmation or blocked."
    ],
    knowledgeContext
  });
  try {
    const apiKey = await decrypt(credential.apiKeyEncrypted);
    const result = await executeKnowledgeBoundedLlm({
      credential,
      apiKey,
      system: `You are the recovery router for a sandboxed test agent. Return only JSON. ${knowledgeBoundarySystemPolicy}`,
      prompt,
      maxTokens: 700,
      timeoutMs: 20_000,
      totalTimeoutMs: 30_000,
      transportPreference: "non-stream-retry",
      jsonSchema: { name: "recovery_decision", schema: outputJsonSchema },
      context: { purpose: "triage", runId: input.baseline.runId, projectDigest: input.projectId },
      knowledgeContext,
      parseOutput: (text) => outputSchema.parse(JSON.parse(text))
    });
    const chosen = result.value;
    if (!candidates.includes(chosen.action)) return input.baseline;
    if (chosen.evidenceRefs.some((id) => !evidence.has(id))) return input.baseline;
    return {
      ...input.baseline,
      id: `recovery_${randomUUID()}`,
      action: chosen.action,
      reason: chosen.reason,
      confidence: chosen.confidence,
      evidenceRefs: chosen.evidenceRefs,
      expectedState: chosen.action === "blocked" ? "等待人工处理" : chosen.action.startsWith("request-") ? "等待用户输入" : "重新进入可执行测试阶段",
      userQuestion: chosen.userQuestion ?? undefined,
      createdAt: new Date().toISOString(),
      policyVersion: "recovery-policy-v2-llm-bounded"
    };
  } catch {
    return input.baseline;
  }
}
