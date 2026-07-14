import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testBenchmarkContract() {
  const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ projectId: string; category: string }>;
  assert.equal(cases.length, 18);
  assert.deepEqual(new Set(cases.map((item) => item.projectId)), new Set(["todo_lite", "order_portal_lite"]));
  assert.equal(cases.filter((item) => item.projectId === "todo_lite").length, 9);
  assert.equal(cases.filter((item) => item.projectId === "order_portal_lite").length, 9);
  assert.ok(new Set(cases.map((item) => item.category)).size >= 6);
  const todo = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "todo_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  const order = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "order_portal_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  assert.equal(todo.testCommand, "npm test");
  assert.equal(order.testCommand, "npm test");
  assert.ok(todo.allowedOrigins?.length);
  assert.ok(order.allowedOrigins?.length);
  const executionMap = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<Record<string, string>> };
  assert.deepEqual(executionMap.mappings.map(({ logicalProjectId, executionProjectId, targetKind }) => ({ logicalProjectId, executionProjectId, targetKind })), [
    { logicalProjectId: "todo_lite", executionProjectId: "local_demo_app", targetKind: "app-under-test" },
    { logicalProjectId: "order_portal_lite", executionProjectId: "customer_portal_lite", targetKind: "independent-fixture" }
  ]);
  const challengeCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "challenge-cases.json"), "utf8")) as Array<{ projectId: string; evaluationScope: string }>;
  assert.equal(challengeCases.length, 1);
  assert.equal(challengeCases[0].projectId, "investment_agent_workflow_external");
  assert.equal(challengeCases[0].evaluationScope, "challenge_only");
}
