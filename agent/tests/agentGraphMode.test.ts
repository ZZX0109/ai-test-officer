import assert from "node:assert/strict";
import {
  agentOrchestrationMode,
  requiresActiveBrowserDiscovery
} from "../src/agentGraphService.js";
import type { RunProjection } from "../src/runEventStore.js";

function runProjection(input: Record<string, unknown>, runKind: RunProjection["runKind"] = "parent"): RunProjection {
  return {
    id: "run_graph_smoke_policy",
    state: "planning",
    version: 1,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    input,
    runKind
  };
}

export function testAgentGraphMode() {
  const previousMode = process.env.AGENT_ORCHESTRATION_MODE;
  const previousAllowlist = process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
  try {
    process.env.AGENT_ORCHESTRATION_MODE = "active";
    process.env.AGENT_GRAPH_ACTIVE_PROJECTS = "andflow,psyexpgen";
    assert.equal(agentOrchestrationMode("andflow"), "active");
    assert.equal(agentOrchestrationMode("unknown-project"), "active");
    assert.equal(agentOrchestrationMode(), "active");
    delete process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
    assert.equal(agentOrchestrationMode("unknown-project"), "active");
    process.env.AGENT_ORCHESTRATION_MODE = "shadow";
    assert.equal(agentOrchestrationMode("andflow"), "shadow");

    assert.equal(requiresActiveBrowserDiscovery(runProjection({
      coverageMode: "full",
      capabilities: ["browser"],
      requirement: "全面扫描"
    })), true);
    assert.equal(requiresActiveBrowserDiscovery(runProjection({
      coverageMode: "full",
      capabilities: ["browser"]
    }), false), false, "a manifest without browser capability must not be page-gated");
    assert.equal(requiresActiveBrowserDiscovery(runProjection({
      coverageMode: "targeted",
      capabilities: ["browser"],
      requirement: "验证指定 API"
    })), false);
    assert.equal(requiresActiveBrowserDiscovery(runProjection({
      coverageMode: "full",
      capabilities: []
    })), false);
    assert.equal(requiresActiveBrowserDiscovery(runProjection({
      coverageMode: "full",
      capabilities: ["browser"]
    }, "path")), false, "child path runs must not repeat parent Discovery");
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE;
    else process.env.AGENT_ORCHESTRATION_MODE = previousMode;
    if (previousAllowlist === undefined) delete process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
    else process.env.AGENT_GRAPH_ACTIVE_PROJECTS = previousAllowlist;
  }
}
