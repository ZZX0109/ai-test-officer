// Red-team: malicious-OCI-image probe.
//
// Builds a malicious image (setuid binary + malicious ENTRYPOINT + host-escape
// binaries), runs the probe inside it with execution-worker's EXACT hardening
// flags (incl. --entrypoint /bin/sh -c, which overrides the image's malicious
// ENTRYPOINT), and asserts every image-based malicious vector is BLOCKED.
//
// Usage: node scripts/redteam-malicious-oci.mjs
// Requires: docker, node:22-bookworm-slim image (for the build base).
// Exits non-zero if ANY probe reports ESCAPED or a required vector is missing.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const fixtureDir = path.join(rootDir, "packages", "execution-worker", "tests", "redteam-fixtures", "malicious-image");
const reportDir = path.join(rootDir, "reports", "redteam");
mkdirSync(reportDir, { recursive: true });

const IMAGE = "redteam-malicious-oci:latest";
const CONTAINER = "ato-redteam-malicious-oci";

// The hardening flags MUST mirror execution-worker/src/index.ts buildOciInvocation:
// --read-only, --security-opt no-new-privileges, --cap-drop ALL, --user 65532:65532,
// --pids-limit, --memory/--memory-swap, --cpus, --network none, --tmpfs /tmp:noexec,
// AND --entrypoint /bin/sh -c (which overrides the image's malicious ENTRYPOINT).
const HARDENING_ARGS = [
  "run", "--rm", "--name", CONTAINER,
  "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
  "--user", "65532:65532",
  "--pids-limit", "256",
  "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
  "--network", "none",
  "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
  "--entrypoint", "/bin/sh",
  IMAGE, "-c", "node /probe-malicious.js"
];

const REQUIRED_VECTORS = [
  "malicious-image-setuid-escalation",
  "malicious-image-entrypoint-override",
  "malicious-image-mount-host",
  "malicious-image-read-docker-sock"
];

function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe", timeout: 8000 });
    return true;
  } catch { return false; }
}

function buildMaliciousImage() {
  // Build the malicious image from the fixture (the build runs as root, so the
  // setuid binary + the malicious ENTRYPOINT are baked in).
  execFileSync("docker", ["build", "-t", IMAGE, fixtureDir], { stdio: "inherit", timeout: 120000 });
}

function main() {
  if (!dockerAvailable()) {
    console.error("SKIP: docker not available — red-team malicious-OCI probe requires docker.");
    process.exit(0);
  }
  // Ensure the build base is present (do not pull — pulling would need network/registry).
  try {
    execFileSync("docker", ["image", "inspect", "node:22-bookworm-slim"], { stdio: "pipe", timeout: 8000 });
  } catch {
    console.error("SKIP: node:22-bookworm-slim not present locally (Docker Hub pull intentionally avoided).");
    process.exit(0);
  }

  buildMaliciousImage();
  execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });

  let output = "";
  try {
    output = execFileSync("docker", HARDENING_ARGS, { stdio: "pipe", timeout: 60000, maxBuffer: 1 << 20 }).toString();
  } catch (err) {
    output = (err.stdout ? err.stdout.toString() : "") + (err.stderr ? err.stderr.toString() : "");
  }

  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("REDTEAM_MALICIOUS_IMAGE_RESULTS_START"));
  const endIdx = lines.findIndex((l) => l.includes("REDTEAM_MALICIOUS_IMAGE_RESULTS_END"));
  if (startIdx === -1 || endIdx === -1) {
    console.error("FAIL: probe did not emit REDTEAM_MALICIOUS_IMAGE_RESULTS markers.");
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

  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: "1.0",
    generatedAt,
    image: IMAGE,
    scenario: "malicious-oci-image",
    description: "A malicious Docker image (setuid binary + malicious ENTRYPOINT + host-escape binaries) run with execution-worker's exact hardening flags. Asserts every image-based malicious vector is BLOCKED.",
    hardeningFlags: "read-only + no-new-privileges + cap-drop-ALL + user-65532 + pids-limit-256 + memory-512m + cpus-1 + network-none + tmpfs-/tmp-noexec + entrypoint-override(/bin/sh -c)",
    summary: {
      verdict: passed ? "PASS" : "FAIL",
      vectorsTotal: REQUIRED_VECTORS.length,
      blocked: blocked.length,
      escaped: escaped.length,
      missingVectors
    },
    results
  };
  const reportPath = path.join(reportDir, "malicious-oci-latest.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const md = [
    `# Red-Team: Malicious-OCI-Image Probe`,
    ``,
    `Generated: ${generatedAt}`,
    ``,
    `Builds a malicious Docker image (setuid binary + malicious ENTRYPOINT + host-escape binaries), runs the probe inside it with execution-worker's exact hardening flags (incl. \`--entrypoint /bin/sh -c\` which overrides the image's malicious ENTRYPOINT), and asserts every image-based malicious vector is BLOCKED.`,
    ``,
    `**Overall: ${passed ? "PASS" : "FAIL"}** — ${blocked.length}/${REQUIRED_VECTORS.length} vectors blocked, ${escaped.length} escaped, ${missingVectors.length} missing.`,
    ``,
    `| Vector | Verdict | Detail |`,
    `| --- | --- | --- |`,
    ...results.map((r) => `| ${r.vector} | ${r.verdict} | ${r.detail} |`),
    ...(missingVectors.length ? [``, `**Missing vectors:** ${missingVectors.join(", ")}`] : []),
    ``
  ].join("\n");
  writeFileSync(path.join(reportDir, "malicious-oci-latest.md"), md);

  console.log(`red-team malicious-oci: ${passed ? "PASS" : "FAIL"} (${blocked.length} blocked, ${escaped.length} escaped, ${missingVectors.length} missing)`);
  console.log(`report: ${reportPath}`);
  results.forEach((r) => console.log(`  ${r.verdict} | ${r.vector} | ${r.detail}`));
  process.exit(passed ? 0 : 1);
}

main();
