import assert from "node:assert/strict";
import { analyzeIntake } from "../src/intakeAnalyzer.js";
import { buildPlanningConversation, type PlanningMessage } from "../src/planningConversation.js";
import type { CodeImpactGraph } from "../src/codeImpactGraph.js";
import type { BusinessCapabilityGraph } from "../src/businessCapabilityGraph.js";
import type { ProjectConfig } from "../src/types.js";

const graph: CodeImpactGraph = {
  version: "1.0",
  createdAt: "2026-07-24T00:00:00.000Z",
  repositoryRoot: "/tmp/planning-project",
  cacheHits: 0,
  explanations: [],
  nodes: [
    { id: "page_login", kind: "page", label: "src/pages/login.tsx", file: "src/pages/login.tsx", confidence: "high" },
    { id: "page_report", kind: "page", label: "src/pages/reports.tsx", file: "src/pages/reports.tsx", confidence: "high" },
    { id: "api_report", kind: "api-route", label: "/api/reports", file: "src/server.ts", confidence: "high" }
  ],
  edges: []
};

const businessGraph: BusinessCapabilityGraph = {
  version: "2.0",
  createdAt: "2026-08-11T00:00:00.000Z",
  repositoryRoot: "/tmp/planning-project",
  projectSnapshotHash: "a".repeat(64),
  sourceFileCount: 2,
  diagnostics: [],
  nodes: [
    { id: "bcg_page_orders", kind: "page", label: "订单", confidence: "high", source: { file: "src/pages/orders.tsx", line: 1, parser: "typescript-jsx", sourceHash: "b".repeat(64) } },
    { id: "bcg_call_orders", kind: "frontend-call", label: "/api/orders", confidence: "high", source: { file: "src/pages/orders.tsx", line: 6, parser: "typescript-jsx", sourceHash: "b".repeat(64) }, metadata: { route: "/api/orders" } },
    { id: "bcg_api_orders", kind: "api-route", label: "GET /api/orders", confidence: "high", source: { file: "src/server/orders.ts", line: 10, parser: "typescript", sourceHash: "c".repeat(64) }, metadata: { route: "/api/orders", method: "GET" } },
    { id: "bcg_guard", kind: "auth-guard", label: "requireAuth", confidence: "medium", source: { file: "src/server/orders.ts", line: 4, parser: "typescript", sourceHash: "c".repeat(64) } }
  ],
  edges: [
    { from: "bcg_page_orders", to: "bcg_call_orders", kind: "calls", confidence: "high", reason: "页面请求订单接口。" },
    { from: "bcg_call_orders", to: "bcg_api_orders", kind: "calls", confidence: "high", reason: "前后端路径相同。" },
    { from: "bcg_guard", to: "bcg_api_orders", kind: "guards", confidence: "medium", reason: "权限守卫。" }
  ]
};

const project: ProjectConfig = {
  id: "external_planning_project",
  name: "External Planning Project",
  projectPath: "/tmp/planning-project",
  frontendUrl: "http://127.0.0.1:5173",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z"
};

export function testPlanningConversation() {
  const requirement = "对整个项目进行全面灰度测试";
  const analysis = analyzeIntake({ requirement, diff: "", projectId: project.id, codeGraph: graph });
  const first = buildPlanningConversation({ project, message: requirement, history: [], graph, analysis });
  assert.equal(first.coverage.scope, "comprehensive");
  assert.equal(first.businessFlows.length, 3);
  assert.equal(first.coverage.autoBindable, 3);
  assert.equal(first.coverage.gaps, 0);
  assert.equal(first.phase, "draft-ready");
  assert.match(first.clarificationQuestions[0] ?? "", /测试账号|未登录/);
  assert.ok(first.businessFlows.every((flow) => flow.status === "auto-bindable"));
  // API flows must read as user-facing functions, not bare routes: no HTTP
  // method, no leading slash or /api/ path segment in the title.
  const apiFlow = first.businessFlows.find((flow) => flow.kind === "api");
  assert.ok(apiFlow, "expected at least one api flow");
  assert.match(apiFlow!.title, /接口流程$/);
  assert.doesNotMatch(apiFlow!.title, /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i, "api flow title must not expose the raw HTTP method");
  assert.doesNotMatch(apiFlow!.title, /\/api\//, "api flow title must not expose the raw /api/ route prefix");
  assert.match(first.plan.levels[0]?.paths[0]?.steps.join("\n") ?? "", /自动发现并绑定/);

  const semanticInventory = buildPlanningConversation({
    project,
    message: requirement,
    history: [],
    graph,
    capabilityGraph: businessGraph,
    analysis
  });
  const ordersFlow = semanticInventory.businessFlows.find((flow) => flow.pathVersion === "2.0");
  assert.ok(ordersFlow, "capability graph must replace directory-only flows with an auditable business path");
  assert.ok(ordersFlow?.surfaces?.includes("page"));
  assert.ok(ordersFlow?.surfaces?.includes("api"));
  assert.ok(ordersFlow?.roles?.length);
  assert.ok(ordersFlow?.sourceLocations?.some((source) => source.file === "src/server/orders.ts"));

  const noBrowserProject: ProjectConfig = {
    ...project,
    id: "external_planning_project_no_browser",
    manifest: {
      schemaVersion: "1.0",
      workspaceRoot: ".",
      capabilities: { browser: false }
    } as ProjectConfig["manifest"]
  };
  const noBrowser = buildPlanningConversation({ project: noBrowserProject, message: requirement, history: [], graph, analysis });
  assert.equal(noBrowser.coverage.autoBindable, 0);
  assert.equal(noBrowser.coverage.gaps, 3);
  assert.ok(noBrowser.businessFlows.every((flow) => flow.status === "coverage-gap"));

  const destructive = buildPlanningConversation({
    project,
    message: "测试批量删除和发布功能",
    history: [],
    graph,
    analysis
  });
  assert.equal(destructive.phase, "clarifying");
  assert.match(destructive.clarificationQuestions.join("\n"), /沙盒测试数据|禁止执行/);

  const history: PlanningMessage[] = [{
    id: "answer",
    role: "user",
    content: "无需登录，只验证未登录状态；使用沙盒测试数据。",
    createdAt: "2026-07-24T00:00:01.000Z"
  }];
  const second = buildPlanningConversation({ project, message: "继续生成计划", history, graph, analysis });
  assert.equal(second.phase, "draft-ready");
  assert.equal(second.plan.levels[0]?.paths.length, 3);

  const assistantHintHistory: PlanningMessage[] = [
    {
      id: "assistant_hint",
      role: "assistant",
      content: "输入“全面扫描”或“灰度测试”可直接列出完整测试清单。",
      createdAt: "2026-07-24T00:00:02.000Z"
    }
  ];
  const targetedAfterHint = buildPlanningConversation({
    project,
    message: "建立一个最简单的工作流进行测试",
    history: assistantHintHistory,
    graph,
    analysis
  });
  assert.equal(targetedAfterHint.coverage.scope, "targeted", "assistant hint text must not turn a targeted request into a full scan");
  assert.match(targetedAfterHint.reply, /根据你的测试目标从代码中定位/);

  const waitingForSmoke = buildPlanningConversation({
    project,
    message: requirement,
    history: [],
    graph,
    analysis,
    discoveryReadiness: {
      status: "waiting",
      checkedUrl: project.frontendUrl,
      attempts: 0,
      maxAttempts: 2,
      reason: "项目正在启动",
      retryable: true,
      runtimeStatus: "starting"
    }
  });
  assert.equal(waitingForSmoke.phase, "draft-ready");
  assert.equal(waitingForSmoke.businessFlows.length, 3, "comprehensive scans retain the code-derived inventory while runtime preparation waits");
  assert.equal(waitingForSmoke.coverage.discovered, 3);
  assert.equal(waitingForSmoke.coverage.autoBindable, 3);
  assert.match(waitingForSmoke.reply, /代码全面扫描已完成/);
  assert(waitingForSmoke.businessFlows.every((flow) => flow.status === "auto-bindable"));

  const targetedWhileStarting = buildPlanningConversation({
    project,
    message: "测试订单审批功能",
    history: [],
    graph,
    capabilityGraph: businessGraph,
    analysis,
    discoveryReadiness: {
      status: "waiting",
      checkedUrl: project.frontendUrl,
      attempts: 0,
      maxAttempts: 2,
      reason: "项目正在启动",
      retryable: true,
      runtimeStatus: "starting"
    }
  });
  assert.ok(targetedWhileStarting.businessFlows.some((flow) => flow.pathVersion === "2.0"), "targeted planning remains source-grounded while runtime starts");
  assert.match(targetedWhileStarting.reply, /代码定向分析已完成/);

  const readyForDiscovery = buildPlanningConversation({
    project,
    message: requirement,
    history: [],
    graph,
    analysis,
    discoveryReadiness: {
      status: "ready",
      checkedUrl: project.frontendUrl,
      attempts: 1,
      maxAttempts: 2,
      reason: "connectivity_smoke_passed:http_200",
      retryable: false,
      runtimeStatus: "running",
      httpStatus: 200
    }
  });
  assert.equal(readyForDiscovery.businessFlows.length, 3, "coverage expands only after connectivity smoke passes");

  // A full inventory is not an execution batch. Large projects retain every
  // source node, but related code symbols are grouped into bounded business
  // paths so confirmation does not create hundreds of synchronous LLM loops.
  const largeGraph: CodeImpactGraph = {
    ...graph,
    nodes: Array.from({ length: 241 }, (_, index) => ({
      id: `page_${index}`,
      kind: "page" as const,
      label: `src/pages/page-${index}.tsx`,
      file: `src/pages/page-${index}.tsx`,
      confidence: "high" as const
    }))
  };
  const largeAnalysis = analyzeIntake({ requirement, diff: "", projectId: project.id, codeGraph: largeGraph });
  const largeInventory = buildPlanningConversation({
    project,
    message: requirement,
    history,
    graph: largeGraph,
    analysis: largeAnalysis,
    discoveryReadiness: {
      status: "ready",
      checkedUrl: project.frontendUrl,
      attempts: 1,
      maxAttempts: 2,
      reason: "connectivity_smoke_passed:http_200",
      retryable: false,
      runtimeStatus: "running",
      httpStatus: 200
    }
  });
  assert.equal(largeInventory.coverage.sourceCandidates, 241, "all source candidates remain auditable");
  assert(largeInventory.businessFlows.length < 20, "large flat code inventories should be grouped into bounded business paths");
  assert.equal(largeInventory.businessFlows.flatMap((flow) => flow.sourceNodeIds ?? []).length, 241);
  assert.equal(largeInventory.plan.levels[0]?.paths.length, largeInventory.businessFlows.length);
}
