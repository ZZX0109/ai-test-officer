import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AggregatedVerdict, VisualRunResult } from "./types.js";
import { readRunHistoryFromAuditStore } from "./sqliteAuditStore.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const historyDir = path.join(rootDir, "reports", "runs");
const historyFile = path.join(historyDir, "run-history.json");

export interface RunHistoryComparison {
  previousRunId?: string;
  previousVerdict?: VisualRunResult["verdict"];
  previousFailedAssertionCount?: number;
  failureDelta: number;
  riskTrend: "first_run" | "improved" | "regressed" | "stable";
  judgeDecisionChanged: boolean;
  summary: string;
}

export interface RunHistoryEntry {
  runId: string;
  timestamp: string;
  verdict: VisualRunResult["verdict"];
  failedAssertionCount: number;
  appUrl: string;
  projectId?: string;
  scenarioId?: string;
  scenarioFingerprint?: string;
  comparison?: RunHistoryComparison;
}

async function readLegacyHistory() {
  try {
    const raw = await readFile(historyFile, "utf8");
    return JSON.parse(raw) as RunHistoryEntry[];
  } catch {
    return [];
  }
}

function readAuditHistory() {
  try {
    return readRunHistoryFromAuditStore();
  } catch {
    return [];
  }
}

function mergeHistory(auditHistory: RunHistoryEntry[], legacyHistory: RunHistoryEntry[]) {
  if (!auditHistory.length) return legacyHistory;
  const legacyByRunId = new Map(legacyHistory.map((entry) => [entry.runId, entry]));
  const merged: RunHistoryEntry[] = auditHistory.map((entry) => {
    const legacy = legacyByRunId.get(entry.runId);
    return {
      ...entry,
      scenarioFingerprint: entry.scenarioFingerprint ?? legacy?.scenarioFingerprint,
      comparison: undefined
    };
  });
  const auditRunIds = new Set(auditHistory.map((entry) => entry.runId));
  for (const legacy of legacyHistory) {
    if (!auditRunIds.has(legacy.runId)) merged.push(legacy);
  }
  return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function readHistory() {
  const legacyHistory = await readLegacyHistory();
  return mergeHistory(readAuditHistory(), legacyHistory);
}

export async function listRunHistory() {
  return withComparisons(await readHistory());
}

async function writeHistory(entries: RunHistoryEntry[]) {
  await mkdir(historyDir, { recursive: true });
  await writeFile(historyFile, JSON.stringify(entries.slice(-50), null, 2));
}

function scopedHistory(history: RunHistoryEntry[], appUrl: string, scenarioId?: string, scenarioFingerprint?: string) {
  return history
    .filter((item) =>
      item.appUrl === appUrl &&
      (!scenarioId || item.scenarioId === scenarioId) &&
      (!scenarioFingerprint || item.scenarioFingerprint === scenarioFingerprint)
    );
}

function verdictScore(verdict: VisualRunResult["verdict"]) {
  if (verdict === "continue") return 0;
  if (verdict === "hold_for_review") return 1;
  return 2;
}

export function buildHistoryComparison(previous: RunHistoryEntry | undefined, current: Omit<RunHistoryEntry, "comparison">): RunHistoryComparison {
  if (!previous) {
    return {
      failureDelta: current.failedAssertionCount,
      riskTrend: "first_run",
      judgeDecisionChanged: false,
      summary: "首次记录该 app/scenario/fingerprint 的运行结果。"
    };
  }
  const failureDelta = current.failedAssertionCount - previous.failedAssertionCount;
  const scoreDelta = verdictScore(current.verdict) - verdictScore(previous.verdict);
  const riskTrend = scoreDelta < 0 || (scoreDelta === 0 && failureDelta < 0)
    ? "improved"
    : scoreDelta > 0 || failureDelta > 0
      ? "regressed"
      : "stable";
  const judgeDecisionChanged = current.verdict !== previous.verdict;
  return {
    previousRunId: previous.runId,
    previousVerdict: previous.verdict,
    previousFailedAssertionCount: previous.failedAssertionCount,
    failureDelta,
    riskTrend,
    judgeDecisionChanged,
    summary: `Compared with ${previous.runId}: failures ${previous.failedAssertionCount} -> ${current.failedAssertionCount}; verdict ${previous.verdict} -> ${current.verdict}.`
  };
}

function withComparisons(history: RunHistoryEntry[]): RunHistoryEntry[] {
  const scopedPrevious = new Map<string, RunHistoryEntry>();
  return history.map((entry) => {
    const key = `${entry.appUrl}\n${entry.scenarioId ?? ""}\n${entry.scenarioFingerprint ?? ""}`;
    const previous = scopedPrevious.get(key);
    const normalized: RunHistoryEntry = {
      ...entry,
      comparison: entry.comparison ?? buildHistoryComparison(previous, entry)
    };
    scopedPrevious.set(key, normalized);
    return normalized;
  });
}

export async function appendRunHistory(input: {
  runId: string;
  appUrl: string;
  projectId?: string;
  scenarioId?: string;
  scenarioFingerprint?: string;
  result: Pick<VisualRunResult, "verdict" | "assertions">;
}) {
  const history = withComparisons(await readHistory());
  const entryBase: Omit<RunHistoryEntry, "comparison"> = {
    runId: input.runId,
    timestamp: new Date().toISOString(),
    verdict: input.result.verdict,
    failedAssertionCount: input.result.assertions.filter((item) => !item.passed).length,
    appUrl: input.appUrl,
    projectId: input.projectId,
    scenarioId: input.scenarioId,
    scenarioFingerprint: input.scenarioFingerprint
  };
  const previous = scopedHistory(history, input.appUrl, input.scenarioId, input.scenarioFingerprint).at(-1);
  const entry: RunHistoryEntry = {
    ...entryBase,
    comparison: buildHistoryComparison(previous, entryBase)
  };
  history.push(entry);
  await writeHistory(history);
  return buildAggregatedVerdict(history, input.appUrl, input.scenarioId, input.scenarioFingerprint);
}

function buildAggregatedVerdict(history: RunHistoryEntry[], appUrl: string, scenarioId?: string, scenarioFingerprint?: string): AggregatedVerdict {
  const scoped = scopedHistory(history, appUrl, scenarioId, scenarioFingerprint).slice(-3);
  const failedRuns = scoped.filter((item) => item.failedAssertionCount > 0).length;
  const passedRuns = scoped.length - failedRuns;
  const flaky = failedRuns > 0 && passedRuns > 0;
  if (flaky) {
    return {
      runCount: scoped.length,
      failedAssertionCount: scoped.at(-1)?.failedAssertionCount ?? 0,
      flaky: true,
      verdict: "needs_review",
      reason: "最近多次运行结果不一致，需要人工复核。"
    };
  }
  return {
    runCount: scoped.length,
    failedAssertionCount: scoped.at(-1)?.failedAssertionCount ?? 0,
    flaky: false,
    verdict: failedRuns > 0 ? "hold_for_review" : "continue",
    reason: failedRuns > 0 ? "最近运行均存在失败断言。" : "最近运行未发现失败断言。"
  };
}
