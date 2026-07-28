import assert from "node:assert/strict";
import { analyzeIntake } from "../src/intakeAnalyzer.js";
import { buildPlanningConversation, type PlanningMessage } from "../src/planningConversation.js";
import type { CodeImpactGraph } from "../src/codeImpactGraph.js";
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
  assert.match(first.plan.levels[0]?.paths[0]?.steps.join("\n") ?? "", /自动发现并绑定/);

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
}
