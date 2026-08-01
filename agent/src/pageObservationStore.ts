import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DiscoveryPageObservation } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent"
  ? path.resolve(process.cwd(), "..")
  : process.cwd();
const observationRoot = path.join(rootDir, "reports", "discovery", "observations");

export const discoveryPageObservationSchema = z.object({
  id: z.string().min(1).max(200),
  requestedUrl: z.string().max(2_000),
  finalUrl: z.string().max(2_000),
  startedAt: z.string(),
  capturedAt: z.string(),
  durationMs: z.number().nonnegative(),
  stage: z.enum(["launch", "navigation", "dom-ready", "snapshot", "selection", "completed"]),
  status: z.enum(["ready", "degraded", "failed"]),
  navigation: z.object({
    documentCommitted: z.boolean(),
    httpStatus: z.number().int().optional(),
    warning: z.string().max(500).optional()
  }),
  network: z.object({
    totalRequests: z.number().int().nonnegative(),
    completedRequests: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    activeRequests: z.number().int().nonnegative(),
    peakActiveRequests: z.number().int().nonnegative(),
    lastActivityAt: z.string().optional()
  }).optional(),
  document: z.object({
    readyState: z.string().max(100).optional(),
    bodyTextSample: z.string().max(1_200).optional(),
    interactiveElementCount: z.number().int().nonnegative(),
    viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    controls: z.array(z.object({
      kind: z.enum(["link", "button", "input", "textarea", "select", "other"]),
      role: z.string().max(80).optional(),
      accessibleName: z.string().max(240).optional(),
      testId: z.string().max(240).optional(),
      inputType: z.string().max(80).optional(),
      disabled: z.boolean(),
      visible: z.boolean()
    })).max(40).default([])
  }),
  console: z.array(z.object({
    type: z.string().max(50),
    text: z.string().max(500)
  })).max(20),
  pageErrors: z.array(z.string().max(500)).max(20),
  failedRequests: z.array(z.object({
    method: z.string().max(30),
    url: z.string().max(800),
    status: z.number().int().optional(),
    resourceType: z.string().max(80).optional(),
    failure: z.string().max(300).optional()
  })).max(20),
  screenshot: z.object({
    storageUri: z.string()
      .max(1_000)
      .regex(/^\/artifacts\/discovery\/[a-zA-Z0-9_.-]+\.png$/),
    capturedAt: z.string()
  }).optional(),
  diagnosis: z.object({
    summary: z.string().max(1_000),
    likelyCauses: z.array(z.string().max(500)).max(4),
    retryable: z.boolean(),
    userActionRequired: z.boolean()
  })
});

const storedDiscoveryObservationSchema = z.object({
  schemaVersion: z.literal("discovery-observation-v1"),
  id: z.string().min(1).max(200),
  projectId: z.string().min(1).max(300).optional(),
  createdAt: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  observation: discoveryPageObservationSchema
});

export type StoredDiscoveryObservation = z.infer<typeof storedDiscoveryObservationSchema>;

function observationFile(id: string) {
  const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 200);
  if (!safeId || safeId !== id) throw new Error("discovery_observation_id_invalid");
  return path.join(observationRoot, `${safeId}.json`);
}

function latestFile(projectId: string) {
  const projectKey = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
  return path.join(observationRoot, `latest-${projectKey}.json`);
}

function digestObservation(observation: DiscoveryPageObservation) {
  return createHash("sha256").update(JSON.stringify(observation)).digest("hex");
}

function redactObservationText(value: string, limit: number) {
  const redacted = value
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|afk|AIza)[-_A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}

function redactObservationUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
    return redactObservationText(url.toString(), 800);
  } catch {
    return redactObservationText(value, 800);
  }
}

export function sanitizeDiscoveryPageObservation(input: DiscoveryPageObservation) {
  return discoveryPageObservationSchema.parse({
    ...input,
    requestedUrl: redactObservationUrl(input.requestedUrl),
    finalUrl: redactObservationUrl(input.finalUrl),
    navigation: {
      ...input.navigation,
      warning: input.navigation.warning
        ? redactObservationText(input.navigation.warning, 500)
        : undefined
    },
    document: {
      ...input.document,
      bodyTextSample: input.document.bodyTextSample
        ? redactObservationText(input.document.bodyTextSample, 1_200)
        : undefined,
      controls: input.document.controls.map((control) => ({
        ...control,
        role: control.role ? redactObservationText(control.role, 80) : undefined,
        accessibleName: control.accessibleName
          ? redactObservationText(control.accessibleName, 240)
          : undefined,
        testId: control.testId ? redactObservationText(control.testId, 240) : undefined,
        inputType: control.inputType ? redactObservationText(control.inputType, 80) : undefined
      }))
    },
    console: input.console.map((item) => ({
      type: redactObservationText(item.type, 50),
      text: redactObservationText(item.text, 500)
    })),
    pageErrors: input.pageErrors.map((item) => redactObservationText(item, 500)),
    failedRequests: input.failedRequests.map((item) => ({
      ...item,
      url: redactObservationUrl(item.url),
      failure: item.failure ? redactObservationText(item.failure, 300) : undefined
    })),
    diagnosis: {
      ...input.diagnosis,
      summary: redactObservationText(input.diagnosis.summary, 1_000),
      likelyCauses: input.diagnosis.likelyCauses.map((item) =>
        redactObservationText(item, 500)
      )
    }
  });
}

async function atomicWrite(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function writeDiscoveryPageObservation(input: {
  projectId?: string;
  observation: DiscoveryPageObservation;
}) {
  const observation = sanitizeDiscoveryPageObservation(
    discoveryPageObservationSchema.parse(input.observation)
  );
  const record = storedDiscoveryObservationSchema.parse({
    schemaVersion: "discovery-observation-v1",
    id: observation.id,
    projectId: input.projectId,
    createdAt: new Date().toISOString(),
    sha256: digestObservation(observation),
    observation
  });
  await atomicWrite(observationFile(record.id), record);
  if (record.projectId) await atomicWrite(latestFile(record.projectId), record);
  return record;
}

async function readRecord(file: string) {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const record = storedDiscoveryObservationSchema.parse(JSON.parse(raw));
  if (record.sha256 !== digestObservation(record.observation)) {
    throw new Error("discovery_observation_integrity_invalid");
  }
  return record;
}

export async function readDiscoveryPageObservation(id: string) {
  return readRecord(observationFile(id));
}

export async function readLatestDiscoveryPageObservation(projectId: string) {
  return readRecord(latestFile(projectId));
}

export async function resolveTrustedDiscoveryObservation(input: {
  projectId: string;
  observationId?: string;
  maxAgeMs?: number;
}) {
  const selected = input.observationId
    ? await readDiscoveryPageObservation(input.observationId)
    : await readLatestDiscoveryPageObservation(input.projectId);
  if (!selected) return undefined;
  if (selected.projectId !== input.projectId) {
    throw new Error("discovery_observation_cross_project");
  }
  const maxAgeMs = Math.max(1_000, input.maxAgeMs ?? 10 * 60_000);
  const capturedAt = Date.parse(selected.observation.capturedAt);
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAgeMs) {
    throw new Error("discovery_observation_expired");
  }
  return selected;
}
