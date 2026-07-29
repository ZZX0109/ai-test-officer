import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProjectLoginSecret, saveProjectLoginSecret } from "../src/projectLoginStore.js";

export async function testProjectLoginStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ato-project-login-"));
  const previousStore = process.env.PROJECT_LOGIN_STORE_FILE;
  const previousKey = process.env.AGENT_MASTER_KEY_HEX;
  process.env.PROJECT_LOGIN_STORE_FILE = path.join(directory, "credentials.json");
  process.env.AGENT_MASTER_KEY_HEX = "11".repeat(32);
  try {
    const testPassword = ["not-written", "in-plaintext"].join("-");
    const saved = await saveProjectLoginSecret({
      projectId: "project-a",
      username: "tester@example.test",
      password: testPassword
    });
    assert.match(saved.id, /^login_/);
    assert.equal(saved.usernameMasked.includes("tester@example.test"), false);
    const raw = await readFile(process.env.PROJECT_LOGIN_STORE_FILE, "utf8");
    assert.equal(raw.includes("tester@example.test"), false);
    assert.equal(raw.includes(testPassword), false);
    const resolved = await getProjectLoginSecret(saved.id);
    assert.equal(resolved?.username, "tester@example.test");
    assert.equal(resolved?.password, "not-written-in-plaintext");
  } finally {
    if (previousStore === undefined) delete process.env.PROJECT_LOGIN_STORE_FILE;
    else process.env.PROJECT_LOGIN_STORE_FILE = previousStore;
    if (previousKey === undefined) delete process.env.AGENT_MASTER_KEY_HEX;
    else process.env.AGENT_MASTER_KEY_HEX = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
}
