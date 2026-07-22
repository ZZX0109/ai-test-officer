import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorPanel } from "../src/components/ConnectorPanel";
import { PatrolPanel } from "../src/components/PatrolPanel";
import { BenchmarkPanel } from "../src/components/BenchmarkPanel";
import { OidcSessionPanel } from "../src/components/OidcSessionPanel";
import { RunTimeline } from "../src/components/RunTimeline";
import { ProjectWizardPanel } from "../src/components/ProjectWizardPanel";
import { subscribeRunEvents } from "../src/api";

describe("Workbench interactions", () => {
  it("guides a new user through project setup without exposing technical details first", async () => {
    const detect = vi.fn();
    const apply = vi.fn();
    const diagnose = vi.fn();
    render(<ProjectWizardPanel
      projectPath="app-under-test"
      detection={{
        exists: true,
        detectedStack: ["Vite"],
        packageManagers: ["npm"],
        suggestedConfig: { startCommand: "npm run dev", healthCheckUrl: "http://localhost:6173" },
        healthCandidates: ["http://localhost:6173"],
        ports: [],
        plainLanguageFixes: [],
        warnings: []
      } as never}
      onProjectPathChange={() => undefined}
      onDetect={detect}
      onApplySuggestion={apply}
      onDiagnose={diagnose}
    />);
    expect(screen.getByText("告诉我你要测试哪个项目")).toBeTruthy();
    expect(screen.getByText(/不会修改项目代码/)).toBeTruthy();
    expect(screen.getByText("查看系统识别到的技术信息").closest("details")?.open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "使用推荐设置" }));
    await userEvent.click(screen.getByRole("button", { name: "检查能否运行" }));
    expect(apply).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it("propagates connector input and strict mode decisions", async () => {
    const requirement = vi.fn();
    const strict = vi.fn();
    render(<ConnectorPanel requirementPath="" requirementUrl="" bugTicketPath="" bugTicketUrl="" prDiffUrl="" openApiPath="" openApiUrl="" strictInput={false} hasRemoteConnectorInput={false} onRequirementPathChange={() => undefined} onRequirementUrlChange={requirement} onBugTicketPathChange={() => undefined} onBugTicketUrlChange={() => undefined} onPrDiffUrlChange={() => undefined} onOpenApiPathChange={() => undefined} onOpenApiUrlChange={() => undefined} onStrictInputChange={strict} />);
    await userEvent.type(screen.getByLabelText("需求文档 URL"), "https://example.test/requirement");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(requirement).toHaveBeenCalled();
    expect(strict).toHaveBeenCalledWith(true);
  });

  it("runs and deletes a persisted patrol plan through explicit controls", async () => {
    const run = vi.fn(); const remove = vi.fn();
    render(<PatrolPanel patrolJobs={[]} patrolPlans={[{ id: "plan-1", title: "Nightly", status: "scheduled", projectId: "demo", scenarioId: "task_filter_completed", intervalMs: 60_000, permissionProfile: { observe: true, browserControl: true, workspaceControl: false, ideTerminalControl: false, systemControl: false } } as never]} onRunPlan={run} onDeletePlan={remove} />);
    await userEvent.click(screen.getByRole("button", { name: "立即执行" }));
    await userEvent.click(screen.getByRole("button", { name: "删除计划" }));
    expect(run).toHaveBeenCalledWith("plan-1");
    expect(remove).toHaveBeenCalledWith("plan-1");
  });

  it("shows an honest blocked benchmark instead of empty metrics", () => {
    render(<BenchmarkPanel summary={{ version: "v2", status: "catalog_ready", caseCount: 18, blindCaseCount: 6, projectCount: 2, fixtureProjects: [], byProject: {}, categories: [], runtimeMetrics: { status: "blocked", completedRuns: 0, plannedRuns: 480, blockers: ["openai:credential_env_missing"], lanes: {} } }} />);
    expect(screen.getByText(/实验被阻塞/).textContent).toContain("credential_env_missing");
  });

  it("separates scheduling completion from actual test success", () => {
    render(<BenchmarkPanel summary={{ version: "v2", status: "catalog_ready", caseCount: 6, blindCaseCount: 0, projectCount: 2, fixtureProjects: [], byProject: {}, categories: [], runtimeMetrics: { status: "awaiting_blind_runs", completedRuns: 30, plannedRuns: 30, blockers: [], lanes: { "full-llm:model": { schedulingCompletionRate: 1, executionSuccessRate: 2 / 3, requirementCoverageRate: 2 / 3, gateEligibleRate: 2 / 3, recommendationAccuracy: 1 / 2, finalStatusAccuracy: 1 / 3, taskSuccessRate: 1 / 3, macroF1: 1 / 3, falseReleaseRate: 0, falseBlockRate: 1, humanReviewRate: 5 / 6, artifactIntegrityRate: 2 / 3, averageTotalTokensPerRun: 8771 } } } }} />);
    expect(screen.getByText(/调度记录完成 30\/30/).textContent).toContain("不代表测试成功");
    expect(screen.getByText("执行成功 66.7%")).toBeTruthy();
    expect(screen.getByText("任务成功 33.3%")).toBeTruthy();
    expect(screen.getByText("模型推荐正确 50.0%")).toBeTruthy();
    expect(screen.getByText("平均 Token 8,771")).toBeTruthy();
  });

  it("shows the safe development session state when OIDC is unavailable", () => {
    render(<OidcSessionPanel configured={false} authenticated={false} />);
    expect(screen.getByText("开发会话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /OIDC/ })).toBeNull();
  });

  it("renders run-scoped live events for the SSE timeline", () => {
    render(<RunTimeline displayedLoopEvents={[{
      id: "event-1",
      runId: "run-1",
      loopType: "assertion",
      title: "Artifact integrity verified",
      status: "passed",
      observedAt: new Date().toISOString(),
      observation: "artifact-1 linked to attempt-1"
    } as never]} />);
    expect(screen.getByText("Artifact integrity verified")).toBeTruthy();
    expect(screen.getByText("artifact-1 linked to attempt-1")).toBeTruthy();
  });

  it("reconnects a run-scoped SSE stream from the last event ID", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("id: 4\nevent: state\ndata: {\"id\":\"event-4\",\"type\":\"run_started\"}\n\n"))
      .mockResolvedValueOnce(new Response("id: 5\nevent: state\ndata: {\"id\":\"event-5\",\"type\":\"evidence_collecting\"}\n\n"));
    vi.stubGlobal("fetch", fetchMock);
    const received: Array<{ id?: string; type: string }> = [];
    const unsubscribe = subscribeRunEvents("run-1", (event) => received.push({ id: event.id, type: event.type }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(received).toEqual([{ id: "4", type: "state" }, { id: "5", type: "state" }]);
    expect(fetchMock.mock.calls[1]?.[1]?.headers.get("last-event-id")).toBe("4");
    unsubscribe();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
