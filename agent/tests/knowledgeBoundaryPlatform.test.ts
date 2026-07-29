import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { authorizeKnowledgeAction } from "../src/knowledge-boundary/authorization.js";
import { redactForModel, assertModelSafePath } from "../src/knowledge-boundary/redaction.js";
import { resolveKnowledgeSources } from "../src/knowledge-boundary/sourceResolver.js";
import { executeKnowledgeReadTool } from "../src/knowledge-boundary/toolBroker.js";
import {
  bindAndValidateProjectSnapshot,
  buildProjectKnowledgeSnapshot
} from "../src/knowledge-boundary/projectSnapshot.js";
import { createKnowledgeContext, validateKnowledgeBoundaryOutput } from "../src/knowledgeBoundary.js";

export async function testKnowledgeBoundaryPlatform() {
  const root = path.resolve(
    path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd()
  );
  const { redactAcceptanceDiagnostic } = await import(
    path.join(root, "scripts", "production-acceptance-redaction.mjs")
  ) as { redactAcceptanceDiagnostic: (value: unknown) => string };
  const diagnostic = redactAcceptanceDiagnostic([
    "RUN_EVIDENCE_ED25519_PRIVATE_KEY: |",
    `  ${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}`,
    "  private-material",
    `  ${["-----END", "PRIVATE KEY-----"].join(" ")}`,
    "Authorization: Bearer opaque-token-value"
  ].join("\n"));
  assert.equal(diagnostic.includes("private-material"), false);
  assert.equal(diagnostic.includes("opaque-token-value"), false);

  const context = createKnowledgeContext({
    id: "knowledge_context_test",
    purpose: "repairing",
    runId: "run-current",
    projectSnapshot: { projectId: "project-current" },
    claims: [{
      id: "observed-error",
      statement: "The runtime log contains a deterministic startup error.",
      status: "observed",
      domain: "runtime",
      sourceRefs: ["input:startup-log"],
      confidence: 1,
      scope: { runId: "run-current", projectId: "project-current" }
    }],
    allowedCapabilities: ["sandboxWrite", "read-runtime-log"],
    allowedTools: ["read-runtime-log", "shell"],
    unknowns: [],
    untrustedInputKinds: ["source", "console"]
  });

  const output = validateKnowledgeBoundaryOutput({
    schemaVersion: "2.0",
    factsUsed: ["observed-error"],
    inferences: [],
    assumptions: [],
    unknowns: [],
    toolRequests: [],
    blockingQuestions: [],
    proposedActions: [{
      capability: "sandboxWrite",
      reason: "Apply a bounded patch to the writable sandbox copy.",
      sourceClaimIds: ["observed-error"],
      requiresConfirmation: true
    }]
  }, context);

  assert.throws(
    () => authorizeKnowledgeAction({
      context,
      output,
      capability: "sandboxWrite"
    }),
    /knowledge_action_requires_interrupt/
  );
  assert.equal(authorizeKnowledgeAction({
    context,
    output,
    capability: "sandboxWrite",
    grantedCapabilities: ["sandboxWrite"]
  }).capability, "sandboxWrite");
  assert.throws(
    () => authorizeKnowledgeAction({
      context: {
        ...context,
        unknowns: [{
          id: "credential-missing",
          question: "Which credential handle should be used?",
          reason: "The target requires authentication.",
          blocking: true,
          resolvableBy: "user"
        }]
      },
      output: {
        ...output,
        unknowns: []
      },
      capability: "sandboxWrite",
      grantedCapabilities: ["sandboxWrite"]
    }),
    /knowledge_critical_action_blocked_by_unknown/
  );

  await assert.rejects(
    () => executeKnowledgeReadTool({
      context,
      request: {
        tool: "shell",
        input: { command: "rm -rf /" },
        reason: "Attempt to expand the tool boundary.",
        sourceClaimIds: ["observed-error"]
      }
    }),
    /knowledge_tool_requires_capability_interrupt/
  );
  await assert.rejects(
    () => executeKnowledgeReadTool({
      context,
      request: {
        tool: "read-runtime-log",
        input: {
          projectId: "project-current",
          apiKey: ["must-never-enter", "a-tool-execution"].join("-")
        },
        reason: "Attempt to pass a credential through a read-only tool.",
        sourceClaimIds: ["observed-error"]
      }
    }),
    /knowledge_tool_sensitive_input_rejected/
  );

  assert.throws(() => assertModelSafePath("../.env"), /knowledge_path_escape/);
  assert.throws(() => assertModelSafePath(".env.production"), /knowledge_path_forbidden/);
  const redacted = redactForModel([
    `api_key=${["sk-test", "12345678901234567890"].join("_")}`,
    "password=hunter2",
    "postgres://admin:secret@localhost/db",
    `Bearer ${["eyJhbGciOiJIUzI1NiJ9", "payload", "signature"].join(".")}`
  ].join("\n"));
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("admin:secret"), false);
  assert.equal(redacted.includes("eyJhbGci"), false);

  const crossScope = await resolveKnowledgeSources(createKnowledgeContext({
    purpose: "assistant",
    runId: "run-current",
    claims: [{
      id: "cross-run-fact",
      statement: "A different run passed.",
      status: "observed",
      domain: "runtime",
      sourceRefs: ["run-event:run-other"],
      confidence: 1,
      scope: { runId: "run-other" }
    }],
    allowedCapabilities: [],
    allowedTools: [],
    unknowns: [],
    untrustedInputKinds: []
  }));
  assert.deepEqual(crossScope.verifiedClaimIds, []);
  assert.equal(crossScope.rejected[0]?.errorCode, "knowledge_source_cross_run");
  assert.equal(crossScope.context.claims[0]?.status, "unknown");

  const expired = await resolveKnowledgeSources(createKnowledgeContext({
    purpose: "assistant",
    claims: [{
      id: "expired-runtime-fact",
      statement: "The runtime was healthy.",
      status: "observed",
      domain: "runtime",
      sourceRefs: ["input:runtime-health"],
      confidence: 1,
      expiresAt: "2020-01-01T00:00:00.000Z"
    }],
    allowedCapabilities: [],
    allowedTools: [],
    unknowns: [],
    untrustedInputKinds: []
  }));
  assert.deepEqual(expired.expiredClaimIds, ["expired-runtime-fact"]);
  assert.equal(expired.context.claims[0]?.status, "unknown");

  const projectSnapshot = await buildProjectKnowledgeSnapshot("local_demo_app");
  assert.match(projectSnapshot.projectDigest, /^[a-f0-9]{64}$/);
  assert.match(projectSnapshot.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(projectSnapshot.registrySha256, /^[a-f0-9]{64}$/);
  const boundSnapshot = await bindAndValidateProjectSnapshot(createKnowledgeContext({
    purpose: "planning",
    projectSnapshot: { projectId: "local_demo_app" },
    claims: [],
    allowedCapabilities: [],
    allowedTools: [],
    unknowns: [],
    untrustedInputKinds: []
  }));
  assert.equal(boundSnapshot.projectSnapshot?.projectDigest, projectSnapshot.projectDigest);
  const idempotentToolContext = createKnowledgeContext({
    id: "knowledge_context_tool_idempotency",
    purpose: "planning",
    projectSnapshot,
    claims: [],
    allowedCapabilities: ["read-project-manifest"],
    allowedTools: ["read-project-manifest"],
    unknowns: [],
    untrustedInputKinds: []
  });
  const toolRequest = {
    tool: "read-project-manifest",
    input: { projectId: "local_demo_app" },
    reason: "Load the registered manifest before planning.",
    sourceClaimIds: []
  };
  const firstToolExecution = await executeKnowledgeReadTool({
    context: idempotentToolContext,
    request: toolRequest
  });
  const replayedToolExecution = await executeKnowledgeReadTool({
    context: idempotentToolContext,
    request: toolRequest
  });
  assert.equal(replayedToolExecution.execution.id, firstToolExecution.execution.id);
  assert.equal(replayedToolExecution.execution.status, "completed");
  assert.equal(replayedToolExecution.summary, firstToolExecution.summary);
  assert.deepEqual(replayedToolExecution.claims, firstToolExecution.claims);
  await assert.rejects(
    () => bindAndValidateProjectSnapshot(createKnowledgeContext({
      purpose: "planning",
      projectSnapshot: {
        projectId: "local_demo_app",
        manifestSha256: "0".repeat(64)
      },
      claims: [],
      allowedCapabilities: [],
      allowedTools: [],
      unknowns: [],
      untrustedInputKinds: []
    })),
    /knowledge_project_snapshot_expired:manifestSha256/
  );

  const sourceRoot = path.resolve(
    path.basename(process.cwd()) === "agent" ? process.cwd() : path.join(process.cwd(), "agent"),
    "src"
  );
  const allowedDirectCallers = new Set([
    "llmProvider.ts",
    // Credential capability probing does not produce a business decision.
    "server.ts",
    "sophNetResponsesRunnable.ts",
    "knowledge-boundary/executeKnowledgeBoundedLlm.ts"
  ]);
  const queue = [sourceRoot];
  const violations: string[] = [];
  while (queue.length) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const relative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
      if (allowedDirectCallers.has(relative)) continue;
      const source = await readFile(absolute, "utf8");
      if (/\bexecuteLlmCall\s*\(/.test(source)) violations.push(relative);
    }
  }
  assert.deepEqual(violations, [], `business modules bypassed executeKnowledgeBoundedLlm: ${violations.join(", ")}`);
}
