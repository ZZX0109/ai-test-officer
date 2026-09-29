import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectProject } from "../src/projectDetection.js";
import { saveProject, startProject, stopProject, testProjectConnection } from "../src/projectAdapter.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

export async function testOciStaticRuntimeSmoke() {
  if (process.env.RUN_OCI_STATIC_SMOKE !== "1") return;

  const scratchRoot = path.join(rootDir, "reports", "oci-static-runtime-smoke");
  await mkdir(scratchRoot, { recursive: true });
  const projectPath = await mkdtemp(path.join(scratchRoot, "static-"));
  const projectId = `oci_static_runtime_${Date.now()}`;
  const projectFile = path.join(rootDir, "data", "projects", `${projectId}.json`);
  try {
    await writeFile(path.join(projectPath, "index.html"), "<!doctype html><html><body><h1>OCI Static Stack Fixture</h1></body></html>");
    const detected = await detectProject(projectPath);
    const timestamp = new Date().toISOString();
    const project = await saveProject({
      ...detected.suggestedConfig,
      id: projectId,
      name: "OCI Static Runtime Smoke",
      projectPath,
      allowExternalProjectPath: true,
      manifest: detected.suggestedConfig.manifest
        ? {
          ...detected.suggestedConfig.manifest,
          projectId,
          network: { ...detected.suggestedConfig.manifest.network, mode: "deny", allowedHosts: [], enforcement: "none" }
        }
        : undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const runtime = await startProject(projectId);
    assert.equal(runtime.status, "running", runtime.message);
    const health = await testProjectConnection(project);
    assert.equal(health.ok, true, health.message);
    assert.equal(health.health?.ok, true, "the internal health probe must verify the static server");
    const stopped = await stopProject(projectId);
    assert.equal(stopped.status, "stopped");
  } finally {
    await stopProject(projectId);
    await rm(projectFile, { force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
}
