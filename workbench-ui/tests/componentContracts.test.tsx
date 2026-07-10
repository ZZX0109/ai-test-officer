import assert from "node:assert/strict";
import React from "react";
import { ArtifactIntegrityPanel } from "../src/components/ArtifactIntegrityPanel";
import { BotDeliveryPanel } from "../src/components/BotDeliveryPanel";
import { ConnectorPanel } from "../src/components/ConnectorPanel";
import { DiscoveryPanel } from "../src/components/DiscoveryPanel";
import { EvidencePanel } from "../src/components/EvidencePanel";
import { HistoryPanel } from "../src/components/HistoryPanel";
import { ImpactPanel } from "../src/components/ImpactPanel";
import { JudgePanel } from "../src/components/JudgePanel";
import { PatrolPanel } from "../src/components/PatrolPanel";
import { ProjectPanel } from "../src/components/ProjectPanel";
import { ProjectWizardPanel } from "../src/components/ProjectWizardPanel";
import { SecurityPanel } from "../src/components/SecurityPanel";
import { ServiceHealthPanel } from "../src/components/ServiceHealthPanel";
import { SourceStatusPanel } from "../src/components/SourceStatusPanel";
import { StoragePanel } from "../src/components/StoragePanel";

const project = {
  id: "external",
  name: "External Project",
  projectPath: "/tmp/example",
  allowExternalProjectPath: true,
  processes: [{ name: "api", command: "npm run dev:api", healthCheckUrl: "http://127.0.0.1:8000/api/health", required: true }],
  frontendUrl: "http://localhost:3000"
};

assert.equal(React.isValidElement(React.createElement(ProjectPanel, {
  projects: [project],
  selectedProjectId: project.id,
  draft: project,
  status: { projectId: project.id, status: "idle", message: "idle" },
  connection: null,
  onSelect: () => undefined,
  onDraftChange: () => undefined,
  onSave: () => undefined,
  onTest: () => undefined,
  onStart: () => undefined,
  onStop: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(ProjectWizardPanel, {
  projectPath: project.projectPath,
  detection: {
    projectPath: project.projectPath,
    exists: true,
    detectedStack: ["vite"],
    packageManagers: ["npm"],
    suggestedConfig: project,
    ports: [{ port: 5173, purpose: "frontend", status: "available", url: "http://127.0.0.1:5173" }],
    healthCandidates: ["http://127.0.0.1:5173"],
    warnings: [],
    plainLanguageFixes: ["项目路径可以访问。"]
  },
  diagnosis: {
    projectId: project.id,
    checkedAt: new Date().toISOString(),
    overallStatus: "warning",
    stages: [{
      stage: "frontend",
      status: "warning",
      reason: "port_conflict",
      humanMessage: "端口可能被占用。",
      suggestedCommands: ["npm run dev"]
    }]
  },
  onProjectPathChange: () => undefined,
  onDetect: () => undefined,
  onApplySuggestion: () => undefined,
  onDiagnose: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(ConnectorPanel, {
  requirementPath: "/tmp/external-project/docs/requirement.md",
  requirementUrl: "",
  bugTicketPath: "/tmp/external-project/docs/bug.md",
  bugTicketUrl: "",
  prDiffUrl: "",
  openApiPath: "/tmp/external-project/openapi.json",
  openApiUrl: "",
  strictInput: true,
  hasRemoteConnectorInput: false,
  onRequirementPathChange: () => undefined,
  onRequirementUrlChange: () => undefined,
  onBugTicketPathChange: () => undefined,
  onBugTicketUrlChange: () => undefined,
  onPrDiffUrlChange: () => undefined,
  onOpenApiPathChange: () => undefined,
  onOpenApiUrlChange: () => undefined,
  onStrictInputChange: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(SourceStatusPanel, {
  sources: [{
    id: "src",
    kind: "git_diff",
    title: "Diff",
    status: "missing",
    summary: "missing in strict mode",
    permissionState: "not_required",
    isSimulated: false,
    readAt: new Date().toISOString(),
    trustLevel: "low",
    displayStatus: "missing",
    evidenceUse: "planning",
    plainLanguageSummary: "本次没有读到 diff。"
  }]
})), true);

assert.equal(React.isValidElement(React.createElement(DiscoveryPanel, {
  discovery: {
    id: "discovery_contract",
    createdAt: new Date().toISOString(),
    target: { frontendUrl: "http://localhost:6173" },
    page: {
      url: "http://localhost:6173",
      title: "Contract",
      headings: ["Contract"],
      links: [],
      buttons: [{ text: "提交", testId: "submit" }],
      inputs: [{ label: "标题", name: "title", type: "text", testId: "title" }],
      forms: [{ inputCount: 1 }],
      testIds: ["submit", "title"]
    },
    networkEndpoints: [{ method: "GET", url: "http://localhost:6173/api/tasks", status: 200, path: "/api/tasks" }],
    openApiOperations: [{ method: "GET", path: "/api/tasks", operationId: "listTasks" }],
    suggestions: [{
      id: "suggestion_1",
      title: "表单校验",
      riskKind: "form",
      reason: "页面包含表单。",
      suggestedScenarioId: "discovered_form",
      selectors: { testId: "submit" },
      actions: ["complex_form_validate"],
      oracles: [],
      evidenceRequirements: ["screenshot", "dom"],
      humanReviewRequired: true,
      draftScenarioRef: "discovered_form"
    }],
    drafts: [],
    status: "passed",
    message: "ok"
  },
  drafts: [{
    gapId: "discovery_suggestion_1",
    createdAt: new Date().toISOString(),
    scenarioId: "discovered_form",
    draftReviewStatus: "draft",
    selectorProbeStatus: "not_run",
    riskKind: "form",
    evidenceRequirements: ["screenshot", "dom"],
    scenario: {}
  }],
  onScan: () => undefined,
  onProbeDraft: () => undefined,
  onApproveDraft: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(ImpactPanel, {
  impact: {
    id: "impact",
    createdAt: new Date().toISOString(),
    affectedPages: [],
    affectedApis: [],
    affectedComponents: [],
    recommendedScenarios: [],
    uncoveredRisks: []
  }
})), true);

assert.equal(React.isValidElement(React.createElement(HistoryPanel, {
  runs: [{
    runId: "run_contract",
    timestamp: new Date().toISOString(),
    verdict: "continue",
    failedAssertionCount: 0,
    appUrl: "http://localhost:6173",
    scenarioId: "task_filter_completed"
  }],
  activeRunId: "run_contract",
  onOpenRun: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(StoragePanel, {
  storage: {
    reportsDir: "/tmp/reports",
    archiveRoot: "/tmp/archive",
    reportsBytes: 64 * 1024 * 1024,
    archiveBytes: 128 * 1024 * 1024,
    archiveCount: 1,
    maxReportsMb: 100,
    budget: { usedBytes: 64 * 1024 * 1024, maxReportsBytes: 100 * 1024 * 1024, remainingBytes: 36 * 1024 * 1024, status: "within_budget" },
    overBudget: false,
    activeLocks: [{ projectId: "external", status: "locked", startedAt: new Date().toISOString() }]
  },
  archives: [{
    id: "archive_1",
    path: "/tmp/archive/archive_1",
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    sizeBytes: 128
  }],
  onDryRunRetention: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(PatrolPanel, {
  patrolJobs: [],
  patrolPlans: [{
    id: "patrol",
    title: "Daily",
    appUrl: "http://localhost:6173",
    scenarioId: "task_filter_completed",
    intervalMs: 60000,
    cron: "*/5 * * * *",
    notify: ["qa"],
    permissionProfile: { observe: true, browserControl: false, workspaceControl: false, ideTerminalControl: false, systemControl: false },
    retryPolicy: { maxRetries: 2, backoffMs: 1000 },
    escalationPolicy: { failureThreshold: 2, riskTrendThreshold: "regressed", notify: ["lead"] },
    consecutiveFailures: 1,
    riskTrend: "regressed",
    status: "stopped"
  }],
  trend: {
    totalRuns: 3,
    failedRuns: 2,
    latestVerdict: "stop_and_fix",
    riskTrend: "regressed",
    riskIncreased: true,
    summary: "风险升高"
  },
  onRunPlan: () => undefined,
  onDeletePlan: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(SecurityPanel, {
  security: {
    tokenMode: "development",
    defaultDevTokenAllowed: true,
    artifactAccess: "token-gated",
    credentialRotation: "supported"
  },
  credentials: [{
    id: "cred",
    name: "Main",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyMasked: "sk-***",
    model: "gpt-4.1",
    tags: ["judge"],
    owner: "qa",
    scopes: ["judge"],
    isDefault: true,
    rotationHistory: []
  }],
  grants: [{
    id: "grant",
    projectId: project.id,
    subject: "qa-oncall",
    role: "runner",
    tokenKind: "dev",
    scopes: ["read_project", "run_tests", "read_artifacts"],
    createdAt: new Date().toISOString()
  }],
  selectedProjectId: project.id,
  onCreateGrant: () => undefined,
  onRotateCredential: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(BotDeliveryPanel, {
  provider: "simulated",
  channel: "值班群",
  recipients: "qa-oncall",
  githubPrUrl: "",
  includeScreenshots: true,
  deliveries: [{
    id: "bot",
    createdAt: new Date().toISOString(),
    provider: "simulated",
    channel: "值班群",
    recipients: ["qa-oncall"],
    title: "failed",
    body: "blocked",
    evidenceRefs: ["ev_1"],
    blockedRelease: true,
    payloadSummary: "simulated:fail:run",
    status: "simulated"
  }],
  onProviderChange: () => undefined,
  onChannelChange: () => undefined,
  onRecipientsChange: () => undefined,
  onGithubPrUrlChange: () => undefined,
  onIncludeScreenshotsChange: () => undefined,
  onDeliver: () => undefined
})), true);

assert.equal(React.isValidElement(React.createElement(ServiceHealthPanel)), true);

assert.equal(React.isValidElement(React.createElement(JudgePanel, {
  result: {
    judgeReport: {
      source: "deterministic_judge",
      executionMode: "deterministic",
      llmStatus: "not_configured",
      policyVersion: "test",
      createdAt: new Date().toISOString(),
      planJudge: { layer: "plan", title: "Plan", verdict: "pass", summary: "ok", findings: [] },
      evidenceJudge: { layer: "evidence", title: "Evidence", verdict: "pass", summary: "ok", findings: [] },
      releaseJudge: { layer: "release", title: "Release", verdict: "needs_review", summary: "check suspect", findings: [] }
    },
    failureAttributions: [{
      id: "attr_1",
      rank: 1,
      failureClass: "product_bug",
      title: "Network failure",
      reasoning: "API changed",
      suggestedFix: "检查 API handler",
      reproductionSteps: ["open page"],
      evidenceRefs: ["ev_network_1"],
      sourceContextIds: ["src_diff"],
      confidence: "high",
      topSuspects: [{
        filePath: "src/api.ts",
        lineStart: 42,
        componentName: "api",
        apiEndpoint: "/api/tasks",
        reason: "failed network endpoint maps to changed API file",
        confidence: "high",
        evidenceRefs: ["ev_network_1"],
        sourceContextIds: ["src_diff"],
        suggestedFix: "恢复 contract"
      }]
    }]
  } as any
})), true);

assert.equal(React.isValidElement(React.createElement(ArtifactIntegrityPanel, {
  result: {
    id: "run_contract",
    verdict: "continue",
    summary: "ok",
    steps: [],
    network: [],
    console: [],
    assertions: [],
    evidence: [],
    loopEvents: [],
    riskCoverageMatrix: [],
    aggregatedVerdict: { runCount: 1, failedAssertionCount: 0, flaky: false, verdict: "continue", reason: "ok" },
    reflectionNote: "ok",
    conflictPacket: { status: "not_triggered", reason: "ok", evidenceRefs: [] },
    failureAttributions: [],
    judgeReport: {
      source: "deterministic",
      executionMode: "deterministic",
      llmStatus: "not_run",
      policyVersion: "test",
      createdAt: new Date().toISOString(),
      planJudge: { layer: "plan", title: "Plan", verdict: "pass", summary: "ok", findings: [] },
      evidenceJudge: { layer: "evidence", title: "Evidence", verdict: "pass", summary: "ok", findings: [] },
      releaseJudge: { layer: "release", title: "Release", verdict: "pass", summary: "ok", findings: [] }
    },
    reportFile: "/artifacts/runs/run_contract/report.json",
    runBundleFile: "/artifacts/runs/run_contract/run_bundle.json",
    artifactIntegrityReportFile: "/artifacts/runs/run_contract/artifact_integrity.json",
    artifactIntegrity: {
      id: "artifact_integrity_run_contract",
      runId: "run_contract",
      generatedAt: new Date().toISOString(),
      artifactRoot: "/artifacts",
      summary: {
        total: 1,
        present: 1,
        missing: 0,
        unreadable: 0,
        pathEscapes: 0,
        selfReferences: 0,
        hashed: 1
      },
      items: [{
        id: "artifact_1",
        artifactUri: "/artifacts/screenshots/run_contract/page.png",
        kind: "screenshot",
        status: "present",
        sizeBytes: 128,
        sha256: "abc123"
      }]
    }
  }
})), true);

assert.equal(React.isValidElement(React.createElement(EvidencePanel, {
  result: null,
  liveRun: null,
  displayedLoopEvents: [],
  auditStore: {
    database: "/tmp/audit.sqlite",
    schemaVersion: 4,
    userVersion: 4,
    schemaVersionMatches: true,
    migrations: [
      { version: 1, appliedAt: new Date().toISOString(), description: "initial" },
      { version: 2, appliedAt: new Date().toISOString(), description: "fingerprint" },
      { version: 3, appliedAt: new Date().toISOString(), description: "source contexts" },
      { version: 4, appliedAt: new Date().toISOString(), description: "health" }
    ],
    expectedMigrationVersions: [1, 2, 3, 4],
    missingMigrations: [],
    migrationComplete: true,
    integrityCheck: "ok",
    integrityOk: true,
    runs: 1,
    evidence: 2,
    events: 3,
    journalMode: "WAL"
  },
  commitCheck: null,
  requirementAcceptance: null,
  patrolRun: null,
  deliveries: [],
  isBusy: false,
  liveStatusText: "idle",
  onClose: () => undefined
})), true);
console.log("workbench-ui component contract tests passed.");
