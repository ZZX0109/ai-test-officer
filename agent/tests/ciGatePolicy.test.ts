import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCiGatePolicy } from "../src/ciGatePolicy.js";

export async function testCiGatePolicy() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-gate-policy-"));
  try {
    const defaults = readCiGatePolicy({ rootDir: tempDir, env: {} });
    assert.equal(defaults.strictGate, false);
    assert.equal(defaults.flakyMode, "warn");
    assert.deepEqual(defaults.quarantinedScenarios, []);

    const configFile = path.join(tempDir, "gate.json");
    await writeFile(configFile, JSON.stringify({
      strictGate: true,
      flakyMode: "fail",
      quarantinedScenarios: ["legacy_login", "  unstable_checkout  ", 42, ""]
    }));
    const configured = readCiGatePolicy({ rootDir: tempDir, configPath: configFile, env: {} });
    assert.equal(configured.strictGate, true);
    assert.equal(configured.flakyMode, "fail");
    assert.deepEqual(configured.quarantinedScenarios, ["legacy_login", "unstable_checkout"]);

    await writeFile(configFile, JSON.stringify({
      strictGate: false,
      flakyMode: "warn",
      quarantinedScenarios: []
    }));
    const envOverride = readCiGatePolicy({ rootDir: tempDir, configPath: configFile, env: { STRICT_RELEASE_GATE: "1" } });
    assert.equal(envOverride.strictGate, true);
    assert.equal(envOverride.flakyMode, "warn");

    await writeFile(configFile, JSON.stringify({ flakyMode: "maybe" }));
    assert.throws(
      () => readCiGatePolicy({ rootDir: tempDir, configPath: configFile, env: {} }),
      /Invalid CI gate config flakyMode/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
