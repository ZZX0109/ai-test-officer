export interface BenchmarkCatalogCase { id: string; projectId: string; category: string; split?: "development" | "blind" | "extended" }
export interface BenchmarkExecutionMapping { logicalProjectId: string; executionProjectId: string; targetUrl?: string; targetKind?: string }

export function buildBenchmarkCatalog(input: {
  development: BenchmarkCatalogCase[];
  blind: BenchmarkCatalogCase[];
  extended: BenchmarkCatalogCase[];
  mappings: BenchmarkExecutionMapping[];
  challengeProjectIds: string[];
}) {
  const mappingByLogicalId = new Map(input.mappings.map((item) => [item.logicalProjectId, item]));
  if (mappingByLogicalId.size !== input.mappings.length) throw new Error("benchmark_mapping_duplicate_logical_project");
  const requiredProjects = new Set([...input.development, ...input.blind, ...input.extended].map((item) => item.projectId));
  for (const projectId of requiredProjects) if (!mappingByLogicalId.has(projectId)) throw new Error(`benchmark_mapping_missing:${projectId}`);
  const executionProjects = input.mappings.map((mapping) => ({
    logicalProjectId: mapping.logicalProjectId,
    executionProjectId: mapping.executionProjectId,
    targetUrl: mapping.targetUrl,
    targetKind: mapping.targetKind,
    splits: [
      ...(input.development.some((item) => item.projectId === mapping.logicalProjectId) ? ["development"] : []),
      ...(input.blind.some((item) => item.projectId === mapping.logicalProjectId) ? ["blind"] : []),
      ...(input.extended.some((item) => item.projectId === mapping.logicalProjectId) ? ["extended"] : [])
    ]
  }));
  return {
    caseCount: input.development.length,
    blindCaseCount: input.blind.length,
    projectCount: new Set([...executionProjects.map((item) => item.executionProjectId), ...input.challengeProjectIds]).size,
    fixtureProjects: executionProjects,
    executionMap: input.mappings,
    byProject: Object.fromEntries([...requiredProjects].map((projectId) => [projectId, input.development.filter((item) => item.projectId === projectId).length])),
    categories: Array.from(new Set(input.development.map((item) => item.category))).sort()
  };
}

export function trustedBenchmarkRuntimeMetrics(snapshot: unknown) {
  const value = snapshot as {
    experimentId?: string;
    status?: string;
    conclusion?: string;
    evaluations?: Array<{ split: "development" | "blind"; completedRuns: number; plannedRuns: number; acceptance: { proven: boolean; reasons: string[] }; lanes: Record<string, Record<string, number | null>> }>;
    provenance?: { kind?: string; rawRecordCount?: number; formalEligibleRecordCount?: number; excludedRecords?: unknown[]; blindDataIncluded?: boolean };
    blockers?: string[];
  } | undefined;
  if (!value) return { status: "awaiting_credentials", blockers: ["benchmark_snapshot_missing"], lanes: {} as Record<string, Record<string, number | null>> };
  if (!value?.provenance?.kind) return { status: "blocked", blockers: ["benchmark_snapshot_provenance_missing"], lanes: {} as Record<string, Record<string, number | null>> };
  const displayed = value.evaluations?.find((item) => item.split === "blind") ?? value.evaluations?.find((item) => item.split === "development");
  const commandMetrics = Object.entries(displayed?.lanes ?? {}).find(([lane]) => lane.startsWith("test-command"))?.[1];
  if (commandMetrics && commandMetrics.gateEligibleRate !== 0) return { status: "blocked", blockers: ["benchmark_command_baseline_gate_violation"], lanes: {} as Record<string, Record<string, number | null>> };
  if (value.provenance.kind === "historical-recompute" && value.conclusion === "llm_gain_proven") return { status: "blocked", blockers: ["historical_snapshot_cannot_prove_llm_gain"], lanes: {} as Record<string, Record<string, number | null>> };
  return {
    status: value.status ?? "awaiting_agent_runs",
    experimentId: value.experimentId,
    conclusion: value.conclusion ?? "development_only",
    completedRuns: value.provenance.rawRecordCount ?? displayed?.completedRuns ?? 0,
    formalEligibleRuns: value.provenance.formalEligibleRecordCount ?? displayed?.completedRuns ?? 0,
    plannedRuns: displayed?.plannedRuns ?? 0,
    blockers: value.blockers ?? [],
    acceptance: displayed?.acceptance,
    displayedSplit: displayed?.split,
    lanes: displayed?.lanes ?? {},
    provenance: value.provenance
  };
}
