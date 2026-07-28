import assert from "node:assert/strict";
import { agentOrchestrationMode } from "../src/agentGraphService.js";

export function testAgentGraphMode() {
  const previousMode = process.env.AGENT_ORCHESTRATION_MODE;
  const previousAllowlist = process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
  try {
    process.env.AGENT_ORCHESTRATION_MODE = "active";
    process.env.AGENT_GRAPH_ACTIVE_PROJECTS = "andflow,psyexpgen";
    assert.equal(agentOrchestrationMode("andflow"), "active");
    assert.equal(agentOrchestrationMode("unknown-project"), "shadow");
    assert.equal(agentOrchestrationMode(), "shadow");
    delete process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
    assert.equal(agentOrchestrationMode("unknown-project"), "active");
    process.env.AGENT_ORCHESTRATION_MODE = "shadow";
    assert.equal(agentOrchestrationMode("andflow"), "shadow");
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_ORCHESTRATION_MODE;
    else process.env.AGENT_ORCHESTRATION_MODE = previousMode;
    if (previousAllowlist === undefined) delete process.env.AGENT_GRAPH_ACTIVE_PROJECTS;
    else process.env.AGENT_GRAPH_ACTIVE_PROJECTS = previousAllowlist;
  }
}
