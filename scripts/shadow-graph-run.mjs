import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { agentPermissionProfileSchema } from "@ai-test-officer/contracts";
import { createAgentOrchestrationGraph } from "../packages/agent-orchestration/dist/index.js";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const reportDir = path.join(rootDir, "reports", "shadow-graph");
const requestedCount = Number.parseInt(process.env.SHADOW_RUN_COUNT ?? "100", 10);
const count = Number.isFinite(requestedCount) ? Math.max(1, Math.min(requestedCount, 10_000)) : 100;

const expectedCommon = [
  "intake",
  "discover",
  "build-coverage-map",
  "plan",
  "compile",
  "approve-plan",
  "prepare-sandbox",
  "approve-capabilities"
];

function hooksFor(browserPath) {
  return {
    intake: async () => ({ observation: { stage: "intake", status: "ready" } }),
    discover: async () => ({
      coverageMap: {
        status: "ready",
        items: [{ id: "shadow-item", surface: browserPath ? "page" : "api" }],
        discovery: { status: "ready", reason: "synthetic_shadow_fixture" }
      }
    }),
    plan: async () => ({ planData: { provenance: { source: "deterministic", confidence: "high" } } }),
    compile: async () => ({ compiledPlan: {}, browserAgentRequired: browserPath }),
    prepareSandbox: async () => ({ observation: { stage: "sandbox", status: "ready" } }),
    observeBrowser: async () => ({ browserObservation: { status: "ready" } }),
    decideBrowserAction: async () => ({ browserDecision: { status: "complete" } }),
    decideNextStep: async () => ({ browserLoopComplete: true, remainingPathCount: 0, compiledPlan: {} }),
    collectAndGate: async () => ({
      gate: { machineGate: { status: "pass", proofIdentity: { status: "verified" } } },
      failure: {}
    }),
    finalize: async () => ({ status: "completed" })
  };
}

async function runOne(index) {
  const browserPath = index % 2 === 0;
  const runId = `shadow_graph_${String(index + 1).padStart(4, "0")}`;
  const service = createAgentOrchestrationGraph({
    checkpointer: new MemorySaver(),
    hooks: hooksFor(browserPath)
  });
  await service.start({
    runId,
    mode: "shadow",
    requirement: browserPath ? "browser path" : "service path",
    projectId: `synthetic-project-${index % 5}`,
    permissionProfile: agentPermissionProfileSchema.parse({
      observe: true,
      browserControl: browserPath,
      targetNetwork: !browserPath
    })
  });
  const state = await service.state(runId);
  assert.equal(state?.status, "completed", `${runId}: graph did not complete`);
  assert.equal(state?.progress, 1, `${runId}: graph did not reach 100%`);
  assert.equal(state?.pendingInterrupt, undefined, `${runId}: shadow graph interrupted`);
  const completed = state?.completedNodes ?? [];
  for (const node of expectedCommon) assert.ok(completed.includes(node), `${runId}: missing ${node}`);
  if (browserPath) {
    for (const node of ["observe-browser", "decide-browser-action", "decide-next-step"]) {
      assert.ok(completed.includes(node), `${runId}: missing browser node ${node}`);
    }
  } else {
    assert.ok(completed.includes("execute"), `${runId}: missing non-browser execute node`);
  }
  for (const node of ["collect-and-gate", "triage-failure", "finalize"]) {
    assert.ok(completed.includes(node), `${runId}: missing terminal node ${node}`);
  }
  return { runId, path: browserPath ? "browser" : "non-browser", completedNodes: completed.length };
}

const results = [];
for (let index = 0; index < count; index += 1) results.push(await runOne(index));

const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  runCount: count,
  passed: results.length,
  provenance: "synthetic-shadow-topology",
  limitation: "验证编排拓扑、Typed Subgraph 覆盖和 shadow 模式可重复完成；不代表真实项目行为正确，也不证明 LLM 泛化收益。",
  results
};
await fs.mkdir(reportDir, { recursive: true });
await fs.writeFile(path.join(reportDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ runCount: report.runCount, passed: report.passed, report: path.relative(rootDir, path.join(reportDir, "latest.json")) }, null, 2));
