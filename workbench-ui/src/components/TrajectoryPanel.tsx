import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cpu,
  FileSearch,
  Link2,
  MousePointerClick,
  ScrollText,
  ShieldCheck,
  XCircle
} from "lucide-react";
import {
  getRunBrowserActions,
  getRunBrowserObservations,
  getRunConclusions,
  getRunLlmCalls
} from "../api";
import type {
  BrowserActionDecision,
  BrowserActionResult,
  BrowserObservation,
  Conclusion,
  LlmInvocation
} from "../types";

interface TrajectoryLoopEvent {
  id: string;
  loopType: string;
  iteration: number;
  timestamp: string;
  status: string;
  title: string;
  action?: string;
  observation?: string;
  decision?: string;
  decisionReason?: string;
  evidenceRefs: string[];
}

interface TrajectoryPanelProps {
  runId: string | null | undefined;
  loopEvents: TrajectoryLoopEvent[];
}

interface TrajectoryData {
  llmCalls: LlmInvocation[];
  decisions: BrowserActionDecision[];
  actions: BrowserActionResult[];
  observations: BrowserObservation[];
  conclusions: Conclusion[];
  integrity: { valid: boolean; errors: string[] };
  summary: { count: number; totalTokens: number; cost: number | "unknown"; retries: number; failures: number };
}

// Map a loop phase to the LLM invocation purposes that belong to it, so each
// phase node can be drilled into to reveal the model reasoning that drove it.
// This is what makes the trace auditable: a human can follow
// phase -> LLM call -> browser action -> evidence -> verdict.
const PHASE_PURPOSES: Record<string, LlmInvocation["purpose"][]> = {
  plan_loop: ["planning"],
  gray_execution_loop: ["browser-action"],
  failure_recovery_loop: ["triage", "repairing"],
  evidence_conflict_loop: ["triage"],
  report_loop: ["judging"],
  human_verdict_loop: ["judging"],
  approval_loop: [],
  harness_improvement_loop: []
};

const PHASE_LABELS: Record<string, string> = {
  plan_loop: "规划",
  approval_loop: "审批",
  gray_execution_loop: "执行",
  failure_recovery_loop: "失败恢复",
  evidence_conflict_loop: "证据冲突",
  report_loop: "结论",
  human_verdict_loop: "人工裁决",
  harness_improvement_loop: "测试基线改进"
};

function statusTone(status: string): "passed" | "failed" | "running" | "warning" {
  if (status === "failed" || status === "stopped") return "failed";
  if (status === "passed" || status === "completed") return "passed";
  if (status === "waiting_for_user" || status === "retrying") return "warning";
  return "running";
}

function formatCost(cost: number | "unknown"): string {
  return cost === "unknown" ? "未知" : `$${cost.toFixed(4)}`;
}

function EvidenceRefs({ refs }: { refs: string[] | undefined }) {
  if (!refs || refs.length === 0) return null;
  return (
    <ul className="trajectory-evidence-refs">
      {refs.map((ref) => (
        <li key={ref}>
          <Link2 size={12} aria-hidden />
          <code>{ref}</code>
        </li>
      ))}
    </ul>
  );
}

function LlmCallRow({ call }: { call: LlmInvocation }) {
  const tone = call.status === "passed" ? "passed" : call.status === "failed" ? "failed" : "warning";
  const tokens = call.usage.totalTokens ?? 0;
  return (
    <li className={`trajectory-call trajectory-call--${tone}`}>
      <div className="trajectory-call__head">
        <Brain size={14} aria-hidden />
        <span className="trajectory-call__purpose">{call.purpose}</span>
        <span className="trajectory-call__model">{call.provider}/{call.model}</span>
        <span className={`trajectory-call__status trajectory-call__status--${tone}`}>{call.status}</span>
        <span className="trajectory-call__meta">
          {tokens > 0 ? `${tokens} tok` : ""}{call.usage.estimatedCostUsd ? ` · ${formatCost(call.usage.estimatedCostUsd ?? 0)}` : ""}
        </span>
      </div>
      {call.routeReason ? <p className="trajectory-call__reason">{call.routeReason}</p> : null}
      {call.failureClass ? <p className="trajectory-call__reason">{call.failureClass}{call.errorCode ? ` · ${call.errorCode}` : ""}</p> : null}
    </li>
  );
}

function BrowserActionRow({ decision, results }: { decision: BrowserActionDecision; results: BrowserActionResult[] }) {
  return (
    <li className="trajectory-browser">
      <div className="trajectory-browser__head">
        <MousePointerClick size={14} aria-hidden />
        <span className={`trajectory-browser__status trajectory-browser__status--${decision.status}`}>{decision.status}</span>
        <span className="trajectory-browser__summary">{decision.summary}</span>
      </div>
      {decision.actions.length > 0 ? (
        <ul className="trajectory-browser__actions">
          {decision.actions.map((act) => {
            const result = results.find((r) => r.actionId === act.actionId);
            return (
              <li key={act.actionId}>
                <strong>{act.action}</strong>
                <span className="muted"> · {act.purpose}</span>
                {result ? (
                  <>
                    <span className={`trajectory-browser__result trajectory-browser__result--${result.status}`}> · {result.status}</span>
                    {result.oracleResults.length > 0 ? (
                      <span className="trajectory-browser__oracle">
                        {` · 断言 ${result.oracleResults.filter((o) => o.passed).length}/${result.oracleResults.length} 通过`}
                      </span>
                    ) : null}
                    <EvidenceRefs refs={result.evidenceRefs} />
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function ObservationRow({ obs }: { obs: BrowserObservation }) {
  const problems = [...(obs.consoleErrors ?? []), ...(obs.pageErrors ?? []), ...(obs.failedRequests ?? [])];
  return (
    <li className="trajectory-obs">
      <div className="trajectory-obs__head">
        <FileSearch size={14} aria-hidden />
        <span className="trajectory-obs__url" title={obs.finalUrl}>{obs.finalUrl}</span>
        <span className="muted">{obs.title ? ` · ${obs.title}` : ""}</span>
        {problems.length > 0 ? (
          <span className="trajectory-obs__problems"><AlertTriangle size={12} aria-hidden /> {problems.length} 个异常</span>
        ) : null}
      </div>
      <EvidenceRefs refs={obs.evidenceRefs} />
    </li>
  );
}

function ConclusionRow({ conclusion }: { conclusion: Conclusion }) {
  const tone = conclusion.proofStatus === "verified" ? "passed" : conclusion.proofStatus === "invalid" ? "failed" : "warning";
  return (
    <li className={`trajectory-conclusion trajectory-conclusion--${tone}`}>
      <div className="trajectory-conclusion__head">
        <ScrollText size={14} aria-hidden />
        <span className="trajectory-conclusion__claim">{conclusion.claimType}</span>
        <span className={`trajectory-conclusion__status trajectory-conclusion__status--${tone}`}>{conclusion.status}</span>
        <span className="muted"> · 来源 {conclusion.source}</span>
        <span className="muted"> · 证明 {conclusion.proofStatus}</span>
      </div>
      <EvidenceRefs refs={conclusion.evidenceRefs} />
    </li>
  );
}

export function TrajectoryPanel({ runId, loopEvents }: TrajectoryPanelProps) {
  const [data, setData] = useState<TrajectoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!runId) {
      setData(null);
      setError(null);
      return;
    }
    setError(null);
    setData(null);
    const targetRunId = runId;
    async function load() {
      try {
        const [llm, browser, obs, conc] = await Promise.all([
          getRunLlmCalls(targetRunId),
          getRunBrowserActions(targetRunId),
          getRunBrowserObservations(targetRunId),
          getRunConclusions(targetRunId)
        ]);
        if (cancelled) return;
        setData({
          llmCalls: llm.calls,
          decisions: browser.decisions,
          actions: browser.actions,
          observations: obs.observations,
          conclusions: conc.conclusions,
          integrity: conc.integrity,
          summary: llm.summary
        });
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const orderedEvents = useMemo(
    () => [...loopEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [loopEvents]
  );

  if (!runId) {
    return <p className="muted">尚未选择运行，无法展示轨迹。</p>;
  }
  if (error) {
    return <p className="error-text" role="alert">轨迹加载失败：{error}</p>;
  }
  if (!data) {
    return <p className="muted">正在聚合模型调用、浏览器动作与证据，生成可追溯轨迹…</p>;
  }

  const assistantCalls = data.llmCalls.filter((call) => call.purpose === "assistant");

  return (
    <section className="trajectory" aria-label="运行轨迹">
      <header className="trajectory__summary">
        <span className="trajectory__chip"><Cpu size={13} aria-hidden /> 模型调用 {data.summary.count}</span>
        <span className="trajectory__chip">
          {data.summary.cost === "unknown" ? "成本 未知" : `成本 ${formatCost(data.summary.cost)}`}
        </span>
        <span className="trajectory__chip"><MousePointerClick size={13} aria-hidden /> 浏览器动作 {data.actions.length}</span>
        <span className="trajectory__chip"><ScrollText size={13} aria-hidden /> 结论 {data.conclusions.length}</span>
        <span className={`trajectory__chip trajectory__chip--${data.integrity.valid ? "passed" : "failed"}`}>
          <ShieldCheck size={13} aria-hidden /> 证据完整性 {data.integrity.valid ? "通过" : "未通过"}
        </span>
        {data.summary.failures > 0 ? (
          <span className="trajectory__chip trajectory__chip--failed"><XCircle size={13} aria-hidden /> 模型失败 {data.summary.failures}</span>
        ) : null}
      </header>

      {orderedEvents.length === 0 ? (
        <p className="muted">该运行尚未产生轨迹事件。</p>
      ) : (
        <ol className="trajectory__timeline">
          {orderedEvents.map((event) => {
            const purposes = PHASE_PURPOSES[event.loopType] ?? [];
            const phaseCalls = data.llmCalls.filter((call) => purposes.includes(call.purpose));
            const isExecution = event.loopType === "gray_execution_loop";
            const isVerdict = event.loopType === "report_loop" || event.loopType === "human_verdict_loop";
            const isOpen = openId === event.id;
            const hasDetail = phaseCalls.length > 0 || (isExecution && (data.decisions.length > 0 || data.observations.length > 0)) || (isVerdict && data.conclusions.length > 0);
            const tone = statusTone(event.status);
            return (
              <li key={event.id} className={`trajectory__node trajectory__node--${tone}`}>
                <button
                  type="button"
                  className="trajectory__node-head"
                  aria-expanded={isOpen}
                  disabled={!hasDetail}
                  onClick={() => setOpenId(isOpen ? null : event.id)}
                >
                  {hasDetail ? (isOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />) : <Clock3 size={16} aria-hidden />}
                  <span className={`trajectory__phase trajectory__phase--${tone}`}>
                    {PHASE_LABELS[event.loopType] ?? event.loopType}
                    {event.iteration > 0 ? ` #${event.iteration}` : ""}
                  </span>
                  <span className="trajectory__node-title">{event.title}</span>
                  <span className="muted trajectory__node-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
                </button>
                <div className="trajectory__node-body">
                  {event.action ? <p><strong>动作：</strong>{event.action}</p> : null}
                  {event.observation ? <p><strong>观察：</strong>{event.observation}</p> : null}
                  {event.decision ? <p><strong>决策：</strong>{event.decision}</p> : null}
                  {event.decisionReason ? <p className="muted">{event.decisionReason}</p> : null}
                  <EvidenceRefs refs={event.evidenceRefs} />
                </div>
                {isOpen && hasDetail ? (
                  <div className="trajectory__node-detail">
                    {phaseCalls.length > 0 ? (
                      <details open>
                        <summary><Brain size={13} aria-hidden /> 模型调用（{phaseCalls.length}）</summary>
                        <ul className="trajectory__sublist">
                          {phaseCalls.map((call) => <LlmCallRow key={call.id} call={call} />)}
                        </ul>
                      </details>
                    ) : null}
                    {isExecution && data.decisions.length > 0 ? (
                      <details open>
                        <summary><MousePointerClick size={13} aria-hidden /> 浏览器动作（{data.decisions.length}）</summary>
                        <ul className="trajectory__sublist">
                          {data.decisions.map((decision) => (
                            <BrowserActionRow key={decision.decisionId} decision={decision} results={data.actions} />
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {isExecution && data.observations.length > 0 ? (
                      <details>
                        <summary><FileSearch size={13} aria-hidden /> 页面观察（{data.observations.length}）</summary>
                        <ul className="trajectory__sublist">
                          {data.observations.map((obs) => <ObservationRow key={obs.observationId} obs={obs} />)}
                        </ul>
                      </details>
                    ) : null}
                    {isVerdict && data.conclusions.length > 0 ? (
                      <details open>
                        <summary><ScrollText size={13} aria-hidden /> 结论与证明（{data.conclusions.length}）</summary>
                        <ul className="trajectory__sublist">
                          {data.conclusions.map((conclusion) => <ConclusionRow key={conclusion.conclusionId} conclusion={conclusion} />)}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {assistantCalls.length > 0 ? (
        <details className="trajectory__assistant">
          <summary><Brain size={13} aria-hidden /> 助手对话调用（{assistantCalls.length}）</summary>
          <ul className="trajectory__sublist">
            {assistantCalls.map((call) => <LlmCallRow key={call.id} call={call} />)}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
