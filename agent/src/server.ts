import cors from "cors";
import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  agentInterruptSchema,
  agentPermissionProfileSchema,
  commandSpecSchema,
  knowledgeBoundaryOutputSchema,
  llmCallSchema,
  planProvenanceSchema,
  projectManifestSchema
} from "@ai-test-officer/contracts";
import {
  createCredential,
  decrypt,
  deleteCredential,
  getCredential,
  listCredentials,
  rotateCredential,
  updateCredential
} from "./credentialStore.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { generatePlan } from "./llmPlanner.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { routePlanner } from "./llmRoutingPolicy.js";
import { planCacheKey, readCachedPlan, writeCachedPlan } from "./planCache.js";
import { redactText, redactValue } from "./redaction.js";
import { readConnectorContext } from "./sourceConnectors.js";
import { readAuditLog } from "./auditLog.js";
import { readEvidence, readLatestRunId, readRunBundle } from "./evidenceStore.js";
import { readLatestLoopEvents, readLoopEvents } from "./loopEventStore.js";
import { listRunHistory } from "./runHistory.js";
import { proposePlanRefinement } from "./planRefinement.js";
import { captureDesktopScreenshot, desktopCaptureStatus } from "./desktopCaptureAdapter.js";
import { checkEnvironment } from "./environmentCheck.js";
import {
  assertSecurityConfig,
  authContext,
  basicRateLimit,
  createCorsOptions,
  isOrganizationAuthorized,
  requireApiToken,
  requireArtifactAccess,
  requireInternalWorkerIdentity,
  requireRole,
  securitySummary
} from "./security.js";
import { errorHandler } from "./server/middleware/errorHandler.js";
import { metaRouter } from "./server/routes/meta.routes.js";
import { knowledgeRouter } from "./server/routes/knowledge.routes.js";
import { testCredentialConnection } from "./testConnection.js";
import { executeLlmCall, listLlmCalls } from "./llmProvider.js";
import { readLlmBudgetLedger } from "./llmBudgetLedger.js";
import { subscribeLlmLifecycle } from "./llmLifecycle.js";
import {
  assertKnowledgeCanAuthorizeAction,
  createKnowledgeContext,
  knowledgeBoundaryJsonSchemaV2,
  knowledgeBoundarySystemPolicy,
  publicKnowledgeContext,
  validateKnowledgeBoundaryOutput
} from "./knowledgeBoundary.js";
import { executeKnowledgeBoundedLlm } from "./knowledge-boundary/executeKnowledgeBoundedLlm.js";
import { subscribeKnowledgeLifecycle } from "./knowledge-boundary/lifecycle.js";
import {
  appendAgentMessage,
  listAgentMessages,
  listRunKnowledge,
  listRunKnowledgeConflicts,
  listRunKnowledgeToolExecutions,
  readKnowledgeContext
} from "./knowledge-boundary/store.js";
import {
  appendHumanOverrideConclusion,
  readProofArtifacts,
  verifyEvidenceManifest
} from "./proofGraph.js";
import { runVisualGrayTest } from "./testRunner.js";
import { getScenario, hasScenario, listExecutableScenarios, listScenarios } from "./scenarios.js";
import { buildDeliveryFromRun, listBotDeliveries } from "./botNotifier.js";
import {
  deletePatrolPlan,
  listPatrolJobs,
  listPatrolPlans,
  patrolTrend,
  runPatrolNow,
  startPatrolJob,
  stopPatrolJob,
  upsertPatrolPlan
} from "./patrolScheduler.js";
import { listPatrolRuns } from "./patrolRunStore.js";
import { runCommitCheck } from "./commitCheckOrchestrator.js";
import { listCommitChecks } from "./commitCheckStore.js";
import { runRequirementAcceptance } from "./requirementAcceptanceOrchestrator.js";
import { listRequirementAcceptances } from "./requirementAcceptanceStore.js";
import { buildRunBundleArchive } from "./runBundleArchive.js";
import {
  approveScenarioDraft,
  createHarnessGapScenarioDraft,
  installHarnessGapScenarioDraft,
  listHarnessGaps,
  listScenarioDrafts,
  probeScenarioDraft,
  updateHarnessGap
} from "./harnessGapStore.js";
import { requireRunnableTarget, runnableTargetShape, targetRuntimeSchema } from "./runRequestContract.js";
import {
  getProject,
  getProjectRuntimeStatus,
  getProjectRuntimeStatusWithRecovery,
  recordProjectRuntimeStatus,
  listProjects,
  saveProject,
  startProject,
  stopProject,
  testProjectConnection,
  resolveProjectTarget,
  toTargetProjectConfig
} from "./projectAdapter.js";
import { detectProject, detectProjectManifest, diagnoseProject } from "./projectDetection.js";
import { createRuntimeRecoveryAdvice } from "./runtimeStartupAdvisor.js";
import { saveProjectLoginSecret } from "./projectLoginStore.js";
import { runDiscoveryScan } from "./discoveryScan.js";
import { readCoverageItems } from "./coverageStore.js";
import { createProjectGrant, deleteProjectGrant, hasProjectScope, listProjectGrants } from "./projectAccess.js";
import {
  readEvidenceFromAuditStore,
  readFindingsFromAuditStore,
  readJudgeSummaryFromAuditStore
} from "./sqliteAuditStore.js";
import { listStorageArchives, runStorageRetention, storageStatus } from "./storageGovernance.js";
import type { ProjectConfig, SourceReadEnvelope } from "./types.js";
import { loadProjectManifest, manifestToProjectConfig } from "./projectManifest.js";
import { isIdempotentReplay, runEventStore } from "./runEventStore.js";
import type { RunEventType } from "@ai-test-officer/contracts";
import { createRunRequestSchema } from "@ai-test-officer/contracts";
import { buildCodeImpactGraph, changedFilesFromDiff } from "./codeImpactGraph.js";
import { createMissionPreview } from "./missionPreview.js";
import { buildPlanningConversation } from "./planningConversation.js";
import { createLlmPlanningAdvice } from "./llmPlanningAdvisor.js";
import { enqueueRun, executeQueuedRun, interruptRun } from "./runOrchestrator.js";
import { buildBenchmarkCatalog, trustedBenchmarkRuntimeMetrics } from "./benchmarkSummary.js";
import { chooseNativeProjectFolder, listProjectDirectory } from "./projectFolderBrowser.js";
import {
  agentOrchestrationMode,
  getAgentGraphProjection,
  resumeAgentGraph,
  startAgentGraphInBackground
} from "./agentGraphService.js";
import {
  applyRepairSession,
  createRepairSession,
  exportRepairSession,
  listRepairSessions,
  readRepairFile,
  readRepairSession,
  validateRepairSession,
  writeRepairFile
} from "./repairWorkspace.js";
import { proposeCodeRepair } from "./llmCodeRepair.js";

const app = express();
const projectStartTasks = new Map<string, Promise<Awaited<ReturnType<typeof startProject>>>>();
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? (process.env.AGENT_API_TOKEN ? "0.0.0.0" : "127.0.0.1");

async function refreshExternalProjectLaunchContract(id: string) {
  const current = await getProject(id);
  if (!current?.allowExternalProjectPath) return current;
  const detection = await detectProject(current.projectPath);
  if (!detection.exists || detection.executionReady === false) return current;
  const detected = detection.suggestedConfig;
  const detectedManifest = detected.manifest;
  const currentManifest = current.manifest;
  const manifest = detectedManifest ? {
    ...detectedManifest,
    projectId: current.id,
    // The inspected package.json is authoritative for the sandbox base image:
    // retaining an older generic Node image can fail an engines.node check
    // before the target has even started.  External projects are always OCI;
    // only the selected container engine remains a user/deployment choice.
    execution: {
      ...detectedManifest.execution,
      mode: "oci" as const,
      engine: currentManifest?.execution.engine ?? detectedManifest.execution.engine
    },
    network: currentManifest?.network ?? detectedManifest.network,
    budget: currentManifest?.budget ?? detectedManifest.budget,
    environmentAllowlist: Array.from(new Set([
      ...detectedManifest.environmentAllowlist,
      ...(currentManifest?.environmentAllowlist ?? [])
    ]))
  } : currentManifest;
  return saveProject({
    ...current,
    installCommand: detected.installCommand,
    installCommandSpec: detected.installCommandSpec,
    startCommand: detected.startCommand,
    startCommandSpec: detected.startCommandSpec,
    processes: detected.processes,
    frontendUrl: detected.frontendUrl,
    backendUrl: detected.backendUrl,
    healthCheckUrl: detected.healthCheckUrl,
    manifest
  });
}

// Saving a detected project and launching its sandbox are separate durable
// operations. A file-system watcher / hot reload can observe the old registry
// between them, so retry the one safe failure that proves no process was ever
// started. This only refreshes the detected manifest and retries the existing
// allowlisted start contract; it never edits target source or runs LLM output.
async function startProjectWithFreshConfig(id: string) {
  await refreshExternalProjectLaunchContract(id);
  let runtime = await startProject(id);
  if (runtime.failureReason !== "config_missing") return runtime;
  await new Promise((resolve) => setTimeout(resolve, 80));
  await refreshExternalProjectLaunchContract(id);
  runtime = await startProject(id);
  return runtime;
}
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

const knowledgeBoundaryJsonSchema = knowledgeBoundaryJsonSchemaV2;
const assistantReasoningSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["phase", "observations", "assessment", "nextStep", "userAction", "confidence"],
  properties: {
    phase: { type: "string", enum: ["observing", "diagnosing", "planning", "waiting-user", "acting", "completed"] },
    observations: {
      type: "array",
      maxItems: 6,
      items: { type: "string", minLength: 1, maxLength: 500 }
    },
    assessment: { type: "string", minLength: 1, maxLength: 1_200 },
    nextStep: { type: "string", minLength: 1, maxLength: 800 },
    userAction: { type: "string", minLength: 1, maxLength: 800 },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
} as const;
const assistantReasoningSummarySchema = z.object({
  phase: z.enum(["observing", "diagnosing", "planning", "waiting-user", "acting", "completed"]),
  observations: z.array(z.string().min(1).max(500)).max(6),
  assessment: z.string().min(1).max(1_200),
  nextStep: z.string().min(1).max(800),
  userAction: z.string().min(1).max(800),
  confidence: z.enum(["high", "medium", "low"])
}).strict();

async function executeStructuredAssistant<T>(input: {
  credential: NonNullable<Awaited<ReturnType<typeof getCredential>>>;
  apiKey: string;
  system: string;
  prompt: string;
  schemaName: string;
  jsonSchema: NonNullable<Parameters<typeof executeLlmCall>[0]["jsonSchema"]>["schema"];
  parseSchema: z.ZodType<T>;
  context: Parameters<typeof executeLlmCall>[0]["context"];
  knowledgeContext: ReturnType<typeof createKnowledgeContext>;
}) {
  const callInput = {
    credential: input.credential,
    apiKey: input.apiKey,
    system: input.system,
    prompt: input.prompt,
    maxTokens: 700,
    timeoutMs: 20_000,
    totalTimeoutMs: 30_000,
    transportPreference: "non-stream-retry" as const,
    jsonSchema: { name: input.schemaName, schema: input.jsonSchema },
    context: input.context
  };
  const result = await executeKnowledgeBoundedLlm({
    ...callInput,
    knowledgeContext: input.knowledgeContext,
    parseOutput: (text) => input.parseSchema.parse(JSON.parse(text))
  });
  return {
    assistant: result.value,
    llm: result,
    repaired: result.calls.length > 1
  };
}

function assertOrganizationAccess(req: express.Request, organizationId: unknown) {
  const context = authContext(req);
  if (!isOrganizationAuthorized(context, organizationId)) throw new Error("organization_forbidden");
}

type ProjectScope = Parameters<typeof hasProjectScope>[0]["scope"];

async function assertProjectAccess(req: express.Request, projectId: unknown, scope: ProjectScope) {
  if (!projectId) return;
  const context = authContext(req);
  if (!context) throw new Error("project_forbidden");
  if (context.subject === "local-dev" || context.roles.includes("admin")) return;
  if (!await hasProjectScope({ projectId: String(projectId), subject: context.subject, scope })) throw new Error("project_forbidden");
}

function artifactUrl(filePath: string) {
  return `/artifacts/${path.relative(reportsDir, filePath).split(path.sep).join("/")}`;
}

function isMissingRunBundle(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function unavailableRunReport(run: NonNullable<Awaited<ReturnType<typeof runEventStore.get>>>) {
  const finalStatus = run.gateStatus ?? (run.state === "blocked" ? "blocked" : run.state === "failed" ? "fail" : "needs-human-review");
  return {
    runId: run.id,
    state: run.state,
    finalStatus,
    gateStatus: finalStatus,
    outcomeSummary: {
      schemaVersion: "2.0",
      schedulingCompleted: ["completed", "failed", "blocked", "cancelled"].includes(run.state),
      executionStarted: ["running", "collecting", "judging", "awaiting-human-review", "completed", "failed", "blocked"].includes(run.state),
      executionSucceeded: false,
      requirementCovered: false,
      requirementPassed: false,
      artifactIntegrityVerified: false,
      evidenceGrounded: false,
      gateEligible: false,
      machineGate: run.machineGate,
      judgeRecommendation: run.judgeRecommendation,
      humanDecision: run.humanDecision,
      finalStatus
    },
    machineGate: run.machineGate ?? {
      status: finalStatus,
      reasons: ["run_bundle_unavailable"],
      assertionFailures: [],
      evidenceComplete: false
    },
    judgeRecommendation: run.judgeRecommendation ?? {
      status: finalStatus === "fail" ? "fail" : "needs-human-review",
      summary: "Run reached a terminal state before a report bundle was committed.",
      evidenceRefs: []
    },
    reportAvailability: "unavailable" as const,
    artifacts: [],
    evidence: []
  };
}

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: "2mb" }));
app.use(basicRateLimit);
app.get("/artifacts/*", requireArtifactAccess, (req, res, next) => {
  const artifactPath = req.params[0] ?? "";
  const resolved = path.resolve(reportsDir, artifactPath);
  const relative = path.relative(reportsDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.status(403).json({ error: "Artifact path escapes reports directory" });
    return;
  }
  res.sendFile(resolved, (error) => {
    if (error) next(error);
  });
});
app.use(requireApiToken);
app.use(knowledgeRouter());
app.use("/api/credentials", requireRole(["admin"]));
app.use("/api/projects/grants", requireRole(["admin"]));
app.post("/v1/runs", requireRole(["admin", "runner"]));
for (const action of ["plan-approval", "permissions", "pause", "resume", "cancel"]) app.post(`/v1/runs/:id/${action}`, requireRole(["admin", "runner"]));
app.post("/v1/runs/:id/decision-override", requireRole(["admin", "reviewer"]));
app.post("/v1/runs/:id/repairs", requireRole(["admin", "maintainer"]));
app.put("/v1/repair-sessions/:id/files/*", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/validate", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/export", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/apply", requireRole(["admin", "maintainer"]));

const credentialSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["openai-compatible", "openai", "anthropic", "openrouter", "custom"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  tags: z.array(z.string()).default([]),
  isDefault: z.boolean().optional(),
  owner: z.string().optional(),
  scopes: z.array(z.string()).optional()
});

app.use(metaRouter);

app.get("/api/credentials", async (_req, res, next) => {
  try {
    res.json({ credentials: await listCredentials() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/credentials", async (req, res, next) => {
  try {
    const input = credentialSchema.parse(req.body);
    res.status(201).json({ credential: await createCredential(input) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/credentials/:id", async (req, res, next) => {
  try {
    const input = credentialSchema.partial().parse(req.body);
    const credential = await updateCredential(req.params.id, input);
    if (!credential) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    res.json({ credential });
  } catch (error) {
    next(error);
  }
});

app.post("/api/credentials/:id/rotate", async (req, res, next) => {
  try {
    const body = z.object({
      apiKey: z.string().min(1),
      reason: z.string().optional()
    }).parse(req.body);
    const credential = await rotateCredential(req.params.id, body);
    if (!credential) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    res.json({ credential });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/credentials/:id", async (req, res, next) => {
  try {
    const deleted = await deleteCredential(req.params.id);
    res.json({ deleted });
  } catch (error) {
    next(error);
  }
});

app.post("/api/credentials/:id/test", async (req, res, next) => {
  try {
    const credential = await getCredential(req.params.id);
    if (!credential) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    const connection = await testCredentialConnection(credential);
    if (req.body?.mode !== "structured" || !connection.ok) {
      res.json(connection);
      return;
    }
    try {
      const apiKey = await decrypt(credential.apiKeyEncrypted);
      const preflight = async (transportPreference: "stream" | "non-stream") => executeLlmCall({
        credential,
        apiKey,
        system: "Return only a JSON object with key ok and boolean value.",
        prompt: `Preflight structured output check (${transportPreference}).`,
        // Some OpenAI-compatible gateways wrap even a tiny JSON reply with
        // internal formatting. 64 tokens can truncate that valid response and
        // make a working credential look unsupported.
        maxTokens: 256,
        timeoutMs: 30_000,
        transportPreference,
        context: { purpose: "planning", experimentId: "credential-preflight" }
      });
      const streamResult = await preflight("stream");
      const nonStreamResult = await preflight("non-stream");
      let streamParsed: unknown;
      let nonStreamParsed: unknown;
      try { streamParsed = JSON.parse(streamResult.text); } catch { streamParsed = undefined; }
      try { nonStreamParsed = JSON.parse(nonStreamResult.text); } catch { nonStreamParsed = undefined; }
      const streamStructured = streamParsed && typeof streamParsed === "object" && (streamParsed as { ok?: unknown }).ok === true;
      const nonStreamStructured = nonStreamParsed && typeof nonStreamParsed === "object" && (nonStreamParsed as { ok?: unknown }).ok === true;
      res.json({ ...connection, structuredOutput: streamStructured && nonStreamStructured, streamStructuredOutput: streamStructured, nonStreamStructuredOutput: nonStreamStructured, call: nonStreamResult.call, preflightCalls: [streamResult.call, nonStreamResult.call] });
    } catch (error) {
      const call = (error as { llmCall?: unknown }).llmCall;
      res.json({ ...connection, ok: false, structuredOutput: false, message: "结构化输出预检失败", call });
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/harness-gaps", async (_req, res, next) => {
  try {
    res.json({ gaps: await listHarnessGaps() });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/harness-gaps/:id", async (req, res, next) => {
  try {
    const body = z
      .object({
        status: z.enum(["open", "implemented", "dismissed"])
      })
      .parse(req.body);
    const gap = await updateHarnessGap(req.params.id, body);
    if (!gap) {
      res.status(404).json({ error: "Harness gap not found" });
      return;
    }
    res.json({ gap });
  } catch (error) {
    next(error);
  }
});

app.post("/api/harness-gaps/:id/draft-scenario", async (req, res, next) => {
  try {
    const draft = await createHarnessGapScenarioDraft(req.params.id);
    if (!draft) {
      res.status(404).json({ error: "Harness gap not found" });
      return;
    }
    res.status(201).json({ draft });
  } catch (error) {
    next(error);
  }
});

app.post("/api/harness-gaps/:id/install-draft", async (req, res, next) => {
  try {
    const draft = await installHarnessGapScenarioDraft(req.params.id);
    if (!draft) {
      res.status(404).json({ error: "Harness gap not found" });
      return;
    }
    if (draft.draftReviewStatus !== "approved") {
      res.status(409).json({ error: "Scenario draft did not pass selector/oracle probe.", draft });
      return;
    }
    res.status(201).json({ draft });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scenario-drafts", async (_req, res, next) => {
  try {
    res.json({ drafts: await listScenarioDrafts() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scenario-drafts/:id/probe", async (req, res, next) => {
  try {
    const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : undefined;
    const draft = await probeScenarioDraft(req.params.id, credentialId);
    if (!draft) {
      res.status(404).json({ error: "Scenario draft not found" });
      return;
    }
    res.json({ draft });
  } catch (error) {
    next(error);
  }
});

app.post("/api/scenario-drafts/:id/approve", async (req, res, next) => {
  try {
    const draft = await approveScenarioDraft(req.params.id);
    if (!draft) {
      res.status(404).json({ error: "Scenario draft not found" });
      return;
    }
    if (draft.draftReviewStatus !== "approved") {
      res.status(409).json({ error: "Scenario draft probe failed; fix missingInfo before approving.", draft });
      return;
    }
    res.status(201).json({ draft });
  } catch (error) {
    next(error);
  }
});

const connectorContextSchema = z.object({
  requirementPath: z.string().optional(),
  requirementUrl: z.string().url().optional(),
  bugTicketPath: z.string().optional(),
  bugTicketUrl: z.string().url().optional(),
  openApiPath: z.string().optional(),
  openApiUrl: z.string().url().optional(),
  prUrl: z.string().optional(),
  prDiffUrl: z.string().url().optional(),
  gitBase: z.string().optional(),
  gitHead: z.string().optional(),
  staged: z.boolean().default(false),
  fallbackDiff: z.string().optional(),
  strictInput: z.boolean().default(false)
});

const permissionProfileSchema = agentPermissionProfileSchema;

const runControlSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  actor: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payload: z.record(z.unknown()).optional()
});

app.post("/v1/runs", async (req, res, next) => {
  try {
    const body = createRunRequestSchema.parse(req.body);
    assertOrganizationAccess(req, body.organizationId);
    await assertProjectAccess(req, body.projectId, "run_tests");
    const created = await runEventStore.create({
      runId: body.runId,
      actor: body.actor,
      idempotencyKey: body.idempotencyKey,
      payload: {
        ...body.input,
        projectId: body.projectId,
        organizationId: body.organizationId,
        runKind: body.runKind,
        parentRunId: body.parentRunId,
        coverageItemId: body.coverageItemId
      }
    });
    if (agentOrchestrationMode(body.projectId) === "active") {
      startAgentGraphInBackground(created);
      res.status(201).json({ run: created });
      return;
    }
    let planPayload: Record<string, unknown> = {};
    if (created.state === "planning") {
      const sourceContexts: SourceReadEnvelope[] = [];
      if (body.input.requirement) sourceContexts.push({ id: "run_requirement", kind: "manual", title: "Run requirement", status: "connected", summary: body.input.requirement, permissionState: "not_required", isSimulated: false, evidenceUse: "primary_requirement", displayStatus: "ready", readAt: new Date().toISOString(), trustLevel: "medium" });
      if (body.input.diff) sourceContexts.push({ id: "run_diff", kind: "git_diff", title: "Run diff", status: "connected", summary: body.input.diff, permissionState: "not_required", isSimulated: false, evidenceUse: "change_context", displayStatus: "ready", readAt: new Date().toISOString(), trustLevel: "high" });
      const diff = body.input.diff ?? "";
      const project = body.projectId ? await getProject(body.projectId) : undefined;
      const scenarioContracts = listExecutableScenarios().map((scenario) => ({ id: scenario.id, keywords: scenario.matcher?.keywords ?? [scenario.id, scenario.title] }));
      const repositoryGraph = project && diff
        ? await buildCodeImpactGraph({
          repositoryRoot: toTargetProjectConfig(project).rootDir,
          files: changedFilesFromDiff(diff),
          diff,
          cacheFile: path.join(reportsDir, "impact-cache", `${project.id}.json`),
          scenarios: scenarioContracts
        })
        : undefined;
      const codeGraph = repositoryGraph && project ? { ...repositoryGraph, repositoryRoot: `project://${project.id}` } : repositoryGraph;
      const plannerProjectId = body.input.logicalProjectId ?? body.projectId;
      const intake = analyzeIntake({ requirement: body.input.requirement ?? "", diff, projectId: plannerProjectId, sourceContexts, codeGraph });
      const plannerRouting = body.input.plannerMode === "adaptive"
        ? routePlanner({ requirement: body.input.requirement, explicitScenarioId: body.input.scenarioId, intake, impactAnalysis: intake.impactAnalysis })
        : { route: body.input.plannerMode, reason: "explicit_mode", signals: [`mode:${body.input.plannerMode}`] };
      if (plannerRouting.route === "llm") {
        try {
          const cacheKey = planCacheKey({ projectId: plannerProjectId, targetVersion: body.input.targetVersion, requirement: body.input.requirement, diff, promptVersion: body.input.promptVersion, modelProfileId: body.input.modelProfileId });
          const cached = body.input.plannerMode === "adaptive" && body.input.cachePolicy === "auto" && !body.input.experimentId
            ? await readCachedPlan(cacheKey)
            : undefined;
          if (cached) {
            const provenance = planProvenanceSchema.parse({ source: "cached-llm", promptVersion: body.input.promptVersion, modelProfileId: body.input.modelProfileId, model: cached.model, compilationStatus: "validated", cacheKey, originLlmCallId: cached.originLlmCallId });
            planPayload = { plan: cached.plan, compiledPlan: cached.compiledPlan, provenance, scenarioId: cached.scenarioId, impactAnalysis: intake.impactAnalysis, plannerRouting: { ...plannerRouting, signals: [...plannerRouting.signals, "plan_cache_hit"] } };
          } else {
            const generated = await generatePlan({ projectId: plannerProjectId, requirement: body.input.requirement ?? "", diff, impactAnalysis: intake.impactAnalysis, credentialId: body.input.modelProfileId, requireLlm: true, runId: created.id, experimentId: body.input.experimentId, promptVersion: body.input.promptVersion, preferredScenarioId: body.input.scenarioId, llmBudget: body.input.llmBudget, browserControlAllowed: body.input.permissionProfile.browserControl });
            planPayload = { plan: generated.plan, compiledPlan: generated.compiledPlan, provenance: generated.provenance, llmCall: generated.llmCall, llmCalls: generated.llmCalls, scenarioId: generated.scenarioId, impactAnalysis: intake.impactAnalysis, plannerRouting };
            if (body.input.plannerMode === "adaptive" && body.input.cachePolicy === "auto" && !body.input.experimentId && generated.compiledPlan && generated.scenarioId && generated.llmCall && generated.provenance?.model) {
              await writeCachedPlan({ key: cacheKey, plan: generated.plan, compiledPlan: generated.compiledPlan, scenarioId: generated.scenarioId, model: generated.provenance.model, originLlmCallId: generated.llmCall.id, createdAt: new Date().toISOString() });
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : "llm_planner_failed";
          const review = reason.startsWith("llm_plan_") || reason.includes("schema") || reason.includes("parse");
          const callResult = llmCallSchema.safeParse(typeof error === "object" && error !== null && "llmCall" in error ? error.llmCall : undefined);
          const plannerCall = callResult.success ? callResult.data : undefined;
          const callsResult = llmCallSchema.array().safeParse(typeof error === "object" && error !== null && "llmCalls" in error ? error.llmCalls : undefined);
          const plannerCalls = callsResult.success ? callsResult.data : plannerCall ? [plannerCall] : [];
          const failureReason = redactText(reason);
          const fallbackScenario = body.input.plannerMode === "adaptive"
            ? intake.impactAnalysis?.recommendedScenarios.find((item) => item.confidence === "high" && hasScenario(item.scenarioId))
            : undefined;
          if (fallbackScenario) {
            planPayload = {
              plan: buildScenarioGrayPlan(getScenario(fallbackScenario.scenarioId)),
              provenance: planProvenanceSchema.parse({ source: "adaptive-rule-fallback", promptVersion: body.input.promptVersion, modelProfileId: body.input.modelProfileId, model: plannerCall?.model, llmCallId: plannerCall?.id, compilationStatus: "validated", fallbackReason: failureReason }),
              scenarioId: fallbackScenario.scenarioId,
              impactAnalysis: intake.impactAnalysis,
              plannerRouting: { ...plannerRouting, route: "deterministic", reason: "adaptive_rule_fallback", signals: [...plannerRouting.signals, `llm_failure:${failureReason}`, `fallback_scenario:${fallbackScenario.scenarioId}`] },
              ...(plannerCall ? { llmCall: plannerCall } : {}),
              ...(plannerCalls.length ? { llmCalls: plannerCalls } : {})
            };
          } else {
          const provenance = planProvenanceSchema.parse({
            source: "llm",
            promptVersion: body.input.promptVersion,
            modelProfileId: body.input.modelProfileId,
            model: plannerCall?.model,
            llmCallId: plannerCall?.id,
            compilationStatus: "rejected",
            fallbackReason: failureReason
          });
          const run = await runEventStore.append({
            runId: created.id,
            type: review ? "human_review_requested" : "run_blocked",
            expectedVersion: created.version,
            actor: "planner",
            idempotencyKey: `${body.idempotencyKey}:planner-failed`,
            payload: {
              finalStatus: review ? "needs-human-review" : "blocked",
              error: failureReason,
              provenance,
              ...(plannerCall ? { llmCall: plannerCall } : {}),
              ...(plannerCalls.length ? { llmCalls: plannerCalls } : {}),
              impactAnalysis: intake.impactAnalysis
            }
          });
          res.status(201).json({ run });
          return;
          }
        }
      } else {
        const scenarioId = body.input.scenarioId ?? intake.scenarioCandidates.find((candidate) => candidate.executable && candidate.source !== "patrol")?.mappedScenarioId;
        if (!scenarioId) {
          const run = await runEventStore.append({
            runId: created.id,
            type: "human_review_requested",
            expectedVersion: created.version,
            actor: "planner",
            idempotencyKey: `${body.idempotencyKey}:impact-gap`,
            payload: {
              finalStatus: "needs-human-review",
              error: "impact_analysis_no_executable_scenario",
              impactAnalysis: intake.impactAnalysis,
              provenance: { source: "deterministic", promptVersion: body.input.promptVersion, compilationStatus: "rejected", fallbackReason: "impact_analysis_no_executable_scenario" }
            }
          });
          res.status(201).json({ run });
          return;
        }
        planPayload = { plan: buildScenarioGrayPlan(getScenario(scenarioId)), provenance: { source: "deterministic", promptVersion: body.input.promptVersion, compilationStatus: "validated" }, scenarioId, impactAnalysis: intake.impactAnalysis, plannerRouting };
      }
    }
    const run = created.state === "planning"
      ? await runEventStore.append({
        runId: created.id,
        type: "plan_generated",
        expectedVersion: created.version,
        actor: "planner",
        idempotencyKey: `${body.idempotencyKey}:generated`,
        payload: planPayload
      })
      : created;
    startAgentGraphInBackground(run);
    res.status(201).json({ run });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ run });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/events", async (req, res, next) => {
  try { const run = await runEventStore.get(req.params.id); if (!run) return void res.status(404).json({ error: "run_not_found" }); assertOrganizationAccess(req, run.input.organizationId); await assertProjectAccess(req, run.input.projectId, "read_artifacts"); res.json({ events: await runEventStore.events(req.params.id) }); } catch (error) { next(error); }
});

const controlEvents: Record<string, RunEventType> = {
  "plan-approval": "plan_approved",
  permissions: "permission_granted",
  pause: "run_paused",
  resume: "run_resumed",
  cancel: "run_cancelled",
  "decision-override": "decision_overridden"
};

for (const [action, eventType] of Object.entries(controlEvents)) {
  app.post(`/v1/runs/:id/${action}`, async (req, res, next) => {
    try {
      const body = runControlSchema.parse(req.body);
      const existing = await runEventStore.get(req.params.id);
      if (!existing) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, existing.input.organizationId);
      await assertProjectAccess(req, existing.input.projectId, "run_tests");
      if (eventType === "decision_overridden") {
        z.object({ status: z.enum(["approved", "blocked", "accepted-risk"]), reason: z.string().min(1), originalDecision: z.string().optional(), newLabel: z.string().optional() }).parse(body.payload);
      }
      const run = await runEventStore.append({ runId: req.params.id, type: eventType, ...body, payload: body.payload ?? {} });
      const replayed = isIdempotentReplay(run);
      if (!replayed && eventType === "decision_overridden" && run.resultRunId) {
        await appendHumanOverrideConclusion({
          resultRunId: run.resultRunId,
          actor: body.actor,
          reason: String(body.payload?.reason ?? ""),
          status: String(body.payload?.status ?? "approved")
        });
      }
      const graphMode = agentOrchestrationMode(
        typeof run.input.projectId === "string" ? run.input.projectId : undefined
      );
      if (!replayed && eventType === "plan_approved" && graphMode === "active") {
        await resumeAgentGraph(run.id, { approved: true, actor: body.actor });
      }
      if (!replayed && eventType === "permission_granted" && graphMode === "active") {
        await resumeAgentGraph(run.id, { approved: true, actor: body.actor });
      }
      if (!replayed && (eventType === "permission_granted" || eventType === "run_resumed")) await enqueueRun(run.id, run.version);
      if (!replayed && (eventType === "run_paused" || eventType === "run_cancelled")) interruptRun(run.id);
      res.json({ run });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("run_version_conflict:")) {
        res.status(409).json({ error: "run_version_conflict", actualVersion: Number(error.message.split(":")[1]) });
        return;
      }
      next(error);
    }
  });
}

app.get("/v1/runs/:id/artifacts", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    try {
      const bundle = await readRunBundle(run?.resultRunId ?? req.params.id);
      res.json({ artifacts: bundle.artifactsV2 ?? [], legacyEvidence: bundle.evidence.filter((item) => !item.artifactIds?.length) });
    } catch (error) {
      if (!isMissingRunBundle(error)) throw error;
      res.json({ artifacts: [], legacyEvidence: [], reportAvailability: "unavailable" });
    }
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/report", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    try {
      const result = (await readRunBundle(run?.resultRunId ?? req.params.id)).result;
      res.json({ report: { ...result, gateStatus: run?.gateStatus ?? result.gateStatus, finalStatus: run?.gateStatus ?? result.finalStatus, machineGate: run?.machineGate ?? result.machineGate, judgeRecommendation: run?.judgeRecommendation ?? result.judgeRecommendation, humanDecision: run?.humanDecision, planProvenance: run?.planProvenance, plannerCall: run?.plannerCall, plannerCalls: run?.plannerCalls, impactAnalysis: run?.impactAnalysis } });
    } catch (error) {
      if (!isMissingRunBundle(error)) throw error;
      res.json({ report: { ...unavailableRunReport(run), humanDecision: run.humanDecision, planProvenance: run.planProvenance, plannerCall: run.plannerCall, plannerCalls: run.plannerCalls, impactAnalysis: run.impactAnalysis } });
    }
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/agent", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const agent = await getAgentGraphProjection(run.id);
    res.json({ agent: agent ?? null });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/coverage", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const proof = await readProofArtifacts(resultRunId);
    const durableCoverage = proof.coverageItems.length
      ? proof.coverageItems
      : await readCoverageItems(run.id);
    const disposition = {
      executed: durableCoverage.filter((item) => item.disposition === "executed").length,
      excluded: durableCoverage.filter((item) => item.disposition === "excluded").length,
      blocked: durableCoverage.filter((item) => item.disposition === "blocked").length,
      pending: durableCoverage.filter((item) => item.disposition === "pending").length
    };
    res.json({
      coverage: durableCoverage,
      disposition,
      complete: durableCoverage.length > 0 && disposition.pending === 0
    });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/llm-calls", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const calls = await listLlmCalls(run.id);
    const ledger = await readLlmBudgetLedger(run.id);
    const knownCosts = calls.map((call) => call.usage.estimatedCostUsd).filter((value): value is number => typeof value === "number");
    res.json({
      calls,
      budgetLedger: ledger,
      summary: {
        count: calls.length,
        totalTokens: calls.reduce((sum, call) => sum + (call.usage.totalTokens ?? 0), 0),
        cost: knownCosts.length === calls.length ? knownCosts.reduce((sum, value) => sum + value, 0) : "unknown",
        retries: calls.reduce((sum, call) => sum + Math.max(0, (call.transportAttempts?.length ?? 1) - 1), 0),
        failures: calls.filter((call) => call.status !== "passed").length
      }
    });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/conclusions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const proof = await readProofArtifacts(resultRunId);
    let integrity = { valid: false, errors: ["manifest_missing"] };
    if (proof.manifest) {
      try {
        const [knowledge, conflicts, toolExecutions, messages] = await Promise.all([
          listRunKnowledge(resultRunId),
          listRunKnowledgeConflicts(resultRunId),
          listRunKnowledgeToolExecutions(resultRunId),
          listAgentMessages(resultRunId)
        ]);
        integrity = verifyEvidenceManifest(
          await readRunBundle(resultRunId),
          proof.manifest,
          { ...knowledge, conflicts, toolExecutions, messages }
        );
      } catch {
        integrity = { valid: false, errors: ["manifest_verification_failed"] };
      }
    }
    res.json({
      conclusions: integrity.valid
        ? proof.conclusions
        : proof.conclusions.map((item) => ({ ...item, proofStatus: "invalid" })),
      manifest: proof.manifest ? { ...proof.manifest, integrityStatus: integrity.valid ? proof.manifest.integrityStatus : "integrity-invalid" } : null,
      integrity
    });
  } catch (error) { next(error); }
});

app.get("/v1/conclusions/:id/proof", async (req, res, next) => {
  try {
    const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
    if (!runId) return void res.status(400).json({ error: "run_id_required" });
    const run = await runEventStore.get(runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const resultRunId = run.resultRunId ?? run.id;
    const bundle = await readRunBundle(resultRunId);
    const proof = await readProofArtifacts(resultRunId);
    const conclusion = proof.conclusions.find((item) => item.conclusionId === req.params.id);
    if (!conclusion) return void res.status(404).json({ error: "conclusion_not_found" });
    const nodeIds = new Set<string>([conclusion.conclusionId]);
    const edges = proof.proofEdges.filter((edge) => {
      if (!nodeIds.has(edge.fromId)) return false;
      nodeIds.add(edge.toId);
      return true;
    });
    for (let pass = 0; pass < 6; pass += 1) {
      for (const edge of proof.proofEdges) {
        if (nodeIds.has(edge.fromId)) nodeIds.add(edge.toId);
      }
    }
    const selectedEdges = proof.proofEdges.filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId));
    res.json({
      conclusion,
      edges: selectedEdges.length ? selectedEdges : edges,
      evidence: bundle.evidence.filter((item) => nodeIds.has(item.id)),
      artifacts: (bundle.artifactsV2 ?? []).filter((item) => nodeIds.has(item.id)),
      attempts: (bundle.attempts ?? []).filter((item) => nodeIds.has(item.id)),
      steps: bundle.result.steps.filter((item) => nodeIds.has(item.stepId)),
      manifest: proof.manifest ?? null
    });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/messages", async (req, res, next) => {
  try {
    const body = z.object({
      message: z.string().trim().min(1).max(4_000),
      credentialId: z.string().optional()
    }).parse(req.body);
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    await appendAgentMessage({ runId: run.id, role: "user", content: body.message });
    const project = typeof run.input.projectId === "string" ? await getProject(run.input.projectId) : undefined;
    const publicCredentials = await listCredentials();
    const selectedPublic = body.credentialId
      ? publicCredentials.find((item) => item.id === body.credentialId)
      : publicCredentials.find((item) => item.isDefault && !/api\.poe\.com/i.test(item.baseUrl))
        ?? publicCredentials.find((item) => !/api\.poe\.com/i.test(item.baseUrl));
    if (!selectedPublic) return void res.status(409).json({ error: "assistant_model_not_configured" });
    const credential = await getCredential(selectedPublic.id);
    if (!credential) return void res.status(409).json({ error: "assistant_model_not_configured" });
    const graph = await getAgentGraphProjection(run.id);
    const repairs = await listRepairSessions(run.id);
    const resultFacts = await readRunBundle(run.resultRunId ?? run.id)
      .then((bundle) => ({
        summary: bundle.result.summary,
        executionError: bundle.result.executionError,
        failedAssertions: bundle.result.assertions
          .filter((item) => !item.passed)
          .slice(0, 8)
          .map((item) => ({
            name: item.name,
            expected: item.expected,
            actual: item.actual,
            evidenceRefs: item.fact?.evidenceRefs ?? []
          })),
        failureAttributions: (bundle.result.failureAttributions ?? []).slice(0, 4).map((item) => ({
          title: item.title,
          reasoning: item.reasoning,
          suggestedFix: item.suggestedFix
        })),
        evidenceCount: bundle.evidence.length
      }))
      .catch(() => undefined);
    const runEvidenceRefs = Array.from(new Set(
      resultFacts?.failedAssertions.flatMap((item) => item.evidenceRefs) ?? []
    ));
    const knowledgeContext = createKnowledgeContext({
      purpose: "assistant",
      projectSnapshot: { projectId: project?.id ?? String(run.input.projectId) },
      claims: [
        {
          id: "user-message",
          statement: body.message,
          status: "user-provided",
          domain: "user-intent",
          sourceRefs: [`request:${run.id}:message`],
          confidence: 1
        },
        ...(project ? [{
          id: "project-record",
          statement: `Current project is ${project.name} (${project.id}).`,
          status: "retrieved" as const,
          domain: "project-static" as const,
          sourceRefs: [`project:${project.id}`],
          confidence: 1
        }] : []),
        {
          id: "run-state",
          subject: "run-state",
          statement: `Run ${run.id} is in state ${run.state}; final status is ${run.gateStatus ?? "not-decided"}.`,
          status: "observed",
          domain: "runtime",
          sourceRefs: [`run-event:${run.id}`],
          confidence: 1,
          observedAt: new Date().toISOString()
        },
        ...(run.machineGate ? [{
          id: "machine-gate",
          subject: "machine-gate",
          statement: `Machine gate is ${run.machineGate.status}: ${run.machineGate.reasons.join("; ") || "no reason supplied"}.`,
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: run.machineGate.reasonDetails?.flatMap((item) => item.evidenceRefs).filter(Boolean)
            ?? (runEvidenceRefs.length ? runEvidenceRefs : [`run-event:${run.id}`]),
          confidence: 1,
          observedAt: new Date().toISOString()
        }] : []),
        ...(resultFacts ? [{
          id: "saved-run-result",
          subject: "saved-run-result",
          statement: `Saved result summary: ${resultFacts.summary}; execution error: ${resultFacts.executionError ?? "none"}; failed assertions: ${resultFacts.failedAssertions.length}; evidence count: ${resultFacts.evidenceCount}.`,
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: runEvidenceRefs.length ? runEvidenceRefs : [`run-result:${run.resultRunId ?? run.id}`],
          confidence: 1,
          observedAt: new Date().toISOString()
        }] : []),
        ...repairs.slice(0, 3).map((repair) => ({
          id: `repair-${repair.id}`,
          statement: `Repair ${repair.id} status=${repair.status}; changed files=${repair.files.map((file) => file.path).join(", ") || "none"}; validation=${repair.validation?.status ?? "not-run"}.`,
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: [`repair:${repair.id}`],
          confidence: 1,
          observedAt: new Date().toISOString()
        }))
      ],
      allowedCapabilities: [
        "explain-status",
        "revise-plan",
        "start-run",
        "pause-run",
        "resume-run",
        "cancel-run",
        "open-evidence",
        "request-repair",
        "request-interrupt-resume"
      ],
      allowedTools: ["read-run-evidence", "read-repair-history"],
      unknowns: resultFacts ? [] : [{
        id: "saved-result-unavailable",
        question: "What durable execution result and evidence were saved for this run?",
        reason: "The run bundle could not be read, so execution details cannot be asserted.",
        blocking: true,
        resolvableBy: "tool",
        requestedTool: "read-run-evidence"
      }],
      untrustedInputKinds: ["requirement", "diff", "source", "dom", "console", "network", "prior-model-output"]
    });
    const replySchema = {
      type: "object",
      additionalProperties: false,
      required: ["reply", "reasoningSummary", "suggestedAction", "requiresConfirmation", "knowledge"],
      properties: {
        reply: { type: "string", minLength: 1, maxLength: 1_200 },
        reasoningSummary: assistantReasoningSummaryJsonSchema,
        suggestedAction: {
          type: "string",
          enum: [
            "none",
            "revise-plan",
            "start-run",
            "pause-run",
            "resume-run",
            "cancel-run",
            "resume-interrupt",
            "create-repair",
            "open-evidence"
          ]
        },
        requiresConfirmation: { type: "boolean" },
        knowledge: knowledgeBoundaryJsonSchema
      }
    } as const;
    const assistantSchema = z.object({
      reply: z.string().min(1).max(1_200),
      reasoningSummary: assistantReasoningSummarySchema,
      suggestedAction: z.enum([
        "none",
        "revise-plan",
        "start-run",
        "pause-run",
        "resume-run",
        "cancel-run",
        "resume-interrupt",
        "create-repair",
        "open-evidence"
      ]),
      requiresConfirmation: z.boolean(),
      knowledge: knowledgeBoundaryOutputSchema
    }).strict().superRefine((value, ctx) => {
      try {
        validateKnowledgeBoundaryOutput(value.knowledge, knowledgeContext);
        const capability = value.suggestedAction === "resume-interrupt"
          ? "request-interrupt-resume"
          : value.suggestedAction === "create-repair"
            ? "request-repair"
            : value.suggestedAction === "open-evidence"
              ? "open-evidence"
              : value.suggestedAction === "none"
                ? undefined
                : value.suggestedAction;
        if (capability) {
          assertKnowledgeCanAuthorizeAction({
            context: knowledgeContext,
            output: value.knowledge,
            action: capability,
            critical: value.suggestedAction !== "open-evidence"
          });
        }
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledge"],
          message: error instanceof Error ? error.message : "knowledge_boundary_invalid"
        });
      }
    });
    const structured = await executeStructuredAssistant({
      credential,
      apiKey: await decrypt(credential.apiKeyEncrypted),
      system: [
        "You are the assistant for an evidence-driven automated testing run.",
        "Use only the supplied durable run facts. Never claim pass from scheduling completion.",
        "Reply in concise Chinese with exactly three clearly labelled parts: 发生了什么、系统准备怎么处理、需要你做什么.",
        "Also return reasoningSummary as an evidence-backed decision summary for the user. It is not hidden chain-of-thought: list only observable facts, the concise assessment, the next system step, and the exact user action.",
        "If the user does not need to act, explicitly say 无需操作. If a repair session changed no files, explicitly say 未修改项目源码.",
        "Only claim code was repaired when repairHistory contains concrete changed files, and name those files.",
        "Do not push technical diagnosis back to the user when resultFacts already identify a timeout, selector, script, environment or product failure.",
        "When a test-script, selector or product failure has no repair yet, explain that the system can create and validate a sandbox repair, return suggestedAction=create-repair and require confirmation.",
        "Use open-evidence only when the saved facts are genuinely insufficient; use resume-interrupt for missing permission or credential confirmation.",
        "Do not invent evidence, credentials, commands or test results.",
        knowledgeBoundarySystemPolicy,
        "Return only the requested JSON."
      ].join(" "),
      prompt: JSON.stringify({
        userMessage: body.message,
        project: project ? { id: project.id, name: project.name } : undefined,
        run: {
          id: run.id,
          state: run.state,
          finalStatus: run.gateStatus,
          machineGate: run.machineGate,
          judgeRecommendation: run.judgeRecommendation,
          scenarioId: run.selectedScenarioId
        },
        graph,
        resultFacts,
        repairHistory: repairs.slice(0, 3).map((repair) => ({
          id: repair.id,
          status: repair.status,
          summary: repair.summary,
          failureClass: repair.failureClass,
          changedFiles: repair.files.map((file) => ({
            path: file.path,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            risk: file.risk
          })),
          validation: repair.validation ? {
            status: repair.validation.status,
            targetedPassed: repair.validation.targetedPassed,
            regressionPassed: repair.validation.regressionPassed,
            summary: repair.validation.summary
          } : undefined
        })),
        knowledgeContext: publicKnowledgeContext(knowledgeContext)
      }),
      schemaName: "agent_thread_reply",
      jsonSchema: replySchema,
      parseSchema: assistantSchema,
      knowledgeContext,
      context: {
        purpose: "assistant",
        runId: run.id,
        modelProfileId: credential.id,
        promptTemplateId: "run-assistant",
        promptVersion: "assistant-v2-knowledge-boundary",
        outputSchemaVersion: "agent-thread-reply-v2",
        graphVersion: "agent-graph-v1",
        routeReason: "user-requested-run-explanation",
        ruleCapable: false,
        cachePolicy: "bypass"
      }
    });
    await appendAgentMessage({
      runId: run.id,
      role: "assistant",
      content: structured.assistant.reply,
      reasoningSummary: structured.assistant.reasoningSummary,
      knowledgeContextId: structured.llm.knowledgeContext.id,
      knowledgeDecisionId: structured.llm.knowledgeDecision.id,
      llmCallId: structured.llm.call.id,
      suggestedAction: structured.assistant.suggestedAction
    });
    res.json({
      assistant: structured.assistant,
      call: {
        id: structured.llm.call.id,
        provider: structured.llm.call.provider,
        model: structured.llm.call.model,
        status: structured.llm.call.status,
        durationMs: structured.llm.call.durationMs,
        usage: structured.llm.call.usage,
        semanticRepairApplied: structured.repaired,
        knowledgeContextId: structured.llm.knowledgeContext.id,
        knowledgeDecisionId: structured.llm.knowledgeDecision.id,
        knowledgeValidationStatus: structured.llm.knowledgeDecision.validationStatus
      }
    });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/interrupts/:interruptId/resume", async (req, res, next) => {
  try {
    const body = z.object({
      approved: z.boolean(),
      input: z.record(z.unknown()).default({})
    }).parse(req.body);
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    const projection = await getAgentGraphProjection(run.id);
    const interrupt = projection?.pendingInterrupt;
    if (!interrupt || interrupt.id !== req.params.interruptId) {
      return void res.status(409).json({ error: "agent_interrupt_conflict" });
    }
    agentInterruptSchema.parse(interrupt);
    const agent = await resumeAgentGraph(run.id, { approved: body.approved, ...body.input });
    res.json({ agent });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/repairs", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ repairs: await listRepairSessions(run.id) });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/repairs", async (req, res, next) => {
  try {
    const body = z.object({
      autoAnalyze: z.boolean().default(true),
      credentialId: z.string().optional(),
      summary: z.string().max(2_000).optional()
    }).parse(req.body ?? {});
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "edit_sandbox");
    if (typeof run.input.projectId !== "string") return void res.status(409).json({ error: "run_project_missing" });
    const project = await getProject(run.input.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    let repair = await createRepairSession({
      runId: run.id,
      project,
      summary: body.summary,
      failureClass: run.machineGate?.status === "fail" ? "product-bug" : "unknown"
    });
    if (body.autoAnalyze) {
      repair = await proposeCodeRepair({ sessionId: repair.id, run, project, credentialId: body.credentialId });
    }
    res.status(201).json({ repair });
  } catch (error) { next(error); }
});

app.get("/v1/repair-sessions/:id", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    res.json({ repair });
  } catch (error) { next(error); }
});

app.get("/v1/repair-sessions/:id/files/*", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    const requestedPath = (req.params as Record<string, string>)["0"] ?? "";
    res.json({ file: await readRepairFile(repair.id, requestedPath) });
  } catch (error) { next(error); }
});

app.put("/v1/repair-sessions/:id/files/*", async (req, res, next) => {
  try {
    const body = z.object({
      content: z.string().max(1024 * 1024),
      expectedVersion: z.number().int().nonnegative()
    }).parse(req.body);
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const requestedPath = (req.params as Record<string, string>)["0"] ?? "";
    res.json({ repair: await writeRepairFile({ id: repair.id, path: requestedPath, ...body }) });
  } catch (error) { next(error); }
});

app.post("/v1/repair-sessions/:id/validate", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const project = await getProject(repair.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    res.json({ repair: await validateRepairSession(repair.id, project) });
  } catch (error) { next(error); }
});

app.post("/v1/repair-sessions/:id/export", async (req, res, next) => {
  try {
    const body = z.object({ format: z.enum(["patch", "zip"]) }).parse(req.body);
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "export_source");
    res.json(await exportRepairSession(repair.id, body.format));
  } catch (error) { next(error); }
});

app.post("/v1/repair-sessions/:id/apply", async (req, res, next) => {
  try {
    const body = z.object({ confirm: z.literal(true), confirmHighRisk: z.boolean().default(false) }).parse(req.body);
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "apply_source");
    const project = await getProject(repair.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    res.json({ repair: await applyRepairSession(repair.id, project, { confirmHighRisk: body.confirmHighRisk }) });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/stream", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let sentVersion = Number(req.header("last-event-id") ?? 0);
    let sentAgentUpdatedAt = "";
    const sentRepairUpdates = new Map<string, string>();
    const sentLlmCalls = new Map<string, string>();
    let sentEvidenceRoot = "";
    const unsubscribeLlm = subscribeLlmLifecycle(req.params.id, (event) => {
      res.write(`event: ${event.name}\ndata: ${JSON.stringify({
        callId: event.callId,
        at: event.at,
        ...event.payload
      })}\n\n`);
    });
    const unsubscribeKnowledge = subscribeKnowledgeLifecycle((event) => {
      if (event.runId !== req.params.id) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify({
        at: event.createdAt,
        ...event.payload
      })}\n\n`);
    });
    const send = async () => {
      const events = await runEventStore.events(req.params.id);
      for (const event of events.filter((item) => item.version > sentVersion)) {
        res.write(`id: ${event.version}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
        sentVersion = event.version;
      }
      const agent = await getAgentGraphProjection(req.params.id);
      if (agent && agent.updatedAt !== sentAgentUpdatedAt) {
        const eventName = agent.pendingInterrupt
          ? "agent.interrupt"
          : agent.status === "failed"
            ? "agent.node.failed"
            : agent.status === "completed"
              ? "agent.node.completed"
              : "agent.node.started";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(agent)}\n\n`);
        sentAgentUpdatedAt = agent.updatedAt;
      }
      const repairs = await listRepairSessions(req.params.id);
      for (const repair of repairs) {
        if (sentRepairUpdates.get(repair.id) === repair.updatedAt) continue;
        const eventName = repair.validation?.status === "running"
          ? "validation.started"
          : repair.validation && ["passed", "failed", "blocked"].includes(repair.validation.status)
            ? "validation.completed"
            : repair.status === "exported"
              ? "repair.exported"
              : sentRepairUpdates.has(repair.id)
                ? "repair.changed"
                : "repair.created";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(repair)}\n\n`);
        sentRepairUpdates.set(repair.id, repair.updatedAt);
      }
      for (const call of await listLlmCalls(req.params.id)) {
        const fingerprint = `${call.status}:${call.completedAt ?? call.startedAt}:${call.transportAttempts?.length ?? 0}`;
        if (sentLlmCalls.get(call.id) === fingerprint) continue;
        const eventName = call.status === "passed" ? "llm.call.completed" : "llm.call.failed";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(call)}\n\n`);
        for (const attempt of (call.transportAttempts ?? []).slice(1)) {
          res.write(`event: llm.call.retried\ndata: ${JSON.stringify({ callId: call.id, attempt })}\n\n`);
        }
        sentLlmCalls.set(call.id, fingerprint);
      }
      const currentRun = await runEventStore.get(req.params.id);
      const proof = await readProofArtifacts(currentRun?.resultRunId ?? req.params.id);
      if (proof.manifest && proof.manifest.evidenceSetRoot !== sentEvidenceRoot) {
        const resultRunId = currentRun?.resultRunId ?? req.params.id;
        const bundle = await readRunBundle(resultRunId);
        for (const artifact of bundle.result?.artifactsV2 ?? []) {
          res.write(`event: artifact.committed\ndata: ${JSON.stringify({
            runId: resultRunId,
            artifactId: artifact.id,
            attemptId: artifact.attemptId,
            stepId: artifact.stepId,
            kind: artifact.kind,
            origin: artifact.origin,
            integrity: artifact.integrity
          })}\n\n`);
        }
        res.write(`event: proof.${proof.manifest.integrityStatus === "integrity-invalid" ? "invalid" : "verified"}\ndata: ${JSON.stringify(proof.manifest)}\n\n`);
        for (const conclusion of proof.conclusions) {
          res.write(`event: conclusion.created\ndata: ${JSON.stringify(conclusion)}\n\n`);
        }
        sentEvidenceRoot = proof.manifest.evidenceSetRoot;
      }
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ runId: req.params.id, at: new Date().toISOString() })}\n\n`);
    };
    await send();
    const timer = setInterval(() => void send().catch(() => undefined), 1_000);
    req.once("close", () => {
      clearInterval(timer);
      unsubscribeLlm();
      unsubscribeKnowledge();
    });
  } catch (error) { next(error); }
});

app.post("/internal/v1/executions/:runId", requireInternalWorkerIdentity, async (req, res, next) => {
  try {
    res.json({ run: await executeQueuedRun(req.params.runId) });
  } catch (error) { next(error); }
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  projectPath: z.string().min(1),
  allowExternalProjectPath: z.boolean().optional(),
  installCommand: z.string().optional(),
  installCommandSpec: commandSpecSchema.optional(),
  startCommand: z.string().optional(),
  startCommandSpec: commandSpecSchema.optional(),
  processes: z.array(z.object({
    name: z.string().min(1),
    command: z.string().min(1),
    commandSpec: commandSpecSchema.optional(),
    healthCheckUrl: z.string().url().optional(),
    required: z.boolean().optional()
  })).optional(),
  healthCheckUrl: z.string().url().optional(),
  frontendUrl: z.string().url(),
  backendUrl: z.string().url().optional(),
  testCommand: z.string().optional(),
  testCommandSpec: commandSpecSchema.optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
  login: z
    .object({
      method: z.enum(["none", "form", "storage_state", "env"]),
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
      credentialId: z.string().optional(),
      loginUrl: z.string().url().optional()
    })
    .optional(),
  apiCredentialRequirements: z.array(z.object({
    envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    providerHint: z.string().max(80).optional(),
    baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    exposure: z.enum(["server", "browser"]),
    signals: z.array(z.string().max(500)).max(20)
  })).max(20).optional(),
  apiCredentialBindings: z.array(z.object({
    envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
    credentialId: z.string().min(1),
    source: z.enum(["test-system", "dedicated"]),
    baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    configuredAt: z.string().datetime()
  })).max(20).optional(),
  env: z.record(z.string()).optional(),
  cleanupCommand: z.string().optional(),
  cleanupCommandSpec: commandSpecSchema.optional(),
  timeoutMs: z.number().int().min(1000).optional(),
  externalSmokeProfile: z.object({
    login: z.object({
      usernameEnv: z.string().optional(),
      passwordEnv: z.string().optional(),
      expectedText: z.string().optional()
    }).optional(),
    keyPages: z.array(z.object({
      id: z.string(),
      path: z.string(),
      expectedHeading: z.string().optional()
    })).optional(),
    form: z.object({
      path: z.string().optional(),
      inputLabel: z.string(),
      inputValue: z.string(),
      submitButton: z.string(),
      expectedText: z.string()
    }).optional(),
    table: z.object({
      path: z.string().optional(),
      sortButton: z.string().optional(),
      filterLabel: z.string().optional(),
      filterValue: z.string().optional(),
      nextButton: z.string().optional(),
      expectedText: z.string()
    }).optional(),
    permission: z.object({
      roleControlLabel: z.string().optional(),
      roleValue: z.string().optional(),
      expectedText: z.string()
    }).optional(),
    apiSteps: z.array(z.object({
      id: z.string(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string(),
      expectedStatus: z.number().int().optional(),
      requiresAuth: z.boolean().optional()
    })).optional(),
    browserSteps: z.array(z.object({
      id: z.string(),
      action: z.enum(["click", "fill", "upload", "assert_text"]),
      label: z.string().optional(),
      value: z.string().optional(),
      expectedText: z.string().optional()
    })).optional()
  }).optional(),
  manifest: projectManifestSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional()
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    res.json({ projects: await listProjects() });
  } catch (error) {
    next(error);
  }
});

app.get("/v1/projects/manifest", async (req, res, next) => {
  try {
    const repositoryRoot = typeof req.query.repositoryRoot === "string" ? req.query.repositoryRoot : rootDir;
    const manifestPath = typeof req.query.manifestPath === "string" ? req.query.manifestPath : undefined;
    const manifest = await loadProjectManifest({ repositoryRoot, manifestPath });
    res.json({ manifest, project: manifestToProjectConfig(manifest, repositoryRoot) });
  } catch (error) {
    next(error);
  }
});

app.post("/v1/mission-preview", (req, res, next) => {
  try {
    res.json(createMissionPreview(req.body));
  } catch (error) { next(error); }
});

app.post("/v1/impact/code-graph", async (req, res, next) => {
  try {
    const body = z.object({
      repositoryRoot: z.string().min(1).default(rootDir),
      files: z.array(z.string().min(1)).max(1000),
      scope: z.enum(["changed-files", "repository"]).default("repository"),
      historicalBugs: z.array(z.object({ id: z.string(), title: z.string(), files: z.array(z.string()) })).max(500).optional()
    }).parse(req.body);
    const allowedRoot = path.resolve(process.env.WORKSPACE_ROOT ?? rootDir);
    const repositoryRoot = path.resolve(body.repositoryRoot);
    if (repositoryRoot !== allowedRoot && !repositoryRoot.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("impact_repository_outside_workspace");
    const scenarios = listScenarios().map((scenario) => ({ id: scenario.id, keywords: scenario.matcher?.keywords ?? [scenario.id] }));
    res.json({ graph: await buildCodeImpactGraph({ repositoryRoot, files: body.files, includeRepositorySources: body.scope === "repository", scenarios, historicalBugs: body.historicalBugs }) });
  } catch (error) { next(error); }
});

app.get("/api/benchmark/summary", async (_req, res, next) => {
  try {
    const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string }>;
    const blindCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string }>;
    const extendedCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "extended-cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string }>;
    const executionMap = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<{ logicalProjectId: string; executionProjectId: string; targetUrl?: string; targetKind?: string }> };
    const challengeCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "challenge-cases.json"), "utf8")) as Array<{ projectId: string }>;
    const catalog = buildBenchmarkCatalog({ development: cases, blind: blindCases, extended: extendedCases, mappings: executionMap.mappings, challengeProjectIds: challengeCases.map((item) => item.projectId) });
    const snapshot = await readFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), "utf8").then((value) => JSON.parse(value) as unknown).catch(() => undefined);
    const runtimeMetrics = trustedBenchmarkRuntimeMetrics(snapshot);
    res.json({
      version: "benchmark-v1",
      status: "catalog_ready",
      ...catalog,
      challengeCases: { count: challengeCases.length, projectIds: challengeCases.map((item) => item.projectId) },
      runtimeMetrics
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/detect", async (req, res, next) => {
  try {
    const body = z.object({ projectPath: z.string().min(1) }).parse(req.body);
    res.json({ detection: await detectProject(body.projectPath) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/choose-folder", async (_req, res, next) => {
  try {
    res.json({ selection: await chooseNativeProjectFolder() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/list-directory", async (req, res, next) => {
  try {
    const body = z.object({
      projectPath: z.string().min(1).max(4096),
      relativePath: z.string().max(4096).optional()
    }).parse(req.body);
    res.json({ entries: await listProjectDirectory(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/detect-manifest", async (req, res, next) => {
  try {
    const body = z.object({
      rootName: z.string().min(1).max(255),
      files: z.array(z.object({
        relativePath: z.string().min(1).max(1024),
        content: z.string().max(300_000).optional()
      })).max(250)
    }).parse(req.body);
    res.json({ detection: await detectProjectManifest(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", async (req, res, next) => {
  try {
    const project = await saveProject(projectSchema.parse(req.body) as ProjectConfig);
    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/login-credential", requireRole(["admin", "runner"]), async (req, res, next) => {
  try {
    const body = z.object({
      username: z.string().min(1).max(320),
      password: z.string().min(1).max(4096),
      usernameEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("E2E_USERNAME"),
      passwordEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("E2E_PASSWORD")
    }).parse(req.body);
    const current = await getProject(req.params.id);
    if (!current) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const credential = await saveProjectLoginSecret({
      projectId: current.id,
      username: body.username,
      password: body.password
    });
    const environmentAllowlist = Array.from(new Set([
      ...(current.manifest?.environmentAllowlist ?? []),
      body.usernameEnv,
      body.passwordEnv
    ]));
    const project = await saveProject({
      ...current,
      login: {
        method: "env",
        usernameEnv: body.usernameEnv,
        passwordEnv: body.passwordEnv,
        credentialId: credential.id
      },
      manifest: current.manifest ? {
        ...current.manifest,
        environmentAllowlist
      } : undefined
    });
    res.status(201).json({ project, credential });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/api-credential-binding", requireRole(["admin", "runner"]), async (req, res, next) => {
  try {
    const body = z.object({
      envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      credentialId: z.string().min(1),
      source: z.enum(["test-system", "dedicated"]),
      baseUrlEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      modelEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional()
    }).parse(req.body);
    const current = await getProject(req.params.id);
    if (!current) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const requirement = current.apiCredentialRequirements?.find((item) => item.envName === body.envName);
    if (!requirement) {
      res.status(400).json({ error: `Project does not declare API credential requirement ${body.envName}.` });
      return;
    }
    const credential = await getCredential(body.credentialId);
    if (!credential) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    const binding = {
      envName: body.envName,
      credentialId: body.credentialId,
      source: body.source,
      baseUrlEnv: body.baseUrlEnv ?? requirement.baseUrlEnv,
      modelEnv: body.modelEnv ?? requirement.modelEnv,
      configuredAt: new Date().toISOString()
    };
    const apiCredentialBindings = [
      ...(current.apiCredentialBindings ?? []).filter((item) => item.envName !== body.envName),
      binding
    ];
    const environmentAllowlist = Array.from(new Set([
      ...(current.manifest?.environmentAllowlist ?? []),
      binding.envName,
      binding.baseUrlEnv,
      binding.modelEnv
    ].filter((value): value is string => Boolean(value))));
    const project = await saveProject({
      ...current,
      apiCredentialBindings,
      manifest: current.manifest ? { ...current.manifest, environmentAllowlist } : undefined
    });
    res.status(201).json({
      project,
      binding,
      credential: {
        id: credential.id,
        name: credential.name,
        provider: credential.provider,
        model: credential.model,
        apiKeyMasked: credential.apiKeyMasked
      }
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/projects/:id", async (req, res, next) => {
  try {
    const current = await getProject(req.params.id);
    if (!current) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const project = await saveProject(projectSchema.parse({ ...current, ...req.body, id: req.params.id }) as ProjectConfig);
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/runtime", async (req, res, next) => {
  try {
    res.json({ runtime: await getProjectRuntimeStatusWithRecovery(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/target-contract", async (req, res, next) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ contract: toTargetProjectConfig(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/test-connection", async (req, res, next) => {
  try {
    const project = await refreshExternalProjectLaunchContract(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ result: await testProjectConnection(project) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/diagnose", async (req, res, next) => {
  try {
    await refreshExternalProjectLaunchContract(req.params.id);
    res.json({ diagnosis: await diagnoseProject(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id/grants", async (req, res, next) => {
  try {
    res.json({ grants: await listProjectGrants(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/grants", requireRole(["admin"]), async (req, res, next) => {
  try {
    const body = z.object({
      subject: z.string().min(1),
      role: z.enum(["viewer", "runner", "maintainer", "project_admin", "operator", "admin"]),
      expiresAt: z.string().optional(),
      scopes: z.array(z.enum([
        "read_project",
        "run_tests",
        "read_artifacts",
        "edit_sandbox",
        "export_source",
        "apply_source",
        "manage_project",
        "manage_credentials",
        "admin"
      ])).optional()
    }).parse(req.body);
    res.status(201).json({ grant: await createProjectGrant({ ...body, projectId: req.params.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/grants/:grantId", requireRole(["admin"]), async (req, res, next) => {
  try {
    res.json({ deleted: await deleteProjectGrant(req.params.id, req.params.grantId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/start", async (req, res, next) => {
  try {
    res.json({ runtime: await startProjectWithFreshConfig(req.params.id) });
  } catch (error) {
    next(error);
  }
});

// The interactive Workbench must not hold the browser request open while an
// install or health check runs. The task is still owned by the Agent; clients
// observe it through the runtime endpoint until a terminal status is reached.
app.post("/api/projects/:id/start-async", (req, res, next) => {
  try {
    if (!projectStartTasks.has(req.params.id)) {
      const previous = getProjectRuntimeStatus(req.params.id);
      // Return a fresh in-progress state immediately. Without this marker the
      // first poll after a retry can receive a failed status from an earlier
      // attempt and the Workbench appears to flash/exit before the new task
      // has even reached startProject.
      recordProjectRuntimeStatus({
        projectId: req.params.id,
        status: "starting",
        phase: "starting_processes",
        updatedAt: new Date().toISOString(),
        frontendUrl: previous.frontendUrl,
        backendUrl: previous.backendUrl,
        healthCheckUrl: previous.healthCheckUrl,
        message: "Start task accepted; preparing the project runtime.",
        failureReason: "none"
      });
      const task = startProjectWithFreshConfig(req.params.id)
        .then((status) => {
          if (!["installing", "starting", "running"].includes(status.status)) recordProjectRuntimeStatus(status);
          return status;
        })
        .catch(() => {
          const failed = {
            ...getProjectRuntimeStatus(req.params.id),
            projectId: req.params.id,
            status: "failed" as const,
            phase: "failed" as const,
            remainingMs: 0,
            updatedAt: new Date().toISOString(),
            stoppedAt: new Date().toISOString(),
            failureReason: "unknown" as const,
            message: "Project start task failed unexpectedly. Retry after the Agent is healthy."
          };
          recordProjectRuntimeStatus(failed);
          return failed;
        })
        .finally(() => projectStartTasks.delete(req.params.id));
      projectStartTasks.set(req.params.id, task);
      task.catch(() => undefined);
    }
    res.status(202).json({ accepted: true, runtime: getProjectRuntimeStatus(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/ai-start-recovery", async (req, res, next) => {
  try {
    const body = z.object({ credentialId: z.string().optional() }).parse(req.body ?? {});
    const project = await getProject(req.params.id);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const runtime = getProjectRuntimeStatus(req.params.id);
    if (runtime.status !== "failed") return void res.status(409).json({ error: "runtime_not_failed" });
    const advice = await createRuntimeRecoveryAdvice({ project, runtime, credentialId: body.credentialId });
    res.json({ advice });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/stop", async (req, res, next) => {
  try {
    res.json({ runtime: await stopProject(req.params.id) });
  } catch (error) {
    next(error);
  }
});

function withConnectorDemoDefaults(input: z.infer<typeof connectorContextSchema>) {
  if (input.strictInput) return input;
  return {
    ...input,
    requirementPath:
      input.requirementPath ?? (input.requirementUrl ? undefined : "data/fixtures/task-filter-requirement.md"),
    bugTicketPath:
      input.bugTicketPath ?? (input.bugTicketUrl ? undefined : "data/fixtures/tapd-task-filter-bug.md")
  };
}

app.post("/api/connectors/context", async (req, res, next) => {
  try {
    const body = withConnectorDemoDefaults(connectorContextSchema.parse(req.body));
    res.json({ context: await readConnectorContext(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/intake/analyze-connected", async (req, res, next) => {
  try {
    const body = withConnectorDemoDefaults(connectorContextSchema.parse(req.body));
    const context = await readConnectorContext(body);
    res.json({
      context,
      analysis: analyzeIntake({
        requirement: context.requirement,
        diff: context.diff,
        bugTicket: context.bugTicket,
        prUrl: context.prUrl,
        sources: context.sources,
        sourceContexts: context.sourceContexts
      })
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/intake/analyze", (req, res, next) => {
  try {
    const body = z
      .object({
        requirement: z.string().default(""),
        diff: z.string().default(""),
        bugTicket: z.string().optional(),
        prUrl: z.string().optional(),
        projectId: z.string().optional()
      })
      .parse(req.body);
    res.json({ analysis: analyzeIntake(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/planning/conversation", async (req, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().min(1),
      message: z.string().trim().min(1).max(20_000),
      diff: z.string().max(2_000_000).default(""),
      bugTicket: z.string().max(200_000).optional(),
      planningMode: z.enum(["llm-guided", "scan-only"]).default("llm-guided"),
      credentialId: z.string().optional(),
      history: z.array(z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        content: z.string().max(20_000),
        createdAt: z.string()
      })).max(100).default([])
    }).parse(req.body);
    const project = await getProject(body.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const scenarioContracts = listScenarios()
      .filter((scenario) => !scenario.matcher?.projectIds?.length || scenario.matcher.projectIds.includes(project.id))
      .map((scenario) => ({
      id: scenario.id,
      keywords: scenario.matcher?.keywords ?? [scenario.id, scenario.title]
      }));
    const graph = await buildCodeImpactGraph({
      repositoryRoot: project.projectPath,
      files: changedFilesFromDiff(body.diff),
      diff: body.diff || undefined,
      includeRepositorySources: true,
      scenarios: scenarioContracts,
      cacheFile: path.join(reportsDir, "planning-cache", `${project.id}.json`)
    });
    const analysis = analyzeIntake({
      projectId: project.id,
      requirement: body.message,
      diff: body.diff,
      bugTicket: body.bugTicket,
      codeGraph: graph
    });
    const planning = buildPlanningConversation({
      project,
      message: body.message,
      history: body.history,
      graph,
      analysis
    });
    if (body.planningMode === "llm-guided") {
      const advice = await createLlmPlanningAdvice({
        project,
        goal: body.message,
        flows: planning.businessFlows,
        credentialId: body.credentialId
      });
      planning.llmPlanning = advice;
      if (advice.status === "passed") {
        planning.reply = `${planning.reply}\n\nAI 规划建议：${advice.summary}`;
        planning.clarificationQuestions = [...new Set([...planning.clarificationQuestions, ...advice.clarificationQuestions])].slice(0, 6);
      }
    }
    res.json({ planning });
  } catch (error) {
    next(error);
  }
});

app.post("/api/assistant/chat", async (req, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().min(1),
      message: z.string().trim().min(1).max(4_000),
      credentialId: z.string().optional(),
      history: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4_000)
      })).max(12).default([]),
      context: z.object({
        runId: z.string().optional(),
        runState: z.string().optional(),
        finalStatus: z.string().optional(),
        summary: z.string().max(2_000).optional(),
        evidenceCount: z.number().int().nonnegative().optional(),
        currentStep: z.string().max(500).optional(),
        latestLog: z.string().max(1_000).optional(),
        failedAssertions: z.array(z.object({
          name: z.string().max(300),
          expected: z.string().max(800),
          actual: z.string().max(800)
        })).max(8).default([]),
        planning: z.object({
          discovered: z.number().int().nonnegative(),
          executable: z.number().int().nonnegative(),
          autoBindable: z.number().int().nonnegative(),
          confirmed: z.boolean()
        }).optional()
      }).default({ failedAssertions: [] })
    }).parse(req.body);
    const project = await getProject(body.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const publicCredentials = await listCredentials();
    const selectedPublic = body.credentialId
      ? publicCredentials.find((item) => item.id === body.credentialId)
      : publicCredentials.find((item) => item.isDefault && !/api\.poe\.com/i.test(item.baseUrl))
        ?? publicCredentials.find((item) => !/api\.poe\.com/i.test(item.baseUrl));
    if (!selectedPublic || /api\.poe\.com/i.test(selectedPublic.baseUrl)) {
      return void res.status(409).json({ error: "assistant_model_not_configured" });
    }
    const credential = await getCredential(selectedPublic.id);
    if (!credential) return void res.status(409).json({ error: "assistant_model_not_configured" });
    const knowledgeContext = createKnowledgeContext({
      purpose: "assistant",
      projectSnapshot: { projectId: project.id },
      claims: [
        {
          id: "user-message",
          statement: body.message,
          status: "user-provided",
          domain: "user-intent",
          sourceRefs: [`request:${project.id}:message`],
          confidence: 1
        },
        {
          id: "project-record",
          statement: `Current project is ${project.name} (${project.id}).`,
          status: "retrieved",
          domain: "project-static",
          sourceRefs: [`project:${project.id}`],
          confidence: 1
        },
        {
          id: "client-workbench-context",
          subject: "client-workbench-context",
          statement: `Workbench reports runState=${body.context.runState ?? "unknown"}, finalStatus=${body.context.finalStatus ?? "unknown"}, currentStep=${body.context.currentStep ?? "unknown"}, evidenceCount=${body.context.evidenceCount ?? "unknown"}.`,
          status: "inferred",
          domain: "runtime",
          sourceRefs: [`workbench-context:${body.context.runId ?? "pre-run"}`],
          confidence: 0.6
        }
      ],
      allowedCapabilities: [
        "explain-status",
        "revise-plan",
        "start-run",
        "pause-run",
        "resume-run",
        "cancel-run",
        "open-evidence"
      ],
      allowedTools: ["read-project-manifest", "read-run-evidence"],
      unknowns: body.context.runId ? [] : [{
        id: "durable-run-not-created",
        question: "What is the durable run state and evidence?",
        reason: "No runId exists yet; client planning state must not be presented as executed test evidence.",
        blocking: false,
        resolvableBy: "none"
      }],
      untrustedInputKinds: ["requirement", "diff", "source", "dom", "console", "network", "prior-model-output"]
    });
    const responseSchema = {
      type: "object",
      additionalProperties: false,
      required: ["reply", "reasoningSummary", "intent", "suggestedAction", "requiresConfirmation", "knowledge"],
      properties: {
        reply: { type: "string", minLength: 1, maxLength: 1_200 },
        reasoningSummary: assistantReasoningSummaryJsonSchema,
        intent: { type: "string", enum: ["status-question", "failure-question", "plan-change", "execution-control", "general"] },
        suggestedAction: { type: "string", enum: ["none", "revise-plan", "start-run", "pause-run", "resume-run", "cancel-run", "open-evidence"] },
        requiresConfirmation: { type: "boolean" },
        knowledge: knowledgeBoundaryJsonSchema
      }
    } as const;
    const system = [
      "You are the conversational assistant inside an evidence-driven browser testing product.",
      "Answer the user's question directly in concise Chinese using only the supplied run and planning facts.",
      "For a blocker, review request or repair question, reply with three clearly labelled parts: 发生了什么、系统准备怎么处理、需要你做什么.",
      "Return reasoningSummary as a short evidence-backed decision summary. Do not reveal hidden chain-of-thought; include only observed facts, concise assessment, next system step and exact user action.",
      "If no user action is required, explicitly say 无需操作. Never claim source code changed unless the supplied facts contain concrete changed files.",
      "Never claim a test passed merely because scheduling completed.",
      "Never invent screenshots, evidence, failures, credentials, actions, or API results.",
      "You may suggest an action but must require confirmation for starting, pausing, resuming, cancelling, or revising a plan.",
      knowledgeBoundarySystemPolicy,
      "Return only the requested JSON object."
    ].join(" ");
    const prompt = JSON.stringify({
      project: { id: project.id, name: project.name },
      userMessage: body.message,
      recentConversation: body.history,
      currentFacts: body.context,
      knowledgeContext: publicKnowledgeContext(knowledgeContext)
    });
    const apiKey = await decrypt(credential.apiKeyEncrypted);
    const assistantSchema = z.object({
      reply: z.string().min(1).max(1_200),
      reasoningSummary: assistantReasoningSummarySchema,
      intent: z.enum(["status-question", "failure-question", "plan-change", "execution-control", "general"]),
      suggestedAction: z.enum(["none", "revise-plan", "start-run", "pause-run", "resume-run", "cancel-run", "open-evidence"]),
      requiresConfirmation: z.boolean(),
      knowledge: knowledgeBoundaryOutputSchema
    }).strict().superRefine((value, ctx) => {
      try {
        validateKnowledgeBoundaryOutput(value.knowledge, knowledgeContext);
        const capability = value.suggestedAction === "none" ? undefined : value.suggestedAction;
        if (capability) {
          assertKnowledgeCanAuthorizeAction({
            context: knowledgeContext,
            output: value.knowledge,
            action: capability,
            critical: capability !== "open-evidence"
          });
        }
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledge"],
          message: error instanceof Error ? error.message : "knowledge_boundary_invalid"
        });
      }
    });
    const structured = await executeStructuredAssistant({
      credential,
      apiKey,
      system,
      prompt,
      schemaName: "test_assistant_reply",
      jsonSchema: responseSchema,
      parseSchema: assistantSchema,
      knowledgeContext,
      context: {
        purpose: "assistant",
        modelProfileId: credential.id,
        promptTemplateId: "test-assistant",
        promptVersion: "assistant-v2-knowledge-boundary",
        outputSchemaVersion: "test-assistant-reply-v2",
        projectDigest: project.id,
        routeReason: "user-requested-planning-assistance",
        ruleCapable: false,
        cachePolicy: "bypass"
      }
    });
    res.json({
      assistant: structured.assistant,
      call: {
        id: structured.llm.call.id,
        model: structured.llm.call.model,
        provider: structured.llm.call.provider,
        status: structured.llm.call.status,
        durationMs: structured.llm.call.durationMs,
        usage: structured.llm.call.usage,
        semanticRepairApplied: structured.repaired,
        knowledgeContextId: structured.llm.knowledgeContext.id,
        knowledgeDecisionId: structured.llm.knowledgeDecision.id,
        knowledgeValidationStatus: structured.llm.knowledgeDecision.validationStatus
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/generate-plan", async (req, res, next) => {
  try {
    const body = z
      .object({
        requirement: z.string().min(1),
        diff: z.string().min(1),
        credentialId: z.string().optional()
      })
      .parse(req.body);
    res.json(await generatePlan(body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/commit-check/run", async (req, res, next) => {
  try {
    const body = connectorContextSchema
      .extend({
        ...runnableTargetShape,
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        notify: z.array(z.string()).default(["oncall"]),
        permissionProfile: permissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    res.json({ check: await runCommitCheck(body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/commit-checks", async (_req, res, next) => {
  try {
    res.json({ checks: await listCommitChecks() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/requirement-acceptance/run", async (req, res, next) => {
  try {
    const body = connectorContextSchema
      .extend({
        ...runnableTargetShape,
        requirement: z.string().optional(),
        diff: z.string().optional(),
        bugTicket: z.string().optional(),
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        notify: z.array(z.string()).default(["product-owner", "qa-oncall"]),
        permissionProfile: permissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    res.json({ acceptance: await runRequirementAcceptance(body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/requirement-acceptances", async (_req, res, next) => {
  try {
    res.json({ acceptances: await listRequirementAcceptances() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/refine-plan", async (req, res, next) => {
  try {
    const body = z
      .object({
        currentPlan: z.any(),
        feedback: z.string().min(1),
        failedAssertionNames: z.array(z.string()).default([])
      })
      .parse(req.body);
    res.json(proposePlanRefinement(body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/run-visual-test", requireInternalWorkerIdentity, async (req, res, next) => {
  try {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Wed, 14 Oct 2026 00:00:00 GMT");
    const body = z
      .object({
        ...runnableTargetShape,
        planId: z.string().optional(),
        keepProjectRunning: z.boolean().optional(),
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        trigger: z.enum(["manual", "commit", "requirement", "patrol"]).optional(),
        requirement: z.string().optional(),
        diff: z.string().optional(),
        bugTicket: z.string().optional(),
        plan: z.any().optional(),
        sourceContexts: z.array(z.any()).optional(),
        impactAnalysis: z.any().optional(),
        executablePlan: z.any().optional(),
        permissionProfile: permissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    const result = await runVisualGrayTest(body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/discovery/scan", async (req, res, next) => {
  try {
    const body = z
      .object({
        ...runnableTargetShape,
        sourceContexts: z.array(z.any()).optional(),
        goal: z.string().trim().max(20_000).optional(),
        credentialId: z.string().optional()
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    res.json({ discovery: await runDiscoveryScan(body) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/patrol/jobs", (_req, res) => {
  res.json({ jobs: listPatrolJobs() });
});

app.get("/api/patrol/plans", async (_req, res, next) => {
  try {
    res.json({ plans: await listPatrolPlans() });
  } catch (error) {
    next(error);
  }
});

const patrolPlanSchema = z.object({
  id: z.string().default("core_path_daily"),
  title: z.string().optional(),
  appUrl: z.string().url().optional(),
  projectId: z.string().optional(),
  target: targetRuntimeSchema.optional(),
  scenarioId: z.string().optional(),
  intervalMs: z.number().int().min(10_000).optional(),
  cron: z.string().optional(),
  notify: z.array(z.string()).optional(),
  permissionProfile: permissionProfileSchema.optional(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0),
    backoffMs: z.number().int().min(0)
  }).optional(),
  escalationPolicy: z.object({
    failureThreshold: z.number().int().min(1),
    riskTrendThreshold: z.enum(["regressed", "stable", "any"]),
    notify: z.array(z.string())
  }).optional(),
  status: z.enum(["running", "stopped"]).optional()
});

app.post("/api/patrol/plans", async (req, res, next) => {
  try {
    res.status(201).json({ plan: await upsertPatrolPlan(patrolPlanSchema.parse(req.body)) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/patrol/plans/:id", async (req, res, next) => {
  try {
    res.json({ plan: await upsertPatrolPlan({ ...patrolPlanSchema.partial().parse(req.body), id: req.params.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/patrol/plans/:id", async (req, res, next) => {
  try {
    res.json({ deleted: await deletePatrolPlan(req.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/patrol/runs", async (_req, res, next) => {
  try {
    res.json({ patrolRuns: await listPatrolRuns() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/patrol/start", (req, res, next) => {
  try {
    const body = z
      .object({
        id: z.string().default("core_path_daily"),
        title: z.string().optional(),
        appUrl: z.string().url().optional(),
        projectId: z.string().optional(),
        target: targetRuntimeSchema.optional(),
        scenarioId: z.string().optional(),
        intervalMs: z.number().int().min(10_000).optional(),
        notify: z.array(z.string()).optional(),
        permissionProfile: permissionProfileSchema
      })
      .parse(req.body);
    res.json({ job: startPatrolJob(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/patrol/stop", (req, res, next) => {
  try {
    const body = z.object({ id: z.string().default("core_path_daily") }).parse(req.body);
    res.json({ job: stopPatrolJob(body.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/patrol/run-now", async (req, res, next) => {
  try {
    const body = z
      .object({
        ...runnableTargetShape,
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        requirement: z.string().optional(),
        diff: z.string().optional(),
        plan: z.any().optional(),
        notify: z.array(z.string()).default(["oncall"]),
        permissionProfile: permissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    const patrol = await runPatrolNow({
      appUrl: body.appUrl,
      projectId: body.projectId,
      target: body.target,
      scenarioId: body.scenarioId,
      credentialId: body.credentialId,
      requirement: body.requirement,
      diff: body.diff,
      plan: body.plan,
      notify: body.notify,
      permissionProfile: body.permissionProfile
    });
    res.json(patrol);
  } catch (error) {
    next(error);
  }
});

app.post("/api/patrol/plans/:id/run-now", async (req, res, next) => {
  try {
    const plan = (await listPatrolPlans()).find((item) => item.id === req.params.id);
    if (!plan) {
      res.status(404).json({ error: "Patrol plan not found" });
      return;
    }
    res.json(await runPatrolNow({
      appUrl: plan.appUrl,
      projectId: plan.projectId,
      target: plan.target,
      jobId: plan.id,
      scenarioId: plan.scenarioId,
      notify: plan.notify,
      permissionProfile: plan.permissionProfile
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/patrol/trends", async (req, res, next) => {
  try {
    res.json({ trend: await patrolTrend({
      projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
      scenarioId: typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined
    }) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bot/deliveries", async (_req, res, next) => {
  try {
    res.json({ deliveries: await listBotDeliveries() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/bot/deliveries", async (req, res, next) => {
  try {
    const body = z
      .object({
        runId: z.string().optional(),
        provider: z.enum(["wecom", "feishu", "slack", "github_pr_comment", "generic", "simulated"]).optional(),
        channel: z.string().optional(),
        recipients: z.array(z.string()).optional(),
        includeScreenshots: z.boolean().optional(),
        githubPrUrl: z.string().url().optional()
      })
      .parse(req.body);
    const runId = body.runId ?? (await readLatestRunId());
    if (!runId) {
      res.status(404).json({ error: "No run has been recorded yet" });
      return;
    }
    const bundle = await readRunBundle(runId);
    const delivery = await buildDeliveryFromRun({
      bundle,
      provider: body.provider,
      channel: body.channel,
      recipients: body.recipients,
      includeScreenshots: body.includeScreenshots,
      githubPrUrl: body.githubPrUrl
    });
    res.status(201).json({ delivery });
  } catch (error) {
    next(error);
  }
});

app.get("/api/security/summary", (_req, res) => {
  res.json({
    security: {
      ...securitySummary(),
      grants: "project-scoped grants available",
      credentialRotation: "supported",
      artifactAccess: securitySummary().artifactAccess
    }
  });
});

app.get("/api/audit-log", async (_req, res, next) => {
  try {
    res.json({ events: await readAuditLog() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/latest", async (_req, res, next) => {
  try {
    const runId = await readLatestRunId();
    if (!runId) {
      res.status(404).json({ error: "No run has been recorded yet" });
      return;
    }
    res.json(await readRunBundle(runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId", async (req, res, next) => {
  try {
    res.json(await readRunBundle(req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/evidence", async (req, res, next) => {
  try {
    const evidence = readEvidenceFromAuditStore(req.params.runId);
    // Loop events are written throughout browser execution, while the final
    // run bundle is only committed after judging. Returning both lets the
    // Workbench render truthful, per-step live logs instead of guessing from
    // coarse control-plane state transitions.
    res.json({
      evidence: evidence.length ? evidence : await readEvidence(req.params.runId),
      loopEvents: await readLoopEvents(req.params.runId)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/findings", (_req, res, next) => {
  try {
    res.json({ findings: readFindingsFromAuditStore(_req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/judge-summary", (req, res, next) => {
  try {
    res.json({ judge: readJudgeSummaryFromAuditStore(req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:runId/download-bundle", async (req, res, next) => {
  try {
    const body = z.object({ maxInlineBytes: z.number().int().positive().optional() }).parse(req.body ?? {});
    const bundle = await readRunBundle(req.params.runId);
    const runDir = path.join(reportsDir, "runs", req.params.runId);
    const archive = await buildRunBundleArchive({
      bundle,
      outputFile: path.join(runDir, "run-bundle.zip"),
      manifestFile: path.join(runDir, "run-bundle-download-manifest.json"),
      reportsDir,
      maxInlineBytes: body.maxInlineBytes
    });
    res.json({
      archive: {
        zipFile: artifactUrl(archive.zipFile),
        manifestFile: artifactUrl(archive.manifestFile),
        manifest: archive.manifest
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/loop-events", async (req, res, next) => {
  try {
    res.json({ events: await readLoopEvents(req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/loop-events/latest", async (_req, res, next) => {
  try {
    res.json({ events: await readLatestLoopEvents() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/live-run/latest", async (_req, res, next) => {
  try {
    const events = await readLatestLoopEvents();
    const runId = events.at(-1)?.runId ?? (await readLatestRunId());
    const evidence = runId ? await readEvidence(runId) : [];
    const latestScreenshot = [...evidence].reverse().find((item) => item.type === "screenshot")?.file;
    const latestEvent = events.at(-1);
    const finished = events.some((event) => event.action === "generate_report" || event.title.includes("报告已生成"));
    res.json({
      runId,
      status: finished ? "finished" : runId ? "running" : "idle",
      latestScreenshot,
      latestEvent,
      evidenceCount: evidence.length,
      events,
      evidence
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/run-history", async (_req, res, next) => {
  try {
    const projectId = typeof _req.query.projectId === "string" ? _req.query.projectId : undefined;
    const scenarioId = typeof _req.query.scenarioId === "string" ? _req.query.scenarioId : undefined;
    const verdict = typeof _req.query.verdict === "string" ? _req.query.verdict : undefined;
    const from = typeof _req.query.from === "string" ? Date.parse(_req.query.from) : undefined;
    const to = typeof _req.query.to === "string" ? Date.parse(_req.query.to) : undefined;
    const limit = typeof _req.query.limit === "string" ? Number(_req.query.limit) : undefined;
    let runs = await listRunHistory();
    if (projectId) runs = runs.filter((run) => run.projectId === projectId);
    if (scenarioId) runs = runs.filter((run) => run.scenarioId === scenarioId);
    if (verdict) runs = runs.filter((run) => run.verdict === verdict);
    if (Number.isFinite(from)) runs = runs.filter((run) => Date.parse(run.timestamp) >= from!);
    if (Number.isFinite(to)) runs = runs.filter((run) => Date.parse(run.timestamp) <= to!);
    if (Number.isFinite(limit) && limit && limit > 0) runs = runs.slice(-Math.min(limit, 500));
    res.json({ runs });
  } catch (error) {
    next(error);
  }
});

app.get("/api/storage/status", async (_req, res, next) => {
  try {
    res.json({ storage: await storageStatus() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/storage/archives", async (_req, res, next) => {
  try {
    res.json({ archives: await listStorageArchives() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/storage/retention/run", async (req, res, next) => {
  try {
    const body = z.object({
      apply: z.boolean().default(false),
      archive: z.boolean().default(true)
    }).parse(req.body ?? {});
    res.json({ retention: await runStorageRetention(body) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/environment-check", async (req, res, next) => {
  try {
    const body = z.object(runnableTargetShape).superRefine(requireRunnableTarget).parse(req.body);
    const target = await resolveProjectTarget(body);
    res.json(await checkEnvironment(target.frontendUrl));
  } catch (error) {
    next(error);
  }
});

app.get("/api/desktop-capture/status", async (_req, res, next) => {
  try { res.json(await desktopCaptureStatus()); } catch (error) { next(error); }
});

app.post("/api/desktop-capture/screenshot", async (req, res, next) => {
  try {
    const body = z.object({
      bundleId: z.string().min(1),
      windowId: z.string().min(1),
      approvalEventId: z.string().min(1),
      outputPath: z.string().startsWith("reports/"),
      allowedBundleIds: z.array(z.string().min(1)).optional()
    }).parse(req.body);
    res.json(await captureDesktopScreenshot(body));
  } catch (error) {
    next(error);
  }
});

app.use(errorHandler);

assertSecurityConfig(host);
app.listen(port, host, () => {
  console.log(`AI Test Officer agent listening on http://${host}:${port}`);
  console.log("Security boundary:", securitySummary());
});
