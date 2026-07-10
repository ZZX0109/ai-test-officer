import { useMemo } from "react";
import type { Credential, LiveRunState, RunResult } from "../types";

interface WorkbenchStateInput {
  credentials: Credential[];
  result?: RunResult | null;
  liveRun?: LiveRunState | null;
  isRunning: boolean;
  isPatrolling: boolean;
  isCommitChecking: boolean;
  isAcceptingRequirement: boolean;
}

export function useWorkbenchState({
  credentials,
  result,
  liveRun,
  isRunning,
  isPatrolling,
  isCommitChecking,
  isAcceptingRequirement
}: WorkbenchStateInput) {
  const defaultCredential = useMemo(() => credentials.find((item) => item.isDefault), [credentials]);
  const isBusy = isRunning || isPatrolling || isCommitChecking || isAcceptingRequirement;
  const latestScreenshot =
    (isBusy ? liveRun?.latestScreenshot : undefined) ??
    (result ? [...result.steps].reverse().find((step) => step.screenshot)?.screenshot : undefined);
  const displayedLoopEvents = isBusy && liveRun?.events.length ? liveRun.events : result?.loopEvents;
  const liveStatusText = liveRun?.runId
    ? `${liveRun.status} · ${liveRun.runId} · evidence ${liveRun.evidenceCount}`
    : "idle";

  return {
    defaultCredential,
    isBusy,
    latestScreenshot,
    displayedLoopEvents,
    liveStatusText
  };
}
