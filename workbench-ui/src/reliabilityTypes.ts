export interface DifferentialRunView {
  id: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "blocked" | "failed";
  base: { revision: string; runId: string; state: string; gateStatus?: string; environmentHash?: string; failureSignature?: string; repetitionsStable?: boolean; visualDifferenceOnly?: boolean; artifactIds: string[]; evidenceRefs: string[] };
  head: { revision: string; runId: string; state: string; gateStatus?: string; environmentHash?: string; failureSignature?: string; repetitionsStable?: boolean; visualDifferenceOnly?: boolean; artifactIds: string[]; evidenceRefs: string[] };
  pairManifest: {
    id: string;
    baseRevision: string;
    headRevision: string;
    dataContractId: string;
    environmentHash: string;
    planHash: string;
    dataHash: string;
    classification?: string;
    classificationReasons: string[];
  };
  parentRun?: { id: string; state: string; gateStatus?: string; executionStatus?: string };
}

export interface TestAssetView {
  id: string;
  projectId: string;
  sourceRunId: string;
  coverageItemIds: string[];
  oracleSpecIds: string[];
  evidenceRefs: string[];
  status: string;
  oracleSpecs?: Array<{
    id: string;
    description: string;
    source: { kind: string; id: string; version: string; sha256: string };
    decisionUse: string;
    lifecycle: { status: string; expiresAt?: string };
  }>;
  files: Array<{ path: string; content: string; sha256: string; language: "playwright-ts" | "api-ts" }>;
  validation?: {
    status: string;
    repetitions: number;
    passedRepetitions: number;
    mutationTotal: number;
    mutationKilled: number;
    securityPassed: boolean;
    runIds: string[];
    evidenceRefs: string[];
  };
  sourceRepositoryRoot: string;
  sourceRepositorySha256: string;
  targetBranch?: string;
}

export interface ReliabilityAssetContext {
  schemaVersion: "1.0";
  projectId: string;
  sourceRunId?: string;
  repositoryRoot: string;
  repositorySha256: string;
  sourceRun?: { id: string; state: string; gateStatus?: string };
  dataContracts: Array<{ id: string; projectId: string; coverageItemIds: string[]; dataSourceKinds: string[]; randomSeed: number; testTime: string }>;
  oracleSpecs: Array<{ id: string; coverageItemId: string; type: string; description: string; source: { kind: string; id: string; version: string; sha256: string }; decisionUse: string; lifecycleStatus: string }>;
  coverageItems: Array<{ id: string; runId: string; flowId: string; module: string; surface: string; risk: string; disposition: string }>;
  evidenceRefs: Array<{ id: string; type: string; title: string; timestamp: string; artifactIds: string[] }>;
  environmentDefaults: { environmentHash: string; randomSeed: number; testTime: string; ociImage?: string; browserVersion?: string };
}
