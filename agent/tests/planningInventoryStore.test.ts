import assert from "node:assert/strict";
import { getPlanningFlowPage, getPlanningFunctionPage, savePlanningInventory } from "../src/planningInventoryStore.js";
import type { PlannedBusinessFlow } from "../src/planningConversation.js";
import type { BusinessFunction } from "../src/businessFunctionCompiler.js";

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

function businessFunction(index: number): BusinessFunction {
  return {
    id: `business_function_${index}`,
    name: `业务功能 ${index}`,
    purpose: "验证用户业务流程",
    roles: ["用户"],
    risk: "low",
    status: "ready",
    confidence: "high",
    pathIds: [`flow_${index}`],
    sourceLocations: [{ file: `src/${index}.tsx`, line: 1, parser: "test", sourceHash: `hash_${index}` }],
    evidenceRefs: [],
    technicalPathCount: 0,
    branchCount: 1,
    summary: "test"
  };
}

export async function testPlanningInventoryStore() {
  const id = `planning_page_${Date.now()}`;
  await savePlanningInventory({
    id,
    projectId: "project_page",
    flows: Array.from({ length: 53 }, (_, index) => flow(index)),
    functions: Array.from({ length: 31 }, (_, index) => businessFunction(index)),
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
  const functions = await getPlanningFunctionPage({ inventoryId: id, projectId: "project_page", limit: 12 });
  assert.ok(functions);
  assert.equal(functions.functions.length, 12);
  assert.equal(functions.page.total, 31);
  assert.ok(functions.page.nextCursor);
  assert.equal(await getPlanningFunctionPage({ inventoryId: id, projectId: "other_project" }), undefined);
}
