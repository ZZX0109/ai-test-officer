import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const reportDir = path.join(rootDir, "reports", "baseline-verification");
const reportJson = path.join(reportDir, "latest.json");
const reportMarkdown = path.join(reportDir, "latest.md");
const canonicalReportMarkdown = path.join(reportDir, "baseline-verification-report.md");

const commands = [
  { id: "install", command: "npm", args: ["ci"] },
  // A fresh Linux runner also needs the OS libraries required by Chromium.
  // Keeping this in the baseline makes browser acceptance reproducible rather
  // than depending on a pre-baked CI image or a developer workstation.
  { id: "playwright", command: "node", args: ["scripts/install-playwright-chromium.mjs"] },
  { id: "lint", command: "npm", args: ["run", "lint"] },
  { id: "git-diff-check", command: "git", args: ["diff", "--check"] },
  { id: "acceptance-lock", command: "npm", args: ["run", "acceptance:lock:verify"] },
  { id: "size-guard", command: "npm", args: ["run", "size-guard"] },
  { id: "quality-contracts", command: "npm", args: ["run", "quality:contracts"] },
  { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { id: "test", command: "npm", args: ["test"] },
  { id: "build", command: "npm", args: ["run", "build"] },
  // Workbench E2E is a true browser/proxy check. Start the same supervised
  // local stack used by CI instead of relying on an accidental developer
  // process already listening on 6174.
  { id: "start-dev-services", command: "npm", args: ["run", "dev:background"] },
  { id: "health-check", command: "npm", args: ["run", "health:check"] },
  { id: "workbench-e2e", command: "npm", args: ["run", "test:workbench-e2e"] },
  { id: "unified-run", command: "npm", args: ["run", "test:unified-run"] },
  { id: "credibility-browser", command: "npm", args: ["run", "test:credibility-browser"] },
  { id: "judge-eval", command: "npm", args: ["run", "judge:eval"] },
  { id: "benchmark-run", command: "npm", args: ["run", "benchmark:run"] },
  { id: "benchmark-evaluate", command: "npm", args: ["run", "benchmark:evaluate"] },
  { id: "egress-proxy-unit", command: "npm", args: ["run", "test:egress-proxy"] },
  { id: "egress-proxy-acceptance", command: "npm", args: ["run", "acceptance:egress-proxy"] },
  { id: "external-project-smoke", command: "npm", args: ["--workspace", "@ai-test-officer/agent", "test"], env: { RUN_EXTERNAL_PROJECT_SMOKE: "1" } },
  { id: "production-acceptance", command: "npm", args: ["run", "acceptance:production"] },
  { id: "fault-injection-audit", command: "npm", args: ["run", "fault:injection:audit"] }
];

function redact(value) {
  return value
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_TOKEN]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)[A-Z0-9_]*=)[^\s]+/g, "$1[REDACTED]");
}

function gitStatus() {
  return new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: rootDir });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output: output.trim() }));
    child.on("error", (error) => resolve({ exitCode: 1, output: String(error) }));
  });
}

function run(command) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command.command, command.args, {
      cwd: rootDir,
      env: { ...process.env, ...command.env, CI: process.env.CI ?? "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk) => {
      output += String(chunk);
      if (output.length > 240_000) output = output.slice(-240_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code, signal) => resolve({
      ...command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: code ?? 1,
      signal: signal ?? undefined,
      output: redact(output)
    }));
    child.on("error", (error) => resolve({
      ...command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      output: redact(String(error))
    }));
  });
}

function selectedCommands() {
  const only = process.env.BASELINE_ONLY?.split(",").map((value) => value.trim()).filter(Boolean);
  if (!only?.length) return commands;
  const selected = commands.filter((item) => only.includes(item.id));
  if (selected.length !== only.length) {
    const known = new Set(commands.map((item) => item.id));
    throw new Error(`Unknown BASELINE_ONLY command: ${only.filter((id) => !known.has(id)).join(",")}`);
  }
  return selected;
}

function markdown(report) {
  const rows = report.commands.map((item) => `| ${item.id} | ${item.exitCode === 0 ? "pass" : "fail"} | ${item.startedAt} | ${item.finishedAt} |`).join("\n");
  return `# Baseline Verification\n\nGenerated: ${report.generatedAt}\n\n` +
    `This report records commands executed from a clean-install-oriented baseline runner. It does not turn fixture results into external-project generalization claims. A passing report requires a clean worktree both before and after the run; this script cannot claim a fresh Linux runner when it was executed on another platform.\n\n` +
    `Runner: \`${report.node}\` on \`${report.platform}\`\n\n` +
    `Clean worktree before: **${report.cleanWorktreeBefore ? "yes" : "no"}**  \nClean worktree after: **${report.cleanWorktreeAfter ? "yes" : "no"}**\n\n` +
    `Overall: **${report.passed ? "PASS" : "FAIL"}**\n\n` +
    `| Command | Result | Started | Finished |\n| --- | --- | --- | --- |\n${rows}\n\n` +
    `## Worktree\n\nBefore:\n\n\`\`\`\n${report.gitBefore.output || "clean"}\n\`\`\`\n\nAfter:\n\n\`\`\`\n${report.gitAfter.output || "clean"}\n\`\`\`\n`;
}

await mkdir(reportDir, { recursive: true });
// Keep browsers inside the ignored baseline report directory so every command
// in this disposable runner sees the exact browser installed by the prior
// step. The default /root cache is lost when a CI substep uses a new container.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(reportDir, "playwright-browsers");
const gitBefore = await gitStatus();
const results = [];
const selected = selectedCommands();
let ownsDevServices = false;
try {
  for (const command of selected) {
    console.log(`\n==> ${command.id}: ${command.command} ${command.args.join(" ")}`);
    const result = await run(command);
    results.push(result);
    if (command.id === "start-dev-services" && result.exitCode === 0) {
      try {
        // npm prefixes a script's JSON payload with its own command banner.
        // The launcher emits one JSON object as its final line, so parse that
        // line instead of treating the complete npm output as JSON.
        const startupLine = result.output.trim().split("\n").findLast((line) => line.trim().startsWith("{"));
        const startup = JSON.parse(startupLine ?? "");
        ownsDevServices = startup && typeof startup === "object" && startup.alreadyRunning === false;
      } catch {
        // A malformed launcher response is not evidence of ownership. Leave
        // an existing developer supervisor alone rather than guessing.
        ownsDevServices = false;
      }
    }
    console.log(`<== ${command.id}: ${result.exitCode === 0 ? "pass" : "fail"}`);
  }
} finally {
  // Always stop the supervisor before the final clean-worktree inspection.
  // The script deliberately does this even if startup only partially
  // succeeded, so a failed baseline cannot strand a CI runner or hide a port
  // dependency from a later command.
  if (ownsDevServices) {
    const cleanup = await run({ id: "stop-dev-services", command: "npm", args: ["run", "stop:dev"] });
    results.push(cleanup);
    console.log(`<== stop-dev-services: ${cleanup.exitCode === 0 ? "pass" : "fail"}`);
  }
}
const gitAfter = await gitStatus();
const cleanWorktreeBefore = gitBefore.exitCode === 0 && !gitBefore.output;
const cleanWorktreeAfter = gitAfter.exitCode === 0 && !gitAfter.output;
const report = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  // `git diff --check` only detects whitespace errors. A baseline that starts
  // from a modified checkout cannot prove reproducibility, even if every
  // command happens to pass, so keep that precondition in the final result.
  passed: results.every((item) => item.exitCode === 0) && cleanWorktreeBefore && cleanWorktreeAfter,
  cleanWorktreeBefore,
  cleanWorktreeAfter,
  commands: results,
  gitBefore,
  gitAfter
};
await writeFile(reportJson, JSON.stringify(report, null, 2));
await writeFile(reportMarkdown, markdown(report));
await writeFile(canonicalReportMarkdown, markdown(report));
console.log(`Baseline report: ${reportMarkdown}`);
if (!report.passed) process.exitCode = 1;
