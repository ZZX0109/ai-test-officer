import { Link2 } from "lucide-react";
import { ConnectorPanel } from "./ConnectorPanel";
import { ImpactPanel } from "./ImpactPanel";
import { SourceStatusPanel } from "./SourceStatusPanel";
import type { IntakeAnalysis } from "../types";

interface ContextSupplementPanelProps {
  diffText: string;
  bugTicketText: string;
  prUrl: string;
  requirementPath: string;
  requirementUrl: string;
  bugTicketPath: string;
  bugTicketUrl: string;
  prDiffUrl: string;
  openApiPath: string;
  openApiUrl: string;
  strictInput: boolean;
  hasRemoteConnectorInput: boolean;
  analysis: IntakeAnalysis | null;
  onDiffTextChange: (value: string) => void;
  onBugTicketTextChange: (value: string) => void;
  onPrUrlChange: (value: string) => void;
  onRequirementPathChange: (value: string) => void;
  onRequirementUrlChange: (value: string) => void;
  onBugTicketPathChange: (value: string) => void;
  onBugTicketUrlChange: (value: string) => void;
  onPrDiffUrlChange: (value: string) => void;
  onOpenApiPathChange: (value: string) => void;
  onOpenApiUrlChange: (value: string) => void;
  onStrictInputChange: (value: boolean) => void;
  onLoadContext: () => void;
  onSelectScenario: (scenarioId: string) => void;
}

/** Optional, untrusted source material and its derived intake explanation. */
export function ContextSupplementPanel({
  diffText, bugTicketText, prUrl, requirementPath, requirementUrl, bugTicketPath,
  bugTicketUrl, prDiffUrl, openApiPath, openApiUrl, strictInput,
  hasRemoteConnectorInput, analysis, onDiffTextChange, onBugTicketTextChange,
  onPrUrlChange, onRequirementPathChange, onRequirementUrlChange,
  onBugTicketPathChange, onBugTicketUrlChange, onPrDiffUrlChange,
  onOpenApiPathChange, onOpenApiUrlChange, onStrictInputChange, onLoadContext,
  onSelectScenario
}: ContextSupplementPanelProps) {
  return <>
    <details className="optional-context">
      <summary>补充输入（可选）：代码变更、缺陷单、PR 和远程文档</summary>
      <label>
        代码变更（Git diff）
        <textarea value={diffText} onChange={(event) => onDiffTextChange(event.target.value)} rows={6} />
        <small className="field-hint">可粘贴本次提交或 PR 的代码差异；没有也可以只按需求测试。</small>
      </label>
      <label>
        缺陷或任务编号（TAPD，可选）
        <textarea value={bugTicketText} onChange={(event) => onBugTicketTextChange(event.target.value)} rows={3} />
      </label>
      <label>
        PR 来源（可选）
        <input value={prUrl} onChange={(event) => onPrUrlChange(event.target.value)} placeholder="https://github.com/.../pull/123" />
      </label>
      <ConnectorPanel
        requirementPath={requirementPath}
        requirementUrl={requirementUrl}
        bugTicketPath={bugTicketPath}
        bugTicketUrl={bugTicketUrl}
        prDiffUrl={prDiffUrl}
        openApiPath={openApiPath}
        openApiUrl={openApiUrl}
        strictInput={strictInput}
        hasRemoteConnectorInput={hasRemoteConnectorInput}
        onRequirementPathChange={onRequirementPathChange}
        onRequirementUrlChange={onRequirementUrlChange}
        onBugTicketPathChange={onBugTicketPathChange}
        onBugTicketUrlChange={onBugTicketUrlChange}
        onPrDiffUrlChange={onPrDiffUrlChange}
        onOpenApiPathChange={onOpenApiPathChange}
        onOpenApiUrlChange={onOpenApiUrlChange}
        onStrictInputChange={onStrictInputChange}
      />
      <button type="button" onClick={onLoadContext}>
        <Link2 size={16} />
        读取以上资料
      </button>
    </details>
    {analysis && (
      <details className="analysis-box analysis-details">
        <summary>查看系统如何生成这些测试内容</summary>
        <div className="chip-list">
          {analysis.changedAreas.map((area) => <span key={area}>{area}</span>)}
        </div>
        <div className="source-list">
          {analysis.sources.map((source) => (
            <article key={source.kind}>
              <strong>{source.title}</strong>
              <span>{source.status}</span>
              <p>{source.summary}</p>
            </article>
          ))}
        </div>
        <SourceStatusPanel sources={analysis.sourceContexts} />
        <ImpactPanel impact={analysis.impactAnalysis} />
        <div className="candidate-list">
          {analysis.scenarioCandidates.map((candidate) => (
            <article key={candidate.id} className={candidate.executable ? "ready" : "pending"}>
              <strong>{candidate.title}</strong>
              <p>{candidate.reason}</p>
              <span>{candidate.riskLevel} · {candidate.source} · {candidate.executable ? "executable" : "needs harness"}</span>
              {candidate.mappedScenarioId && (
                <button type="button" onClick={() => onSelectScenario(candidate.mappedScenarioId!)}>改用这项测试</button>
              )}
            </article>
          ))}
        </div>
      </details>
    )}
  </>;
}
