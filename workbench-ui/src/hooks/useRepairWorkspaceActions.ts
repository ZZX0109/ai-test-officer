import type { Dispatch, SetStateAction } from "react";
import {
  applyRepair,
  createProjectCodeSession,
  createRunRepair,
  exportRepair,
  getRunLlmCalls,
  updateRepairFile,
  validateRepair
} from "../api";
import type { PlanningMessage, ProjectRecoveryResult, ProjectRuntimeStatus, RepairFileContent, RepairSession, RunResult } from "../types";

interface RepairWorkspaceActionOptions {
  activeRunId: string | null;
  selectedProjectId: string;
  repairBusy: boolean;
  startupRepairAvailable: boolean;
  credentialId?: string;
  projectRecovery: ProjectRecoveryResult | null;
  projectRuntime: ProjectRuntimeStatus | null;
  repairSession: RepairSession | null;
  result: RunResult | null;
  setCentreSurface: (surface: "preview" | "trajectory" | "code") => void;
  setRepairBusy: Dispatch<SetStateAction<boolean>>;
  setRepairWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  setRepairSession: Dispatch<SetStateAction<RepairSession | null>>;
  setMessage: (message: string) => void;
  setPlanningMessages: Dispatch<SetStateAction<PlanningMessage[]>>;
  setRepairVerifiedScenarioIds: Dispatch<SetStateAction<Set<string>>>;
}

/**
 * Owns only sandbox repair/session operations. The original project is never
 * written here; applying a patch still travels through the server-side write
 * safety checks and explicit confirmation.
 */
export function useRepairWorkspaceActions({
  activeRunId, selectedProjectId, repairBusy, startupRepairAvailable, credentialId,
  projectRecovery, projectRuntime, repairSession, result, setCentreSurface,
  setRepairBusy, setRepairWorkspaceOpen, setRepairSession, setMessage,
  setPlanningMessages, setRepairVerifiedScenarioIds
}: RepairWorkspaceActionOptions) {
  async function openCodeRepairWorkspace(targetRunId?: string, autoValidate = false) {
    const repairRunId = targetRunId ?? activeRunId;
    if (!repairRunId) {
      setCentreSurface("code");
      if (!selectedProjectId || repairBusy) {
        setMessage(selectedProjectId ? "代码沙盒正在准备，请稍候。" : "请先选择项目，再打开代码沙盒。");
        return;
      }
      setRepairBusy(true);
      const analyzeStartup = startupRepairAvailable;
      const pendingId = `startup_repair_${Date.now()}`;
      setMessage(analyzeStartup
        ? "正在读取启动诊断并让 AI 生成受限的沙盒修复…"
        : "正在创建项目代码沙盒；原项目保持只读。");
      if (analyzeStartup) {
        setPlanningMessages((current) => [...current, {
          id: pendingId,
          role: "assistant",
          content: "遇到的问题：项目经过有限恢复后仍未启动。\n系统正在做什么：正在读取启动日志和允许修改的配置文件，在隔离沙盒中生成最小补丁。\n需要你操作：你已确认本次沙盒分析；原项目不会被修改，联网安装仍会单独询问。",
          createdAt: new Date().toISOString(),
          streaming: true
        }]);
      }
      try {
        const response = await createProjectCodeSession(selectedProjectId, {
          autoAnalyze: analyzeStartup,
          credentialId,
          summary: analyzeStartup ? "根据已保存的项目启动状态和运行日志，分析最小启动配置修复。" : undefined
        });
        let preparedRepair = response.repair;
        let validationNote: string | undefined;
        if (autoValidate && response.repair.files.length) {
          try {
            const validated = await validateRepair(response.repair.id, false);
            preparedRepair = validated.repair;
            validationNote = `自动验证：${validated.repair.validation?.status ?? "已执行"}。`;
          } catch (error) {
            validationNote = `自动验证未完成：${error instanceof Error ? error.message : "验证服务不可用"}。补丁仍保留在沙盒中。`;
          }
        }
        setRepairSession(preparedRepair);
        setRepairWorkspaceOpen(true);
        const changedFiles = preparedRepair.files.map((file) => file.path);
        setMessage(validationNote ?? (analyzeStartup ? preparedRepair.summary : "代码沙盒已准备，可以查看和编辑文件。保存只写入沙盒，不会直接修改原项目。"));
        if (analyzeStartup) {
          setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
            ...item,
            streaming: false,
            content: [
              `遇到的问题：${projectRecovery?.events.at(-1)?.message ?? projectRuntime?.message ?? "项目启动失败。"}`,
              `系统已经做了什么：${response.repair.summary}`,
              changedFiles.length ? `沙盒变更：${changedFiles.join("、")}。已打开代码 Diff，尚未写回原项目。` : "沙盒变更：模型没有生成满足安全约束的修改，未改动任何文件。",
              validationNote,
              "需要你操作：查看 Diff；如涉及依赖清单，需先授权联网安装，然后执行重新验证。"
            ].filter(Boolean).join("\n")
          } : item));
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "创建代码沙盒失败";
        setMessage(detail);
        if (analyzeStartup) {
          setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
            ...item,
            streaming: false,
            content: `遇到的问题：启动修复没有完成。\n系统已经做了什么：已保留原启动诊断，没有修改原项目。技术原因：${detail}\n需要你操作：检查模型配置，或在已打开的代码沙盒中手动调整启动配置。`
          } : item));
        }
      } finally {
        setRepairBusy(false);
      }
      return;
    }
    setCentreSurface("code");
    setRepairBusy(true);
    setMessage("已获得你的请求，正在创建只读源码快照和可写沙盒副本，并根据失败证据生成最小修复。");
    const pendingId = `code_repair_pending_${Date.now()}`;
    setPlanningMessages((current) => [...current, {
      id: pendingId,
      role: "assistant",
      content: "你已授权 AI 在隔离沙盒中分析失败并提出最小补丁。系统会先保留原始证据；原项目保持只读。AI 会说明修改原因、预期效果和复测范围，验证通过前不会应用到原项目。",
      createdAt: new Date().toISOString(),
      streaming: true
    }]);
    try {
      const response = await createRunRepair(repairRunId, {
        autoAnalyze: true,
        credentialId,
        summary: "根据当前运行的机器门禁、失败断言和证据定位最小修复。"
      });
      let preparedRepair = response.repair;
      let validationNote: string | undefined;
      if (autoValidate && response.repair.files.length) {
        setMessage("沙盒补丁已生成，正在自动执行受控验证…");
        try {
          const validated = await validateRepair(response.repair.id, false);
          preparedRepair = validated.repair;
          validationNote = `自动验证：${validated.repair.validation?.status ?? "已执行"}。`;
          if (validated.repair.validation?.status === "passed") {
            const scenarioId = result?.conclusions?.find((conclusion) => conclusion.runId === validated.repair.runId)?.scenarioId;
            if (scenarioId) setRepairVerifiedScenarioIds((current) => new Set([...current, scenarioId]));
          }
        } catch (error) {
          validationNote = `自动验证未完成：${error instanceof Error ? error.message : "验证服务不可用"}。补丁仍保留在沙盒中。`;
        }
      }
      setRepairSession(preparedRepair);
      setRepairWorkspaceOpen(true);
      setMessage(validationNote ?? preparedRepair.summary);
      const calls = await getRunLlmCalls(repairRunId).catch(() => null);
      const repairCall = [...(calls?.calls ?? [])].reverse().find((call) => call.purpose === "repairing");
      const changedFiles = preparedRepair.files.map((file) => `${file.path}（${file.additions}+/${file.deletions}-，${file.risk}）`);
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        streaming: false,
        content: [
          preparedRepair.summary,
          `失败归因：${preparedRepair.failureClass}。`,
          changedFiles.length ? `沙盒变更：${changedFiles.join("；")}。` : "模型没有生成可安全应用的文件变更。",
          validationNote,
          repairCall ? `模型 ${repairCall.model}；调用 ${repairCall.id}；${repairCall.durationMs}ms；${repairCall.usage.totalTokens ?? 0} Token；状态 ${repairCall.status}。` : "本次没有可用的 Repair 模型调用记录。",
          "修复工作区已打开，可逐行查看 Diff；重新验证通过前不会应用到原项目。你可以继续手动编辑沙盒副本。"
        ].filter(Boolean).join("\n")
      } : item));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "创建修复工作区失败";
      setMessage(detail);
      setPlanningMessages((current) => current.map((item) => item.id === pendingId ? {
        ...item,
        streaming: false,
        content: `修复会话创建失败：${detail}。原机器结论和证据保持不变，没有修改项目文件。`
      } : item));
    } finally {
      setRepairBusy(false);
    }
  }

  async function openProjectCodeWorkspace() {
    setCentreSurface("code");
    if (!selectedProjectId) {
      setMessage("请先上传或选择项目，再查看代码。");
      return;
    }
    if (repairSession?.projectId === selectedProjectId) {
      setRepairWorkspaceOpen(true);
      return;
    }
    if (repairBusy) return;
    setRepairBusy(true);
    setMessage("正在创建受控项目代码副本；原项目保持只读。");
    try {
      const response = await createProjectCodeSession(selectedProjectId, "项目代码工作区：用于查看、编辑沙盒副本和准备后续测试修复。");
      setRepairSession(response.repair);
      setRepairWorkspaceOpen(true);
      setMessage("项目代码已载入受控工作区。任何保存只写入沙盒副本，不会直接修改原项目。");
    } catch (error) {
      setRepairWorkspaceOpen(false);
      setCentreSurface("preview");
      setMessage(error instanceof Error ? `无法打开项目代码：${error.message}` : "无法打开项目代码工作区。");
    } finally {
      setRepairBusy(false);
    }
  }

  async function saveRepairFile(file: RepairFileContent, content: string) {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await updateRepairFile(repairSession.id, file.path, { content, expectedVersion: file.version });
    setRepairSession(response.repair);
    return response.repair;
  }

  async function validateCurrentRepair(allowNetworkInstall = false) {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await validateRepair(repairSession.id, allowNetworkInstall);
    setRepairSession(response.repair);
    if (response.repair.validation?.status === "passed") {
      const scenarioId = result?.conclusions?.find((conclusion) => conclusion.runId === response.repair.runId)?.scenarioId;
      if (scenarioId) setRepairVerifiedScenarioIds((current) => new Set([...current, scenarioId]));
    }
    return response.repair;
  }

  async function exportCurrentRepair(format: "patch" | "zip") {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await exportRepair(repairSession.id, format);
    return { downloadUrl: response.export.downloadUrl };
  }

  async function applyCurrentRepair(confirmHighRisk: boolean) {
    if (!repairSession) throw new Error("repair_session_not_selected");
    const response = await applyRepair(repairSession.id, confirmHighRisk);
    setRepairSession(response.repair);
    return response.repair;
  }

  return { openCodeRepairWorkspace, openProjectCodeWorkspace, saveRepairFile, validateCurrentRepair, exportCurrentRepair, applyCurrentRepair };
}
