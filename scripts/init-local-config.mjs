import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(process.env.INIT_LOCAL_CONFIG_ROOT ?? path.resolve(scriptDir, ".."));
const configDir = path.join(rootDir, "config");
const exampleFile = path.join(configDir, "config.example.json");
const localSecretsFile = path.join(configDir, "local-secrets.json");
const legacyKeyFile = path.join(configDir, ".master-key");
const masterKeyFile = process.env.AGENT_MASTER_KEY_FILE ??
  path.join(homedir(), ".ai-test-officer", "master-key");
const masterKeyDir = path.dirname(masterKeyFile);

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalSecrets() {
  await mkdir(configDir, { recursive: true });
  if (await exists(localSecretsFile)) {
    return "kept existing config/local-secrets.json";
  }
  const raw = await readFile(exampleFile, "utf8");
  await writeFile(localSecretsFile, raw, { mode: 0o600 });
  return "created config/local-secrets.json from config/config.example.json";
}

async function ensureMasterKey() {
  await mkdir(masterKeyDir, { recursive: true });
  const hasExternalKey = await exists(masterKeyFile);
  const hasLegacyKey = await exists(legacyKeyFile);

  if (hasExternalKey) {
    const archivedLegacyKey = hasLegacyKey ? await archiveLegacyProjectKey() : undefined;
    if (archivedLegacyKey) {
      return `kept existing ${masterKeyFile}; archived legacy config/.master-key to ${archivedLegacyKey}`;
    }
    return `kept existing ${masterKeyFile}`;
  }

  if (hasLegacyKey) {
    const legacyKey = (await readFile(legacyKeyFile, "utf8")).trim();
    await writeFile(masterKeyFile, legacyKey, { mode: 0o600 });
    const archivedLegacyKey = await archiveLegacyProjectKey();
    return `migrated legacy config/.master-key to ${masterKeyFile}; archived project-local key to ${archivedLegacyKey}`;
  }

  await writeFile(masterKeyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  return `created ${masterKeyFile}`;
}

function legacyArchivePath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(masterKeyDir, `legacy-project-master-key-${timestamp}`);
}

async function archiveLegacyProjectKey() {
  const archiveFile = legacyArchivePath();
  const legacyKey = await readFile(legacyKeyFile, "utf8");
  await writeFile(archiveFile, legacyKey, { mode: 0o600 });
  await rm(legacyKeyFile, { force: true });
  return archiveFile;
}

const results = await Promise.all([ensureLocalSecrets(), ensureMasterKey()]);
for (const line of results) {
  console.log(line);
}
console.log("Project-local config/.master-key is intentionally not created.");
