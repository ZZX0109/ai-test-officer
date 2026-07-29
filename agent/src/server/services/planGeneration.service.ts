import { generatePlan } from "../../llmPlanner.js";
import { proposePlanRefinement } from "../../planRefinement.js";
import type { GrayPlan } from "../../types.js";

export interface GeneratePlanInput {
  projectId?: string;
  requirement: string;
  diff: string;
  credentialId?: string;
}

export interface RefinePlanInput {
  currentPlan?: GrayPlan;
  feedback: string;
  failedAssertionNames: string[];
}

/**
 * Application service boundary for plan generation.
 *
 * HTTP concerns deliberately stay in the router so graph/CLI callers can
 * reuse the exact same business operation without synthesizing a request.
 */
export function generateProjectPlan(input: GeneratePlanInput) {
  return generatePlan(input);
}

export function refineProjectPlan(input: RefinePlanInput) {
  return proposePlanRefinement(input);
}
