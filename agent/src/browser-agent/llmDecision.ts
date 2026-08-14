import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  browserActionDecisionSchema,
  dynamicOracleSchema,
  knowledgeBoundaryOutputSchema,
  llmBudgetSchema,
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
  action: z.enum(["click-control", "fill-control", "select-control", "check-control", "press-key", "scroll-to-control", "wait-for-control", "navigate-route", "submit-form", "evaluate-oracle"]),
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

// Keep the provider-facing Oracle schema flat. SophNet's Responses-compatible
// endpoint is reliable with required nullable fields, but has intermittently
// rejected nested oneOf/discriminated-union schemas. Requiring every key here
// prevents a structurally incomplete Oracle from consuming the one permitted
// semantic-repair call; null placeholders are removed before the deterministic
// dynamicOracleSchema validates the selected Oracle type.
const oracleJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "type", "description", "controlId", "operator", "expected", "operationId", "expectedStatus"],
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: ["element-state", "text", "url", "count-change", "network", "dom-change", "input-state"] },
    description: { type: "string" },
    controlId: { type: ["string", "null"] },
    operator: { type: ["string", "null"], enum: ["equals", "contains", "not-contains", null] },
    // Text and URL Oracles accept a bounded literal, while the deterministic
    // union below restricts the other Oracle types to their allowed enums.
    expected: { type: ["string", "null"], maxLength: 500 },
    operationId: { type: ["string", "null"] },
    expectedStatus: { type: ["integer", "null"], minimum: 100, maximum: 599 }
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
    // Oracle objects are validated again by the deterministic discriminated
    // union after nullable provider placeholders are removed.
    oracles: { type: "array", maxItems: 6, items: oracleJsonSchema },
    evidenceRefs: { type: "array", maxItems: 20, items: { type: "string" } },
    userQuestion: { type: ["string", "null"], maxLength: 500 },
    knowledge: knowledgeBoundaryJsonSchemaV2
  }
} as const;

function removeNullFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeNullFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, field]) => field !== null)
    .map(([key, field]) => [key, removeNullFields(field)]));
}

/** The provider JSON schema requires nullable placeholders for optional
 * properties. Convert only those nulls back to omitted fields. Historical
 * aliases and misspelled Oracle types are intentionally not repaired here:
 * invalid model output gets the single semantic-repair attempt owned by the
 * knowledge-bounded LLM wrapper. */
function normalizeProviderOutput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    actions: removeNullFields(record.actions),
    oracles: removeNullFields(record.oracles)
  };
}

/** Validate every model-selected runtime binding inside the knowledge-boundary
 * wrapper. Throwing after the wrapper returned used to bypass its one bounded
 * semantic-repair attempt, so a one-character controlId typo immediately
 * blocked an otherwise healthy page path. */
export function parseBrowserDecisionProviderOutput(text: string, observation: BrowserObservation) {
  const parsed = outputSchema.parse(normalizeProviderOutput(JSON.parse(text)));
  const parsedOracles = parsed.oracles.map((oracle) => dynamicOracleSchema.parse(oracle));
  const oracleIds = new Set(parsedOracles.map((oracle) => oracle.id));
  const allowedControlIds = new Set(observation.controls.map((control) => control.controlId));
  for (const proposal of parsed.actions) {
    if (proposal.controlId && !allowedControlIds.has(proposal.controlId)) {
      throw new Error(`browser_llm_unknown_control:${proposal.controlId}`);
    }
    const unknownOracle = proposal.oracleIds.find((id) => !oracleIds.has(id));
    if (unknownOracle) throw new Error(`browser_llm_unknown_oracle:${unknownOracle}`);
  }
  const invalidEvidence = parsed.evidenceRefs.find((id) => !observation.evidenceRefs.includes(id));
  if (invalidEvidence) throw new Error(`browser_llm_invalid_evidence_ref:${invalidEvidence}`);
  return { ...parsed, oracles: parsedOracles };
}

export function compactBrowserObservationForDecision(observation: BrowserObservation) {
  const boundedText = (value: string | null | undefined, maximum: number) => value ? value.slice(0, maximum) : value;
  const controls = [...observation.controls]
    .sort((left, right) => Number(right.visible && !right.disabled && !right.obscured) - Number(left.visible && !left.disabled && !left.obscured))
    .slice(0, 80)
    .map((control) => ({
      controlId: control.controlId,
      kind: control.kind,
      role: control.role,
      name: boundedText(control.accessibleName, 180),
      label: boundedText(control.label, 180),
      inputType: control.inputType,
      visible: control.visible,
      disabled: control.disabled,
      obscured: control.obscured
    }));
  return {
    url: observation.finalUrl,
    title: boundedText(observation.title, 300),
    readyState: observation.readyState,
    bodyTextSample: boundedText(observation.bodyTextSample, 2_000),
    accessibilityTree: boundedText(observation.accessibilityTree, 4_000),
    controls,
    consoleErrors: observation.consoleErrors.slice(-12).map((value) => boundedText(value, 500)),
    pageErrors: observation.pageErrors.slice(-12).map((value) => boundedText(value, 500)),
    failedRequests: observation.failedRequests.slice(-20).map((request) => ({
      ...request,
      url: boundedText(request.url, 500),
      failure: boundedText(request.failure, 500)
    }))
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
  const unsupported: never = input.proposal.action;
  throw new Error(`browser_llm_action_not_supported:${unsupported}`);
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
  const page = compactBrowserObservationForDecision(input.observation);
  const prompt = JSON.stringify({
    task: "Choose the single next safe browser action required to test the supplied goal.",
    goal: input.goal,
    page,
    allowedRouteIds: input.allowedRouteIds,
    previousResults: input.previousResults.slice(-8),
    rules: [
      "Use only controlId values present in page.controls and routeId values in allowedRouteIds.",
      "Never output selectors, JavaScript, shell commands, SQL, arbitrary URLs, raw credentials, or literal secrets.",
      "Values must be opaque refs prefixed testData., credential., or fixture.; credential refs require user confirmation.",
      "Propose at most one action. The page will be observed again before you choose another action.",
      "The current page has already been observed by the system; choose a real bounded action, complete, blocked, or needs-confirmation.",
      "Every action that claims a result must bind at least one deterministic oracle.",
      "If the goal is complete return complete. If facts are insufficient return blocked or needs-confirmation.",
      "Knowledge toolRequests and proposedActions must be empty; browser actions belong only in actions."
    ],
    exactOutputShape: {
      status: "act | complete | blocked | needs-confirmation",
      summary: "short plain-language sentence",
      actions: [{
        action: "click-control | fill-control | select-control | check-control | press-key | scroll-to-control | wait-for-control | navigate-route | submit-form | evaluate-oracle",
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
      oracles: [{
        id: "oracle id",
        type: "allowed dynamic oracle type",
        description: "machine-checkable assertion",
        controlId: "supplied controlId or null",
        operator: "equals | contains | not-contains | null",
        expected: "the exact allowed expected value for this oracle type; null only for network",
        operationId: "registered operation id for network, otherwise null",
        expectedStatus: "HTTP status for network or null"
      }],
      evidenceRefs: "only supplied evidence ids",
      userQuestion: "string or null",
      knowledge: {
        schemaVersion: "2.0", factsUsed: [], inferences: [], assumptions: [], unknowns: [],
        toolRequests: [], blockingQuestions: [], proposedActions: []
      }
    },
    forbiddenFields: ["selector", "xpath", "javascript", "command", "url"],
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
    context: {
      purpose: "browser-action",
      runId: input.observation.runId,
      budgetScopeId: input.coverageItemId
    },
    // Browser decisions are budgeted per CoverageItem. The parent Run still
    // aggregates actual usage for observability, but a planning/login call can
    // no longer exhaust every later business path before it is attempted.
    budget: llmBudgetSchema.parse({
      maxBrowserActionCalls: 6,
      // This is an independent per-CoverageItem allowance, not the parent
      // run's aggregate usage. A normal page path needs several
      // observe/decide cycles; 12k allowed one complete Codex decision but
      // rejected the second during conservative preflight reservation.
      maxTotalTokens: 30_000,
      totalTimeoutMs: 120_000
    }),
    knowledgeContext: context,
    maxToolRounds: 0,
    parseOutput: (text) => parseBrowserDecisionProviderOutput(text, input.observation)
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
