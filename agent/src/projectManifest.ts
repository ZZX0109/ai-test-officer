import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectManifestSchema, type ProjectManifest } from "@ai-test-officer/contracts";
import { resolveManifestWorkspace } from "@ai-test-officer/execution-worker";

export async function loadProjectManifest(input: { repositoryRoot: string; manifestPath?: string }): Promise<ProjectManifest> {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const file = path.resolve(repositoryRoot, input.manifestPath ?? "ai-test-officer.project.json");
  if (file !== repositoryRoot && !file.startsWith(`${repositoryRoot}${path.sep}`)) throw new Error("manifest_path_escape");
  const manifest = projectManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  resolveManifestWorkspace(manifest, repositoryRoot);
  return manifest;
}

export function manifestToProjectConfig(manifest: ProjectManifest, repositoryRoot: string) {
  const workspace = resolveManifestWorkspace(manifest, repositoryRoot);
  const timestamp = new Date().toISOString();
  return {
    id: manifest.projectId,
    name: manifest.projectId,
    projectPath: path.relative(repositoryRoot, workspace) || ".",
    frontendUrl: process.env.APP_URL ?? "http://127.0.0.1:6173",
    healthCheckUrl: manifest.healthCheck ? `${process.env.APP_URL ?? "http://127.0.0.1:6173"}${manifest.healthCheck.path}` : undefined,
    installCommand: "",
    installCommandSpec: manifest.commands.install,
    startCommand: "",
    startCommandSpec: manifest.commands.start,
    testCommand: manifest.commands.test ? [manifest.commands.test.executable, ...manifest.commands.test.args].join(" ") : undefined,
    cleanupCommand: "",
    cleanupCommandSpec: manifest.commands.cleanup,
    timeoutMs: manifest.healthCheck?.timeoutMs ?? manifest.budget.prepareTimeoutMs,
    env: {},
    allowedOrigins: [],
    login: { method: "none" as const },
    manifest,
    budget: manifest.budget,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
