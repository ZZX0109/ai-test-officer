import assert from "node:assert/strict";
import {
  assertKnowledgeCanAuthorizeAction,
  createKnowledgeContext,
  publicKnowledgeContext,
  validateKnowledgeBoundaryOutput
} from "../src/knowledgeBoundary.js";

export function testKnowledgeBoundary() {
  const context = createKnowledgeContext({
    purpose: "assistant",
    projectSnapshot: { projectId: "demo" },
    claims: [
      {
        id: "observed-failure",
        statement: "The browser step timed out.",
        status: "observed",
        domain: "runtime",
        sourceRefs: ["evidence-timeout"],
        confidence: 1
      },
      {
        id: "possible-selector-drift",
        statement: "The selector may have drifted.",
        status: "inferred",
        domain: "runtime",
        sourceRefs: ["observed-failure"],
        confidence: 0.7
      },
      {
        id: "credential-handle",
        statement: "secret-value-that-must-not-reach-the-model",
        status: "retrieved",
        domain: "credential-metadata",
        sourceRefs: ["credential:demo"],
        confidence: 1,
        sensitive: true
      }
    ],
    allowedCapabilities: ["request-repair"],
    allowedTools: ["read-run-evidence"],
    unknowns: [{
      id: "login-account-missing",
      question: "Which test account may be used?",
      reason: "The project requires authentication.",
      blocking: true,
      resolvableBy: "user"
    }],
    untrustedInputKinds: ["source", "dom"]
  });

  const grounded = validateKnowledgeBoundaryOutput({
    factsUsed: ["observed-failure"],
    inferences: [{ statement: "Selector drift is a candidate cause.", sourceClaimIds: ["observed-failure"] }],
    assumptions: [],
    unknowns: [],
    requestedTools: ["read-run-evidence"],
    blockingQuestions: []
  }, context);
  assert.deepEqual(grounded.factsUsed, ["observed-failure"]);

  assert.throws(() => validateKnowledgeBoundaryOutput({
    factsUsed: ["possible-selector-drift"],
    inferences: [],
    assumptions: [],
    unknowns: [],
    requestedTools: [],
    blockingQuestions: []
  }, context), /knowledge_unverified_fact_ref/);

  assert.throws(() => validateKnowledgeBoundaryOutput({
    factsUsed: ["missing"],
    inferences: [],
    assumptions: [],
    unknowns: [],
    requestedTools: [],
    blockingQuestions: []
  }, context), /knowledge_unknown_fact_ref/);

  assert.throws(() => validateKnowledgeBoundaryOutput({
    factsUsed: ["observed-failure"],
    inferences: [],
    assumptions: [],
    unknowns: [],
    requestedTools: ["shell"],
    blockingQuestions: []
  }, context), /knowledge_tool_not_allowed/);

  assert.throws(() => assertKnowledgeCanAuthorizeAction({
    context,
    output: {
      factsUsed: ["observed-failure"],
      inferences: [],
      assumptions: [],
      unknowns: ["login-account-missing"],
      requestedTools: [],
      blockingQuestions: ["Please choose a test account."]
    },
    action: "request-repair",
    critical: true
  }), /knowledge_critical_action_blocked_by_unknown/);

  const publicContext = publicKnowledgeContext(context);
  assert.equal(publicContext.claims.some((claim) => claim.id === "credential-handle"), true);
  assert.equal(
    publicContext.claims.find((claim) => claim.id === "credential-handle")?.statement,
    "A credential handle is configured; secret value is not available to the model."
  );
  assert.equal(JSON.stringify(publicContext).includes("secret-value-that-must-not-reach-the-model"), false);
}
