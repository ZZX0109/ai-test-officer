import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactIntegrityItem,
  ArtifactIntegrityReport,
  EvidenceItem,
  VisualRunResult
} from "./types.js";

const artifactPrefix = "/artifacts/";
const selfReferenceNames = new Set([
  "artifact_integrity.json",
  "report.json",
  "report.md",
  "report.html",
  "run_bundle.json"
]);

interface ArtifactReference {
  artifactUri: string;
  kind: ArtifactIntegrityItem["kind"];
  evidenceId?: string;
}

interface ArtifactIntegrityInput {
  result: VisualRunResult;
  reportsDir?: string;
  generatedAt?: string;
}

interface WriteArtifactIntegrityInput extends ArtifactIntegrityInput {
  outputFile: string;
}

const defaultRootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const defaultReportsDir = path.join(defaultRootDir, "reports");

function stableId(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveArtifactPath(artifactUri: string, reportsDir = defaultReportsDir) {
  if (!artifactUri.startsWith(artifactPrefix)) {
    return { ok: false as const, reason: "not_an_artifact_uri" };
  }
  const relative = safeDecode(artifactUri.slice(artifactPrefix.length));
  const resolvedReportsDir = path.resolve(reportsDir);
  const resolved = path.resolve(resolvedReportsDir, relative);
  if (resolved !== resolvedReportsDir && !resolved.startsWith(`${resolvedReportsDir}${path.sep}`)) {
    return { ok: false as const, reason: "artifact_path_escape" };
  }
  return { ok: true as const, filePath: resolved };
}

async function sha256File(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function addReference(references: Map<string, ArtifactReference>, reference: ArtifactReference | undefined) {
  if (!reference?.artifactUri?.startsWith(artifactPrefix)) return;
  if (!references.has(reference.artifactUri)) references.set(reference.artifactUri, reference);
}

function collectPayloadArtifactUris(value: unknown, references: Map<string, ArtifactReference>, evidence: EvidenceItem) {
  if (typeof value === "string") {
    addReference(references, { artifactUri: value, kind: evidence.type, evidenceId: evidence.id });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPayloadArtifactUris(item, references, evidence);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPayloadArtifactUris(item, references, evidence);
    }
  }
}

function collectArtifactReferences(result: VisualRunResult) {
  const references = new Map<string, ArtifactReference>();
  addReference(references, { artifactUri: result.reportFile, kind: "report" });
  addReference(references, { artifactUri: result.markdownReportFile ?? "", kind: "report" });
  addReference(references, { artifactUri: result.htmlReportFile ?? "", kind: "report" });
  addReference(references, { artifactUri: result.runBundleFile, kind: "run_bundle" });
  addReference(references, { artifactUri: result.artifactIntegrityReportFile ?? "", kind: "report" });
  for (const step of result.steps) {
    addReference(references, { artifactUri: step.screenshot ?? "", kind: "screenshot" });
  }
  for (const evidence of result.evidence) {
    addReference(references, {
      artifactUri: evidence.file ?? "",
      kind: evidence.type,
      evidenceId: evidence.id
    });
    collectPayloadArtifactUris(evidence.payload, references, evidence);
  }
  return Array.from(references.values()).sort((a, b) => a.artifactUri.localeCompare(b.artifactUri));
}

async function checkReference(reference: ArtifactReference, reportsDir: string): Promise<ArtifactIntegrityItem> {
  const id = `artifact_${stableId(reference.artifactUri)}`;
  const resolved = resolveArtifactPath(reference.artifactUri, reportsDir);
  if (!resolved.ok) {
    return {
      id,
      artifactUri: reference.artifactUri,
      kind: reference.kind,
      evidenceId: reference.evidenceId,
      status: "path_escape",
      reason: resolved.reason
    };
  }
  const isSelfReference = selfReferenceNames.has(path.basename(resolved.filePath));
  if (isSelfReference) {
    return {
      id,
      artifactUri: reference.artifactUri,
      kind: reference.kind,
      evidenceId: reference.evidenceId,
      status: "self_reference",
      reason: "Excluded from hashing because run metadata can be rewritten after integrity generation."
    };
  }
  try {
    const fileStat = await stat(resolved.filePath);
    return {
      id,
      artifactUri: reference.artifactUri,
      kind: reference.kind,
      evidenceId: reference.evidenceId,
      status: "present",
      sizeBytes: fileStat.size,
      sha256: await sha256File(resolved.filePath)
    };
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    return {
      id,
      artifactUri: reference.artifactUri,
      kind: reference.kind,
      evidenceId: reference.evidenceId,
      status: code === "ENOENT" ? "missing" : "unreadable",
      reason: code || "artifact_unreadable"
    };
  }
}

function summarize(items: ArtifactIntegrityItem[]): ArtifactIntegrityReport["summary"] {
  return {
    total: items.length,
    present: items.filter((item) => item.status === "present").length,
    missing: items.filter((item) => item.status === "missing").length,
    unreadable: items.filter((item) => item.status === "unreadable").length,
    pathEscapes: items.filter((item) => item.status === "path_escape").length,
    selfReferences: items.filter((item) => item.status === "self_reference").length,
    hashed: items.filter((item) => item.sha256).length
  };
}

export async function buildArtifactIntegrityReport(input: ArtifactIntegrityInput): Promise<ArtifactIntegrityReport> {
  const reportsDir = input.reportsDir ?? defaultReportsDir;
  const references = collectArtifactReferences(input.result);
  const items = await Promise.all(references.map((reference) => checkReference(reference, reportsDir)));
  return {
    id: `artifact_integrity_${input.result.id}`,
    runId: input.result.id,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    artifactRoot: "/artifacts",
    summary: summarize(items),
    items
  };
}

export async function writeArtifactIntegrityReport(input: WriteArtifactIntegrityInput) {
  const report = await buildArtifactIntegrityReport(input);
  await mkdir(path.dirname(input.outputFile), { recursive: true });
  await writeFile(input.outputFile, JSON.stringify(report, null, 2));
  return report;
}

export type { ArtifactIntegrityInput };
