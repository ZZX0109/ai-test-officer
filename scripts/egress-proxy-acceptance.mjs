import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const compose = path.join(root, "deploy", "egress-proxy", "compose.yml");
const project = `ato-egress-acceptance-${randomUUID().slice(0, 8)}`;
const network = `ato-egress-${project.slice(-8)}`;
const policySecret = `acceptance-${randomUUID()}`;
const env = { ...process.env, ATO_EGRESS_ALLOWED_HOSTS: "example.com", ATO_EGRESS_ALLOWED_PORTS: "80,443", ATO_EGRESS_POLICY_SECRET: policySecret, ATO_EGRESS_NETWORK_NAME: network };
function composeInvocation() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return { executable: "docker", prefix: ["compose"], supportsWait: true };
  } catch {
    try {
      execFileSync("docker-compose", ["version"], { stdio: "ignore" });
      return { executable: "docker-compose", prefix: [], supportsWait: false };
    } catch {
      return undefined;
    }
  }
}
const composeCli = composeInvocation();
const composeRun = (args, options = {}) => {
  if (!composeCli) throw new Error("docker_compose_unavailable");
  return execFileSync(composeCli.executable, [...composeCli.prefix, "-p", project, "-f", compose, ...args], { cwd: root, env, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
};
const curl = (args) => execFileSync("docker", ["run", "--rm", "--network", network, "curlimages/curl:8.10.1", ...args], { env, cwd: root, encoding: "utf8" });
function waitForProxyHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (curl(["-fsS", "http://egress-proxy:3128/healthz"]).includes("\"ok\":true")) return;
    } catch (error) {
      lastError = error;
    }
    execFileSync("sleep", ["1"]);
  }
  throw lastError instanceof Error ? lastError : new Error("proxy_health_timeout");
}
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error("egress_proxy_acceptance_blocked:docker_runtime_unavailable:install_or_start_docker_desktop");
  process.exit(2);
}
if (!composeCli) {
  console.error("egress_proxy_acceptance_blocked:docker_compose_unavailable:install_docker_compose");
  process.exit(2);
}
try {
  composeRun(["up", "-d", "--build", ...(composeCli.supportsWait ? ["--wait"] : [])]);
  waitForProxyHealth();
  try { curl(["-fsS", "-x", "http://egress-proxy:3128", "http://not-allowed.test/"]); throw new Error("unauthorized_host_not_blocked"); } catch (error) {
    if (error instanceof Error && error.message === "unauthorized_host_not_blocked") throw error;
  }
  const policyToken = (allowedHosts, allowedPorts = [80]) => {
    const payload = JSON.stringify({ runId: "run-egress-acceptance", attemptId: "attempt-1", policyHash: "a".repeat(64), allowedHosts, allowedPorts });
    const signature = createHmac("sha256", policySecret).update(payload).digest("base64url");
    return Buffer.from(`${payload}.${signature}`).toString("base64url");
  };
  const allowedToken = policyToken(["example.com"], [80, 443]);
  const allowedHeader = `Basic ${Buffer.from(`ato:${allowedToken}`).toString("base64")}`;
  const allowedStatus = curl(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-x", "http://egress-proxy:3128", "--proxy-header", `Proxy-Authorization: ${allowedHeader}`, "http://example.com/"]).trim();
  if (allowedStatus === "403") throw new Error("allowlisted_host_blocked");
  const connectStatus = curl(["-k", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "-x", "http://egress-proxy:3128", "--proxy-header", `Proxy-Authorization: ${allowedHeader}`, "https://example.com/"]).trim();
  if (connectStatus === "403" || connectStatus === "000") throw new Error(`connect_tunnel_failed:${connectStatus}`);
  const privateToken = policyToken(["localhost"], [3128]);
  const privateStatus = curl(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-x", "http://egress-proxy:3128", "--proxy-header", `Proxy-Authorization: Basic ${Buffer.from(`ato:${privateToken}`).toString("base64")}`, "http://localhost:3128/healthz"]).trim();
  if (privateStatus !== "403") throw new Error(`private_address_not_blocked:${privateStatus}`);
  const dynamicToken = policyToken(["not-example.test"]);
  const dynamicStatus = curl(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-x", "http://egress-proxy:3128", "--proxy-header", `Proxy-Authorization: Basic ${Buffer.from(`ato:${dynamicToken}`).toString("base64")}`, "http://example.com/"]).trim();
  if (dynamicStatus !== "403") throw new Error(`dynamic_policy_not_enforced:${dynamicStatus}`);
  composeRun(["restart", "egress-proxy"]);
  waitForProxyHealth();
  const postRestartStatus = curl(["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-x", "http://egress-proxy:3128", "--proxy-header", `Proxy-Authorization: ${allowedHeader}`, "http://example.com/"]).trim();
  if (postRestartStatus === "403" || postRestartStatus === "000") throw new Error(`post_restart_policy_request_failed:${postRestartStatus}`);
  const audit = composeRun(["exec", "-T", "egress-proxy", "sh", "-c", "test -s /var/log/ato/egress.jsonl && grep -q 'run-egress-acceptance' /var/log/ato/egress.jsonl && grep -q 'attempt-1' /var/log/ato/egress.jsonl"], { capture: true });
  if (audit === undefined) throw new Error("egress_audit_missing");
  console.log("egress proxy docker acceptance passed");
} finally {
  try { composeRun(["down", "--volumes", "--remove-orphans"]); } catch { /* preserve original failure */ }
}
