import { isIP } from "node:net";
import type { ProjectConfig } from "./types.js";

type OciRuntimeContainer = { engine: "docker"; containerName: string };
type DockerInspect = (engine: "docker", args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

function replaceUrlHost(value: string | undefined, host: string) {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.hostname = host;
    return parsed.toString();
  } catch {
    return value;
  }
}

/**
 * Resolves the private address of a deny-policy OCI target for the Agent's
 * control plane. An internal Docker bridge has no external route, but the
 * Agent needs this address to collect browser evidence without relying on a
 * host-published port that may be unreachable from a Docker-socket client.
 */
export async function projectWithIsolatedRuntimeUrls(input: {
  project: ProjectConfig;
  containers: readonly OciRuntimeContainer[];
  networkName?: string;
  inspect: DockerInspect;
}) {
  const { project, containers, networkName, inspect } = input;
  if (project.manifest?.execution.mode !== "oci" || project.manifest.network.mode !== "deny" || !networkName || containers.length !== 1) {
    return project;
  }
  const container = containers[0];
  const inspectArgs = ["inspect", "--format", `{{with index .NetworkSettings.Networks \"${networkName}\"}}{{.IPAddress}}{{end}}`, container.containerName];
  // `docker run` returns a client process before the daemon necessarily makes
  // the named container inspectable. Retry this short registration window so
  // a legitimate isolated address never falls back to the host publication.
  let host = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const address = await inspect(container.engine, inspectArgs, 1_000).catch(() => ({ stdout: "" }));
    host = address.stdout.trim();
    if (isIP(host)) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (!isIP(host)) return project;
  return {
    ...project,
    frontendUrl: replaceUrlHost(project.frontendUrl, host) ?? project.frontendUrl,
    backendUrl: replaceUrlHost(project.backendUrl, host) ?? project.backendUrl,
    healthCheckUrl: replaceUrlHost(project.healthCheckUrl, host) ?? project.healthCheckUrl,
    processes: project.processes?.map((processConfig) => ({
      ...processConfig,
      healthCheckUrl: replaceUrlHost(processConfig.healthCheckUrl, host)
    }))
  };
}
