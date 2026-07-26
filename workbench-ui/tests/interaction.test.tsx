import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorPanel } from "../src/components/ConnectorPanel";
import { PatrolPanel } from "../src/components/PatrolPanel";
import { BenchmarkPanel } from "../src/components/BenchmarkPanel";
import { OidcSessionPanel } from "../src/components/OidcSessionPanel";
import { RunTimeline } from "../src/components/RunTimeline";
import { buildFileTree, ProjectWizardPanel } from "../src/components/ProjectWizardPanel";
import { ProjectPanel } from "../src/components/ProjectPanel";
import { subscribeRunEvents } from "../src/api";

describe("Workbench interactions", () => {
  it("shows login settings only for detected login projects and exposes one run action", async () => {
    const project = {
      id: "demo",
      name: "Demo",
      projectPath: "/tmp/demo",
      frontendUrl: "http://127.0.0.1:5173",
      healthCheckUrl: "http://127.0.0.1:5173",
      startCommand: "npm run dev",
      manifest: {
        execution: { mode: "oci", image: "node:22-bookworm-slim", engine: "docker" }
      }
    };
    const detection = {
      projectPath: project.projectPath,
      exists: true,
      executionReady: true,
      detectedStack: ["vite"],
      packageManagers: ["npm"],
      loginCapability: { detected: false, confidence: "none", signals: [] },
      suggestedConfig: project,
      ports: [],
      healthCandidates: [],
      warnings: [],
      plainLanguageFixes: []
    };
    const props = {
      projects: [project],
      selectedProjectId: project.id,
      draft: project,
      detection,
      onSelect: vi.fn(),
      onDraftChange: vi.fn(),
      onRunDiagnosis: vi.fn(),
      onStop: vi.fn(),
      onSaveLoginCredential: vi.fn()
    };
    const view = render(<ProjectPanel {...props as never} />);
    expect(screen.queryByText("登录与测试账号（需要登录时配置）")).toBeNull();
    expect(screen.getByRole("button", { name: "诊断并运行" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /运行方式/ }) as HTMLInputElement).value).toContain("安全沙盒");
    expect(screen.getByText(/源码只读挂载/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "仅检查连接" })).toBeNull();
    expect(screen.queryByRole("button", { name: "检查能否运行" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存设置" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "诊断并运行" }));
    expect(props.onRunDiagnosis).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在启动…" })).toBeTruthy();

    view.rerender(<ProjectPanel {...{
      ...props,
      detection: {
        ...detection,
        loginCapability: { detected: true, confidence: "high", signals: ["src/pages/login.tsx"] }
      }
    } as never} />);
    await userEvent.click(screen.getByText("登录与测试账号（需要登录时配置）"));
    fireEvent.change(screen.getByLabelText("测试账号"), { target: { value: "tester@example.test" } });
    fireEvent.change(screen.getByLabelText("测试密码"), { target: { value: "secret-for-test" } });
    await userEvent.click(screen.getByRole("button", { name: "保存测试账号" }));
    expect(props.onSaveLoginCredential).toHaveBeenCalledWith({
      username: "tester@example.test",
      password: "secret-for-test",
      usernameEnv: "E2E_USERNAME",
      passwordEnv: "E2E_PASSWORD"
    });
  });

  it("shows recent projects above inline upload controls and the folder tree after selection", async () => {
    const detect = vi.fn();
    const pathChange = vi.fn();
    const selectProject = vi.fn();
    render(<ProjectWizardPanel
      projects={[{ id: "user-project", name: "之前的项目", projectPath: "/tmp/user-project", frontendUrl: "http://127.0.0.1:3000" }]}
      selectedProjectId=""
      projectPath=""
      detection={null}
      onSelectProject={selectProject}
      onProjectPathChange={pathChange}
      onDetect={detect}
    />);
    expect(screen.getByText("之前接入的项目")).toBeTruthy();
    expect(screen.getByRole("option", { name: "之前的项目" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "上传新项目" })).toBeTruthy();
    expect(screen.queryByText("第 1 步")).toBeNull();
    expect((screen.getByRole("button", { name: "识别项目" }) as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByLabelText("选择项目文件夹") as HTMLInputElement;
    const file = new File(["export default {}"], "src/main.tsx", { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", { value: "demo-project/src/main.tsx" });
    await userEvent.upload(input, [file]);
    expect(await screen.findByRole("button", { name: "收起 demo-project" })).toBeTruthy();
    const sourceDirectory = screen.getByRole("button", { name: "展开 src" });
    await userEvent.click(sourceDirectory);
    expect(screen.getByText("main.tsx")).toBeTruthy();
    expect(pathChange).toHaveBeenCalledWith("demo-project");
    expect(screen.getByRole("button", { name: "识别项目" })).toBeTruthy();
    expect(selectProject).toHaveBeenCalledWith("");
  });

  it("shows a bounded startup countdown and a differentiated failure", () => {
    const project = {
      id: "startup-demo",
      name: "Startup Demo",
      projectPath: "/tmp/startup-demo",
      frontendUrl: "http://127.0.0.1:5173",
      healthCheckUrl: "http://127.0.0.1:5173",
      startCommand: "npm run dev"
    };
    const detection = {
      projectPath: project.projectPath,
      exists: true,
      executionReady: true,
      detectedStack: ["vite"],
      packageManagers: ["npm"],
      loginCapability: { detected: false, confidence: "none", signals: [] },
      suggestedConfig: project,
      ports: [],
      healthCandidates: [],
      warnings: [],
      plainLanguageFixes: []
    };
    const baseProps = {
      projects: [project],
      selectedProjectId: project.id,
      draft: project,
      detection,
      connection: null,
      onSelect: vi.fn(),
      onDraftChange: vi.fn(),
      onRunDiagnosis: vi.fn(),
      onStop: vi.fn(),
      onSaveLoginCredential: vi.fn()
    };
    const view = render(<ProjectPanel {...{
      ...baseProps,
      status: {
        projectId: project.id,
        status: "starting",
        phase: "waiting_for_health",
        phaseStartedAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        elapsedMs: 1_000,
        remainingMs: 29_000,
        progressPercent: 10,
        message: "waiting"
      }
    } as never} />);
    expect(screen.getByText("正在等待项目地址响应")).toBeTruthy();
    expect(screen.getByText(/最多还需约 30 秒/)).toBeTruthy();

    view.rerender(<ProjectPanel {...{
      ...baseProps,
      status: {
        projectId: project.id,
        status: "failed",
        phase: "failed",
        failureReason: "port_conflict",
        message: "EADDRINUSE"
      }
    } as never} />);
    expect(screen.getByText(/目标端口已被其他进程占用/)).toBeTruthy();
  });

  it("indexes a large project tree without dropping files", () => {
    const paths = Array.from({ length: 20_000 }, (_, index) => `large-project/node_modules/pkg-${Math.floor(index / 100)}/file-${index}.js`);
    paths.push("large-project/package.json", "large-project/src/main.tsx");
    const tree = buildFileTree(paths);
    const root = tree.find((node) => node.name === "large-project");
    const dependencyDirectory = root?.children.find((node) => node.name === "node_modules");
    const indexedFiles = dependencyDirectory?.children.reduce((total, directory) => total + directory.children.length, 0);
    expect(indexedFiles).toBe(20_000);
    expect(root?.children.some((node) => node.name === "package.json")).toBe(true);
    expect(root?.children.some((node) => node.name === "src")).toBe(true);
  });

  it("keeps the recent-project control visible when the Agent project list is unavailable", () => {
    const view = render(<ProjectWizardPanel
      projects={[]}
      selectedProjectId=""
      projectPath=""
      detection={null}
      onSelectProject={() => undefined}
      onProjectPathChange={() => undefined}
      onDetect={() => undefined}
      projectListNotice="Agent 暂时未连接，历史项目列表目前无法读取。"
    />);
    expect(view.container.textContent).toContain("之前接入的项目");
    expect((view.container.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect(view.container.textContent).toContain("Agent 暂时未连接，历史项目列表目前无法读取。");
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
