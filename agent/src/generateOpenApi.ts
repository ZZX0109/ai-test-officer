import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  agentGraphProjectionSchema,
  apiErrorSchema,
  artifactV2Schema,
  browserActionDecisionSchema,
  browserActionResultSchema,
  browserObservationSchema,
  browserSessionSchema,
  conclusionSchema,
  coverageItemSchema,
  createRunRequestSchema,
  agentMessageSchema,
  knowledgeClaimSchema,
  knowledgeConflictSchema,
  knowledgeDecisionSchema,
  knowledgeToolExecutionSchema,
  llmKnowledgeContextSchema,
  llmInvocationSchema,
  proofEdgeSchema,
  repairExportSchema,
  repairSessionSchema,
  runEventSchema
} from "@ai-test-officer/contracts";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();
const Run = registry.register("Run", z.object({ id: z.string(), state: z.string(), version: z.number().int(), gateStatus: z.string().optional() }));
const ApiError = registry.register("ApiError", apiErrorSchema);
registry.register("ArtifactV2", artifactV2Schema);
registry.register("RunEvent", runEventSchema);
const AgentGraphProjection = registry.register("AgentGraphProjection", agentGraphProjectionSchema);
const RepairSession = registry.register("RepairSession", repairSessionSchema);
const RepairExport = registry.register("RepairExport", repairExportSchema);
const CreateRun = registry.register("CreateRunRequest", createRunRequestSchema);
const CoverageItem = registry.register("CoverageItem", coverageItemSchema);
const LlmInvocation = registry.register("LlmInvocation", llmInvocationSchema);
const Conclusion = registry.register("Conclusion", conclusionSchema);
const ProofEdge = registry.register("ProofEdge", proofEdgeSchema);
const KnowledgeClaim = registry.register("KnowledgeClaim", knowledgeClaimSchema);
const KnowledgeContext = registry.register("LlmKnowledgeContext", llmKnowledgeContextSchema);
const KnowledgeDecision = registry.register("KnowledgeDecision", knowledgeDecisionSchema);
const KnowledgeConflict = registry.register("KnowledgeConflict", knowledgeConflictSchema);
const KnowledgeToolExecution = registry.register("KnowledgeToolExecution", knowledgeToolExecutionSchema);
const AgentMessage = registry.register("AgentMessage", agentMessageSchema);
const BrowserSession = registry.register("BrowserSession", browserSessionSchema);
const BrowserObservation = registry.register("BrowserObservation", browserObservationSchema);
const BrowserActionDecision = registry.register("BrowserActionDecision", browserActionDecisionSchema);
const BrowserActionResult = registry.register("BrowserActionResult", browserActionResultSchema);
registry.registerPath({ method: "post", path: "/v1/runs", request: { body: { content: { "application/json": { schema: CreateRun } } } }, responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ run: Run }) } } }, 400: { description: "Invalid request", content: { "application/json": { schema: ApiError } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Run", content: { "application/json": { schema: z.object({ run: Run }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/agent", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Agent graph projection", content: { "application/json": { schema: z.object({ agent: AgentGraphProjection.nullable() }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/browser-session", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Shared Playwright browser session", content: { "application/json": { schema: z.object({ session: BrowserSession.nullable() }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/browser-observations", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Structured browser observations", content: { "application/json": { schema: z.object({ observations: z.array(BrowserObservation) }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/browser-actions", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "LLM browser decisions and deterministic results", content: { "application/json": { schema: z.object({ decisions: z.array(BrowserActionDecision), actions: z.array(BrowserActionResult) }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/browser-live", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Length-prefixed live Playwright compositor stream", content: { "application/x-ai-test-officer-browser-stream": { schema: z.string() } } } } });
registry.registerPath({ method: "post", path: "/v1/runs/{id}/browser-control/acquire", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Acquire the shared browser for user input", content: { "application/json": { schema: z.object({ session: BrowserSession }) } } } } });
registry.registerPath({ method: "post", path: "/v1/runs/{id}/browser-control/release", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Return the shared browser to the Agent", content: { "application/json": { schema: z.object({ session: BrowserSession }) } } } } });
registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/browser-input",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({
      kind: z.enum(["click", "type", "press", "scroll"]),
      x: z.number().nonnegative().optional(),
      y: z.number().nonnegative().optional(),
      text: z.string().max(4_000).optional(),
      key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]).optional(),
      deltaY: z.number().min(-5_000).max(5_000).optional()
    }).strict() } } }
  },
  responses: { 200: { description: "User input applied to the shared Playwright page", content: { "application/json": { schema: z.object({ observation: BrowserObservation }) } } } }
});
registry.registerPath({ method: "get", path: "/v1/runs/{id}/coverage", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Coverage disposition", content: { "application/json": { schema: z.object({ coverage: z.array(CoverageItem), complete: z.boolean() }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/llm-calls", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Versioned LLM invocations", content: { "application/json": { schema: z.object({ calls: z.array(LlmInvocation) }) } } } } });
registry.registerPath({ method: "get", path: "/v1/runs/{id}/conclusions", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Verified conclusions", content: { "application/json": { schema: z.object({ conclusions: z.array(Conclusion) }) } } } } });
registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/knowledge",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Knowledge contexts, decisions, conflicts, tools, and durable conversation",
      content: {
        "application/json": {
          schema: z.object({
            contexts: z.array(KnowledgeContext),
            decisions: z.array(KnowledgeDecision),
            conflicts: z.array(KnowledgeConflict),
            toolExecutions: z.array(KnowledgeToolExecution),
            messages: z.array(AgentMessage)
          })
        }
      }
    }
  }
});
registry.registerPath({
  method: "get",
  path: "/v1/knowledge-contexts/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Knowledge context", content: { "application/json": { schema: KnowledgeContext } } } }
});
registry.registerPath({
  method: "get",
  path: "/v1/knowledge-claims/{id}/source",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ contextId: z.string().optional() })
  },
  responses: {
    200: {
      description: "Resolved claim source handle",
      content: {
        "application/json": {
          schema: z.object({
            claimId: z.string(),
            contextId: z.string(),
            status: z.enum(["observed", "user-provided", "retrieved", "inferred", "assumed", "unknown"]),
            domain: z.enum(["general", "project-static", "runtime", "user-intent", "credential-metadata", "external-documentation"]),
            statement: z.string().optional(),
            sensitive: z.boolean(),
            sourceRefs: z.array(z.string()),
            scope: z.object({
              organizationId: z.string().optional(),
              projectId: z.string().optional(),
              runId: z.string().optional(),
              scenarioId: z.string().optional(),
              attemptId: z.string().optional(),
              projectDigest: z.string().optional()
            })
          })
        }
      }
    }
  }
});
registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/knowledge-conflicts",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Knowledge conflicts", content: { "application/json": { schema: z.object({ conflicts: z.array(KnowledgeConflict) }) } } } }
});
registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/tool-executions",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Knowledge tool executions", content: { "application/json": { schema: z.object({ executions: z.array(KnowledgeToolExecution) }) } } } }
});
registry.registerPath({ method: "get", path: "/v1/conclusions/{id}/proof", request: { params: z.object({ id: z.string() }), query: z.object({ runId: z.string() }) }, responses: { 200: { description: "Conclusion proof graph", content: { "application/json": { schema: z.object({ conclusion: Conclusion, edges: z.array(ProofEdge) }) } } } } });
registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/messages",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ message: z.string().min(1), credentialId: z.string().optional() }) } } }
  },
  responses: { 200: { description: "Agent reply" }, 409: { description: "Model unavailable", content: { "application/json": { schema: ApiError } } } }
});
registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/interrupts/{interruptId}/resume",
  request: {
    params: z.object({ id: z.string(), interruptId: z.string() }),
    body: { content: { "application/json": { schema: z.object({ approved: z.boolean(), input: z.record(z.unknown()).optional() }) } } }
  },
  responses: { 200: { description: "Resumed graph", content: { "application/json": { schema: z.object({ agent: AgentGraphProjection }) } } } }
});
registry.registerPath({
  method: "post",
  path: "/v1/runs/{id}/repairs",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ autoAnalyze: z.boolean().optional(), credentialId: z.string().optional(), summary: z.string().optional() }) } } }
  },
  responses: { 201: { description: "Repair session", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } } }
});
registry.registerPath({
  method: "post",
  path: "/v1/projects/{id}/code-sessions",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({
      summary: z.string().optional(),
      autoAnalyze: z.boolean().optional(),
      credentialId: z.string().optional()
    }) } } }
  },
  responses: { 201: { description: "Project sandbox code session", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } } }
});
registry.registerPath({
  method: "get",
  path: "/v1/runs/{id}/repairs",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: "Repair sessions for a run", content: { "application/json": { schema: z.object({ repairs: z.array(RepairSession) }) } } } }
});
registry.registerPath({ method: "get", path: "/v1/repair-sessions/{id}", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "Repair session", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } } } });
registry.registerPath({
  method: "post",
  path: "/v1/repair-sessions/{id}/validate",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ allowNetworkInstall: z.boolean().optional() }) } } }
  },
  responses: { 200: { description: "Repair validation", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } } }
});
registry.registerPath({
  method: "get",
  path: "/v1/repair-sessions/{id}/files/{filePath}",
  request: { params: z.object({ id: z.string(), filePath: z.string().min(1) }) },
  responses: { 200: { description: "Repair workspace file", content: { "application/json": { schema: z.object({ file: z.object({ path: z.string(), content: z.string(), version: z.number().int(), sha256: z.string() }) }) } } } }
});
registry.registerPath({
  method: "put",
  path: "/v1/repair-sessions/{id}/files/{filePath}",
  request: {
    params: z.object({ id: z.string(), filePath: z.string().min(1) }),
    body: { content: { "application/json": { schema: z.object({ content: z.string(), version: z.number().int().nonnegative() }) } } }
  },
  responses: {
    200: { description: "Updated repair workspace file", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } },
    409: { description: "File version conflict", content: { "application/json": { schema: ApiError } } }
  }
});
registry.registerPath({
  method: "post",
  path: "/v1/repair-sessions/{id}/export",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ format: z.enum(["patch", "zip"]) }) } } }
  },
  responses: { 200: { description: "Repair export", content: { "application/json": { schema: z.object({ export: RepairExport, artifact: artifactV2Schema }) } } } }
});
registry.registerPath({
  method: "post",
  path: "/v1/repair-sessions/{id}/apply",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ confirm: z.literal(true), confirmHighRisk: z.boolean().optional() }) } } }
  },
  responses: { 200: { description: "Applied repair", content: { "application/json": { schema: z.object({ repair: RepairSession }) } } } }
});
const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({ openapi: "3.0.3", info: { title: "AI Test Officer API", version: "1.0.0" }, servers: [{ url: "/" }] });
const output = path.join(rootDir, "docs", "openapi.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(document, null, 2));
