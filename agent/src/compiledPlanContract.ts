import { compiledPlanSchema, type ActionDsl, type CompiledPlan } from "@ai-test-officer/contracts";
import type { ExecutableScenario } from "./scenarios.js";

export interface ScenarioCompiledPlanStep {
  pathId: string;
  action: ActionDsl;
}

export interface ScenarioCompiledPlanContract {
  routePath?: string;
  requiredSteps: ScenarioCompiledPlanStep[];
  requiredEvidenceKinds: CompiledPlan["requiredEvidenceKinds"];
  allowOptionalWait?: boolean;
}

function actionKey(step: ScenarioCompiledPlanStep) {
  return JSON.stringify({ pathId: step.pathId, action: step.action });
}

/** Verifies semantic equivalence, not merely syntactic validity. Optional waits
 * may be inserted for stabilization, but all observable actions must exactly
 * match the trusted scenario contract and remain in order. */
export function assertCompiledPlanSemanticContract(compiledPlan: CompiledPlan, scenario: ExecutableScenario) {
  const parsed = compiledPlanSchema.parse(compiledPlan);
  const contract = scenario.compiledPlanContract;
  if (!contract) throw new Error(`compiled_plan_contract_missing:${scenario.id}`);
  if (contract.routePath && (parsed.steps[0]?.action.action !== "navigate" || parsed.steps[0].action.path !== contract.routePath)) {
    throw new Error(`compiled_plan_route_mismatch:${scenario.id}:${contract.routePath}`);
  }
  const observable = parsed.steps
    .map((step) => ({ pathId: step.pathId ?? scenario.corePath.pathId, action: step.action }))
    .filter((step) => step.action.action !== "wait");
  const expected = contract.requiredSteps.filter((step) => step.action.action !== "wait");
  if (observable.length !== expected.length || observable.some((step, index) => actionKey(step) !== actionKey(expected[index]))) {
    throw new Error(`compiled_plan_semantic_sequence_mismatch:${scenario.id}`);
  }
  if (!contract.allowOptionalWait && parsed.steps.some((step) => step.action.action === "wait")) {
    throw new Error(`compiled_plan_wait_not_allowed:${scenario.id}`);
  }
  const requiredEvidence = new Set(contract.requiredEvidenceKinds);
  if (parsed.requiredEvidenceKinds.length !== requiredEvidence.size || parsed.requiredEvidenceKinds.some((kind) => !requiredEvidence.has(kind))) {
    throw new Error(`compiled_plan_evidence_contract_mismatch:${scenario.id}`);
  }
  return parsed;
}

export function compiledPlanSemanticSignature(steps: ScenarioCompiledPlanStep[]) {
  return steps.filter((step) => step.action.action !== "wait").map(actionKey);
}

export function compileTrustedScenarioPlan(scenario: ExecutableScenario) {
  const contract = scenario.compiledPlanContract;
  if (!contract) throw new Error(`compiled_plan_contract_missing:${scenario.id}`);
  const plan = compiledPlanSchema.parse({
    scenarioId: scenario.id,
    steps: contract.requiredSteps.map((step, index) => ({
      id: `${scenario.id}_trusted_${index + 1}`,
      pathId: step.pathId,
      action: step.action
    })),
    requiredOracleIds: Array.from(new Set(
      contract.requiredSteps.flatMap((step) => step.action.action === "assert" ? [step.action.oracleId] : [])
    )),
    requiredEvidenceKinds: contract.requiredEvidenceKinds
  });
  return assertCompiledPlanSemanticContract(plan, scenario);
}
