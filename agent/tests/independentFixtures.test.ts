import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The fixture is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fixture did not become healthy: ${url}`);
}

async function runFixture(directory: string, port: number, checks: (baseUrl: string) => Promise<void>) {
  const child: ChildProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(rootDir, "fixtures", directory),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${baseUrl}/health`);
    await checks(baseUrl);
  } finally {
    child.kill("SIGTERM");
  }
}

export async function testIndependentFixtures() {
  const todoConfig = JSON.parse(await readFile(path.join(rootDir, "data/projects/todo_lite.json"), "utf8")) as { projectPath: string; healthCheckUrl: string };
  assert.equal(todoConfig.projectPath, "fixtures/todo-lite");
  await runFixture("todo-lite", 6282, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks?status=completed`);
    const payload = await response.json() as { tasks: Array<{ status: string }> };
    assert.ok(payload.tasks.length > 0);
    assert.ok(payload.tasks.every((task) => task.status === "completed"));
    const openApi = await (await fetch(`${baseUrl}/openapi.json`)).json() as { paths: Record<string, unknown> };
    assert.ok(openApi.paths["/api/tasks"]);
  });
  await runFixture("order-portal-lite", 6283, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/orders?status=pending`);
    const payload = await response.json() as { orders: Array<{ status: string }> };
    assert.ok(payload.orders.length > 0);
    assert.ok(payload.orders.every((order) => order.status === "pending"));
    const approval = await fetch(`${baseUrl}/api/orders/ORD-1001/approve`, { method: "POST" });
    assert.equal(approval.status, 200);
    const repeated = await fetch(`${baseUrl}/api/orders/ORD-1001/approve`, { method: "POST" });
    assert.equal(repeated.status, 409);
  });
}
