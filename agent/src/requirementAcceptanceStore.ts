import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RequirementAcceptanceResult } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const acceptanceDir = path.join(rootDir, "reports", "requirement-acceptance");
const latestFile = path.join(acceptanceDir, "latest.json");
const indexFile = path.join(acceptanceDir, "index.json");

interface RequirementAcceptanceIndexItem {
  id: string;
  createdAt: string;
  selectedScenarioId?: string;
  verdict: string;
  releaseJudge?: string;
  readableReport?: string;
  deliveryStatus?: string;
  acceptanceFile?: string;
  harnessGapCount?: number;
}

async function readIndex() {
  try {
    const raw = await readFile(indexFile, "utf8");
    return JSON.parse(raw) as RequirementAcceptanceIndexItem[];
  } catch {
    return [];
  }
}

function toIndexItem(result: RequirementAcceptanceResult): RequirementAcceptanceIndexItem {
  return {
    id: result.id,
    createdAt: result.createdAt,
    selectedScenarioId: result.selectedScenarioId,
    verdict: result.run?.verdict ?? "skipped",
    releaseJudge: result.run?.judgeReport.releaseJudge.verdict,
    readableReport: result.run?.htmlReportFile ?? result.run?.markdownReportFile,
    deliveryStatus: result.delivery?.status,
    acceptanceFile: result.acceptanceFile,
    harnessGapCount: result.harnessGaps?.length ?? 0
  };
}

export async function writeRequirementAcceptance(result: RequirementAcceptanceResult) {
  await mkdir(acceptanceDir, { recursive: true });
  const file = path.join(acceptanceDir, `${result.id}.json`);
  const acceptanceFile = `/artifacts/requirement-acceptance/${result.id}.json`;
  const resultWithFile = { ...result, acceptanceFile };
  await writeFile(file, JSON.stringify(resultWithFile, null, 2));
  await writeFile(latestFile, JSON.stringify(resultWithFile, null, 2));
  const index = await readIndex();
  index.push(toIndexItem(resultWithFile));
  await writeFile(indexFile, JSON.stringify(index.slice(-100), null, 2));
  return {
    file: acceptanceFile,
    indexItem: toIndexItem(resultWithFile)
  };
}

export async function listRequirementAcceptances() {
  return readIndex();
}
