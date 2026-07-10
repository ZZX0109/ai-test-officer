import { FolderSearch, Stethoscope, Wand2 } from "lucide-react";
import type { ProjectDetectionResult, ProjectDiagnosis } from "../types";

interface ProjectWizardPanelProps {
  projectPath: string;
  detection?: ProjectDetectionResult | null;
  diagnosis?: ProjectDiagnosis | null;
  onProjectPathChange: (value: string) => void;
  onDetect: () => void;
  onApplySuggestion: () => void;
  onDiagnose: () => void;
}

export function ProjectWizardPanel({
  projectPath,
  detection,
  diagnosis,
  onProjectPathChange,
  onDetect,
  onApplySuggestion,
  onDiagnose
}: ProjectWizardPanelProps) {
  return (
    <section className="wizard-box">
      <h3>项目接入向导</h3>
      <label>
        项目文件夹
        <input
          value={projectPath}
          onChange={(event) => onProjectPathChange(event.target.value)}
          placeholder="/Users/you/project"
        />
      </label>
      <div className="form-actions">
        <button type="button" onClick={onDetect}>
          <FolderSearch size={15} />
          自动识别
        </button>
        <button type="button" onClick={onApplySuggestion} disabled={!detection}>
          <Wand2 size={15} />
          套用建议
        </button>
        <button type="button" onClick={onDiagnose}>
          <Stethoscope size={15} />
          诊断
        </button>
      </div>

      {detection ? (
        <article className={detection.exists ? "passed" : "failed"}>
          <header>
            <strong>{detection.detectedStack.join(" + ")}</strong>
            <span>{detection.exists ? "路径可读" : "路径不存在"}</span>
          </header>
          <p>包管理器：{detection.packageManagers.join(", ") || "未识别"}</p>
          <p>建议启动：{detection.suggestedConfig.startCommand ?? "需要手动填写"}</p>
          <p>建议健康检查：{detection.suggestedConfig.healthCheckUrl ?? detection.healthCandidates[0] ?? "需要手动填写"}</p>
          <div className="chip-list">
            {detection.ports.map((port) => (
              <span key={`${port.purpose}-${port.port}`}>
                {port.purpose}:{port.port} {port.status}
              </span>
            ))}
          </div>
          {detection.plainLanguageFixes.map((fix) => (
            <p key={fix}>怎么修：{fix}</p>
          ))}
          {detection.warnings.map((warning) => (
            <p key={warning}>注意：{warning}</p>
          ))}
        </article>
      ) : (
        <p className="empty">选择或填写项目文件夹后，向导会识别 Vite、Next、FastAPI、Express，并自动猜启动命令和端口。</p>
      )}

      {diagnosis ? (
        <article className={diagnosis.overallStatus === "passed" ? "passed" : diagnosis.overallStatus === "warning" ? "warning" : "failed"}>
          <header>
            <strong>连接诊断</strong>
            <span>{diagnosis.overallStatus}</span>
          </header>
          {diagnosis.stages.map((stage) => (
            <div className="diagnosis-step" key={stage.stage}>
              <strong>{stage.stage} · {stage.status}</strong>
              <p>{stage.humanMessage}</p>
              {stage.missingEnv?.length ? <code>缺少环境变量：{stage.missingEnv.join(", ")}</code> : null}
              {stage.portConflicts?.map((conflict) => (
                <code key={`${stage.stage}-${conflict.port}`}>端口 {conflict.port}：{conflict.fix}</code>
              ))}
              {stage.suggestedCommands.length ? <code>{stage.suggestedCommands.join(" && ")}</code> : null}
            </div>
          ))}
        </article>
      ) : null}
    </section>
  );
}
