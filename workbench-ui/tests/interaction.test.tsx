import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorPanel } from "../src/components/ConnectorPanel";
import { PatrolPanel } from "../src/components/PatrolPanel";
import { BenchmarkPanel } from "../src/components/BenchmarkPanel";

describe("Workbench interactions", () => {
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
});
