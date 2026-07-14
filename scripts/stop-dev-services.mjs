import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ports = [
  Number(process.env.PORT ?? 4317),
  Number(process.env.APP_API_PORT ?? 6172),
  Number(process.env.APP_WEB_PORT ?? 6173),
  Number(process.env.WORKBENCH_PORT ?? 6174)
];

async function pidsForPort(port) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"]);
    return stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const stopped = [];
for (const port of ports) {
  const pids = await pidsForPort(port);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      stopped.push({ port, pid: Number(pid), signal: "SIGTERM" });
    } catch {
      // Process may have exited between lsof and kill.
    }
  }
}

await new Promise((resolve) => setTimeout(resolve, 800));

for (const port of ports) {
  const pids = await pidsForPort(port);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGKILL");
      stopped.push({ port, pid: Number(pid), signal: "SIGKILL" });
    } catch {
      // Already stopped.
    }
  }
}

console.log(JSON.stringify({ ok: true, stopped }, null, 2));
