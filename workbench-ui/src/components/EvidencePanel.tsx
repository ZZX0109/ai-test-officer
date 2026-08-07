import { useEffect, useRef } from "react";
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
import { TrustTracePanel } from "./TrustTracePanel";

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
  /** When set, scroll-to + highlight the matching evidence/assertion/artifact. */
  focusEvidenceId?: string | null;
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
  focusEvidenceId,
  onClose
}: EvidencePanelProps) {
  const drawerBodyRef = useRef<HTMLDivElement>(null);

  // When the workbench asks to locate an evidence id (e.g. from a repair plan),
  // scroll the matching element into view and flash a highlight so the user is
  // taken straight to the relevant Evidence / Artifact / Assertion / event.
  useEffect(() => {
    if (!focusEvidenceId || !drawerBodyRef.current) return;
    const root = drawerBodyRef.current;
    const candidates = Array.from(
      root.querySelectorAll<HTMLElement>("[data-evidence-id], [data-evidence-refs]")
    );
    const target = candidates.find((el) => {
      if (el.dataset.evidenceId === focusEvidenceId) return true;
      const refs = el.dataset.evidenceRefs?.split(/\s+/) ?? [];
      return refs.includes(focusEvidenceId);
    });
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("evidence-focus");
    const timer = window.setTimeout(() => target.classList.remove("evidence-focus"), 2400);
    return () => window.clearTimeout(timer);
  }, [focusEvidenceId, result]);

  return (
    <>
      <div className="drawer-header">
        <h2>证据与裁决</h2>
        <div className="drawer-toggles">
          <span className={`verdict ${result?.gateStatus ?? result?.verdict ?? liveRun?.status ?? "idle"}`}>
            {isBusy ? liveStatusText : result?.gateStatus ?? result?.verdict ?? "idle"}
          </span>
          <button className="icon-button" onClick={onClose} type="button" title="关闭">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="drawer-body" ref={drawerBodyRef}>
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
              <span>Artifact v2 only · no verified artifact, no pass</span>
            </article>
            <article className={auditStoreClass(auditStore)}>
              <strong>Audit Store</strong>
              <span>{auditStoreLabel(auditStore)}</span>
            </article>
          </div>
          {result?.judgeReport.policyVersion && <p>Policy: {result.judgeReport.policyVersion}</p>}
          {result?.judgeReport.llmError && <p>Fallback reason: {result.judgeReport.llmError}</p>}
        </section>

        <TrustTracePanel runId={result?.id ?? liveRun?.runId} />

        <RunTimeline result={result} displayedLoopEvents={displayedLoopEvents} />

        <ArtifactIntegrityPanel result={result} />

        <section>
          <h3>Artifact v2 / Attempts</h3>
          <div className="network-list">
            {result?.attempts?.map((attempt) => (
              <code key={attempt.id} data-evidence-id={attempt.id}>attempt {attempt.attempt} · {attempt.status} · artifacts={attempt.artifactIds.length}{attempt.retryReason ? ` · ${attempt.retryReason}` : ""}</code>
            )) ?? <p className="empty">暂无 attempt 记录。</p>}
            {result?.artifactsV2?.slice(-12).map((artifact) => (
              <code key={artifact.id} data-evidence-id={artifact.id}>{artifact.kind} · {artifact.origin} · attempt={artifact.attempt} · sha256={artifact.integrity.sha256.slice(0, 12)}…</code>
            ))}
          </div>
        </section>

        <section>
          <h3>Assertions</h3>
          {result?.assertions.map((assertion) => (
            <article
              className={`assertion ${assertion.passed ? "passed" : "failed"}`}
              key={assertion.name}
              data-evidence-refs={assertion.fact?.evidenceRefs.join(" ") ?? ""}
            >
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

        <section>
          <h3>Evidence</h3>
          <div className="evidence-list">
            {result?.evidence?.length ? (
              result.evidence.map((item) => (
                <article className="evidence-item" data-evidence-id={item.id} key={item.id}>
                  <header>
                    <span className={`evidence-type ${item.type}`}>{item.type}</span>
                    <strong>{item.title}</strong>
                  </header>
                  {item.file && <code>{item.file}</code>}
                  {item.locator?.pageUrl && <code>page: {item.locator.pageUrl}</code>}
                  {item.locator?.selector && <code>selector: {item.locator.selector}</code>}
                  {item.locator?.requestId && <code>request: {item.locator.requestId}</code>}
                  {item.locator?.sourceLocation && <code>source: {item.locator.sourceLocation}</code>}
                  {item.locator?.lineStart != null && (
                    <code>lines: {item.locator.lineStart}{item.locator.lineEnd != null ? `–${item.locator.lineEnd}` : ""}</code>
                  )}
                </article>
              ))
            ) : (
              <p className="empty">暂无证据项。</p>
            )}
          </div>
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
              <article className={`loop-event ${event.status}`} key={event.id} data-evidence-id={event.id}>
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
