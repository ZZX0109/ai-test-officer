import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCiAnnotationMarkdown,
  buildCiErrorGateReport,
  buildCiGateReport,
  buildCiJUnitReport,
  buildCiPrAnnotations,
  buildCiUploadManifest,
  computeCiExitCode,
  type CiGatePolicy,
  type CiExitCode
} from "./ciContract.js";
import { readCiGatePolicy } from "./ciGatePolicy.js";
import { runCommitCheck } from "./commitCheckOrchestrator.js";
import { buildRunBundleArchive } from "./runBundleArchive.js";
import { redactText } from "./redaction.js";
import type { RunBundle } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.resolve(process.env.REPORTS_DIR ?? path.join(rootDir, "reports"));

function readList(value: string | undefined, fallback: string[]) {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : fallback;
}

const appUrl = process.env.APP_URL ?? "http://localhost:6173";
const projectId = process.env.PROJECT_ID;
const scenarioId = process.env.SCENARIO_ID;
const credentialId = process.env.CREDENTIAL_ID;
const strictInput = process.env.STRICT_INPUT === "1";
const prUrl = process.env.PR_URL ?? (strictInput ? undefined : "local://cli/commit-check");
const prDiffUrl = process.env.PR_DIFF_URL;
const requirementUrl = process.env.REQUIREMENT_URL;
const requirementPath =
  process.env.REQUIREMENT_PATH ?? (strictInput || requirementUrl ? undefined : "data/fixtures/task-filter-requirement.md");
const bugTicketUrl = process.env.BUG_TICKET_URL;
const bugTicketPath =
  process.env.BUG_TICKET_PATH ?? (strictInput || bugTicketUrl ? undefined : "data/fixtures/tapd-task-filter-bug.md");
const openApiUrl = process.env.OPENAPI_URL;
const openApiPath = process.env.OPENAPI_PATH;
const fallbackDiff = process.env.FALLBACK_DIFF ?? (strictInput ? undefined : "fetchTasks changed query to empty string");
const notify = readList(process.env.NOTIFY, ["oncall"]);

function fallbackGatePolicy(): CiGatePolicy {
  return {
    strictGate: process.env.STRICT_RELEASE_GATE === "1",
    quarantinedScenarios: [],
    flakyMode: "warn"
  };
}

function artifactPath(artifactUrl: string | undefined) {
  if (!artifactUrl) return undefined;
  return path.join(rootDir, artifactUrl.replace(/^\/artifacts\//, "reports/"));
}

function rootRelative(filePath: string | undefined) {
  if (!filePath) return undefined;
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

async function buildDownloadBundle(runBundleUrl: string | undefined) {
  const bundlePath = artifactPath(runBundleUrl);
  if (!bundlePath) return undefined;
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as RunBundle;
  const outputFile = path.join(reportsDir, "run-bundle.zip");
  const manifestFile = path.join(reportsDir, "run-bundle-download-manifest.json");
  const archive = await buildRunBundleArchive({
    bundle,
    outputFile,
    manifestFile,
    reportsDir,
    maxInlineBytes: Number(process.env.RUN_BUNDLE_MAX_INLINE_BYTES ?? 8 * 1024 * 1024)
  });
  return {
    zipPath: rootRelative(archive.zipFile),
    manifestPath: rootRelative(archive.manifestFile),
    referenceOnlyFiles: archive.manifest.entries
      .filter((entry) => entry.status === "reference_only")
      .map((entry) => rootRelative(artifactPath(entry.artifactUri)))
      .filter(Boolean)
  };
}

async function writeCiReports(check: Awaited<ReturnType<typeof runCommitCheck>>, gatePolicy: CiGatePolicy) {
  await mkdir(reportsDir, { recursive: true });
  const gate = buildCiGateReport(check, gatePolicy);
  const downloadBundle = await buildDownloadBundle(gate.runBundle);
  const enrichedGate = {
    ...gate,
    runBundleZip: downloadBundle?.zipPath,
    downloadManifest: downloadBundle?.manifestPath
  };
  const annotation = buildCiAnnotationMarkdown(enrichedGate);
  const annotations = buildCiPrAnnotations(enrichedGate);
  const uploadManifest = buildCiUploadManifest([
    downloadBundle?.zipPath,
    downloadBundle?.manifestPath,
    ...(downloadBundle?.referenceOnlyFiles ?? []),
    gate.runBundle ? rootRelative(artifactPath(gate.runBundle)) : undefined,
    gate.readableReport ? rootRelative(artifactPath(gate.readableReport)) : undefined
  ]);
  await writeFile(path.join(reportsDir, "gate.json"), JSON.stringify(enrichedGate, null, 2));
  await writeFile(path.join(reportsDir, "junit.xml"), buildCiJUnitReport(enrichedGate));
  await writeFile(path.join(reportsDir, "pr-annotation.md"), annotation);
  await writeFile(path.join(reportsDir, "pr-annotations.json"), JSON.stringify(annotations, null, 2));
  await writeFile(path.join(reportsDir, "artifact-upload-manifest.json"), JSON.stringify(uploadManifest, null, 2));
  return enrichedGate;
}

async function writeCiErrorReports(error: unknown, gatePolicy: CiGatePolicy) {
  await mkdir(reportsDir, { recursive: true });
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactText(rawMessage);
  const exitCode: Extract<CiExitCode, 3 | 4> = rawMessage.startsWith("runtime_unavailable:") ? 3 : 4;
  const gate = buildCiErrorGateReport({
    gatePolicy,
    exitCode,
    errorMessage: message
  });
  await writeFile(path.join(reportsDir, "gate.json"), JSON.stringify(gate, null, 2));
  await writeFile(path.join(reportsDir, "junit.xml"), buildCiJUnitReport(gate));
  await writeFile(path.join(reportsDir, "pr-annotation.md"), buildCiAnnotationMarkdown(gate));
  await writeFile(path.join(reportsDir, "pr-annotations.json"), JSON.stringify(buildCiPrAnnotations(gate), null, 2));
  await writeFile(path.join(reportsDir, "artifact-upload-manifest.json"), JSON.stringify(buildCiUploadManifest([]), null, 2));
  return gate;
}

async function main() {
  let gatePolicy = fallbackGatePolicy();
  try {
    gatePolicy = readCiGatePolicy({ rootDir });
    const check = await runCommitCheck({
      appUrl,
      projectId,
      scenarioId,
      credentialId,
      prUrl,
      prDiffUrl,
      requirementPath,
      requirementUrl,
      bugTicketPath,
      bugTicketUrl,
      openApiPath,
      openApiUrl,
      fallbackDiff,
      strictInput,
      notify,
      permissionProfile: {
        observe: true,
        browserControl: true,
        workspaceControl: false,
        ideTerminalControl: false,
        systemControl: false
      }
    });
    const gate = await writeCiReports(check, gatePolicy);
    console.log(JSON.stringify(gate, null, 2));
    process.exitCode = computeCiExitCode(check, gatePolicy);
  } catch (error) {
    console.error(error);
    const gate = await writeCiErrorReports(error, gatePolicy);
    process.exit(gate.exitCode);
  }
}

void main();
