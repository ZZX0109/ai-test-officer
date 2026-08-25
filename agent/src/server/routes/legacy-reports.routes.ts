import path from "node:path";
import { Router, type Request } from "express";
import { z } from "zod";
import { readEvidence, readLatestRunId, readRunBundle } from "../../evidenceStore.js";
import { readLatestLoopEvents, readLoopEvents } from "../../loopEventStore.js";
import { listRunHistory } from "../../runHistory.js";
import {
  readEvidenceFromAuditStore,
  readFindingsFromAuditStore,
  readJudgeSummaryFromAuditStore
} from "../../sqliteAuditStore.js";
import { buildRunBundleArchive } from "../../runBundleArchive.js";
import { authContext } from "../../security.js";
import { listAccessibleProjectIds } from "../../projectAccess.js";
import { requireRunnableTarget, runnableTargetShape } from "../../runRequestContract.js";
import { resolveProjectTarget } from "../../projectAdapter.js";
import { checkEnvironment } from "../../environmentCheck.js";
import { captureDesktopScreenshot, desktopCaptureStatus } from "../../desktopCaptureAdapter.js";
import type { ProjectScope } from "../services/runAccess.service.js";

interface LegacyReportsInput {
  reportsDir: string;
  artifactUrl: (filePath: string) => string;
  assertAuthorizedRun: (req: Request, runId: string, scope?: ProjectScope) => Promise<void>;
  assertProjectAccess: (req: Request, projectId: unknown, scope: ProjectScope) => Promise<void>;
  readAuthorizedLegacyRun: (req: Request, runId: string, scope?: ProjectScope) => Promise<Awaited<ReturnType<typeof readRunBundle>>>;
}

type RunHistoryEntry = Awaited<ReturnType<typeof listRunHistory>>[number];

function queryRunHistory(req: Request) {
  return {
    projectId: typeof req.query.projectId === "string" ? req.query.projectId : undefined,
    scenarioId: typeof req.query.scenarioId === "string" ? req.query.scenarioId : undefined,
    verdict: typeof req.query.verdict === "string" ? req.query.verdict : undefined,
    from: typeof req.query.from === "string" ? Date.parse(req.query.from) : undefined,
    to: typeof req.query.to === "string" ? Date.parse(req.query.to) : undefined,
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
  };
}

function applyRunHistoryFilters(runs: RunHistoryEntry[], query: ReturnType<typeof queryRunHistory>) {
  let filtered = runs;
  if (query.scenarioId) filtered = filtered.filter((run) => run.scenarioId === query.scenarioId);
  if (query.verdict) filtered = filtered.filter((run) => run.verdict === query.verdict);
  if (Number.isFinite(query.from)) filtered = filtered.filter((run) => Date.parse(run.timestamp) >= query.from!);
  if (Number.isFinite(query.to)) filtered = filtered.filter((run) => Date.parse(run.timestamp) <= query.to!);
  if (Number.isFinite(query.limit) && query.limit && query.limit > 0) filtered = filtered.slice(-Math.min(query.limit, 500));
  return filtered;
}

async function authorizedRunHistory(req: Request, input: LegacyReportsInput) {
  const query = queryRunHistory(req);
  let runs = await listRunHistory();
  const context = authContext(req);
  if (query.projectId) {
    await input.assertProjectAccess(req, query.projectId, "read_reports");
    runs = runs.filter((run) => run.projectId === query.projectId);
  } else if (context && context.subject !== "local-dev" && !context.roles.includes("admin")) {
    const allowed = new Set(await listAccessibleProjectIds(context.subject));
    runs = runs.filter((run) => Boolean(run.projectId && allowed.has(run.projectId)));
  }
  return applyRunHistoryFilters(runs, query);
}

export function legacyReportsRouter(input: LegacyReportsInput) {
  const router = Router();

  router.get("/api/runs/latest", async (req, res, next) => {
    try {
      const runId = await readLatestRunId();
      if (!runId) return void res.status(404).json({ error: "No run has been recorded yet" });
      res.json(await input.readAuthorizedLegacyRun(req, runId));
    } catch (error) { next(error); }
  });

  router.get("/api/runs/:runId", async (req, res, next) => {
    try { res.json(await input.readAuthorizedLegacyRun(req, req.params.runId)); }
    catch (error) { next(error); }
  });

  router.get("/api/runs/:runId/evidence", async (req, res, next) => {
    try {
      await input.assertAuthorizedRun(req, req.params.runId);
      const evidence = readEvidenceFromAuditStore(req.params.runId);
      res.json({ evidence: evidence.length ? evidence : await readEvidence(req.params.runId), loopEvents: await readLoopEvents(req.params.runId) });
    } catch (error) { next(error); }
  });

  router.get("/api/runs/:runId/findings", async (req, res, next) => {
    try {
      await input.assertAuthorizedRun(req, req.params.runId);
      res.json({ findings: readFindingsFromAuditStore(req.params.runId) });
    } catch (error) { next(error); }
  });

  router.get("/api/runs/:runId/judge-summary", async (req, res, next) => {
    try {
      await input.assertAuthorizedRun(req, req.params.runId);
      res.json({ judge: readJudgeSummaryFromAuditStore(req.params.runId) });
    } catch (error) { next(error); }
  });

  router.post("/api/runs/:runId/download-bundle", async (req, res, next) => {
    try {
      const body = z.object({ maxInlineBytes: z.number().int().positive().optional() }).parse(req.body ?? {});
      const bundle = await input.readAuthorizedLegacyRun(req, req.params.runId);
      const runDir = path.join(input.reportsDir, "runs", req.params.runId);
      const archive = await buildRunBundleArchive({
        bundle,
        outputFile: path.join(runDir, "run-bundle.zip"),
        manifestFile: path.join(runDir, "run-bundle-download-manifest.json"),
        reportsDir: input.reportsDir,
        maxInlineBytes: body.maxInlineBytes
      });
      res.json({ archive: { zipFile: input.artifactUrl(archive.zipFile), manifestFile: input.artifactUrl(archive.manifestFile), manifest: archive.manifest } });
    } catch (error) { next(error); }
  });

  router.get("/api/runs/:runId/loop-events", async (req, res, next) => {
    try {
      await input.assertAuthorizedRun(req, req.params.runId);
      res.json({ events: await readLoopEvents(req.params.runId) });
    } catch (error) { next(error); }
  });

  router.get("/api/loop-events/latest", async (req, res, next) => {
    try {
      const events = await readLatestLoopEvents();
      const runId = events.at(-1)?.runId ?? (await readLatestRunId());
      if (runId) await input.readAuthorizedLegacyRun(req, runId);
      res.json({ events });
    } catch (error) { next(error); }
  });

  router.get("/api/live-run/latest", async (req, res, next) => {
    try {
      const events = await readLatestLoopEvents();
      const runId = events.at(-1)?.runId ?? (await readLatestRunId());
      if (runId) await input.readAuthorizedLegacyRun(req, runId);
      const evidence = runId ? await readEvidence(runId) : [];
      const latestScreenshot = [...evidence].reverse().find((item) => item.type === "screenshot")?.file;
      const latestEvent = events.at(-1);
      const finished = events.some((event) => event.action === "generate_report" || event.title.includes("报告已生成"));
      res.json({ runId, status: finished ? "finished" : runId ? "running" : "idle", latestScreenshot, latestEvent, evidenceCount: evidence.length, events, evidence });
    } catch (error) { next(error); }
  });

  router.get("/api/run-history", async (req, res, next) => {
    try { res.json({ runs: await authorizedRunHistory(req, input) }); }
    catch (error) { next(error); }
  });

  router.post("/api/environment-check", async (req, res, next) => {
    try {
      const target = await resolveProjectTarget(z.object(runnableTargetShape).superRefine(requireRunnableTarget).parse(req.body));
      res.json(await checkEnvironment(target.frontendUrl));
    } catch (error) { next(error); }
  });

  router.get("/api/desktop-capture/status", async (_req, res, next) => {
    try { res.json(await desktopCaptureStatus()); }
    catch (error) { next(error); }
  });

  router.post("/api/desktop-capture/screenshot", async (req, res, next) => {
    try {
      const body = z.object({
        bundleId: z.string().min(1), windowId: z.string().min(1), approvalEventId: z.string().min(1),
        outputPath: z.string().startsWith("reports/"), allowedBundleIds: z.array(z.string().min(1)).optional()
      }).parse(req.body);
      res.json(await captureDesktopScreenshot(body));
    } catch (error) { next(error); }
  });

  return router;
}
