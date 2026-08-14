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
import { planRunFromDurableInput } from "./runPlanningService.js";
import { generatePlan } from "./llmPlanner.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { routePlanner } from "./llmRoutingPolicy.js";
import { planCacheKey, readCachedPlan, writeCachedPlan } from "./planCache.js";
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
import { listStorageArchives, runStorageRetention, storageStatus } from "./storageGovernance.js";
import type {
  ProjectConfig,
  ProjectRecoveryAction,
  ProjectRecoveryEvent,
  ProjectRecoveryResult,
  ProjectRuntimeStatus,
  SourceReadEnvelope
} from "./types.js";
import { loadProjectManifest, manifestToProjectConfig } from "./projectManifest.js";
import { isIdempotentReplay, runEventStore } from "./runEventStore.js";
import type { RunEventType } from "@ai-test-officer/contracts";
import { createRunRequestSchema } from "@ai-test-officer/contracts";
import { buildCodeImpactGraph, changedFilesFromDiff } from "./codeImpactGraph.js";
import { buildBusinessCapabilityGraph } from "./businessCapabilityGraph.js";
import { createMissionPreview } from "./missionPreview.js";
import { getPlanningFlowPage } from "./planningInventoryStore.js";
import { createPlanningConversation } from "./planningService.js";
import { enqueueRun, executeQueuedRun, interruptRun } from "./runOrchestrator.js";
import { buildBenchmarkCatalog, trustedBenchmarkRuntimeMetrics } from "./benchmarkSummary.js";
import { chooseNativeProjectFolder, listProjectDirectory } from "./projectFolderBrowser.js";
import {
  agentOrchestrationMode,
  getAgentGraphProjection,
  resumeAgentGraph,
  resumeAgentGraphInBackground,
  startAgentGraphForRun,
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
import { getAgentSustainability, initializeAgentSustainability } from "./agentSustainability.js";
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
  executeUserBrowserInput,
  releaseBrowserControl,
  resizeManagedBrowserViewport,
  subscribeBrowserLiveFrames
} from "./browser-agent/sessionManager.js";

const app = express();
const projectStartTasks = new Map<string, Promise<Awaited<ReturnType<typeof startProject>>>>();
const projectRecoveryTasks = new Map<string, Promise<ProjectRecoveryResult>>();
const projectRecoverySnapshots = new Map<string, ProjectRecoveryResult>();
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
    testCommand: detected.testCommand,
    testCommandSpec: detected.testCommandSpec,
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

function runtimeRecoveryAction(runtime: ProjectRuntimeStatus): ProjectRecoveryAction {
  if (runtime.status === "running") return "retry-discovery";
  if (["container_runtime_unavailable", "dependency_missing", "command_not_found", "port_conflict", "health_timeout", "early_exit", "budget_exceeded"].includes(runtime.failureReason ?? "")) return "retry-runtime";
  if (["idle", "installing", "starting"].includes(runtime.status)) return "retry-runtime";
  return "unavailable";
}

function recoveryUserAction(action: ProjectRecoveryAction, runtime: ProjectRuntimeStatus) {
  if (action === "retry-runtime") {
    return runtime.failureReason === "container_runtime_unavailable"
      ? "暂时无需操作；系统会先启动 Docker Desktop。若 180 秒后仍不可用，会提示你检查 Docker 是否已安装并完成系统权限确认。"
      : "暂时无需操作；系统会重新准备安全沙盒、项目服务和健康检查。";
  }
  if (action === "retry-discovery") return "暂时无需操作；系统会重新扫描页面并绑定可执行路径。";
  return "当前没有安全且可自动执行的恢复动作，请查看运行详情后补充项目启动条件。";
}

function appendRecoveryEvent(snapshot: ProjectRecoveryResult, phase: ProjectRecoveryEvent["phase"], message: string) {
  snapshot.events.push({ phase, message, at: new Date().toISOString() });
  snapshot.updatedAt = new Date().toISOString();
  projectRecoverySnapshots.set(snapshot.projectId, { ...snapshot, events: [...snapshot.events] });
}

function recoverAndRetryProject(
  id: string,
  requestedMode: "auto" | "runtime" | "discovery" = "auto",
  credentialId?: string
): Promise<ProjectRecoveryResult> {
  const existing = projectRecoveryTasks.get(id);
  if (existing) return existing;
  const task = (async (): Promise<ProjectRecoveryResult> => {
    const project = await getProject(id);
    if (!project) throw new Error("project_not_found");
    const initialRuntime = await getProjectRuntimeStatusWithRecovery(id);
    const action = requestedMode === "discovery" ? "retry-discovery" : runtimeRecoveryAction(initialRuntime);
    const initial: ProjectRecoveryResult = {
      recoveryId: `recovery_${crypto.randomUUID()}`,
      projectId: id,
      action,
      status: "accepted",
      sourceError: initialRuntime.failureReason ?? initialRuntime.message,
      runtime: initialRuntime,
      events: [],
      userAction: recoveryUserAction(action, initialRuntime),
      updatedAt: new Date().toISOString()
    };
    projectRecoverySnapshots.set(id, initial);
    const snapshot = initial;
    snapshot.status = "running";
    if (action === "unavailable") {
      snapshot.status = "blocked";
      appendRecoveryEvent(snapshot, "blocked", "当前没有可安全自动执行的恢复动作；未启动代码修复或重试路径。");
      return snapshot;
    }

    let runtime = initialRuntime;
    if (action === "retry-runtime") {
      appendRecoveryEvent(snapshot, "docker_launching", "正在检查并自动启动 Docker Desktop 安全沙盒。");
      recordProjectRuntimeStatus({
        ...runtime,
        status: "starting",
        phase: "starting_processes",
        updatedAt: new Date().toISOString(),
        message: "恢复中：正在检查 Docker Desktop 并准备安全沙盒。",
        failureReason: "none"
      });
      appendRecoveryEvent(snapshot, "daemon_waiting", "正在等待 Docker daemon 就绪（最长 180 秒）。");
      runtime = await startProjectWithFreshConfig(id);
      snapshot.runtime = runtime;
      // An adopted OCI container may legitimately report `installing` or
      // `starting` while its dependency layer is still warming. Do not turn
      // that intermediate lifecycle state into a user-facing blocked result.
      if (["installing", "starting"].includes(runtime.status)) {
        appendRecoveryEvent(snapshot, "sandbox_starting", "安全沙盒已接管，正在等待依赖安装和项目健康检查完成。");
        const waitDeadline = Date.now() + Math.min(
          Math.max(project.manifest?.budget.prepareTimeoutMs ?? 120_000, 30_000),
          300_000
        );
        while (["installing", "starting"].includes(runtime.status) && Date.now() < waitDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          runtime = await getProjectRuntimeStatusWithRecovery(id);
          snapshot.runtime = runtime;
          snapshot.updatedAt = new Date().toISOString();
          projectRecoverySnapshots.set(id, { ...snapshot, events: [...snapshot.events] });
        }
      }
      if (runtime.status !== "running") {
        snapshot.status = "blocked";
        // The deterministic starter has already tried the saved, allowlisted
        // launch contract.  At this point an LLM may *recommend* one of the
        // inspected candidates, but it cannot execute it or mutate the source.
        // This turns an opaque startup block into a concrete, user-approved
        // next step without weakening the sandbox boundary.
        snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime, credentialId }).catch(() => undefined);
        snapshot.userAction = recoveryUserAction("retry-runtime", runtime);
        if (snapshot.advice?.status === "passed" && snapshot.advice.nextStep === "use_candidate" && snapshot.advice.selectedCandidateId) {
          const candidate = snapshot.advice.candidates.find((item) => item.id === snapshot.advice?.selectedCandidateId);
          snapshot.userAction = candidate
            ? `AI 已根据脱敏启动日志建议“${candidate.label}”。请确认采用后再重试；系统不会自动执行模型建议的命令。`
            : snapshot.userAction;
        }
        appendRecoveryEvent(snapshot, "blocked", runtime.message || "安全沙盒未能启动。");
        return snapshot;
      }
    }

    appendRecoveryEvent(snapshot, "health_checking", "项目已启动，正在检查沙盒内页面连通性。");
    const connection = await testProjectConnection(project);
    if (!connection.ok) {
      snapshot.runtime = await getProjectRuntimeStatusWithRecovery(id);
      snapshot.status = "blocked";
      snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime: snapshot.runtime, credentialId }).catch(() => undefined);
      snapshot.userAction = "无需立即修改源码；请等待系统完成有限恢复。若仍失败，请补充项目启动所需的外部服务或凭据。";
      if (snapshot.advice?.status === "passed" && snapshot.advice.nextStep === "use_candidate" && snapshot.advice.selectedCandidateId) {
        const candidate = snapshot.advice.candidates.find((item) => item.id === snapshot.advice?.selectedCandidateId);
        if (candidate) snapshot.userAction = `AI 已建议采用“${candidate.label}”。请确认后再修改下一次沙盒启动配置。`;
      }
      appendRecoveryEvent(snapshot, "blocked", connection.message);
      return snapshot;
    }

    appendRecoveryEvent(snapshot, "discovery_retrying", "页面已连通，正在重新扫描真实控件、网络和可执行路径。");
    const discovery = await runSmokeFirstDiscovery({
      projectId: id,
      goal: "恢复后重新扫描页面，并只绑定具备真实入口、操作、oracle 和证据要求的测试路径。",
      smokeAttempts: 2,
      discoveryAttempts: 2
    });
    snapshot.runtime = await getProjectRuntimeStatusWithRecovery(id);
    snapshot.discovery = discovery;
    if (discovery.orchestration?.status === "ready") {
      snapshot.status = "completed";
      snapshot.userAction = "无需操作；页面扫描已恢复，可以继续生成或执行测试计划。";
      appendRecoveryEvent(snapshot, "completed", "恢复完成：页面连通性和 Discovery 已通过。");
    } else {
      snapshot.status = "blocked";
      snapshot.advice = await createRuntimeRecoveryAdvice({ project, runtime: snapshot.runtime, credentialId }).catch(() => undefined);
      snapshot.userAction = discovery.observation.diagnosis.userActionRequired
        ? "请根据页面实际提示完成登录、授权或凭据配置后重试。"
        : "无需重复点击；系统已保存页面截图、DOM、控制台和网络诊断，可查看详情后补充启动条件。";
      appendRecoveryEvent(snapshot, "blocked", discovery.message);
    }
    return snapshot;
  })().catch(async (error) => {
    const runtime = await getProjectRuntimeStatusWithRecovery(id).catch(() => ({
      projectId: id,
      status: "failed" as const,
      phase: "failed" as const,
      updatedAt: new Date().toISOString(),
      failureReason: "none" as const,
      message: "恢复任务初始化失败。",
      processes: []
    }));
    const failed: ProjectRecoveryResult = {
      recoveryId: `recovery_${crypto.randomUUID()}`,
      projectId: id,
      action: requestedMode === "discovery" ? "retry-discovery" : runtimeRecoveryAction(runtime),
      status: "failed",
      runtime,
      events: [],
      userAction: "恢复请求未完成。请查看运行详情；系统没有修改项目源码或覆盖既有测试证据。",
      updatedAt: new Date().toISOString()
    };
    appendRecoveryEvent(failed, "blocked", error instanceof Error ? error.message : "恢复任务发生未知错误。");
    return failed;
  }).finally(() => projectRecoveryTasks.delete(id));
  projectRecoveryTasks.set(id, task);
  task.catch(() => undefined);
  return task;
}
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

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

function assertOrganizationAccess(req: express.Request, organizationId: unknown) {
  const context = authContext(req);
  if (!isOrganizationAuthorized(context, organizationId)) throw new Error("organization_forbidden");
}

type ProjectScope = Parameters<typeof hasProjectScope>[0]["scope"];

async function assertProjectAccess(req: express.Request, projectId: unknown, scope: ProjectScope) {
  if (!projectId) return;
  const context = authContext(req);
  if (!context) throw new Error("project_not_found_or_forbidden");
  if (context.subject === "local-dev" || context.roles.includes("admin")) return;
  const decision = await projectAccessDecision({
    projectId: String(projectId),
    subject: context.subject,
    scope
  });
  if (!decision.member) throw new Error("project_not_found_or_forbidden");
  if (!decision.allowed) throw new Error("project_scope_forbidden");
}

function artifactUrl(filePath: string) {
  return `/artifacts/${path.relative(reportsDir, filePath).split(path.sep).join("/")}`;
}

function runBundleProjectId(bundle: Awaited<ReturnType<typeof readRunBundle>>) {
  return bundle.input?.projectId ?? bundle.project?.id;
}

async function readAuthorizedLegacyRun(req: express.Request, runId: string, scope: ProjectScope = "read_artifacts") {
  const bundle = await readRunBundle(runId);
  const projectId = runBundleProjectId(bundle);
  const context = authContext(req);
  if (!projectId && context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
    throw new Error("project_not_found_or_forbidden");
  }
  await assertProjectAccess(req, projectId, scope);
  return bundle;
}

/** Authorize a live control-plane Run without requiring its final bundle.
 * Browser evidence is streamed before judging commits run_bundle.json; using
 * the legacy bundle reader here turned every in-progress poll into ENOENT. */
async function assertAuthorizedRun(req: express.Request, runId: string, scope: ProjectScope = "read_artifacts") {
  const run = await runEventStore.get(runId);
  if (run) {
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, scope);
    return;
  }
  await readAuthorizedLegacyRun(req, runId, scope);
}

function isMissingRunBundle(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function unavailableRunReport(run: NonNullable<Awaited<ReturnType<typeof runEventStore.get>>>) {
  const finalStatus = run.gateStatus ?? (run.state === "blocked" ? "blocked" : run.state === "failed" ? "fail" : "needs-human-review");
  // Even the "bundle unavailable" fallback must mint its gate through the
  // Proof Bundle Service — never by hard-coding credibility flags.
  const machineGate = finalizeProofBundle({
    draft: {
      status: finalStatus,
      reasons: ["run_bundle_unavailable"],
      reasonDetails: [],
      assertionFailures: []
    },
    runId: run.id,
    machineGate: {
      status: finalStatus,
      reasons: ["run_bundle_unavailable"],
      reasonDetails: [],
      assertionFailures: []
    }
  }).machineGate;
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
      ...proofCredibility(
        {
          artifactIntegrityVerified: machineGate.evidenceComplete,
          evidenceGrounded: machineGate.evidenceComplete,
          evidenceComplete: machineGate.evidenceComplete
        },
        machineGate,
        false
      ),
      machineGate,
      judgeRecommendation: run.judgeRecommendation,
      humanDecision: run.humanDecision,
      finalStatus
    },
    machineGate,
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
app.use(planRouter(assertProjectAccess));
app.use(repairRouter(assertProjectAccess));
app.use("/api/credentials", requireRole(["admin"]));
app.use("/api/projects/grants", requireRole(["admin"]));
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
      let run = created;
      if (body.input.confirmedExecution) {
        // "确认并执行" is already the operator's plan/capability decision.
        // Persist planning and both approvals before the Graph can race into
        // runtime recovery, rather than asking the same user a second time.
        run = await planRunFromDurableInput(run.id);
        if (run.state === "awaiting-plan-approval") {
          run = await runEventStore.append({
            runId: run.id,
            type: "plan_approved",
            expectedVersion: run.version,
            actor: body.actor,
            idempotencyKey: `${body.idempotencyKey}:confirmed-plan`,
            payload: { source: "confirmed-execution" }
          });
        }
        if (run.state === "awaiting-permission") {
          run = await runEventStore.append({
            runId: run.id,
            type: "permission_granted",
            expectedVersion: run.version,
            actor: body.actor,
            idempotencyKey: `${body.idempotencyKey}:confirmed-permissions`,
            payload: { permissionProfile: body.input.permissionProfile, source: "confirmed-execution" }
          });
        }
      }
      startAgentGraphInBackground(run);
      res.status(201).json({ run });
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
      let existing = await runEventStore.get(req.params.id);
      if (!existing) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, existing.input.organizationId);
      await assertProjectAccess(req, existing.input.projectId, "run_tests");
      const graphMode = agentOrchestrationMode(
        typeof existing.input.projectId === "string" ? existing.input.projectId : undefined
      );
      // In active mode the Graph, rather than this HTTP route, creates the
      // durable plan. A user (or the production acceptance client) can submit
      // approval immediately after POST /v1/runs, before the background graph
      // has reached its approval interrupt. Drive that same graph thread to
      // its checkpoint first; never manufacture a plan_approved event from
      // the planning state.
      if (eventType === "plan_approved" && graphMode === "active" && existing.state === "planning") {
        await startAgentGraphForRun(existing);
        existing = await runEventStore.get(req.params.id);
        if (!existing) return void res.status(404).json({ error: "run_not_found" });
        if (existing.state !== "awaiting-plan-approval") {
          res.status(409).json({
            error: "plan_not_ready",
            message: "Agent Graph has not produced a reviewable test plan yet.",
            runState: existing.state
          });
          return;
        }
      }
      if (eventType === "plan_approved" && existing.state !== "awaiting-plan-approval") {
        res.status(409).json({
          error: "plan_not_ready",
          message: "A test plan must be generated before it can be approved.",
          runState: existing.state
        });
        return;
      }
      if (eventType === "decision_overridden") {
        z.object({ status: z.enum(["approved", "blocked", "accepted-risk"]), reason: z.string().min(1), originalDecision: z.string().optional(), newLabel: z.string().optional() }).parse(body.payload);
      }
      // Pause/resume/cancel race the Worker and Graph by design. The user's
      // operational intent must not turn into a dead button merely because an
      // internal node committed one progress event between GET and POST. In
      // active mode retry these controls against the latest durable version;
      // planning/permission/override mutations keep strict optimistic
      // concurrency because their payload changes business meaning.
      const operationalControl = graphMode === "active"
        && (eventType === "run_paused" || eventType === "run_resumed" || eventType === "run_cancelled");
      let run: typeof existing | undefined;
      for (let attempt = 0; attempt < (operationalControl ? 4 : 1); attempt += 1) {
        try {
          run = await runEventStore.append({
            runId: req.params.id,
            type: eventType,
            ...body,
            // The Graph creates plan_generated asynchronously. Once the API
            // has synchronized a planning run to its approval checkpoint, the
            // client cannot know that internal event's version yet.
            expectedVersion: (eventType === "plan_approved" && graphMode === "active") || operationalControl
              ? existing.version
              : body.expectedVersion,
            payload: body.payload ?? {}
          });
          break;
        } catch (error) {
          if (!operationalControl || !(error instanceof Error) || !error.message.startsWith("run_version_conflict:") || attempt === 3) throw error;
          const latest = await runEventStore.get(req.params.id);
          if (!latest) return void res.status(404).json({ error: "run_not_found" });
          // Cancellation that loses the race to a terminal result is already
          // complete and requires no destructive replay. Return that durable
          // truth to the caller instead of manufacturing a transition.
          if (eventType === "run_cancelled" && ["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(latest.state)) {
            return void res.json({ run: latest });
          }
          existing = latest;
        }
      }
      if (!run) throw new Error("run_control_retry_exhausted");
      const replayed = isIdempotentReplay(run);
      if (!replayed && eventType === "decision_overridden" && run.resultRunId) {
        await appendHumanOverrideConclusion({
          resultRunId: run.resultRunId,
          actor: body.actor,
          reason: String(body.payload?.reason ?? ""),
          status: String(body.payload?.status ?? "approved")
        });
      }
      if (!replayed && eventType === "plan_approved" && graphMode === "active") {
        await resumeAgentGraph(run.id, { approved: true, actor: body.actor });
      }
      if (!replayed && eventType === "permission_granted" && graphMode === "active") {
        // Permission approval starts the potentially long browser/LLM loop.
        // Running that loop inside this HTTP request made the Workbench look
        // frozen and could turn an eventual Graph validation error into a
        // failed button click even though permission_granted was already
        // durable. Return the queued Run immediately and let SSE/polling show
        // every subsequent Graph node and browser action.
        await resumeAgentGraphInBackground(run.id, { approved: true, actor: body.actor });
      }
      if (!replayed && (eventType === "permission_granted" || eventType === "run_resumed")
        && run.planProvenance?.source !== "dynamic-browser-agent") {
        await enqueueRun(run.id, run.version);
      }
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

/**
 * The benchmark harness owns its wall-clock budget.  Timeout must become a
 * durable, fail-closed Run result before the harness tears down its services;
 * otherwise a parent graph can keep waiting while the experiment is already
 * reported as failed.
 */
app.post("/v1/runs/:id/benchmark-timeout", async (req, res, next) => {
  try {
    const body = z.object({ timeoutMs: z.number().int().positive(), actor: z.string().min(1).default("benchmark-runner") }).parse(req.body);
    const current = await runEventStore.get(req.params.id);
    if (!current) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, current.input.organizationId);
    await assertProjectAccess(req, current.input.projectId, "run_tests");
    if (["completed", "failed", "blocked", "cancelled", "awaiting-human-review"].includes(current.state)) {
      return void res.json({ run: current, replayed: true });
    }
    interruptRun(current.id);
    const run = await runEventStore.append({
      runId: current.id,
      type: "run_blocked",
      expectedVersion: current.version,
      actor: body.actor,
      idempotencyKey: `benchmark-timeout:${current.id}:${current.version}`,
      payload: { finalStatus: "blocked", error: "execution_timeout", timeoutMs: body.timeoutMs }
    });
    res.json({ run });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("run_version_conflict:")) {
      return void res.status(409).json({ error: "run_version_conflict", actualVersion: Number(error.message.split(":")[1]) });
    }
    next(error);
  }
});

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
      const bundle = await readRunBundle(run?.resultRunId ?? req.params.id);
      const result = bundle.result;
      // RunBundle keeps evidence-bearing collections at its immutable top
      // level to avoid duplicating large payloads in `result`. Rehydrate the
      // public report projection here. Returning only `result` made parent
      // aggregates look like an operation-log with no coverage/attempts to
      // Benchmark and the Workbench, even though their child evidence existed.
      res.json({ report: {
        ...result,
        evidence: bundle.evidence,
        artifactsV2: bundle.artifactsV2 ?? result.artifactsV2,
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
        gateStatus: run?.gateStatus ?? result.gateStatus,
        finalStatus: run?.gateStatus ?? result.finalStatus,
        machineGate: run?.machineGate ?? result.machineGate,
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

app.get("/v1/runs/:id/browser-session", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ session: await readBrowserSession(run.id) ?? null });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/browser-observations", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.json({ observations: await readBrowserObservations(run.id) });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/browser-actions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const [decisions, actions] = await Promise.all([readBrowserDecisions(run.id), readBrowserActionResults(run.id)]);
    res.json({ decisions, actions });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/browser-frame", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(browserSessionFramePath(run.id), (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: "browser_frame_not_available" });
    });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/browser-live", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");

    // The Workbench consumes this as a binary canvas stream. Evidence files
    // remain immutable artifacts, while this endpoint only mirrors the latest
    // compositor frame from the same Playwright BrowserContext the Agent uses.
    let closed = false;
    let responseReady = false;
    const queuedFrames: Buffer[] = [];
    const writeFrame = (frame: Buffer) => {
      if (closed || res.writableEnded) return;
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(frame.length, 0);
      res.write(header);
      res.write(frame);
    };
    // Subscribe before committing the HTTP status. If the in-memory
    // Playwright session has already closed, this lets us return a useful 409
    // instead of first sending 200 and then crashing with ERR_HTTP_HEADERS_SENT.
    const unsubscribe = await subscribeBrowserLiveFrames(run.id, (frame) => {
      if (!responseReady) queuedFrames.push(frame);
      else writeFrame(frame);
    });
    res.status(200);
    res.setHeader("Content-Type", "application/x-ai-test-officer-browser-stream");
    res.setHeader("Cache-Control", "no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    responseReady = true;
    for (const frame of queuedFrames.splice(0)) writeFrame(frame);
    req.on("close", () => {
      closed = true;
      void unsubscribe();
    });
  } catch (error) {
    if (!res.headersSent && error instanceof Error && error.message === "browser_session_not_active") {
      return void res.status(409).json({ error: "browser_session_not_active", message: "共享浏览器会话尚未建立或已经结束。" });
    }
    next(error);
  }
});

app.post("/v1/runs/:id/browser-control/acquire", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    // This endpoint is itself an authenticated, explicit operator action. It
    // may pre-empt the Agent's short lease so the user can immediately handle
    // MFA, consent or a blocked page in the same Playwright context.
    res.json({ session: await acquireBrowserControl(run.id, "user", { force: true }) });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/browser-control/release", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ session: await releaseBrowserControl(run.id, "user") });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/browser-viewport", async (req, res, next) => {
  try {
    const body = z.object({
      width: z.number().finite().int().min(320).max(3_840),
      height: z.number().finite().int().min(240).max(2_160)
    }).strict().parse(req.body);
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ session: await resizeManagedBrowserViewport(run.id, body) });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/browser-input", async (req, res, next) => {
  try {
    const body = z.object({
      kind: z.enum(["click", "type", "press", "scroll"]),
      x: z.number().finite().nonnegative().optional(),
      y: z.number().finite().nonnegative().optional(),
      text: z.string().max(4_000).optional(),
      key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]).optional(),
      deltaY: z.number().finite().min(-5_000).max(5_000).optional()
    }).strict().parse(req.body);
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    res.json({ observation: await executeUserBrowserInput({ runId: run.id, ...body }) });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/recovery-actions", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const records = await listRecoveryRecords(req.params.id);
    res.json(records);
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/observations", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "read_artifacts");
    const records = await listRecoveryRecords(req.params.id);
    res.json({ observations: records.observations });
  } catch (error) { next(error); }
});

/** Resume the active graph with a recovery decision. Safe recovery actions
 * are executed by the graph; credential, source-write and other risky actions
 * remain interrupt-gated and are never performed by this route itself. */
app.post("/v1/runs/:id/recover", async (req, res, next) => {
  try {
    const body = z.object({
      approved: z.boolean().default(true),
      action: z.string().optional(),
      idempotencyKey: z.string().min(1).optional()
    }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const value = { approved: body.approved, actor: authContext(req)?.subject ?? "user", ...(body.action ? { action: body.action } : {}) };
    const projection = await getAgentGraphProjection(run.id);
    const resumed = projection?.pendingInterrupt
      ? await resumeAgentGraph(run.id, value)
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, runId: run.id, resumed: resumed ?? null, agent: await getAgentGraphProjection(run.id) ?? null });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/paths/:pathId/retry", async (req, res, next) => {
  try {
    const body = z.object({ idempotencyKey: z.string().min(1).optional() }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const projection = await getAgentGraphProjection(run.id);
    if (!projection) return void res.status(409).json({ error: "agent_state_unavailable" });
    const resumed = projection.pendingInterrupt
      ? await resumeAgentGraph(run.id, { approved: true, action: "retry-path", pathId: req.params.pathId, actor: authContext(req)?.subject ?? "user" })
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, pathId: req.params.pathId, idempotencyKey: body.idempotencyKey, resumed: resumed ?? null });
  } catch (error) { next(error); }
});

app.post("/v1/runs/:id/continue", async (req, res, next) => {
  try {
    const body = z.object({ approved: z.boolean().default(true) }).strict().parse(req.body ?? {});
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, run.input.projectId, "run_tests");
    if (agentOrchestrationMode(typeof run.input.projectId === "string" ? run.input.projectId : undefined) !== "active") {
      return void res.status(409).json({ error: "active_graph_required" });
    }
    const projection = await getAgentGraphProjection(run.id);
    const resumed = projection?.pendingInterrupt
      ? await resumeAgentGraph(run.id, { approved: body.approved, action: "continue-safe-paths", actor: authContext(req)?.subject ?? "user" })
      : (startAgentGraphInBackground(run), undefined);
    res.status(202).json({ accepted: true, resumed: resumed ?? null });
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

app.post("/v1/runs/:id/interrupts/:interruptId/resume", async (req, res, next) => {
  try {
    const body = z.object({
      approved: z.boolean().optional(),
      input: z.record(z.unknown()).default({}),
      decision: z.enum(["repair", "create-session", "provide-credentials", "recover-sandbox", "reopen-discovery", "dismiss"]).optional(),
      message: z.string().max(4_000).optional(),
      repairPlanId: z.string().optional()
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
    // `execution-result` is a private Graph/Worker rendezvous. A user response
    // cannot contain the signed execution generation, Attempt and artifacts
    // required to resume it safely. Older Workbench builds incorrectly showed
    // this as a generic repair choice, which appeared to do nothing and could
    // leave the graph checkpoint inconsistent.
    if (interrupt.kind === "execution-result") {
      return void res.status(409).json({
        error: "execution_result_worker_owned",
        message: "该等待项由执行 Worker 自动完成，不需要用户处理。"
      });
    }
    // The graph node that raised the interrupt decides how to interpret the
    // resume value. plan-approval / browser-permission / execution-result nodes
    // expect `{ approved, ...input }`; the repair-decision node expects a
    // structured RepairDecisionAnswer. Forward the matching shape so the
    // decision is actually applied rather than silently dismissed.
    const resumeValue = interrupt.kind === "repair-decision"
      ? { decision: body.decision ?? "dismiss", message: body.message, repairPlanId: body.repairPlanId }
      : { approved: body.approved ?? true, ...body.input };
    await resumeAgentGraph(run.id, resumeValue);
    // `resume` returns the raw graph state, which is not a projection and would
    // overwrite the client's view with a malformed object. Re-read the
    // projection the graph persisted while resuming, so the caller also sees any
    // *new* interrupt raised downstream of this decision.
    const agent = await getAgentGraphProjection(run.id);
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

/**
 * Open the project-level code surface without pretending that a test run
 * exists. This creates an un-analyzed sandbox session: it is safe to browse
 * and edit, but it cannot publish a test result or apply to the source tree.
 */
app.post("/v1/projects/:id/code-sessions", async (req, res, next) => {
  try {
    const body = z.object({
      summary: z.string().max(2_000).optional(),
      autoAnalyze: z.boolean().default(false),
      credentialId: z.string().optional()
    }).parse(req.body ?? {});
    const project = await getProject(req.params.id);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    await assertProjectAccess(req, project.id, "edit_sandbox");
    const reusable = body.autoAnalyze ? undefined : await findReusableProjectCodeSession(project.id);
    let repair = reusable ?? await createRepairSession({
      runId: `code-session:${project.id}:${crypto.randomUUID()}`,
      project,
      summary: body.summary ?? "项目代码沙盒已创建。原项目保持只读，保存和导出都只作用于沙盒副本。",
      failureClass: body.autoAnalyze ? "environment" : "unknown"
    });
    if (body.autoAnalyze) {
      const runtime = await getProjectRuntimeStatusWithRecovery(project.id);
      try {
        repair = await proposeProjectStartupRepair({
          sessionId: repair.id,
          project,
          runtime,
          credentialId: body.credentialId
        });
      } catch (error) {
        // The code surface remains useful when the provider is unavailable.
        // Return the session with an explicit diagnosis instead of turning a
        // model outage into another opaque, unopenable UI failure.
        const errorCode = (error instanceof Error ? error.message : "model_repair_failed")
          .replace(/[^a-zA-Z0-9_:-]/g, "_")
          .slice(0, 120);
        repair = await updateRepairSessionSummary(repair.id, {
          summary: `AI 启动修复未完成（${errorCode}）。沙盒副本已保留，原项目未修改。`,
          status: "editing",
          failureClass: "environment"
        });
      }
    }
    res.status(201).json({ repair });
  } catch (error) { next(error); }
});

app.get("/v1/repair-sessions/:id", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    res.json({ repair });
  } catch (error) { next(error); }
});

// Deliberately registered before the wildcard file-content route below. The
// workbench receives only the filtered sandbox snapshot tree, never arbitrary
// paths from the host project.
app.get("/v1/repair-sessions/:id/files", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "read_artifacts");
    res.json({ files: await listRepairWorkspaceFiles(repair.id) });
  } catch (error) { next(error); }
});

app.get("/v1/repair-sessions/:id/files/*", async (req, res, next) => {
  try {
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
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
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const requestedPath = (req.params as Record<string, string>)["0"] ?? "";
    res.json({ repair: await writeRepairFile({ id: repair.id, path: requestedPath, ...body }) });
  } catch (error) { next(error); }
});

app.post("/v1/repair-sessions/:id/validate", async (req, res, next) => {
  try {
    const body = z.object({ allowNetworkInstall: z.boolean().default(false) }).parse(req.body ?? {});
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
    await assertProjectAccess(req, repair.projectId, "edit_sandbox");
    const project = await getProject(repair.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    res.json({ repair: await validateRepairSession(repair.id, project, body) });
  } catch (error) { next(error); }
});

app.post("/v1/repair-sessions/:id/export", async (req, res, next) => {
  try {
    const body = z.object({ format: z.enum(["patch", "zip"]) }).parse(req.body);
    const repair = await readRepairSession(req.params.id);
    if (!repair) return void res.status(404).json({ error: "repair_session_not_found" });
    const run = await runEventStore.get(repair.runId);
    if (!run && !repair.runId.startsWith("code-session:")) return void res.status(404).json({ error: "run_not_found" });
    if (run) assertOrganizationAccess(req, run.input.organizationId);
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
    const safety = getWriteSafetyLayer();
    const proposed = safety.resolveProposal({
      actionId: `apply-${repair.id}`,
      proposedBy: "user",
      capability: "apply_source_patch",
      params: { repairSessionId: repair.id },
      reason: "User explicitly confirmed applying the validated sandbox patch.",
      sourceClaimIds: ["user-confirmation"],
      riskLevel: "high",
      requiresConfirmation: true,
      idempotencyKey: `apply-${repair.id}`,
      runId: run.id,
      projectId: repair.projectId,
      proposedAt: new Date().toISOString()
    });
    const policy = await safety.policyCheck(proposed);
    if (!policy.allowed) return void res.status(403).json({ error: "write_policy_denied", policy });
    const workflow = await safety.createApprovalWorkflow(proposed);
    if (workflow.status === "pending") safety.approveWorkflow(workflow.workflowId, authContext(req)?.subject ?? "user", "Explicit apply confirmation");
    let applied: Awaited<ReturnType<typeof applyRepairSession>> | undefined;
    const execution = await safety.executeApproved(proposed, async () => {
      applied = await applyRepairSession(repair.id, project, { confirmHighRisk: body.confirmHighRisk });
      return {
        executionId: `exec-${repair.id}`,
        actionId: proposed.actionId,
        status: "executed",
        affectedTables: ["sandbox_source"],
        affectedRows: applied.files.length,
        durationMs: 0,
        executedAt: new Date().toISOString(),
        executorId: authContext(req)?.subject ?? "user"
      };
    });
    if (execution.status !== "executed" || !applied) return void res.status(409).json({ error: "write_execution_failed", execution, workflow });
    res.json({ repair: applied, workflow, execution });
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
    let lastInterruptId: string | undefined;
    const sentRepairUpdates = new Map<string, string>();
    const sentLlmCalls = new Map<string, string>();
    let sentRecoveryFingerprint = "";
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
    const unsubscribeBrowser = subscribeBrowserAgentLifecycle(req.params.id, (event) => {
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
        if (agent.pendingInterrupt) {
          const isNew = agent.pendingInterrupt.id !== lastInterruptId;
          if (isNew) {
            res.write(`event: agent.interrupt.created\ndata: ${JSON.stringify(agent)}\n\n`);
            lastInterruptId = agent.pendingInterrupt.id;
          }
          res.write(`event: agent.interrupt.waiting\ndata: ${JSON.stringify(agent)}\n\n`);
          // Backward-compatible event the existing workbench may still consume.
          res.write(`event: agent.interrupt\ndata: ${JSON.stringify(agent)}\n\n`);
        } else if (lastInterruptId) {
          res.write(`event: agent.interrupt.resumed\ndata: ${JSON.stringify(agent)}\n\n`);
          lastInterruptId = undefined;
        } else {
          const eventName = agent.status === "failed"
            ? "agent.node.failed"
            : agent.status === "completed"
              ? "agent.node.completed"
              : "agent.node.started";
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(agent)}\n\n`);
        }
        sentAgentUpdatedAt = agent.updatedAt;
      }
      const recovery = await listRecoveryRecords(req.params.id);
      const latestDecision = recovery.decisions.at(-1);
      const latestAction = recovery.actions.at(-1);
      const latestObservation = recovery.observations.at(-1);
      const recoveryFingerprint = [latestDecision?.id, latestAction?.actionId, latestAction?.status, latestObservation?.id].filter(Boolean).join(":");
      if (recoveryFingerprint && recoveryFingerprint !== sentRecoveryFingerprint) {
        if (latestObservation) res.write(`event: agent.observation.created\ndata: ${JSON.stringify(latestObservation)}\n\n`);
        if (latestDecision) res.write(`event: agent.recovery.started\ndata: ${JSON.stringify(latestDecision)}\n\n`);
        if (latestAction) {
          const eventName = latestAction.status === "completed" ? "agent.recovery.completed" : latestAction.status === "blocked" || latestAction.status === "needs-confirmation" ? "agent.recovery.blocked" : "agent.recovery.started";
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(latestAction)}\n\n`);
        }
        sentRecoveryFingerprint = recoveryFingerprint;
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
      unsubscribeBrowser();
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

app.get("/api/projects", async (req, res, next) => {
  try {
    const context = authContext(req);
    const projects = await listProjects();
    if (!context || context.subject === "local-dev" || context.roles.includes("admin")) {
      res.json({ projects });
      return;
    }
    const allowed = new Set(await listAccessibleProjectIds(context.subject));
    res.json({ projects: projects.filter((project) => allowed.has(project.id)) });
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
    const graph = await buildCodeImpactGraph({ repositoryRoot, files: body.files, includeRepositorySources: body.scope === "repository", scenarios, historicalBugs: body.historicalBugs });
    res.json({ graph, businessGraph: await buildBusinessCapabilityGraph({ repositoryRoot, codeGraph: graph }) });
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

app.post("/api/projects", requireRole(["admin", "runner"]), async (req, res, next) => {
  try {
    const project = await saveProject(projectSchema.parse(req.body) as ProjectConfig);
    const context = authContext(req);
    if (context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
      await createProjectGrant({ projectId: project.id, subject: context.subject, role: "owner" });
    }
    res.status(201).json({ project });
  } catch (error) {
    next(error);
  }
});

app.use("/api/projects/:id", async (req, _res, next) => {
  try {
    if (!await getProject(req.params.id)) throw new Error("project_not_found_or_forbidden");
    await assertProjectAccess(req, req.params.id, projectScopeForOperation(req));
    next();
  } catch (error) {
    next(error);
  }
});
app.use("/api/projects/:id/grants", projectMemberRouter());

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

app.get("/api/projects/:id/recovery", async (req, res, next) => {
  try {
    const snapshot = projectRecoverySnapshots.get(req.params.id);
    if (snapshot) return void res.json({ recovery: snapshot });
    const runtime = await getProjectRuntimeStatusWithRecovery(req.params.id);
    const action = runtimeRecoveryAction(runtime);
    res.json({
      recovery: {
        recoveryId: "",
        projectId: req.params.id,
        action,
        status: action === "unavailable" ? "blocked" : "accepted",
        sourceError: runtime.failureReason ?? runtime.message,
        runtime,
        events: [],
        userAction: recoveryUserAction(action, runtime),
        updatedAt: new Date().toISOString()
      } satisfies ProjectRecoveryResult
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/recover-and-retry", async (req, res, next) => {
  try {
    const body = z.object({
      mode: z.enum(["auto", "runtime", "discovery"]).default("auto"),
      credentialId: z.string().min(1).max(200).optional()
    }).strict().parse(req.body ?? {});
    const project = await getProject(req.params.id);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    const existing = projectRecoverySnapshots.get(req.params.id);
    const runtime = await getProjectRuntimeStatusWithRecovery(req.params.id);
    const task = recoverAndRetryProject(req.params.id, body.mode, body.credentialId);
    // Deliberately return immediately: Docker startup and dependency recovery
    // may take minutes. The Workbench polls this same recovery record and
    // updates one conversation message instead of leaving a dead button.
    task.catch(() => undefined);
    res.status(202).json({
      accepted: true,
      recovery: existing ?? projectRecoverySnapshots.get(req.params.id) ?? {
        recoveryId: "",
        projectId: req.params.id,
        action: body.mode === "discovery" ? "retry-discovery" : runtimeRecoveryAction(runtime),
        status: "accepted",
        sourceError: runtime.failureReason ?? runtime.message,
        runtime,
        events: [],
        userAction: "系统已接收恢复请求，正在同步安全沙盒状态。",
        updatedAt: new Date().toISOString()
      }
    });
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
app.post("/api/projects/:id/start-async", async (req, res, next) => {
  try {
    const current = await getProjectRuntimeStatusWithRecovery(req.params.id);
    // This endpoint is an idempotent "ensure running" operation. A healthy
    // project sandbox is reusable across diagnosis and test Runs; overwriting
    // it with a synthetic `starting` record discarded the owned container
    // handles and made every imported project appear to require a restart.
    if (current.status === "running") {
      res.status(200).json({ accepted: false, reused: true, runtime: current });
      return;
    }
    if (["installing", "starting"].includes(current.status)) {
      res.status(202).json({ accepted: true, reused: true, runtime: current });
      return;
    }
    if (!projectStartTasks.has(req.params.id)) {
      const previous = current;
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
    res.status(202).json({ accepted: true, reused: false, runtime: getProjectRuntimeStatus(req.params.id) });
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

app.get("/api/planning/:planningId/flows", async (req, res, next) => {
  try {
    const query = z.object({
      projectId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional()
    }).parse(req.query);
    await assertProjectAccess(req, query.projectId, "run_tests");
    const page = await getPlanningFlowPage({
      inventoryId: req.params.planningId,
      projectId: query.projectId,
      cursor: query.cursor,
      limit: query.limit
    });
    if (!page) return void res.status(404).json({ error: "planning_inventory_not_found" });
    res.json(page);
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
    await assertProjectAccess(req, body.projectId, "run_tests");
    const project = await getProject(body.projectId);
    if (!project) return void res.status(404).json({ error: "project_not_found" });
    res.json(await createPlanningConversation({ project, request: body, reportsDir }));
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
    await assertProjectAccess(req, body.projectId, "run_tests");
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
    await assertProjectAccess(req, body.projectId, "run_tests");
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
        plan: grayPlanSchema.optional(),
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

app.get("/api/runs/latest", async (req, res, next) => {
  try {
    const runId = await readLatestRunId();
    if (!runId) {
      res.status(404).json({ error: "No run has been recorded yet" });
      return;
    }
    res.json(await readAuthorizedLegacyRun(req, runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId", async (req, res, next) => {
  try {
    res.json(await readAuthorizedLegacyRun(req, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/evidence", async (req, res, next) => {
  try {
    await assertAuthorizedRun(req, req.params.runId);
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

app.get("/api/runs/:runId/findings", async (req, res, next) => {
  try {
    await assertAuthorizedRun(req, req.params.runId);
    res.json({ findings: readFindingsFromAuditStore(req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId/judge-summary", async (req, res, next) => {
  try {
    await assertAuthorizedRun(req, req.params.runId);
    res.json({ judge: readJudgeSummaryFromAuditStore(req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/runs/:runId/download-bundle", async (req, res, next) => {
  try {
    const body = z.object({ maxInlineBytes: z.number().int().positive().optional() }).parse(req.body ?? {});
    const bundle = await readAuthorizedLegacyRun(req, req.params.runId);
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
    await assertAuthorizedRun(req, req.params.runId);
    res.json({ events: await readLoopEvents(req.params.runId) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/loop-events/latest", async (_req, res, next) => {
  try {
    const events = await readLatestLoopEvents();
    const runId = events.at(-1)?.runId ?? (await readLatestRunId());
    if (runId) await readAuthorizedLegacyRun(_req, runId);
    res.json({ events });
  } catch (error) {
    next(error);
  }
});

app.get("/api/live-run/latest", async (_req, res, next) => {
  try {
    const events = await readLatestLoopEvents();
    const runId = events.at(-1)?.runId ?? (await readLatestRunId());
    if (runId) await readAuthorizedLegacyRun(_req, runId);
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

app.get("/api/run-history", async (req, res, next) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const scenarioId = typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined;
    const verdict = typeof req.query.verdict === "string" ? req.query.verdict : undefined;
    const from = typeof req.query.from === "string" ? Date.parse(req.query.from) : undefined;
    const to = typeof req.query.to === "string" ? Date.parse(req.query.to) : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    let runs = await listRunHistory();
    const context = authContext(req);
    if (projectId) {
      await assertProjectAccess(req, projectId, "read_reports");
      runs = runs.filter((run) => run.projectId === projectId);
    } else if (context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
      const allowed = new Set(await listAccessibleProjectIds(context.subject));
      runs = runs.filter((run) => Boolean(run.projectId && allowed.has(run.projectId)));
    }
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

// Sustainable-agent observability surface. These endpoints expose only the
// structured, redacted projections; raw credentials and prompts never leave
// the provider/knowledge-boundary layer.
app.get("/api/agent/sustainability", async (_req, res, next) => {
  try {
    const platform = getAgentSustainability();
    res.json({
      modules: ["context-layer", "memory", "tool-gateway", "write-safety", "tracing", "llm-input", "feedback-loop"],
      tools: platform.tools.getRegistry().listTools(),
      pendingApprovals: platform.writeSafety.getPendingApprovals().length,
      feedback: await platform.feedback.getStageCounts()
    });
  } catch (error) { next(error); }
});

app.get("/api/runs/:runId/trace", async (req, res, next) => {
  try {
    const chain = await getAgentSustainability().tracer.getChainByRunId(req.params.runId);
    if (!chain) return void res.status(404).json({ error: "trace_not_found", runId: req.params.runId });
    res.json({ chain, spans: chain.spans });
  } catch (error) { next(error); }
});

app.get("/api/agent/tools", (_req, res) => {
  res.json({ tools: getAgentSustainability().tools.getRegistry().listTools() });
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
      const runtime = await startProjectWithFreshConfig(projectId);
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
app.listen(port, host, () => {
  console.log(`AI Test Officer agent listening on http://${host}:${port}`);
  console.log("Security boundary:", securitySummary());
});
