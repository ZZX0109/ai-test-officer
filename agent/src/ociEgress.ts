import { createEgressNetworkController, createIsolatedNetworkController, networkPolicyHash, runAllowlistedCommand, type EgressNetworkHandle } from "@ai-test-officer/execution-worker";
import type { ProjectConfig } from "./types.js";

const rootDir = process.cwd().endsWith("/agent") ? process.cwd().slice(0, -6) : process.cwd();
type OciNetworkController = ReturnType<typeof createEgressNetworkController> | ReturnType<typeof createIsolatedNetworkController>;
export type OciEgressLease = { controller: OciNetworkController; handle: EgressNetworkHandle };

export async function prepareOciEgress(project: ProjectConfig, context: { runId?: string; attemptId?: string }): Promise<OciEgressLease | undefined> {
  const manifest = project.manifest;
  if (!manifest || manifest.execution.mode !== "oci") return undefined;
  const runner = async (args: string[]) => {
    const result = await runAllowlistedCommand({ command: { executable: "docker", args, timeoutMs: 30_000 }, cwd: rootDir, env: {}, allowedExecutables: ["docker"], maxLogBytes: 8_000 });
    return { exitCode: result.exitCode ?? 1, stderr: result.stderr };
  };
  if (manifest.network.mode === "deny") {
    const controller = createIsolatedNetworkController({ run: runner });
    const handle = await controller.ensure({
      projectId: manifest.projectId,
      runId: context.runId ?? `project-bootstrap:${project.id}`,
      policyHash: networkPolicyHash(manifest.network)
    });
    return { controller, handle };
  }
  const proxyUrl = process.env.ATO_EGRESS_PROXY_URL;
  const proxyContainer = process.env.ATO_EGRESS_PROXY_CONTAINER_NAME;
  const policySecret = process.env.ATO_EGRESS_POLICY_SECRET;
  if (!proxyUrl) throw new Error("egress_proxy_not_configured");
  if (!proxyContainer) throw new Error("egress_proxy_container_not_configured");
  if (!policySecret) throw new Error("egress_policy_secret_not_configured");
  if (!manifest.network.allowedHosts.length) throw new Error("egress_allowed_hosts_missing");
  const controller = createEgressNetworkController({ run: runner });
  const handle = await controller.ensure({
    projectId: manifest.projectId,
    runId: context.runId ?? `project-bootstrap:${project.id}`,
    attemptId: context.attemptId ?? "bootstrap",
    policyHash: networkPolicyHash(manifest.network),
    allowedHosts: manifest.network.allowedHosts,
    allowedPorts: [80, 443],
    policySecret,
    proxyUrl,
    proxyContainer
  });
  return { controller, handle };
}
