import { createServer } from "node:net";
import type { ProjectConfig } from "./types.js";

export function portFromUrl(value?: string) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

export function replaceUrlPort(value: string | undefined, hostPort: number) {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.protocol = "http:";
    parsed.hostname = "127.0.0.1";
    parsed.port = String(hostPort);
    return parsed.toString();
  } catch {
    return value;
  }
}

async function allocateLoopbackPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error
        ? reject(error)
        : port
          ? resolve(port)
          : reject(new Error("loopback_port_unavailable")));
    });
  });
}

/** Allocates unique loopback publications for an OCI target's declared URLs. */
export async function projectWithSandboxRuntimeUrls(project: ProjectConfig) {
  if (project.manifest?.execution.mode !== "oci") {
    return {
      project,
      containerPortFor: (_url?: string) => undefined,
      portBindings: [] as Array<{ hostPort: number; containerPort: number }>
    };
  }
  const hostPorts = new Map<number, number>();
  const bridgeUrl = async (url?: string) => {
    const containerPort = portFromUrl(url);
    if (!url || !containerPort) return url;
    let hostPort = hostPorts.get(containerPort);
    if (!hostPort) {
      hostPort = await allocateLoopbackPort();
      hostPorts.set(containerPort, hostPort);
    }
    return replaceUrlPort(url, hostPort);
  };
  return {
    project: {
      ...project,
      frontendUrl: await bridgeUrl(project.frontendUrl) ?? project.frontendUrl,
      backendUrl: await bridgeUrl(project.backendUrl) ?? project.backendUrl,
      healthCheckUrl: await bridgeUrl(project.healthCheckUrl) ?? project.healthCheckUrl,
      processes: project.processes
        ? await Promise.all(project.processes.map(async (processConfig) => ({
          ...processConfig,
          healthCheckUrl: await bridgeUrl(processConfig.healthCheckUrl)
        })))
        : project.processes
    },
    containerPortFor: (url?: string) => portFromUrl(url),
    portBindings: [...hostPorts.entries()].map(([containerPort, hostPort]) => ({ hostPort, containerPort }))
  };
}
