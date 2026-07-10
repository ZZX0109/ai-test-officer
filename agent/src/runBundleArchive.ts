import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveArtifactPath } from "./artifactIntegrity.js";
import type { ArtifactIntegrityItem, RunBundle } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const defaultReportsDir = path.join(rootDir, "reports");
const defaultMaxInlineBytes = 8 * 1024 * 1024;

export interface RunBundleDownloadManifestEntry {
  artifactUri: string;
  archivePath?: string;
  kind: ArtifactIntegrityItem["kind"];
  status: "included" | "missing" | "unreadable" | "path_escape" | "reference_only";
  sizeBytes?: number;
  sha256?: string;
  evidenceId?: string;
  reason?: string;
}

export interface RunBundleDownloadManifest {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  policy: {
    maxInlineBytes: number;
    largeArtifactPolicy: "reference_only";
  };
  entries: RunBundleDownloadManifestEntry[];
}

interface BuildRunBundleArchiveInput {
  bundle: RunBundle;
  outputFile: string;
  manifestFile: string;
  reportsDir?: string;
  maxInlineBytes?: number;
  generatedAt?: string;
}

interface ZipEntry {
  name: string;
  data: Buffer;
  artifactUri?: string;
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function normalizeArchivePath(name: string) {
  return name
    .replace(/^\/+/, "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function writeZipStoreArchive(outputFile: string, inputEntries: ZipEntry[]) {
  const now = dosTimestamp(new Date());
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  const entries = inputEntries
    .map((entry) => ({ ...entry, name: normalizeArchivePath(entry.name) }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.dosTime, 10);
    local.writeUInt16LE(now.dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(now.dosTime, 12);
    central.writeUInt16LE(now.dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralDirectory.push(central);
    offset += local.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralDirectory.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, Buffer.concat([...chunks, ...centralDirectory, end]));
}

function artifactItems(bundle: RunBundle): ArtifactIntegrityItem[] {
  const report = bundle.artifactIntegrity ?? bundle.result.artifactIntegrity;
  if (report?.items?.length) return report.items;
  return [
    { id: "report_json", artifactUri: bundle.result.reportFile, kind: "report", status: "self_reference" },
    { id: "run_bundle", artifactUri: bundle.result.runBundleFile, kind: "run_bundle", status: "self_reference" },
    ...(bundle.result.markdownReportFile
      ? [{ id: "report_md", artifactUri: bundle.result.markdownReportFile, kind: "report" as const, status: "self_reference" as const }]
      : []),
    ...(bundle.result.htmlReportFile
      ? [{ id: "report_html", artifactUri: bundle.result.htmlReportFile, kind: "report" as const, status: "self_reference" as const }]
      : []),
    ...(bundle.result.artifactIntegrityReportFile
      ? [{ id: "artifact_integrity", artifactUri: bundle.result.artifactIntegrityReportFile, kind: "report" as const, status: "self_reference" as const }]
      : [])
  ];
}

function shouldReferenceOnly(item: ArtifactIntegrityItem, sizeBytes: number, maxInlineBytes: number) {
  return (item.kind === "trace" || item.kind === "video") && sizeBytes > maxInlineBytes;
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function archiveRelativeReference(fromArchivePath: string, toArchivePath: string) {
  const relative = path.posix.relative(path.posix.dirname(fromArchivePath), toArchivePath);
  return relative || path.posix.basename(toArchivePath);
}

function rewriteHtmlArtifactReferences(entry: ZipEntry, artifactArchivePaths: Map<string, string>) {
  if (!entry.name.endsWith(".html")) return entry;
  const html = entry.data.toString("utf8").replace(
    /((?:src|href)=["'])(\/artifacts\/[^"']+)(["'])/g,
    (match: string, prefix: string, artifactUri: string, suffix: string) => {
      const archivePath = artifactArchivePaths.get(artifactUri);
      return archivePath ? `${prefix}${archiveRelativeReference(entry.name, archivePath)}${suffix}` : match;
    }
  );
  return { ...entry, data: Buffer.from(html) };
}

export async function buildRunBundleArchive(input: BuildRunBundleArchiveInput) {
  const reportsDir = input.reportsDir ?? defaultReportsDir;
  const maxInlineBytes = input.maxInlineBytes ?? defaultMaxInlineBytes;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const entries: RunBundleDownloadManifestEntry[] = [];
  const pendingZipEntries: ZipEntry[] = [];

  for (const item of artifactItems(input.bundle)) {
    const resolved = resolveArtifactPath(item.artifactUri, reportsDir);
    if (!resolved.ok) {
      entries.push({
        artifactUri: item.artifactUri,
        kind: item.kind,
        evidenceId: item.evidenceId,
        status: "path_escape",
        reason: resolved.reason
      });
      continue;
    }

    const archivePath = item.artifactUri.replace(/^\/artifacts\//, "");
    try {
      const fileStat = await stat(resolved.filePath);
      if (shouldReferenceOnly(item, fileStat.size, maxInlineBytes)) {
        entries.push({
          artifactUri: item.artifactUri,
          archivePath,
          kind: item.kind,
          evidenceId: item.evidenceId,
          status: "reference_only",
          sizeBytes: fileStat.size,
          sha256: item.sha256,
          reason: `Large ${item.kind} artifact exceeds ${maxInlineBytes} bytes and should be uploaded separately.`
        });
        continue;
      }
      const data = await readFile(resolved.filePath);
      pendingZipEntries.push({ name: archivePath, data, artifactUri: item.artifactUri });
      entries.push({
        artifactUri: item.artifactUri,
        archivePath,
        kind: item.kind,
        evidenceId: item.evidenceId,
        status: "included",
        sizeBytes: fileStat.size,
        sha256: item.sha256 ?? sha256(data)
      });
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      entries.push({
        artifactUri: item.artifactUri,
        archivePath,
        kind: item.kind,
        evidenceId: item.evidenceId,
        status: code === "ENOENT" ? "missing" : "unreadable",
        reason: code || "artifact_unreadable"
      });
    }
  }

  const manifest: RunBundleDownloadManifest = {
    schemaVersion: 1,
    runId: input.bundle.runId,
    generatedAt,
    policy: {
      maxInlineBytes,
      largeArtifactPolicy: "reference_only"
    },
    entries
  };
  const artifactArchivePaths = new Map(
    pendingZipEntries
      .filter((entry) => entry.artifactUri)
      .map((entry) => [entry.artifactUri!, normalizeArchivePath(entry.name)])
  );
  const zipEntries = pendingZipEntries.map((entry) => rewriteHtmlArtifactReferences(entry, artifactArchivePaths));
  zipEntries.push({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) });

  await mkdir(path.dirname(input.manifestFile), { recursive: true });
  await writeFile(input.manifestFile, JSON.stringify(manifest, null, 2));
  await writeZipStoreArchive(input.outputFile, zipEntries);
  return {
    zipFile: input.outputFile,
    manifestFile: input.manifestFile,
    manifest
  };
}
