import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile } from "node:fs/promises";

const port = Number(process.env.PORT ?? 3128);
const allowedHosts = (process.env.ATO_EGRESS_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const allowedPorts = new Set((process.env.ATO_EGRESS_ALLOWED_PORTS ?? "80,443")
  .split(",").map((item) => Number(item.trim())).filter((item) => Number.isInteger(item) && item > 0 && item < 65536));

function audit(req, decision, host, detail = "") {
  const authorization = req.headers["proxy-authorization"];
  const encoded = typeof authorization === "string" && authorization.startsWith("Basic ")
    ? Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":")[1]
    : undefined;
  const policy = readPolicy(req);
  const runId = policy?.runId;
  const attemptId = policy?.attemptId;
  const policyHash = policy?.policyHash;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    runId: req.headers["x-ato-run-id"] ?? runId ?? "unknown",
    attemptId: req.headers["x-ato-attempt-id"] ?? attemptId ?? "unknown",
    policyHash: req.headers["x-ato-policy-sha256"] ?? policyHash ?? "unknown",
    method: req.method,
    host,
    decision,
    detail
  });
  process.stdout.write(`${line}\n`);
  if (process.env.ATO_EGRESS_AUDIT_FILE) void appendFile(process.env.ATO_EGRESS_AUDIT_FILE, `${line}\n`, { mode: 0o600 }).catch(() => undefined);
}

function readPolicy(req) {
  const authorization = req.headers["proxy-authorization"];
  if (typeof authorization !== "string" || !authorization.startsWith("Basic ")) return undefined;
  const encoded = Buffer.from(authorization.slice(6), "base64").toString("utf8").split(":")[1];
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf(".");
    const payload = decoded.slice(0, separator);
    const signature = decoded.slice(separator + 1);
    const expected = createHmac("sha256", process.env.ATO_EGRESS_POLICY_SECRET ?? "").update(payload).digest("base64url");
    if (!process.env.ATO_EGRESS_POLICY_SECRET || !signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed.allowedHosts) && Array.isArray(parsed.allowedPorts) ? parsed : undefined;
  } catch { return undefined; }
}

function allowed(host, policy) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  const hosts = policy?.allowedHosts ?? allowedHosts;
  return hosts.some((candidate) => candidate === normalized || (candidate.startsWith("*.") && normalized.endsWith(candidate.slice(1))));
}

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
      || a >= 224;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return privateAddress(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe80:")
    || normalized.startsWith("ff");
}

async function resolveSafe(host) {
  if (net.isIP(host)) {
    if (privateAddress(host)) throw new Error("private_address_denied");
    return host;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => privateAddress(record.address))) throw new Error("private_address_denied");
  return records[0].address;
}

function deny(req, response, host, status, detail) {
  audit(req, "denied", host, detail);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "egress_denied", detail }));
}

async function validate(req, host, port, response) {
  const policy = readPolicy(req);
  if (process.env.ATO_EGRESS_POLICY_SECRET && !policy) {
    deny(req, response, host, 403, "run_policy_missing_or_invalid");
    return false;
  }
  if (!host || !allowed(host, policy)) {
    deny(req, response, host, 403, "host_not_allowlisted");
    return false;
  }
  const ports = policy ? new Set(policy.allowedPorts) : allowedPorts;
  if (!ports.has(port)) {
    deny(req, response, host, 403, "port_not_allowlisted");
    return false;
  }
  try {
    await resolveSafe(host);
    audit(req, "allowed", host);
    return true;
  } catch (error) {
    deny(req, response, host, 403, error instanceof Error ? error.message : "dns_policy_denied");
    return false;
  }
}

function connectTarget(value) {
  const input = String(value ?? "");
  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0) return { host: input, port: NaN };
    return { host: input.slice(1, end), port: Number(input.slice(end + 1).replace(/^:/, "") || 443) };
  }
  const separator = input.lastIndexOf(":");
  return separator < 0 ? { host: input, port: 443 } : { host: input.slice(0, separator), port: Number(input.slice(separator + 1) || 443) };
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, allowedHosts: allowedHosts.length }));
    return;
  }
  let target;
  try { target = new URL(req.url ?? ""); } catch { deny(req, res, "", 400, "absolute_proxy_url_required"); return; }
  const host = target.hostname;
  const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (!await validate(req, host, targetPort, res)) return;
  const address = await resolveSafe(host).catch((error) => {
    deny(req, res, host, 403, error instanceof Error ? error.message : "dns_policy_denied");
    return undefined;
  });
  if (!address) return;
  const transport = target.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers.host;
  headers.host = target.host;
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: address,
    port: targetPort,
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers,
    ...(target.protocol === "https:" ? { servername: host } : {})
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(error.message);
  });
  req.pipe(upstream);
});

server.on("connect", async (req, client, head) => {
  const { host, port } = connectTarget(req.url);
  const policy = readPolicy(req);
  if (process.env.ATO_EGRESS_POLICY_SECRET && !policy) {
    audit(req, "denied", host, "run_policy_missing_or_invalid");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const ports = policy ? new Set(policy.allowedPorts) : allowedPorts;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !allowed(host, policy) || !ports.has(port)) {
    audit(req, "denied", host, "host_or_port_not_allowlisted");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  let address;
  try { address = await resolveSafe(host); } catch (error) {
    audit(req, "denied", host, error instanceof Error ? error.message : "dns_policy_denied");
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  audit(req, "allowed", host, `connect:${port}`);
  const upstream = net.connect(port, address, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`ato-egress-proxy listening on ${port}\n`));
