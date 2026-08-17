import type { ActionDsl, ProjectManifest } from "@ai-test-officer/contracts";
import { executeStructuredAction, type StructuredAction, type StructuredActionResult } from "../structuredActionExecutors.js";
import type { ProjectConfig, TargetAppRuntime } from "../types.js";

/**
 * One bounded ReAct turn for non-browser surfaces.
 *
 * The plan compiler supplies the action (reasoning/selection), the executor
 * performs the allow-listed operation, and the result is immediately
 * verified before the next action is considered.  There is intentionally no
 * free-form fallback here: an action absent from the manifest is rejected by
 * the structured executor and the current path becomes blocked.
 */
export interface StructuredReActTurn {
  stepId: string;
  action: StructuredAction;
  status: "executed" | "failed" | "blocked";
  result?: StructuredActionResult;
  error?: string;
}

export interface StructuredReActLoopResult {
  turns: StructuredReActTurn[];
  completed: boolean;
  passed: boolean;
  error?: string;
}

export async function runStructuredReActLoop(input: {
  steps: ReadonlyArray<{ id: string; action: ActionDsl }>;
  manifest: ProjectManifest;
  project: ProjectConfig;
  target: TargetAppRuntime;
  signal?: AbortSignal;
  maxSteps?: number;
}): Promise<StructuredReActLoopResult> {
  const maxSteps = Math.min(input.maxSteps ?? 50, 50);
  const turns: StructuredReActTurn[] = [];

  // Never truncate a compiled path silently. A path larger than the bounded
  // executor budget is an explicit blocked result, while independent paths
  // continue through the parent graph.
  if (input.steps.length > maxSteps) {
    return {
      turns,
      completed: false,
      passed: false,
      error: `structured_react_budget_exceeded:${input.steps.length}>${maxSteps}`
    };
  }

  for (const step of input.steps.slice(0, maxSteps)) {
    if (input.signal?.aborted) {
      return { turns, completed: false, passed: false, error: "aborted" };
    }
    const action = step.action;
    if (!["api-request", "data-assert", "wait-job", "command-check"].includes(action.action)) {
      const error = `structured_react_action_unsupported:${action.action}`;
      turns.push({ stepId: step.id, action: action as StructuredAction, status: "blocked", error });
      return { turns, completed: false, passed: false, error };
    }
    try {
      const result = await executeStructuredAction({
        action: action as StructuredAction,
        manifest: input.manifest,
        project: input.project,
        target: input.target,
        signal: input.signal
      });
      turns.push({
        stepId: step.id,
        action: action as StructuredAction,
        status: result.passed ? "executed" : "failed",
        result,
        ...(result.passed ? {} : { error: result.summary })
      });
      // A failed oracle is a real result. Do not run dependent steps against
      // an invalid state; independent paths are handled by the parent graph.
      if (!result.passed) {
        return { turns, completed: false, passed: false };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      turns.push({ stepId: step.id, action: action as StructuredAction, status: "blocked", error: message });
      return { turns, completed: false, passed: false, error: message };
    }
  }

  const completed = turns.length === input.steps.length && turns.length > 0;
  return {
    turns,
    completed,
    passed: completed && turns.every((turn) => turn.status === "executed")
  };
}
