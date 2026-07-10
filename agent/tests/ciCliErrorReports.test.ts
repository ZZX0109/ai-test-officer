import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const agentDir = path.basename(process.cwd()) === "agent" ? process.cwd() : path.join(process.cwd(), "agent");
const rootDir = path.resolve(agentDir, "..");

function runCli(env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "commitCheckCli.ts")], {
      cwd: agentDir,
      env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

export async function testCiCliErrorReports() {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-ci-error-reports-"));
  const projectId = "runtime_unavailable_cli_selftest";
  const projectFile = path.join(rootDir, "data", "projects", `${projectId}.json`);
  try {
    await writeFile(projectFile, JSON.stringify({
      id: projectId,
      name: "Runtime Unavailable CLI Selftest",
      projectPath: ".",
      allowExternalProjectPath: false,
      installCommand: "",
      startCommand: "",
      frontendUrl: "http://127.0.0.1:1",
      login: { method: "none" },
      timeoutMs: 500,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2));
    const result = await runCli({
      ...process.env,
      REPORTS_DIR: reportsDir,
      PROJECT_ID: projectId,
      SCENARIO_ID: "task_filter_completed",
      APP_URL: "http://127.0.0.1:1",
      STRICT_INPUT: "1",
      HEADLESS: "1",
      CONNECTOR_FETCH_RETRIES: "0"
    });
    assert.equal(result.code, 3, result.stderr);
    const gate = JSON.parse(await readFile(path.join(reportsDir, "gate.json"), "utf8")) as {
      exitCode: number;
      exitMeaning: string;
      verdict: string;
      error?: { message?: string };
    };
    assert.equal(gate.exitCode, 3);
    assert.equal(gate.exitMeaning, "runtime_unavailable");
    assert.equal(gate.verdict, "error");
    assert.match(gate.error?.message ?? "", /runtime_unavailable/);
    assert.match(await readFile(path.join(reportsDir, "pr-annotation.md"), "utf8"), /runtime_unavailable/);
    const junit = await readFile(path.join(reportsDir, "junit.xml"), "utf8");
    assert.match(junit, /errors="1"/);
    assert.match(junit, /runtime_unavailable/);
    const annotations = JSON.parse(await readFile(path.join(reportsDir, "pr-annotations.json"), "utf8")) as Array<{ annotation_level: string }>;
    assert.equal(annotations[0]?.annotation_level, "failure");
    const upload = JSON.parse(await readFile(path.join(reportsDir, "artifact-upload-manifest.json"), "utf8")) as { files: string[] };
    assert.deepEqual(upload.files, [
      "reports/gate.json",
      "reports/junit.xml",
      "reports/pr-annotation.md",
      "reports/pr-annotations.json",
      "reports/artifact-upload-manifest.json"
    ]);
  } finally {
    await rm(projectFile, { force: true });
    await rm(reportsDir, { recursive: true, force: true });
  }

  const invalidConfigReportsDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-ci-invalid-config-"));
  const invalidGateConfig = path.join(invalidConfigReportsDir, "invalid-gate.json");
  try {
    await writeFile(invalidGateConfig, JSON.stringify({ flakyMode: "maybe" }));
    const result = await runCli({
      ...process.env,
      REPORTS_DIR: invalidConfigReportsDir,
      CI_GATE_CONFIG: invalidGateConfig,
      STRICT_INPUT: "1",
      HEADLESS: "1"
    });
    assert.equal(result.code, 4, result.stderr);
    const gate = JSON.parse(await readFile(path.join(invalidConfigReportsDir, "gate.json"), "utf8")) as {
      exitCode: number;
      exitMeaning: string;
      verdict: string;
      error?: { message?: string };
    };
    assert.equal(gate.exitCode, 4);
    assert.equal(gate.exitMeaning, "unexpected_cli_error");
    assert.equal(gate.verdict, "error");
    assert.match(gate.error?.message ?? "", /Invalid CI gate config flakyMode/);
    assert.match(await readFile(path.join(invalidConfigReportsDir, "junit.xml"), "utf8"), /unexpected_cli_error/);
    assert.match(await readFile(path.join(invalidConfigReportsDir, "pr-annotation.md"), "utf8"), /unexpected_cli_error/);
    const upload = JSON.parse(await readFile(path.join(invalidConfigReportsDir, "artifact-upload-manifest.json"), "utf8")) as { files: string[] };
    assert.deepEqual(upload.files, [
      "reports/gate.json",
      "reports/junit.xml",
      "reports/pr-annotation.md",
      "reports/pr-annotations.json",
      "reports/artifact-upload-manifest.json"
    ]);
  } finally {
    await rm(invalidConfigReportsDir, { recursive: true, force: true });
  }
}
