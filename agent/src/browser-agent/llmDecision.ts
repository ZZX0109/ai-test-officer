import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  browserActionDecisionSchema,
  dynamicOracleSchema,
  knowledgeBoundaryOutputSchema,
  type BrowserActionDecision,
  type BrowserAgentAction,
  type BrowserObservation
} from "@ai-test-officer/contracts";
import { decrypt, getCredential } from "../credentialStore.js";
import {
  createKnowledgeContext,
  knowledgeBoundaryJsonSchemaV2,
  knowledgeBoundarySystemPolicy
} from "../knowledgeBoundary.js";
import { executeKnowledgeBoundedLlm } from "../knowledge-boundary/executeKnowledgeBoundedLlm.js";

const proposedActionSchema = z.object({
  action: z.enum(["click-control", "fill-control", "select-control", "check-control", "press-key", "scroll-to-control", "wait-for-control", "navigate-route", "submit-form", "observe-page", "evaluate-oracle"]),
  controlId: z.string().min(1).optional(),
  valueRef: z.string().min(1).optional(),
  checked: z.boolean().optional(),
  key: z.enum(["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"]).optional(),
  state: z.enum(["visible", "hidden", "enabled", "disabled"]).optional(),
  routeId: z.string().min(1).optional(),
  purpose: z.string().min(1).max(500),
  expectedChange: z.string().min(1).max(500),
  oracleIds: z.array(z.string().min(1)).max(6),
  risk: z.enum(["low", "medium", "high", "forbidden"]),
  timeoutMs: z.number().int().min(250).max(45_000).optional()
}).strict();

const outputSchema = z.object({
  status: z.enum(["act", "complete", "blocked", "needs-confirmation"]),
  summary: z.string().min(1).max(800),
  // The graph re-observes the page after every operation. Accept exactly one
  // executable action per decision so a page-changing first action cannot
  // silently invalidate or discard later model proposals.
  actions: z.array(proposedActionSchema).max(1),
  oracles: z.array(z.unknown()).max(6),
  evidenceRefs: z.array(z.string().min(1)).max(20),
  userQuestion: z.string().max(500).nullable(),
  knowledge: knowledgeBoundaryOutputSchema
}).strict();

const actionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "controlId", "valueRef", "checked", "key", "state", "routeId", "purpose", "expectedChange", "oracleIds", "risk", "timeoutMs"],
  properties: {
    action: { type: "string", enum: proposedActionSchema.shape.action.options },
    controlId: { type: ["string", "null"] }, valueRef: { type: ["string", "null"] }, checked: { type: ["boolean", "null"] },
    key: { type: ["string", "null"], enum: ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space", null] },
    state: { type: ["string", "null"], enum: ["visible", "hidden", "enabled", "disabled", null] },
    routeId: { type: ["string", "null"] }, purpose: { type: "string" }, expectedChange: { type: "string" },
    oracleIds: { type: "array", maxItems: 6, items: { type: "string" } },
    risk: { type: "string", enum: ["low", "medium", "high", "forbidden"] }, timeoutMs: { type: ["integer", "null"] }
  }
} as const;

const outputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "actions", "oracles", "evidenceRefs", "userQuestion", "knowledge"],
  properties: {
    status: { type: "string", enum: ["act", "complete", "blocked", "needs-confirmation"] },
    summary: { type: "string", maxLength: 800 },
    actions: { type: "array", maxItems: 1, items: actionJsonSchema },
    // Oracle objects are validated again by the deterministic contract. The
    // compatible provider receives a permissive JSON container here because
    // it does not consistently accept a deeply nested oneOf schema.
    oracles: { type: "array", maxItems: 6, items: { type: "object" } },
    evidenceRefs: { type: "array", maxItems: 20, items: { type: "string" } },
    userQuestion: { type: ["string", "null"], maxLength: 500 },
    knowledge: knowledgeBoundaryJsonSchemaV2
  }
} as const;

function normalizeNullableFields(value: unknown, fallbackEvidenceRefs: string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const fallbackKnowledge = {
    schemaVersion: "2.0",
    factsUsed: [],
    inferences: [],
    assumptions: [],
    unknowns: [],
    toolRequests: [],
    blockingQuestions: [],
    proposedActions: []
  };
  const normalizedOracles = Array.isArray(record.oracles)
    ? record.oracles.map((oracle) => {
      if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) return oracle;
      const raw = oracle as Record<string, unknown>;
      const type = String(raw.type ?? "").toLowerCase().replace(/[_\s]+/g, "-");
      // Accept only spelling variants of a known deterministic Oracle.  This
      // does not invent an assertion or grant the model a new evaluator.
      if (["input-value", "input-filled", "value", "value-state"].includes(type) && typeof raw.controlId === "string") {
        return {
          ...raw,
          type: "input-state",
          expected: raw.expected === "empty" ? "empty" : "nonempty",
          description: typeof raw.description === "string" ? raw.description : "Input value state is verified without retaining its contents."
        };
      }
      if (["element-visible", "element-exists", "visibility"].includes(type) && typeof raw.controlId === "string") {
        return {
          ...raw,
          type: "element-state",
          expected: ["visible", "hidden", "enabled", "disabled"].includes(String(raw.expected)) ? raw.expected : "visible",
          description: typeof raw.description === "string" ? raw.description : "Observed control state is verified."
        };
      }
      if (type === "text-contains") return { ...raw, type: "text", operator: "contains" };
      if (type === "url-contains") return { ...raw, type: "url", operator: "contains" };
      if (["dom-changed", "page-change"].includes(type)) return { ...raw, type: "dom-change", expected: "changed" };
      if (type === "dom-change") {
        return {
          ...raw,
          expected: raw.expected === "unchanged" ? "unchanged" : "changed",
          description: typeof raw.description === "string" ? raw.description : "Page DOM change is verified after the bounded action."
        };
      }
      if (type === "input-state" && typeof raw.controlId === "string") {
        return {
          ...raw,
          expected: raw.expected === "empty" ? "empty" : "nonempty",
          description: typeof raw.description === "string" ? raw.description : "Input value state is verified without retaining its contents."
        };
      }
      if (type === "element-state" && typeof raw.controlId === "string") {
        return {
          ...raw,
          expected: ["visible", "hidden", "enabled", "disabled"].includes(String(raw.expected)) ? raw.expected : "visible",
          description: typeof raw.description === "string" ? raw.description : "Observed control state is verified."
        };
      }
      return raw;
    })
    : [];
  return {
    ...record,
    actions: Array.isArray(record.actions) ? record.actions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const action = item as Record<string, unknown>;
      // Earlier browser prompts used `boundOracles` and omitted the metadata
      // now required by the executable Action DSL.  This compatibility layer
      // never broadens a model capability: it merely converts safe legacy
      // shape into an action which is re-authorized and re-bound below.
      const legacyOracleIds = Array.isArray(action.boundOracles)
        ? action.boundOracles.flatMap((oracle) => typeof oracle === "string"
          ? [oracle]
          : oracle && typeof oracle === "object" && typeof (oracle as { id?: unknown }).id === "string"
            ? [(oracle as { id: string }).id]
            : [])
        : [];
      const inferredRisk = action.action === "fill-control" && typeof action.valueRef === "string" && action.valueRef.startsWith("credential.")
        ? "medium"
        : "low";
      return {
        ...Object.fromEntries(Object.entries(action).filter(([key, field]) => key !== "boundOracles" && field !== null)),
        expectedChange: typeof action.expectedChange === "string" && action.expectedChange.trim()
          ? action.expectedChange
          : "Verify the declared page state after this bounded action.",
        oracleIds: Array.isArray(action.oracleIds)
          ? action.oracleIds.filter((id): id is string => typeof id === "string")
          : legacyOracleIds,
        risk: ["low", "medium", "high", "forbidden"].includes(String(action.risk)) ? action.risk : inferredRisk
      };
    }) : record.actions
    ,
    oracles: normalizedOracles,
    evidenceRefs: Array.isArray(record.evidenceRefs)
      ? record.evidenceRefs.filter((id): id is string => typeof id === "string")
      : fallbackEvidenceRefs,
    userQuestion: typeof record.userQuestion === "string" ? record.userQuestion : null,
    knowledge: record.knowledge && typeof record.knowledge === "object" ? record.knowledge : fallbackKnowledge
  };
}

function toExecutableAction(input: {
  proposal: z.infer<typeof proposedActionSchema>;
  observation: BrowserObservation;
  coverageItemId: string;
  index: number;
}): BrowserAgentAction {
  const base = {
    actionId: `browser_action_${randomUUID()}`,
    runId: input.observation.runId,
    attemptId: input.observation.attemptId,
    coverageItemId: input.coverageItemId,
    sourceObservationId: input.observation.observationId,
    sourcePageFingerprint: input.observation.pageFingerprint,
    purpose: input.proposal.purpose,
    expectedChange: input.proposal.expectedChange,
    oracleIds: input.proposal.oracleIds,
    risk: input.proposal.risk,
    timeoutMs: input.proposal.timeoutMs ?? 10_000
  };
  const controlId = input.proposal.controlId;
  const knownControl = !controlId || input.observation.controls.some((control) => control.controlId === controlId);
  if (!knownControl) throw new Error(`browser_llm_unknown_control:${controlId}`);
  if (input.proposal.action === "click-control" || input.proposal.action === "scroll-to-control" || input.proposal.action === "submit-form") {
    if (!controlId) throw new Error("browser_llm_control_required");
    return { ...base, action: input.proposal.action, controlId };
  }
  if (input.proposal.action === "fill-control" || input.proposal.action === "select-control") {
    if (!controlId || !input.proposal.valueRef || !/^(?:testData|credential|fixture)\.[a-zA-Z0-9_.:-]+$/.test(input.proposal.valueRef)) throw new Error("browser_llm_value_ref_invalid");
    return { ...base, action: input.proposal.action, controlId, valueRef: input.proposal.valueRef };
  }
  if (input.proposal.action === "check-control") {
    if (!controlId || input.proposal.checked === undefined) throw new Error("browser_llm_check_binding_invalid");
    return { ...base, action: input.proposal.action, controlId, checked: input.proposal.checked };
  }
  if (input.proposal.action === "press-key") {
    if (!input.proposal.key) throw new Error("browser_llm_key_required");
    return { ...base, action: input.proposal.action, ...(controlId ? { controlId } : {}), key: input.proposal.key };
  }
  if (input.proposal.action === "wait-for-control") {
    if (!controlId || !input.proposal.state) throw new Error("browser_llm_wait_binding_invalid");
    return { ...base, action: input.proposal.action, controlId, state: input.proposal.state };
  }
  if (input.proposal.action === "navigate-route") {
    if (!input.proposal.routeId) throw new Error("browser_llm_route_required");
    return { ...base, action: input.proposal.action, routeId: input.proposal.routeId };
  }
  if (input.proposal.action === "evaluate-oracle") return { ...base, action: input.proposal.action, oracleIds: input.proposal.oracleIds };
  // Observation is performed by the graph before every decision and after
  // every browser mutation.  Letting the model choose it creates a costly
  // no-op loop that never advances the test.
  if (input.proposal.action === "observe-page") throw new Error("browser_llm_redundant_observe_action");
  return { ...base, action: "observe-page" };
}

export async function decideNextBrowserActions(input: {
  observation: BrowserObservation;
  coverageItemId: string;
  goal: string;
  credentialId?: string;
  allowedRouteIds: string[];
  previousResults: Array<{ action: string; status: string; summary: string }>;
}): Promise<BrowserActionDecision> {
  if (!input.credentialId) return browserActionDecisionSchema.parse({
    schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
    runId: input.observation.runId, attemptId: input.observation.attemptId, observationId: input.observation.observationId,
    status: "blocked", summary: "没有可用的模型凭据，未知页面不能安全生成动态动作。", actions: [], oracles: [],
    evidenceRefs: input.observation.evidenceRefs, userQuestion: "请配置活动模型后重试。", createdAt: new Date().toISOString()
  });
  const credential = await getCredential(input.credentialId);
  if (!credential) throw new Error("browser_llm_credential_missing");
  const context = createKnowledgeContext({
    purpose: "browser-action",
    runId: input.observation.runId,
    projectSnapshot: undefined,
    claims: [{
      id: `page-observation-${input.observation.observationId}`,
      subject: "current-browser-page",
      statement: `The current browser page is ${input.observation.finalUrl} with ${input.observation.controls.length} observed controls.`,
      status: "observed",
      domain: "runtime",
      sourceRefs: input.observation.evidenceRefs.length
        ? input.observation.evidenceRefs.map((id) => `evidence:${id}`)
        : [`run-event:${input.observation.runId}`],
      scope: { runId: input.observation.runId, attemptId: input.observation.attemptId },
      confidence: 1
    }],
    allowedCapabilities: ["browserControl"],
    allowedTools: ["read-page-observation", "read-run-evidence"],
    unknowns: [],
    untrustedInputKinds: ["dom", "console", "network", "requirement", "prior-model-output"]
  });
  const controls = input.observation.controls.map((control) => ({
    controlId: control.controlId, kind: control.kind, role: control.role, name: control.accessibleName,
    label: control.label, inputType: control.inputType, visible: control.visible, disabled: control.disabled, obscured: control.obscured
  }));
  const prompt = JSON.stringify({
    task: "Choose the single next safe browser action required to test the supplied goal.",
    goal: input.goal,
    page: {
      url: input.observation.finalUrl, title: input.observation.title, readyState: input.observation.readyState,
      bodyTextSample: input.observation.bodyTextSample, accessibilityTree: input.observation.accessibilityTree,
      controls, consoleErrors: input.observation.consoleErrors, pageErrors: input.observation.pageErrors,
      failedRequests: input.observation.failedRequests
    },
    allowedRouteIds: input.allowedRouteIds,
    previousResults: input.previousResults.slice(-8),
    rules: [
      "Use only controlId values present in page.controls and routeId values in allowedRouteIds.",
      "Never output selectors, JavaScript, shell commands, SQL, arbitrary URLs, raw credentials, or literal secrets.",
      "Values must be opaque refs prefixed testData., credential., or fixture.; credential refs require user confirmation.",
      "Propose at most one action. The page will be observed again before you choose another action.",
      "The current page has already been observed by the system. Never propose observe-page; choose a real bounded action, complete, blocked, or needs-confirmation.",
      "Every action that claims a result must bind at least one deterministic oracle.",
      "If the goal is complete return complete. If facts are insufficient return blocked or needs-confirmation.",
      "Knowledge toolRequests and proposedActions must be empty; browser actions belong only in actions."
    ],
    exactOutputShape: {
      status: "act | complete | blocked | needs-confirmation",
      summary: "short plain-language sentence",
      actions: [{
        action: "click-control | fill-control | select-control | check-control | press-key | scroll-to-control | wait-for-control | navigate-route | submit-form | observe-page | evaluate-oracle",
        controlId: "a supplied controlId or null",
        valueRef: "testData.* | credential.* | fixture.* | null",
        checked: "boolean or null",
        key: "Enter | Tab | Escape | ArrowUp | ArrowDown | Space | null",
        state: "visible | hidden | enabled | disabled | null",
        routeId: "a supplied route id or null",
        purpose: "why this bounded action is needed",
        expectedChange: "the observable page change expected after the action",
        oracleIds: ["ids from oracles"],
        risk: "low | medium | high | forbidden",
        timeoutMs: "integer or null"
      }],
      oracles: [{ id: "oracle id", type: "allowed dynamic oracle type", description: "machine-checkable assertion" }],
      evidenceRefs: "only supplied evidence ids",
      userQuestion: "string or null",
      knowledge: {
        schemaVersion: "2.0", factsUsed: [], inferences: [], assumptions: [], unknowns: [],
        toolRequests: [], blockingQuestions: [], proposedActions: []
      }
    },
    forbiddenLegacyFields: ["boundOracles", "selector", "xpath", "javascript", "command", "url"],
    allowedOracleTypes: {
      "element-state": { controlId: "supplied controlId", expected: "visible | hidden | enabled | disabled" },
      text: { controlId: "optional supplied controlId", operator: "equals | contains | not-contains", expected: "text" },
      url: { operator: "equals | contains | not-contains", expected: "registered route or current URL fragment" },
      "count-change": { controlId: "optional", expected: "increased | decreased | unchanged" },
      network: { operationId: "registered operation id", expectedStatus: "optional HTTP status" },
      "dom-change": { expected: "changed | unchanged" },
      "input-state": { controlId: "supplied input controlId", expected: "empty | nonempty", note: "never request or return the actual value" }
    },
    knowledgeContext: context
  });
  const result = await executeKnowledgeBoundedLlm({
    credential,
    apiKey: await decrypt(credential.apiKeyEncrypted),
    system: `You are a browser-test action planner. You propose bounded semantic actions; a deterministic broker authorizes and executes them. Return JSON only. ${knowledgeBoundarySystemPolicy}`,
    prompt,
    // Codex Responses counts internal reasoning against max_output_tokens.
    // 1,200 tokens repeatedly ended with `max_output_tokens` before the small
    // JSON decision was emitted.  Keep the action contract bounded to one
    // action, but leave enough output budget for a complete structured result.
    maxTokens: 2_400,
    timeoutMs: 25_000,
    totalTimeoutMs: 35_000,
    transportPreference: "non-stream-retry",
    jsonSchema: { name: "browser_action_decision", schema: outputJsonSchema },
    context: { purpose: "browser-action", runId: input.observation.runId },
    knowledgeContext: context,
    maxToolRounds: 0,
    parseOutput: (text) => outputSchema.parse(normalizeNullableFields(JSON.parse(text), input.observation.evidenceRefs))
  });
  const parsedOracles = result.value.oracles.map((oracle) => dynamicOracleSchema.parse(oracle));
  const oracleIds = new Set(parsedOracles.map((oracle) => oracle.id));
  const actions = result.value.actions.map((proposal, index) => toExecutableAction({ proposal, observation: input.observation, coverageItemId: input.coverageItemId, index }));
  if (actions.some((action) => action.oracleIds.some((id) => !oracleIds.has(id)))) throw new Error("browser_llm_unknown_oracle");
  if (result.value.evidenceRefs.some((id) => !input.observation.evidenceRefs.includes(id))) throw new Error("browser_llm_invalid_evidence_ref");
  return browserActionDecisionSchema.parse({
    schemaVersion: "1.0", decisionId: `browser_decision_${randomUUID()}`,
    runId: input.observation.runId, attemptId: input.observation.attemptId, observationId: input.observation.observationId,
    status: result.value.status, summary: result.value.summary,
    actions, oracles: parsedOracles, evidenceRefs: result.value.evidenceRefs,
    userQuestion: result.value.userQuestion ?? undefined, createdAt: new Date().toISOString()
  });
}
