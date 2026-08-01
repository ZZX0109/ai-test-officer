import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { authorizeKnowledgeAction } from "../src/knowledge-boundary/authorization.js";
import { redactForModel, assertModelSafePath } from "../src/knowledge-boundary/redaction.js";
import { resolveKnowledgeSources } from "../src/knowledge-boundary/sourceResolver.js";
import {
  executeKnowledgeReadTool,
  summarizeEvidenceForModel
} from "../src/knowledge-boundary/toolBroker.js";
import {
  bindAndValidateProjectSnapshot,
  buildProjectKnowledgeSnapshot
} from "../src/knowledge-boundary/projectSnapshot.js";
import { createKnowledgeContext, validateKnowledgeBoundaryOutput } from "../src/knowledgeBoundary.js";
import { writeDiscoveryPageObservation } from "../src/pageObservationStore.js";

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

  const pageObservationSummary = summarizeEvidenceForModel({
    id: "evidence_page_observation",
    runId: "run-current",
    scenarioId: "scenario-current",
    attemptId: "attempt-current",
    attempt: 1,
    stepId: "click-submit",
    type: "dom",
    title: "失败时页面观测 click-submit",
    timestamp: new Date().toISOString(),
    artifactIds: ["artifact_page_observation"],
    locator: {
      pageUrl: "http://127.0.0.1:5173/login?token=must-not-leak",
      selector: "body"
    },
    payload: {
      phase: "failure",
      readyState: "complete",
      interactiveElementCount: 2,
      controls: [{ kind: "input", name: "账号" }, { kind: "button", name: "登录" }],
      alerts: ["password=hunter2"],
      consoleErrors: ["Failed to fetch"],
      failedRequests: [{ method: "GET", url: "/api/session", status: 401 }],
      changes: []
    }
  });
  assert.equal(pageObservationSummary.type, "dom");
  assert.match(JSON.stringify(pageObservationSummary), /Failed to fetch/);
  assert.match(JSON.stringify(pageObservationSummary), /\[REDACTED\]/);
  assert.equal(JSON.stringify(pageObservationSummary).includes("hunter2"), false);

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

  const observationId = `discovery_knowledge_${Date.now()}`;
  const capturedAt = new Date().toISOString();
  await writeDiscoveryPageObservation({
    projectId: "local_demo_app",
    observation: {
      id: observationId,
      requestedUrl: "http://127.0.0.1:6173/",
      finalUrl: "http://127.0.0.1:6173/",
      startedAt: capturedAt,
      capturedAt,
      durationMs: 12,
      stage: "completed",
      status: "ready",
      navigation: { documentCommitted: true, httpStatus: 200 },
      document: { interactiveElementCount: 1, controls: [] },
      console: [],
      pageErrors: [],
      failedRequests: [],
      diagnosis: {
        summary: "页面已完成观测。",
        likelyCauses: [],
        retryable: false,
        userActionRequired: false
      }
    }
  });
  const discoverySource = await resolveKnowledgeSources(createKnowledgeContext({
    purpose: "assistant",
    projectSnapshot: { projectId: "local_demo_app" },
    claims: [{
      id: "discovery-observation",
      statement: "Discovery observed one interactive element.",
      status: "observed",
      domain: "runtime",
      sourceRefs: [`discovery:${observationId}`],
      confidence: 1,
      observedAt: capturedAt,
      scope: { projectId: "local_demo_app" }
    }],
    allowedCapabilities: [],
    allowedTools: [],
    unknowns: [],
    untrustedInputKinds: ["dom", "console", "network"]
  }));
  assert.deepEqual(discoverySource.verifiedClaimIds, ["discovery-observation"]);
  assert.equal(discoverySource.rejected.length, 0);
  const crossProjectDiscovery = await resolveKnowledgeSources(createKnowledgeContext({
    purpose: "assistant",
    projectSnapshot: { projectId: "order-portal-lite" },
    claims: [{
      id: "cross-project-discovery",
      statement: "A different project's page was ready.",
      status: "observed",
      domain: "runtime",
      sourceRefs: [`discovery:${observationId}`],
      confidence: 1,
      observedAt: capturedAt,
      scope: { projectId: "order-portal-lite" }
    }],
    allowedCapabilities: [],
    allowedTools: [],
    unknowns: [],
    untrustedInputKinds: []
  }));
  assert.equal(crossProjectDiscovery.context.claims[0]?.status, "unknown");
  assert.equal(crossProjectDiscovery.rejected[0]?.errorCode, "knowledge_source_cross_project");
  const observationRoot = path.join(root, "reports", "discovery", "observations");
  const projectKey = createHash("sha256").update("local_demo_app").digest("hex").slice(0, 24);
  await Promise.all([
    rm(path.join(observationRoot, `${observationId}.json`), { force: true }),
    rm(path.join(observationRoot, `latest-${projectKey}.json`), { force: true })
  ]);

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
