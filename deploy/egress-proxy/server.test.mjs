import assert from "node:assert/strict";
import { request } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHmac } from "node:crypto";

const port = 31999;
const child = spawn(process.execPath, [path.join(import.meta.dirname, "server.mjs")], {
  env: { ...process.env, PORT: String(port), ATO_EGRESS_ALLOWED_HOSTS: "example.com", ATO_EGRESS_ALLOWED_PORTS: "80,443", ATO_EGRESS_POLICY_SECRET: "test-secret" },
  stdio: "ignore"
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function get(options) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, ...options }, (res) => {
      res.resume();
      res.once("end", () => resolve(res));
    });
    req.once("error", reject);
    req.end();
  });
}
try {
  await wait(150);
  assert.equal((await get({ path: "/healthz" })).statusCode, 200);
  assert.equal((await get({ path: "http://not-allowed.test/" })).statusCode, 403);
  assert.equal((await get({ path: "http://example.com:8080/" })).statusCode, 403);
  const payload = JSON.stringify({ runId: "run-1", attemptId: "attempt-1", policyHash: "a".repeat(64), allowedHosts: ["api.example.com"], allowedPorts: [80] });
  const signature = createHmac("sha256", "test-secret").update(payload).digest("base64url");
  const token = Buffer.from(`${payload}.${signature}`).toString("base64url");
  assert.equal((await get({ path: "http://example.com/", headers: { "proxy-authorization": `Basic ${Buffer.from(`ato:${token}`).toString("base64")}` } })).statusCode, 403);
  console.log("egress proxy tests passed");
} finally {
  child.kill("SIGTERM");
}
