import type { ComponentProps } from "react";
import { RefreshCw, X } from "lucide-react";
import { ContextSupplementPanel } from "./ContextSupplementPanel";
import { PlanningConversationPanel } from "./PlanningConversationPanel";
import { ProjectPanel } from "./ProjectPanel";
import { ProjectWizardPanel } from "./ProjectWizardPanel";
import { ReadinessPanel } from "./ReadinessPanel";

type ProjectWizardProps = ComponentProps<typeof ProjectWizardPanel>;
type ProjectProps = ComponentProps<typeof ProjectPanel>;
type PlanningProps = ComponentProps<typeof PlanningConversationPanel>;
type ContextSupplementProps = ComponentProps<typeof ContextSupplementPanel>;

interface ContextDrawerProps {
  isRefreshingContext: boolean;
  contextRefreshStatus: string;
  currentFlowStep: number;
  selectedProjectId: string;
  readinessReport: ComponentProps<typeof ReadinessPanel>["report"];
  readinessLoading: boolean;
  bootstrapBusy: boolean;
  readinessBlockers: string[];
  readinessReady: boolean;
  dockerReadiness: { available: boolean; engine: "docker" } | null;
  onRefreshContext: () => void;
  onClose: () => void;
  onRefreshReadiness: () => void;
  onBootstrap: () => void;
  projectWizard: ProjectWizardProps;
  project: ProjectProps;
  planning: PlanningProps;
  contextSupplement: ContextSupplementProps;
}

export function ContextDrawer({
  isRefreshingContext,
  contextRefreshStatus,
  currentFlowStep,
  selectedProjectId,
  readinessReport,
  readinessLoading,
  bootstrapBusy,
  readinessBlockers,
  readinessReady,
  dockerReadiness,
  onRefreshContext,
  onClose,
  onRefreshReadiness,
  onBootstrap,
  projectWizard,
  project,
  planning,
  contextSupplement
}: ContextDrawerProps) {
  const steps = [
    "1. 上传项目",
    "2. 沙盒运行",
    "3. 内置浏览器",
    "4. 描述测试目标",
    "5. 识别功能列表",
    "6. 逐条测试",
    "7. 修复失败（可选）",
    "8. 测试报告"
  ];

  return (
    <>
      <div className="drawer-header">
        <h2>输入上下文</h2>
        <div className="drawer-toggles">
          <button
            className="icon-button"
            onClick={onRefreshContext}
            type="button"
            title={isRefreshingContext ? "正在刷新" : "重新扫描当前项目并刷新上下文"}
            disabled={isRefreshingContext}
            aria-label={isRefreshingContext ? "正在刷新项目上下文" : "刷新项目上下文"}
          >
            <RefreshCw className={isRefreshingContext ? "spin" : undefined} size={16} />
          </button>
          <button className="icon-button" onClick={onClose} type="button" title="关闭" aria-label="关闭输入上下文">
            <X size={16} />
          </button>
        </div>
      </div>
      {contextRefreshStatus ? <p className="drawer-refresh-status" role="status">{contextRefreshStatus}</p> : null}
      <div className="drawer-body">
        <section className="workflow-guide" aria-label="测试流程">
          <strong>按这个顺序完成测试</strong>
          <ol className="workflow-guide__steps">
            {steps.map((label, index) => {
              const step = index + 1;
              const stateClass = step === currentFlowStep ? "is-current" : step < currentFlowStep ? "is-done" : "";
              return <li key={label} className={stateClass}>{label}</li>;
            })}
          </ol>
          {selectedProjectId ? (
            <ReadinessPanel
              report={readinessReport}
              loading={readinessLoading}
              bootstrapping={bootstrapBusy}
              onRefresh={onRefreshReadiness}
              onBootstrap={onBootstrap}
            />
          ) : null}
          {currentFlowStep <= 2 && !readinessReady ? (
            <div className="readiness-gate" role="alert">
              <strong>进入第 2 步前需先就绪：</strong>
              <ul>
                {readinessBlockers.map((item) => <li key={item}>{item}</li>)}
              </ul>
              {dockerReadiness === null ? <p className="readiness-gate__pending">正在检查容器运行时…</p> : null}
            </div>
          ) : null}
        </section>

        <ProjectWizardPanel {...projectWizard} />
        <ProjectPanel {...project} />
        <PlanningConversationPanel {...planning} />
        <ContextSupplementPanel {...contextSupplement} />
      </div>
    </>
  );
}
