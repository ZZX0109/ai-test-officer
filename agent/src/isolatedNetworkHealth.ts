// Health probing for OCI sandboxes on the deny-mode `--internal` network.
//
// `docker network create --internal` (network.mode === "deny") is what makes a
// deny-mode sandbox safe — it has no external route — but it also blocks
// host->container reachability: a published port is never active and the
// container IP is unreachable from the host. A host-side `checkUrl` therefore
// always reports a healthy sandbox as dead. These helpers probe the health
// endpoint from *inside* the container (where the app serves on its own
// loopback) and locate the agent-managed container by its deterministic name
// prefix, so the --internal isolation is preserved while health monitoring
// still works.

import { spawn } from "node:child_process";
import type { ProjectConfig } from "./types.js";

type ExecOutput = { exitCode: number | null; stdout: string; stderr: string };

function captureExecOutput(executable: string, args: string[], timeoutMs = 5_000): Promise<ExecOutput> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: unknown) => `${current}${String(chunk)}`.slice(-512 * 1024);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    const done = (exitCode: number | null) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); };
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  });
}

/** Find the agent-managed container for a project by its `ato-<projectId>-` name prefix. */
export async function findOciContainerName(engine: string, manifestProjectId: string): Promise<string | undefined> {
  const prefix = `ato-${manifestProjectId}-`;
  const listed = await captureExecOutput(engine, ["ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"]);
  if (listed.exitCode !== 0) return undefined;
  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith(prefix));
}

/** Probe a URL from inside the container (its own loopback is reachable on --internal). */
export async function checkUrlViaContainer(engine: string, containerName: string, url: string | undefined, timeoutMs: number) {
  if (!url) return undefined;
  const deadline = Math.max(timeoutMs + 3_000, 8_000);
  // Node-based images (node 18+): use the global fetch.
  const nodeScript = `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(${timeoutMs})}).then(r=>{process.stdout.write(String(r.status));if(!r.ok)process.exit(2)}).catch(e=>{process.stderr.write(e instanceof Error?e.message:String(e));process.exit(1)})`;
  const nodeResult = await captureExecOutput(engine, ["exec", containerName, "node", "-e", nodeScript], deadline);
  const nodeCode = Number(nodeResult.stdout.trim());
  if (nodeResult.exitCode === 0 && nodeCode >= 200 && nodeCode < 400) return { ok: true, status: nodeCode, url };
  // Python-based images (no node, e.g. python:*-slim): use urllib. urlopen
  // raises HTTPError for 4xx/5xx and follows 3xx, so exit 0 with a 2xx-3xx
  // stdout code is the success signal; any failure exits non-zero.
  const pyScript = `import urllib.request; r=urllib.request.urlopen(${JSON.stringify(url)}, timeout=${Math.max(1, Math.floor(timeoutMs / 1000))}); print(r.status)`;
  const pyResult = await captureExecOutput(engine, ["exec", containerName, "python", "-c", pyScript], deadline);
  const pyCode = Number(pyResult.stdout.trim());
  if (pyResult.exitCode === 0 && pyCode >= 200 && pyCode < 400) return { ok: true, status: pyCode, url };
  return { ok: false, url, error: (nodeResult.stderr.trim() || pyResult.stderr.trim()) || `docker exec exit node=${nodeResult.exitCode} python=${pyResult.exitCode}` };
}

/**
 * Unified deny-mode health probe. Returns the in-container probe result when
 * the sandbox is a deny-mode OCI project with a running managed container that
 * serves its health endpoint; otherwise undefined. Callers fall back to this
 * before declaring a host-side health_timeout so a real running target is not
 * killed and not misreported as dead by the runtime status poller.
 */
export async function probeIsolatedSandboxHealth(project: ProjectConfig, timeoutMs: number) {
  if (project.manifest?.execution.mode !== "oci" || project.manifest?.network.mode !== "deny" || !project.healthCheckUrl) {
    return undefined;
  }
  const engine = project.manifest.execution.engine;
  const containerName = await findOciContainerName(engine, project.manifest.projectId);
  if (!containerName) return undefined;
  return checkUrlViaContainer(engine, containerName, project.healthCheckUrl, timeoutMs);
}
