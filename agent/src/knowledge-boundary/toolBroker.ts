import { createHash, randomUUID } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  knowledgeToolRequestSchema,
  type KnowledgeClaim,
  type KnowledgeToolExecution,
  type KnowledgeToolRequest,
  type LlmKnowledgeContext
} from "@ai-test-officer/contracts";
import { readRunBundle } from "../evidenceStore.js";
import { getProject, getProjectRuntimeStatusWithRecovery } from "../projectAdapter.js";
import { listRepairSessions } from "../repairWorkspace.js";
import { readLatestDiscoveryPageObservation } from "../pageObservationStore.js";
import { listScenarioDrafts } from "../harnessGapStore.js";
import type { EvidenceItem } from "../types.js";
import {
  canonicalSha256,
  persistKnowledgeToolExecution,
  readKnowledgeToolExecution
} from "./store.js";
import { assertModelSafePath, forbiddenModelPath, redactForModel } from "./redaction.js";
import { publishKnowledgeLifecycle } from "./lifecycle.js";

export const KNOWLEDGE_READ_TOOLS = [
  "read-run-evidence",
  "read-project-manifest",
  "inspect-project-file",
  "inspect-route",
  "inspect-api-operation",
  "read-repair-history",
  "read-runtime-log",
  "read-page-observation",
  "read-discovery-candidates"
] as const;

type KnowledgeReadTool = typeof KNOWLEDGE_READ_TOOLS[number];

const ignoredDirectories = new Set([
  ".git", ".next", ".nuxt", ".output", ".turbo", ".venv", "build", "coverage",
  "dist", "node_modules", "reports", "target", "vendor", "venv", "__pycache__"
]);

function projectRoot(project: { projectPath: string }) {
  const repositoryRoot = path.basename(process.cwd()) === "agent"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
  return path.isAbsolute(project.projectPath)
    ? path.resolve(project.projectPath)
    : path.resolve(repositoryRoot, project.projectPath);
}

function claim(input: Omit<KnowledgeClaim, "id" | "status" | "confidence" | "observedAt" | "sensitive">) {
  return {
    ...input,
    id: `knowledge_claim_${randomUUID()}`,
    status: "retrieved" as const,
    confidence: 1,
    observedAt: new Date().toISOString(),
    sensitive: false
  } satisfies KnowledgeClaim;
}

async function safeReadProjectFile(projectId: string, relativeInput: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("knowledge_project_not_found");
  const relative = assertModelSafePath(relativeInput);
  const root = projectRoot(project);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("knowledge_path_escape");
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("knowledge_project_file_not_found");
  if (metadata.size > 1024 * 1024) throw new Error("knowledge_project_file_too_large");
  const raw = await readFile(absolute, "utf8");
  return {
    project,
    relative,
    fileSha256: createHash("sha256").update(raw).digest("hex"),
    content: redactForModel(raw).slice(0, 40_000)
  };
}

async function collectTextFiles(root: string, limit = 1_000) {
  const result: string[] = [];
  const queue = [""];
  while (queue.length && result.length < limit) {
    const relativeDirectory = queue.shift()!;
    const absoluteDirectory = path.join(root, relativeDirectory);
    let handle;
    try {
      handle = await opendir(absoluteDirectory);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) queue.push(relative);
        continue;
      }
      if (!entry.isFile() || forbiddenModelPath.test(relative)) continue;
      if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|vue|svelte|json|ya?ml)$/i.test(relative)) continue;
      result.push(relative);
      if (result.length >= limit) break;
    }
  }
  return result;
}

async function inspectSourceMatches(projectId: string, needle: string, sourceKind: "route" | "api") {
  if (!needle.trim() || needle.length > 500) throw new Error("knowledge_inspection_query_invalid");
  const project = await getProject(projectId);
  if (!project) throw new Error("knowledge_project_not_found");
  const root = projectRoot(project);
  const matches: Array<{ file: string; line: number; excerpt: string }> = [];
  for (const relative of await collectTextFiles(root)) {
    let content: string;
    try {
      content = await readFile(path.join(root, relative), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle.toLowerCase())) continue;
      matches.push({
        file: relative,
        line: index + 1,
        excerpt: redactForModel(lines[index]).slice(0, 500)
      });
      if (matches.length >= 25) break;
    }
    if (matches.length >= 25) break;
  }
  return {
    project,
    matches,
    statement: matches.length
      ? `${sourceKind} inspection found ${matches.length} locked-source matches for ${needle}.`
      : `${sourceKind} inspection found no locked-source match for ${needle}.`
  };
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`knowledge_tool_input_missing:${key}`);
  return value.trim();
}

function assertNoSensitiveToolInput(value: unknown, key = ""): void {
  if (/password|passwd|secret|token|api[_-]?key|authorization|connection[_-]?string/i.test(key)) {
    throw new Error("knowledge_tool_sensitive_input_rejected");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveToolInput(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      assertNoSensitiveToolInput(item, childKey);
    }
  }
}

function modelSafeUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactForModel(value).slice(0, 1_000);
  if (Array.isArray(value)) return value.slice(0, 20).map(modelSafeUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          /password|passwd|secret|token|api[_-]?key|authorization|connection[_-]?string/i.test(key)
            ? "[REDACTED]"
            : modelSafeUnknown(item)
        ])
    );
  }
  return value;
}

function selectedEvidenceDetails(item: EvidenceItem): Record<string, unknown> | undefined {
  const payload = item.payload;
  if (item.type === "dom") {
    return {
      phase: payload.phase,
      readyState: payload.readyState,
      interactiveElementCount: payload.interactiveElementCount,
      controls: payload.controls,
      alerts: payload.alerts,
      consoleErrors: payload.consoleErrors,
      failedRequests: payload.failedRequests,
      changes: payload.changes
    };
  }
  if (item.type === "operation") {
    return {
      action: payload.action,
      code: payload.code,
      failureClass: payload.failureClass,
      message: payload.message,
      observationEvidenceRefs: payload.observationEvidenceRefs,
      changes: payload.changes
    };
  }
  if (item.type === "assertion") {
    const assertion = payload.assertion;
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return undefined;
    const record = assertion as Record<string, unknown>;
    return {
      name: record.name,
      passed: record.passed,
      expected: record.expected,
      actual: record.actual
    };
  }
  if (item.type === "network" || item.type === "console") {
    return payload;
  }
  return undefined;
}

/**
 * Return only the bounded, redacted evidence facts a model needs to explain a
 * failure. Artifact contents stay outside the prompt and can still be opened
 * explicitly through the proof/evidence APIs.
 */
export function summarizeEvidenceForModel(item: EvidenceItem) {
  return {
    id: item.id,
    type: item.type,
    scenarioId: item.scenarioId,
    attemptId: item.attemptId,
    stepId: item.stepId,
    summary: redactForModel(item.title).slice(0, 500),
    artifactIds: item.artifactIds?.slice(0, 20) ?? [],
    locator: item.locator ? modelSafeUnknown(item.locator) : undefined,
    details: modelSafeUnknown(selectedEvidenceDetails(item))
  };
}

async function executeReadTool(
  tool: KnowledgeReadTool,
  input: Record<string, unknown>,
  context: LlmKnowledgeContext
): Promise<{ summary: string; claims: KnowledgeClaim[]; data: unknown }> {
  if (tool === "read-run-evidence") {
    const runId = typeof input.runId === "string" ? input.runId : context.runId;
    if (!runId || (context.runId && context.runId !== runId)) throw new Error("knowledge_source_cross_run");
    const bundle = await readRunBundle(runId);
    const requestedIds = Array.isArray(input.evidenceIds)
      ? new Set(input.evidenceIds.filter((item): item is string => typeof item === "string"))
      : undefined;
    const evidence = bundle.evidence
      .filter((item) => !requestedIds || requestedIds.has(item.id))
      .slice(0, 100)
      .map(summarizeEvidenceForModel);
    return {
      summary: `Read ${evidence.length} committed evidence records for run ${runId}.`,
      claims: evidence.map((item) => claim({
        statement: `Evidence ${item.id}: ${item.summary}`,
        domain: "runtime",
        sourceRefs: [`evidence:${item.id}`],
        scope: { runId, scenarioId: item.scenarioId, attemptId: item.attemptId }
      })),
      data: evidence
    };
  }
  if (tool === "read-project-manifest") {
    const projectId = typeof input.projectId === "string"
      ? input.projectId
      : context.projectSnapshot?.projectId;
    if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
    if (context.projectSnapshot?.projectId && context.projectSnapshot.projectId !== projectId) {
      throw new Error("knowledge_source_cross_project");
    }
    const project = await getProject(projectId);
    if (!project) throw new Error("knowledge_project_not_found");
    const safeManifest = {
      id: project.id,
      name: project.name,
      frontendUrl: project.frontendUrl,
      backendUrl: project.backendUrl,
      manifest: project.manifest,
      hasLogin: Boolean(project.login),
      apiCredentialRequirementNames: project.apiCredentialRequirements?.map((item) => item.envName) ?? []
    };
    return {
      summary: `Read the saved manifest for project ${projectId}.`,
      claims: [claim({
        statement: `Project ${projectId} manifest and runtime metadata were retrieved from the saved registry.`,
        domain: "project-static",
        sourceRefs: [`project-manifest:${projectId}`],
        scope: { projectId }
      })],
      data: safeManifest
    };
  }
  if (tool === "inspect-project-file") {
    const projectId = typeof input.projectId === "string"
      ? input.projectId
      : context.projectSnapshot?.projectId;
    if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
    const relative = requireString(input, "path");
    const file = await safeReadProjectFile(projectId, relative);
    const lines = file.content.split(/\r?\n/);
    const startLine = Math.max(1, Number(input.startLine ?? 1));
    const endLine = Math.min(lines.length, Number(input.endLine ?? startLine + 200), startLine + 500);
    const excerpt = lines.slice(startLine - 1, endLine).join("\n");
    return {
      summary: `Read ${relative}:${startLine}-${endLine} from the locked project snapshot.`,
      claims: [claim({
        statement: `Project file ${relative} lines ${startLine}-${endLine} were inspected; content hash ${createHash("sha256").update(excerpt).digest("hex")}.`,
        domain: "project-static",
        sourceRefs: [`project-file:${projectId}:${relative}`],
        scope: { projectId, filePath: relative, fileSha256: file.fileSha256 }
      })],
      data: { path: relative, startLine, endLine, content: excerpt }
    };
  }
  if (tool === "inspect-route" || tool === "inspect-api-operation") {
    const projectId = typeof input.projectId === "string"
      ? input.projectId
      : context.projectSnapshot?.projectId;
    if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
    const needle = requireString(input, tool === "inspect-route" ? "route" : "operation");
    const inspected = await inspectSourceMatches(
      projectId,
      needle,
      tool === "inspect-route" ? "route" : "api"
    );
    return {
      summary: inspected.statement,
      claims: [claim({
        statement: inspected.statement,
        domain: "project-static",
        sourceRefs: [`project:${projectId}`],
        scope: { projectId }
      })],
      data: inspected.matches
    };
  }
  if (tool === "read-repair-history") {
    const runId = typeof input.runId === "string" ? input.runId : context.runId;
    if (!runId || (context.runId && context.runId !== runId)) throw new Error("knowledge_source_cross_run");
    const sessions = await listRepairSessions(runId);
    const data = sessions.map((session) => ({
      id: session.id,
      status: session.status,
      failureClass: session.failureClass,
      summary: session.summary,
      validationRunId: session.validation?.childRunId,
      changedFileCount: session.files.length
    }));
    return {
      summary: `Read ${data.length} repair sessions for run ${runId}.`,
      claims: data.map((session) => claim({
        statement: `Repair ${session.id} is ${session.status}: ${session.summary}`,
        domain: "runtime",
        sourceRefs: [`repair:${session.id}`],
        scope: { runId }
      })),
      data
    };
  }
  if (tool === "read-page-observation") {
    const projectId = typeof input.projectId === "string"
      ? input.projectId
      : context.projectSnapshot?.projectId;
    if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
    if (context.projectSnapshot?.projectId && context.projectSnapshot.projectId !== projectId) {
      throw new Error("knowledge_source_cross_project");
    }
    const stored = await readLatestDiscoveryPageObservation(projectId);
    if (!stored) throw new Error("knowledge_discovery_observation_not_found");
    const observation = stored.observation;
    const data = {
      id: observation.id,
      status: observation.status,
      stage: observation.stage,
      requestedUrl: observation.requestedUrl,
      finalUrl: observation.finalUrl,
      capturedAt: observation.capturedAt,
      durationMs: observation.durationMs,
      navigation: observation.navigation,
      document: {
        readyState: observation.document.readyState,
        bodyTextSample: observation.document.bodyTextSample,
        interactiveElementCount: observation.document.interactiveElementCount,
        controls: observation.document.controls
      },
      console: observation.console,
      pageErrors: observation.pageErrors,
      failedRequests: observation.failedRequests,
      diagnosis: observation.diagnosis,
      screenshot: observation.screenshot
    };
    return {
      summary: `Read the latest committed page observation for project ${projectId}: ${observation.status}, ${observation.document.interactiveElementCount} interactive controls at ${observation.finalUrl}.`,
      claims: [claim({
        statement: `Discovery ${observation.id} observed ${observation.document.interactiveElementCount} interactive controls at ${observation.finalUrl}; status=${observation.status}; diagnosis=${observation.diagnosis.summary}`,
        domain: "runtime",
        sourceRefs: [`discovery:${observation.id}`],
        scope: { projectId }
      })],
      data
    };
  }
  if (tool === "read-discovery-candidates") {
    const projectId = typeof input.projectId === "string"
      ? input.projectId
      : context.projectSnapshot?.projectId;
    if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
    if (context.projectSnapshot?.projectId && context.projectSnapshot.projectId !== projectId) {
      throw new Error("knowledge_source_cross_project");
    }
    const drafts = (await listScenarioDrafts()).filter((draft) => {
      const matcher = draft.scenario.matcher;
      if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) return false;
      const projectIds = (matcher as Record<string, unknown>).projectIds;
      return Array.isArray(projectIds) && projectIds.includes(projectId);
    }).slice(-30);
    const data = drafts.map((draft) => ({
      scenarioId: draft.scenarioId,
      title: typeof draft.scenario.title === "string" ? draft.scenario.title : draft.scenarioId,
      reviewStatus: draft.draftReviewStatus ?? "draft",
      selectorProbeStatus: draft.selectorProbeStatus ?? "not_run",
      riskKind: draft.riskKind,
      selectors: modelSafeUnknown(draft.selectors),
      actions: draft.actions?.slice(0, 20) ?? [],
      oracles: modelSafeUnknown(draft.oracles),
      evidenceRequirements: draft.evidenceRequirements?.slice(0, 20) ?? [],
      missingInfo: draft.missingInfo?.slice(0, 20) ?? [],
      probeTrace: modelSafeUnknown(draft.probeTrace)
    }));
    return {
      summary: `Read ${data.length} Discovery scenario candidates scoped to project ${projectId}.`,
      claims: [claim({
        statement: `Project ${projectId} currently has ${data.length} persisted Discovery scenario candidates; ${data.filter((item) => item.selectorProbeStatus === "passed").length} passed selector probing.`,
        domain: "project-static",
        sourceRefs: [`project:${projectId}`],
        scope: { projectId }
      })],
      data
    };
  }
  const projectId = typeof input.projectId === "string"
    ? input.projectId
    : context.projectSnapshot?.projectId;
  if (!projectId) throw new Error("knowledge_tool_input_missing:projectId");
  const runtime = await getProjectRuntimeStatusWithRecovery(projectId);
  return {
    summary: `Read current runtime status ${runtime.status} for project ${projectId}.`,
    claims: [claim({
      statement: `Project ${projectId} runtime is ${runtime.status} (${runtime.phase}): ${redactForModel(runtime.message)}`,
      domain: "runtime",
      sourceRefs: [`project:${projectId}`],
      scope: { projectId, runId: context.runId },
      expiresAt: new Date(Date.now() + 30_000).toISOString()
    })],
    data: {
      status: runtime.status,
      phase: runtime.phase,
      progressPercent: runtime.progressPercent,
      failureReason: runtime.failureReason,
      message: redactForModel(runtime.message)
    }
  };
}

export async function executeKnowledgeReadTool(input: {
  context: LlmKnowledgeContext;
  request: KnowledgeToolRequest;
}) {
  const request = knowledgeToolRequestSchema.parse(input.request);
  assertNoSensitiveToolInput(request.input);
  if (!input.context.allowedTools.includes(request.tool)) throw new Error("knowledge_tool_not_allowed");
  if (!KNOWLEDGE_READ_TOOLS.includes(request.tool as KnowledgeReadTool)) {
    throw new Error("knowledge_tool_requires_capability_interrupt");
  }
  const inputSha256 = canonicalSha256(request.input);
  const id = `knowledge_tool_${createHash("sha256")
    .update(`${input.context.id}\0${request.tool}\0${inputSha256}`)
    .digest("hex")
    .slice(0, 32)}`;
  const existing = await readKnowledgeToolExecution(id, input.context.runId);
  if (existing) {
    return {
      execution: existing,
      summary: existing.outputSummary ?? existing.errorCode ?? "knowledge_tool_execution_replayed",
      claims: existing.outputClaims,
      data: existing.outputData
    };
  }
  const startedAt = new Date().toISOString();
  publishKnowledgeLifecycle({
    runId: input.context.runId,
    type: "knowledge.tool.started",
    payload: { executionId: id, contextId: input.context.id, tool: request.tool }
  });
  try {
    const output = await executeReadTool(
      request.tool as KnowledgeReadTool,
      request.input,
      input.context
    );
    const execution: KnowledgeToolExecution = {
      id,
      runId: input.context.runId,
      contextId: input.context.id!,
      request,
      inputSha256,
      status: "completed",
      outputClaimIds: output.claims.map((item) => item.id),
      outputClaims: output.claims,
      outputSummary: output.summary,
      outputData: output.data,
      startedAt,
      completedAt: new Date().toISOString()
    };
    await persistKnowledgeToolExecution(execution);
    publishKnowledgeLifecycle({
      runId: input.context.runId,
      type: "knowledge.tool.completed",
      payload: {
        executionId: id,
        contextId: input.context.id,
        tool: request.tool,
        outputClaimIds: execution.outputClaimIds
      }
    });
    return { execution, ...output };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : "knowledge_tool_failed";
    const execution: KnowledgeToolExecution = {
      id,
      runId: input.context.runId,
      contextId: input.context.id!,
      request,
      inputSha256,
      status: errorCode.includes("requires_capability") ? "denied" : "failed",
      outputClaimIds: [],
      outputClaims: [],
      outputSummary: errorCode,
      errorCode,
      startedAt,
      completedAt: new Date().toISOString()
    };
    await persistKnowledgeToolExecution(execution);
    publishKnowledgeLifecycle({
      runId: input.context.runId,
      type: "knowledge.tool.failed",
      payload: { executionId: id, contextId: input.context.id, tool: request.tool, errorCode }
    });
    return { execution, summary: errorCode, claims: [], data: undefined };
  }
}
