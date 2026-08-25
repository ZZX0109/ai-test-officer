import "./setupProxyDispatcher.js";
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
import { redactText, redactValue } from "./redaction.js";
import { readConnectorContext } from "./sourceConnectors.js";
import { readAuditLog } from "./auditLog.js";
import { readEvidence, readLatestRunId, readRunBundle } from "./evidenceStore.js";
import {
  resolveRunRepairPlan,
  toAssistantRepairDecision,
  toRepairPlanPayload
} from "./repairPlan.js";
import { finalizeProofBundle, proofCredibility } from "./proof/proofBundleService.js";
import { readLatestLoopEvents, readLoopEvents } from "./loopEventStore.js";
import { listRunHistory } from "./runHistory.js";
import { captureDesktopScreenshot, desktopCaptureStatus } from "./desktopCaptureAdapter.js";
import { checkEnvironment } from "./environmentCheck.js";
import { readinessRouter } from "./server/routes/readiness.routes.js";
import { reviewRouter } from "./server/routes/review.routes.js";
import { credentialSetupRouter } from "./server/routes/credential-setup.routes.js";
import { credentialAdminRouter } from "./server/routes/credential-admin.routes.js";
import { legacyReportsRouter } from "./server/routes/legacy-reports.routes.js";
import { projectRouter } from "./server/routes/projects.routes.js";
import { patrolRouter } from "./server/routes/patrol.routes.js";
import { runInspectionRouter } from "./server/routes/run-inspection.routes.js";
import { runStreamRouter } from "./server/routes/run-stream.routes.js";
import { connectorContextSchema, workbenchOperationsRouter } from "./server/routes/workbench-operations.routes.js";
import { runRepairSessionRouter } from "./server/routes/run-repair-session.routes.js";
import { runCreationRouter } from "./server/routes/run-creation.routes.js";
import { runControlRouter } from "./server/routes/run-control.routes.js";
import { createRunAccessService } from "./server/services/runAccess.service.js";
import { createProjectRuntimeService } from "./server/services/projectRuntime.service.js";
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
import { planRouter } from "./server/routes/plan.routes.js";
import { projectMemberRouter } from "./server/routes/projectMember.routes.js";
import { repairRouter } from "./server/routes/repair.routes.js";
import {
  executableTestPlanSchema,
  grayPlanSchema,
  impactAnalysisSchema,
  sourceReadEnvelopeSchema
} from "./server/schemas/execution.schemas.js";
import { testCredentialConnection } from "./testConnection.js";
import { executeLlmCall, listLlmCalls } from "./llmProvider.js";
import { readLlmBudgetLedger } from "./llmBudgetLedger.js";
import { subscribeLlmLifecycle } from "./llmLifecycle.js";
import {
  createKnowledgeContext,
  publicKnowledgeContext,
  validateKnowledgeBoundaryOutput
} from "./knowledgeBoundary.js";
import { executeKnowledgeBoundedLlm } from "./knowledge-boundary/executeKnowledgeBoundedLlm.js";
import { summarizeEvidenceForModel } from "./knowledge-boundary/toolBroker.js";
import {
  compactAssistantContext,
  compactKnowledgeStatement,
  normalizeAssistantOutputShape
} from "./assistantContext.js";
import {
  assistantReplyNeedsNormalization,
  buildDeterministicAssistantFallback,
  deterministicAssistantCall,
  deterministicAssistantCommandCall,
  requestedAssistantAction
} from "./assistantFallback.js";
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
  readProofArtifacts,
  verifyEvidenceManifest
} from "./proofGraph.js";
import { runVisualGrayTest } from "./testRunner.js";
import {
  overlayArtifactObjectStoreStates,
  revalidateArtifactObjectStoreState
} from "./executionPersistence.js";
import { listScenarios } from "./scenarios.js";
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
  resolveProjectTarget
} from "./projectAdapter.js";
import { detectProject, detectProjectManifest, diagnoseProject } from "./projectDetection.js";
import { createRuntimeRecoveryAdvice } from "./runtimeStartupAdvisor.js";
import { saveProjectLoginSecret } from "./projectLoginStore.js";
import { runSmokeFirstDiscovery } from "./smokeFirstDiscovery.js";
import {
  discoveryPageObservationSchema,
  resolveTrustedDiscoveryObservation
} from "./pageObservationStore.js";
import { readCoverageItems } from "./coverageStore.js";
import {
  createProjectGrant,
  hasProjectScope,
  listAccessibleProjectIds,
  projectAccessDecision,
  projectScopeForOperation
} from "./projectAccess.js";
import {
  readEvidenceFromAuditStore,
  readFindingsFromAuditStore,
  readJudgeSummaryFromAuditStore
} from "./sqliteAuditStore.js";
import type {
  ProjectConfig,
  ProjectRuntimeStatus
} from "./types.js";
import { loadProjectManifest, manifestToProjectConfig } from "./projectManifest.js";
import { runEventStore } from "./runEventStore.js";
import { buildBusinessCapabilityGraph } from "./businessCapabilityGraph.js";
import { createMissionPreview } from "./missionPreview.js";
import { getPlanningFlowPage, getPlanningFunctionPage } from "./planningInventoryStore.js";
import { createPlanningConversation } from "./planningService.js";
import { listenAgentServer } from "./server/startup.js";
import { observabilityRouter } from "./server/routes/observability.routes.js";
import { buildBenchmarkCatalog, trustedBenchmarkRuntimeMetrics } from "./benchmarkSummary.js";
import { chooseNativeProjectFolder, listProjectDirectory } from "./projectFolderBrowser.js";
import {
  getAgentGraphProjection,
  resumeAgentGraph,
  startAgentGraphInBackground
} from "./agentGraphService.js";
import {
  applyRepairSession,
  createRepairSession,
  exportRepairSession,
  findReusableProjectCodeSession,
  listRepairWorkspaceFiles,
  listRepairSessions,
  readRepairFile,
  readRepairSession,
  updateRepairSessionSummary,
  validateRepairSession,
  writeRepairFile
} from "./repairWorkspace.js";
import { proposeCodeRepair, proposeProjectStartupRepair } from "./llmCodeRepair.js";
import { initializeAgentSustainability } from "./agentSustainability.js";
import { getWriteSafetyLayer } from "./write-safety/index.js";
import { listRecoveryRecords } from "./recoveryStore.js";
import {
  browserSessionFramePath,
  readBrowserActionResults,
  readBrowserDecisions,
  readBrowserObservations,
  readBrowserSession,
  subscribeBrowserAgentLifecycle
} from "./browser-agent/store.js";
import {
  acquireBrowserControl,
  closeBrowserSessionsForProject,
  executeUserBrowserInput,
  releaseBrowserControl,
  resizeManagedBrowserViewport,
  subscribeBrowserLiveFrames
} from "./browser-agent/sessionManager.js";

const projectRuntime = createProjectRuntimeService();
const app = express();
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? (process.env.AGENT_API_TOKEN ? "0.0.0.0" : "127.0.0.1");
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");
const {
  artifactUrl,
  assertAuthorizedRun,
  assertOrganizationAccess,
  assertProjectAccess,
  isMissingRunBundle,
  readAuthorizedLegacyRun,
  releaseRecommendation,
  unavailableRunReport
} = createRunAccessService(reportsDir);

const assistantReasoningSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["phase", "observations", "assessment", "nextStep", "userAction", "confidence"],
  properties: {
    phase: { type: "string", enum: ["observing", "diagnosing", "planning", "waiting-user", "acting", "completed"] },
    observations: {
      type: "array",
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 500 }
    },
    assessment: { type: "string", minLength: 1, maxLength: 600 },
    nextStep: { type: "string", minLength: 1, maxLength: 500 },
    userAction: { type: "string", minLength: 1, maxLength: 500 },
    confidence: { type: "string", enum: ["high", "medium", "low"] }
  }
} as const;
const assistantReasoningSummarySchema = z.object({
  phase: z.enum(["observing", "diagnosing", "planning", "waiting-user", "acting", "completed"]),
  observations: z.array(z.string().min(1).max(500)).max(3),
  assessment: z.string().min(1).max(600),
  nextStep: z.string().min(1).max(500),
  userAction: z.string().min(1).max(500),
  confidence: z.enum(["high", "medium", "low"])
}).strict();
const assistantSuggestedActions = [
  "none",
  "revise-plan",
  "start-run",
  "pause-run",
  "resume-run",
  "cancel-run",
  "resume-interrupt",
  "create-repair",
  "retry-runtime",
  "retry-discovery",
  "retry-failed-path",
  "continue-safe-paths",
  "open-evidence"
] as const;
const assistantSuggestedActionSchema = z.enum(assistantSuggestedActions);

function deterministicAssistantKnowledge(context: ReturnType<typeof createKnowledgeContext>) {
  return knowledgeBoundaryOutputSchema.parse({
    schemaVersion: "2.0",
    factsUsed: context.claims
      .filter((claim) => ["observed", "user-provided", "retrieved"].includes(claim.status))
      .map((claim) => claim.id),
    inferences: [],
    assumptions: [],
    unknowns: [],
    toolRequests: [],
    blockingQuestions: context.unknowns.filter((item) => item.blocking).map((item) => item.question),
    proposedActions: []
  });
}

function withAssistantOutputNormalization<T extends z.ZodTypeAny>(
  schema: T,
  knowledge?: ReturnType<typeof deterministicAssistantKnowledge>
): z.ZodType<z.output<T>> {
  return z.preprocess((value) => {
    const normalized = normalizeAssistantOutputShape(value);
    return knowledge && normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? { ...normalized, knowledge }
      : normalized;
  }, schema) as z.ZodType<z.output<T>>;
}

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
  const providerNeedsPromptSchema = /api\.sophnet\.com/i.test(input.credential.baseUrl);
  const callInput = {
    credential: input.credential,
    apiKey: input.apiKey,
    system: input.system,
    prompt: providerNeedsPromptSchema
      ? `${input.prompt}\n\nThe provider does not enforce native JSON Schema. Follow this exact output schema and do not rename, omit, or add fields:\n${JSON.stringify(input.jsonSchema)}`
      : input.prompt,
    // Knowledge citations and capability auditing are attached
    // deterministically by the server. The model only writes the concise
    // conversational envelope, so a bounded response should not consume the
    // entire 2.5k-token allowance and truncate mid-object.
    // Responses models account for internal reasoning inside max_output_tokens.
    // 1,200 caused otherwise successful SophNet calls to stop at ~1,152
    // completion tokens and return a truncated JSON object. Keep the visible
    // envelope compact, but reserve enough room for reasoning plus the final
    // structured answer.
    maxTokens: 3_200,
    timeoutMs: 45_000,
    totalTimeoutMs: 60_000,
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

async function readProjectAssistantDiagnostic(projectId: string, refreshDiagnosis = false) {
  const runtime = await getProjectRuntimeStatusWithRecovery(projectId).catch(() => undefined);
  // Idle/installing/starting are lifecycle states, not failed health checks.
  // Diagnosing them as unreachable polluted the assistant with a failure that
  // had not happened yet. Refresh a diagnosis only after a terminal runtime
  // failure or when the caller has an explicit blocked connection result.
  const diagnosis = runtime && (runtime.status === "failed" || refreshDiagnosis)
    ? await diagnoseProject(projectId).catch(() => undefined)
    : undefined;
  const failedStages = (diagnosis?.stages ?? [])
    .filter((stage) => stage.status === "failed" || stage.status === "warning")
    .slice(0, 8)
    .map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      reason: compactAssistantContext(stage.reason, 300),
      humanMessage: compactAssistantContext(stage.humanMessage, 500),
      missingEnv: stage.missingEnv?.slice(0, 8) ?? [],
      portConflicts: stage.portConflicts?.slice(0, 8) ?? []
    }));
  return {
    runtime: runtime ? {
      status: runtime.status,
      phase: runtime.phase,
      failureReason: runtime.failureReason,
      message: compactAssistantContext(runtime.message, 800),
      updatedAt: runtime.updatedAt
    } : undefined,
    diagnosis: diagnosis ? {
      overallStatus: diagnosis.overallStatus,
      checkedAt: diagnosis.checkedAt,
      failedStages
    } : undefined
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
app.use(readinessRouter({ assertProjectAccess, startProject: projectRuntime.startProjectWithFreshConfig })); app.use(reviewRouter({ assertOrganizationAccess, assertProjectAccess })); app.use(credentialSetupRouter({ assertProjectAccess }));
app.use(observabilityRouter());
app.use(knowledgeRouter());
app.use(planRouter(assertProjectAccess));
app.use(repairRouter(assertProjectAccess));
app.use(credentialAdminRouter());
app.use(legacyReportsRouter({
  reportsDir,
  artifactUrl,
  assertAuthorizedRun,
  assertProjectAccess,
  readAuthorizedLegacyRun
}));
app.use("/api/projects/grants", requireRole(["admin"]));
app.use(projectRouter({ rootDir, assertProjectAccess, runtime: projectRuntime }));
app.use(patrolRouter({ assertProjectAccess }));
app.use(runInspectionRouter({
  assertOrganizationAccess: (request, organizationId) => assertOrganizationAccess(request, String(organizationId ?? "")),
  // Keep an absent project absent. Converting it to the literal string
  // "undefined" makes public/appUrl Runs look like a project-scoped Run and
  // rejects otherwise authorized read-only inspection requests.
  assertProjectAccess: (request, projectId, scope) => assertProjectAccess(request, projectId, scope)
}));
app.use(runStreamRouter({
  assertOrganizationAccess: (request, organizationId) => assertOrganizationAccess(request, String(organizationId ?? "")),
  assertProjectAccess: (request, projectId, scope) => assertProjectAccess(request, projectId, scope)
}));
app.use(workbenchOperationsRouter({
  rootDir,
  reportsDir,
  assertProjectAccess: (request, projectId, scope) => assertProjectAccess(request, String(projectId), scope)
}));
app.use(runRepairSessionRouter({
  assertOrganizationAccess: (request, organizationId) => assertOrganizationAccess(request, String(organizationId ?? "")),
  assertProjectAccess: (request, projectId, scope) => assertProjectAccess(request, projectId, scope)
}));
app.post("/v1/runs", requireRole(["admin", "runner"]));
for (const action of ["plan-approval", "permissions", "pause", "resume", "cancel", "benchmark-timeout"]) app.post(`/v1/runs/:id/${action}`, requireRole(["admin", "runner"]));
app.post("/v1/runs/:id/decision-override", requireRole(["admin", "reviewer"]));
app.post("/v1/runs/:id/repairs", requireRole(["admin", "maintainer"]));
app.post("/v1/runs/:id/recover", requireRole(["admin", "runner"]));
app.post("/v1/runs/:id/continue", requireRole(["admin", "runner"]));
app.post("/v1/runs/:id/paths/:pathId/retry", requireRole(["admin", "runner"]));
app.put("/v1/repair-sessions/:id/files/*", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/validate", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/export", requireRole(["admin", "maintainer"]));
app.post("/v1/repair-sessions/:id/apply", requireRole(["admin", "maintainer"]));

app.use(runCreationRouter({
  runEventStore,
  assertOrganizationAccess,
  assertProjectAccess: (request, projectId, scope) => assertProjectAccess(request, projectId, scope)
}));
app.use(runControlRouter({
  runEventStore,
  assertOrganizationAccess,
  assertProjectAccess
}));

app.use(metaRouter);

const permissionProfileSchema = agentPermissionProfileSchema;

app.get("/v1/runs/:id/artifacts", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    try {
      const bundle = await readRunBundle(run?.resultRunId ?? req.params.id);
      const artifacts = await overlayArtifactObjectStoreStates(run.id, bundle.artifactsV2 ?? []);
      res.json({ artifacts, legacyEvidence: bundle.evidence.filter((item) => !item.artifactIds?.length) });
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
      const bundle = await readRunBundle(run?.resultRunId ?? req.params.id);
      const result = bundle.result;
      const executionStatus = run.executionStatus ?? result.outcomeSummary?.executionStatus;
      const sourceMachineGate = run.machineGate ?? result.machineGate;
      const machineGate = sourceMachineGate
        ? await revalidateArtifactObjectStoreState(run.id, sourceMachineGate)
        : sourceMachineGate;
      // A historical `completed/pass` event remains immutable for audit, but
      // it is not a release decision once reconciliation has established that
      // its Artifact object disappeared. The live read projection fails closed.
      const finalStatus = machineGate?.status === "blocked"
        ? "blocked"
        : run?.gateStatus ?? result.finalStatus;
      const artifacts = await overlayArtifactObjectStoreStates(run.id, bundle.artifactsV2 ?? result.artifactsV2);
      // RunBundle keeps evidence-bearing collections at its immutable top
      // level to avoid duplicating large payloads in `result`. Rehydrate the
      // public report projection here. Returning only `result` made parent
      // aggregates look like an operation-log with no coverage/attempts to
      // Benchmark and the Workbench, even though their child evidence existed.
      res.json({ report: {
        ...result,
        evidence: bundle.evidence,
        artifactsV2: artifacts,
        attempts: bundle.attempts ?? result.attempts,
        loopEvents: bundle.loopEvents,
        oracles: bundle.oracles,
        riskCoverageMatrix: bundle.riskCoverageMatrix,
        failureAttributions: bundle.failureAttributions ?? result.failureAttributions,
        artifactIntegrity: bundle.artifactIntegrity ?? result.artifactIntegrity,
        coverageItems: bundle.coverageItems ?? result.coverageItems,
        conclusions: bundle.conclusions ?? result.conclusions,
        proofNodes: bundle.proofNodes ?? result.proofNodes,
        proofEdges: bundle.proofEdges ?? result.proofEdges,
        evidenceManifest: bundle.evidenceManifest ?? result.evidenceManifest,
        executionStatus,
        gateStatus: machineGate?.status ?? run?.gateStatus ?? result.gateStatus,
        finalStatus,
        releaseRecommendation: releaseRecommendation({ executionStatus, finalStatus }),
        machineGate,
        judgeRecommendation: run?.judgeRecommendation ?? result.judgeRecommendation,
        humanDecision: run?.humanDecision,
        planProvenance: run?.planProvenance,
        plannerCall: run?.plannerCall,
        plannerCalls: run?.plannerCalls,
        impactAnalysis: run?.impactAnalysis
      } });
    } catch (error) {
      if (!isMissingRunBundle(error)) throw error;
      res.json({ report: { ...unavailableRunReport(run), humanDecision: run.humanDecision, planProvenance: run.planProvenance, plannerCall: run.plannerCall, plannerCalls: run.plannerCalls, impactAnalysis: run.impactAnalysis } });
    }
  } catch (error) { next(error); }
});


app.post("/v1/runs/:id/messages", async (req, res, next) => {
  try {
    const body = z.object({
      message: z.string().trim().min(1).max(4_000),
      credentialId: z.string().optional(),
      origin: z.enum(["user", "system-diagnosis"]).default("user")
    }).parse(req.body);
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    if (body.origin === "user") {
      await appendAgentMessage({ runId: run.id, role: "user", content: body.message });
    }
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
    // Owner-aware repair plan derived from the persisted failure attributions.
    // It is the single source of the "需要你做什么" instruction for this run.
    const runRepairPlan = await resolveRunRepairPlan(run.resultRunId ?? run.id);
    const runRepairPlanPayload = toRepairPlanPayload(runRepairPlan);
    const runRepairDecision = toAssistantRepairDecision(runRepairPlan);
    const resultFacts = await readRunBundle(run.resultRunId ?? run.id)
      .then((bundle) => {
        const pageObservations = bundle.evidence
          .filter((item) =>
            item.type === "dom"
            && /页面观测/.test(item.title)
          )
          .slice(-8)
          .map(summarizeEvidenceForModel);
        const recentOperations = bundle.evidence
          .filter((item) => item.type === "operation")
          .slice(-8)
          .map(summarizeEvidenceForModel);
        return {
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
        evidenceCount: bundle.evidence.length,
        pageObservations,
        recentOperations
        };
      })
      .catch(() => undefined);
    const runEvidenceRefs = Array.from(new Set(
      resultFacts?.failedAssertions.flatMap((item) => item.evidenceRefs) ?? []
    ));
    const machineGateEvidenceRefs = Array.from(new Set(
      run.machineGate?.reasonDetails?.flatMap((item) => item.evidenceRefs).filter(Boolean) ?? []
    ));
    const machineGateSourceRefs = machineGateEvidenceRefs.length
      ? machineGateEvidenceRefs
      : runEvidenceRefs.length
        ? runEvidenceRefs
        : [`run-event:${run.id}`];
    const knowledgeContext = createKnowledgeContext({
      purpose: "assistant",
      runId: run.id,
      projectSnapshot: { projectId: project?.id ?? String(run.input.projectId) },
      claims: [
        {
          id: "user-message",
          statement: compactKnowledgeStatement(body.message),
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
          statement: compactKnowledgeStatement(`Machine gate is ${run.machineGate.status}: ${run.machineGate.reasons.join("; ") || "no reason supplied"}.`),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: machineGateSourceRefs,
          confidence: 1,
          observedAt: new Date().toISOString()
        }] : []),
        ...(resultFacts ? [{
          id: "saved-run-result",
          subject: "saved-run-result",
          statement: compactKnowledgeStatement(`Saved result summary: ${resultFacts.summary}; execution error: ${resultFacts.executionError ?? "none"}; failed assertions: ${resultFacts.failedAssertions.length}; evidence count: ${resultFacts.evidenceCount}.`),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: runEvidenceRefs.length ? runEvidenceRefs : [`run-result:${run.resultRunId ?? run.id}`],
          confidence: 1,
          observedAt: new Date().toISOString()
        }, ...(resultFacts.pageObservations.length ? [{
          id: "browser-page-observations",
          subject: "browser-page-observations",
          statement: compactKnowledgeStatement(
            `The browser saved ${resultFacts.pageObservations.length} recent before/after/failure page observations with DOM controls, console errors, failed requests and state changes.`
          ),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: resultFacts.pageObservations.map((item) => `evidence:${item.id}`),
          confidence: 1,
          observedAt: new Date().toISOString()
        }] : [])] : []),
        ...repairs.slice(0, 3).map((repair) => ({
          id: `repair-${repair.id}`,
          statement: compactKnowledgeStatement(`Repair ${repair.id} status=${repair.status}; changed files=${repair.files.map((file) => file.path).join(", ") || "none"}; validation=${repair.validation?.status ?? "not-run"}.`),
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
      allowedTools: [
        "read-run-evidence",
        "read-repair-history",
        "read-page-observation",
        "read-discovery-candidates"
      ],
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
      required: ["reply", "reasoningSummary", "suggestedAction", "requiresConfirmation"],
      properties: {
        reply: { type: "string", minLength: 1, maxLength: 1_200 },
        reasoningSummary: assistantReasoningSummaryJsonSchema,
        suggestedAction: {
          type: "string",
          enum: [...assistantSuggestedActions]
        },
        requiresConfirmation: { type: "boolean" }
      }
    } as const;
    const assistantSchema = withAssistantOutputNormalization(z.object({
      reply: z.string().min(1).max(1_200),
      reasoningSummary: assistantReasoningSummarySchema,
      suggestedAction: assistantSuggestedActionSchema,
      requiresConfirmation: z.boolean(),
      knowledge: knowledgeBoundaryOutputSchema
    }).strict(), deterministicAssistantKnowledge(knowledgeContext)).superRefine((value, ctx) => {
      try {
        validateKnowledgeBoundaryOutput(value.knowledge, knowledgeContext);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledge"],
          message: error instanceof Error ? error.message : "knowledge_boundary_invalid"
        });
      }
    });
    const assistantStartedAt = Date.now();
    try {
      const structured = await executeStructuredAssistant({
        credential,
        apiKey: await decrypt(credential.apiKeyEncrypted),
        system: [
        "You are the assistant for an evidence-driven automated testing run.",
        "Use only the supplied durable run facts. Never claim pass from scheduling completion.",
        "Answer the user's actual question in concise, plain Chinese. Avoid raw error codes, stack traces and internal field names in the main reply.",
        "For a blocked or failed run, the reply must use three short labelled paragraphs: 遇到的问题, 系统已经做了什么, 需要你做什么.",
        "Name the failed step, assertion, page or path whenever it exists in resultFacts. Do not replace specific facts with generic phrases such as 'a problem occurred'.",
        "Use resultFacts.pageObservations and recentOperations to explain what the browser actually saw before, after, or during a failed action. Treat their controls, console errors, failed requests and changes as observations, not guesses.",
        "Do not ask for login credentials unless a saved observation contains HTTP 401/403, a login form, or explicit authentication text.",
        "Also return reasoningSummary as an evidence-backed decision summary for the user. It is not hidden chain-of-thought: list only observable facts, the concise assessment, the next system step, and the exact user action.",
        "If the user does not need to act, explicitly say 无需操作. If a repair session changed no files, explicitly say 未修改项目源码.",
        "Only claim code was repaired when repairHistory contains concrete changed files, and name those files.",
        "Do not push technical diagnosis back to the user when resultFacts already identify a timeout, selector, script, environment or product failure.",
        "When a test-script, selector or product failure has no repair yet, explain that the system can create and validate a sandbox repair, return suggestedAction=create-repair and require confirmation.",
        "Only recommend retry-failed-path when a persisted failed attempt exists. For sandbox, Docker, port, or project-start failures, return retry-runtime. For a connected page whose discovery is incomplete, return retry-discovery. If no safe recovery exists, return none.",
        "Translate direct user commands such as pause, resume, cancel, revise the plan, inspect evidence, retry failures, or continue safe paths into the matching suggestedAction. Never claim the action already happened.",
        "Use open-evidence only when the saved facts are genuinely insufficient; use resume-interrupt for missing permission or credential confirmation.",
        "Do not invent evidence, credentials, commands or test results.",
        "Keep the entire JSON concise: reply under 350 Chinese characters and at most 3 short observations. Knowledge citations and capability authorization are attached by the server; do not output a knowledge field.",
        "Return only the requested JSON."
        ].join(" "),
        prompt: JSON.stringify({
        userMessage: compactAssistantContext(body.message, 4_000),
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
          summary: compactAssistantContext(repair.summary, 800),
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
            summary: compactAssistantContext(repair.validation.summary, 800)
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
      const safetyNormalized = assistantReplyNeedsNormalization(structured.assistant);
      const modelAssistant = safetyNormalized
        ? buildDeterministicAssistantFallback({
          userMessage: body.message,
          projectName: project?.name,
          repairDecision: runRepairDecision,
          runState: run.state,
          finalStatus: run.gateStatus,
          summary: [
            run.machineGate?.reasons.join("；"),
            resultFacts?.summary,
            resultFacts?.executionError?.message
          ].filter(Boolean).join("；"),
          currentStep: resultFacts?.executionError?.stepId,
          latestLog: resultFacts?.executionError?.message,
          evidenceCount: resultFacts?.evidenceCount,
          failedAssertions: resultFacts?.failedAssertions
        })
        : structured.assistant;
      const assistant = runRepairPlanPayload
        ? { ...modelAssistant, repairPlan: runRepairPlanPayload }
        : modelAssistant;
      await appendAgentMessage({
        runId: run.id,
        role: "assistant",
        content: assistant.reply,
        reasoningSummary: assistant.reasoningSummary,
        repairPlan: runRepairPlanPayload,
        knowledgeContextId: structured.llm.knowledgeContext.id,
        knowledgeDecisionId: structured.llm.knowledgeDecision.id,
        llmCallId: structured.llm.call.id,
        suggestedAction: assistant.suggestedAction,
        requiresConfirmation: assistant.requiresConfirmation
      });
      res.json({
        assistant,
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
          knowledgeValidationStatus: structured.llm.knowledgeDecision.validationStatus,
          fallbackApplied: safetyNormalized,
          errorCode: safetyNormalized ? "assistant_output_normalized" : undefined
        }
      });
    } catch (assistantError) {
      const assistant = buildDeterministicAssistantFallback({
        userMessage: body.message,
        projectName: project?.name,
        repairDecision: runRepairDecision,
        runState: run.state,
        finalStatus: run.gateStatus,
        summary: [
          run.machineGate?.reasons.join("；"),
          resultFacts?.summary
        ].filter(Boolean).join("；"),
        currentStep: resultFacts?.executionError?.stepId,
        latestLog: resultFacts?.executionError?.message,
        evidenceCount: resultFacts?.evidenceCount,
        failedAssertions: resultFacts?.failedAssertions
      });
      const call = deterministicAssistantCall(assistantError, {
        provider: credential.provider,
        model: credential.model,
        durationMs: Date.now() - assistantStartedAt
      });
      await appendAgentMessage({
        runId: run.id,
        role: "assistant",
        content: assistant.reply,
        reasoningSummary: assistant.reasoningSummary,
        repairPlan: runRepairPlanPayload,
        llmCallId: call.id,
        suggestedAction: assistant.suggestedAction,
        requiresConfirmation: assistant.requiresConfirmation
      });
      res.json({ assistant, call });
    }
  } catch (error) { next(error); }
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
        pageObservation: discoveryPageObservationSchema.extend({
          // Compatibility: cached clients created before observation IDs were
          // introduced may omit the id. Such payloads are never trusted as
          // facts; the server resolves the latest persisted observation.
          id: z.string().min(1).max(200).optional()
        }).optional(),
        failedAssertions: z.array(z.object({
          name: z.string().max(300),
          expected: z.string().max(800),
          actual: z.string().max(800)
        })).max(8).default([]),
        planning: z.object({
          discovered: z.number().int().nonnegative(),
          executable: z.number().int().nonnegative(),
          autoBindable: z.number().int().nonnegative(),
          confirmed: z.boolean(),
          failures: z.array(z.object({
            title: z.string().max(300).optional(),
            target: z.string().max(500).optional(),
            stage: z.enum(["binding", "execution"]).optional(),
            detail: z.string().max(1_000),
            requiredInformation: z.array(z.string().max(500)).max(8).default([])
          })).max(12).default([]),
          blockingQuestions: z.array(z.string().max(500)).max(8).default([])
        }).optional()
      }).default({ failedAssertions: [] })
    }).parse(req.body);
    await assertProjectAccess(req, body.projectId, "run_tests");
    const project = await getProject(body.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const trustedObservation = await resolveTrustedDiscoveryObservation({
      projectId: project.id,
      observationId: body.context.pageObservation?.id
    }).catch(() => undefined);
    // Page observations come back through a browser client, so never mark the
    // client copy as observed. Replace it with the immutable server-side
    // record produced by Discovery (or omit it when no record exists).
    body.context.pageObservation = trustedObservation?.observation;
    const projectDiagnostic = await readProjectAssistantDiagnostic(
      project.id,
      body.context.finalStatus === "blocked"
    );
    // The structured failure-attribution chain already decided who owns this
    // failure and what the operator must do. Reuse that decision verbatim so the
    // chat reply, the repair-plan API and the UI panel never diverge.
    const chatRepairPlan = await resolveRunRepairPlan(body.context.runId);
    const fallbackInput = {
      userMessage: body.message,
      projectName: project.name,
      repairDecision: toAssistantRepairDecision(chatRepairPlan),
      runState: body.context.runState,
      finalStatus: body.context.finalStatus,
      summary: body.context.summary,
      currentStep: body.context.currentStep,
      latestLog: body.context.latestLog,
      pageObservation: body.context.pageObservation,
      evidenceCount: body.context.evidenceCount,
      failedAssertions: body.context.failedAssertions,
      planning: body.context.planning,
      projectDiagnostic: {
        runtimeStatus: projectDiagnostic.runtime?.status,
        runtimePhase: projectDiagnostic.runtime?.phase,
        failureReason: projectDiagnostic.runtime?.failureReason,
        runtimeMessage: projectDiagnostic.runtime?.message,
        failedStages: projectDiagnostic.diagnosis?.failedStages
      }
    };

    // Immediate run controls remain deterministic and available when a model
    // provider is unhealthy. Recovery and Discovery commands deliberately go
    // through the knowledge-bounded assistant first: it can inspect the latest
    // committed observation/candidates and explain why that action is valid.
    const requestedAction = requestedAssistantAction(body.message);
    if (requestedAction && [
      "pause-run",
      "resume-run",
      "cancel-run",
      "start-run",
      "open-evidence"
    ].includes(requestedAction)) {
      return void res.json({
        assistant: buildDeterministicAssistantFallback(fallbackInput),
        call: deterministicAssistantCommandCall()
      });
    }
    const publicCredentials = await listCredentials();
    const selectedPublic = body.credentialId
      ? publicCredentials.find((item) => item.id === body.credentialId)
      : publicCredentials.find((item) => item.isDefault && !/api\.poe\.com/i.test(item.baseUrl))
        ?? publicCredentials.find((item) => !/api\.poe\.com/i.test(item.baseUrl));
    if (!selectedPublic || /api\.poe\.com/i.test(selectedPublic.baseUrl)) {
      return void res.json({
        assistant: buildDeterministicAssistantFallback(fallbackInput),
        call: deterministicAssistantCall(new Error("assistant_model_not_configured"), {})
      });
    }
    const credential = await getCredential(selectedPublic.id);
    if (!credential) {
      return void res.json({
        assistant: buildDeterministicAssistantFallback(fallbackInput),
        call: deterministicAssistantCall(new Error("assistant_model_not_configured"), {})
      });
    }
    const knowledgeContext = createKnowledgeContext({
      purpose: "assistant",
      projectSnapshot: { projectId: project.id },
      claims: [
        {
          id: "user-message",
          statement: compactKnowledgeStatement(body.message),
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
        },
        ...(projectDiagnostic.runtime ? [{
          id: "project-runtime",
          subject: "project-runtime",
          statement: compactKnowledgeStatement(
            `Project runtime is ${projectDiagnostic.runtime.status}/${projectDiagnostic.runtime.phase ?? "unknown"}; failure=${projectDiagnostic.runtime.failureReason ?? "none"}; ${projectDiagnostic.runtime.message ?? ""}`
          ),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: [`project:${project.id}`],
          confidence: 1,
          observedAt: projectDiagnostic.runtime.updatedAt ?? new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString()
        }] : []),
        ...(projectDiagnostic.diagnosis ? [{
          id: "project-diagnosis",
          subject: "project-diagnosis",
          statement: compactKnowledgeStatement(
            `Project diagnosis is ${projectDiagnostic.diagnosis.overallStatus}; stages: ${projectDiagnostic.diagnosis.failedStages
              .map((stage) => `${stage.stage}/${stage.status}: ${stage.humanMessage}`)
              .join("; ") || "no failed stage"}`
          ),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: [`project:${project.id}`],
          confidence: 1,
          observedAt: projectDiagnostic.diagnosis.checkedAt,
          expiresAt: new Date(Date.now() + 30_000).toISOString()
        }] : []),
        ...(body.context.pageObservation ? [{
          id: "discovery-page-observation",
          subject: "discovery-page-observation",
          statement: compactKnowledgeStatement(
            `Discovery ${body.context.pageObservation.status} at ${body.context.pageObservation.stage}; `
            + `requested=${body.context.pageObservation.requestedUrl}; final=${body.context.pageObservation.finalUrl}; `
            + `http=${body.context.pageObservation.navigation.httpStatus ?? "unknown"}; `
            + `committed=${body.context.pageObservation.navigation.documentCommitted}; `
            + `interactive=${body.context.pageObservation.document.interactiveElementCount}; `
            + `controls=${body.context.pageObservation.document.controls.length}; `
            + `console=${body.context.pageObservation.console.length}; pageErrors=${body.context.pageObservation.pageErrors.length}; `
            + `failedRequests=${body.context.pageObservation.failedRequests.length}; `
            + `diagnosis=${body.context.pageObservation.diagnosis.summary}; `
            + `causes=${body.context.pageObservation.diagnosis.likelyCauses.join("; ") || "none"}`
          ),
          status: "observed" as const,
          domain: "runtime" as const,
          sourceRefs: [`discovery:${body.context.pageObservation.id}`],
          scope: { projectId: project.id },
          confidence: 1,
          observedAt: body.context.pageObservation.capturedAt,
          expiresAt: new Date(Date.now() + 30_000).toISOString()
        }] : [])
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
      allowedTools: [
        "read-project-manifest",
        "read-run-evidence",
        "read-runtime-log",
        "read-page-observation",
        "read-discovery-candidates"
      ],
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
      required: ["reply", "reasoningSummary", "intent", "suggestedAction", "requiresConfirmation"],
      properties: {
        reply: { type: "string", minLength: 1, maxLength: 1_200 },
        reasoningSummary: assistantReasoningSummaryJsonSchema,
        intent: { type: "string", enum: ["status-question", "failure-question", "plan-change", "execution-control", "general"] },
        suggestedAction: { type: "string", enum: [...assistantSuggestedActions] },
        requiresConfirmation: { type: "boolean" }
      }
    } as const;
    const system = [
      "You are the conversational assistant inside an evidence-driven browser testing product.",
      "Act as the plain-language intermediary between a non-technical user and the automated test system.",
      "Answer the user's actual question directly in concise Chinese using only the supplied run and planning facts.",
      "Do not expose raw error codes, stack traces, schema names or internal field names in the main reply; translate them into user-visible impact.",
      "Do not print knowledge claim IDs or sourceRef tokens such as project-diagnosis; the Workbench renders provenance separately.",
      "For a blocker, review request or repair question, the reply must use three short labelled paragraphs: 遇到的问题, 系统已经做了什么, 需要你做什么.",
      "When currentFacts.projectDiagnostic exists, treat its runtime and failed stages as the authoritative pre-run startup facts. Name the failed stage and explain whether the user must provide a credential/permission or whether the system can retry automatically.",
      "A project startup failure happens before product testing. Never describe it as a product bug, a failed assertion, or a completed test.",
      "Use currentFacts.planning.failures to name the failed page, flow or binding condition. Never reduce a specific failure list to a generic 'there is a problem'.",
      "When currentFacts.pageObservation exists, treat it as the authoritative browser observation: use its final URL, HTTP status, committed document state, DOM sample, console errors, page errors, failed requests and diagnosis. Do not ask whether the user is logged in unless the observed DOM or HTTP status contains concrete authentication evidence.",
      "If pageObservation.diagnosis.userActionRequired is false, say 无需操作 and propose a bounded system retry instead of asking the user to guess runtime details.",
      "Return reasoningSummary as a short evidence-backed decision summary. Do not reveal hidden chain-of-thought; include only observed facts, concise assessment, next system step and exact user action.",
      "If no user action is required, explicitly say 无需操作. Never claim source code changed unless the supplied facts contain concrete changed files.",
      "Never claim a test passed merely because scheduling completed.",
      "Never invent screenshots, evidence, failures, credentials, actions, or API results.",
      "You may suggest an action but must require confirmation for starting, pausing, resuming, cancelling, or revising a plan.",
      "Translate direct user commands into suggestedAction. Only use retry-failed-path for a persisted failed path. Use retry-runtime for Docker, sandbox, project-start, port, or health failures; use retry-discovery for a connected page whose controls have not been discovered; use continue-safe-paths only for independently executable paths.",
      "Before a durable run exists, do not suggest retry-failed-path or create-repair. If runtime facts show a sandbox/start failure, use retry-runtime; if page discovery is incomplete, use retry-discovery; otherwise use revise-plan or none. Use capability=request-interrupt-resume for resume-interrupt.",
      "Never say an action was executed merely because it was suggested.",
      "Keep the entire JSON concise: reply under 350 Chinese characters and at most 3 short observations. Knowledge citations and capability authorization are attached by the server; do not output a knowledge field.",
      "Return only the requested JSON object."
    ].join(" ");
    const prompt = JSON.stringify({
      project: { id: project.id, name: project.name },
      userMessage: body.message,
      recentConversation: body.history.map((item) => ({
        ...item,
        content: compactAssistantContext(item.content, 1_500)
      })),
      currentFacts: {
        ...body.context,
        projectDiagnostic,
        summary: compactAssistantContext(body.context.summary, 1_200),
        currentStep: compactAssistantContext(body.context.currentStep, 300),
        latestLog: compactAssistantContext(body.context.latestLog, 700),
        failedAssertions: body.context.failedAssertions.map((item) => ({
          name: compactAssistantContext(item.name, 240),
          expected: compactAssistantContext(item.expected, 500),
          actual: compactAssistantContext(item.actual, 500)
        }))
      },
      knowledgeContext: publicKnowledgeContext(knowledgeContext)
    });
    const apiKey = await decrypt(credential.apiKeyEncrypted);
    const assistantSchema = withAssistantOutputNormalization(z.object({
      reply: z.string().min(1).max(1_200),
      reasoningSummary: assistantReasoningSummarySchema,
      intent: z.enum(["status-question", "failure-question", "plan-change", "execution-control", "general"]),
      suggestedAction: assistantSuggestedActionSchema,
      requiresConfirmation: z.boolean(),
      knowledge: knowledgeBoundaryOutputSchema
    }).strict(), deterministicAssistantKnowledge(knowledgeContext)).superRefine((value, ctx) => {
      try {
        validateKnowledgeBoundaryOutput(value.knowledge, knowledgeContext);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["knowledge"],
          message: error instanceof Error ? error.message : "knowledge_boundary_invalid"
        });
      }
    });
    const assistantStartedAt = Date.now();
    try {
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
          promptVersion: "assistant-v3-actionable-failure",
          outputSchemaVersion: "test-assistant-reply-v2",
          projectDigest: project.id,
          routeReason: "user-requested-planning-assistance",
          ruleCapable: false,
          cachePolicy: "bypass"
        }
      });
      const safetyNormalized = assistantReplyNeedsNormalization({
        ...structured.assistant,
        pageObservation: body.context.pageObservation
      });
      const modelAssistant = safetyNormalized
        ? buildDeterministicAssistantFallback(fallbackInput)
        : structured.assistant;
      // A model reply never invents the repair plan: it is attached from the
      // deterministic decision so the panel stays evidence-backed.
      const chatRepairPlanPayload = toRepairPlanPayload(chatRepairPlan);
      const assistant = chatRepairPlanPayload
        ? { ...modelAssistant, repairPlan: chatRepairPlanPayload }
        : modelAssistant;
      res.json({
        assistant,
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
    } catch (assistantError) {
      const assistant = buildDeterministicAssistantFallback(fallbackInput);
      res.json({
        assistant,
        call: deterministicAssistantCall(assistantError, {
          provider: credential.provider,
          model: credential.model,
          durationMs: Date.now() - assistantStartedAt
        })
      });
    }
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
        plan: grayPlanSchema.optional(),
        sourceContexts: z.array(sourceReadEnvelopeSchema).optional(),
        impactAnalysis: impactAnalysisSchema.optional(),
        executablePlan: executableTestPlanSchema.optional(),
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
        sourceContexts: z.array(sourceReadEnvelopeSchema).optional(),
        goal: z.string().trim().max(20_000).optional(),
        credentialId: z.string().optional()
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    await assertProjectAccess(req, body.projectId, "run_tests");
    res.json({ discovery: await runSmokeFirstDiscovery(body) });
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

app.use(errorHandler);

assertSecurityConfig(host);
// Connect the sustainable-agent facade to the real application services.
// The earlier default initialization exposed correctly shaped but empty
// placeholders, which meant an LLM could describe recovery tools while every
// runtime/evidence tool still returned "not restored". Keep this composition
// at the application boundary so the gateway never talks to storage directly.
initializeAgentSustainability(undefined, {
  getProjectContextRaw: async (projectId) => {
    const project = await getProject(projectId);
    if (!project) return { status: "blocked", errorCode: "project_not_found" };
    return {
      project: {
        id: project.id,
        name: project.name,
        frontendUrl: project.frontendUrl,
        backendUrl: project.backendUrl,
        execution: project.manifest?.execution,
        capabilities: project.manifest?.capabilities,
        hasLogin: Boolean(project.login),
        apiCredentialRequirementNames: project.apiCredentialRequirements?.map((item) => item.envName) ?? []
      },
      manifest: project.manifest
    };
  },
  getRunStatusRaw: async (runId) => {
    const run = await runEventStore.get(runId);
    return run ?? { status: "blocked", errorCode: "run_not_found" };
  },
  getEvidenceRaw: async (runId) => {
    const run = await runEventStore.get(runId);
    if (!run) return { status: "blocked", errorCode: "run_not_found" };
    const resultRunId = run.resultRunId ?? run.id;
    return Promise.all([
      readRunBundle(resultRunId).catch(() => undefined),
      readProofArtifacts(resultRunId).catch(() => undefined)
    ]).then(([bundle, proof]) => ({ bundle, proof }));
  },
  getFailureHistoryRaw: async (projectId) => (await listRunHistory())
    .filter((run) => run.projectId === projectId && run.verdict !== "continue"),
  getRepairHistoryRaw: async (projectId) => {
    const runs = (await listRunHistory()).filter((run) => run.projectId === projectId);
    return (await Promise.all(runs.slice(-20).map((run) => listRepairSessions(run.runId)))).flat();
  },
  inspectRuntimeRaw: async (projectId) => getProjectRuntimeStatusWithRecovery(projectId),
  readRuntimeLogRaw: async (projectId) => ({
    runtime: await getProjectRuntimeStatusWithRecovery(projectId),
    diagnosis: await diagnoseProject(projectId).catch(() => undefined)
  }),
  inspectHealthCheckRaw: async (projectId) => {
    const project = await getProject(projectId);
    return project
      ? testProjectConnection(project)
      : { status: "blocked", errorCode: "project_not_found" };
  },
  observePageRaw: async (runId) => {
    const records = await listRecoveryRecords(runId);
    return records.observations.at(-1) ?? { status: "blocked", errorCode: "page_observation_unavailable" };
  },
  readCurrentPlanRaw: async (runId) => {
    const run = await runEventStore.get(runId);
    return run ? { plan: run.plan, compiledPlan: run.compiledPlan, selectedScenarioId: run.selectedScenarioId } : { status: "blocked", errorCode: "run_not_found" };
  },
  readFailedAttemptRaw: async (runId) => {
    const run = await runEventStore.get(runId);
    if (!run) return { status: "blocked", errorCode: "run_not_found" };
    return readRunBundle(run.resultRunId ?? run.id).catch(() => ({ status: "blocked", errorCode: "attempt_unavailable" }));
  },
  readEvidenceProofRaw: async (runId) => {
    const run = await runEventStore.get(runId);
    return run
      ? readProofArtifacts(run.resultRunId ?? run.id)
      : { status: "blocked", errorCode: "run_not_found" };
  },
  safeRecoveryActionRaw: async (action, params, runId) => {
    const run = await runEventStore.get(runId);
    const projectId = typeof params.projectId === "string"
      ? params.projectId
      : typeof run?.input.projectId === "string" ? run.input.projectId : undefined;
    const actionId = `tool_${action}_${crypto.randomUUID()}`;
    if (["start_sandbox", "restart_sandbox", "resolve_port"].includes(action)) {
      if (!projectId) return { status: "blocked", actionId, nextState: "waiting_user", errorCode: "project_missing", userMessage: "当前运行没有关联项目。" };
      if (action === "restart_sandbox") await stopProject(projectId).catch(() => undefined);
      const runtime = await projectRuntime.startProjectWithFreshConfig(projectId);
      return {
        status: runtime.status === "running" ? "completed" : "failed",
        actionId,
        nextState: runtime.status === "running" ? "retry-discovery" : "waiting_user",
        errorCode: runtime.status === "running" ? undefined : runtime.failureReason,
        userMessage: runtime.message,
        runtime
      };
    }
    if (action === "retry_health_check") {
      if (!projectId) return { status: "blocked", actionId, nextState: "waiting_user", errorCode: "project_missing" };
      const project = await getProject(projectId);
      const health = project ? await testProjectConnection(project) : undefined;
      return { status: health?.ok ? "completed" : "failed", actionId, nextState: health?.ok ? "retry-discovery" : "waiting_user", errorCode: health?.ok ? undefined : health?.reason ?? "project_not_found", health };
    }
    if (action === "retry_discovery") {
      if (!projectId) return { status: "blocked", actionId, nextState: "waiting_user", errorCode: "project_missing" };
      const discovery = await runSmokeFirstDiscovery({ projectId, goal: typeof run?.input.requirement === "string" ? run.input.requirement : "重新扫描页面", smokeAttempts: 2, discoveryAttempts: 2 });
      const ready = discovery.orchestration?.status === "ready";
      return { status: ready ? "completed" : "failed", actionId, nextState: ready ? "planning" : "waiting_user", errorCode: ready ? undefined : discovery.orchestration?.reason ?? discovery.status, discovery };
    }
    if (action === "retry_failed_path" || action === "continue_safe_paths") {
      if (!run) return { status: "blocked", actionId, nextState: "waiting_user", errorCode: "run_not_found" };
      const projection = await getAgentGraphProjection(runId);
      if (projection?.pendingInterrupt) {
        await resumeAgentGraph(runId, {
          approved: true,
          action: action === "retry_failed_path" ? "retry-path" : "continue-safe-paths",
          actor: "tool-gateway"
        });
      } else {
        startAgentGraphInBackground(run);
      }
      return { status: "completed", actionId, nextState: action === "retry_failed_path" ? "retrying" : "executing" };
    }
    return {
      status: "needs-confirmation",
      actionId,
      nextState: "waiting_user",
      errorCode: "repair_confirmation_required",
      userMessage: "创建验证运行前需要先确认沙盒代码修复。"
    };
  }
});
listenAgentServer({ app, port, host, securitySummary });
