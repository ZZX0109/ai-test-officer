import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(new URL("../acceptance-projects.lock.json", import.meta.url), "utf8"));
assert.equal(lock.schemaVersion, "1.0");
assert.equal(Array.isArray(lock.projects), true);
assert.equal(lock.projects.length, 5, "release acceptance requires exactly five pinned heterogeneous projects");
const ids = new Set();
for (const project of lock.projects) {
  assert.match(project.id, /^[a-z0-9][a-z0-9-]+$/);
  assert.equal(ids.has(project.id), false, `duplicate project id: ${project.id}`);
  ids.add(project.id);
  if (project.kind === "git") {
    assert.match(project.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/);
    assert.match(project.revision, /^[a-f0-9]{40}$/, `${project.id} must use a full immutable commit SHA`);
  } else {
    assert.equal(project.kind, "source-snapshot");
    assert.match(project.treeSha256, /^[a-f0-9]{64}$/, `${project.id} must use a full source tree digest`);
  }
}
console.log(`acceptance-projects.lock.json verified (${lock.projects.length} immutable projects)`);
