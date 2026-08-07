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

export interface DiscoveryOrchestrationCopy {
  tone: "waiting" | "ready" | "blocked" | "failed";
  status: string;
  reason: string;
  completed: string;
  nextStep: string;
}

export function discoveryOrchestrationCopy(discovery: DiscoveryScanResult): DiscoveryOrchestrationCopy | null {
  const orchestration = discovery.orchestration;
  if (!orchestration) return null;

  if (orchestration.status === "ready") {
    return {
      tone: "ready",
      status: "页面已就绪",
      reason: orchestration.reason || "页面已经打开并发现可操作控件。",
      completed: `页面预检已完成（${orchestration.discoveryAttempts || 1} 次 Discovery）。`,
      nextStep: "系统可以继续生成并执行正式测试清单。"
    };
  }
  if (orchestration.status === "waiting") {
    return {
      tone: "waiting",
      status: "正在等待测试页面",
      reason: orchestration.reason || "项目服务仍在启动，页面暂时不能稳定访问。",
      completed: `已完成 ${orchestration.attempts}/${orchestration.maxAttempts} 次连通性检查；业务测试尚未生成。`,
      nextStep: orchestration.retryable
        ? "无需操作，等待项目服务就绪后重新预检。"
        : "请检查项目启动状态后重试。"
    };
  }
  if (orchestration.status === "blocked") {
    const authenticationBlocked = orchestration.httpStatus === 401 || orchestration.httpStatus === 403;
    return {
      tone: "blocked",
      status: "测试尚未开始",
      reason: orchestration.reason || "页面预检遇到必须先处理的条件。",
      completed: "只完成了页面预检，没有把调度完成当成测试通过。",
      nextStep: authenticationBlocked
        ? "页面明确返回认证或权限错误，请绑定测试凭据后重试。"
        : "请按阻塞原因处理项目运行条件后重试。"
    };
  }
  return {
    tone: "failed",
    status: "测试尚未开始",
    reason: orchestration.reason || discovery.observation.diagnosis.summary || "页面没有进入可测试状态。",
    completed: `页面预检已停止（连通性 ${orchestration.attempts}/${orchestration.maxAttempts}，Discovery ${orchestration.discoveryAttempts} 次）；没有生成大批不可执行流程。`,
    nextStep: orchestration.retryable
      ? "系统已保存当前页面观测；确认服务地址后可有限重试。"
      : "请确认项目服务和测试地址正确，再重新预检。"
  };
}

export function DiscoveryOrchestrationNotice({ discovery }: { discovery: DiscoveryScanResult }) {
  const copy = discoveryOrchestrationCopy(discovery);
  if (!copy) return null;
  const orchestration = discovery.orchestration!;
  return (
    <section className={`discovery-orchestration-notice ${copy.tone}`} aria-live="polite">
      <strong>状态：{copy.status}</strong>
      <p><b>原因：</b>{copy.reason}</p>
      <p><b>已完成：</b>{copy.completed}</p>
      <p><b>下一步：</b>{copy.nextStep}</p>
      <details>
        <summary>查看技术详情</summary>
        <dl>
          <div><dt>检查地址</dt><dd>{orchestration.checkedUrl}</dd></div>
          <div><dt>运行状态</dt><dd>{orchestration.runtimeStatus ?? "unknown"}</dd></div>
          <div><dt>HTTP</dt><dd>{orchestration.httpStatus ?? "未收到响应"}</dd></div>
          <div><dt>最终地址</dt><dd>{discovery.observation.finalUrl || "未完成导航"}</dd></div>
          <div><dt>可操作控件</dt><dd>{discovery.observation.document.interactiveElementCount}</dd></div>
          <div><dt>Console / JS / 请求失败</dt><dd>{discovery.observation.console.length} / {discovery.observation.pageErrors.length} / {discovery.observation.failedRequests.length}</dd></div>
        </dl>
      </details>
    </section>
  );
}

export function DiscoveryPanel({ discovery, drafts, onScan, onProbeDraft, onApproveDraft }: DiscoveryPanelProps) {
  const discoveryReady = !discovery?.orchestration || discovery.orchestration.status === "ready";
  return (
    <section className="discovery-box">
      <div className="section-title-row">
        <h3>AI 测试点发现</h3>
        <button type="button" onClick={onScan}>
          <FlaskConical size={15} />
          扫描页面和接口
        </button>
      </div>

      {discovery?.orchestration ? <DiscoveryOrchestrationNotice discovery={discovery} /> : null}

      {discovery ? (
        <article className={discovery.status === "passed"
          ? "passed"
          : discovery.status === "partial" || discovery.status === "waiting-auth"
            ? "warning"
            : "failed"}>
          <header>
            <strong>{discovery.page.title || discovery.page.url}</strong>
            <span>{discovery.status === "waiting-auth" ? "等待登录凭据" : discovery.status}</span>
          </header>
          <p>{discovery.message}</p>
          <p>
            链接 {discovery.page.links.length} · 按钮 {discovery.page.buttons.length} · 表单 {discovery.page.forms.length} ·
            test-id {discovery.page.testIds.length} · API {discovery.openApiOperations.length}
          </p>
          <p>
            页面观测：{discovery.observation.diagnosis.summary}
            {discovery.observation.navigation.httpStatus
              ? ` · HTTP ${discovery.observation.navigation.httpStatus}`
              : ""}
            {` · ${discovery.observation.durationMs} ms`}
          </p>
          {discovery.observation.diagnosis.likelyCauses.length ? (
            <details>
              <summary>查看页面观测数据</summary>
              <p>阶段：{discovery.observation.stage} · 最终地址：{discovery.observation.finalUrl}</p>
              <p>可能原因：{discovery.observation.diagnosis.likelyCauses.join("；")}</p>
              <p>
                可操作元素 {discovery.observation.document.interactiveElementCount} ·
                console {discovery.observation.console.length} ·
                JS 异常 {discovery.observation.pageErrors.length} ·
                失败请求 {discovery.observation.failedRequests.length}
              </p>
              {discovery.observation.document.bodyTextSample
                ? <code>{discovery.observation.document.bodyTextSample}</code>
                : null}
            </details>
          ) : null}
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

      {discoveryReady ? <div className="candidate-list">
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
      </div> : (
        <p className="empty">页面预检通过前不会生成或展示批量测试流程。</p>
      )}

      {discoveryReady ? <div className="candidate-list">
        {drafts.slice(0, 8).map((draft) => (
          <article key={draft.scenarioId} className={draft.draftReviewStatus === "approved" ? "ready" : "pending"}>
            <header>
              <strong>{draft.scenarioId}</strong>
              <span>
                {draft.draftReviewStatus === "approved"
                  ? "已验证可执行"
                  : draft.selectorProbeStatus === "passed"
                    ? "页面绑定已通过"
                    : draft.selectorProbeStatus === "failed"
                      ? "等待修复"
                      : "等待页面探测"}
              </span>
            </header>
            <p>风险：{draft.riskKind ?? "unknown"} · 证据：{draft.evidenceRequirements?.join(", ") || "待补充"}</p>
            {draft.probeTrace ? (
              <p>
                真实动作：{draft.probeTrace.actionExecuted ? "已执行" : "未执行"} ·
                页面元素：{draft.probeTrace.observedButtons.length} 个按钮 / {draft.probeTrace.observedTestIds.length} 个 test-id ·
                网络请求：{draft.probeTrace.responseUrls.length}
              </p>
            ) : null}
            {draft.repairAttempts?.length ? (
              <p>
                自动修复：{draft.repairAttempts.map((attempt) =>
                  `${attempt.strategy === "llm-assisted" ? "AI" : "规则"}${attempt.status === "repaired" ? "已修复" : "未能安全修复"}`
                ).join("、")}
              </p>
            ) : null}
            {draft.missingInfo?.length ? <code>仍需处理：{draft.missingInfo.join(", ")}</code> : null}
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
      </div> : null}
    </section>
  );
}
