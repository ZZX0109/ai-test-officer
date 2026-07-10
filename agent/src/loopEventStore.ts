import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoopEvent } from "./types.js";

const rootDir = path.resolve(process.cwd(), "..");
const reportsDir = path.join(rootDir, "reports");
const writeQueues = new Map<string, Promise<unknown>>();

function runDir(runId: string) {
  return path.join(reportsDir, "runs", runId);
}

function loopFile(runId: string) {
  return path.join(runDir(runId), "loop-events.json");
}

function makeLoopEventId(runId: string) {
  return `${runId}_loop_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

export async function appendLoopEvent(
  runId: string,
  input: Omit<LoopEvent, "id" | "runId" | "timestamp">
) {
  const previous = writeQueues.get(runId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(runDir(runId), { recursive: true });
      const current = await readLoopEvents(runId);
      const item: LoopEvent = {
        ...input,
        id: makeLoopEventId(runId),
        runId,
        timestamp: new Date().toISOString()
      };
      current.push(item);
      await writeFile(loopFile(runId), JSON.stringify(current, null, 2));
      await writeFile(path.join(reportsDir, "runs", "latest-loop-events.json"), JSON.stringify(current, null, 2));
      return item;
    });
  writeQueues.set(runId, next);
  return next;
}

export async function readLoopEvents(runId: string) {
  try {
    const raw = await readFile(loopFile(runId), "utf8");
    return JSON.parse(raw) as LoopEvent[];
  } catch {
    return [];
  }
}

export async function readLatestLoopEvents() {
  try {
    const raw = await readFile(path.join(reportsDir, "runs", "latest-loop-events.json"), "utf8");
    return JSON.parse(raw) as LoopEvent[];
  } catch {
    return [];
  }
}
