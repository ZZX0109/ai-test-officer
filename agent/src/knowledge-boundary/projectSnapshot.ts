import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { LlmKnowledgeContext } from "@ai-test-officer/contracts";
import { getProject } from "../projectAdapter.js";
import { canonicalJson } from "./store.js";

const lockfileNames = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
  "gradle.lockfile",
  "Gemfile.lock",
  "composer.lock"
];

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryRoot() {
  return path.basename(process.cwd()) === "agent"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
}

function projectRoot(projectPath: string) {
  return path.isAbsolute(projectPath)
    ? path.resolve(projectPath)
    : path.resolve(repositoryRoot(), projectPath);
}

async function readOptional(file: string) {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

async function resolveGitDirectory(root: string) {
  const dotGit = path.join(root, ".git");
  const marker = await readOptional(dotGit);
  if (!marker) return dotGit;
  const match = marker.toString("utf8").trim().match(/^gitdir:\s*(.+)$/i);
  return match
    ? path.resolve(root, match[1])
    : dotGit;
}

async function readCommitSha(root: string) {
  const gitDirectory = await resolveGitDirectory(root);
  const head = await readOptional(path.join(gitDirectory, "HEAD"));
  if (!head) return undefined;
  const value = head.toString("utf8").trim();
  if (/^[a-f0-9]{40,64}$/i.test(value)) return value;
  const reference = value.match(/^ref:\s*(.+)$/i)?.[1];
  if (!reference) return undefined;
  const loose = await readOptional(path.resolve(gitDirectory, reference));
  if (loose && /^[a-f0-9]{40,64}$/i.test(loose.toString("utf8").trim())) {
    return loose.toString("utf8").trim();
  }
  const packed = await readOptional(path.join(gitDirectory, "packed-refs"));
  const packedLine = packed?.toString("utf8").split(/\r?\n/)
    .find((line) => line.endsWith(` ${reference}`));
  const packedSha = packedLine?.split(/\s+/)[0];
  return packedSha && /^[a-f0-9]{40,64}$/i.test(packedSha) ? packedSha : undefined;
}

async function hashLockfiles(root: string) {
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const name of lockfileNames) {
    const content = await readOptional(path.join(root, name));
    if (content) entries.push({ path: name, sha256: sha256(content) });
  }
  return entries.length ? sha256(canonicalJson(entries)) : undefined;
}

async function hashScenarioRegistry() {
  const directory = path.join(repositoryRoot(), "data", "scenarios");
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const entries = [];
  for (const name of files) {
    const content = await readOptional(path.join(directory, name));
    if (content) entries.push({ path: name, sha256: sha256(content) });
  }
  return sha256(canonicalJson(entries));
}

export async function buildProjectKnowledgeSnapshot(projectId: string) {
  const project = await getProject(projectId);
  if (!project) throw new Error("knowledge_project_not_found");
  const root = projectRoot(project.projectPath);
  const [commitSha, lockfileSha256, registrySha256] = await Promise.all([
    readCommitSha(root),
    hashLockfiles(root),
    hashScenarioRegistry()
  ]);
  const manifestSha256 = sha256(canonicalJson(project.manifest ?? {}));
  const projectDigest = sha256(canonicalJson({
    project,
    commitSha,
    manifestSha256,
    lockfileSha256,
    registrySha256
  }));
  return {
    projectId,
    commitSha,
    projectDigest,
    manifestSha256,
    lockfileSha256,
    registrySha256
  } satisfies NonNullable<LlmKnowledgeContext["projectSnapshot"]>;
}

export async function bindAndValidateProjectSnapshot(context: LlmKnowledgeContext) {
  if (!context.projectSnapshot) return context;
  const actual = await buildProjectKnowledgeSnapshot(context.projectSnapshot.projectId);
  for (const key of [
    "commitSha",
    "projectDigest",
    "manifestSha256",
    "lockfileSha256",
    "registrySha256"
  ] as const) {
    const expected = context.projectSnapshot[key];
    if (expected && expected !== actual[key]) {
      throw new Error(`knowledge_project_snapshot_expired:${key}`);
    }
  }
  return {
    ...context,
    projectSnapshot: actual
  } satisfies LlmKnowledgeContext;
}
