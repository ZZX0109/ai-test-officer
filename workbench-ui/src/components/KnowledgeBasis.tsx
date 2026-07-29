import { useState } from "react";
import { AlertTriangle, CheckCircle2, Database, LoaderCircle, Wrench } from "lucide-react";
import { getKnowledgeClaimSource } from "../api";
import type { PlanningMessage } from "../types";

export function KnowledgeBasis({ message }: { message: PlanningMessage }) {
  const knowledge = message.knowledge;
  const [selectedSource, setSelectedSource] = useState<Awaited<ReturnType<typeof getKnowledgeClaimSource>> | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [loadingClaimId, setLoadingClaimId] = useState<string | null>(null);
  if (!knowledge) return null;
  const unresolved = knowledge.unknowns.length + knowledge.blockingQuestions.length;

  async function inspectSource(claimId: string) {
    setLoadingClaimId(claimId);
    setSourceError(null);
    try {
      setSelectedSource(await getKnowledgeClaimSource(claimId, message.llmTrace?.contextId));
    } catch (error) {
      setSelectedSource(null);
      setSourceError(error instanceof Error ? error.message : "无法读取该事实来源");
    } finally {
      setLoadingClaimId(null);
    }
  }

  return (
    <details className={`knowledge-basis ${unresolved ? "has-unknowns" : ""}`}>
      <summary>
        判断依据
        <span>{knowledge.factsUsed.length} 项事实 · {knowledge.inferences.length} 项推断 · {unresolved} 项待确认</span>
      </summary>
      <div className="knowledge-basis-sections">
        <section>
          <h5><CheckCircle2 size={13} /> 已验证事实</h5>
          {knowledge.factsUsed.length ? (
            <ul>
              {knowledge.factsUsed.map((claimId) => (
                <li key={claimId}>
                  <button
                    className="knowledge-source-button"
                    type="button"
                    onClick={() => void inspectSource(claimId)}
                    disabled={loadingClaimId === claimId}
                  >
                    {loadingClaimId === claimId ? <LoaderCircle className="spin" size={12} /> : null}
                    {claimId}
                  </button>
                </li>
              ))}
            </ul>
          ) : <p>本次回复未使用事实型 claim。</p>}
          {sourceError ? <p className="knowledge-source-error">{sourceError}</p> : null}
          {selectedSource ? (
            <div className={`knowledge-source-detail status-${selectedSource.status}`}>
              <header>
                <strong>{selectedSource.sensitive ? "敏感事实句柄" : selectedSource.statement}</strong>
                <span>{selectedSource.status}</span>
              </header>
              <p>{selectedSource.domain} · Context {selectedSource.contextId}</p>
              {selectedSource.sourceRefs.length ? (
                <ul>
                  {selectedSource.sourceRefs.map((sourceRef) => <li key={sourceRef}>{sourceRef}</li>)}
                </ul>
              ) : <p>该事实没有可解析的来源引用。</p>}
              <small>
                {Object.entries(selectedSource.scope)
                  .filter(([, value]) => Boolean(value))
                  .map(([key, value]) => `${key}=${value}`)
                  .join(" · ")}
              </small>
            </div>
          ) : null}
        </section>
        {knowledge.inferences.length ? (
          <section>
            <h5><Database size={13} /> AI 推断</h5>
            <ul>{knowledge.inferences.map((item, index) => (
              <li key={`${item.statement}-${index}`}>{item.statement}<small>来源：{item.sourceClaimIds.join("、")}</small></li>
            ))}</ul>
          </section>
        ) : null}
        {knowledge.assumptions.length || unresolved ? (
          <section className="knowledge-unconfirmed">
            <h5><AlertTriangle size={13} /> 尚未确认</h5>
            <ul>
              {knowledge.assumptions.map((item, index) => (
                <li key={`${item.statement}-${index}`} className={`risk-${item.risk}`}>{item.statement}（{item.risk}）</li>
              ))}
              {knowledge.unknowns.map((item) => <li key={item}>{item}</li>)}
              {knowledge.blockingQuestions.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ) : null}
        {knowledge.toolRequests.length ? (
          <section>
            <h5><Wrench size={13} /> 工具请求</h5>
            <ul>{knowledge.toolRequests.map((item, index) => (
              <li key={`${item.tool}-${index}`}><strong>{item.tool}</strong>：{item.reason}</li>
            ))}</ul>
          </section>
        ) : null}
        {message.llmTrace ? (
          <footer>
            策略 knowledge-boundary-v2 · 校验 {message.llmTrace.validationStatus ?? "pending"} · 调用 {message.llmTrace.callId}
            {message.llmTrace.contextId ? <> · Context {message.llmTrace.contextId}</> : null}
          </footer>
        ) : null}
      </div>
    </details>
  );
}
