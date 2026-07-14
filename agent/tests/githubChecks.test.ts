import assert from "node:assert/strict";
import { forkExecutionPolicy, githubCheckIdempotencyKey, githubConclusionForGate } from "../src/githubChecks.js";

export function testGithubChecks() {
  assert.equal(githubConclusionForGate({ gateStatus: "pass", exitCode: 0 }), "success");
  assert.equal(githubConclusionForGate({ gateStatus: "blocked", exitCode: 3 }), "action_required");
  assert.equal(githubConclusionForGate({ gateStatus: "needs-human-review", exitCode: 2 }), "neutral");
  assert.equal(forkExecutionPolicy({ isFork: true, approved: false }).allowed, false);
  assert.equal(githubCheckIdempotencyKey({ commitSha: "abc", manifestHash: "def", agentVersion: "1" }), githubCheckIdempotencyKey({ commitSha: "abc", manifestHash: "def", agentVersion: "1" }));
}
