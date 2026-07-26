import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisorPidFile = path.join(rootDir, "reports", "background", "dev-supervisor.pid");
const services = [
  { id: "agent", args: ["run", "dev:agent"], healthUrl: "http://127.0.0.1:4317/api/health" },
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
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      // Workbench owns the visual surface; managed Playwright must not open a
      // second foreground browser window.
      HEADLESS: process.env.HEADLESS ?? "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  children.set(service.id, { child, startedAt: Date.now(), unhealthyChecks: 0 });
  console.log(`[supervisor] started ${service.id} pid=${child.pid}`);
  child.stdout.on("data", (chunk) => writePrefixed(process.stdout, service.id, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(process.stderr, service.id, chunk));
  child.once("exit", (code, signal) => {
    children.delete(service.id);
    if (shuttingDown) return;
    console.error(`[supervisor] ${service.id} exited code=${code ?? "n/a"} signal=${signal ?? "n/a"}; restarting`);
    setTimeout(() => startService(service), 750);
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
  if (child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
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
      } catch {
        runtime.unhealthyChecks += 1;
      }
      if (runtime.unhealthyChecks < 4) continue;
      // The local Agent uses a synchronous development SQLite backend. A
      // large audit/history read can temporarily delay HTTP health responses
      // while the process is still alive and making progress. Killing it here
      // caused the exact user-visible "flash exit" we are trying to prevent.
      // Real process exits are already restarted by the child exit handler.
      console.warn(`[supervisor] ${service.id} is temporarily busy after ${runtime.unhealthyChecks} health checks; keeping the live process`);
      runtime.unhealthyChecks = 0;
    }
  } finally {
    healthSweepInProgress = false;
  }
}, 3_000);
