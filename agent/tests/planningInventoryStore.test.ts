import assert from "node:assert/strict";
import { getPlanningFlowPage, savePlanningInventory } from "../src/planningInventoryStore.js";
import type { PlannedBusinessFlow } from "../src/planningConversation.js";

function flow(index: number): PlannedBusinessFlow {
  return {
    id: `flow_${index}`,
    title: `业务流程 ${index}`,
    kind: "page",
    target: `src/pages/${index}.tsx`,
    status: "auto-bindable",
    confidence: "high",
    reason: "test",
    requiredInformation: []
  };
}

export async function testPlanningInventoryStore() {
  const id = `planning_page_${Date.now()}`;
  await savePlanningInventory({
    id,
    projectId: "project_page",
    flows: Array.from({ length: 53 }, (_, index) => flow(index)),
    createdAt: new Date().toISOString()
  });
  const first = await getPlanningFlowPage({ inventoryId: id, projectId: "project_page", limit: 24 });
  assert.ok(first);
  assert.equal(first.flows.length, 24);
  assert.equal(first.page.total, 53);
  assert.ok(first.page.nextCursor);
  const second = await getPlanningFlowPage({ inventoryId: id, projectId: "project_page", cursor: first.page.nextCursor, limit: 24 });
  assert.ok(second);
  assert.equal(second.flows[0]?.id, "flow_24");
  const last = await getPlanningFlowPage({ inventoryId: id, projectId: "project_page", cursor: second.page.nextCursor, limit: 24 });
  assert.ok(last);
  assert.equal(last.flows.length, 5);
  assert.equal(last.page.nextCursor, undefined);
  assert.equal(await getPlanningFlowPage({ inventoryId: id, projectId: "other_project" }), undefined);
}
