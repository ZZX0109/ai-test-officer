import type { GrayPlan, RunResult } from "../types";

export type WorkspacePhase =
  | "idle"
  | "project-loading"
  | "ready"
  | "generating"
  | "executing"
  | "judging"
  | "completed"
  | "failed"
  | "cancelled";

export interface GenerationReceipt {
  source: string;
  generatedAt: string;
  model?: string;
  ruleVersion?: string;
  validationStatus: "validated" | "unverified";
}

export interface WorkspaceState {
  selectedProjectId: string;
  projectRevision: number;
  phase: WorkspacePhase;
  activeRequestId?: string;
  activeRunId?: string;
  plan?: GrayPlan;
  report?: RunResult;
  generation?: GenerationReceipt;
  error?: string;
}

export type WorkspaceAction =
  | { type: "project-selected"; projectId: string }
  | { type: "project-loaded"; projectId: string }
  | { type: "operation-started"; phase: Extract<WorkspacePhase, "project-loading" | "generating" | "executing" | "judging">; requestId: string; projectId: string; runId?: string }
  | { type: "plan-generated"; requestId: string; projectId: string; plan: GrayPlan; receipt: GenerationReceipt }
  | { type: "run-completed"; requestId: string; projectId: string; report: RunResult }
  | { type: "operation-failed"; requestId: string; projectId: string; error: string }
  | { type: "operation-cancelled"; requestId: string; projectId: string }
  | { type: "reset-error" };

export const initialWorkspaceState: WorkspaceState = {
  selectedProjectId: "",
  projectRevision: 0,
  phase: "idle"
};

function isCurrentOperation(state: WorkspaceState, action: { requestId: string; projectId: string }) {
  return state.activeRequestId === action.requestId && state.selectedProjectId === action.projectId;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "project-selected":
      return {
        selectedProjectId: action.projectId,
        projectRevision: state.projectRevision + 1,
        phase: action.projectId ? "project-loading" : "idle"
      };
    case "project-loaded":
      if (state.selectedProjectId !== action.projectId || state.phase !== "project-loading") return state;
      return { ...state, phase: "ready", error: undefined };
    case "operation-started":
      if (state.selectedProjectId !== action.projectId) return state;
      return {
        ...state,
        phase: action.phase,
        activeRequestId: action.requestId,
        activeRunId: action.runId ?? state.activeRunId,
        error: undefined
      };
    case "plan-generated":
      if (!isCurrentOperation(state, action)) return state;
      return {
        ...state,
        phase: "ready",
        activeRequestId: undefined,
        plan: action.plan,
        generation: action.receipt,
        error: undefined
      };
    case "run-completed":
      if (!isCurrentOperation(state, action)) return state;
      return {
        ...state,
        phase: "completed",
        activeRequestId: undefined,
        report: action.report,
        error: undefined
      };
    case "operation-failed":
      if (!isCurrentOperation(state, action)) return state;
      return {
        ...state,
        phase: "failed",
        activeRequestId: undefined,
        error: action.error
      };
    case "operation-cancelled":
      if (!isCurrentOperation(state, action)) return state;
      return {
        ...state,
        phase: "cancelled",
        activeRequestId: undefined,
        error: undefined
      };
    case "reset-error":
      return { ...state, error: undefined, phase: state.selectedProjectId ? "ready" : "idle" };
  }
}

export const workspaceSelectors = {
  isBusy: (state: WorkspaceState) => ["project-loading", "generating", "executing", "judging"].includes(state.phase),
  canGenerate: (state: WorkspaceState) => Boolean(state.selectedProjectId) && !["generating", "executing", "judging"].includes(state.phase),
  currentPlan: (state: WorkspaceState) => state.plan,
  currentReport: (state: WorkspaceState) => state.report
};
