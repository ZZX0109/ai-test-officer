import { describe, expect, it } from "vitest";
import {
  initialWorkspaceState,
  workspaceReducer,
  workspaceSelectors
} from "../src/state/workspaceReducer";

const plan = {
  id: "plan-1",
  createdAt: new Date().toISOString(),
  grayLevel: "L1" as const,
  rationale: "test",
  risks: [],
  steps: []
};

describe("workspaceReducer", () => {
  it("drops stale generation responses after a project switch", () => {
    let state = workspaceReducer(initialWorkspaceState, { type: "project-selected", projectId: "one" });
    state = workspaceReducer(state, { type: "operation-started", phase: "generating", requestId: "request-1", projectId: "one" });
    state = workspaceReducer(state, { type: "project-selected", projectId: "two" });
    const afterStaleResponse = workspaceReducer(state, {
      type: "plan-generated",
      requestId: "request-1",
      projectId: "one",
      plan,
      receipt: {
        source: "llm",
        generatedAt: new Date().toISOString(),
        validationStatus: "validated"
      }
    });
    expect(afterStaleResponse).toEqual(state);
    expect(afterStaleResponse.plan).toBeUndefined();
  });

  it("prevents duplicate work while an operation owns the workspace", () => {
    let state = workspaceReducer(initialWorkspaceState, { type: "project-selected", projectId: "one" });
    state = workspaceReducer(state, { type: "operation-started", phase: "generating", requestId: "request-1", projectId: "one" });
    expect(workspaceSelectors.isBusy(state)).toBe(true);
    expect(workspaceSelectors.canGenerate(state)).toBe(false);
  });

  it("preserves a typed failure and can recover without changing project", () => {
    let state = workspaceReducer(initialWorkspaceState, { type: "project-selected", projectId: "one" });
    state = workspaceReducer(state, { type: "operation-started", phase: "executing", requestId: "request-1", projectId: "one" });
    state = workspaceReducer(state, { type: "operation-failed", requestId: "request-1", projectId: "one", error: "worker unavailable" });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("worker unavailable");
    state = workspaceReducer(state, { type: "reset-error" });
    expect(state.phase).toBe("ready");
    expect(state.error).toBeUndefined();
  });
});
