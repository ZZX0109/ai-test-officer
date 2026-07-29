import { closeSync, openSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { environmentForNode, resolveSupportedNode } from "./node-runtime.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backgroundDir = path.join(rootDir, "reports", "background");
const pidFile = path.join(backgroundDir, "dev-supervisor.pid");
const logFile = path.join(backgroundDir, "dev-supervisor.stdout.log");
const supervisorScript = path.join(rootDir, "scripts", "dev-supervisor.mjs");
const supportedNode = resolveSupportedNode();
const serviceUrls = [
  process.env.AGENT_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4317"}/api/health`,
  process.env.APP_API_HEALTH_URL ?? `http://127.0.0.1:${process.env.APP_API_PORT ?? "6172"}/api/health`,
  process.env.APP_URL ?? `http://127.0.0.1:${process.env.APP_WEB_PORT ?? "6173"}`,
  process.env.WORKBENCH_URL ?? `http://127.0.0.1:${process.env.WORKBENCH_PORT ?? "6174"}`
];

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function existingSupervisorPid() {
  try {
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    return processIsAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function servicesAreHealthy() {
  const results = await Promise.all(serviceUrls.map(async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      return response.ok;
    } catch {
      return false;
    }
  }));
  return results.every(Boolean);
}

async function waitForServices(timeoutMs = Number(process.env.DEV_START_TIMEOUT_MS ?? 45_000)) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await servicesAreHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const log = await readFile(logFile, "utf8").catch(() => "");
  const tail = log.split(/\r?\n/).slice(-80).join("\n");
  throw new Error(`dev_services_not_ready_within_${timeoutMs}ms: inspect ${logFile}\n${tail}`);
}

await mkdir(backgroundDir, { recursive: true });
const existingPid = await existingSupervisorPid();
if (existingPid) {
  await waitForServices();
  console.log(JSON.stringify({ ok: true, alreadyRunning: true, pid: existingPid, logFile }, null, 2));
  process.exit(0);
}

const output = openSync(logFile, "a");
const supervisor = spawn(supportedNode.binary, [supervisorScript], {
  cwd: rootDir,
  detached: true,
  env: environmentForNode(supportedNode.binary, {
    ...process.env,
    HEADLESS: process.env.HEADLESS ?? "1"
  }),
  stdio: ["ignore", output, output]
});
supervisor.unref();
closeSync(output);

const deadline = Date.now() + 5_000;
let recordedPid;
while (Date.now() < deadline) {
  recordedPid = await existingSupervisorPid();
  if (recordedPid) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!recordedPid) {
  throw new Error(`dev_supervisor_failed_to_detach: inspect ${logFile}`);
}

try {
  await waitForServices();
} catch (error) {
  try {
    process.kill(recordedPid, "SIGTERM");
  } catch {
    // The supervisor already exited; the log tail in the thrown error is the
    // authoritative startup diagnostic.
  }
  throw error;
}

console.log(JSON.stringify({
  ok: true,
  alreadyRunning: false,
  pid: recordedPid,
  node: supportedNode.binary,
  logFile
}, null, 2));
