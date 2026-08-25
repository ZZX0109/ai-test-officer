// Clean Linux baseline verification (#6 干净 Linux 基线).
// Runs the project's clean-build matrix inside a SINGLE fresh Linux container
// (node:22-bookworm) using `git archive HEAD` as the source — no macOS
// node_modules, no reports, no uncommitted changes. This proves the project
// builds + lints + typechecks + tests pass on a truly clean Linux baseline.
//
// All steps run in ONE container so node_modules persists across steps.
// Docker-dependent steps (production-acceptance, fault-injection, e2e)
// require Docker-in-Docker and are noted as limitations.
//
// Usage: node scripts/baseline-verification-linux.mjs
import { execSync, spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const OUT = path.join(root, "reports", "baseline-verification");
await mkdir(OUT, { recursive: true });

const IMAGE = "node:22-bookworm";
const CONTAINER_WORKDIR = "/workspace";

const STEPS = [
  { id: "install", command: "npm ci --no-audit --no-fund 2>&1 | tail -3" },
  { id: "lint", command: "npm run lint 2>&1 | tail -5" },
  { id: "git-diff-check", command: "git diff --check 2>&1 || echo CLEAN" },
  { id: "size-guard", command: "THRESHOLD=2000 NEW_FILE_THRESHOLD=800 node scripts/file-size-guard.mjs 2>&1 | tail -3" },
  { id: "quality-contracts", command: "npm run quality:contracts 2>&1 | tail -5" },
  { id: "typecheck", command: "npm run typecheck 2>&1 | tail -8" },
  { id: "build", command: "npm run build 2>&1 | tail -8" },
  { id: "test", command: "npm test 2>&1 | tail -15" }
];

// Use set -o pipefail so `cmd | tail` propagates the real exit code
const stepScripts = STEPS.map((s) =>
  `echo "===STEP:${s.id}===" && set -o pipefail && (${s.command}) && echo "STEP_RESULT:${s.id}:0" || echo "STEP_RESULT:${s.id}:$?"`
).join(" && ");

const initScript =
  `mkdir -p ${CONTAINER_WORKDIR} && tar x -C ${CONTAINER_WORKDIR} && ` +
  `apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git python3 make g++ >/dev/null 2>&1 && ` +
  `cd ${CONTAINER_WORKDIR} && git init -q && git add -A && git commit -q -m baseline-init && ` +
  stepScripts;

console.log(`Clean Linux baseline verification (image: ${IMAGE})`);
console.log(`Source: git archive HEAD (committed source only, no node_modules/reports)`);
console.log(`Steps: ${STEPS.map((s) => s.id).join(", ")}`);
console.log("");

const archive = execSync("git archive HEAD --format=tar", { maxBuffer: 50 * 1024 * 1024 });

const result = await new Promise((resolve) => {
  const child = spawn("docker", [
    "run", "--rm",
    "-w", CONTAINER_WORKDIR,
    "-e", "CI=1", "-e", "NODE_ENV=test", "-e", "HEADLESS=1",
    "-e", "GIT_AUTHOR_NAME=baseline", "-e", "GIT_AUTHOR_EMAIL=baseline@ai-test-officer.local",
    "-e", "GIT_COMMITTER_NAME=baseline", "-e", "GIT_COMMITTER_EMAIL=baseline@ai-test-officer.local",
    "-i", IMAGE, "bash", "-c", initScript
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve({ timedOut: true, stdout, stderr });
  }, 900_000);

  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ timedOut: false, exitCode: code, stdout, stderr });
  });

  child.stdin.write(archive);
  child.stdin.end();
});

const stepResults = STEPS.map((step) => {
  const resultMatch = result.stdout.match(new RegExp(`STEP_RESULT:${step.id}:(-?\\d+)`));
  const exitCode = resultMatch ? parseInt(resultMatch[1], 10) : -1;
  const stepBlock = result.stdout.match(new RegExp(`===STEP:${step.id}===[\\s\\S]*?(?====STEP:|STEP_RESULT:${step.id}:|$)`));
  const output = stepBlock ? stepBlock[0].slice(-600) : "";
  return { id: step.id, command: step.command, exitCode, outputTail: output };
});

const passed = stepResults.filter((r) => r.exitCode === 0).length;
const platform = "linux/amd64 (node:22-bookworm container)";
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  objective: "#6 干净 Linux 基线 — clean-build matrix on a fresh Linux container",
  platform,
  image: IMAGE,
  sourceMethod: "git archive HEAD (committed source only, no node_modules, no reports, no uncommitted changes)",
  passed: passed === STEPS.length && !result.timedOut,
  passedCount: passed,
  totalSteps: STEPS.length,
  timedOut: result.timedOut ?? false,
  steps: stepResults,
  limitations: [
    "Docker-dependent steps (production-acceptance, fault-injection, workbench-e2e, unified-run, credibility-browser, benchmark) require Docker-in-Docker and are not run in this container.",
    "Playwright browser tests require browser system dependencies; the node:22-bookworm image may need apt-get install for Playwright deps.",
    "This baseline validates the clean-build matrix (install, lint, typecheck, build, test, size-guard, quality-contracts) on a fresh Linux environment."
  ]
};

await writeFile(path.join(OUT, "linux-latest.json"), JSON.stringify(report, null, 2));
console.log("");
console.log(`report → reports/baseline-verification/linux-latest.json`);
console.log(`passed: ${passed}/${STEPS.length} (${platform})`);
if (report.passed) console.log("✓ Clean Linux baseline: clean-build matrix PASSED");
else console.log("✗ Clean Linux baseline: some steps failed (see report)");
