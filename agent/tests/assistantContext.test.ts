import assert from "node:assert/strict";
import test from "node:test";
import {
  compactAssistantContext,
  compactAssistantGraphProjection,
  compactKnowledgeStatement,
  humanizeAssistantCoverageRefs,
  normalizeAssistantOutputShape,
  stripAssistantInlineClaimIds
} from "../src/assistantContext.js";

test("knowledge statements remain valid when runtime errors are very large", () => {
  const compacted = compactKnowledgeStatement({
    error: "page.screenshot timeout",
    callLog: "x".repeat(5_000)
  });
  assert.ok(compacted.length <= 2_000);
  assert.match(compacted, /内容已截断/);
});

test("assistant context compacts whitespace and obeys endpoint-specific limits", () => {
  assert.equal(compactAssistantContext("  first\n\n second  ", 100), "first second");
  assert.ok(compactAssistantContext("x".repeat(2_000), 700).length <= 700);
});

test("assistant reply removes internal inline claim IDs", () => {
  assert.equal(
    stripAssistantInlineClaimIds("阻塞来自三条未绑定路径。[saved-run-result]\n请补充验证条件。[machine-gate]"),
    "阻塞来自三条未绑定路径。\n请补充验证条件。"
  );
});

test("assistant reply translates a raw coverage reference without discarding the surrounding answer", () => {
  const result = humanizeAssistantCoverageRefs("遇到的问题：coverage_blocked:business_path_runtime_task_filter。系统没有将它计为通过。");
  assert.match(result, /遇到的问题：1 条路径缺少可执行入口、操作条件或验证条件/);
  assert.match(result, /系统没有将它计为通过/);
  assert.doesNotMatch(result, /coverage_blocked|business_path_runtime/);
});

test("assistant graph context excludes duplicate browser payloads", () => {
  const compacted = compactAssistantGraphProjection({
    schemaVersion: "1.0",
    runId: "run-1",
    status: "completed",
    currentNode: "finalize",
    completedNodes: Array.from({ length: 20 }, (_, index) => `node-${index}`),
    progress: 1,
    tokenUsage: 8_134,
    remainingPathCount: 3,
    updatedAt: "2026-08-27T06:00:00.000Z",
    // These fields exist on the full projection but deliberately are not part
    // of the compact assistant type/output.
    observation: { bodyText: "x".repeat(20_000) },
    browserObservation: { accessibilityTree: "y".repeat(20_000) }
  } as Parameters<typeof compactAssistantGraphProjection>[0] & Record<string, unknown>);
  const serialized = JSON.stringify(compacted);
  assert.ok(serialized.length < 2_000);
  assert.doesNotMatch(serialized, /bodyText|accessibilityTree/);
  assert.deepEqual(compacted?.completedNodes, Array.from({ length: 12 }, (_, index) => `node-${index + 8}`));
});

test("assistant reasoning aliases normalize without changing actions or knowledge", () => {
  const normalized = normalizeAssistantOutputShape({
    reply: "当前截图步骤超时。",
    intent: "failure-question",
    suggestedAction: "open-evidence",
    requiresConfirmation: false,
    reasoningSummary: {
      summary: "页面没有在时限内完成截图。",
      evidence: ["capture-screenshot timeout"]
    },
    knowledge: { factsUsed: ["run-state"] }
  }) as {
    reasoningSummary: { phase: string; observations: string[]; assessment: string; userAction: string };
    suggestedAction: string;
    knowledge: { factsUsed: string[] };
  };
  assert.equal(normalized.reasoningSummary.phase, "diagnosing");
  assert.deepEqual(normalized.reasoningSummary.observations, ["capture-screenshot timeout"]);
  assert.equal(normalized.reasoningSummary.assessment, "页面没有在时限内完成截图。");
  assert.equal(normalized.reasoningSummary.userAction, "无需操作。");
  assert.equal(normalized.suggestedAction, "open-evidence");
  assert.deepEqual(normalized.knowledge.factsUsed, ["run-state"]);
});
