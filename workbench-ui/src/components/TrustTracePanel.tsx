import { useEffect, useState } from "react";
import { ChevronRight, Coins, GitBranch, Timer, TriangleAlert } from "lucide-react";
import { getConclusionProof, getRunConclusions, getRunLlmCalls } from "../api";
import type { Conclusion, LlmInvocation, ProofEdge, RunResult } from "../types";

type ProofView = {
  conclusion: Conclusion;
  edges: ProofEdge[];
  evidence: RunResult["evidence"];
  artifacts: NonNullable<RunResult["artifactsV2"]>;
  attempts: NonNullable<RunResult["attempts"]>;
  steps: RunResult["steps"];
};

function costLabel(call: LlmInvocation) {
  return typeof call.usage.estimatedCostUsd === "number"
    ? `${call.usage.currency ?? "USD"} ${call.usage.estimatedCostUsd.toFixed(6)}`
    : "unknown";
}

export function TrustTracePanel({ runId }: { runId?: string }) {
  const [calls, setCalls] = useState<LlmInvocation[]>([]);
  const [budget, setBudget] = useState<Awaited<ReturnType<typeof getRunLlmCalls>>["budgetLedger"] | null>(null);
  const [conclusions, setConclusions] = useState<Conclusion[]>([]);
  const [manifest, setManifest] = useState<{ integrityStatus: string; evidenceSetRoot: string } | null>(null);
  const [proof, setProof] = useState<ProofView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setCalls([]);
    setBudget(null);
    setConclusions([]);
    setManifest(null);
    setProof(null);
    setError("");
    if (!runId) return;
    void Promise.all([getRunLlmCalls(runId), getRunConclusions(runId)])
      .then(([llm, graph]) => {
        setCalls(llm.calls);
        setBudget(llm.budgetLedger);
        setConclusions(graph.conclusions);
        setManifest(graph.manifest);
        if (!graph.integrity.valid) setError(graph.integrity.errors.join(", "));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "无法读取可信度数据"));
  }, [runId]);

  async function openProof(conclusion: Conclusion) {
    if (!runId) return;
    try {
      setProof(await getConclusionProof(runId, conclusion.conclusionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "证明链读取失败");
    }
  }

  return (
    <section className="trust-trace-panel">
      <header>
        <div>
          <h3>模型调用与结论证明链</h3>
          <p>模型建议不会越过机器门禁；点击结论可追溯到 attempt、step、Evidence 和 Artifact。</p>
        </div>
        <span className={`proof-integrity ${manifest?.integrityStatus ?? "missing"}`}>
          {manifest?.integrityStatus ?? "manifest missing"}
        </span>
      </header>
      {error ? <p className="trust-trace-error"><TriangleAlert size={14} />{error}</p> : null}
      {budget ? (
        <div className="llm-budget-summary">
          <span>模型预算</span>
          <strong>{budget.consumed.tokens} / {budget.budget.maxTotalTokens} Token</strong>
          <small>{budget.consumed.plannerCalls} Planner · {budget.consumed.judgeCalls} Judge · {budget.consumed.triageCalls} Triage · {budget.consumed.repairCalls} Repair</small>
          <small>{budget.consumed.wallClockMs} / {budget.budget.totalTimeoutMs} ms</small>
        </div>
      ) : null}

      <div className="llm-call-list">
        {calls.map((call) => (
          <details key={call.id}>
            <summary>
              <span>{call.purpose}</span>
              <strong>{call.returnedModel ?? call.model}</strong>
              <small><Timer size={12} />{call.durationMs} ms</small>
              <small><Coins size={12} />{costLabel(call)}</small>
              <em className={call.status}>{call.status}</em>
            </summary>
            <dl>
              <div><dt>路由原因</dt><dd>{call.routeReason ?? "未记录"}</dd></div>
              <div><dt>Token</dt><dd>{call.usage.totalTokens ?? "unknown"}</dd></div>
              <div><dt>Prompt / Graph</dt><dd>{call.promptVersion ?? "unknown"} / {call.graphVersion ?? "unknown"}</dd></div>
              <div><dt>传输</dt><dd>{call.transportMode ?? "unknown"} · retries {Math.max(0, (call.transportAttempts?.length ?? 1) - 1)}</dd></div>
              <div><dt>Fallback</dt><dd>{call.fallbackReason ?? "none"} · impact {call.finalStatusImpact ?? "none"}</dd></div>
              {call.errorCode ? <div><dt>错误</dt><dd>{call.errorCode}</dd></div> : null}
            </dl>
          </details>
        ))}
        {!calls.length ? <p className="empty">本次运行没有调用模型，或调用记录尚未提交。</p> : null}
      </div>

      <div className="conclusion-list">
        {conclusions.map((conclusion) => (
          <button type="button" key={conclusion.conclusionId} onClick={() => void openProof(conclusion)}>
            <GitBranch size={15} />
            <span><strong>{conclusion.claimType}</strong><small>{conclusion.source} · {conclusion.status}</small></span>
            <em className={conclusion.proofStatus}>{conclusion.proofStatus}</em>
            <ChevronRight size={14} />
          </button>
        ))}
        {!conclusions.length ? <p className="empty">尚未生成可验证结论。</p> : null}
      </div>

      {proof ? (
        <div className="proof-chain-detail">
          <h4>{proof.conclusion.claimType} → {proof.conclusion.status}</h4>
          <ol>
            {proof.edges.map((edge) => (
              <li key={edge.id}><code>{edge.fromType}</code> {edge.relation} <code>{edge.toType}</code><small>{edge.toId}</small></li>
            ))}
          </ol>
          <div className="proof-evidence-locators">
            {proof.evidence.map((evidence) => (
              <article key={evidence.id}>
                <strong>{evidence.type} · {evidence.title}</strong>
                <code>{evidence.id}</code>
                {evidence.locator?.pageUrl ? <span>URL {evidence.locator.pageUrl}</span> : null}
                {evidence.locator?.selector ? <span>selector {evidence.locator.selector}</span> : null}
                {evidence.locator?.requestId ? <span>request {evidence.locator.requestId} · {evidence.locator.method} {evidence.locator.statusCode ?? ""}</span> : null}
                {evidence.locator?.lineStart ? <span>lines {evidence.locator.lineStart}–{evidence.locator.lineEnd ?? evidence.locator.lineStart}</span> : null}
              </article>
            ))}
          </div>
          <div className="proof-artifacts">
            {proof.artifacts.map((artifact) => (
              <article key={artifact.id}>
                <strong>{artifact.kind}</strong>
                <code>{artifact.id}</code>
                <span>attempt {artifact.attempt} · {artifact.integrity.sha256.slice(0, 12)}…</span>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
