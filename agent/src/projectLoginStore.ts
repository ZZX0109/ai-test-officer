import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { decrypt, encrypt } from "./credentialStore.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
function storeFile() {
  return process.env.PROJECT_LOGIN_STORE_FILE ?? path.join(rootDir, "config", "project-login-secrets.json");
}

interface ProjectLoginSecretRecord {
  id: string;
  projectId: string;
  usernameEncrypted: string;
  passwordEncrypted: string;
  usernameMasked: string;
  createdAt: string;
  updatedAt: string;
}

async function readStore(): Promise<ProjectLoginSecretRecord[]> {
  try {
    const value = JSON.parse(await readFile(storeFile(), "utf8")) as { credentials?: ProjectLoginSecretRecord[] };
    return Array.isArray(value.credentials) ? value.credentials : [];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeStore(credentials: ProjectLoginSecretRecord[]) {
  const target = storeFile();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ credentials }, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

function maskUsername(username: string) {
  if (username.length <= 3) return "***";
  const at = username.indexOf("@");
  if (at > 1) return `${username.slice(0, 2)}***${username.slice(at)}`;
  return `${username.slice(0, 2)}***${username.slice(-1)}`;
}

export async function saveProjectLoginSecret(input: { projectId: string; username: string; password: string }) {
  const credentials = await readStore();
  const existingIndex = credentials.findIndex((item) => item.projectId === input.projectId);
  const timestamp = new Date().toISOString();
  const record: ProjectLoginSecretRecord = {
    id: existingIndex >= 0 ? credentials[existingIndex].id : `login_${randomBytes(8).toString("hex")}`,
    projectId: input.projectId,
    usernameEncrypted: await encrypt(input.username),
    passwordEncrypted: await encrypt(input.password),
    usernameMasked: maskUsername(input.username),
    createdAt: existingIndex >= 0 ? credentials[existingIndex].createdAt : timestamp,
    updatedAt: timestamp
  };
  if (existingIndex >= 0) credentials[existingIndex] = record;
  else credentials.push(record);
  await writeStore(credentials);
  return { id: record.id, projectId: record.projectId, usernameMasked: record.usernameMasked, updatedAt: record.updatedAt };
}

export async function getProjectLoginSecret(id: string) {
  const record = (await readStore()).find((item) => item.id === id);
  if (!record) return undefined;
  return {
    id: record.id,
    projectId: record.projectId,
    username: await decrypt(record.usernameEncrypted),
    password: await decrypt(record.passwordEncrypted)
  };
}
