import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runInitLocalConfig(env: Record<string, string>) {
  const script = path.join(rootDir, "scripts", "init-local-config.mjs");
  const child = spawn(process.execPath, [script], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  return { exitCode, stdout, stderr };
}

export async function testLocalConfigInit() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-init-config-"));
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-init-home-"));
  const configDir = path.join(fixtureRoot, "config");
  const legacyKeyFile = path.join(configDir, ".master-key");
  const masterKeyFile = path.join(homeRoot, "master-key");
  const legacyKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "config.example.json"), JSON.stringify({ credentials: [] }, null, 2));
  await writeFile(legacyKeyFile, `${legacyKey}\n`, { mode: 0o600 });

  try {
    const result = await runInitLocalConfig({
      INIT_LOCAL_CONFIG_ROOT: fixtureRoot,
      AGENT_MASTER_KEY_FILE: masterKeyFile
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /created config\/local-secrets\.json/);
    assert.match(result.stdout, /migrated legacy config\/\.master-key/);
    assert.equal(await exists(path.join(configDir, "local-secrets.json")), true);
    assert.equal(await exists(legacyKeyFile), false);
    assert.equal((await readFile(masterKeyFile, "utf8")).trim(), legacyKey);

    const archivedKeys = (await readdir(homeRoot)).filter((entry) => entry.startsWith("legacy-project-master-key-"));
    assert.equal(archivedKeys.length, 1);
    assert.equal((await readFile(path.join(homeRoot, archivedKeys[0]), "utf8")).trim(), legacyKey);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(homeRoot, { recursive: true, force: true });
  }
}
