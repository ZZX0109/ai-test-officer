import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PatrolRunResult } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const patrolDir = path.join(rootDir, "reports", "patrol-runs");
const latestFile = path.join(patrolDir, "latest.json");
const indexFile = path.join(patrolDir, "index.json");

interface PatrolRunIndexItem {
  id: string;
  createdAt: string;
  jobId?: string;
  appUrl?: string;
  projectId?: string;
  targetFrontendUrl?: string;
  scenarioId?: string;
  verdict: string;
  releaseJudge?: string;
  deliveryStatus?: string;
  readableReport?: string;
  patrolFile?: string;
}

async function readIndex() {
  try {
    const raw = await readFile(indexFile, "utf8");
    return JSON.parse(raw) as PatrolRunIndexItem[];
  } catch {
    return [];
  }
}

function toIndexItem(result: PatrolRunResult): PatrolRunIndexItem {
  return {
    id: result.id,
    createdAt: result.createdAt,
    jobId: result.jobId,
    appUrl: result.appUrl,
    projectId: result.projectId,
    targetFrontendUrl: result.target?.frontendUrl,
    scenarioId: result.scenarioId,
    verdict: result.run.verdict,
    releaseJudge: result.run.judgeReport.releaseJudge.verdict,
    deliveryStatus: result.delivery.status,
    readableReport: result.run.htmlReportFile ?? result.run.markdownReportFile,
    patrolFile: result.patrolFile
  };
}

export async function writePatrolRun(result: PatrolRunResult) {
  await mkdir(patrolDir, { recursive: true });
  const file = path.join(patrolDir, `${result.id}.json`);
  const patrolFile = `/artifacts/patrol-runs/${result.id}.json`;
  const resultWithFile = { ...result, patrolFile };
  await writeFile(file, JSON.stringify(resultWithFile, null, 2));
  await writeFile(latestFile, JSON.stringify(resultWithFile, null, 2));
  const index = await readIndex();
  index.push(toIndexItem(resultWithFile));
  await writeFile(indexFile, JSON.stringify(index.slice(-100), null, 2));
  return {
    file: patrolFile,
    indexItem: toIndexItem(resultWithFile)
  };
}

export async function listPatrolRuns() {
  return readIndex();
}
