import { readFile } from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import { z } from "zod";
import { agentPermissionProfileSchema } from "@ai-test-officer/contracts";
import { requireInternalWorkerIdentity } from "../../security.js";
import { executeQueuedRun } from "../../runOrchestrator.js";
import { createMissionPreview } from "../../missionPreview.js";
import { buildCodeImpactGraph } from "../../codeImpactGraph.js";
import { buildBusinessCapabilityGraph } from "../../businessCapabilityGraph.js";
import { listScenarios } from "../../scenarios.js";
import { buildBenchmarkCatalog, trustedBenchmarkRuntimeMetrics } from "../../benchmarkSummary.js";
import { readConnectorContext } from "../../sourceConnectors.js";
import { analyzeIntake } from "../../intakeAnalyzer.js";
import { getPlanningFlowPage, getPlanningFunctionPage, getPlanningInventoryProjectId } from "../../planningInventoryStore.js";
import { getProject } from "../../projectAdapter.js";
import { createPlanningConversation } from "../../planningService.js";
import { trajectoryEventStore } from "../../trajectoryEventStore.js";
import { projectTrajectoryEvents } from "../../trajectoryProjector.js";
import { runnableTargetShape, requireRunnableTarget } from "../../runRequestContract.js";
import { runCommitCheck } from "../../commitCheckOrchestrator.js";
import { listCommitChecks } from "../../commitCheckStore.js";
import { runRequirementAcceptance } from "../../requirementAcceptanceOrchestrator.js";
import { listRequirementAcceptances } from "../../requirementAcceptanceStore.js";
import type { ProjectScope } from "../../types.js";

export const connectorContextSchema = z.object({
  requirementPath: z.string().optional(),
  requirementUrl: z.string().url().optional(),
  bugTicketPath: z.string().optional(),
  bugTicketUrl: z.string().url().optional(),
  openApiPath: z.string().optional(),
  openApiUrl: z.string().url().optional(),
  prUrl: z.string().optional(),
  prDiffUrl: z.string().optional(),
  gitBase: z.string().optional(),
  gitHead: z.string().optional(),
  staged: z.boolean().default(false),
  fallbackDiff: z.string().optional(),
  strictInput: z.boolean().default(false)
});

function withConnectorDemoDefaults(input: z.infer<typeof connectorContextSchema>) {
  if (input.strictInput) return input;
  return {
    ...input,
    requirementPath: input.requirementPath ?? (input.requirementUrl ? undefined : "data/fixtures/task-filter-requirement.md"),
    bugTicketPath: input.bugTicketPath ?? (input.bugTicketUrl ? undefined : "data/fixtures/tapd-task-filter-bug.md")
  };
}

export interface WorkbenchOperationsRouterDependencies {
  rootDir: string;
  reportsDir: string;
  assertProjectAccess: (request: Request, projectId: unknown, scope: ProjectScope) => Promise<unknown>;
}

export function workbenchOperationsRouter(dependencies: WorkbenchOperationsRouterDependencies) {
  const { assertProjectAccess, reportsDir, rootDir } = dependencies;
  const router = Router();

router.post("/internal/v1/executions/:runId", requireInternalWorkerIdentity, async (req, res, next) => {
  try {
    res.json({ run: await executeQueuedRun(String(req.params.runId)) });
  } catch (error) { next(error); }
});

router.post("/v1/mission-preview", (req, res, next) => {
  try {
    res.json(createMissionPreview(req.body));
  } catch (error) { next(error); }
});

router.post("/v1/impact/code-graph", async (req, res, next) => {
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

router.get("/api/benchmark/summary", async (_req, res, next) => {
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

router.post("/api/connectors/context", async (req, res, next) => {
  try {
    const body = withConnectorDemoDefaults(connectorContextSchema.parse(req.body));
    res.json({ context: await readConnectorContext(body) });
  } catch (error) {
    next(error);
  }
});

router.post("/api/intake/analyze-connected", async (req, res, next) => {
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

router.post("/api/intake/analyze", (req, res, next) => {
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

router.get("/api/planning/:planningId/flows", async (req, res, next) => {
  try {
    const query = z.object({
      projectId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional()
    }).parse(req.query);
    await assertProjectAccess(req, query.projectId, "run_tests");
    const page = await getPlanningFlowPage({
      inventoryId: String(req.params.planningId),
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

router.get("/api/planning/:planningId/functions", async (req, res, next) => {
  try {
    const query = z.object({
      projectId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional()
    }).parse(req.query);
    await assertProjectAccess(req, query.projectId, "run_tests");
    const page = await getPlanningFunctionPage({
      inventoryId: String(req.params.planningId),
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

router.get("/api/planning/:planningId/trajectory", async (req, res, next) => {
  try {
    const query = z.object({ projectId: z.string().min(1) }).parse(req.query);
    await assertProjectAccess(req, query.projectId, "run_tests");
    const planningId = String(req.params.planningId);
    if (await getPlanningInventoryProjectId(planningId) !== query.projectId) {
      return void res.status(404).json({ error: "planning_inventory_not_found" });
    }
    const events = await trajectoryEventStore.read(planningId, { limit: 1_000 });
    res.json({ view: projectTrajectoryEvents(events, planningId) });
  } catch (error) {
    next(error);
  }
});

router.post("/api/planning/conversation", async (req, res, next) => {
  try {
    const body = z.object({
      projectId: z.string().min(1),
      message: z.string().trim().min(1).max(20_000),
      diff: z.string().max(2_000_000).default(""),
      bugTicket: z.string().max(200_000).optional(),
      planningMode: z.enum(["llm-guided", "scan-only"]).default("llm-guided"),
      credentialId: z.string().optional(),
      planningId: z.string().regex(/^planning_[A-Za-z0-9_-]+$/).max(160).optional(),
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

router.post("/api/commit-check/run", async (req, res, next) => {
  try {
    const body = connectorContextSchema
      .extend({
        ...runnableTargetShape,
        scenarioId: z.string().optional(),
        credentialId: z.string().optional(),
        notify: z.array(z.string()).default(["oncall"]),
        permissionProfile: agentPermissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    await assertProjectAccess(req, body.projectId, "run_tests");
    res.json({ check: await runCommitCheck(body) });
  } catch (error) {
    next(error);
  }
});

router.get("/api/commit-checks", async (_req, res, next) => {
  try {
    res.json({ checks: await listCommitChecks() });
  } catch (error) {
    next(error);
  }
});

router.post("/api/requirement-acceptance/run", async (req, res, next) => {
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
        permissionProfile: agentPermissionProfileSchema
      })
      .superRefine(requireRunnableTarget)
      .parse(req.body);
    await assertProjectAccess(req, body.projectId, "run_tests");
    res.json({ acceptance: await runRequirementAcceptance(body) });
  } catch (error) {
    next(error);
  }
});

router.get("/api/requirement-acceptances", async (_req, res, next) => {
  try {
    res.json({ acceptances: await listRequirementAcceptances() });
  } catch (error) {
    next(error);
  }
});

  return router;
}
