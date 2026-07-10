import { FlaskConical, ShieldCheck } from "lucide-react";
import type { DiscoveryScanResult, HarnessGapScenarioDraft } from "../types";
import { AuthenticatedArtifactLink } from "./AuthenticatedArtifact";

interface DiscoveryPanelProps {
  discovery?: DiscoveryScanResult | null;
  drafts: HarnessGapScenarioDraft[];
  onScan: () => void;
  onProbeDraft: (id: string) => void;
  onApproveDraft: (id: string) => void;
}

export function DiscoveryPanel({ discovery, drafts, onScan, onProbeDraft, onApproveDraft }: DiscoveryPanelProps) {
  return (
    <section className="discovery-box">
      <div className="section-title-row">
        <h3>AI 测试点发现</h3>
        <button type="button" onClick={onScan}>
          <FlaskConical size={15} />
          扫描页面和接口
        </button>
      </div>

      {discovery ? (
        <article className={discovery.status === "passed" ? "passed" : discovery.status === "partial" ? "warning" : "failed"}>
          <header>
            <strong>{discovery.page.title || discovery.page.url}</strong>
            <span>{discovery.status}</span>
          </header>
          <p>{discovery.message}</p>
          <p>
            链接 {discovery.page.links.length} · 按钮 {discovery.page.buttons.length} · 表单 {discovery.page.forms.length} ·
            test-id {discovery.page.testIds.length} · API {discovery.openApiOperations.length}
          </p>
          <div className="chip-list">
            {discovery.page.testIds.slice(0, 8).map((testId) => <span key={testId}>test-id:{testId}</span>)}
            {discovery.openApiOperations.slice(0, 6).map((operation) => (
              <span key={`${operation.method}-${operation.path}`}>
                {operation.method} {operation.path}
              </span>
            ))}
          </div>
        </article>
      ) : (
        <p className="empty">先读页面 DOM、按钮、表单、data-testid、network endpoint 和 OpenAPI，再生成可审批的场景草案。</p>
      )}

      <div className="candidate-list">
        {discovery?.suggestions.map((suggestion) => (
          <article key={suggestion.id} className={suggestion.humanReviewRequired ? "pending" : "ready"}>
            <header>
              <strong>{suggestion.title}</strong>
              <span>{suggestion.riskKind}</span>
            </header>
            <p>{suggestion.reason}</p>
            <code>{suggestion.actions.join(" -> ") || "no actions"}</code>
            <code>evidence={suggestion.evidenceRequirements.join(", ")}</code>
            {suggestion.draftScenarioRef && <span>draft={suggestion.draftScenarioRef}</span>}
          </article>
        ))}
      </div>

      <div className="candidate-list">
        {drafts.slice(0, 8).map((draft) => (
          <article key={draft.scenarioId} className={draft.draftReviewStatus === "approved" ? "ready" : "pending"}>
            <header>
              <strong>{draft.scenarioId}</strong>
              <span>{draft.draftReviewStatus ?? "draft"} · probe={draft.selectorProbeStatus ?? "not_run"}</span>
            </header>
            <p>风险：{draft.riskKind ?? "unknown"} · 证据：{draft.evidenceRequirements?.join(", ") || "待补充"}</p>
            {draft.missingInfo?.length ? <code>missing={draft.missingInfo.join(", ")}</code> : null}
            {draft.scenarioFile ? (
              <AuthenticatedArtifactLink artifactUrl={draft.scenarioFile}>
                打开草案
              </AuthenticatedArtifactLink>
            ) : null}
            <div className="row-actions">
              <button type="button" onClick={() => onProbeDraft(draft.scenarioId)}>
                <FlaskConical size={14} />
                探测
              </button>
              <button type="button" onClick={() => onApproveDraft(draft.scenarioId)}>
                <ShieldCheck size={14} />
                批准入库
              </button>
            </div>
          </article>
        ))}
        {drafts.length === 0 && <p className="empty">还没有场景草案。扫描页面或从 harness gap 生成后会出现在这里。</p>}
      </div>
    </section>
  );
}
