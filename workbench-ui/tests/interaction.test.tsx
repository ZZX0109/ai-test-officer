import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorPanel } from "../src/components/ConnectorPanel";
import { PatrolPanel } from "../src/components/PatrolPanel";
import { BenchmarkPanel } from "../src/components/BenchmarkPanel";
import { OidcSessionPanel } from "../src/components/OidcSessionPanel";
import { RunTimeline } from "../src/components/RunTimeline";
import { ProjectWizardPanel } from "../src/components/ProjectWizardPanel";
import { buildFileTree } from "../src/projectFileTree";
import { ProjectPanel } from "../src/components/ProjectPanel";
import { RunAssistantPanel } from "../src/components/RunAssistantPanel";
import { KnowledgeBasis } from "../src/components/KnowledgeBasis";
import { AssistantReasoningSummary } from "../src/components/AssistantReasoningSummary";
import { AssistantConversationMessage } from "../src/components/AssistantConversationMessage";
import { DiscoveryPanel } from "../src/components/DiscoveryPanel";
import { chatWithTestAssistant, createVisualRun, generatePlan, subscribeRunEvents } from "../src/api";
import { commandFallbackAction, describeRunActivity, isUserActionableInterrupt, upsertAssistantProgress } from "../src/workbenchLogic";
import { isRestorableProjectRun, rankProjectRunCandidates } from "../src/activeRunCache";
import type { DiscoveryScanResult } from "../src/types";
import { pointInSharedBrowser } from "../src/sharedBrowserGeometry";

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div aria-label="代码差异">
      <pre>{original}</pre>
      <pre>{modified}</pre>
    </div>
  )
}));

import { RepairWorkspace } from "../src/components/RepairWorkspace";

describe("Workbench interactions", () => {
  it("keeps one visible thinking state until the Graph reaches a real terminal state", () => {
    const activity = describeRunActivity({
      runId: "run-1",
      runState: "running",
      isRunning: true,
      planningPhase: "running",
      projection: {
        schemaVersion: "1.0",
        runId: "run-1",
        threadId: "run-1",
        mode: "active",
        status: "running",
        currentNode: "execute-browser-action",
        completedNodes: [],
        progress: 0.5,
        tokenUsage: 100,
        updatedAt: "2026-08-14T02:00:00.000Z"
      }
    });
    expect(activity).toMatchObject({
      action: "操作当前页面",
      streaming: true,
      phase: "acting"
    });
    expect(activity?.content).toContain("测试尚未结束");
    expect(describeRunActivity({
      runId: "run-1",
      runState: "completed",
      isRunning: false,
      planningPhase: "ready",
      projection: null
    })).toBeNull();
  });

  it("presents provider throttling as an in-progress retry rather than a conclusion", () => {
    const activity = describeRunActivity({
      runId: "run-rate-limited",
      runState: "running",
      isRunning: true,
      planningPhase: "running",
      projection: {
        schemaVersion: "1.0",
        runId: "run-rate-limited",
        threadId: "run-rate-limited",
        mode: "active",
        status: "running",
        currentNode: "decide-browser-action",
        completedNodes: [],
        progress: 0.5,
        tokenUsage: 100,
        lastError: { code: "provider_http_429", message: "Rate limit exceeded", node: "decide-browser-action" },
        updatedAt: "2026-08-14T02:00:00.000Z"
      }
    });
    expect(activity?.streaming).toBe(true);
    expect(activity?.content).toContain("正在退避");
    expect(activity?.action).toContain("限流");
  });

  it("renders a streaming assistant activity as a labelled thinking row", () => {
    render(<AssistantConversationMessage message={{
      id: "progress:run:run-1",
      role: "assistant",
      content: "正在思考 · 操作当前页面\n测试尚未结束。",
      createdAt: "2026-08-14T02:00:00.000Z",
      streaming: true
    }} />);
    expect(screen.getByLabelText("AI 正在思考并执行")).toBeTruthy();
    expect(screen.getByText("正在思考")).toBeTruthy();
    expect(screen.getByText("测试尚未结束。")).toBeTruthy();
  });

  it("updates one browser progress message instead of repeating observations", () => {
    const first = upsertAssistantProgress([], {
      id: "ignored",
      role: "assistant",
      content: "正在观察登录页",
      createdAt: "2026-08-13T01:00:00.000Z"
    }, "browser:run-1");
    const second = upsertAssistantProgress(first, {
      id: "ignored-again",
      role: "assistant",
      content: "正在点击登录按钮",
      createdAt: "2026-08-13T01:00:01.000Z"
    }, "browser:run-1");
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe("progress:browser:run-1");
    expect(second[0]?.content).toBe("正在点击登录按钮");
  });

  it("maps live canvas clicks back to Playwright viewport coordinates", () => {
    const bounds = { left: 10, top: 20 } as DOMRect;
    expect(pointInSharedBrowser(410, 270, bounds, {
      left: 0,
      top: 0,
      width: 800,
      height: 500,
      x: 0,
      y: 0,
      imageWidth: 1600,
      imageHeight: 1000
    })).toMatchObject({ x: 800, y: 500, imageWidth: 1600, imageHeight: 1000 });
  });

  it("never restores terminal history as the current project's active run", () => {
    expect(rankProjectRunCandidates("run_cached_active", [
      { runId: "run_new_pass", timestamp: "2026-08-12T15:04:38.568Z" },
      { runId: "run_older_failure", timestamp: "2026-08-12T13:53:37.328Z" }
    ])).toEqual(["run_cached_active"]);
    expect(rankProjectRunCandidates(undefined, [
      { runId: "run_new_pass", timestamp: "2026-08-12T15:04:38.568Z" }
    ])).toEqual([]);
  });

  it("restores only fresh nonterminal runs from the same project", () => {
    const now = Date.parse("2026-08-13T08:00:00.000Z");
    expect(isRestorableProjectRun({
      id: "run_current",
      state: "running",
      updatedAt: "2026-08-13T07:59:00.000Z",
      input: { projectId: "andflow_current" }
    }, "andflow_current", now)).toBe(true);
    expect(isRestorableProjectRun({
      id: "run_other",
      state: "running",
      updatedAt: "2026-08-13T07:59:00.000Z",
      input: { projectId: "another_project" }
    }, "andflow_current", now)).toBe(false);
    expect(isRestorableProjectRun({
      id: "run_stale",
      state: "queued",
      updatedAt: "2026-08-13T03:21:20.296Z",
      input: { projectId: "andflow_current" }
    }, "andflow_current", now)).toBe(false);
  });

  it("never presents the Worker's execution-result rendezvous as a user decision", () => {
    expect(isUserActionableInterrupt({
      id: "interrupt-worker",
      runId: "run-worker",
      kind: "execution-result",
      status: "pending",
      title: "等待执行 Worker",
      detail: "等待结果",
      requestedCapabilities: [],
      payload: {},
      createdAt: "2026-08-13T07:00:00.000Z"
    })).toBe(false);
    expect(isUserActionableInterrupt({
      id: "interrupt-credential",
      runId: "run-worker",
      kind: "credential",
      status: "pending",
      title: "需要测试账号",
      detail: "登录后继续",
      requestedCapabilities: ["credential"],
      payload: {},
      createdAt: "2026-08-13T07:00:00.000Z"
    })).toBe(true);
  });

  it("turns plain-language test commands into confirmable actions", () => {
    expect(commandFallbackAction("先继续其他可以执行的测试")).toBe("continue-safe-paths");
    expect(commandFallbackAction("请重试刚才失败的链路")).toBe("retry-failed-path");
    expect(commandFallbackAction("把测试暂停一下", "running")).toBe("pause-run");
    expect(commandFallbackAction("继续测试", "paused")).toBe("resume-run");
    expect(commandFallbackAction("为什么会失败？", "blocked")).toBeUndefined();
  });

  it("normalizes runtime-only coverage before creating a Run", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run: { id: "run_runtime_login", state: "queued", version: 1 }
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await createVisualRun("http://127.0.0.1:55531/", {
      observe: true,
      browserControl: true,
      sourceRead: false,
      sandboxWrite: false,
      sandboxCommand: false,
      networkInstall: false,
      hostApply: false,
      artifactExport: false
    }, undefined, {
      projectId: "andflow_current",
      coverageInventory: [{
        id: "flow_login_gate",
        title: "登录并进入应用",
        status: "auto-bindable",
        kind: "page",
        target: "/signin",
        sourceNodeIds: [],
        sourceCount: 0
      }],
      dynamicBrowser: true
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.input.coverageInventory[0].sourceCount).toBe(1);
  });

  it("generates a plan through the real project-scoped API contract", async () => {
    const responsePlan = {
      sessionName: "Generated plan",
      risks: [],
      levels: []
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      source: "llm",
      message: "generated",
      plan: responsePlan,
      provenance: {
        source: "llm",
        model: "gpt-test",
        promptVersion: "planner-v2",
        compilationStatus: "validated"
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const response = await generatePlan({
      projectId: "project-1",
      requirement: "验证登录",
      diff: "",
      credentialId: "credential-1"
    }, { signal: controller.signal });
    expect(response.plan).toEqual(responsePlan);
    expect(response.provenance?.compilationStatus).toBe("validated");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ projectId: "project-1", requirement: "验证登录" });
    expect(init.signal).toBe(controller.signal);
  });

  it("reviews a sandbox diff, validates it and keeps host apply disabled by default", async () => {
    const loadFile = vi.fn().mockResolvedValue({
      path: "src/app.ts",
      original: "export const value = 1;",
      content: "export const value = 2;",
      version: 1,
      risk: "low",
      riskReasons: [],
      editable: true
    });
    const validate = vi.fn().mockResolvedValue({});
    const apply = vi.fn().mockResolvedValue({});
    render(<RepairWorkspace
      session={{
        schemaVersion: "1.0",
        id: "repair-1",
        runId: "run-1",
        projectId: "project-1",
        status: "editing",
        baseSourceSha256: "a".repeat(64),
        workspaceRoot: "/sandbox/project",
        summary: "修复一个断言失败",
        failureClass: "product-bug",
        files: [{
          path: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          risk: "low",
          riskReasons: [],
          editable: true,
          version: 1
        }],
        iteration: 1,
        maxFiles: 20,
        maxChangedLines: 2000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }}
      onLoadFile={loadFile}
      onSaveFile={vi.fn()}
      onValidate={validate}
      onExport={vi.fn()}
      onApply={apply}
      onClose={vi.fn()}
    />);
    expect(await screen.findByLabelText("代码差异")).toBeTruthy();
    expect(screen.getAllByText("src/app.ts").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "重新验证" }));
    expect(validate).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "应用到原项目" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  });
  it("collects non-secret run feedback and redirects passwords to encrypted account settings", async () => {
    const submit = vi.fn();
    const configure = vi.fn();
    render(<RunAssistantPanel
      message="登录解析失败，需要测试账号。"
      blocked
      authRequired
      onSubmit={submit}
      onConfigureCredentials={configure}
    />);
    expect(screen.getByText("登录解析失败，需要测试账号。")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "配置测试账号" }));
    expect(configure).toHaveBeenCalledTimes(1);

    const feedback = screen.getByLabelText("向 AI 测试助手反馈");
    await userEvent.type(feedback, "请改为验证公开页面");
    await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
    expect(submit).toHaveBeenCalledWith("请改为验证公开页面");

    await userEvent.type(feedback, "密码: do-not-store-this");
    await userEvent.click(screen.getByRole("button", { name: "发送给 AI" }));
    expect(screen.getByText(/检测到疑似密码/)).toBeTruthy();
    expect((feedback as HTMLTextAreaElement).value).toBe("");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledTimes(2);
  });

  it("offers a new run after the encrypted test account is ready", async () => {
    const retry = vi.fn();
    render(<RunAssistantPanel
      message="测试账号已加密保存。"
      blocked
      credentialReady
      onSubmit={() => undefined}
      onConfigureCredentials={() => undefined}
      onRetryWithCredentials={retry}
    />);
    expect(screen.getByText("账号已就绪")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "使用账号重新测试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps failed-path repair actionable without asking the user for technical details", async () => {
    const repair = vi.fn();
    const editPlan = vi.fn();
    const view = render(<RunAssistantPanel
      message="3 条失败链路已保留，其他测试继续执行。"
      blocked
      autoRepairAvailable
      onAutoRepair={repair}
      onEditPlan={editPlan}
      onSubmit={() => undefined}
      onConfigureCredentials={() => undefined}
    />);
    const panel = within(view.container);
    expect(panel.getByText("可自动处理")).toBeTruthy();
    expect(panel.getByLabelText("向 AI 测试助手反馈")).toBeTruthy();
    await userEvent.click(panel.getByRole("button", { name: "分析并修复失败链路" }));
    expect(repair).toHaveBeenCalledTimes(1);
    await userEvent.click(panel.getByRole("button", { name: "修改测试范围" }));
    expect(editPlan).toHaveBeenCalledTimes(1);
  });

  it("renders review controls separately from the assistant conversation", () => {
    const view = render(<RunAssistantPanel
      message="This explanation belongs in the assistant message stream."
      reviewRequired
      reviewReason=""
      onReviewReasonChange={() => undefined}
      onAcceptRisk={() => undefined}
      onSubmit={() => undefined}
      onConfigureCredentials={() => undefined}
      conversationVisible={false}
    />);
    const panel = within(view.container);
    expect(panel.queryByText("This explanation belongs in the assistant message stream.")).toBeNull();
    expect(panel.queryByLabelText("向 AI 测试助手反馈")).toBeNull();
    expect(panel.getByText("需要人工裁决")).toBeTruthy();
    expect(panel.getByLabelText("裁决原因")).toBeTruthy();
  });

  it("proactively offers current or dedicated API credentials without accepting secrets in chat", async () => {
    const bind = vi.fn();
    const openSettings = vi.fn();
    render(<RunAssistantPanel
      message="检测到被测项目需要 OPENAI_API_KEY。"
      apiCredentialRequired
      apiCredentialEnvNames={["OPENAI_API_KEY"]}
      credentials={[
        { id: "cred-default", name: "测试官默认模型", provider: "openai-compatible", baseUrl: "https://example.test/v1", apiKeyMasked: "****", model: "model-a", tags: [], isDefault: true },
        { id: "cred-project", name: "项目专用", provider: "openai-compatible", baseUrl: "https://project.test/v1", apiKeyMasked: "****", model: "model-b", tags: [], isDefault: false }
      ]}
      defaultCredentialId="cred-default"
      onSubmit={() => undefined}
      onConfigureCredentials={() => undefined}
      onBindApiCredential={bind}
      onOpenApiSettings={openSettings}
    />);
    await userEvent.click(screen.getByRole("button", { name: "沿用当前测试模型凭据" }));
    expect(bind).toHaveBeenCalledWith("cred-default", "test-system");
    await userEvent.selectOptions(screen.getByLabelText("选择项目专用 API Key"), "cred-project");
    await userEvent.click(screen.getByRole("button", { name: "使用单独凭据" }));
    expect(bind).toHaveBeenCalledWith("cred-project", "dedicated");
    await userEvent.click(screen.getByRole("button", { name: "添加新的 API Key" }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps project login fields out of project settings until a plan requires them", async () => {
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
      onRunDiagnosis: vi.fn(() => new Promise<void>(() => undefined)),
      onStop: vi.fn()
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
    expect(screen.getByText("登录与测试账号（在开始测试时配置）")).toBeTruthy();
    expect(screen.queryByLabelText("测试账号")).toBeNull();
    expect(screen.queryByLabelText("测试密码")).toBeNull();
    expect(screen.getByText(/只有本次测试计划包含登录步骤/)).toBeTruthy();

    view.rerender(<ProjectPanel {...{
      ...props,
      detection,
      revealLoginSettings: true
    } as never} />);
    expect(screen.getByText("登录与测试账号（在开始测试时配置）")).toBeTruthy();
    expect((screen.getByText("登录与测试账号（在开始测试时配置）").parentElement as HTMLDetailsElement).open).toBe(true);
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
      timestamp: new Date().toISOString(),
      observation: "artifact-1 linked to attempt-1",
      action: "verify_artifact_integrity",
      evidenceRefs: ["artifact-1"]
    } as never]} />);
    expect(screen.getByText("Artifact integrity verified")).toBeTruthy();
    expect(screen.getByText("artifact-1 linked to attempt-1")).toBeTruthy();
    const details = screen.getByText("Artifact integrity verified").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Artifact integrity verified"));
    expect(details?.open).toBe(true);
    expect(screen.getByText("verify_artifact_integrity")).toBeTruthy();
    expect(screen.getByText("artifact-1")).toBeTruthy();
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

  it("sends run questions to the conversational assistant without regenerating a plan", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      assistant: {
        reply: "当前运行已完成，证据完整。",
        intent: "status-question",
        suggestedAction: "none",
        requiresConfirmation: false,
        reasoningSummary: {
          phase: "completed",
          observations: ["运行已完成", "证据完整性校验通过"],
          assessment: "当前没有需要用户处理的阻塞项。",
          nextStep: "查看最终报告。",
          userAction: "无需操作。",
          confidence: "high"
        }
      },
      call: {
        id: "call-1",
        model: "gpt-5.1-codex",
        provider: "openai-compatible",
        status: "passed",
        durationMs: 1200,
        usage: { totalTokens: 88 }
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await chatWithTestAssistant({
      projectId: "psyexpgen_2",
      message: "测试情况如何？",
      credentialId: "cred-sophnet",
      history: [],
      context: {
        runState: "completed",
        finalStatus: "pass",
        evidenceCount: 18,
        failedAssertions: []
      }
    });
    expect(response.assistant.intent).toBe("status-question");
    expect(response.assistant.reply).toContain("证据完整");
    expect(response.assistant.reasoningSummary?.assessment).toContain("没有需要用户处理");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/assistant/chat");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/api/planning/conversation");
    vi.unstubAllGlobals();
  });

  it("shows an auditable AI decision summary without exposing hidden reasoning", () => {
    render(<AssistantReasoningSummary message={{
      id: "assistant-summary-1",
      role: "assistant",
      content: "我需要你确认测试账号。",
      createdAt: new Date().toISOString(),
      reasoningSummary: {
        phase: "waiting-user",
        observations: ["登录页面返回 401", "当前运行没有可用的测试账号句柄"],
        assessment: "这是凭据缺失，不是产品功能失败。",
        nextStep: "绑定一条加密保存的测试账号后恢复当前运行。",
        userAction: "请点击“配置测试账号”，不要在对话中粘贴密码。",
        confidence: "high"
      }
    }} />);
    expect(screen.getByText("查看处理依据")).toBeTruthy();
    expect((screen.getByText("查看处理依据").closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByText("查看处理依据"));
    expect(screen.getByText("这是凭据缺失，不是产品功能失败。")).toBeTruthy();
    expect(screen.getByText(/请点击“配置测试账号”/)).toBeTruthy();
    expect(screen.getByText(/不展示模型内部思维链/)).toBeTruthy();
  });

  it("keeps raw runtime diagnostics out of the visible reasoning summary", () => {
    const view = render(<AssistantReasoningSummary message={{
      id: "assistant-summary-error",
      role: "assistant",
      content: "截图失败，其他路径继续。",
      createdAt: new Date().toISOString(),
      reasoningSummary: {
        phase: "diagnosing",
        observations: ["action_binding_failure: page.screenshot: Timeout 30000ms exceeded. Call log: waiting for fonts"],
        assessment: "{\"error\":\"Validation failed\",\"fieldErrors\":{\"claims\":[\"too long\"]}}",
        nextStep: "保留机器结论并诊断当前链路。",
        userAction: "无需操作。",
        confidence: "high"
      }
    }} />);
    const summary = within(view.container);
    fireEvent.click(summary.getByText("查看处理依据"));
    expect(summary.getByText("模型返回内容未通过结构校验，机器事实和测试证据不受影响。")).toBeTruthy();
    expect(summary.getByText("页面截图步骤超过等待时间，已有证据已保留。")).toBeTruthy();
    expect(summary.queryByText(/Timeout 30000ms exceeded/)).toBeNull();
  });

  it("presents model failures as a readable chat reply and folds raw diagnostics", () => {
    render(<AssistantConversationMessage message={{
      id: "assistant-error-1",
      role: "assistant",
      content: "AI解释暂不可用 ({\"error\":\"Validation failed\",\"fieldErrors\":{\"claims\":[\"String must contain at most 2000 character(s)\"]}})",
      createdAt: new Date().toISOString()
    }} />);
    expect(screen.getByText(/没有通过格式校验/)).toBeTruthy();
    expect((screen.getByText("查看技术详情").closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByText("查看技术详情"));
    expect(screen.getByText(/String must contain at most 2000/)).toBeTruthy();
  });

  it("shows a failed smoke as not started and hides untrusted bulk suggestions", () => {
    const discovery = {
      id: "discovery-failed-smoke",
      createdAt: new Date().toISOString(),
      target: { frontendUrl: "http://127.0.0.1:61770" },
      page: {
        url: "http://127.0.0.1:61770",
        title: "",
        headings: [],
        links: [],
        buttons: [],
        inputs: [],
        forms: [],
        testIds: []
      },
      networkEndpoints: [],
      openApiOperations: [],
      observation: {
        requestedUrl: "http://127.0.0.1:61770",
        finalUrl: "http://127.0.0.1:61770",
        startedAt: new Date().toISOString(),
        capturedAt: new Date().toISOString(),
        durationMs: 8_000,
        stage: "dom-ready",
        status: "failed",
        navigation: { documentCommitted: true, httpStatus: 200 },
        document: { readyState: "complete", interactiveElementCount: 0 },
        console: [],
        pageErrors: [],
        failedRequests: [],
        diagnosis: {
          summary: "页面打开，但没有出现可操作控件。",
          likelyCauses: ["前端尚未完成渲染"],
          retryable: false,
          userActionRequired: false
        }
      },
      suggestions: [{
        id: "phantom-flow",
        title: "不应显示的 200 条候选流程",
        riskKind: "navigation",
        reason: "smoke 未通过",
        suggestedScenarioId: "phantom",
        selectors: {},
        actions: [],
        oracles: [],
        evidenceRequirements: [],
        humanReviewRequired: true
      }],
      drafts: [],
      status: "failed",
      message: "没有关键控件",
      orchestration: {
        status: "failed",
        checkedUrl: "http://127.0.0.1:61770",
        attempts: 2,
        maxAttempts: 2,
        discoveryAttempts: 2,
        reason: "页面打开，但没有出现可操作控件。",
        retryable: false,
        runtimeStatus: "running",
        httpStatus: 200
      }
    } satisfies DiscoveryScanResult;

    const view = render(<DiscoveryPanel
      discovery={discovery}
      drafts={[]}
      onScan={() => undefined}
      onProbeDraft={() => undefined}
      onApproveDraft={() => undefined}
    />);
    const panel = within(view.container);
    expect(panel.getByText("状态：测试尚未开始")).toBeTruthy();
    expect(panel.getByText(/没有生成大批不可执行流程/)).toBeTruthy();
    expect(panel.queryByText("不应显示的 200 条候选流程")).toBeNull();
    const technical = panel.getAllByText("查看技术详情")[0]?.closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    view.unmount();
  });

  it("summarizes raw connection diagnostics and keeps the call log folded", () => {
    const view = render(<AssistantConversationMessage message={{
      id: "assistant-connection-failure",
      role: "assistant",
      content: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:61770/ Call log: navigating",
      createdAt: new Date().toISOString()
    }} />);
    const message = within(view.container);
    expect(message.getByText(/遇到的问题：测试页面当前无法连接/)).toBeTruthy();
    const technical = message.getByText("查看技术详情").closest("details") as HTMLDetailsElement;
    expect(technical.open).toBe(false);
    fireEvent.click(message.getByText("查看技术详情"));
    expect(technical.open).toBe(true);
    expect(message.getByText(/Call log: navigating/)).toBeTruthy();
    view.unmount();
  });

  it("keeps a failed model call actionable with a fact-based fallback reply", () => {
    render(<AssistantConversationMessage message={{
      id: "assistant-fallback-1",
      role: "assistant",
      content: [
        "遇到的问题：实验创建流程没有找到可提交实验的按钮。",
        "系统已经做了什么：页面扫描结果和失败证据已经保存。",
        "需要你做什么：请确认是否重试失败链路。"
      ].join("\n"),
      createdAt: new Date().toISOString(),
      suggestedAction: "retry-failed-path",
      requiresConfirmation: true,
      llmTrace: {
        callId: "assistant-fallback-call",
        model: "gpt-5.1-codex",
        provider: "openai-compatible",
        status: "failed",
        fallbackApplied: true,
        errorCode: "assistant_output_invalid"
      }
    }} actions={<button type="button">重试失败链路</button>} />);
    expect(screen.getByText(/遇到的问题：实验创建流程/)).toBeTruthy();
    expect(screen.getByText(/系统已经做了什么：页面扫描结果/)).toBeTruthy();
    expect(screen.getByText(/需要你做什么：请确认/)).toBeTruthy();
    const sourceDetails = screen.getByText("回复来源").closest("details") as HTMLDetailsElement;
    expect(sourceDetails.open).toBe(false);
    fireEvent.click(screen.getByText("回复来源"));
    expect(sourceDetails.open).toBe(true);
    expect(screen.getByText(/系统依据已保存的测试事实生成了这段说明/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试失败链路" })).toBeTruthy();
  });

  it("opens a verified knowledge source through the authenticated Agent API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      claimId: "claim-runtime-1",
      contextId: "context-1",
      status: "observed",
      domain: "runtime",
      statement: "The captured response returned HTTP 500.",
      sensitive: false,
      sourceRefs: ["evidence:evidence-network-1"],
      scope: { runId: "run-1", attemptId: "attempt-1" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<KnowledgeBasis message={{
      id: "assistant-knowledge-1",
      role: "assistant",
      content: "The request failed.",
      createdAt: new Date().toISOString(),
      knowledge: {
        schemaVersion: "2.0",
        factsUsed: ["claim-runtime-1"],
        inferences: [],
        assumptions: [],
        unknowns: [],
        toolRequests: [],
        blockingQuestions: [],
        proposedActions: []
      },
      llmTrace: {
        callId: "call-1",
        contextId: "context-1",
        validationStatus: "verified"
      }
    } as never} />);
    await userEvent.click(screen.getByText("判断依据"));
    await userEvent.click(screen.getByRole("button", { name: "claim-runtime-1" }));
    expect(await screen.findByText("The captured response returned HTTP 500.")).toBeTruthy();
    expect(screen.getByText("evidence:evidence-network-1")).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/agent-api/v1/knowledge-claims/claim-runtime-1/source?contextId=context-1"
    );
    vi.unstubAllGlobals();
  });
});
