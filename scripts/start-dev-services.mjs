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

await mkdir(backgroundDir, { recursive: true });
const existingPid = await existingSupervisorPid();
if (existingPid) {
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

console.log(JSON.stringify({
  ok: true,
  alreadyRunning: false,
  pid: recordedPid,
  node: supportedNode.binary,
  logFile
}, null, 2));
