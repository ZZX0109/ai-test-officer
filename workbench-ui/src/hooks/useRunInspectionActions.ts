import type { Dispatch, SetStateAction } from "react";
import { getRunBrowserSession, getRunBundle, getRunProjection, runStorageRetention } from "../api";
import type {
  BrowserSession,
  CommitCheckResult,
  LiveRunState,
  PatrolRunResult,
  RequirementAcceptanceResult,
  RunBundle,
  RunProjection,
  RunResult
} from "../types";

interface RunInspectionActionOptions {
  refresh: () => Promise<void>;
  fromBundle: (bundle: RunBundle) => RunResult;
  setMessage: (message: string) => void;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
  setCentreSurface: (surface: "preview" | "trajectory" | "code") => void;
  setActiveRun: Dispatch<SetStateAction<RunProjection | null>>;
  setBrowserSession: Dispatch<SetStateAction<BrowserSession | null>>;
  setBrowserFrameRevision: Dispatch<SetStateAction<number>>;
  setLiveRun: Dispatch<SetStateAction<LiveRunState | null>>;
  setCommitCheck: Dispatch<SetStateAction<CommitCheckResult | null>>;
  setRequirementAcceptance: Dispatch<SetStateAction<RequirementAcceptanceResult | null>>;
  setPatrolRun: Dispatch<SetStateAction<PatrolRunResult | null>>;
  setRightDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setLeftDrawerOpen: Dispatch<SetStateAction<boolean>>;
}

/** Read-only historical run navigation and storage-retention dry-run actions. */
export function useRunInspectionActions({
  refresh, fromBundle, setMessage, setResult, setActiveRunId, setCentreSurface,
  setActiveRun, setBrowserSession, setBrowserFrameRevision, setLiveRun,
  setCommitCheck, setRequirementAcceptance, setPatrolRun, setRightDrawerOpen,
  setLeftDrawerOpen
}: RunInspectionActionOptions) {
  async function openHistoricalRun(runId: string) {
    setMessage(`正在读取历史运行：${runId}`);
    try {
      const bundle = await getRunBundle(runId);
      setResult(fromBundle(bundle));
      setActiveRunId(runId);
      setCentreSurface("preview");
      const [projection, sessionResponse] = await Promise.all([getRunProjection(runId), getRunBrowserSession(runId)]);
      setActiveRun(projection.run);
      setBrowserSession(sessionResponse.session);
      setBrowserFrameRevision((current) => current + 1);
      setLiveRun(null);
      setCommitCheck(null);
      setRequirementAcceptance(null);
      setPatrolRun(null);
      setRightDrawerOpen(true);
      setLeftDrawerOpen(false);
      setMessage(`已打开历史运行：${runId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取历史运行失败");
    }
  }

  async function runRetentionDryRun() {
    try {
      const response = await runStorageRetention({ apply: false, archive: true });
      await refresh();
      setMessage(`Retention dry-run: actions=${String(response.retention.actionCount ?? 0)}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retention dry-run 失败");
    }
  }

  return { openHistoricalRun, runRetentionDryRun };
}
