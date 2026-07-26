import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CredentialInput, CredentialPublic, CredentialRecord } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const configDir = path.join(rootDir, "config");
const storeFile = path.join(configDir, "local-secrets.json");
const backupFile = path.join(configDir, "local-secrets.backup.json");
const legacyKeyFile = path.join(configDir, ".master-key");
const externalKeyFile =
  process.env.AGENT_MASTER_KEY_FILE ??
  path.join(homedir(), ".ai-test-officer", "master-key");

interface CredentialStoreFile {
  credentials: CredentialRecord[];
}

class CredentialStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

async function ensureConfig() {
  await mkdir(configDir, { recursive: true });
}

async function exists(file: string) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseHexKey(value: string) {
  const key = Buffer.from(value.trim(), "hex");
  if (key.length !== 32) {
    throw new CredentialStoreError("Master key must be 32 bytes hex.");
  }
  return key;
}

async function readOrCreateExternalKey() {
  await mkdir(path.dirname(externalKeyFile), { recursive: true });
  try {
    return parseHexKey(await readFile(externalKeyFile, "utf8"));
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    if (await exists(legacyKeyFile)) {
      const legacy = await readFile(legacyKeyFile, "utf8");
      await writeFile(externalKeyFile, legacy.trim(), { mode: 0o600 });
      return parseHexKey(legacy);
    }
    const key = randomBytes(32);
    await writeFile(externalKeyFile, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

async function getMasterKey() {
  if (process.env.AGENT_MASTER_KEY_HEX) {
    return parseHexKey(process.env.AGENT_MASTER_KEY_HEX);
  }
  return readOrCreateExternalKey();
}

function maskKey(apiKey: string) {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

export async function encrypt(value: string) {
  const key = await getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export async function decrypt(value: string) {
  const key = await getMasterKey();
  const [ivHex, tagHex, encryptedHex] = value.split(":");
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new CredentialStoreError("Encrypted credential has invalid format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

function assertCredentialStore(candidate: unknown): CredentialStoreFile {
  if (!candidate || typeof candidate !== "object") {
    throw new CredentialStoreError("Credential store schema mismatch.");
  }
  const credentials = (candidate as { credentials?: unknown }).credentials;
  if (!Array.isArray(credentials)) {
    throw new CredentialStoreError("Credential store missing credentials array.");
  }
  for (const record of credentials) {
    if (!record || typeof record !== "object") {
      throw new CredentialStoreError("Credential record schema mismatch.");
    }
    const item = record as Partial<CredentialRecord>;
    if (!item.id || !item.name || !item.provider || !item.baseUrl || !item.apiKeyEncrypted || !item.apiKeyMasked || !item.model) {
      throw new CredentialStoreError(`Credential record ${item.id ?? "<unknown>"} is incomplete.`);
    }
  }
  return { credentials: credentials as CredentialRecord[] };
}

async function readStore(): Promise<CredentialStoreFile> {
  await ensureConfig();
  try {
    const raw = await readFile(storeFile, "utf8");
    return assertCredentialStore(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { credentials: [] };
    }
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError(error instanceof Error ? `Credential store read failed: ${error.message}` : "Credential store read failed.");
  }
}

async function atomicWriteJson(file: string, value: unknown) {
  await ensureConfig();
  if (await exists(file)) {
    await copyFile(file, backupFile);
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function writeStore(store: CredentialStoreFile) {
  await atomicWriteJson(storeFile, store);
}

function toPublic(record: CredentialRecord): CredentialPublic {
  const { apiKeyEncrypted: _apiKeyEncrypted, ...safe } = record;
  return safe;
}

export async function listCredentials() {
  const store = await readStore();
  return store.credentials.map(toPublic);
}

export async function getCredential(id: string) {
  const store = await readStore();
  return store.credentials.find((item) => item.id === id);
}

export async function createCredential(input: CredentialInput) {
  const store = await readStore();
  const now = new Date().toISOString();
  const record: CredentialRecord = {
    id: `cred_${randomBytes(8).toString("hex")}`,
    name: input.name,
    provider: input.provider,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    apiKeyEncrypted: await encrypt(input.apiKey),
    apiKeyMasked: maskKey(input.apiKey),
    model: input.model,
    tags: input.tags,
    owner: input.owner,
    scopes: input.scopes,
    isDefault: Boolean(input.isDefault) || store.credentials.length === 0,
    rotationHistory: [],
    createdAt: now,
    updatedAt: now
  };
  if (record.isDefault) {
    store.credentials = store.credentials.map((item) => ({ ...item, isDefault: false }));
  }
  store.credentials.push(record);
  await writeStore(store);
  return toPublic(record);
}

export async function updateCredential(id: string, input: Partial<CredentialInput>) {
  const store = await readStore();
  const index = store.credentials.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const current = store.credentials[index];
  const updated: CredentialRecord = {
    ...current,
    name: input.name ?? current.name,
    provider: input.provider ?? current.provider,
    baseUrl: input.baseUrl ? input.baseUrl.replace(/\/$/, "") : current.baseUrl,
    model: input.model ?? current.model,
    tags: input.tags ?? current.tags,
    owner: input.owner ?? current.owner,
    scopes: input.scopes ?? current.scopes,
    isDefault: input.isDefault ?? current.isDefault,
    updatedAt: new Date().toISOString()
  };
  if (input.apiKey) {
    updated.apiKeyEncrypted = await encrypt(input.apiKey);
    updated.apiKeyMasked = maskKey(input.apiKey);
  }
  if (updated.isDefault) {
    store.credentials = store.credentials.map((item) => ({ ...item, isDefault: false }));
  }
  store.credentials[index] = updated;
  await writeStore(store);
  return toPublic(updated);
}

export async function rotateCredential(id: string, input: { apiKey: string; reason?: string }) {
  const store = await readStore();
  const index = store.credentials.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const current = store.credentials[index];
  const rotatedAt = new Date().toISOString();
  const updated: CredentialRecord = {
    ...current,
    apiKeyEncrypted: await encrypt(input.apiKey),
    apiKeyMasked: maskKey(input.apiKey),
    rotationHistory: [
      ...(current.rotationHistory ?? []),
      {
        rotatedAt,
        apiKeyMasked: current.apiKeyMasked,
        reason: input.reason
      }
    ].slice(-20),
    updatedAt: rotatedAt
  };
  store.credentials[index] = updated;
  await writeStore(store);
  return toPublic(updated);
}

export async function markCredentialUsed(id: string) {
  const store = await readStore();
  const index = store.credentials.findIndex((item) => item.id === id);
  if (index === -1) return undefined;
  store.credentials[index] = { ...store.credentials[index], lastUsedAt: new Date().toISOString() };
  await writeStore(store);
  return toPublic(store.credentials[index]);
}

export async function deleteCredential(id: string) {
  const store = await readStore();
  const target = store.credentials.find((item) => item.id === id);
  store.credentials = store.credentials.filter((item) => item.id !== id);
  if (target?.isDefault && store.credentials[0]) {
    store.credentials[0].isDefault = true;
  }
  await writeStore(store);
  return Boolean(target);
}
