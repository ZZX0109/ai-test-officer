import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/main.tsx", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
};

for (const marker of [
  "data-testid=\"auth-state\"",
  "data-testid=\"permission-state\"",
  "data-testid=\"login-error\"",
  "data-testid=\"task-list\"",
  "data-testid=\"empty-state\"",
  "标记{task.title}为已完成",
  "编辑{task.title}"
]) {
  assert.ok(source.includes(marker), `app-under-test contract should include ${marker}`);
}

assert.ok(packageJson.scripts.dev.includes("dev:api"));
assert.ok(packageJson.scripts.dev.includes("dev:web"));
console.log("app-under-test contract tests passed.");
