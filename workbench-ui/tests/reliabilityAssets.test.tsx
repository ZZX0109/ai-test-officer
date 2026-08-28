import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getReliabilityAssetContext: vi.fn(),
  createDifferentialRun: vi.fn(),
  getDifferentialRun: vi.fn(),
  createTestAsset: vi.fn(),
  getTestAsset: vi.fn(),
  validateTestAsset: vi.fn(),
  applyTestAsset: vi.fn()
}));

vi.mock("../src/api", () => mocks);

import { ReliabilityAssetsPanel } from "../src/components/ReliabilityAssetsPanel";

const hash = "a".repeat(64);

function context(projectId: string, sourceRunId: string) {
  return {
    schemaVersion: "1.0" as const,
    projectId,
    sourceRunId,
    repositoryRoot: `/tmp/${projectId}`,
    repositorySha256: hash,
    sourceRun: { id: sourceRunId, state: "completed", gateStatus: "pass" },
    dataContracts: [{ id: `${projectId}-data`, projectId, coverageItemIds: [`${projectId}-coverage`], dataSourceKinds: ["sqlite"], randomSeed: 7, testTime: "2026-08-26T00:00:00.000Z" }],
    oracleSpecs: [{
      id: `${projectId}-oracle`,
      coverageItemId: `${projectId}-coverage`,
      type: "dom",
      description: "页面包含 completed",
      source: { kind: "formal-contract", id: `${projectId}-contract`, version: "1.0", sha256: hash },
      decisionUse: "release",
      lifecycleStatus: "active"
    }],
    coverageItems: [{ id: `${projectId}-coverage`, runId: sourceRunId, flowId: "flow-1", module: "订单", surface: "page", risk: "high", disposition: "executed" }],
    evidenceRefs: [{ id: `${sourceRunId}-evidence`, type: "operation", title: "可信证据", timestamp: "2026-08-26T00:00:00.000Z", artifactIds: [] }],
    environmentDefaults: { environmentHash: hash, randomSeed: 7, testTime: "2026-08-26T00:00:00.000Z", browserVersion: "playwright-managed" }
  };
}

function differential(projectId: string) {
  return {
    id: `${projectId}-diff`,
    projectId,
    status: "completed" as const,
    base: { revision: "base", runId: `${projectId}-diff_base`, state: "completed", gateStatus: "pass", artifactIds: [], evidenceRefs: [] },
    head: { revision: "head", runId: `${projectId}-diff_head`, state: "completed", gateStatus: "pass", artifactIds: [], evidenceRefs: [] },
    pairManifest: { id: `${projectId}-manifest`, baseRevision: "base", headRevision: "head", dataContractId: `${projectId}-data`, environmentHash: hash, planHash: hash, dataHash: hash, classification: "expected-change", classificationReasons: ["both_sides_passed"] }
  };
}

describe("ReliabilityAssetsPanel", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReliabilityAssetContext.mockImplementation((projectId: string, sourceRunId: string) => Promise.resolve({ context: context(projectId, sourceRunId) }));
    mocks.createDifferentialRun.mockImplementation((payload: Record<string, unknown>) => Promise.resolve({ differentialRun: differential(String(payload.projectId)) }));
    mocks.getDifferentialRun.mockImplementation((id: string) => Promise.resolve({ differentialRun: differential(id.replace(/-diff$/, "")), parentRun: { id: "parent-1", state: "completed", gateStatus: "pass", executionStatus: "completed" } }));
  });

  it("loads the selected context and assembles the differential request", async () => {
    render(<ReliabilityAssetsPanel projectId="project-a" sourceRunId="run-a" />);
    await screen.findByText(/项目 project-a/);

    const revisionInputs = screen.getAllByPlaceholderText("commit / tag");
    fireEvent.change(revisionInputs[0], { target: { value: "base-commit" } });
    fireEvent.change(revisionInputs[1], { target: { value: "head-commit" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并执行 Base/Head" }));

    await waitFor(() => expect(mocks.createDifferentialRun).toHaveBeenCalledTimes(1));
    const payload = mocks.createDifferentialRun.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      projectId: "project-a",
      baseRevision: "base-commit",
      headRevision: "head-commit",
      dataContractId: "project-a-data",
      oracleSpecIds: ["project-a-oracle"],
      environmentHash: hash,
      randomSeed: 7,
      testTime: "2026-08-26T00:00:00.000Z"
    });
    expect(payload.planHash).toBeUndefined();
    expect(payload.plan).toMatchObject({ coverageItemIds: ["project-a-coverage"] });
    expect(payload.idempotencyKey).toContain("project-a");
  });

  it("clears stale request state when the project and source run change", async () => {
    const { rerender } = render(<ReliabilityAssetsPanel projectId="project-a" sourceRunId="run-a" />);
    await screen.findByText(/项目 project-a/);
    fireEvent.change(screen.getAllByPlaceholderText("commit / tag")[0], { target: { value: "old-base" } });

    rerender(<ReliabilityAssetsPanel projectId="project-b" sourceRunId="run-b" />);
    await screen.findByText(/项目 project-b/);
    expect((screen.getAllByPlaceholderText("commit / tag")[0] as HTMLInputElement).value).toBe("");
    expect(mocks.getReliabilityAssetContext).toHaveBeenLastCalledWith("project-b", "run-b");
  });
});
