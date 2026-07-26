import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  defaultProjectConfig,
  getProjectRuntimeStatus,
  listProjects,
  recordProjectRuntimeStatus,
  resolveProjectTarget,
  saveProject,
  startProject,
  stopProject,
  testProjectConnection
} from "../src/projectAdapter.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();

async function removeProjectFixture(id: string) {
  await rm(path.join(rootDir, "data", "projects", `${id}.json`), { force: true });
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Unable to allocate a free TCP port for project adapter test."));
        }
      });
    });
  });
}

async function expectUrlUnreachable(url: string, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }
  throw new Error(`Expected ${url} to be unreachable after stopping the external project.`);
}

async function waitForRuntimeStatus(id: string, expected: string, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = getProjectRuntimeStatus(id);
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected runtime ${id} to reach ${expected}, got ${getProjectRuntimeStatus(id).status}.`);
}

export async function testProjectAdapter() {
  await removeProjectFixture("registrytest_project_adapter");
  await removeProjectFixture("external_registrytest_project_adapter");
  await removeProjectFixture("install_failure_registrytest_project_adapter");
  await removeProjectFixture("install_stop_registrytest_project_adapter");
  await removeProjectFixture("redacted_env_registrytest_project_adapter");
  await removeProjectFixture("external_runtime_registrytest_project_adapter");
  await removeProjectFixture("multi_process_registrytest_project_adapter");
  await removeProjectFixture("restart_after_exit_registrytest_project_adapter");
  await removeProjectFixture("cleanup_failure_registrytest_project_adapter");
  await removeProjectFixture("runtime_target_registrytest_project_adapter");
  const demo = defaultProjectConfig();
  assert.equal(demo.frontendUrl, "http://localhost:6173");
  const saved = await saveProject({
    ...demo,
    id: "registrytest_project_adapter",
    name: "Self Test Project Adapter",
    env: {
      API_TOKEN: "secret-token",
      PUBLIC_FLAG: "1"
    },
    startCommand: ""
  });
  assert.equal(saved.installCommand, "");
  assert.equal(saved.env?.API_TOKEN, "[REDACTED]");
  assert.ok((await listProjects()).some((project) => project.id === saved.id));
  const runtimeTargetProject = await saveProject({
    ...saved,
    id: "runtime_target_registrytest_project_adapter",
    frontendUrl: "http://127.0.0.1:8080",
    healthCheckUrl: "http://127.0.0.1:8080"
  });
  recordProjectRuntimeStatus({
    projectId: runtimeTargetProject.id,
    status: "running",
    frontendUrl: "http://127.0.0.1:65403",
    healthCheckUrl: "http://127.0.0.1:65403",
    failureReason: "none",
    message: "Test sandbox runtime is healthy."
  });
  const resolvedRuntimeTarget = await resolveProjectTarget({
    projectId: runtimeTargetProject.id,
    // A stale client value must not override the managed runtime endpoint.
    appUrl: "http://127.0.0.1:8080"
  });
  assert.equal(resolvedRuntimeTarget.frontendUrl, "http://127.0.0.1:65403");
  assert.equal(resolvedRuntimeTarget.healthCheckUrl, "http://127.0.0.1:65403");
  recordProjectRuntimeStatus({
    projectId: runtimeTargetProject.id,
    status: "stopped",
    frontendUrl: "http://127.0.0.1:65403",
    healthCheckUrl: "http://127.0.0.1:65403",
    message: "Test runtime stopped."
  });
  const connection = await testProjectConnection({
    ...saved,
    frontendUrl: "http://127.0.0.1:1",
    healthCheckUrl: "http://127.0.0.1:1",
    timeoutMs: 1000
  });
  assert.equal(connection.ok, false);
  assert.match(connection.reason, /health_timeout|frontend_unreachable|backend_unreachable|credential_missing|project_path_missing/);
  await withEnv({ E2E_USERNAME: undefined, E2E_PASSWORD: undefined }, async () => {
    const missingCredential = await testProjectConnection({
      ...saved,
      login: { method: "form", usernameEnv: "E2E_USERNAME", passwordEnv: "E2E_PASSWORD" },
      frontendUrl: "http://127.0.0.1:1",
      healthCheckUrl: undefined,
      backendUrl: undefined,
      timeoutMs: 1000
    });
    assert.equal(missingCredential.reason, "credential_missing");
    assert.deepEqual(missingCredential.credential.missingEnv, ["E2E_USERNAME", "E2E_PASSWORD"]);
  });
  await withEnv({ E2E_USERNAME: "qa@example.com", E2E_PASSWORD: "pw" }, async () => {
    const presentCredential = await testProjectConnection({
      ...saved,
      login: { method: "form", usernameEnv: "E2E_USERNAME", passwordEnv: "E2E_PASSWORD" },
      frontendUrl: "http://127.0.0.1:1",
      healthCheckUrl: undefined,
      backendUrl: undefined,
      timeoutMs: 1000
    });
    assert.equal(presentCredential.credential.ok, true);
    assert.equal(presentCredential.reason, "frontend_unreachable");
  });
  await assert.rejects(() => saveProject({ ...saved, id: "escape", projectPath: "../outside" }));
  const external = await saveProject({
    ...saved,
    id: "external_registrytest_project_adapter",
    projectPath: "/tmp",
    allowExternalProjectPath: true
  });
  assert.equal(external.allowExternalProjectPath, true);
  const externalRuntimeDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-external-project-"));
  const externalRuntimeId = "external_runtime_registrytest_project_adapter";
  const externalRuntimePort = await freePort();
  const externalRuntimeUrl = `http://127.0.0.1:${externalRuntimePort}/health`;
  await writeFile(path.join(externalRuntimeDir, "child-server.mjs"), `
import http from "node:http";

const port = Number(process.env.PORT);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, source: "external-project-fixture" }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`);
  await writeFile(path.join(externalRuntimeDir, "parent.mjs"), `
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["child-server.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "ignore"
});

child.unref();
process.on("SIGTERM", () => {
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(0), 100);
});
setInterval(() => {}, 1000);
`);
  try {
    const externalRuntime = await saveProject({
      ...saved,
      id: externalRuntimeId,
      projectPath: externalRuntimeDir,
      allowExternalProjectPath: true,
      installCommand: "",
      startCommand: "node parent.mjs",
      frontendUrl: externalRuntimeUrl,
      backendUrl: undefined,
      healthCheckUrl: externalRuntimeUrl,
      env: { PORT: String(externalRuntimePort) },
      timeoutMs: 5_000
    });
    assert.equal(externalRuntime.allowExternalProjectPath, true);
    const concurrentStarts = await Promise.all([
      startProject(externalRuntime.id),
      startProject(externalRuntime.id),
      startProject(externalRuntime.id)
    ]);
    assert.equal(concurrentStarts.every((status) => status.status === "running"), true);
    assert.equal(new Set(concurrentStarts.map((status) => status.pid)).size, 1);
    const externalHealth = await testProjectConnection(externalRuntime);
    assert.equal(externalHealth.ok, true);
    const externalStopped = await stopProject(externalRuntime.id);
    assert.equal(externalStopped.status, "stopped");
    await expectUrlUnreachable(externalRuntimeUrl);
    // An adopted local process may disappear without emitting a child-process
    // exit event. A later start must probe the endpoint instead of trusting a
    // stale in-memory "running" snapshot.
    recordProjectRuntimeStatus({
      projectId: externalRuntime.id,
      status: "running",
      frontendUrl: externalRuntimeUrl,
      healthCheckUrl: externalRuntimeUrl,
      message: "stale adopted runtime"
    });
    const restartedFromStaleRuntime = await startProject(externalRuntime.id);
    assert.equal(restartedFromStaleRuntime.status, "running");
    assert.equal((await testProjectConnection(externalRuntime)).ok, true);
  } finally {
    await stopProject(externalRuntimeId);
    await removeProjectFixture(externalRuntimeId);
    await rm(externalRuntimeDir, { recursive: true, force: true });
  }
  const multiProcessDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-multi-process-project-"));
  const multiProcessId = "multi_process_registrytest_project_adapter";
  const multiApiPort = await freePort();
  const multiWebPort = await freePort();
  const multiApiUrl = `http://127.0.0.1:${multiApiPort}/health`;
  const multiWebUrl = `http://127.0.0.1:${multiWebPort}/health`;
  await writeFile(path.join(multiProcessDir, "server.mjs"), `
import http from "node:http";

const port = Number(process.env.PORT);
const name = process.env.NAME ?? "service";
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true, name }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`);
  try {
    const multi = await saveProject({
      ...saved,
      id: multiProcessId,
      projectPath: multiProcessDir,
      allowExternalProjectPath: true,
      installCommand: "",
      startCommand: "",
      processes: [
        { name: "api", command: `PORT=${multiApiPort} NAME=api node server.mjs`, healthCheckUrl: multiApiUrl, required: true },
        { name: "web", command: `PORT=${multiWebPort} NAME=web node server.mjs`, healthCheckUrl: multiWebUrl, required: true }
      ],
      frontendUrl: multiWebUrl,
      backendUrl: multiApiUrl,
      healthCheckUrl: multiApiUrl,
      timeoutMs: 5_000
    });
    const multiStatus = await startProject(multi.id);
    assert.equal(multiStatus.status, "running");
    assert.equal(multiStatus.processes?.length, 2);
    assert.equal(multiStatus.processes?.every((process) => process.status === "running"), true);
    const multiHealth = await testProjectConnection(multi);
    assert.equal(multiHealth.ok, true);
    assert.equal(multiHealth.processHealth?.length, 2);
    const multiStopped = await stopProject(multi.id);
    assert.equal(multiStopped.status, "stopped");
    await expectUrlUnreachable(multiApiUrl);
    await expectUrlUnreachable(multiWebUrl);
  } finally {
    await stopProject(multiProcessId);
    await removeProjectFixture(multiProcessId);
    await rm(multiProcessDir, { recursive: true, force: true });
  }
  const restartRuntimeDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-restart-project-"));
  const restartRuntimeId = "restart_after_exit_registrytest_project_adapter";
  const restartRuntimePort = await freePort();
  const restartRuntimeUrl = `http://127.0.0.1:${restartRuntimePort}/health`;
  await writeFile(path.join(restartRuntimeDir, "server-once.mjs"), `
import http from "node:http";

const port = Number(process.env.PORT);
const lifetimeMs = Number(process.env.LIFETIME_MS ?? 250);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

server.listen(port, "127.0.0.1", () => {
  setTimeout(() => server.close(() => process.exit(0)), lifetimeMs);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  try {
    const restartRuntime = await saveProject({
      ...saved,
      id: restartRuntimeId,
      projectPath: restartRuntimeDir,
      allowExternalProjectPath: true,
      installCommand: "",
      startCommand: "node server-once.mjs",
      frontendUrl: restartRuntimeUrl,
      backendUrl: undefined,
      healthCheckUrl: restartRuntimeUrl,
      env: { PORT: String(restartRuntimePort), LIFETIME_MS: "1500" },
      timeoutMs: 3_000
    });
    const firstStart = await startProject(restartRuntime.id);
    assert.equal(firstStart.status, "running");
    await expectUrlUnreachable(restartRuntimeUrl);
    await waitForRuntimeStatus(restartRuntime.id, "stopped");
    const secondStart = await startProject(restartRuntime.id);
    assert.equal(secondStart.status, "running");
  } finally {
    await stopProject(restartRuntimeId);
    await removeProjectFixture(restartRuntimeId);
    await rm(restartRuntimeDir, { recursive: true, force: true });
  }
  const cleanupFailureDir = await mkdtemp(path.join(os.tmpdir(), "ai-test-officer-cleanup-project-"));
  const cleanupFailureId = "cleanup_failure_registrytest_project_adapter";
  const cleanupFailurePort = await freePort();
  const cleanupFailureUrl = `http://127.0.0.1:${cleanupFailurePort}/health`;
  await writeFile(path.join(cleanupFailureDir, "server.mjs"), `
import http from "node:http";

const port = Number(process.env.PORT);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
  try {
    const cleanupFailure = await saveProject({
      ...saved,
      id: cleanupFailureId,
      projectPath: cleanupFailureDir,
      allowExternalProjectPath: true,
      installCommand: "",
      startCommand: "node server.mjs",
      cleanupCommand: "node -e \"process.exit(1)\"",
      frontendUrl: cleanupFailureUrl,
      backendUrl: undefined,
      healthCheckUrl: cleanupFailureUrl,
      env: { PORT: String(cleanupFailurePort) },
      timeoutMs: 3_000
    });
    const cleanupStart = await startProject(cleanupFailure.id);
    assert.equal(cleanupStart.status, "running");
    const cleanupStop = await stopProject(cleanupFailure.id);
    assert.equal(cleanupStop.status, "failed");
    assert.equal(cleanupStop.failureReason, "cleanup_failed");
  } finally {
    await stopProject(cleanupFailureId);
    await removeProjectFixture(cleanupFailureId);
    await rm(cleanupFailureDir, { recursive: true, force: true });
  }
  const installFailure = await saveProject({
    ...saved,
    id: "install_failure_registrytest_project_adapter",
    projectPath: ".",
    installCommand: "node -e \"process.exit(1)\"",
    startCommand: "node -e \"setTimeout(() => {}, 1000)\"",
    timeoutMs: 1000
  });
  const status = await startProject(installFailure.id);
  assert.equal(status.status, "failed");
  assert.equal(status.failureReason, "install_failed");
  const longInstall = await saveProject({
    ...saved,
    id: "install_stop_registrytest_project_adapter",
    projectPath: ".",
    installCommand: "node -e \"setTimeout(() => {}, 5000)\"",
    startCommand: "node -e \"setTimeout(() => {}, 1000)\"",
    timeoutMs: 10_000
  });
  const startPromise = startProject(longInstall.id);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const installing = getProjectRuntimeStatus(longInstall.id);
  assert.equal(installing.status, "installing");
  assert.equal(installing.phase, "installing_dependencies");
  assert.ok((installing.remainingMs ?? 0) > 0);
  assert.ok((installing.progressPercent ?? -1) >= 0);
  assert.ok(installing.pid);
  const stopped = await stopProject(longInstall.id);
  assert.equal(stopped.status, "stopped");
  const stoppedStart = await startPromise;
  assert.equal(stoppedStart.status, "failed");
  assert.equal(stoppedStart.failureReason, "install_failed");
  await withEnv({ API_TOKEN: "real-token" }, async () => {
    const redactedEnv = await saveProject({
      ...saved,
      id: "redacted_env_registrytest_project_adapter",
      projectPath: ".",
      env: { API_TOKEN: "should-not-overwrite-process-env" },
      installCommand: "node -e \"process.exit(process.env.API_TOKEN === 'real-token' ? 0 : 1)\"",
      startCommand: "node -e \"setTimeout(() => {}, 5000)\"",
      frontendUrl: "http://127.0.0.1:1",
      healthCheckUrl: undefined,
      backendUrl: undefined,
      timeoutMs: 1000
    });
    assert.equal(redactedEnv.env?.API_TOKEN, "[REDACTED]");
    const redactedStatus = await startProject(redactedEnv.id);
    assert.notEqual(redactedStatus.failureReason, "install_failed");
  });
  await removeProjectFixture(saved.id);
  await removeProjectFixture(external.id);
  await removeProjectFixture(installFailure.id);
  await removeProjectFixture(longInstall.id);
  await removeProjectFixture("redacted_env_registrytest_project_adapter");
  await removeProjectFixture("external_runtime_registrytest_project_adapter");
  await removeProjectFixture("multi_process_registrytest_project_adapter");
  await removeProjectFixture("restart_after_exit_registrytest_project_adapter");
  await removeProjectFixture("cleanup_failure_registrytest_project_adapter");
  await removeProjectFixture("runtime_target_registrytest_project_adapter");
}
