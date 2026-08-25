import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const reportDir = path.join(rootDir, "reports", "external-acceptance");
const checkoutRoot = process.env.EXTERNAL_ACCEPTANCE_ROOT?.trim();
const allowHostCommands = process.env.EXTERNAL_ACCEPTANCE_ALLOW_HOST_COMMANDS === "1";
const commandTimeoutMs = Number(process.env.EXTERNAL_PREFLIGHT_TIMEOUT_MS ?? 15 * 60_000);

const projectLayout = {
  andflow: { directory: "andflow", cwd: ".", setup: [["pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]]], checks: [["native-tests", "pnpm", ["test"]]] },
  "investment-research-system": { directory: "investment-research-system", cwd: ".", setup: [["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]], checks: [
    ["native-tests", "python3", ["-m", "pytest", "-q"]],
    ["native-build", "npm", ["run", "build"]],
    ["native-js-tests", "npm", ["test"]]
  ] },
  "nextjs-with-docker": { directory: "nextjs-with-docker", cwd: "examples/with-docker", setup: [["npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]]], checks: [["native-build", "npm", ["run", "build"]]] },
  "fastapi-full-stack-template": { directory: "fastapi-full-stack-template", cwd: ".", setup: [], checks: [] },
  "spring-petclinic": { directory: "spring-petclinic", cwd: ".", setup: [], checks: [["native-tests", "./mvnw", ["-q", "-DskipTests=false", "test"]]] }
};

function redactOutput(value, checkout) {
  return String(value ?? "")
    .replaceAll(checkout, "<external-checkout>")
    .replace(/(password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(-4000);
}

function commandEnvironment(home) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: "/tmp",
    CI: "1",
    NODE_ENV: "test",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1"
  };
}

function runCommand({ id, program, args, cwd, env, checkout }) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(program, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), commandTimeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ id, program, args, status: error.code === "ENOENT" ? "blocked" : "failed", exitCode: null, reason: error.code ?? error.message, startedAt, finishedAt: new Date().toISOString(), outputTail: redactOutput(`${stdout}\n${stderr}`, checkout) });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ id, program, args, status: exitCode === 0 ? "passed" : signal === "SIGTERM" ? "timeout" : "failed", exitCode, signal, startedAt, finishedAt: new Date().toISOString(), outputTail: redactOutput(`${stdout}\n${stderr}`, checkout) });
    });
  });
}

async function gitValue(directory, args) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", directory, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => resolve(code === 0 ? output.trim() : null));
    child.on("error", () => resolve(null));
  });
}

async function main() {
  if (!checkoutRoot) throw new Error("EXTERNAL_ACCEPTANCE_ROOT_required");
  if (!allowHostCommands) throw new Error("external_preflight_host_execution_disabled_set_EXTERNAL_ACCEPTANCE_ALLOW_HOST_COMMANDS_1_only_in_an_isolated_checkout");
  const lock = JSON.parse(await readFile(path.join(rootDir, "acceptance-projects.lock.json"), "utf8"));
  await mkdir(reportDir, { recursive: true });

  for (const project of lock.projects) {
    const layout = projectLayout[project.id];
    const repositoryRoot = path.join(checkoutRoot, layout?.directory ?? project.id);
    const cwd = path.resolve(repositoryRoot, layout?.cwd ?? ".");
    const home = path.join(checkoutRoot, ".preflight-home", project.id);
    await mkdir(home, { recursive: true });
    const codeCommit = await gitValue(repositoryRoot, ["rev-parse", "HEAD"]);
    const tree = await gitValue(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    const dirty = await gitValue(repositoryRoot, ["status", "--porcelain"]);
    const report = {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      projectId: project.id,
      framework: project.framework,
      repository: project.repository,
      revision: project.revision,
      codeCommit,
      gitTree: tree,
      checkoutPresent: Boolean(codeCommit),
      checkoutDirtyAfterExecution: Boolean(dirty),
      promptVersion: null,
      labelsSealed: false,
      evaluatorSeparated: false,
      repetitions: 0,
      models: [],
      lanes: [],
      status: "preflight-only",
      metrics: {},
      setup: [],
      checks: [],
      limitations: [
        "Only locked-source provenance and native project checks were executed.",
        "No evaluator-owned sealed labels were mounted.",
        "No rules/LLM comparison lanes were executed.",
        "No completion claim is made for P0-8."
      ]
    };
    if (!layout || !codeCommit) {
      report.status = "blocked";
      report.limitations.push("project_checkout_or_layout_missing");
      await writeFile(path.join(reportDir, `${project.id}.json`), JSON.stringify(report, null, 2));
      continue;
    }
    const expectedRevisionMatches = codeCommit === project.revision;
    report.expectedRevisionMatches = expectedRevisionMatches;
    const env = commandEnvironment(home);
    for (const [program, args] of layout.setup) {
      report.setup.push(await runCommand({ id: `setup:${program}`, program, args, cwd, env, checkout: checkoutRoot }));
    }
    for (const [id, program, args] of layout.checks) {
      report.checks.push(await runCommand({ id, program, args, cwd, env, checkout: checkoutRoot }));
    }
    const nativeTests = report.checks.filter((item) => item.id === "native-tests");
    const passedNativeTests = nativeTests.filter((item) => item.status === "passed").length;
    const nativeBuilds = [...report.setup, ...report.checks].filter((item) => item.id === "native-build");
    report.lanes = passedNativeTests === nativeTests.length && nativeTests.length > 0 ? ["native-tests"] : [];
    report.metrics = {
      nativeTestPassRate: nativeTests.length ? passedNativeTests / nativeTests.length : null,
      nativeTestCount: nativeTests.length,
      nativeBuildPassRate: nativeBuilds.length ? nativeBuilds.filter((item) => item.status === "passed").length / nativeBuilds.length : null,
      checkCount: report.checks.length
    };
    if (!expectedRevisionMatches) report.limitations.push("locked_revision_mismatch");
    await writeFile(path.join(reportDir, `${project.id}.json`), JSON.stringify(report, null, 2));
  }
}

await main();
