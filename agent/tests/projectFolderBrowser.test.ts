import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProjectDirectory } from "../src/projectFolderBrowser.js";

export async function testProjectFolderBrowser() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-folder-browser-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "src", "main.ts"), "export {};");
    const topLevel = await listProjectDirectory({ projectPath: root });
    assert.deepEqual(topLevel.map((entry) => [entry.kind, entry.name]), [
      ["directory", "src"],
      ["file", "package.json"]
    ]);
    const source = await listProjectDirectory({ projectPath: root, relativePath: "src" });
    assert.equal(source[0]?.relativePath, "src/main.ts");
    await assert.rejects(
      () => listProjectDirectory({ projectPath: root, relativePath: "../" }),
      /project_directory_path_escape/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
