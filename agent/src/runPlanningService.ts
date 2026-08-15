import path from "node:path";
import {
  llmBudgetSchema,
  llmCallSchema,
  planProvenanceSchema,
  type CompiledPlan,
  type LlmBudget,
  type PlanProvenance
} from "@ai-test-officer/contracts";
import { buildCodeImpactGraph, changedFilesFromDiff } from "./codeImpactGraph.js";
import { compileTrustedScenarioPlan } from "./compiledPlanContract.js";
import { analyzeIntake } from "./intakeAnalyzer.js";
import { generatePlan } from "./llmPlanner.js";
import { routePlanner } from "./llmRoutingPolicy.js";
import { planCacheKey, readCachedPlan, writeCachedPlan } from "./planCache.js";
import { buildScenarioGrayPlan } from "./plan.js";
import { getProject, toTargetProjectConfig } from "./projectAdapter.js";
import { redactText } from "./redaction.js";
import { runEventStore, type RunProjection } from "./runEventStore.js";
import { getScenario, hasScenario, listExecutableScenarios } from "./scenarios.js";
import type { GrayPlan, ImpactAnalysis, SourceReadEnvelope } from "./types.js";

const rootDir = path.basename(process.cwd()) === "agent" ? path.resolve(process.cwd(), "..") : process.cwd();
const reportsDir = path.join(rootDir, "reports");

type PlanningInput = {
  projectId?: string;
  logicalProjectId?: string;
  requirement?: string;
  diff?: string;
  scenarioId?: string;
  plannerMode?: "deterministic" | "llm" | "adaptive";
  modelProfileId?: string;
  experimentId?: string;
  repetition?: number;
  promptVersion?: string;
  targetVersion?: string;
  cachePolicy?: "auto" | "bypass";
  llmBudget?: LlmBudget;
  permissionProfile?: { browserControl?: boolean };
  executionProfile?: "interactive" | "benchmark";
  dynamicBrowser?: boolean;
  coverageInventory?: Array<{
    id: string;
    title: string;
    status?: "executable" | "auto-bindable" | "needs-input" | "coverage-gap";
    kind: "page" | "component" | "api" | "scenario" | "data" | "background-task";
    target: string;
    sourceNodeIds: string[];
    sourceCount: number;
    surfaces?: Array<"page" | "api" | "data" | "background-task">;
    requiredEvidenceKinds?: string[];
    preconditions?: string[];
  }>;
};

type PlanPayload = {
  plan?: GrayPlan;
  compiledPlan?: CompiledPlan;
  provenance: PlanProvenance;
  llmCall?: unknown;
  llmCalls?: unknown[];
  scenarioId?: string;
  impactAnalysis?: ImpactAnalysis;
  plannerRouting?: { route: "deterministic" | "llm"; reason: string; signals: string[] };
};

function dynamicBrowserPlan(input: {
  requirement?: string;
  impactAnalysis: ImpactAnalysis;
  promptVersion: string;
  modelProfileId?: string;
  coverageInventory?: PlanningInput["coverageInventory"];
}): PlanPayload {
  const inventory = input.coverageInventory ?? [];
  const pathIds = inventory.length ? inventory.map((item) => item.id) : [
    ...input.impactAnalysis.affectedPages.map((item) => item.id),
    ...input.impactAnalysis.uncoveredRisks.map((item) => item.id)
  ];
  // Full-scan planning must never silently drop discovered paths. Execution
  // budgets control concurrency and may explicitly block a path, but every
  // discovered flow remains visible in Coverage disposition.
  const uniquePathIds = Array.from(new Set(pathIds));
  const effectivePathIds = uniquePathIds.length ? uniquePathIds : ["dynamic-browser-path"];
  return {
    plan: {
      sessionName: "动态浏览器 Agent 测试计划",
      risks: [{
        id: "dynamic-browser-binding",
        level: "high",
        title: "未知项目需要运行时页面绑定与机器 Oracle",
        evidence: input.requirement ?? "用户要求执行交互式浏览器测试",
        pathIds: effectivePathIds,
        coverageDisposition: "required"
      }],
      levels: [{
        id: "core_path",
        title: "运行时业务路径",
        description: "由页面观测、受限 LLM 动作和确定性 Oracle 逐步执行。",
        paths: effectivePathIds.map((id, index) => ({
          id,
          title: inventory.find((item) => item.id === id)?.title
            ?? input.impactAnalysis.affectedPages[index]?.target
            ?? `动态业务路径 ${index + 1}`,
          riskReason: inventory.find((item) => item.id === id)
            ? `该业务路径代表 ${inventory.find((item) => item.id === id)?.sourceCount ?? 1} 个静态代码候选；必须在真实页面中形成动作和机器 Oracle。`
            : "没有可直接复用的固定 Scenario，需在真实页面中绑定控件。",
          expectedFrom: "llm_inferred" as const,
          steps: ["观测页面", "选择受限动作", "执行并采集前后证据", "执行机器 Oracle"],
          retry: 2
        }))
      }]
    },
    provenance: planProvenanceSchema.parse({
      source: "dynamic-browser-agent",
      promptVersion: input.promptVersion,
      modelProfileId: input.modelProfileId,
      compilationStatus: "validated"
    }),
    impactAnalysis: input.impactAnalysis,
    plannerRouting: {
      route: "llm",
      reason: "dynamic_browser_agent_required",
      signals: ["no_static_scenario", "runtime_controls_required"]
    }
  };
}

async function appendPlanningEvent(
  runId: string,
  type: "plan_generated" | "human_review_requested" | "run_blocked",
  suffix: string,
  payload: Record<string, unknown>
) {
  for (let retry = 0; retry < 4; retry += 1) {
    const current = await runEventStore.get(runId);
    if (!current) throw new Error("run_not_found");
    if (current.state !== "planning") return current;
    try {
      return await runEventStore.append({
        runId,
        type,
        expectedVersion: current.version,
        actor: "agent-graph:planner",
        idempotencyKey: `${runId}:graph-planning:${suffix}`,
        payload
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("run_version_conflict:")) throw error;
    }
  }
  throw new Error("run_event_contention");
}

function trustedPlanPayload(input: {
  scenarioId: string;
  promptVersion: string;
  impactAnalysis: ImpactAnalysis;
  plannerRouting: PlanPayload["plannerRouting"];
  provenance?: PlanProvenance;
}): PlanPayload {
  const scenario = getScenario(input.scenarioId);
  return {
    plan: buildScenarioGrayPlan(scenario),
    compiledPlan: compileTrustedScenarioPlan(scenario),
    provenance: input.provenance ?? planProvenanceSchema.parse({
      source: "deterministic",
      promptVersion: input.promptVersion,
      compilationStatus: "validated"
    }),
    scenarioId: scenario.id,
    impactAnalysis: input.impactAnalysis,
    plannerRouting: input.plannerRouting
  };
}

export async function planRunFromDurableInput(runId: string): Promise<RunProjection> {
  const current = await runEventStore.get(runId);
  if (!current) throw new Error("run_not_found");
  if (current.state !== "planning") return current;
  const input = current.input as PlanningInput;
  const promptVersion = input.promptVersion ?? "plan-v1";
  const plannerMode = input.plannerMode ?? "deterministic";
  const sourceContexts: SourceReadEnvelope[] = [];
  if (input.requirement) {
    sourceContexts.push({
      id: "run_requirement",
      kind: "manual",
      title: "Run requirement",
      status: "connected",
      summary: input.requirement,
      permissionState: "not_required",
      isSimulated: false,
      evidenceUse: "primary_requirement",
      displayStatus: "ready",
      readAt: new Date().toISOString(),
      trustLevel: "medium"
    });
  }
  if (input.diff) {
    sourceContexts.push({
      id: "run_diff",
      kind: "git_diff",
      title: "Run diff",
      status: "connected",
      summary: input.diff,
      permissionState: "not_required",
      isSimulated: false,
      evidenceUse: "change_context",
      displayStatus: "ready",
      readAt: new Date().toISOString(),
      trustLevel: "high"
    });
  }
  const diff = input.diff ?? "";
  const project = input.projectId ? await getProject(input.projectId) : undefined;
  const scenarioContracts = input.executionProfile === "benchmark"
    ? listExecutableScenarios().map((scenario) => ({
      id: scenario.id,
      keywords: scenario.matcher?.keywords ?? [scenario.id, scenario.title]
    }))
    : [];
  const repositoryGraph = project && diff
    ? await buildCodeImpactGraph({
      repositoryRoot: toTargetProjectConfig(project).rootDir,
      files: changedFilesFromDiff(diff),
      diff,
      cacheFile: path.join(reportsDir, "impact-cache", `${project.id}.json`),
      ...(scenarioContracts.length ? { scenarios: scenarioContracts } : {})
    })
    : undefined;
  const codeGraph = repositoryGraph && project
    ? { ...repositoryGraph, repositoryRoot: `project://${project.id}` }
    : repositoryGraph;
  const plannerProjectId = input.logicalProjectId ?? input.projectId;
  const intake = analyzeIntake({
    requirement: input.requirement ?? "",
    diff,
    projectId: plannerProjectId,
    sourceContexts,
    codeGraph
  });
  const impactAnalysis = intake.impactAnalysis;
  if (!impactAnalysis) {
    return appendPlanningEvent(runId, "human_review_requested", "impact-analysis-missing", {
      finalStatus: "needs-human-review",
      error: "impact_analysis_missing",
      provenance: {
        source: "deterministic",
        promptVersion,
        compilationStatus: "rejected",
        fallbackReason: "impact_analysis_missing"
      }
    });
  }
  if (input.dynamicBrowser && input.executionProfile !== "benchmark") {
    const payload = dynamicBrowserPlan({
      requirement: input.requirement,
      impactAnalysis,
      promptVersion,
      modelProfileId: input.modelProfileId,
      coverageInventory: input.coverageInventory
    });
    return appendPlanningEvent(runId, "plan_generated", "dynamic-browser-requested", payload as unknown as Record<string, unknown>);
  }
  const plannerRouting = plannerMode === "adaptive"
    ? routePlanner({
      requirement: input.requirement,
      explicitScenarioId: input.scenarioId,
      intake,
      impactAnalysis
    })
    : {
      route: plannerMode === "llm" ? "llm" as const : "deterministic" as const,
      reason: "explicit_mode",
      signals: [`mode:${plannerMode}`]
    };
  let payload: PlanPayload;
  if (plannerRouting.route === "llm") {
    try {
      const cacheKey = planCacheKey({
        projectId: plannerProjectId,
        targetVersion: input.targetVersion,
        requirement: input.requirement,
        diff,
        promptVersion,
        modelProfileId: input.modelProfileId
      });
      const cached = plannerMode === "adaptive" && input.cachePolicy !== "bypass" && !input.experimentId
        ? await readCachedPlan(cacheKey)
        : undefined;
      if (cached) {
        payload = {
          plan: cached.plan,
          compiledPlan: cached.compiledPlan,
          provenance: planProvenanceSchema.parse({
            source: "cached-llm",
            promptVersion,
            modelProfileId: input.modelProfileId,
            model: cached.model,
            compilationStatus: "validated",
            cacheKey,
            originLlmCallId: cached.originLlmCallId
          }),
          scenarioId: cached.scenarioId,
          impactAnalysis,
          plannerRouting: { ...plannerRouting, signals: [...plannerRouting.signals, "plan_cache_hit"] }
        };
      } else {
        const generated = await generatePlan({
          projectId: plannerProjectId,
          requirement: input.requirement ?? "",
          diff,
          impactAnalysis,
          credentialId: input.modelProfileId,
          requireLlm: true,
          runId,
          experimentId: input.experimentId,
          promptVersion,
          preferredScenarioId: input.scenarioId,
          llmBudget: llmBudgetSchema.parse(input.llmBudget ?? {}),
          browserControlAllowed: input.permissionProfile?.browserControl !== false
        });
        if (!("provenance" in generated) || !generated.provenance || !("compiledPlan" in generated)) {
          throw new Error("llm_plan_missing_compiled_provenance");
        }
        payload = {
          plan: generated.plan,
          compiledPlan: generated.compiledPlan,
          provenance: generated.provenance,
          llmCall: generated.llmCall,
          llmCalls: generated.llmCalls,
          scenarioId: generated.scenarioId,
          impactAnalysis,
          plannerRouting
        };
        if (
          plannerMode === "adaptive"
          && input.cachePolicy !== "bypass"
          && !input.experimentId
          && generated.compiledPlan
          && generated.scenarioId
          && generated.llmCall
          && generated.provenance?.model
        ) {
          await writeCachedPlan({
            key: cacheKey,
            plan: generated.plan,
            compiledPlan: generated.compiledPlan,
            scenarioId: generated.scenarioId,
            model: generated.provenance.model,
            originLlmCallId: generated.llmCall.id,
            createdAt: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "llm_planner_failed";
      const callResult = llmCallSchema.safeParse(
        typeof error === "object" && error !== null && "llmCall" in error ? error.llmCall : undefined
      );
      const plannerCall = callResult.success ? callResult.data : undefined;
      const callsResult = llmCallSchema.array().safeParse(
        typeof error === "object" && error !== null && "llmCalls" in error ? error.llmCalls : undefined
      );
      const plannerCalls = callsResult.success ? callsResult.data : plannerCall ? [plannerCall] : [];
      const failureReason = redactText(reason);
      const fallbackScenario = plannerMode === "adaptive"
        ? impactAnalysis.recommendedScenarios.find((candidate) =>
          candidate.confidence === "high"
          && hasScenario(candidate.scenarioId)
          && Boolean(getScenario(candidate.scenarioId).compiledPlanContract)
        )
        : undefined;
      if (fallbackScenario) {
        payload = {
          ...trustedPlanPayload({
            scenarioId: fallbackScenario.scenarioId,
            promptVersion,
            impactAnalysis,
            plannerRouting: {
              route: "deterministic",
              reason: "adaptive_rule_fallback",
              signals: [...plannerRouting.signals, `llm_failure:${failureReason}`, `fallback_scenario:${fallbackScenario.scenarioId}`]
            },
            provenance: planProvenanceSchema.parse({
              source: "adaptive-rule-fallback",
              promptVersion,
              modelProfileId: input.modelProfileId,
              model: plannerCall?.model,
              llmCallId: plannerCall?.id,
              compilationStatus: "validated",
              fallbackReason: failureReason
            })
          }),
          ...(plannerCall ? { llmCall: plannerCall } : {}),
          ...(plannerCalls.length ? { llmCalls: plannerCalls } : {})
        };
      } else {
        const review = reason.startsWith("llm_plan_") || reason.includes("schema") || reason.includes("parse");
        if (input.executionProfile !== "benchmark" && input.permissionProfile?.browserControl !== false) {
          // Preserve the code-derived business inventory when the semantic
          // planner is unavailable. Dropping it here used to replace a full
          // scan with one generic `dynamic-browser-path`, which looked like a
          // successful fallback while silently abandoning the user's plan.
          payload = dynamicBrowserPlan({
            requirement: input.requirement,
            impactAnalysis,
            promptVersion,
            modelProfileId: input.modelProfileId,
            coverageInventory: input.coverageInventory
          });
          return appendPlanningEvent(runId, "plan_generated", "dynamic-browser-fallback", payload as unknown as Record<string, unknown>);
        }
        return appendPlanningEvent(runId, review ? "human_review_requested" : "run_blocked", "planner-failed", {
          finalStatus: review ? "needs-human-review" : "blocked",
          error: failureReason,
          provenance: planProvenanceSchema.parse({
            source: "llm",
            promptVersion,
            modelProfileId: input.modelProfileId,
            model: plannerCall?.model,
            llmCallId: plannerCall?.id,
            compilationStatus: "rejected",
            fallbackReason: failureReason
          }),
          ...(plannerCall ? { llmCall: plannerCall } : {}),
          ...(plannerCalls.length ? { llmCalls: plannerCalls } : {}),
          impactAnalysis
        });
      }
    }
  } else {
    const scenarioId = input.scenarioId
      ?? intake.scenarioCandidates.find((candidate) => candidate.executable && candidate.source !== "patrol")?.mappedScenarioId;
    if (!scenarioId || !hasScenario(scenarioId) || !getScenario(scenarioId).compiledPlanContract) {
      if (input.executionProfile !== "benchmark" && input.permissionProfile?.browserControl !== false) {
        payload = dynamicBrowserPlan({ requirement: input.requirement, impactAnalysis, promptVersion, modelProfileId: input.modelProfileId });
        return appendPlanningEvent(runId, "plan_generated", "dynamic-browser-plan", payload as unknown as Record<string, unknown>);
      }
      return appendPlanningEvent(runId, "human_review_requested", "impact-gap", {
        finalStatus: "needs-human-review",
        error: "impact_analysis_no_executable_scenario",
        impactAnalysis,
        provenance: {
          source: "deterministic",
          promptVersion,
          compilationStatus: "rejected",
          fallbackReason: "impact_analysis_no_executable_scenario"
        }
      });
    }
    payload = trustedPlanPayload({
      scenarioId,
      promptVersion,
      impactAnalysis,
      plannerRouting
    });
  }
  return appendPlanningEvent(runId, "plan_generated", "generated", payload as unknown as Record<string, unknown>);
}
