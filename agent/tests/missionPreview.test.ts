import assert from "node:assert/strict";
import { createMissionPreview } from "../src/missionPreview.js";

export function testMissionPreview() {
  const preview = createMissionPreview({
    project: { name: "Checkout QA" },
    targetApp: { name: "Store", defaultMode: "plan-assisted" },
    baseUrl: "https://store.example.test",
    keyPages: ["/checkout"],
    businessObjective: "Verify checkout",
    selectorHints: ["data-testid=submit"],
    scenarioRequests: [{ family: "checkout", pagePath: "/checkout" }]
  });
  assert.deepEqual(preview.counts, { pages: 1, selectorHints: 1, scenarios: 1, oracles: 1 });
  assert.equal(preview.scenarios[0]?.pagePath, "/checkout");
  assert.deepEqual(preview.oracles[0]?.requiredEvidence, ["screenshot", "dom", "trace"]);
}
