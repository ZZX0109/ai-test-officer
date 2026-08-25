import { createExecutionEnvironment } from "@ai-test-officer/execution-worker";

export function createRunnerExecutionEnvironment<TTarget, TBrowser, TEvidence>(input: {
  projectId: string;
  runtimeStatus: unknown;
  target: TTarget;
  launchBrowser: () => Promise<TBrowser>;
  collectArtifacts: () => Promise<TEvidence[]>;
  teardown: () => Promise<void>;
}) {
  return createExecutionEnvironment<TTarget, TBrowser, TEvidence>({
    prepare: async () => ({
      projectId: input.projectId,
      status: input.runtimeStatus && typeof input.runtimeStatus === "object" && "status" in input.runtimeStatus && input.runtimeStatus.status === "failed" ? "blocked" : "ready",
      generatedAt: new Date().toISOString(),
      checks: []
    }),
    launchTarget: async () => input.target,
    launchBrowser: input.launchBrowser,
    collectArtifacts: input.collectArtifacts,
    teardown: input.teardown
  });
}
