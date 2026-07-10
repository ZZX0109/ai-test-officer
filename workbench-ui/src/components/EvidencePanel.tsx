import { BotMessageSquare, X } from "lucide-react";
import type {
  AuditStoreStatus,
  BotDelivery,
  CommitCheckResult,
  LiveRunState,
  PatrolRunResult,
  RequirementAcceptanceResult,
  RunResult
} from "../types";
import { ArtifactIntegrityPanel } from "./ArtifactIntegrityPanel";
import { JudgePanel } from "./JudgePanel";
import { ReportLinks } from "./ReportLinks";
import { RunTimeline } from "./RunTimeline";

interface EvidencePanelProps {
  result?: RunResult | null;
  liveRun?: LiveRunState | null;
  displayedLoopEvents?: RunResult["loopEvents"] | LiveRunState["events"];
  auditStore?: AuditStoreStatus | null;
  commitCheck?: CommitCheckResult | null;
  requirementAcceptance?: RequirementAcceptanceResult | null;
  patrolRun?: PatrolRunResult | null;
  deliveries: BotDelivery[];
  isBusy: boolean;
  liveStatusText: string;
  onClose: () => void;
}

function auditStoreClass(auditStore?: AuditStoreStatus | null) {
  if (!auditStore) return "warning";
  if (auditStore.schemaVersionMatches === false || auditStore.migrationComplete === false || auditStore.integrityOk === false) {
    return "failed";
  }
  return "passed";
}

function auditStoreLabel(auditStore?: AuditStoreStatus | null) {
  if (!auditStore) return "—";
  const version = auditStore.userVersion !== undefined
    ? `schema ${auditStore.schemaVersion}/user ${auditStore.userVersion}`
    : `schema ${auditStore.schemaVersion}`;
  const migration = auditStore.migrationComplete === false
    ? `missing migrations ${(auditStore.missingMigrations ?? []).join(",") || "unknown"}`
    : "migrations ok";
  const integrity = auditStore.integrityOk === false
    ? `integrity ${auditStore.integrityCheck ?? "failed"}`
    : "integrity ok";
  return `${version} · ${migration} · ${integrity} · events ${auditStore.events}`;
}

export function EvidencePanel({
  result,
  liveRun,
  displayedLoopEvents,
  auditStore,
  commitCheck,
  requirementAcceptance,
  patrolRun,
  deliveries,
  isBusy,
  liveStatusText,
  onClose
}: EvidencePanelProps) {
  return (
    <>
      <div className="drawer-header">
        <h2>证据与裁决</h2>
        <div className="drawer-toggles">
          <span className={`verdict ${result?.verdict ?? liveRun?.status ?? "idle"}`}>
            {isBusy ? liveStatusText : result?.verdict ?? "idle"}
          </span>
          <button className="icon-button" onClick={onClose} type="button" title="关闭">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="drawer-body">
        <section className="trust-boundary">
          <h3>Trust Boundary</h3>
          <div className="trust-grid">
            <article className={result?.judgeReport.executionMode === "fallback_baseline" ? "warning" : "passed"}>
              <strong>Judge Mode</strong>
              <span>{result?.judgeReport.executionMode ?? "waiting"}</span>
            </article>
            <article className={result?.judgeReport.llmStatus === "failed" ? "failed" : "passed"}>
              <strong>LLM Status</strong>
              <span>{result?.judgeReport.llmStatus ?? "not_run"}</span>
            </article>
            <article className="passed">
              <strong>Evidence Rule</strong>
              <span>no evidenceRefs, no conclusion</span>
            </article>
            <article className={auditStoreClass(auditStore)}>
              <strong>Audit Store</strong>
              <span>{auditStoreLabel(auditStore)}</span>
            </article>
          </div>
          {result?.judgeReport.policyVersion && <p>Policy: {result.judgeReport.policyVersion}</p>}
          {result?.judgeReport.llmError && <p>Fallback reason: {result.judgeReport.llmError}</p>}
        </section>

        <RunTimeline result={result} displayedLoopEvents={displayedLoopEvents} />

        <ArtifactIntegrityPanel result={result} />

        <section>
          <h3>Assertions</h3>
          {result?.assertions.map((assertion) => (
            <article className={`assertion ${assertion.passed ? "passed" : "failed"}`} key={assertion.name}>
              <strong>{assertion.name}</strong>
              <p>预期：{assertion.expected}</p>
              <p>实际：{assertion.actual}</p>
              {assertion.fact && (
                <div className="assertion-fact">
                  <code>
                    {assertion.fact.kind} · {assertion.fact.operator} · {assertion.fact.target}
                  </code>
                  <span>
                    {assertion.fact.severity}
                    {assertion.fact.failureClass ? ` · ${assertion.fact.failureClass}` : ""}
                  </span>
                  <code>{assertion.fact.evidenceRefs.join(", ") || "no evidence ref"}</code>
                </div>
              )}
            </article>
          )) ?? <p className="empty">暂无断言结果。</p>}
        </section>

        <JudgePanel result={result} />

        <section>
          <h3>Network</h3>
          <div className="network-list">
            {result?.network.slice(-8).map((entry, index) => (
              <code key={`${entry.url}-${index}`}>
                {entry.method} {entry.status ?? "ERR"} {entry.url}
              </code>
            )) ?? <p className="empty">暂无请求记录。</p>}
          </div>
        </section>

        <section>
          <h3>Risk Coverage</h3>
          <div className="coverage-list">
            {result?.riskCoverageMatrix.map((item) => (
              <article className={`coverage ${item.passed ? "passed" : item.covered ? "failed" : "warning"}`} key={item.riskId}>
                <strong>{item.riskTitle}</strong>
                <p>{item.notes}</p>
                <span>{item.covered ? "covered" : "not covered"} · {item.pathIds.join(", ")}</span>
              </article>
            )) ?? <p className="empty">暂无风险覆盖矩阵。</p>}
          </div>
        </section>

        <section>
          <h3>Loop Trace</h3>
          <div className="loop-trace">
            {displayedLoopEvents?.map((event) => (
              <article className={`loop-event ${event.status}`} key={event.id}>
                <div>
                  <span>{event.loopType}</span>
                  <strong>{event.title}</strong>
                </div>
                {event.observation && <p>观察：{event.observation}</p>}
                {event.decision && <p>决策：{event.decision}</p>}
                {event.decisionReason && <p>原因：{event.decisionReason}</p>}
              </article>
            )) ?? <p className="empty">执行后会显示 plan、permission、action、assertion、retry、report 事件。</p>}
          </div>
        </section>

        <ReportLinks
          result={result}
          commitCheck={commitCheck}
          requirementAcceptance={requirementAcceptance}
          patrolRun={patrolRun}
        />

        <section>
          <h3>Bot Deliveries</h3>
          <div className="delivery-list">
            {deliveries.slice(0, 4).map((delivery) => (
              <article key={delivery.id}>
                <header>
                  <BotMessageSquare size={16} />
                  <strong>{delivery.title}</strong>
                  <span>{delivery.status}</span>
                </header>
                <p>
                  {delivery.provider ?? "local"} · {delivery.channel} · {delivery.recipients.join(", ")}
                  {delivery.httpStatus ? ` · HTTP ${delivery.httpStatus}` : ""}
                </p>
                {delivery.error && <p>Error: {delivery.error}</p>}
                <code>{delivery.evidenceRefs.slice(0, 3).join(", ") || "no evidence ref"}</code>
              </article>
            ))}
            {deliveries.length === 0 && <p className="empty">暂无推送记录。</p>}
          </div>
        </section>
      </div>
    </>
  );
}
