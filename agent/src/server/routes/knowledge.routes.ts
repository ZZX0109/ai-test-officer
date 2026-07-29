import { Router, type Request } from "express";
import { knowledgeClaimSchema } from "@ai-test-officer/contracts";
import { authContext, isOrganizationAuthorized } from "../../security.js";
import { hasProjectScope } from "../../projectAccess.js";
import { runEventStore } from "../../runEventStore.js";
import {
  findKnowledgeClaim,
  listAgentMessages,
  listRunKnowledge,
  listRunKnowledgeConflicts,
  listRunKnowledgeToolExecutions,
  readKnowledgeContext
} from "../../knowledge-boundary/store.js";

async function authorizeRun(req: Request, runId: string) {
  const run = await runEventStore.get(runId);
  if (!run) throw new Error("run_not_found");
  const identity = authContext(req);
  if (!isOrganizationAuthorized(identity, run.input.organizationId)) {
    throw new Error("organization_forbidden");
  }
  if (
    run.input.projectId
    && identity
    && identity.subject !== "local-dev"
    && !identity.roles.includes("admin")
    && !await hasProjectScope({
      projectId: String(run.input.projectId),
      subject: identity.subject,
      scope: "read_artifacts"
    })
  ) {
    throw new Error("project_forbidden");
  }
  return run;
}

export function knowledgeRouter() {
  const router = Router();

  router.get("/v1/runs/:id/knowledge", async (req, res, next) => {
    try {
      await authorizeRun(req, req.params.id);
      const [knowledge, conflicts, toolExecutions, messages] = await Promise.all([
        listRunKnowledge(req.params.id),
        listRunKnowledgeConflicts(req.params.id),
        listRunKnowledgeToolExecutions(req.params.id),
        listAgentMessages(req.params.id)
      ]);
      res.json({ ...knowledge, conflicts, toolExecutions, messages });
    } catch (error) { next(error); }
  });

  router.get("/v1/runs/:id/knowledge-conflicts", async (req, res, next) => {
    try {
      await authorizeRun(req, req.params.id);
      res.json({ conflicts: await listRunKnowledgeConflicts(req.params.id) });
    } catch (error) { next(error); }
  });

  router.get("/v1/runs/:id/tool-executions", async (req, res, next) => {
    try {
      await authorizeRun(req, req.params.id);
      res.json({ executions: await listRunKnowledgeToolExecutions(req.params.id) });
    } catch (error) { next(error); }
  });

  router.get("/v1/knowledge-contexts/:id", async (req, res, next) => {
    try {
      const context = await readKnowledgeContext(req.params.id);
      if (!context) return void res.status(404).json({ error: "knowledge_context_not_found" });
      if (!context.runId) return void res.status(403).json({ error: "knowledge_context_unscoped" });
      await authorizeRun(req, context.runId);
      res.json({
        ...context,
        claims: context.claims.map((claim) => claim.sensitive
          ? { ...claim, statement: "[SENSITIVE_CLAIM_HANDLE]" }
          : claim)
      });
    } catch (error) { next(error); }
  });

  router.get("/v1/knowledge-claims/:id/source", async (req, res, next) => {
    try {
      const found = await findKnowledgeClaim(
        req.params.id,
        typeof req.query.contextId === "string" ? req.query.contextId : undefined
      );
      if (!found) return void res.status(404).json({ error: "knowledge_claim_not_found" });
      if (!found.runId) return void res.status(403).json({ error: "knowledge_claim_unscoped" });
      await authorizeRun(req, found.runId);
      const claim = knowledgeClaimSchema.parse(found.claim);
      res.json({
        claimId: claim.id,
        contextId: found.contextId,
        status: claim.status,
        domain: claim.domain,
        statement: claim.sensitive ? undefined : claim.statement,
        sensitive: claim.sensitive,
        sourceRefs: claim.sourceRefs,
        scope: claim.scope
      });
    } catch (error) { next(error); }
  });

  return router;
}
