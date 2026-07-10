import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testServiceHealthContract() {
  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [path.join(rootDir, "scripts", "dev-service-health.mjs")], {
      cwd: rootDir
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const payload = JSON.parse(stdout) as {
    ok: boolean;
    services: Record<string, { status: string; port: number }>;
  };
  assert.equal(typeof payload.ok, "boolean");
  for (const [id, port] of Object.entries({ agent: 4317, appApi: 6172, appWeb: 6173, workbench: 6174 })) {
    assert.equal(payload.services[id].port, port);
    assert.match(payload.services[id].status, /listening|missing|unhealthy/);
  }
}
