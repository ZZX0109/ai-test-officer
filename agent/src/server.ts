import cors from "cors";
import express from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { commandSpecSchema } from "@ai-test-officer/contracts";
import {
  createCredential,
  deleteCredential,
  getCredential,
  listCredentials,
  rotateCredential,
  updateCredential
} from "./credentialStore.js";
import { buildScenarioGrayPlan, fixedGrayPlan } from "./plan.js";
import { generatePlan } from "./llmPlanner.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { redactText, redactValue } from "./redaction.js";
import { readConnectorContext } from "./sourceConnectors.js";
import { readAuditLog } from "./auditLog.js";
import { readEvidence, readLatestRunId, readRunBundle } from "./evidenceStore.js";
import { readLatestLoopEvents, readLoopEvents } from "./loopEventStore.js";
import { listRunHistory } from "./runHistory.js";
import { proposePlanRefinement } from "./planRefinement.js";
import { captureDesktopScreenshot, desktopCaptureStatus } from "./desktopCaptureAdapter.js";
import { checkEnvironment } from "./environmentCheck.js";
import { listPlatformCapabilities } from "./platformCapabilities.js";
import {
  assertSecurityConfig,
  authContext,
  basicRateLimit,
  createCorsOptions,
  requireApiToken,
  requireArtifactAccess,
  requireRole,
  securitySummary
} from "./security.js";
import { testCredentialConnection } from "./testConnection.js";
import { runVisualGrayTest } from "./testRunner.js";
import { getScenario, listScenarios } from "./scenarios.js";
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
import { readLatestDemoVerification } from "./demoVerificationStore.js";
import { requireRunnableTarget, runnableTargetShape, targetRuntimeSchema } from "./runRequestContract.js";
import {
  getProject,
  getProjectRuntimeStatus,
  listProjects,
  saveProject,
  startProject,
  stopProject,
  testProjectConnection,
  resolveProjectTarget,
  toTargetProjectConfig
} from "./projectAdapter.js";
import { detectProject, diagnoseProject } from "./projectDetection.js";
import { runDiscoveryScan } from "./discoveryScan.js";
import { createProjectGrant, deleteProjectGrant, listProjectGrants } from "./projectAccess.js";
import {
  auditStoreStatus,
  readEvidenceFromAuditStore,
  readFindingsFromAuditStore,
  readJudgeSummaryFromAuditStore
} from "./sqliteAuditStore.js";
import { listStorageArchives, runStorageRetention, storageStatus } from "./storageGovernance.js";
import type { ProjectConfig } from "./types.js";
import { loadProjectManifest, manifestToProjectConfig } from "./projectManifest.js";
import { runEventStore } from "./runEventStore.js";
import type { RunEventType } from "@ai-test-officer/contracts";
import { createRunRequestSchema } from "@ai-test-officer/contracts";
import { buildCodeImpactGraph } from "./codeImpactGraph.js";
import { createMissionPreview } from "./missionPreview.js";
import { enqueueRun, executeQueuedRun, interruptRun } from "./runOrchestrator.js";

const app = express();
const port = Number(process.env.PORT ?? 4317);
const host = process.env.HOST ?? (process.env.AGENT_API_TOKEN ? "0.0.0.0" : "127.0.0.1");
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

function assertOrganizationAccess(req: express.Request, organizationId: unknown) {
  const context = authContext(req);
  if (!context || context.subject === "local-dev" || context.roles.includes("admin")) return;
  if (!organizationId || String(organizationId) !== context.organizationId) throw new Error("organization_forbidden");
}

function artifactUrl(filePath: string) {
  return `/artifacts/${path.relative(reportsDir, filePath).split(path.sep).join("/")}`;
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
app.use("/api/credentials", requireRole(["admin"]));
app.use("/api/projects/grants", requireRole(["admin"]));
app.post("/v1/runs", requireRole(["admin", "runner"]));
for (const action of ["plan-approval", "permissions", "pause", "resume", "cancel"]) app.post(`/v1/runs/:id/${action}`, requireRole(["admin", "runner"]));
app.post("/v1/runs/:id/decision-override", requireRole(["admin", "reviewer"]));

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ai-test-officer-agent" });
});

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
    res.json(await testCredentialConnection(credential));
  } catch (error) {
    next(error);
  }
});

app.get("/api/gray-plan", (_req, res) => {
  res.json(fixedGrayPlan);
});

app.get("/api/platform-capabilities", (_req, res) => {
  res.json({ capabilities: listPlatformCapabilities() });
});

app.get("/api/audit-store/status", (_req, res) => {
  res.json({ auditStore: auditStoreStatus() });
});

app.get("/api/demo-verification/latest", async (_req, res, next) => {
  try {
    const verification = await readLatestDemoVerification();
    if (!verification) {
      res.status(404).json({ error: "No demo verification has been recorded yet" });
      return;
    }
    res.json({ verification });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scenarios", (_req, res) => {
  res.json({ scenarios: listScenarios() });
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
    const draft = await probeScenarioDraft(req.params.id);
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

const permissionProfileSchema = z.object({
  observe: z.boolean(),
  browserControl: z.boolean(),
  workspaceControl: z.boolean(),
  ideTerminalControl: z.boolean(),
  systemControl: z.boolean()
});

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
    const created = await runEventStore.create({
      runId: body.runId,
      actor: body.actor,
      idempotencyKey: body.idempotencyKey,
      payload: { ...body.input, projectId: body.projectId, organizationId: body.organizationId }
    });
    let planPayload: Record<string, unknown> = {};
    if (created.state === "planning") {
      if (body.input.plannerMode === "llm") {
        try {
          const generated = await generatePlan({ requirement: body.input.requirement ?? "", diff: body.input.diff ?? "", credentialId: body.input.modelProfileId, requireLlm: true, runId: created.id, experimentId: body.input.experimentId, promptVersion: body.input.promptVersion });
          planPayload = { plan: generated.plan, compiledPlan: generated.compiledPlan, provenance: generated.provenance, llmCall: generated.llmCall, scenarioId: generated.scenarioId };
        } catch (error) {
          const reason = error instanceof Error ? error.message : "llm_planner_failed";
          const review = reason.startsWith("llm_plan_") || reason.includes("schema") || reason.includes("parse");
          const run = await runEventStore.append({ runId: created.id, type: review ? "human_review_requested" : "run_blocked", expectedVersion: created.version, actor: "planner", idempotencyKey: `${body.idempotencyKey}:planner-failed`, payload: { finalStatus: review ? "needs-human-review" : "blocked", error: redactText(reason), provenance: { source: "llm", promptVersion: body.input.promptVersion, modelProfileId: body.input.modelProfileId, compilationStatus: "rejected", fallbackReason: redactText(reason) } } });
          res.status(201).json({ run });
          return;
        }
      } else {
        const scenarioId = body.input.scenarioId ?? "task_filter_completed";
        planPayload = { plan: buildScenarioGrayPlan(getScenario(scenarioId)), provenance: { source: "deterministic", promptVersion: body.input.promptVersion, compilationStatus: "validated" }, scenarioId };
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
    res.status(201).json({ run });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    res.json({ run });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/events", async (req, res, next) => {
  try { const run = await runEventStore.get(req.params.id); if (!run) return void res.status(404).json({ error: "run_not_found" }); assertOrganizationAccess(req, run.input.organizationId); res.json({ events: await runEventStore.events(req.params.id) }); } catch (error) { next(error); }
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
      if (eventType === "decision_overridden") {
        z.object({ status: z.enum(["approved", "blocked", "accepted-risk"]), reason: z.string().min(1), originalDecision: z.string().optional(), newLabel: z.string().optional() }).parse(body.payload);
      }
      const run = await runEventStore.append({ runId: req.params.id, type: eventType, ...body, payload: body.payload ?? {} });
      if (eventType === "permission_granted" || eventType === "run_resumed") await enqueueRun(run.id, run.version);
      if (eventType === "run_paused" || eventType === "run_cancelled") interruptRun(run.id);
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
    const bundle = await readRunBundle(run?.resultRunId ?? req.params.id);
    res.json({ artifacts: bundle.artifactsV2 ?? [], legacyEvidence: bundle.evidence.filter((item) => !item.artifactIds?.length) });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/report", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    const result = (await readRunBundle(run?.resultRunId ?? req.params.id)).result;
    res.json({ report: { ...result, gateStatus: run?.gateStatus ?? result.gateStatus, finalStatus: run?.gateStatus ?? result.finalStatus, machineGate: run?.machineGate ?? result.machineGate, judgeRecommendation: run?.judgeRecommendation ?? result.judgeRecommendation, humanDecision: run?.humanDecision, planProvenance: run?.planProvenance, plannerCall: run?.plannerCall } });
  } catch (error) { next(error); }
});

app.get("/v1/runs/:id/stream", async (req, res, next) => {
  try {
    const run = await runEventStore.get(req.params.id);
    if (!run) return void res.status(404).json({ error: "run_not_found" });
    assertOrganizationAccess(req, run.input.organizationId);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let sentVersion = Number(req.header("last-event-id") ?? 0);
    const send = async () => {
      const events = await runEventStore.events(req.params.id);
      for (const event of events.filter((item) => item.version > sentVersion)) {
        res.write(`id: ${event.version}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
        sentVersion = event.version;
      }
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ runId: req.params.id, at: new Date().toISOString() })}\n\n`);
    };
    await send();
    const timer = setInterval(() => void send().catch(() => undefined), 1_000);
    req.once("close", () => clearInterval(timer));
  } catch (error) { next(error); }
});

app.post("/internal/v1/executions/:runId", async (req, res, next) => {
  try {
    if (!process.env.INTERNAL_WORKER_TOKEN || req.header("x-internal-worker-token") !== process.env.INTERNAL_WORKER_TOKEN) {
      return void res.status(403).json({ error: "internal_worker_identity_required" });
    }
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
      historicalBugs: z.array(z.object({ id: z.string(), title: z.string(), files: z.array(z.string()) })).max(500).optional()
    }).parse(req.body);
    const allowedRoot = path.resolve(process.env.WORKSPACE_ROOT ?? rootDir);
    const repositoryRoot = path.resolve(body.repositoryRoot);
    if (repositoryRoot !== allowedRoot && !repositoryRoot.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("impact_repository_outside_workspace");
    const scenarios = listScenarios().map((scenario) => ({ id: scenario.id, keywords: scenario.matcher?.keywords ?? [scenario.id] }));
    res.json({ graph: await buildCodeImpactGraph({ repositoryRoot, files: body.files, scenarios, historicalBugs: body.historicalBugs }) });
  } catch (error) { next(error); }
});

app.get("/api/benchmark/summary", async (_req, res, next) => {
  try {
    const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ projectId: string; category: string }>;
    const blindCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8")) as Array<{ projectId: string; category: string }>;
    const executionMap = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<{ logicalProjectId: string; executionProjectId: string }> };
    const challengeCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "challenge-cases.json"), "utf8")) as Array<{ projectId: string }>;
    const projectIds = Array.from(new Set(cases.map((item) => item.projectId)));
    const byProject = Object.fromEntries(projectIds.map((projectId) => [projectId, cases.filter((item) => item.projectId === projectId).length]));
    const evaluation = await readFile(path.join(rootDir, "reports", "benchmarks", "latest.json"), "utf8").then((value) => JSON.parse(value) as { experimentId?: string; status?: string; conclusion?: string; completedRuns?: number; plannedRuns?: number; blockers?: string[]; evaluations?: Array<{ split: string; completedRuns: number; plannedRuns: number; acceptance: { proven: boolean; reasons: string[] }; lanes: Record<string, Record<string, number | null>> }> }).catch(() => undefined);
    const blindEvaluation = evaluation?.evaluations?.find((item) => item.split === "blind");
    res.json({
      version: "benchmark-v1",
      status: "catalog_ready",
      caseCount: cases.length,
      blindCaseCount: blindCases.length,
      projectCount: new Set(["local_demo_app", ...executionMap.mappings.map((item) => item.executionProjectId), ...challengeCases.map((item) => item.projectId)]).size,
      fixtureProjects: ["local_demo_app", "customer_portal_lite"],
      executionMap,
      challengeCases: { count: challengeCases.length, projectIds: challengeCases.map((item) => item.projectId) },
      byProject,
      categories: Array.from(new Set(cases.map((item) => item.category))).sort(),
      runtimeMetrics: {
        status: evaluation?.status ?? "awaiting_agent_runs",
        experimentId: evaluation?.experimentId,
        conclusion: evaluation?.conclusion,
        completedRuns: evaluation?.completedRuns ?? evaluation?.evaluations?.reduce((sum, item) => sum + item.completedRuns, 0) ?? 0,
        plannedRuns: evaluation?.plannedRuns ?? evaluation?.evaluations?.reduce((sum, item) => sum + item.plannedRuns, 0) ?? 0,
        blockers: evaluation?.blockers ?? [],
        acceptance: blindEvaluation?.acceptance,
        lanes: blindEvaluation?.lanes ?? {}
      }
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

app.post("/api/projects", async (req, res, next) => {
  try {
    const project = await saveProject(projectSchema.parse(req.body) as ProjectConfig);
    res.status(201).json({ project });
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

app.get("/api/projects/:id/runtime", (req, res) => {
  res.json({ runtime: getProjectRuntimeStatus(req.params.id) });
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
    const project = await getProject(req.params.id);
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

app.post("/api/projects/:id/grants", async (req, res, next) => {
  try {
    const body = z.object({
      subject: z.string().min(1),
      role: z.enum(["viewer", "runner", "project_admin", "operator", "admin"]),
      expiresAt: z.string().optional(),
      scopes: z.array(z.enum(["read_project", "run_tests", "read_artifacts", "manage_project", "manage_credentials", "admin"])).optional()
    }).parse(req.body);
    res.status(201).json({ grant: await createProjectGrant({ ...body, projectId: req.params.id }) });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/projects/:id/grants/:grantId", async (req, res, next) => {
  try {
    res.json({ deleted: await deleteProjectGrant(req.params.id, req.params.grantId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/start", async (req, res, next) => {
  try {
    res.json({ runtime: await startProject(req.params.id) });
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
        prUrl: z.string().optional()
      })
      .parse(req.body);
    res.json({ analysis: analyzeIntake(body) });
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

app.post("/api/run-visual-test", async (req, res, next) => {
  try {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Wed, 14 Oct 2026 00:00:00 GMT");
    if (!process.env.INTERNAL_WORKER_TOKEN || req.header("x-internal-worker-token") !== process.env.INTERNAL_WORKER_TOKEN) {
      return void res.status(403).json({ error: "deprecated_internal_execution_only", replacement: "/v1/runs" });
    }
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
        sourceContexts: z.array(z.any()).optional()
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
    res.json({ evidence: evidence.length ? evidence : await readEvidence(req.params.runId) });
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

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  if (error instanceof Error && error.message === "CORS origin not allowed") {
    res.status(403).json({ error: "CORS origin not allowed" });
    return;
  }
  if (error instanceof Error && error.message === "organization_forbidden") {
    res.status(403).json({ error: "organization_forbidden" });
    return;
  }
  const safeError = error instanceof Error
    ? { name: error.name, message: redactText(error.message), stack: error.stack ? redactText(error.stack) : undefined }
    : redactValue(error);
  console.error("Unhandled agent error", safeError);
  res.status(500).json({ error: error instanceof Error ? redactText(error.message) : "Internal server error" });
});

assertSecurityConfig(host);
app.listen(port, host, () => {
  console.log(`AI Test Officer agent listening on http://${host}:${port}`);
  console.log("Security boundary:", securitySummary());
});
