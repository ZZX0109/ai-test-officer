import assert from "node:assert/strict";
import test from "node:test";
import {
  compactAssistantContext,
  compactKnowledgeStatement,
  normalizeAssistantOutputShape
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
