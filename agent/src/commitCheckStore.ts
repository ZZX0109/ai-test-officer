import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommitCheckResult } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const checksDir = path.join(rootDir, "reports", "commit-checks");
const latestFile = path.join(checksDir, "latest.json");
const indexFile = path.join(checksDir, "index.json");

interface CommitCheckIndexItem {
  id: string;
  createdAt: string;
  selectedScenarioId?: string;
  verdict: string;
  releaseJudge?: string;
  readableReport?: string;
  deliveryStatus?: string;
  commitCheckFile?: string;
  harnessGapCount?: number;
}

async function readIndex() {
  try {
    const raw = await readFile(indexFile, "utf8");
    return JSON.parse(raw) as CommitCheckIndexItem[];
  } catch {
    return [];
  }
}

function toIndexItem(check: CommitCheckResult): CommitCheckIndexItem {
  return {
    id: check.id,
    createdAt: check.createdAt,
    selectedScenarioId: check.selectedScenarioId,
    verdict: check.run?.verdict ?? "skipped",
    releaseJudge: check.run?.judgeReport.releaseJudge.verdict,
    readableReport: check.run?.htmlReportFile ?? check.run?.markdownReportFile,
    deliveryStatus: check.delivery?.status,
    commitCheckFile: check.commitCheckFile,
    harnessGapCount: check.harnessGaps?.length ?? 0
  };
}

export async function writeCommitCheck(check: CommitCheckResult) {
  await mkdir(checksDir, { recursive: true });
  const file = path.join(checksDir, `${check.id}.json`);
  const commitCheckFile = `/artifacts/commit-checks/${check.id}.json`;
  const checkWithFile = { ...check, commitCheckFile };
  await writeFile(file, JSON.stringify(checkWithFile, null, 2));
  await writeFile(latestFile, JSON.stringify(checkWithFile, null, 2));
  const index = await readIndex();
  index.push(toIndexItem(checkWithFile));
  await writeFile(indexFile, JSON.stringify(index.slice(-100), null, 2));
  return {
    file: commitCheckFile,
    indexItem: toIndexItem(checkWithFile)
  };
}

export async function listCommitChecks() {
  return readIndex();
}
