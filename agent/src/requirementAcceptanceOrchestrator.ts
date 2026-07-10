import { buildScenarioGrayPlan, fixedGrayPlan } from "./plan.js";
import { generatePlan } from "./llmPlanner.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { readConnectorContext, type ReadConnectorContextInput } from "./sourceConnectors.js";
import { runVisualGrayTest } from "./testRunner.js";
import { readRunBundle } from "./evidenceStore.js";
import { buildDeliveryFromRun } from "./botNotifier.js";
import { getScenario } from "./scenarios.js";
import { writeRequirementAcceptance } from "./requirementAcceptanceStore.js";
import { buildHarnessGaps } from "./harnessGaps.js";
import { writeHarnessGaps } from "./harnessGapStore.js";
import { assertExecutablePlan, buildExecutablePlan } from "./executablePlan.js";
import type {
  ConnectorContext,
  GrayPlan,
  IntakeSource,
  RequirementAcceptanceResult,
  RunRequest,
  SourceReadEnvelope
} from "./types.js";

export interface RunRequirementAcceptanceInput extends ReadConnectorContextInput {
  appUrl?: string;
  projectId?: string;
  target?: RunRequest["target"];
  requirement?: string;
  diff?: string;
  bugTicket?: string;
  scenarioId?: string;
  credentialId?: string;
  notify?: string[];
  permissionProfile?: RunRequest["permissionProfile"];
}

function sourceStatus(value: string | undefined): IntakeSource["status"] {
  return value?.trim() ? "simulated" : "missing";
}

function manualSource(input: {
  kind: SourceReadEnvelope["kind"];
  title: string;
  value?: string;
  uri?: string;
  summaryPresent: string;
  summaryMissing: string;
}): SourceReadEnvelope {
  const readAt = new Date().toISOString();
  const status = sourceStatus(input.value);
  return {
    id: `source_manual_${input.kind}_${Math.random().toString(16).slice(2, 8)}`,
    kind: input.kind,
    title: input.title,
    uri: input.uri,
    status,
    summary: input.value?.trim() ? input.summaryPresent : input.summaryMissing,
    permissionState: "unknown",
    isSimulated: status === "simulated",
    contentHash: input.value?.trim() ? `manual_${Buffer.from(input.value).toString("base64url").slice(0, 20)}` : undefined,
    readAt,
    trustLevel: status === "simulated" ? "low" : "medium"
  };
}

function buildManualContext(input: RunRequirementAcceptanceInput): ConnectorContext | undefined {
  const hasManualInput =
    input.requirement !== undefined ||
    input.diff !== undefined ||
    input.bugTicket !== undefined;
  if (!hasManualInput) return undefined;

  const sourceContexts: SourceReadEnvelope[] = [
    manualSource({
      kind: "requirement_doc",
      title: "工作台需求输入",
      value: input.requirement,
      summaryPresent: "已读取工作台中的需求文本。",
      summaryMissing: "未提供需求文本。"
    }),
    manualSource({
      kind: "git_diff",
      title: "工作台变更输入",
      value: input.diff ?? input.fallbackDiff,
      summaryPresent: "已读取工作台中的变更说明或 diff。",
      summaryMissing: "未提供变更说明。"
    }),
    manualSource({
      kind: "tapd_bug",
      title: "工作台 Bug/TAPD 输入",
      value: input.bugTicket,
      summaryPresent: "已读取工作台中的缺陷上下文。",
      summaryMissing: "未提供缺陷上下文。"
    }),
    manualSource({
      kind: "github_pr",
      title: "需求来源",
      value: input.prUrl,
      uri: input.prUrl,
      summaryPresent: "已记录需求或 PR 来源。",
      summaryMissing: "未提供外部来源链接。"
    })
  ];
  return {
    requirement: input.requirement ?? "",
    diff: input.diff ?? input.fallbackDiff ?? "",
    bugTicket: input.bugTicket ?? "",
    prUrl: input.prUrl,
    sourceContexts,
    sources: [
      {
        kind: "requirement_doc",
        title: "工作台需求输入",
        status: sourceStatus(input.requirement),
        summary: input.requirement?.trim() ? "已读取工作台中的需求文本。" : "未提供需求文本。"
      },
      {
        kind: "git_diff",
        title: "工作台变更输入",
        status: sourceStatus(input.diff ?? input.fallbackDiff),
        summary: (input.diff ?? input.fallbackDiff)?.trim()
          ? "已读取工作台中的变更说明或 diff。"
          : "未提供变更说明。"
      },
      {
        kind: "tapd_bug",
        title: "工作台 Bug/TAPD 输入",
        status: sourceStatus(input.bugTicket),
        summary: input.bugTicket?.trim() ? "已读取工作台中的缺陷上下文。" : "未提供缺陷上下文。"
      },
      {
        kind: "pr",
        title: "需求来源",
        status: sourceStatus(input.prUrl),
        summary: input.prUrl?.trim() ? "已记录需求或 PR 来源。" : "未提供外部来源链接。"
      }
    ]
  };
}

async function resolveContext(input: RunRequirementAcceptanceInput) {
  return buildManualContext(input) ?? readConnectorContext(input);
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
    return input.scenarioId
      ? { plan: buildScenarioGrayPlan(getScenario(input.scenarioId)), source: "scenario_fallback" }
      : { plan: fixedGrayPlan, source: "fallback" };
  }
}

function selectScenario(input: {
  explicitScenarioId?: string;
  analysis: RequirementAcceptanceResult["analysis"];
}) {
  if (input.explicitScenarioId) return input.explicitScenarioId;
  return input.analysis.scenarioCandidates.find((item) => item.executable && item.mappedScenarioId)?.mappedScenarioId;
}

export async function runRequirementAcceptance(
  input: RunRequirementAcceptanceInput
): Promise<RequirementAcceptanceResult> {
  const context = await resolveContext(input);
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
  const baseResult: RequirementAcceptanceResult = {
    id: `requirement_acceptance_${Date.now()}`,
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
    source: "requirement",
    context,
    analysis,
    selectedScenarioId: executionScenarioId,
    relatedCheckId: baseResult.id
  }));

  if (!executionScenarioId) {
    const skipped = {
      ...baseResult,
      harnessGaps,
      skippedReason: "需求未命中可执行 scenario。Plan Judge 会把该需求标记为未覆盖，需要补 harness 或人工验收。"
    };
    const stored = await writeRequirementAcceptance(skipped);
    return { ...skipped, acceptanceFile: stored.file };
  }

  const run = await runVisualGrayTest({
    appUrl: input.appUrl,
    projectId: input.projectId,
    target: input.target,
    scenarioId: executionScenarioId,
    credentialId: input.credentialId,
    trigger: "requirement",
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
        channel: "需求验收群",
        recipients: input.notify
      });
  const finalResult = {
    ...baseResult,
    selectedScenarioId: executionScenarioId,
    harnessGaps,
    run,
    delivery
  };
  const stored = await writeRequirementAcceptance(finalResult);
  return {
    ...finalResult,
    acceptanceFile: stored.file
  };
}
