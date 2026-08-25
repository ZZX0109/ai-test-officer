// Red-team: sandbox-escape probes.
//
// Runs the malicious probe project inside a container with the exact
// hardening flags execution-worker/src/index.ts applies, then asserts every
// escape vector is BLOCKED. This is the E2E complement to worker.test.ts
// (which only checks the docker-run *args*): here a real malicious payload
// actually attempts to escape and we verify it cannot.
//
// Usage: node scripts/redteam-sandbox-escape.mjs
// Requires: docker, node:22-bookworm-slim image.
// Exits non-zero if ANY probe reports ESCAPED or a required vector is missing.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const fixtureDir = path.join(rootDir, "packages", "execution-worker", "tests", "redteam-fixtures");
const reportDir = path.join(rootDir, "reports", "redteam");
mkdirSync(reportDir, { recursive: true });

const IMAGE = "node:22-bookworm-slim";
const CONTAINER = "ato-redteam-escape-probe";

// The hardening flags MUST mirror execution-worker/src/index.ts
// (--read-only, --security-opt no-new-privileges, --cap-drop ALL,
// --user 65532:65532, --pids-limit, --memory/--memory-swap, --cpus,
// --network none, --tmpfs /tmp:noexec, --tmpfs /workspace). Verified by
// keeping them adjacent to the source's runSandbox arg builder.
const HARDENING_ARGS = [
  "run", "--rm", "--name", CONTAINER,
  "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
  "--user", "65532:65532",
  "--pids-limit", "256",
  "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
  "--network", "none",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
  "-v", `${fixtureDir}:/workspace:ro`,
  "-w", "/workspace",
  IMAGE, "node", "probe.js"
];

const REQUIRED_VECTORS = [
  "cloud-metadata-169.254.169.254",
  "docker-sock-var-run",
  "host-fs-users",
  "host-fs-root-home",
  "host-etc-shadow",
  "symlink-escape-host-secret",
  "write-etc-escape",
  "tmp-noexec-binary",
  "non-root-uid",
  "disk-log-explosion-tmpfs-cap",
  "pid-flood-cap",
  "memory-bomb-cgroup-cap"
];

function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 8000 });
    return true;
  } catch { return false; }
}

function main() {
  if (!dockerAvailable()) {
    console.error("SKIP: docker not available — red-team sandbox-escape probe requires docker + the node image.");
    process.exit(0);
  }
  // Ensure the image is present (do not pull — pulling would need network/registry).
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "pipe", timeout: 8000 });
  } catch {
    console.error(`SKIP: image ${IMAGE} not present locally (Docker Hub pull intentionally avoided).`);
    process.exit(0);
  }

  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  let output = "";
  try {
    output = execFileSync("docker", HARDENING_ARGS, { stdio: "pipe", timeout: 60000, maxBuffer: 1 << 20 }).toString();
  } catch (err) {
    output = (err.stdout ? err.stdout.toString() : "") + (err.stderr ? err.stderr.toString() : "");
  }

  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("REDTEAM_PROBE_RESULTS_START"));
  const endIdx = lines.findIndex((l) => l.includes("REDTEAM_PROBE_RESULTS_END"));
  if (startIdx === -1 || endIdx === -1) {
    console.error("FAIL: probe did not emit REDTEAM_PROBE_RESULTS markers.");
    console.error(output.slice(-800));
    process.exit(1);
  }
  const resultLines = lines.slice(startIdx + 1, endIdx).filter((l) => l.trim());
  const results = resultLines.map((l) => {
    const parts = l.split("|");
    const verdict = (parts[0] ?? "").trim();
    const vector = (parts[1] ?? "").trim();
    const detail = (parts.slice(2).join("|")).trim();
    return { verdict, vector, detail };
  }).filter((r) => r.verdict && r.vector);

  const escaped = results.filter((r) => r.verdict === "ESCAPED");
  const blocked = results.filter((r) => r.verdict === "BLOCKED");
  const coveredVectors = new Set(results.map((r) => r.vector));
  const missingVectors = REQUIRED_VECTORS.filter((v) => !coveredVectors.has(v));

  const passed = escaped.length === 0 && missingVectors.length === 0;

  // Report
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: "1.0",
    generatedAt,
    image: IMAGE,
    hardeningFlags: "read-only + no-new-privileges + cap-drop-ALL + user-65532 + pids-limit-256 + memory-512m + cpus-1 + network-none + tmpfs-/tmp-noexec + tmpfs-/workspace",
    summary: {
      verdict: passed ? "PASS" : "FAIL",
      vectorsTotal: REQUIRED_VECTORS.length,
      blocked: blocked.length,
      escaped: escaped.length,
      missingVectors
    },
    results
  };
  const reportPath = path.join(reportDir, "sandbox-escape-latest.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const md = [
    `# Red-Team: Sandbox-Escape Probe`,
    ``,
    `Generated: ${generatedAt}`,
    ``,
    `Runs a malicious probe project inside a container with execution-worker's exact hardening flags and asserts every escape vector is BLOCKED. This is the E2E complement to \`worker.test.ts\` (which checks the docker-run *args*); here a real payload actually attempts to escape.`,
    ``,
    `**Overall: ${passed ? "PASS" : "FAIL"}** — ${blocked.length}/${REQUIRED_VECTORS.length} vectors blocked, ${escaped.length} escaped, ${missingVectors.length} missing.`,
    ``,
    `| Vector | Verdict | Detail |`,
    `| --- | --- | --- |`,
    ...results.map((r) => `| ${r.vector} | ${r.verdict} | ${r.detail} |`),
    ...(missingVectors.length ? [``, `**Missing vectors:** ${missingVectors.join(", ")}`] : []),
    ``
  ].join("\n");
  writeFileSync(path.join(reportDir, "sandbox-escape-latest.md"), md);

  console.log(`red-team sandbox-escape: ${passed ? "PASS" : "FAIL"} (${blocked.length} blocked, ${escaped.length} escaped, ${missingVectors.length} missing)`);
  console.log(`report: ${reportPath}`);
  results.forEach((r) => console.log(`  ${r.verdict} | ${r.vector} | ${r.detail}`));
  process.exit(passed ? 0 : 1);
}

main();
