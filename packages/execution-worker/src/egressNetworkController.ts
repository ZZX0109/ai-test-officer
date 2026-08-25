import { createHash, createHmac } from "node:crypto";

export type ContainerEngine = "docker";

export interface EgressCommandRunner {
  (args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

export interface EgressNetworkHandle {
  name: string;
  created: boolean;
  proxyContainer?: string;
  proxyUrl?: string;
}

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 32) || "run";
}

export function buildRunScopedProxyUrl(baseUrl: string, metadata: { runId: string; attemptId: string; policyHash: string; allowedHosts?: string[]; allowedPorts?: number[]; secret?: string }) {
  const url = new URL(baseUrl);
  const payload = JSON.stringify({ runId: metadata.runId, attemptId: metadata.attemptId, policyHash: metadata.policyHash, allowedHosts: metadata.allowedHosts ?? [], allowedPorts: metadata.allowedPorts ?? [80, 443] });
  const signature = metadata.secret ? createHmac("sha256", metadata.secret).update(payload).digest("base64url") : "";
  const token = Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
  url.username = "ato";
  url.password = token;
  return url.toString().replace(/\/$/, "");
}

export function egressNetworkName(projectId: string, runId: string) {
  const suffix = createHash("sha256").update(`${projectId}:${runId}`).digest("hex").slice(0, 12);
  return `ato-egress-${safePart(projectId)}-${suffix}`.slice(0, 63);
}

/**
 * A deny-policy target still needs a private network interface for its
 * loopback-published browser port. Docker's literal `network=none` removes
 * that interface entirely, so `--publish 127.0.0.1:host:container` cannot be
 * reached by the Agent and a Browser run can never collect real evidence.
 * An internal bridge has no default external route, while retaining the
 * narrowly scoped host-side control channel.
 */
export function isolatedNetworkName(projectId: string, runId: string) {
  const suffix = createHash("sha256").update(`isolated:${projectId}:${runId}`).digest("hex").slice(0, 12);
  return `ato-isolated-${safePart(projectId)}-${suffix}`.slice(0, 63);
}

export function createEgressNetworkController(input: { run: EgressCommandRunner }) {
  return {
    async ensure(args: { projectId: string; runId: string; attemptId?: string; policyHash?: string; allowedHosts?: string[]; allowedPorts?: number[]; policySecret?: string; proxyUrl?: string; proxyContainer?: string }): Promise<EgressNetworkHandle> {
      const name = egressNetworkName(args.projectId, args.runId);
      const inspected = await input.run(["network", "inspect", name]);
      let created = false;
      if (inspected.exitCode !== 0) {
        const result = await input.run(["network", "create", "--driver", "bridge", "--attachable", "--label", "ai-test-officer.managed=true", "--label", `ai-test-officer.run-id=${args.runId}`, ...(args.policyHash ? ["--label", `ai-test-officer.policy-sha256=${args.policyHash}`] : []), name]);
        if (result.exitCode !== 0) {
          const raced = await input.run(["network", "inspect", name]);
          if (raced.exitCode !== 0) throw new Error(`egress_network_create_failed:${result.stderr ?? "unknown"}`);
        } else created = true;
      }
      if (args.proxyContainer) {
        const connected = await input.run(["network", "connect", name, args.proxyContainer]);
        const alreadyConnected = /already connected|already exists|endpoint.*exists/i.test(connected.stderr ?? "");
        if (connected.exitCode !== 0 && !alreadyConnected) {
          if (created) await input.run(["network", "rm", name]);
          throw new Error(`egress_proxy_attach_failed:${connected.stderr ?? "unknown"}`);
        }
      }
      return {
        name,
        created,
        proxyContainer: args.proxyContainer,
        proxyUrl: args.proxyUrl && args.attemptId && args.policyHash
          ? buildRunScopedProxyUrl(args.proxyUrl, { runId: args.runId, attemptId: args.attemptId, policyHash: args.policyHash, allowedHosts: args.allowedHosts, allowedPorts: args.allowedPorts, secret: args.policySecret })
          : args.proxyUrl
      };
    },
    async teardown(handle: EgressNetworkHandle) {
      if (handle.proxyContainer) await input.run(["network", "disconnect", handle.name, handle.proxyContainer]);
      if (handle.created) {
        const removed = await input.run(["network", "rm", handle.name]);
        if (removed.exitCode !== 0) throw new Error(`egress_network_remove_failed:${removed.stderr ?? "unknown"}`);
      }
    }
  };
}

export function createIsolatedNetworkController(input: { run: EgressCommandRunner }) {
  return {
    async ensure(args: { projectId: string; runId: string; policyHash?: string }): Promise<EgressNetworkHandle> {
      const name = isolatedNetworkName(args.projectId, args.runId);
      const inspected = await input.run(["network", "inspect", name]);
      let created = false;
      if (inspected.exitCode !== 0) {
        const result = await input.run([
          "network", "create", "--driver", "bridge", "--internal", "--attachable",
          "--label", "ai-test-officer.managed=true",
          "--label", "ai-test-officer.network-mode=deny",
          "--label", `ai-test-officer.run-id=${args.runId}`,
          ...(args.policyHash ? ["--label", `ai-test-officer.policy-sha256=${args.policyHash}`] : []),
          name
        ]);
        if (result.exitCode !== 0) {
          const raced = await input.run(["network", "inspect", name]);
          if (raced.exitCode !== 0) throw new Error(`isolated_network_create_failed:${result.stderr ?? "unknown"}`);
        } else created = true;
      }
      return { name, created };
    },
    async teardown(handle: EgressNetworkHandle) {
      if (!handle.created) return;
      const removed = await input.run(["network", "rm", handle.name]);
      if (removed.exitCode !== 0) throw new Error(`isolated_network_remove_failed:${removed.stderr ?? "unknown"}`);
    }
  };
}
