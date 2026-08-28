import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlanningConversationResult } from "../src/types";
import type { TrajectoryEvent, TrajectoryViewModel } from "../src/api";

const trajectoryMocks = vi.hoisted(() => ({
  getRunTrajectory: vi.fn(),
  subscribeRunTrajectory: vi.fn(() => () => undefined)
}));

vi.mock("../src/api", async () => {
  const actual = await vi.importActual<typeof import("../src/api")>("../src/api");
  return {
    ...actual,
    getRunTrajectory: trajectoryMocks.getRunTrajectory,
    subscribeRunTrajectory: trajectoryMocks.subscribeRunTrajectory
  };
});

import { buildDynamicCoverageInventory } from "../src/hooks/useAutomaticPlanning";
import { TrajectoryPanel } from "../src/components/TrajectoryPanel";

describe("planning coverage regression", () => {
  it("preserves every business-function path instead of replacing the plan with one demo path", () => {
    const businessFlows = [
      { id: "path-ui", title: "任务管理", status: "auto-bindable", kind: "page", target: "/", surfaces: ["page"] },
      { id: "path-root", title: "GET /", status: "needs-input", kind: "api", target: "GET /", surfaces: ["api"] },
      { id: "path-tasks", title: "GET /api/tasks", status: "needs-input", kind: "api", target: "GET /api/tasks", surfaces: ["api"] },
      { id: "path-source", title: "GET /src/main.tsx", status: "needs-input", kind: "api", target: "GET /src/main.tsx", surfaces: ["api"] }
    ];
    const planning = {
      businessFlows,
      businessFunctions: businessFlows.map((flow, index) => ({
        id: `feature-${index}`,
        name: flow.title,
        status: index === 0 ? "ready" : "unknown",
        pathIds: [flow.id],
        sourceLocations: []
      }))
    } as unknown as PlanningConversationResult;

    const coverage = buildDynamicCoverageInventory(planning);

    expect(coverage.map((item) => item.id)).toEqual(["path-ui", "path-root", "path-tasks", "path-source"]);
    expect(coverage).toHaveLength(4);
    expect(coverage.some((item) => item.id === "official-demo-task-filter-completed")).toBe(false);
  });
});

function event(seq: number, type: string, payload: Record<string, unknown>, status: TrajectoryEvent["status"] = "running"): TrajectoryEvent {
  return {
    id: `event-${seq}`,
    runId: "run-1",
    seq,
    rootSeq: seq,
    type,
    at: `2026-08-27T03:00:0${seq}.000Z`,
    actor: type.startsWith("tool") ? "browser-agent" : "llm-provider",
    status,
    idempotencyKey: `key-${seq}`,
    payload,
    evidenceRefs: []
  };
}

describe("trajectory disclosure", () => {
  it("groups model input/output and exact tool data while folding token chunks", async () => {
    const events = [
      event(1, "llm.request", { callId: "call-1", purpose: "browser-action", model: "gpt-test", systemPrompt: "系统规则（已脱敏）", prompt: "检查已完成任务" }),
      event(2, "llm.chunk", { callId: "call-1", textDelta: "第一段" }),
      event(3, "llm.call.completed", { callId: "call-1", call: { outputPreview: "{\"action\":\"click\"}", usage: { promptTokens: 10, completionTokens: 4 } } }, "success"),
      event(4, "tool.call.started", { callId: "tool-1", toolName: "browser.act", params: { selector: "#completed" } }),
      event(5, "tool.call.completed", { callId: "tool-1", toolName: "browser.act", output: { clicked: true } }, "success")
    ];
    const view: TrajectoryViewModel = {
      schemaVersion: "1.0",
      runId: "run-1",
      fromSeq: 1,
      toSeq: 5,
      events,
      tools: [{ callId: "tool-1", toolName: "browser.act", status: "completed", evidenceRefs: [], eventSeqs: [4, 5] }],
      eventLocations: {},
      requests: [],
      callSchemas: [],
      runningCalls: [],
      warnings: [],
      summary: { totalEvents: 5, llmCalls: 1, toolCalls: 1, browserActions: 1, observations: 0, evidence: 0, failures: 0 },
      replayable: true
    };
    trajectoryMocks.getRunTrajectory.mockResolvedValue({ view, events, page: {} });

    render(<TrajectoryPanel runId="run-1" />);

    await waitFor(() => expect(screen.getByText("模型与工具做了什么")).toBeTruthy());
    expect(screen.getByText("已折叠流式片段 1")).toBeTruthy();
    expect(screen.getByText("发送给模型的完整内容（已脱敏）")).toBeTruthy();
    expect(screen.getByText("检查已完成任务")).toBeTruthy();
    expect(screen.getByText("模型返回的原始结果")).toBeTruthy();
    expect(screen.getByText(/"action": "click"/)).toBeTruthy();
    expect(screen.getByText("工具输入参数")).toBeTruthy();
    expect(screen.getByText(/#completed/)).toBeTruthy();
    expect(screen.getByText("工具执行结果")).toBeTruthy();
    expect(screen.getByText(/"clicked": true/)).toBeTruthy();
    expect(screen.queryByText("模型流式片段")).toBeNull();
  });
});
