import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCurrentNodeSupported, environmentForNode } from "./node-runtime.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assertCurrentNodeSupported();
const childEnvironment = environmentForNode(process.execPath, {
  ...process.env,
  FORCE_COLOR: "1",
  HEADLESS: process.env.HEADLESS ?? "1"
});
const supervisorPidFile = path.join(rootDir, "reports", "background", "dev-supervisor.pid");
const services = [
  { id: "agent", args: ["run", "dev:agent"], healthUrl: "http://127.0.0.1:4317/api/health", restartOnConnectionRefused: true },
  { id: "app-api", args: ["--workspace", "app-under-test", "run", "dev:api"], healthUrl: "http://127.0.0.1:6172/api/health" },
  { id: "app-web", args: ["--workspace", "app-under-test", "run", "dev:web"], healthUrl: "http://127.0.0.1:6173" },
  { id: "workbench", args: ["run", "dev:workbench"], healthUrl: "http://127.0.0.1:6174" }
];
const children = new Map();
let shuttingDown = false;
let healthSweepInProgress = false;

function writePrefixed(stream, id, chunk) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line) stream.write(`[${id}] ${line}\n`);
  }
}

function startService(service) {
  if (shuttingDown) return;
  const child = spawn("npm", service.args, {
    cwd: rootDir,
    // Workbench owns the visual surface; managed Playwright must not open a
    // second foreground browser window.
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  const runtime = {
    child,
    startedAt: Date.now(),
    unhealthyChecks: 0,
    connectionRefusedChecks: 0,
    restartScheduled: false,
    terminating: false
  };
  children.set(service.id, runtime);
  console.log(`[supervisor] started ${service.id} pid=${child.pid}`);
  child.stdout.on("data", (chunk) => writePrefixed(process.stdout, service.id, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(process.stderr, service.id, chunk));
  const scheduleRestart = (reason) => {
    if (runtime.restartScheduled || shuttingDown) return;
    runtime.restartScheduled = true;
    children.delete(service.id);
    console.error(`[supervisor] ${service.id} ${reason}; restarting`);
    setTimeout(() => startService(service), 750);
  };
  child.once("error", (error) => {
    scheduleRestart(`failed to spawn (${error instanceof Error ? error.message : String(error)})`);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    scheduleRestart(`exited code=${code ?? "n/a"} signal=${signal ?? "n/a"}`);
  });
}

async function waitForHealthy(service, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (!shuttingDown && Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        console.log(`[supervisor] ${service.id} is ready`);
        return true;
      }
    } catch {
      // The service is still initializing.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error(`[supervisor] ${service.id} did not become ready within ${timeoutMs}ms`);
  return false;
}

function stopServiceProcess(child, signal = "SIGTERM") {
  // child.killed only means a signal was sent; the detached npm/tsx process
  // group may still be alive. exitCode/signalCode are the actual terminal
  // indicators and allow a later SIGKILL escalation.
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (typeof child.pid === "number") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

function connectionErrorCode(error) {
  if (!error || typeof error !== "object") return "";
  if ("code" in error && typeof error.code === "string") return error.code;
  const cause = "cause" in error ? error.cause : undefined;
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "";
}

function stopAll(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] stopping services (${signal})`);
  for (const { child } of children.values()) {
    stopServiceProcess(child);
  }
  void unlink(supervisorPidFile).catch(() => undefined);
  setTimeout(() => process.exit(0), 1_500).unref();
}

process.once("SIGINT", () => stopAll("SIGINT"));
process.once("SIGTERM", () => stopAll("SIGTERM"));
process.once("SIGHUP", () => stopAll("SIGHUP"));
process.once("uncaughtException", (error) => {
  console.error(error);
  stopAll("uncaughtException");
});

await mkdir(path.dirname(supervisorPidFile), { recursive: true });
await writeFile(supervisorPidFile, `${process.pid}\n`);
const backendServices = services.filter((service) => service.id === "agent" || service.id === "app-api");
const frontendServices = services.filter((service) => service.id !== "agent" && service.id !== "app-api");
for (const service of backendServices) startService(service);
await Promise.all(backendServices.map((service) => waitForHealthy(service)));
for (const service of frontendServices) startService(service);

setInterval(async () => {
  // Avoid overlapping sweeps. The old 2s interval could start another sweep
  // while a busy Agent was still answering the previous one, increment the
  // same counter several times, and terminate a healthy process during a
  // project launch.
  if (shuttingDown || healthSweepInProgress) return;
  healthSweepInProgress = true;
  try {
    for (const service of services) {
      const runtime = children.get(service.id);
      if (!runtime || Date.now() - runtime.startedAt < 30_000) continue;
      try {
        const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2_000) });
        runtime.unhealthyChecks = response.ok ? 0 : runtime.unhealthyChecks + 1;
        runtime.connectionRefusedChecks = 0;
      } catch (error) {
        runtime.unhealthyChecks += 1;
        runtime.connectionRefusedChecks = connectionErrorCode(error) === "ECONNREFUSED"
          ? runtime.connectionRefusedChecks + 1
          : 0;
      }
      if (runtime.unhealthyChecks < 4) continue;
      if (
        service.restartOnConnectionRefused
        && runtime.connectionRefusedChecks >= 4
        && !runtime.terminating
      ) {
        runtime.terminating = true;
        console.error(`[supervisor] ${service.id} has no TCP listener after ${runtime.connectionRefusedChecks} checks; restarting its process group`);
        stopServiceProcess(runtime.child);
        setTimeout(() => {
          if (children.get(service.id) !== runtime) return;
          console.error(`[supervisor] ${service.id} did not exit after SIGTERM; forcing process-group shutdown`);
          stopServiceProcess(runtime.child, "SIGKILL");
        }, 5_000).unref();
        continue;
      }
      // The local Agent uses a synchronous development SQLite backend. A
      // large audit/history read can temporarily delay HTTP health responses
      // while the process is still alive and making progress. Killing it here
      // caused the exact user-visible "flash exit" we are trying to prevent.
      // Real process exits are already restarted by the child exit handler.
      console.warn(`[supervisor] ${service.id} is temporarily busy after ${runtime.unhealthyChecks} health checks; keeping the live process`);
      runtime.unhealthyChecks = 0;
      runtime.connectionRefusedChecks = 0;
    }
  } finally {
    healthSweepInProgress = false;
  }
}, 3_000);
