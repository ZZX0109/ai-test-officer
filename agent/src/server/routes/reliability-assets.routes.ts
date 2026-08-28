import { Router, type Request } from "express";
import path from "node:path";
import {
  applyTestAssetRequestV1Schema,
  createTestAssetRequestV1Schema,
  differentialRunRequestV1Schema,
  reliabilityAssetContextV1Schema,
  validateTestAssetRequestV1Schema
} from "@ai-test-officer/contracts";
import { authContext, requireRole } from "../../security.js";
import { grantAllows, listProjectGrants } from "../../projectAccess.js";
import { blockDifferentialRun, createDifferentialRun, refreshDifferentialRun } from "../../differentialRunService.js";
import { executeDifferentialRunWithDefaultExecutor } from "../../differentialRunExecutor.js";
import { getReliabilityAssetStore } from "../../reliabilityAssetStore.js";
import { applyTestAsset, createTestAsset, inspectTestAssetTarget, repositorySnapshotHash, validateTestAssetWithExecutor } from "../../testAssetService.js";
import { createDefaultTestAssetValidationExecutor } from "../../testAssetValidationExecutor.js";
import { runEventStore } from "../../runEventStore.js";
import { getProject, safeProjectPath } from "../../projectAdapter.js";
import { readCoverageItems } from "../../coverageStore.js";
import { readEvidence } from "../../evidenceStore.js";
import { canonicalSha256 } from "../../canonicalHash.js";
import type { ProjectScope } from "../../types.js";

type AuthorizeProject = (request: Request, projectId: unknown, scope: ProjectScope) => Promise<void> | void;

async function hasCapabilityGrant(request: Request, projectId: string, grantId: string) {
  const context = authContext(request);
  if (context?.subject === "local-dev" || context?.roles.includes("admin")) return true;
  const grant = (await listProjectGrants(projectId)).find((candidate) => candidate.id === grantId);
  return Boolean(grant && context && grantAllows(grant, context.subject, "apply_source"));
}

export interface ReliabilityAssetsRouterDependencies {
  assertOrganizationAccess: (request: Request, organizationId: unknown) => void;
  assertProjectAccess: AuthorizeProject;
}

type ReliabilityContextResult = { status: number; body: Record<string, unknown> };

async function readReliabilityContextSources(
  store: ReturnType<typeof getReliabilityAssetStore>,
  projectId: string,
  sourceRunId: string | undefined
) {
  const [dataContracts, oracles, coverageItems, evidence] = await Promise.all([
    store.listDataContracts(projectId),
    store.listOracles(projectId),
    sourceRunId ? readCoverageItems(sourceRunId) : Promise.resolve([]),
    sourceRunId ? readEvidence(sourceRunId) : Promise.resolve([])
  ]);
  return { dataContracts, oracles, coverageItems, evidence };
}

function selectContextContract(
  dataContracts: Awaited<ReturnType<ReturnType<typeof getReliabilityAssetStore>["listDataContracts"]>>,
  coverageItems: Awaited<ReturnType<typeof readCoverageItems>>
) {
  return dataContracts.find((item) => item.coverageItemIds.some((id) => coverageItems.some((coverage) => coverage.id === id))) ?? dataContracts[0];
}

function buildReliabilityContext(input: {
  projectId: string;
  sourceRunId?: string;
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  repositoryRoot: string;
  repositorySha256: string;
  sourceRun?: Awaited<ReturnType<typeof runEventStore.get>>;
  sources: Awaited<ReturnType<typeof readReliabilityContextSources>>;
}) {
  const { projectId, sourceRunId, project, repositoryRoot, repositorySha256, sourceRun, sources } = input;
  const selectedContract = selectContextContract(sources.dataContracts, sources.coverageItems);
  const timestamp = new Date().toISOString();
  return reliabilityAssetContextV1Schema.parse({
    schemaVersion: "1.0",
    projectId,
    sourceRunId,
    repositoryRoot,
    repositorySha256,
    sourceRun: sourceRun ? { id: sourceRun.id, state: sourceRun.state, gateStatus: sourceRun.gateStatus } : undefined,
    dataContracts: sources.dataContracts.map((item) => ({
      id: item.id,
      projectId: item.projectId,
      coverageItemIds: item.coverageItemIds,
      dataSourceKinds: item.dataSources.map((source) => source.kind),
      randomSeed: item.randomSeed,
      testTime: item.testTime
    })),
    oracleSpecs: sources.oracles.map((item) => ({
      id: item.id,
      coverageItemId: item.coverageItemId,
      type: item.type,
      description: item.description,
      source: item.source,
      decisionUse: item.decisionUse,
      lifecycleStatus: item.lifecycle.status
    })),
    coverageItems: sources.coverageItems.map((item) => ({
      id: item.id,
      runId: item.runId,
      flowId: item.flowId,
      module: item.module,
      surface: item.surface,
      risk: item.risk,
      disposition: item.disposition
    })),
    evidenceRefs: sources.evidence.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      timestamp: item.timestamp,
      artifactIds: item.artifactIds ?? []
    })),
    environmentDefaults: {
      environmentHash: canonicalSha256({ projectId, manifest: project.manifest, browserVersion: "playwright-managed" }),
      randomSeed: selectedContract?.randomSeed ?? 1,
      testTime: selectedContract?.testTime ?? timestamp,
      ociImage: project.manifest?.execution.image,
      browserVersion: "playwright-managed"
    }
  });
}

function validateContextSourceRun(
  projectId: string,
  sourceRunId: string | undefined,
  sourceRun: Awaited<ReturnType<typeof runEventStore.get>>
): ReliabilityContextResult | undefined {
  if (sourceRunId && !sourceRun) return { status: 404, body: { error: "source_run_not_found" } };
  if (sourceRun?.input.projectId && sourceRun.input.projectId !== projectId) {
    return { status: 409, body: { error: "source_run_project_mismatch" } };
  }
  return undefined;
}

async function getReliabilityContext(input: {
  request: Request;
  dependencies: ReliabilityAssetsRouterDependencies;
  store: ReturnType<typeof getReliabilityAssetStore>;
}): Promise<ReliabilityContextResult> {
  const projectId = String(input.request.query.projectId ?? "").trim();
  const sourceRunId = String(input.request.query.sourceRunId ?? "").trim() || undefined;
  if (!projectId) return { status: 400, body: { error: "project_id_required" } };
  await input.dependencies.assertProjectAccess(input.request, projectId, "run_tests");
  const project = await getProject(projectId);
  if (!project) return { status: 404, body: { error: "project_not_found_or_forbidden" } };
  const repositoryRoot = safeProjectPath(project);
  const repositorySha256 = await repositorySnapshotHash(repositoryRoot);
  const sourceRun = sourceRunId ? await runEventStore.get(sourceRunId) : undefined;
  const sourceRunError = validateContextSourceRun(projectId, sourceRunId, sourceRun);
  if (sourceRunError) return sourceRunError;
  if (sourceRun) input.dependencies.assertOrganizationAccess(input.request, sourceRun.input.organizationId);
  const sources = await readReliabilityContextSources(input.store, projectId, sourceRunId);
  return {
    status: 200,
    body: { context: buildReliabilityContext({ projectId, sourceRunId, project, repositoryRoot, repositorySha256, sourceRun, sources }) }
  };
}

export function reliabilityAssetsRouter(input: ReliabilityAssetsRouterDependencies) {
  const router = Router();
  const store = getReliabilityAssetStore();
  const validationExecutor = createDefaultTestAssetValidationExecutor({ runStore: runEventStore });

  router.get("/v1/reliability-assets/context", async (req, res, next) => {
    try {
      const result = await getReliabilityContext({ request: req, dependencies: input, store });
      res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  });

  router.post("/v1/differential-runs", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = differentialRunRequestV1Schema.parse(req.body);
      input.assertOrganizationAccess(req, body.organizationId);
      await input.assertProjectAccess(req, body.projectId, "run_tests");
      const differentialRun = await createDifferentialRun({ request: body, store, actor: "api-user" });
      void executeDifferentialRunWithDefaultExecutor({ id: differentialRun.id, assetStore: store }).catch(async (error: unknown) => {
        // The pair remains queued/running if a process-level failure occurs;
        // retain the failure as evidence rather than turning it into a pass or
        // hiding an unhandled rejection from the API process.
        await blockDifferentialRun({
          id: differentialRun.id,
          store,
          runStore: runEventStore,
          reason: `default_executor_failed:${error instanceof Error ? error.message : String(error)}`
        }).catch(() => undefined);
      });
      res.status(202).json({ differentialRun });
    } catch (error) { next(error); }
  });

  router.get("/v1/differential-runs/:id", async (req, res, next) => {
    try {
      const current = await store.getDifferentialRun(req.params.id);
      if (!current) return void res.status(404).json({ error: "differential_run_not_found" });
      input.assertOrganizationAccess(req, current.organizationId);
      await input.assertProjectAccess(req, current.projectId, "read_artifacts");
      const differentialRun = await refreshDifferentialRun({ id: current.id, store });
      const parentRun = await runEventStore.get(current.id);
      res.json({
        differentialRun,
        parentRun: parentRun ? {
          id: parentRun.id,
          state: parentRun.state,
          gateStatus: parentRun.gateStatus,
          executionStatus: parentRun.executionStatus
        } : undefined
      });
    } catch (error) { next(error); }
  });

  router.post("/v1/runs/:runId/test-assets", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const body = createTestAssetRequestV1Schema.parse({ ...req.body, sourceRunId: req.params.runId });
      const sourceRun = await runEventStore.get(req.params.runId);
      if (!sourceRun) return void res.status(404).json({ error: "source_run_not_found" });
      input.assertOrganizationAccess(req, sourceRun.input.organizationId);
      if (sourceRun.input.projectId && sourceRun.input.projectId !== body.projectId) return void res.status(409).json({ error: "source_run_project_mismatch" });
      await input.assertProjectAccess(req, body.projectId, "run_tests");
      const project = await getProject(body.projectId);
      if (!project) return void res.status(404).json({ error: "project_not_found_or_forbidden" });
      if (path.resolve(body.repositoryRoot) !== safeProjectPath(project)) return void res.status(403).json({ error: "asset_repository_root_forbidden" });
      const asset = await createTestAsset({ request: body, store });
      res.status(201).json({ asset });
    } catch (error) { next(error); }
  });

  router.get("/v1/test-assets/:id", async (req, res, next) => {
    try {
      const asset = await store.getTestAsset(req.params.id);
      if (!asset) return void res.status(404).json({ error: "test_asset_not_found" });
      await input.assertProjectAccess(req, asset.projectId, "read_artifacts");
      const target = await inspectTestAssetTarget({ asset });
      const oracleSpecs = (await Promise.all(asset.oracleSpecIds.map((id) => store.getOracle(id)))).filter(Boolean);
      res.json({ asset, oracleSpecs, target: { clean: target.clean, status: target.status, repositorySha256: target.repositorySha256, patch: target.patch, patchSha256: target.patchSha256 } });
    } catch (error) { next(error); }
  });

  router.post("/v1/test-assets/:id/validate", requireRole(["admin", "runner"]), async (req, res, next) => {
    try {
      const asset = await store.getTestAsset(req.params.id);
      if (!asset) return void res.status(404).json({ error: "test_asset_not_found" });
      await input.assertProjectAccess(req, asset.projectId, "run_tests");
      const request = validateTestAssetRequestV1Schema.parse(req.body ?? {});
      const validation = await validateTestAssetWithExecutor({
        id: req.params.id,
        executor: validationExecutor,
        store,
        runStore: runEventStore,
        mutations: request.mutationIds
      });
      res.json({ asset: validation });
    } catch (error) { next(error); }
  });

  router.post("/v1/test-assets/:id/apply", requireRole(["admin", "maintainer"]), async (req, res, next) => {
    try {
      const asset = await store.getTestAsset(req.params.id);
      if (!asset) return void res.status(404).json({ error: "test_asset_not_found" });
      await input.assertProjectAccess(req, asset.projectId, "apply_source");
      const applyRequest = applyTestAssetRequestV1Schema.parse(req.body);
      if (!(await hasCapabilityGrant(req, asset.projectId, applyRequest.capabilityGrantId))) {
        return void res.status(403).json({ error: "capability_grant_forbidden" });
      }
      const project = await getProject(asset.projectId);
      if (!project || path.resolve(asset.sourceRepositoryRoot) !== safeProjectPath(project)) return void res.status(403).json({ error: "asset_repository_root_forbidden" });
      const target = await inspectTestAssetTarget({ asset });
      if (!target.clean) {
        return void res.status(409).json({
          error: "target_worktree_dirty",
          status: target.status,
          patch: target.patch,
          patchSha256: target.patchSha256,
          repositorySha256: target.repositorySha256
        });
      }
      const result = await applyTestAsset({ id: req.params.id, request: applyRequest, store });
      res.json(result);
    } catch (error) { next(error); }
  });

  return router;
}
