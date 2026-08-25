import { spawn } from "node:child_process";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const archiveStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const defaultOutput = path.join(homedir(), "Desktop", `ai-test-officer-review-${archiveStamp}.tar.gz`);
const outputIndex = process.argv.indexOf("--output");
const requestedOutput = outputIndex >= 0 ? process.argv[outputIndex + 1] : process.env.REVIEW_PACKAGE_OUTPUT;
if (outputIndex >= 0 && !requestedOutput) throw new Error("review_package_output_required");
const outputFile = path.resolve(requestedOutput ?? defaultOutput);
const requiredReport = "reports/production-acceptance/latest.json";
const reviewReports = [
  requiredReport,
  "reports/shadow-graph/latest.json",
  "reports/external-acceptance/latest.json",
  "reports/external-acceptance/latest.md",
  "reports/external-acceptance/andflow.json",
  "reports/external-acceptance/investment-research-system.json",
  "reports/external-acceptance/nextjs-with-docker.json",
  "reports/external-acceptance/fastapi-full-stack-template.json",
  "reports/external-acceptance/spring-petclinic.json",
  "reports/baseline-verification/latest.json",
  "reports/baseline-verification/latest.md",
  "reports/baseline-verification/linux-latest.json",
  "reports/fault-injection/latest.json",
  "reports/fault-injection/latest.md",
  "reports/capacity-control-plane/latest.json",
  "reports/worker-load-slo/latest.json",
  "reports/browser-concurrency/latest.json",
  "reports/production-slo/latest.json",
  "reports/production-slo/dashboard-validation.json",
  "reports/security-adversarial/latest.json"
];
const requirementsSource = process.env.REVIEW_REQUIREMENTS_SOURCE?.trim();

const excludedDirectories = new Set([
  ".git", ".build", ".cache", ".turbo", "coverage", "dist", "node_modules"
]);
const excludedFiles = new Set([
  "data/benchmark/blind-cases.json",
  "evaluation/benchmark-labels/blind.json",
  ".DS_Store"
]);

function isSensitiveFile(relative, name) {
  if (excludedFiles.has(relative) || name === ".DS_Store") return true;
  if ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") return true;
  if (relative.startsWith("config/") && relative !== "config/config.example.json") return true;
  return false;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`review_package_command_failed:${command}:${code}:${stderr.slice(-800)}`));
    });
  });
}

async function sourceFiles(directory = rootDir, relative = ".") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relative === "." ? entry.name : path.posix.join(relative, entry.name);
    if (entry.name.startsWith("._")) continue;
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      if (childRelative === "reports") {
        // Reports commonly contain runtime evidence, local databases and
        // credentials. Only the low-sensitivity allowlist below is added as
        // reviewable release evidence.
        continue;
      }
      files.push(...await sourceFiles(path.join(directory, entry.name), childRelative));
      continue;
    }
    if (!entry.isFile() || isSensitiveFile(childRelative, entry.name)) continue;
    files.push(`./${childRelative}`);
  }
  return files;
}

async function main() {
  await Promise.all(reviewReports.map((report) => access(path.join(rootDir, report))));
  if (requirementsSource) await access(requirementsSource);
  try {
    await access(outputFile);
    if (process.env.REVIEW_PACKAGE_OVERWRITE !== "1") {
      throw new Error(`review_package_output_exists:${outputFile}:set REVIEW_PACKAGE_OVERWRITE=1 to replace it`);
    }
  } catch (error) {
    if (error instanceof Error && !/^ENOENT$/.test((error).code ?? "")) throw error;
  }
  const files = await sourceFiles();
  files.push(...reviewReports.map((report) => `./${report}`));
  const normalized = [...new Set(files)].sort();
  if (normalized.some((item) => item.includes("/node_modules/") || item.includes("/dist/") || /\/\._[^/]+$/.test(item))) {
    throw new Error("review_package_manifest_contains_excluded_content");
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.partial-${process.pid}`;
  await rm(temporary, { force: true });
  try {
    const tarArgs = ["-czf", temporary, "-C", rootDir, ...normalized];
    // The delivery requirements often arrive as an attachment outside the
    // repository. Include that exact user-provided source when supplied so an
    // external reviewer can judge the implementation against the same text.
    if (requirementsSource) tarArgs.push("-C", path.dirname(path.resolve(requirementsSource)), `./${path.basename(requirementsSource)}`);
    await run("tar", tarArgs);
    const { stdout } = await run("tar", ["-tzf", temporary]);
    const archived = stdout.split("\n").filter(Boolean);
    if (!reviewReports.every((report) => archived.includes(`./${report}`))
      || (requirementsSource && !archived.includes(`./${path.basename(requirementsSource)}`))
      || archived.some((item) => /(^|\/)\._[^/]+$/.test(item)
        || /(^|\/)(node_modules|dist|\.build)(\/|$)/.test(item)
        || item.endsWith("/.env")
        || /(^|\/)\.env\.(?!example$)[^/]+$/.test(item)
        || /(^|\/)config\/(local-secrets|project-login-secrets)/.test(item)
        || item.endsWith("/.DS_Store")
        || item.endsWith("/blind.json")
        || item.endsWith("/blind-cases.json"))) {
      throw new Error("review_package_validation_failed");
    }
    await rename(temporary, outputFile);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  console.log(JSON.stringify({ outputFile, fileCount: normalized.length, reviewReports, requirementsSource: requirementsSource ? path.basename(requirementsSource) : undefined }, null, 2));
}

await main();
