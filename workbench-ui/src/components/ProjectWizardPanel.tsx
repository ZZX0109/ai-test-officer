import { CheckCircle2, ChevronRight, FolderSearch, Info, Stethoscope, Wand2 } from "lucide-react";
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
      <div className="wizard-heading">
        <span className="wizard-step">第 1 步</span>
        <div>
          <h3>告诉我你要测试哪个项目</h3>
          <p>选择项目文件夹后，系统会帮你准备测试设置。不会修改项目代码。</p>
        </div>
      </div>
      <label>
        项目文件夹
        <input
          value={projectPath}
          onChange={(event) => onProjectPathChange(event.target.value)}
          placeholder="例如：app-under-test 或 /Users/you/my-project"
        />
      </label>
      <div className="form-actions">
        <button className="primary" type="button" onClick={onDetect}>
          <FolderSearch size={15} />
          帮我识别项目
        </button>
      </div>

      {detection ? (
        <article className={`wizard-result ${detection.exists ? "passed" : "failed"}`}>
          <header>
            <div>
              <strong>{detection.exists ? "已找到项目" : "暂时找不到这个项目文件夹"}</strong>
              <p>{detection.exists ? `看起来是 ${detection.detectedStack.join(" + ") || "一个可测试的项目"}。` : "请检查文件夹名称或填写完整路径后重试。"}</p>
            </div>
            {detection.exists ? <CheckCircle2 aria-label="识别成功" size={19} /> : null}
          </header>
          {detection.exists ? (
            <div className="wizard-next-step">
              <div>
                <span>下一步</span>
                <p>使用推荐设置，再检查项目能否正常启动。</p>
              </div>
              <div className="form-actions">
                <button className="primary" type="button" onClick={onApplySuggestion}>
                  <Wand2 size={15} />
                  使用推荐设置
                  <ChevronRight size={15} />
                </button>
                <button type="button" onClick={onDiagnose}>
                  <Stethoscope size={15} />
                  检查能否运行
                </button>
              </div>
            </div>
          ) : null}
          {detection.plainLanguageFixes.map((fix) => (
            <p key={fix}>怎么修：{fix}</p>
          ))}
          {detection.warnings.map((warning) => (
            <p key={warning}>注意：{warning}</p>
          ))}
          {detection.exists ? (
            <details className="wizard-details">
              <summary><Info size={14} /> 查看系统识别到的技术信息</summary>
              <p>包管理器：{detection.packageManagers.join(", ") || "未识别"}</p>
              <p>建议启动方式：{detection.suggestedConfig.startCommand ?? "需要手动填写"}</p>
              <p>检查地址：{detection.suggestedConfig.healthCheckUrl ?? detection.healthCandidates[0] ?? "需要手动填写"}</p>
              <div className="chip-list">
                {detection.ports.map((port) => (
                  <span key={`${port.purpose}-${port.port}`}>
                    {port.purpose}:{port.port} {port.status}
                  </span>
                ))}
              </div>
            </details>
          ) : null}
        </article>
      ) : (
        <p className="empty">不知道项目用了什么技术也没关系。点击“帮我识别项目”，系统会自动查找启动方式和测试地址。</p>
      )}

      {diagnosis ? (
        <article className={diagnosis.overallStatus === "passed" ? "passed" : diagnosis.overallStatus === "warning" ? "warning" : "failed"}>
          <header>
            <div>
              <strong>{diagnosis.overallStatus === "passed" ? "项目已准备好测试" : "项目还需要一点准备"}</strong>
              <p>{diagnosis.overallStatus === "passed" ? "可以继续填写测试需求并生成测试计划。" : "请按下面的提示处理后，再检查一次。"}</p>
            </div>
            <span>{diagnosis.overallStatus === "passed" ? "检查通过" : "需要处理"}</span>
          </header>
          <div className="diagnosis-summary">
            {diagnosis.stages.filter((stage) => stage.status !== "passed").map((stage) => (
              <div className="diagnosis-step" key={stage.stage}>
                <strong>{stage.humanMessage}</strong>
                {stage.missingEnv?.length ? <p>还需要填写：{stage.missingEnv.join(", ")}</p> : null}
                {stage.portConflicts?.map((conflict) => <p key={`${stage.stage}-${conflict.port}`}>端口 {conflict.port}：{conflict.fix}</p>)}
              </div>
            ))}
            {diagnosis.stages.every((stage) => stage.status === "passed") ? <p className="wizard-success-note">接下来可进入“测试依据”，描述你想验证的功能。</p> : null}
          </div>
          <details className="wizard-details">
            <summary><Info size={14} /> 查看完整检查结果（高级）</summary>
            {diagnosis.stages.map((stage) => (
              <div className="diagnosis-step" key={stage.stage}>
                <strong>{stage.stage} · {stage.status}</strong>
                <p>{stage.humanMessage}</p>
                {stage.missingEnv?.length ? <code>缺少环境变量：{stage.missingEnv.join(", ")}</code> : null}
                {stage.portConflicts?.map((conflict) => <code key={`${stage.stage}-${conflict.port}`}>端口 {conflict.port}：{conflict.fix}</code>)}
                {stage.suggestedCommands.length ? <code>{stage.suggestedCommands.join(" && ")}</code> : null}
              </div>
            ))}
          </details>
        </article>
      ) : null}
    </section>
  );
}
