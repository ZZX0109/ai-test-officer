import { Router } from "express";
import { fixedGrayPlan } from "../../plan.js";
import { listPlatformCapabilities } from "../../platformCapabilities.js";
import { auditStoreStatus } from "../../sqliteAuditStore.js";
import { readLatestDemoVerification } from "../../demoVerificationStore.js";
import { listScenarios } from "../../scenarios.js";

/**
 * Meta / status routes: health probe, static capability/plan descriptors, and
 * read-only store status. These are pure reads with no side effects and no
 * role requirements, so they stay thin and dependency-light.
 *
 * Mounted by server.ts via `app.use(metaRouter)`.
 */
export const metaRouter = Router();

metaRouter.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "ai-test-officer-agent" });
});

metaRouter.get("/api/gray-plan", (_req, res) => {
  res.json(fixedGrayPlan);
});

metaRouter.get("/api/platform-capabilities", (_req, res) => {
  res.json({ capabilities: listPlatformCapabilities() });
});

metaRouter.get("/api/audit-store/status", (_req, res) => {
  res.json({ auditStore: auditStoreStatus() });
});

metaRouter.get("/api/demo-verification/latest", async (_req, res, next) => {
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

metaRouter.get("/api/scenarios", (_req, res) => {
  res.json({ scenarios: listScenarios() });
});
