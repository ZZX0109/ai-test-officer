import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceItem, RunBundle } from "./types.js";
import { redactRecord, redactUrl, redactValue } from "./redaction.js";
import {
  appendEvidenceToAuditStore,
  finalizeEvidenceArtifactLinksInAuditStore,
  readEvidenceFromAuditStore,
  readRunBundleFromAuditStore,
  readLatestRunIdFromAuditStore,
  recordRunBundleInAuditStore
} from "./sqliteAuditStore.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const defaultReportsDir = path.join(rootDir, "reports");
let reportsDirOverride: string | undefined;

/**
 * Test seam: redirect the reports root to an isolated temp directory so tests
 * never write into (or recursively delete) the real workspace `reports/`.
 */
export function setReportsDir(dir?: string): void {
  reportsDirOverride = dir;
}

export function getReportsDir(): string {
  return reportsDirOverride ?? defaultReportsDir;
}

const writeQueues = new Map<string, Promise<unknown>>();

function runDir(runId: string) {
  return path.join(getReportsDir(), "runs", runId);
}

function evidenceFile(runId: string) {
  return path.join(runDir(runId), "evidence.json");
}

function bundleFile(runId: string) {
  return path.join(runDir(runId), "run_bundle.json");
}

function makeEvidenceId(runId: string, type: EvidenceItem["type"]) {
  return `${runId}_${type}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export async function appendEvidence(
  runId: string,
  input: Omit<EvidenceItem, "id" | "runId" | "timestamp">
) {
  const previous = writeQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(runDir(runId), { recursive: true });
      const current = await readEvidence(runId);
      const item: EvidenceItem = {
        ...input,
        title: typeof input.title === "string" ? input.title : String(input.title),
        url: redactUrl(input.url),
        payload: redactRecord(input.payload),
        id: makeEvidenceId(runId, input.type),
        runId,
        timestamp: new Date().toISOString()
      };
      current.push(item);
      await writeFile(evidenceFile(runId), JSON.stringify(current, null, 2));
      appendEvidenceToAuditStore(item);
      return item;
    });
  writeQueues.set(runId, next);
  return next;
}

export async function readEvidence(runId: string): Promise<EvidenceItem[]> {
  const auditEvidence = readEvidenceFromAuditStore(runId);
  if (auditEvidence.length > 0) return auditEvidence;
  try {
    const raw = await readFile(evidenceFile(runId), "utf8");
    return JSON.parse(raw) as EvidenceItem[];
  } catch {
    return [];
  }
}

export async function finalizeEvidenceArtifactLinks(
  runId: string,
  evidence: EvidenceItem[]
) {
  const previous = writeQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      finalizeEvidenceArtifactLinksInAuditStore(runId, evidence);
      const persisted = readEvidenceFromAuditStore(runId);
      await mkdir(runDir(runId), { recursive: true });
      await writeFile(evidenceFile(runId), JSON.stringify(persisted, null, 2));
      return persisted;
    });
  writeQueues.set(runId, next);
  return next;
}

export async function writeRunBundle(bundle: RunBundle) {
  await mkdir(runDir(bundle.runId), { recursive: true });
  const redactedBundle = redactValue(bundle) as RunBundle;
  await writeFile(bundleFile(bundle.runId), JSON.stringify(redactedBundle, null, 2));
  await writeFile(path.join(getReportsDir(), "runs", "latest-run-id.txt"), bundle.runId);
  const bundleUri = `/artifacts/runs/${bundle.runId}/run_bundle.json`;
  recordRunBundleInAuditStore(redactedBundle, bundleUri);
  return bundleUri;
}

export async function readRunBundle(runId: string) {
  const auditBundle = readRunBundleFromAuditStore(runId);
  if (auditBundle) return auditBundle;
  const raw = await readFile(bundleFile(runId), "utf8");
  return JSON.parse(raw) as RunBundle;
}

export async function readLatestRunId() {
  const auditRunId = readLatestRunIdFromAuditStore();
  if (auditRunId) return auditRunId;
  try {
    return (await readFile(path.join(getReportsDir(), "runs", "latest-run-id.txt"), "utf8")).trim();
  } catch {
    return null;
  }
}
