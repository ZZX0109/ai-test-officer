import { Router } from "express";
import { authContext } from "../../security.js";
import { trajectoryEmitter } from "../../trajectoryEmitter.js";
import { trajectoryEventStore } from "../../trajectoryEventStore.js";
import { projectTrajectoryEvents } from "../../trajectoryProjector.js";
import { runEventStore } from "../../runEventStore.js";
import type { RunInspectionRouterDependencies } from "./run-inspection.routes.js";

function numberQuery(value: unknown, fallback: number) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  return Number(value);
}

function optionalNumberQuery(value: unknown, fallback: number) {
  return typeof value === "string" ? numberQuery(value, fallback) : fallback;
}

function visibleToRequest(events: Awaited<ReturnType<typeof trajectoryEventStore.read>>, request: Parameters<typeof authContext>[0]) {
  const roles = authContext(request)?.roles ?? [];
  const canSeeDeveloper = roles.includes("admin") || roles.includes("maintainer");
  return events.filter((event) => event.visibility === "user" || canSeeDeveloper);
}

async function resolveRootRunId(run: Awaited<ReturnType<typeof runEventStore.get>>) {
  if (!run) return undefined;
  const visited = new Set<string>();
  let current = run;
  while (current.parentRunId && !visited.has(current.parentRunId)) {
    visited.add(current.id);
    const parent = await runEventStore.get(current.parentRunId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

async function readTrajectoryPage(
  run: NonNullable<Awaited<ReturnType<typeof runEventStore.get>>>,
  request: Parameters<typeof authContext>[0]
) {
  const scope = request.query.scope === "tree" ? "tree" : "run";
  const rootRunId = scope === "tree" ? await resolveRootRunId(run) : run.id;
  const afterSeq = numberQuery(request.query.afterSeq, 0);
  const afterRootSeq = numberQuery(request.query.afterRootSeq, afterSeq);
  const beforeSeq = optionalNumberQuery(request.query.beforeSeq, Number.MAX_SAFE_INTEGER);
  const beforeRootSeq = optionalNumberQuery(request.query.beforeRootSeq, Number.MAX_SAFE_INTEGER);
  const limit = Math.min(1_000, Math.max(1, numberQuery(request.query.limit, 200)));
  const compact = request.query.compact === "true";
  const storedEvents = compact
    ? await (async () => {
      const collected = [] as Awaited<ReturnType<typeof trajectoryEventStore.read>>;
      let cursor = scope === "tree" ? afterRootSeq : afterSeq;
      // Token deltas are durable audit events, but sending thousands of them
      // to a panel that immediately folds them made newer model calls vanish
      // behind the 1,000-event page boundary. Scan bounded pages server-side
      // and return the complete non-chunk history plus per-call chunk counts.
      for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
        const batch = scope === "tree"
          ? await trajectoryEventStore.readTree(rootRunId ?? run.id, { afterRootSeq: cursor, beforeRootSeq, limit: 1_000 })
          : await trajectoryEventStore.read(run.id, { afterSeq: cursor, beforeSeq, limit: 1_000 });
        if (!batch.length) break;
        collected.push(...batch);
        cursor = scope === "tree" ? (batch.at(-1)?.rootSeq ?? cursor) : (batch.at(-1)?.seq ?? cursor);
        if (batch.length < 1_000) break;
      }
      return collected;
    })()
    : scope === "tree"
      ? await trajectoryEventStore.readTree(rootRunId ?? run.id, { afterRootSeq, beforeRootSeq, limit: limit + 1 })
      : await trajectoryEventStore.read(run.id, { afterSeq, beforeSeq, limit: limit + 1 });
  const events = visibleToRequest(storedEvents, request);
  const chunkCounts = new Map<string, number>();
  if (compact) {
    for (const event of events) {
      if (event.type !== "llm.chunk") continue;
      const callId = typeof event.payload.callId === "string" ? event.payload.callId : undefined;
      if (callId) chunkCounts.set(callId, (chunkCounts.get(callId) ?? 0) + 1);
    }
  }
  const compactedEvents = compact
    ? events.filter((event) => event.type !== "llm.chunk").map((event) => {
      if (event.type !== "llm.request" || typeof event.payload.callId !== "string") return event;
      return { ...event, payload: { ...event.payload, streamChunkCount: chunkCounts.get(event.payload.callId) ?? 0 } };
    })
    : events;
  const hasMore = !compact && compactedEvents.length > limit;
  const page = compact ? compactedEvents : compactedEvents.slice(0, limit);
  const latestSeq = await trajectoryEventStore.latestSeq(run.id);
  const latestRootSeq = await trajectoryEventStore.latestRootSeq(rootRunId ?? run.id);

  return {
    runId: run.id,
    scope,
    rootRunId,
    view: (() => {
      const projected = projectTrajectoryEvents(page, run.id);
      if (compact) projected.summary.totalEvents = events.length;
      return projected;
    })(),
    events: page,
    page: {
      afterSeq,
      beforeSeq: beforeSeq === Number.MAX_SAFE_INTEGER ? undefined : beforeSeq,
      limit,
      nextAfterSeq: page.at(-1)?.seq ?? afterSeq,
      nextAfterRootSeq: page.at(-1)?.rootSeq ?? afterRootSeq,
      hasMore,
      latestSeq,
      latestRootSeq
    }
  };
}

export function trajectoryRouter(dependencies: RunInspectionRouterDependencies) {
  const { assertOrganizationAccess, assertProjectAccess } = dependencies;
  const router = Router();

  router.get("/v1/runs/:id/trajectory", async (req, res, next) => {
    try {
      const run = await runEventStore.get(String(req.params.id));
      if (!run) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, run.input.organizationId);
      await assertProjectAccess(req, run.input.projectId, "read_artifacts");
      res.json(await readTrajectoryPage(run, req));
    } catch (error) { next(error); }
  });

  router.get("/v1/runs/:id/trajectory/stream", async (req, res, next) => {
    try {
      const run = await runEventStore.get(String(req.params.id));
      if (!run) return void res.status(404).json({ error: "run_not_found" });
      assertOrganizationAccess(req, run.input.organizationId);
      await assertProjectAccess(req, run.input.projectId, "read_artifacts");
      const runId = run.id;
      const scope = req.query.scope === "tree" ? "tree" : "run";
      const rootRunId = scope === "tree" ? await resolveRootRunId(run) ?? run.id : run.id;
      let cursor = numberQuery(req.query.afterSeq, numberQuery(req.header("last-event-id"), 0));
      let rootCursor = numberQuery(req.query.afterRootSeq, numberQuery(req.header("last-event-root-seq"), cursor));
      let closed = false;
      let sendInFlight = false;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const write = (eventName: string, data: unknown, id?: number) => {
        if (closed) return;
        if (id !== undefined) res.write(`id: ${id}\n`);
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const sendAfter = async (after: number) => {
        if (sendInFlight || closed) return;
        sendInFlight = true;
        try {
        const events = visibleToRequest(scope === "tree"
          ? await trajectoryEventStore.readTree(rootRunId, { afterRootSeq: after, limit: 1_000 })
          : await trajectoryEventStore.read(runId, { afterSeq: after, limit: 1_000 }), req);
        for (const event of events) {
          const eventCursor = scope === "tree" ? (event.rootSeq ?? event.seq) : event.seq;
          if (eventCursor <= (scope === "tree" ? rootCursor : cursor)) continue;
          write("trajectory.event", event, eventCursor);
          if (scope === "tree") rootCursor = eventCursor;
          else cursor = eventCursor;
        }
        } finally {
          sendInFlight = false;
        }
      };
      const subscriptions = new Map<string, () => void>();
      const subscribeRun = (subRunId: string) => {
        if (subscriptions.has(subRunId)) return;
        subscriptions.set(subRunId, trajectoryEmitter.subscribe(subRunId, (event) => {
          const eventCursor = scope === "tree" ? (event.rootSeq ?? event.seq) : event.seq;
          if (eventCursor <= (scope === "tree" ? rootCursor : cursor)) return;
          if (!visibleToRequest([event], req).length) return;
          write("trajectory.event", event, eventCursor);
          if (scope === "tree") rootCursor = eventCursor;
          else cursor = eventCursor;
        }));
      };
      subscribeRun(runId);
      if (scope === "tree") subscribeRun(rootRunId);
      await sendAfter(scope === "tree" ? rootCursor : cursor);
      const initialTree = visibleToRequest(scope === "tree" ? await trajectoryEventStore.readTree(rootRunId, { afterRootSeq: 0, limit: 1_000 }) : await trajectoryEventStore.read(runId, { afterSeq: 0, limit: 1_000 }), req);
      for (const event of initialTree) subscribeRun(event.runId);
      const snapshot = projectTrajectoryEvents(initialTree, scope === "tree" ? rootRunId : runId);
      write("trajectory.snapshot", { runId, scope, rootRunId, view: snapshot, afterSeq: cursor, afterRootSeq: rootCursor, latestSeq: await trajectoryEventStore.latestSeq(runId), latestRootSeq: await trajectoryEventStore.latestRootSeq(rootRunId) });
      const heartbeat = setInterval(() => {
        void sendAfter(scope === "tree" ? rootCursor : cursor);
        write("heartbeat", { runId, scope, rootRunId, at: new Date().toISOString(), afterSeq: cursor, afterRootSeq: rootCursor });
      }, 1_000);
      req.once("close", () => {
        closed = true;
        clearInterval(heartbeat);
        for (const unsubscribe of subscriptions.values()) unsubscribe();
      });
    } catch (error) { next(error); }
  });

  return router;
}
