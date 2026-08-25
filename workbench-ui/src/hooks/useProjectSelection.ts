import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { detectProject, getPatrolTrend, getProjectRuntime, listProjectGrants } from "../api";
import type {
  GrayPlan,
  IntakeAnalysis,
  ProjectConfig,
  ProjectDetectionResult,
  ProjectDiagnosis,
  ProjectGrant,
  ProjectHealthCheckResult,
  ProjectRuntimeStatus,
  RepairSession,
  RunProjection,
  RunResult
} from "../types";

interface ProjectSelectionOptions {
  projects: ProjectConfig[];
  scenarioId: string;
  activeRunRestoreEpochRef: MutableRefObject<number>;
  generationRequestRef: MutableRefObject<{ id: string; projectId: string; controller: AbortController } | null>;
  diagnosisOperationRef: MutableRefObject<{ id: string; projectId: string } | null>;
  onResetPlanning: () => void;
  onProjectNotFound: (projectId: string) => void;
  onProjectLoaded: (projectId: string) => void;
  setSelectedProjectId: (projectId: string) => void;
  setPreviewSessionProjectId: Dispatch<SetStateAction<string>>;
  setRunPreviewModalOpen: Dispatch<SetStateAction<boolean>>;
  setProjectDraft: Dispatch<SetStateAction<ProjectConfig | null>>;
  setProjectPathInput: Dispatch<SetStateAction<string>>;
  setAppUrl: Dispatch<SetStateAction<string>>;
  setProjectDetection: Dispatch<SetStateAction<ProjectDetectionResult | null>>;
  setProjectDetectMessage: Dispatch<SetStateAction<string>>;
  setProjectDiagnosis: Dispatch<SetStateAction<ProjectDiagnosis | null>>;
  setProjectConnection: Dispatch<SetStateAction<ProjectHealthCheckResult | null>>;
  setProjectRuntime: Dispatch<SetStateAction<ProjectRuntimeStatus | null>>;
  setProjectGrants: Dispatch<SetStateAction<ProjectGrant[]>>;
  setPatrolTrend: Dispatch<SetStateAction<import("../types").PatrolTrend | null>>;
  setPlan: Dispatch<SetStateAction<GrayPlan | null>>;
  setResult: Dispatch<SetStateAction<RunResult | null>>;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
  setActiveRun: Dispatch<SetStateAction<RunProjection | null>>;
  setAnalysis: Dispatch<SetStateAction<IntakeAnalysis | null>>;
}

/** Project boundaries: invalidate stale UI/projections before loading another project's metadata. */
export function useProjectSelection({
  projects, scenarioId, activeRunRestoreEpochRef, generationRequestRef,
  diagnosisOperationRef, onResetPlanning, onProjectNotFound, onProjectLoaded, setSelectedProjectId,
  setPreviewSessionProjectId, setRunPreviewModalOpen, setProjectDraft,
  setProjectPathInput, setAppUrl, setProjectDetection, setProjectDetectMessage,
  setProjectDiagnosis, setProjectConnection, setProjectRuntime, setProjectGrants,
  setPatrolTrend, setPlan, setResult, setActiveRunId, setActiveRun, setAnalysis
}: ProjectSelectionOptions) {
  function selectProject(projectId: string) {
    activeRunRestoreEpochRef.current += 1;
    generationRequestRef.current?.controller.abort();
    generationRequestRef.current = null;
    diagnosisOperationRef.current = null;
    setPreviewSessionProjectId("");
    setRunPreviewModalOpen(false);
    if (!projectId) {
      setSelectedProjectId("");
      setProjectDraft(null);
      setProjectPathInput("");
      setAppUrl("");
      setProjectDetection(null);
      setProjectDetectMessage("");
      setProjectDiagnosis(null);
      setProjectConnection(null);
      setProjectRuntime(null);
      setProjectGrants([]);
      onResetPlanning();
      return;
    }
    const project = projects.find((item) => item.id === projectId);
    setSelectedProjectId(projectId);
    setPlan(null);
    setResult(null);
    setActiveRunId(null);
    setActiveRun(null);
    setAnalysis(null);
    onResetPlanning();
    if (!project) {
      onProjectNotFound(projectId);
      return;
    }

    setProjectDraft(project);
    setProjectPathInput(project.projectPath);
    setAppUrl(project.frontendUrl);
    setProjectConnection(null);
    setProjectRuntime(null);
    setProjectDiagnosis(null);
    setProjectDetection(null);
    setProjectDetectMessage("");
    void detectProject(project.projectPath)
      .then((response) => {
        setProjectDetection(response.detection);
        const detected = response.detection.suggestedConfig;
        const systemProjectIds = new Set(["customer_portal_lite", "investment_agent_workflow_external", "local_demo_app", "order_portal_lite", "todo_lite"]);
        if (!project.allowExternalProjectPath || systemProjectIds.has(projectId)) return;
        setAppUrl(detected.frontendUrl);
        setProjectDraft((current) => current?.id === projectId ? {
          ...current,
          installCommand: detected.installCommand,
          installCommandSpec: detected.installCommandSpec,
          startCommand: detected.startCommand,
          startCommandSpec: detected.startCommandSpec,
          processes: detected.processes,
          frontendUrl: detected.frontendUrl,
          backendUrl: detected.backendUrl,
          healthCheckUrl: detected.healthCheckUrl,
          login: current.login ?? detected.login ?? { method: "none" },
          apiCredentialRequirements: detected.apiCredentialRequirements ?? [],
          apiCredentialBindings: current.apiCredentialBindings ?? [],
          manifest: detected.manifest ? {
            ...detected.manifest,
            environmentAllowlist: Array.from(new Set([
              ...detected.manifest.environmentAllowlist,
              ...(current.manifest?.environmentAllowlist ?? [])
            ])),
            execution: current.allowExternalProjectPath
              ? { ...detected.manifest.execution, mode: "oci" }
              : current.manifest?.execution ?? detected.manifest.execution
          } : current.manifest
        } : current);
      })
      .catch(() => setProjectDetection(null))
      .finally(() => onProjectLoaded(projectId));
    void getProjectRuntime(projectId).then((response) => setProjectRuntime(response.runtime)).catch(() => setProjectRuntime(null));
    void listProjectGrants(projectId).then((response) => setProjectGrants(response.grants)).catch(() => setProjectGrants([]));
    void getPatrolTrend({ projectId, scenarioId }).then((response) => setPatrolTrend(response.trend)).catch(() => setPatrolTrend(null));
  }

  return { selectProject };
}
