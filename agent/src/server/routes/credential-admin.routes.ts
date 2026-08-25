import { Router } from "express";
import { z } from "zod";
import {
  createCredential,
  decrypt,
  deleteCredential,
  getCredential,
  listCredentials,
  rotateCredential,
  updateCredential
} from "../../credentialStore.js";
import { testCredentialConnection } from "../../testConnection.js";
import { executeLlmCall } from "../../llmProvider.js";
import { requireRole } from "../../security.js";
import {
  approveScenarioDraft,
  createHarnessGapScenarioDraft,
  installHarnessGapScenarioDraft,
  listHarnessGaps,
  listScenarioDrafts,
  probeScenarioDraft,
  updateHarnessGap
} from "../../harnessGapStore.js";

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

async function structuredCredentialPreflight(
  credential: NonNullable<Awaited<ReturnType<typeof getCredential>>>,
  connection: Awaited<ReturnType<typeof testCredentialConnection>>
) {
  try {
    const apiKey = await decrypt(credential.apiKeyEncrypted);
    const preflight = async (transportPreference: "stream" | "non-stream") => executeLlmCall({
      credential,
      apiKey,
      system: "Return only a JSON object with key ok and boolean value.",
      prompt: `Preflight structured output check (${transportPreference}).`,
      maxTokens: 256,
      timeoutMs: 30_000,
      transportPreference,
      context: { purpose: "planning", experimentId: "credential-preflight" }
    });
    const [streamResult, nonStreamResult] = await Promise.all([preflight("stream"), preflight("non-stream")]);
    let streamParsed: unknown;
    let nonStreamParsed: unknown;
    try { streamParsed = JSON.parse(streamResult.text); } catch { streamParsed = undefined; }
    try { nonStreamParsed = JSON.parse(nonStreamResult.text); } catch { nonStreamParsed = undefined; }
    const streamStructured = streamParsed && typeof streamParsed === "object" && (streamParsed as { ok?: unknown }).ok === true;
    const nonStreamStructured = nonStreamParsed && typeof nonStreamParsed === "object" && (nonStreamParsed as { ok?: unknown }).ok === true;
    return { ...connection, structuredOutput: streamStructured && nonStreamStructured, streamStructuredOutput: streamStructured, nonStreamStructuredOutput: nonStreamStructured, call: nonStreamResult.call, preflightCalls: [streamResult.call, nonStreamResult.call] };
  } catch (error) {
    const call = (error as { llmCall?: unknown }).llmCall;
    return { ...connection, ok: false, structuredOutput: false, message: "结构化输出预检失败", call };
  }
}

export function credentialAdminRouter() {
  const router = Router();
  router.use("/api/credentials", requireRole(["admin"]));

  router.get("/api/credentials", async (_req, res, next) => {
    try { res.json({ credentials: await listCredentials() }); }
    catch (error) { next(error); }
  });

  router.post("/api/credentials", async (req, res, next) => {
    try {
      const input = credentialSchema.parse(req.body);
      res.status(201).json({ credential: await createCredential(input) });
    } catch (error) { next(error); }
  });

  router.patch("/api/credentials/:id", async (req, res, next) => {
    try {
      const credential = await updateCredential(req.params.id, credentialSchema.partial().parse(req.body));
      if (!credential) return void res.status(404).json({ error: "Credential not found" });
      res.json({ credential });
    } catch (error) { next(error); }
  });

  router.post("/api/credentials/:id/rotate", async (req, res, next) => {
    try {
      const body = z.object({ apiKey: z.string().min(1), reason: z.string().optional() }).parse(req.body);
      const credential = await rotateCredential(req.params.id, body);
      if (!credential) return void res.status(404).json({ error: "Credential not found" });
      res.json({ credential });
    } catch (error) { next(error); }
  });

  router.delete("/api/credentials/:id", async (req, res, next) => {
    try { res.json({ deleted: await deleteCredential(req.params.id) }); }
    catch (error) { next(error); }
  });

  router.post("/api/credentials/:id/test", async (req, res, next) => {
    try {
      const credential = await getCredential(req.params.id);
      if (!credential) return void res.status(404).json({ error: "Credential not found" });
      const connection = await testCredentialConnection(credential);
      if (req.body?.mode !== "structured" || !connection.ok) return void res.json(connection);
      res.json(await structuredCredentialPreflight(credential, connection));
    } catch (error) { next(error); }
  });

  router.get("/api/harness-gaps", async (_req, res, next) => {
    try { res.json({ gaps: await listHarnessGaps() }); }
    catch (error) { next(error); }
  });

  router.patch("/api/harness-gaps/:id", async (req, res, next) => {
    try {
      const gap = await updateHarnessGap(req.params.id, z.object({ status: z.enum(["open", "implemented", "dismissed"]) }).parse(req.body));
      if (!gap) return void res.status(404).json({ error: "Harness gap not found" });
      res.json({ gap });
    } catch (error) { next(error); }
  });

  router.post("/api/harness-gaps/:id/draft-scenario", async (req, res, next) => {
    try {
      const draft = await createHarnessGapScenarioDraft(req.params.id);
      if (!draft) return void res.status(404).json({ error: "Harness gap not found" });
      res.status(201).json({ draft });
    } catch (error) { next(error); }
  });

  router.post("/api/harness-gaps/:id/install-draft", async (req, res, next) => {
    try {
      const draft = await installHarnessGapScenarioDraft(req.params.id);
      if (!draft) return void res.status(404).json({ error: "Harness gap not found" });
      if (draft.draftReviewStatus !== "approved") return void res.status(409).json({ error: "Scenario draft did not pass selector/oracle probe.", draft });
      res.status(201).json({ draft });
    } catch (error) { next(error); }
  });

  router.get("/api/scenario-drafts", async (_req, res, next) => {
    try { res.json({ drafts: await listScenarioDrafts() }); }
    catch (error) { next(error); }
  });

  router.post("/api/scenario-drafts/:id/probe", async (req, res, next) => {
    try {
      const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : undefined;
      const draft = await probeScenarioDraft(req.params.id, credentialId);
      if (!draft) return void res.status(404).json({ error: "Scenario draft not found" });
      res.json({ draft });
    } catch (error) { next(error); }
  });

  router.post("/api/scenario-drafts/:id/approve", async (req, res, next) => {
    try {
      const draft = await approveScenarioDraft(req.params.id);
      if (!draft) return void res.status(404).json({ error: "Scenario draft not found" });
      if (draft.draftReviewStatus !== "approved") return void res.status(409).json({ error: "Scenario draft probe failed; fix missingInfo before approving.", draft });
      res.status(201).json({ draft });
    } catch (error) { next(error); }
  });

  return router;
}
