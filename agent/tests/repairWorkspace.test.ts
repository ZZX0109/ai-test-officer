import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyRepairSession,
  createRepairSession,
  exportRepairSession,
  readRepairFile,
  validateRepairSession,
  writeRepairFile
} from "../src/repairWorkspace.js";
import type { ProjectConfig } from "../src/types.js";

export async function testRepairWorkspace() {
  const source = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-repair-"));
  try {
    await writeFile(path.join(source, "app.ts"), "export const answer = 1;\n");
    await writeFile(path.join(source, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(source, ".env"), "SECRET=must-not-copy\n");
    const project: ProjectConfig = {
      id: "repair-test-project",
      name: "Repair Test Project",
      projectPath: source
    };
    const session = await createRepairSession({
      runId: "run_repair_workspace_test",
      project,
      failureClass: "product-bug"
    });
    assert.notEqual(session.workspaceRoot, source);
    await assert.rejects(() => readRepairFile(session.id, "../outside.ts"), /repair_path_escape/);
    await assert.rejects(() => readRepairFile(session.id, ".env"), /repair_path_forbidden/);
    await assert.rejects(() => readRepairFile(session.id, "logo.png"), /repair_path_forbidden/);

    const file = await readRepairFile(session.id, "app.ts");
    const edited = await writeRepairFile({
      id: session.id,
      path: "app.ts",
      content: "export const answer = 2;\n",
      expectedVersion: file.version
    });
    assert.equal(edited.files.length, 1);
    assert.equal(edited.files[0]?.path, "app.ts");
    assert.equal(await readFile(path.join(source, "app.ts"), "utf8"), "export const answer = 1;\n");

    await assert.rejects(
      () => writeRepairFile({ id: session.id, path: "app.ts", content: "stale", expectedVersion: 0 }),
      /repair_version_conflict/
    );
    const patch = await exportRepairSession(session.id, "patch");
    assert.equal(patch.artifact.origin, "agent-generated");
    assert.equal(patch.artifact.kind, "source-patch");
    assert.match(await readFile(path.join(source, "app.ts"), "utf8"), /answer = 1/);

    const validation = await validateRepairSession(session.id, project);
    assert.equal(validation.validation?.status, "blocked");
    const previous = process.env.REPAIR_HOST_APPLY_ENABLED;
    process.env.REPAIR_HOST_APPLY_ENABLED = "false";
    await assert.rejects(() => applyRepairSession(session.id, project), /repair_host_apply_disabled/);
    if (previous === undefined) delete process.env.REPAIR_HOST_APPLY_ENABLED;
    else process.env.REPAIR_HOST_APPLY_ENABLED = previous;
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}
