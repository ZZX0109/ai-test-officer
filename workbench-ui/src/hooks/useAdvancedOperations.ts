import type { Dispatch, SetStateAction } from "react";
import {
  createHarnessGapDraft,
  deletePatrolPlan,
  deliverRunToBot,
  installHarnessGapDraft,
  runPatrol,
  runPatrolPlanNow,
  savePatrolPlan,
  startPatrolJob,
  stopPatrolJob,
  updateHarnessGap
} from "../api";
import type {
  BotDelivery,
  GrayPlan,
  HarnessGap,
  HarnessGapScenarioDraft,
  PatrolJob,
  PatrolRunResult,
  PermissionProfile,
  ProjectConfig,
  RunResult
} from "../types";

interface AdvancedOperationsOptions {
  appUrl: string;
  selectedProjectId: string;
  projectDraft: ProjectConfig | null;
  scenarioId: string;
  credentialId?: string;
  requirementText: string;
  diffText: string;
  plan: GrayPlan | null;
  permissionProfile: PermissionProfile;
  result: RunResult | null;
  botProvider: NonNullable<BotDelivery["provider"]>;
  botChannel: string;
  botIncludeScreenshots: boolean;
  botGithubPrUrl: string;
  recipients: () => string[];
  optionalTrim: (value: string) => string | undefined;
  requireBrowserAuthorization: (action: string) => boolean;
  refresh: () => Promise<void>;
  setMessage: (message: string) => void;
  setIsPatrolling: Dispatch<SetStateAction<boolean>>;
  setIsScheduling: Dispatch<SetStateAction<boolean>>;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setPatrolRun: Dispatch<SetStateAction<PatrolRunResult | null>>;
  setDeliveries: Dispatch<SetStateAction<BotDelivery[]>>;
  setPatrolPlans: Dispatch<SetStateAction<PatrolJob[]>>;
  setPatrolJobs: Dispatch<SetStateAction<PatrolJob[]>>;
  setHarnessGaps: Dispatch<SetStateAction<HarnessGap[]>>;
  setGapDrafts: Dispatch<SetStateAction<Record<string, HarnessGapScenarioDraft>>>;
  setScenarioId: Dispatch<SetStateAction<string>>;
}

/** Patrol, delivery, retention-adjacent harness and notification operations. */
export function useAdvancedOperations({
  appUrl, selectedProjectId, projectDraft, scenarioId, credentialId, requirementText,
  diffText, plan, permissionProfile, result, botProvider, botChannel,
  botIncludeScreenshots, botGithubPrUrl, recipients, optionalTrim,
  requireBrowserAuthorization, refresh, setMessage, setIsPatrolling,
  setIsScheduling, setResult, setPatrolRun, setDeliveries, setPatrolPlans,
  setPatrolJobs, setHarnessGaps, setGapDrafts, setScenarioId
}: AdvancedOperationsOptions) {
  const projectId = selectedProjectId || projectDraft?.id;

  async function runPatrolOnce() {
    if (!requireBrowserAuthorization("执行核心路径巡检")) return;
    setIsPatrolling(true);
    setMessage("正在执行一次核心路径巡检。");
    try {
      const response = await runPatrol({ appUrl, projectId, scenarioId, credentialId, requirement: requirementText, diff: diffText, plan: plan ?? undefined, notify: recipients(), permissionProfile });
      setResult(response.run);
      setPatrolRun(response.patrol);
      setDeliveries((current) => [response.delivery, ...current]);
      setMessage(`巡检完成：${response.run.verdict}，已生成值班推送。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "巡检失败");
    } finally {
      setIsPatrolling(false);
    }
  }

  async function startScheduler() {
    if (!requireBrowserAuthorization("启动会接管浏览器的定时巡检")) return;
    setIsScheduling(true);
    setMessage("正在保存并启动核心路径巡检计划。");
    try {
      const notify = recipients();
      const payload = {
        id: "core_path_daily", title: "核心路径定时巡检", appUrl, projectId, scenarioId,
        intervalMs: 60_000, cron: "*/1 * * * *", notify,
        retryPolicy: { maxRetries: 2, backoffMs: 2000 },
        escalationPolicy: { failureThreshold: 2, riskTrendThreshold: "regressed" as const, notify },
        permissionProfile
      };
      const saved = await savePatrolPlan(payload);
      const response = await startPatrolJob(payload);
      setPatrolPlans((current) => [saved.plan, ...current.filter((job) => job.id !== saved.plan.id)]);
      setPatrolJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
      setMessage("定时巡检计划已保存并启动；失败会按 retry policy 重试。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动巡检失败");
    } finally {
      setIsScheduling(false);
    }
  }

  async function stopScheduler() {
    setIsScheduling(true);
    setMessage("正在停止核心路径定时巡检。");
    try {
      const response = await stopPatrolJob({ id: "core_path_daily" });
      setPatrolJobs((current) => [response.job, ...current.filter((job) => job.id !== response.job.id)]);
      setMessage("定时巡检已停止。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "停止巡检失败");
    } finally {
      setIsScheduling(false);
    }
  }

  async function runSavedPatrolPlan(id: string) {
    if (!requireBrowserAuthorization("执行巡检计划")) return;
    setIsPatrolling(true);
    try {
      const response = await runPatrolPlanNow(id);
      setResult(response.run);
      setPatrolRun(response.patrol);
      setDeliveries((current) => [response.delivery, ...current]);
      await refresh();
      setMessage(`巡检计划执行完成：${response.run.verdict}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "执行巡检计划失败");
    } finally {
      setIsPatrolling(false);
    }
  }

  async function removeSavedPatrolPlan(id: string) {
    try {
      await deletePatrolPlan(id);
      setPatrolPlans((current) => current.filter((planItem) => planItem.id !== id));
      setMessage(`巡检计划已删除：${id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除巡检计划失败");
    }
  }

  async function deliverRun() {
    setMessage("正在生成值班推送。");
    try {
      const response = await deliverRunToBot({ runId: result?.id, provider: botProvider, channel: botChannel, recipients: recipients(), includeScreenshots: botIncludeScreenshots, githubPrUrl: optionalTrim(botGithubPrUrl) });
      setDeliveries((current) => [response.delivery, ...current]);
      setMessage("值班推送记录已生成。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "推送失败");
    }
  }

  async function setGapStatus(gap: HarnessGap, status: HarnessGap["status"]) {
    try {
      const response = await updateHarnessGap(gap.id, { status });
      setHarnessGaps((current) => current.map((item) => item.id === gap.id ? response.gap : item));
      setMessage(`Harness gap 已标记为 ${status}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新 harness gap 失败");
    }
  }

  async function draftScenarioFromGap(gap: HarnessGap) {
    try {
      const response = await createHarnessGapDraft(gap.id);
      setGapDrafts((current) => ({ ...current, [gap.id]: response.draft }));
      setMessage(`已生成 scenario 草案：${response.draft.scenarioId}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生成 scenario 草案失败");
    }
  }

  async function installScenarioFromGap(gap: HarnessGap) {
    try {
      const response = await installHarnessGapDraft(gap.id);
      setGapDrafts((current) => ({ ...current, [gap.id]: response.draft }));
      setHarnessGaps((current) => current.map((item) => item.id === gap.id ? { ...item, status: "implemented" } : item));
      await refresh();
      setScenarioId(response.draft.scenarioId);
      setMessage(`已安装 scenario 到 registry：${response.draft.scenarioId}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "安装 scenario 草案失败");
    }
  }

  return { runPatrolOnce, startScheduler, stopScheduler, runSavedPatrolPlan, removeSavedPatrolPlan, deliverRun, setGapStatus, draftScenarioFromGap, installScenarioFromGap };
}
