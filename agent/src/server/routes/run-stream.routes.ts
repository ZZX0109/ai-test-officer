import { Router } from "express";
import { runEventStore } from "../../runEventStore.js";
import { subscribeLlmLifecycle } from "../../llmLifecycle.js";
import { subscribeKnowledgeLifecycle } from "../../knowledge-boundary/lifecycle.js";
import { subscribeBrowserAgentLifecycle } from "../../browser-agent/store.js";
import { getAgentGraphProjection } from "../../agentGraphService.js";
import { listRecoveryRecords } from "../../recoveryStore.js";
import { listRepairSessions } from "../../repairWorkspace.js";
import { listLlmCalls } from "../../llmProvider.js";
import { readProofArtifacts } from "../../proofGraph.js";
import { readRunBundle } from "../../evidenceStore.js";
import type { RunInspectionRouterDependencies } from "./run-inspection.routes.js";

export function runStreamRouter(dependencies: RunInspectionRouterDependencies) {
  const { assertOrganizationAccess, assertProjectAccess } = dependencies;
  const router = Router();

router.get("/v1/runs/:id/stream", async (req, res, next) => {
  try {
    const run = await runEventStore.get(String(req.params.id));
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
    const unsubscribeLlm = subscribeLlmLifecycle(String(req.params.id), (event) => {
      res.write(`event: ${event.name}\ndata: ${JSON.stringify({
        callId: event.callId,
        at: event.at,
        ...event.payload
      })}\n\n`);
    });
    const unsubscribeKnowledge = subscribeKnowledgeLifecycle((event) => {
      if (event.runId !== String(req.params.id)) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify({
        at: event.createdAt,
        ...event.payload
      })}\n\n`);
    });
    const unsubscribeBrowser = subscribeBrowserAgentLifecycle(String(req.params.id), (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify({
        at: event.createdAt,
        ...event.payload
      })}\n\n`);
    });
    // eslint-disable-next-line complexity -- event emission is intentionally explicit per durable channel.
    const send = async () => {
      const events = await runEventStore.events(String(req.params.id));
      for (const event of events.filter((item) => item.version > sentVersion)) {
        res.write(`id: ${event.version}\nevent: state\ndata: ${JSON.stringify(event)}\n\n`);
        sentVersion = event.version;
      }
      const agent = await getAgentGraphProjection(String(req.params.id));
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
      const recovery = await listRecoveryRecords(String(req.params.id));
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
      const repairs = await listRepairSessions(String(req.params.id));
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
      for (const call of await listLlmCalls(String(req.params.id))) {
        const fingerprint = `${call.status}:${call.completedAt ?? call.startedAt}:${call.transportAttempts?.length ?? 0}`;
        if (sentLlmCalls.get(call.id) === fingerprint) continue;
        const eventName = call.status === "passed" ? "llm.call.completed" : "llm.call.failed";
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(call)}\n\n`);
        for (const attempt of (call.transportAttempts ?? []).slice(1)) {
          res.write(`event: llm.call.retried\ndata: ${JSON.stringify({ callId: call.id, attempt })}\n\n`);
        }
        sentLlmCalls.set(call.id, fingerprint);
      }
      const currentRun = await runEventStore.get(String(req.params.id));
      const proof = await readProofArtifacts(currentRun?.resultRunId ?? String(req.params.id));
      if (proof.manifest && proof.manifest.evidenceSetRoot !== sentEvidenceRoot) {
        const resultRunId = currentRun?.resultRunId ?? String(req.params.id);
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
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ runId: String(req.params.id), at: new Date().toISOString() })}\n\n`);
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

  return router;
}
