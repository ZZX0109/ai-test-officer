import {
  trajectoryViewModelSchema,
  type TrajectoryEvent,
  type TrajectoryToolNode,
  type TrajectoryViewModel
} from "@ai-test-officer/contracts";

function payloadString(event: TrajectoryEvent, key: string) {
  const value = event.payload[key];
  return typeof value === "string" ? value : undefined;
}

function payloadValue(event: TrajectoryEvent, ...keys: string[]) {
  for (const key of keys) if (event.payload[key] !== undefined) return event.payload[key];
  return undefined;
}

function eventSequence(event: TrajectoryEvent) {
  return event.rootSeq ?? event.seq;
}

function buildTools(events: readonly TrajectoryEvent[]): { nodes: TrajectoryToolNode[]; warnings: string[] } {
  const tools = new Map<string, TrajectoryToolNode>();
  for (const event of events) {
    if (!(event.type.startsWith("tool.call.") || event.type === "tool.call" || event.type === "tool.result")) continue;
    const callId = payloadString(event, "callId") ?? payloadString(event, "executionId") ?? event.id;
    const current = tools.get(callId) ?? {
      callId,
      toolName: payloadString(event, "toolName") ?? payloadString(event, "tool") ?? "unknown",
      status: "started" as const,
      evidenceRefs: [],
      eventSeqs: []
    };
    const parentCallId = payloadString(event, "parentCallId") ?? payloadString(event, "parentToolCallId");
    if (parentCallId && parentCallId !== callId) current.parentCallId = parentCallId;
    current.eventSeqs = [...current.eventSeqs, eventSequence(event)];
    current.evidenceRefs = [...new Set([...current.evidenceRefs, ...event.evidenceRefs])];
    if (event.type === "tool.call.started" || event.type === "tool.call") {
      current.status = "started";
      current.startedAt = event.at;
    } else if (event.type === "tool.call.completed" || event.type === "tool.result" && payloadString(event, "status") === "completed") {
      current.status = "completed";
      current.completedAt = event.at;
      current.durationMs = typeof event.payload.durationMs === "number" ? event.payload.durationMs : undefined;
    } else {
      current.status = "failed";
      current.completedAt = event.at;
    }
    tools.set(callId, current);
  }
  const nodes = [...tools.values()];
  const byId = new Map(nodes.map((node) => [node.callId, node]));
  const warnings: string[] = [];
  const depthOf = (node: TrajectoryToolNode, seen = new Set<string>()): number => {
    if (seen.has(node.callId)) {
      warnings.push(`tool_tree_cycle:${node.callId}`);
      node.parentCallId = undefined;
      return 0;
    }
    if (!node.parentCallId || !byId.has(node.parentCallId)) return 0;
    if (seen.size >= 32) {
      warnings.push(`tool_tree_depth_exceeded:${node.callId}`);
      node.parentCallId = undefined;
      return 0;
    }
    seen.add(node.callId);
    return 1 + depthOf(byId.get(node.parentCallId)!, seen);
  };
  for (const node of nodes) node.depth = depthOf(node);
  return { nodes, warnings: [...new Set(warnings)] };
}

export function projectTrajectoryEvents(events: readonly TrajectoryEvent[], runId?: string): TrajectoryViewModel {
  const seenIds = new Set<string>();
  const ordered = [...events]
    .sort((left, right) => eventSequence(left) - eventSequence(right) || left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
    .filter((event) => {
      if (seenIds.has(event.id)) return false;
      seenIds.add(event.id);
      return true;
    });
  const first = ordered[0];
  const last = ordered.at(-1);
  const llmCallIds = new Set(ordered
    .filter((event) => event.type.startsWith("llm.") || event.type === "request.header")
    .map((event) => payloadString(event, "callId") ?? payloadString(event, "requestId") ?? event.id));
  const llmCalls = llmCallIds.size;
  const toolProjection = buildTools(ordered);
  const toolCalls = toolProjection.nodes;
  const browserActions = ordered.filter((event) => event.type === "browser.action.completed" || event.type === "browser.action.failed").length;
  const observations = ordered.filter((event) => event.type === "browser.observation.created").length;
  const evidence = ordered.filter((event) => event.type === "evidence.created" || event.type === "artifact.committed").length;
  const failures = ordered.filter((event) => event.status === "error" || event.status === "blocked" || event.type.endsWith(".failed") || event.type === "run.blocked" || event.type === "proof.invalid").length
    + toolCalls.filter((tool) => tool.status === "interrupted").length;
  const durationMs = first && last ? Math.max(0, new Date(last.at).getTime() - new Date(first.at).getTime()) : undefined;
  const eventLocations = Object.fromEntries(ordered.map((event) => [event.id, {
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {})
  }]));
  const requests = ordered
    .filter((event) => event.type === "request.header" || event.type === "llm.request" || event.type === "llm.call.started")
    .map((event) => ({
      eventSeq: eventSequence(event),
      ...(payloadString(event, "callId") ? { callId: payloadString(event, "callId") } : {}),
      ...(payloadString(event, "model") ? { model: payloadString(event, "model") } : {}),
      ...(payloadString(event, "systemPrompt") ? { systemPrompt: payloadString(event, "systemPrompt") } : {}),
      ...(Array.isArray(event.payload.tools) ? { tools: event.payload.tools } : {})
    }));
  const callSchemas = ordered.flatMap((event) => {
    const explicitSchema = payloadValue(event, "toolSchema", "callSchema");
    if (explicitSchema !== undefined) return [{
      eventSeq: eventSequence(event),
      ...(payloadString(event, "callId") ? { callId: payloadString(event, "callId") } : {}),
      ...(payloadString(event, "toolName") ? { toolName: payloadString(event, "toolName") } : {}),
      schema: explicitSchema
    }];
    if (event.type !== "llm.request" || !Array.isArray(event.payload.tools)) return [];
    return event.payload.tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const record = tool as Record<string, unknown>;
      return [{
        eventSeq: eventSequence(event),
        ...(payloadString(event, "callId") ? { callId: payloadString(event, "callId") } : {}),
        ...(typeof record.name === "string" ? { toolName: record.name } : {}),
        schema: record.schema ?? record.inputSchema ?? record
      }];
    });
  });
  const chunks = ordered.filter((event) => event.type === "assistant.chunk" || event.type === "llm.chunk");
  const responses = ordered.filter((event) => event.type === "llm.response");
  const latestResponse = responses.at(-1);
  const latestAttempt = Math.max(...chunks.map((event) => typeof event.payload.attempt === "number" ? event.payload.attempt : 0), 0);
  const visibleChunks = chunks.filter((event) => (typeof event.payload.attempt === "number" ? event.payload.attempt : latestAttempt) === latestAttempt);
  const responseText = latestResponse && latestResponse.status !== "error" ? payloadString(latestResponse, "text") : undefined;
  const partial = chunks.length || latestResponse ? {
    text: responseText ?? visibleChunks.map((event) => payloadString(event, "text") ?? payloadString(event, "textDelta") ?? payloadString(event, "delta") ?? "").join(""),
    reasoning: visibleChunks.map((event) => payloadString(event, "reasoning") ?? payloadString(event, "reasoningDelta") ?? "").join(""),
    lastSeq: latestResponse ? eventSequence(latestResponse) : eventSequence(visibleChunks.at(-1) ?? chunks.at(-1)!)
  } : undefined;
  const terminal = ordered.some((event) => ["run.completed", "run.failed", "run.blocked", "step.failed"].includes(event.type));
  if (terminal) {
    for (const tool of toolCalls) {
      if (tool.status === "started") tool.status = "interrupted";
    }
  }
  return trajectoryViewModelSchema.parse({
    schemaVersion: "1.0",
    runId: runId ?? first?.runId ?? "",
    ...(first?.rootRunId ? { rootRunId: first.rootRunId } : {}),
    fromSeq: first ? eventSequence(first) : 0,
    toSeq: last ? eventSequence(last) : 0,
    events: ordered,
    tools: toolCalls,
    eventLocations,
    requests,
    callSchemas,
    ...(partial ? { partial } : {}),
    runningCalls: toolCalls.filter((tool) => tool.status === "started"),
    warnings: toolProjection.warnings,
    summary: { totalEvents: ordered.length, llmCalls, toolCalls: toolCalls.length, browserActions, observations, evidence, failures, durationMs },
    replayable: true
  });
}

export function appendTrajectoryEvent(projection: TrajectoryViewModel | undefined, event: TrajectoryEvent) {
  return projectTrajectoryEvents([...(projection?.events ?? []), event]);
}

export function prependTrajectoryEvents(projection: TrajectoryViewModel | undefined, events: TrajectoryEvent | readonly TrajectoryEvent[]) {
  const incoming = Array.isArray(events) ? events : [events];
  return projectTrajectoryEvents([...incoming, ...(projection?.events ?? [])]);
}

/** Explicit aliases make the replay invariant easy to test and consume. */
export const replayTrajectory = projectTrajectoryEvents;
export const appendTrajectory = appendTrajectoryEvent;
export const prependTrajectory = prependTrajectoryEvents;
