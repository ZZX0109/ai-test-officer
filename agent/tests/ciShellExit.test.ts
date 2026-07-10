import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

function resolveAgentDir() {
  return path.basename(process.cwd()) === "agent" ? process.cwd() : path.resolve(process.cwd(), "agent");
}

function runProbe(caseName: string) {
  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join("tests", "ciExitProbe.ts"), caseName], {
      cwd: resolveAgentDir(),
      stdio: "ignore"
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

export async function testCiShellExitContract() {
  const cases: Array<[string, number]> = [
    ["pass", 0],
    ["fail", 1],
    ["strict_review", 1],
    ["harness", 2],
    ["runtime", 3],
    ["unexpected", 4]
  ];
  for (const [caseName, expected] of cases) {
    assert.equal(await runProbe(caseName), expected, `ci shell exit code for ${caseName}`);
  }
}
