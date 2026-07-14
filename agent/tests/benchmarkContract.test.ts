import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testBenchmarkContract() {
  const cases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "cases.json"), "utf8")) as Array<{ id: string; projectId: string; category: string; scenarioId: string; expectedVerdict?: string }>;
  assert.equal(cases.length, 18);
  assert.deepEqual(new Set(cases.map((item) => item.projectId)), new Set(["todo_lite", "order_portal_lite"]));
  assert.equal(cases.filter((item) => item.projectId === "todo_lite").length, 9);
  assert.equal(cases.filter((item) => item.projectId === "order_portal_lite").length, 9);
  assert.ok(new Set(cases.map((item) => item.category)).size >= 6);
  assert.ok(cases.every((item) => item.scenarioId));
  assert.ok(cases.every((item) => item.expectedVerdict === undefined));
  const blindCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "blind-cases.json"), "utf8")) as Array<{ id: string; expectedVerdict?: string; faultProfile: string }>;
  assert.equal(blindCases.length, 6);
  assert.ok(blindCases.every((item) => !item.expectedVerdict && item.faultProfile));
  const extendedCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "extended-cases.json"), "utf8")) as Array<{ id: string; projectId: string; scenarioId: string }>;
  assert.equal(extendedCases.length, 6);
  assert.equal(new Set(extendedCases.map((item) => item.projectId)).size, 1);
  assert.equal(extendedCases.every((item) => item.projectId === "customer_portal_lite" && item.scenarioId.startsWith("generic_")), true);
  const developmentLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "development.json"), "utf8")) as Array<{ benchmarkId: string }>;
  const blindLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "blind.json"), "utf8")) as Array<{ benchmarkId: string }>;
  const extendedLabels = JSON.parse(await readFile(path.join(rootDir, "evaluation", "benchmark-labels", "extended.json"), "utf8")) as Array<{ benchmarkId: string }>;
  assert.deepEqual(new Set(developmentLabels.map((item) => item.benchmarkId)), new Set(cases.map((item) => item.id)));
  assert.deepEqual(new Set(blindLabels.map((item) => item.benchmarkId)), new Set(blindCases.map((item) => item.id)));
  assert.deepEqual(new Set(extendedLabels.map((item) => item.benchmarkId)), new Set(extendedCases.map((item) => item.id)));
  assert.match(await readFile(path.join(rootDir, ".dockerignore"), "utf8"), /^evaluation$/m);
  const todo = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "todo_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  const order = JSON.parse(await readFile(path.join(rootDir, "data", "projects", "order_portal_lite.json"), "utf8")) as { testCommand?: string; allowedOrigins?: string[] };
  assert.equal(todo.testCommand, "npm test");
  assert.equal(order.testCommand, "npm test");
  assert.ok(todo.allowedOrigins?.length);
  assert.ok(order.allowedOrigins?.length);
  const executionMap = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "execution-map.json"), "utf8")) as { mappings: Array<Record<string, string>> };
  assert.deepEqual(executionMap.mappings.map(({ logicalProjectId, executionProjectId, targetKind }) => ({ logicalProjectId, executionProjectId, targetKind })), [
    { logicalProjectId: "todo_lite", executionProjectId: "local_demo_app", targetKind: "app-under-test" },
    { logicalProjectId: "order_portal_lite", executionProjectId: "customer_portal_lite", targetKind: "independent-fixture" },
    { logicalProjectId: "customer_portal_lite", executionProjectId: "customer_portal_lite", targetKind: "independent-fixture" }
  ]);
  const challengeCases = JSON.parse(await readFile(path.join(rootDir, "data", "benchmark", "challenge-cases.json"), "utf8")) as Array<{ projectId: string; evaluationScope: string }>;
  assert.equal(challengeCases.length, 1);
  assert.equal(challengeCases[0].projectId, "investment_agent_workflow_external");
  assert.equal(challengeCases[0].evaluationScope, "challenge_only");
}
