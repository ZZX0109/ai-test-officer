import { buildScenarioGrayPlan } from "./plan.js";
import { generatePlan } from "./llmPlanner.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { readConnectorContext, type ReadConnectorContextInput } from "./sourceConnectors.js";
import { runVisualGrayTest } from "./testRunner.js";
import { readRunBundle } from "./evidenceStore.js";
import { buildDeliveryFromRun } from "./botNotifier.js";
import { writeCommitCheck } from "./commitCheckStore.js";
import { getScenario } from "./scenarios.js";
import { buildHarnessGaps } from "./harnessGaps.js";
import { writeHarnessGaps } from "./harnessGapStore.js";
import { assertExecutablePlan, buildExecutablePlan } from "./executablePlan.js";
import type { CommitCheckResult, GrayPlan, RunRequest } from "./types.js";

export interface RunCommitCheckInput extends ReadConnectorContextInput {
  appUrl?: string;
  projectId?: string;
  target?: RunRequest["target"];
  scenarioId?: string;
  credentialId?: string;
  notify?: string[];
  permissionProfile?: RunRequest["permissionProfile"];
}

async function buildPlan(input: {
  requirement: string;
  diff: string;
  credentialId?: string;
  scenarioId?: string;
}): Promise<{ plan: GrayPlan; source: string }> {
  try {
    const generated = await generatePlan(input);
    if (generated.source === "fallback" && input.scenarioId) {
      return { plan: buildScenarioGrayPlan(getScenario(input.scenarioId)), source: "scenario_fallback" };
    }
    return { plan: generated.plan, source: generated.source };
  } catch {
    return { plan: buildScenarioGrayPlan(getScenario(input.scenarioId)), source: "scenario_fallback" };
  }
}

function selectScenario(input: {
  explicitScenarioId?: string;
  analysis: CommitCheckResult["analysis"];
}) {
  if (input.explicitScenarioId) return input.explicitScenarioId;
  return input.analysis.scenarioCandidates.find((item) => item.executable && item.mappedScenarioId)?.mappedScenarioId;
}

export async function runCommitCheck(input: RunCommitCheckInput): Promise<CommitCheckResult> {
  const context = await readConnectorContext(input);
  const analysis = analyzeIntake({
    requirement: context.requirement,
    diff: context.diff,
    bugTicket: context.bugTicket,
    prUrl: context.prUrl,
    sources: context.sources,
    sourceContexts: context.sourceContexts
  });
  const selectedScenarioId = selectScenario({
    explicitScenarioId: input.scenarioId,
    analysis
  });
  const { plan, source } = await buildPlan({
    requirement: context.requirement,
    diff: context.diff,
    credentialId: input.credentialId,
    scenarioId: selectedScenarioId
  });
  const executablePlan = buildExecutablePlan({
    plan,
    selectedScenarioId,
    impactAnalysis: analysis.impactAnalysis,
    source: source === "llm" || source === "openai" ? "llm_validated" : selectedScenarioId ? "scenario_registry" : "fallback"
  });
  if (executablePlan.status === "valid") assertExecutablePlan(executablePlan);
  const baseResult: CommitCheckResult = {
    id: `commit_check_${Date.now()}`,
    createdAt: new Date().toISOString(),
    context,
    analysis,
    plan,
    executablePlan,
    planSource: source,
    selectedScenarioId
  };
  const executionScenarioId = selectedScenarioId ?? executablePlan.steps.find((step) => !step.humanReviewRequired)?.scenarioId;
  const harnessGaps = await writeHarnessGaps(buildHarnessGaps({
    source: "commit",
    context,
    analysis,
    selectedScenarioId: executionScenarioId,
    relatedCheckId: baseResult.id
  }));

  if (!executionScenarioId) {
    const skipped = {
      ...baseResult,
      harnessGaps,
      skippedReason: "没有找到可执行 scenario。Plan Judge 会把未执行路径标记为覆盖缺口。"
    };
    const stored = await writeCommitCheck(skipped);
    return { ...skipped, commitCheckFile: stored.file };
  }

  const run = await runVisualGrayTest({
    appUrl: input.appUrl,
    projectId: input.projectId,
    target: input.target,
    scenarioId: executionScenarioId,
    credentialId: input.credentialId,
    trigger: "commit",
    requirement: context.requirement,
    diff: context.diff,
    bugTicket: context.bugTicket,
    plan,
    sourceContexts: context.sourceContexts,
    impactAnalysis: analysis.impactAnalysis,
    executablePlan,
    permissionProfile: input.permissionProfile ?? {
      observe: true,
      browserControl: false,
      workspaceControl: false,
      ideTerminalControl: false,
      systemControl: false
    }
  });

  const bundle = await readRunBundle(run.id);
  const delivery =
    run.verdict === "continue"
      ? undefined
      : await buildDeliveryFromRun({
        bundle,
        channel: "值班群",
        recipients: input.notify
      });

  const finalResult = {
    ...baseResult,
    selectedScenarioId: executionScenarioId,
    harnessGaps,
    run,
    delivery
  };
  const stored = await writeCommitCheck(finalResult);
  return {
    ...finalResult,
    commitCheckFile: stored.file
  };
}
