import { useEffect, useMemo, useState } from "react";
import { Activity, Download, GitBranch, Link2, Pause, Play, Search, ShieldCheck, StepForward, Wrench, XCircle } from "lucide-react";
import { getPlanningTrajectory, getRunTrajectory, subscribeRunTrajectory, type TrajectoryEvent, type TrajectoryViewModel } from "../api";

interface TrajectoryPanelProps {
  runId: string | null | undefined;
  /** Planning owns a trajectory before the user confirms an executable Run. */
  planningId?: string | null;
  projectId?: string | null;
  /** Polls a planning session while its request is still in flight. */
  pollPlanning?: boolean;
  /** Kept for callers from the legacy run model; the projector is authoritative. */
  loopEvents?: unknown[];
}
function eventLabel(type: string) {
  const labels: Record<string, string> = {
    "run.created": "运行创建", "run.linked": "子 Run 关联", "run.started": "运行开始", "run.state.changed": "运行状态", "planning.started": "规划开始", "planning.updated": "规划更新", "planning.completed": "规划完成",
    "user.message": "用户消息", "assistant.message": "助手回复",
    "llm.request": "模型请求", "llm.chunk": "模型流式片段", "llm.response": "模型响应", "llm.retry": "模型传输重试",
    "llm.call.started": "模型调用开始", "llm.call.retried": "模型重试", "llm.call.completed": "模型调用完成", "llm.call.failed": "模型调用失败",
    "tool.call.started": "工具调用开始", "tool.call.completed": "工具调用完成", "tool.call.failed": "工具调用失败",
    "browser.session.started": "浏览器会话", "browser.observation.created": "页面观察", "browser.action.proposed": "浏览器动作提案", "browser.action.authorized": "浏览器动作授权", "browser.action.started": "浏览器动作开始", "browser.action.completed": "浏览器动作完成", "browser.action.failed": "浏览器动作失败",
    "assertion.evaluated": "断言评估", "evidence.created": "证据产生", "artifact.committed": "产物提交", "proof.verified": "证明通过", "proof.invalid": "证明无效", "repair.started": "修复开始", "repair.completed": "修复完成", "repair.failed": "修复失败", "recovery.started": "恢复开始", "recovery.completed": "恢复完成", "recovery.failed": "恢复失败", "run.completed": "运行完成", "run.failed": "运行失败", "run.blocked": "运行阻塞", "human.review.requested": "等待人工审核"
  };
  return labels[type] ?? type;
}

function eventTone(event: TrajectoryEvent) {
  if (event.status === "error" || event.status === "blocked" || event.type.endsWith(".failed") || event.type === "run.blocked" || event.type === "proof.invalid") return "failed";
  if (event.status === "success" || event.type.endsWith(".completed") || event.type === "run.completed" || event.type === "proof.verified") return "passed";
  return "running";
}

function eventSearchText(event: TrajectoryEvent) {
  return `${event.type} ${event.actor} ${JSON.stringify(event.payload)} ${event.evidenceRefs.join(" ")}`.toLowerCase();
}

function payloadString(event: TrajectoryEvent | undefined, key: string) {
  const value = event?.payload[key];
  return typeof value === "string" ? value : undefined;
}

function readableJson(value: unknown) {
  if (value === undefined || value === null || value === "") return "（无）";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

type LlmTraceCall = {
  callId: string;
  request: TrajectoryEvent;
  response?: TrajectoryEvent;
  completion?: TrajectoryEvent;
  chunkCount: number;
};

function buildLlmTraceCalls(events: TrajectoryEvent[]): LlmTraceCall[] {
  const requests = events.filter((event) => event.type === "llm.request");
  return requests.map((request) => {
    const callId = payloadString(request, "callId") ?? request.id;
    return {
      callId,
      request,
      response: events.find((event) => event.type === "llm.response" && payloadString(event, "callId") === callId),
      completion: [...events].reverse().find((event) => ["llm.call.completed", "llm.call.failed"].includes(event.type) && payloadString(event, "callId") === callId),
      chunkCount: typeof request.payload.streamChunkCount === "number"
        ? request.payload.streamChunkCount
        : events.filter((event) => event.type === "llm.chunk" && payloadString(event, "callId") === callId).length
    };
  });
}

export function TrajectoryPanel({ runId, planningId, projectId, pollPlanning = false }: TrajectoryPanelProps) {
  const [view, setView] = useState<TrajectoryViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [timelineScrollTop, setTimelineScrollTop] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const target = runId ?? planningId;
    if (!target) { setView(null); setError(null); return; }
    setView(null);
    setError(null);
    setSelectedSeq(null);
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = runId
          ? await getRunTrajectory(target, { scope: "tree", limit: 1_000, compact: true })
          : projectId
            ? await getPlanningTrajectory(target, projectId)
            : undefined;
        if (!result) throw new Error("planning_project_missing");
        if (!cancelled) { setView(result.view); setError(null); setReplaySeq(null); }
      } catch (reason) {
        if (!cancelled && !pollPlanning) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void load();
    if (!runId) {
      const pollTimer = pollPlanning ? setInterval(() => { void load(); }, 500) : undefined;
      return () => { cancelled = true; if (pollTimer) clearInterval(pollTimer); };
    }
    const unsubscribe = subscribeRunTrajectory(
      target,
      // REST loads a compact, complete history. The raw stream snapshot is
      // intentionally capped and may end before the latest call when a model
      // produced many token events, so live events trigger a compact reload.
      () => undefined,
      (event) => {
        if (event.type === "llm.chunk") return;
        // A streamed model response can contain hundreds of chunks. Batch
        // REST refreshes so React is not forced to rebuild the full projector
        // on every token while the SSE cursor still advances losslessly.
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { reloadTimer = undefined; void load(); }, 100);
      },
      { scope: "tree" }
    );
    return () => { cancelled = true; unsubscribe(); if (reloadTimer) clearTimeout(reloadTimer); };
  }, [runId, planningId, projectId, pollPlanning]);

  const llmCalls = useMemo(() => buildLlmTraceCalls(view?.events ?? []), [view]);
  const streamChunkCount = useMemo(() => (view?.events ?? []).reduce((total, event) => total + (
    event.type === "llm.chunk" ? 1 : event.type === "llm.request" && typeof event.payload.streamChunkCount === "number" ? event.payload.streamChunkCount : 0
  ), 0), [view]);
  const events = useMemo(() => {
    const source = view?.events ?? [];
    const replayed = replaySeq === null ? source : source.filter((event) => (event.rootSeq ?? event.seq) <= replaySeq);
    const normalized = query.trim().toLowerCase();
    const matched = normalized ? replayed.filter((event) => eventSearchText(event).includes(normalized)) : replayed;
    // Preserve token deltas in the exported trace, but fold them in the UI so
    // the actual request, answer and action remain readable.
    return matched.filter((event) => event.type !== "llm.chunk" && !["llm.call.started", "llm.call.completed"].includes(event.type));
  }, [view, query, replaySeq]);

  useEffect(() => {
    if (!replaying || !view?.events.length) return;
    const next = view.events.find((event) => (event.rootSeq ?? event.seq) > (replaySeq ?? 0));
    if (!next) { setReplaying(false); return; }
    const timer = setTimeout(() => setReplaySeq(next.rootSeq ?? next.seq), 450);
    return () => clearTimeout(timer);
  }, [replaying, replaySeq, view]);

  const trajectoryId = runId ?? planningId;
  if (!trajectoryId) return <p className="muted">尚未开始规划或测试，暂无轨迹。</p>;
  if (error) return <p className="error-text" role="alert">轨迹加载失败：{error}</p>;
  if (!view) return <p className="muted">正在读取统一轨迹…</p>;

  const selected = view.events.find((event) => (event.rootSeq ?? event.seq) === selectedSeq);
  const rowHeight = 76;
  const visibleStart = Math.max(0, Math.floor(timelineScrollTop / rowHeight) - 5);
  const visibleEnd = Math.min(events.length, visibleStart + 25);
  const visibleEvents = events.slice(visibleStart, visibleEnd);
  const replayStart = replaySeq === null ? "实时" : `${replaySeq}/${view.toSeq}`;
  const exportTrajectory = () => {
    const blob = new Blob([JSON.stringify(view, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `trajectory-${trajectoryId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="trajectory" aria-label="运行轨迹">
      <header className="trajectory__toolbar">
        <div className="trajectory__summary">
          <span className="trajectory__chip"><Activity size={13} aria-hidden /> 关键事件 {events.length}</span>
          <span className="trajectory__chip"><GitBranch size={13} aria-hidden /> 模型 {view.summary.llmCalls}</span>
          <span className="trajectory__chip"><Wrench size={13} aria-hidden /> 工具 {view.summary.toolCalls}</span>
          <span className="trajectory__chip"><ShieldCheck size={13} aria-hidden /> 证据 {view.summary.evidence}</span>
          {streamChunkCount > 0 ? <span className="trajectory__chip">已折叠流式片段 {streamChunkCount}</span> : null}
          {view.summary.failures > 0 ? <span className="trajectory__chip trajectory__chip--failed"><XCircle size={13} aria-hidden /> 失败 {view.summary.failures}</span> : null}
        </div>
        <div className="trajectory__actions">
          <label className="trajectory__search"><Search size={14} aria-hidden /><input aria-label="搜索轨迹" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、工具或证据" /></label>
          <button type="button" onClick={() => { setReplaySeq(0); setReplaying(true); }} disabled={!view.events.length}><Play size={14} aria-hidden />回放</button>
          <button type="button" onClick={() => setReplaying((value) => !value)} disabled={replaySeq === null}>{replaying ? <Pause size={14} aria-hidden /> : <StepForward size={14} aria-hidden />}{replaying ? "暂停" : "继续"}</button>
          <button type="button" onClick={exportTrajectory}><Download size={14} aria-hidden />导出</button>
        </div>
      </header>
      <p className="muted trajectory__replay-status">当前视图：{replayStart} · Projector 回放 {view.replayable ? "可用" : "不可用"}</p>
      {view.warnings?.length ? <p className="error-text" role="status">轨迹结构提醒：{view.warnings.join("；")}</p> : null}
      <section className="trajectory__calls" aria-label="模型与工具调用详情">
        <header className="trajectory__calls-header">
          <div><strong>模型与工具做了什么</strong><span>展示已脱敏的模型输入、原始返回、工具参数和执行结果。</span></div>
        </header>
        {llmCalls.length ? <div className="trajectory__call-list">
          {llmCalls.map((call, index) => {
            const request = call.request.payload;
            const completionCall = call.completion?.payload.call && typeof call.completion.payload.call === "object"
              ? call.completion.payload.call as Record<string, unknown>
              : undefined;
            const responseText = payloadString(call.response, "text")
              ?? (typeof completionCall?.outputPreview === "string" ? completionCall.outputPreview : undefined);
            const usage = call.response?.usage
              ?? (call.response?.payload.usage as Record<string, number> | undefined)
              ?? (completionCall?.usage as Record<string, number> | undefined);
            const callFailed = call.response?.status === "error" || call.completion?.type === "llm.call.failed";
            const callFinished = Boolean(call.response || call.completion);
            return <details className="trajectory-call" key={call.callId} open={index === 0}>
              <summary>
                <span className="trajectory-call__index">LLM {index + 1}</span>
                <strong>{String(request.purpose ?? "模型调用")}</strong>
                <span>{String(request.model ?? request.provider ?? "未记录模型")}</span>
                <span className={`trajectory-call__status trajectory-call__status--${callFailed ? "failed" : callFinished ? "passed" : "warning"}`}>{callFailed ? "失败" : callFinished ? "已完成" : "生成中"}</span>
              </summary>
              <div className="trajectory-call__meta">
                <span>Call {call.callId}</span><span>流式片段 {call.chunkCount}</span>
                {usage ? <span>Token {Number(usage.inputTokens ?? usage.promptTokens ?? 0) + Number(usage.outputTokens ?? usage.completionTokens ?? 0)}</span> : null}
              </div>
              <div className="trajectory-call__previews">
                <div className="trajectory-call__preview trajectory-call__preview--system">
                  <span className="trajectory-call__preview-label">System</span>
                  <details className="trajectory-payload-disclosure"><summary>查看系统指令（已脱敏）</summary><pre className="trajectory-call__preview-text">{readableJson(request.systemPrompt)}</pre></details>
                </div>
                <div className="trajectory-call__preview">
                  <span className="trajectory-call__preview-label">模型输入</span>
                  <div><small>发送给模型的完整内容（已脱敏）</small><pre className="trajectory-call__preview-text">{readableJson(request.prompt ?? request.promptPreview)}</pre></div>
                </div>
                <div className="trajectory-call__preview">
                  <span className="trajectory-call__preview-label">模型输出</span>
                  <div><small>{callFinished ? "模型返回的原始结果" : "等待模型完成"}</small><pre className="trajectory-call__preview-text">{readableJson(responseText ?? call.response?.payload)}</pre></div>
                </div>
              </div>
            </details>;
          })}
        </div> : <p className="muted trajectory__empty-call">本段轨迹没有模型调用。</p>}
        {view.tools.length ? <div className="trajectory__tool-list">
          {view.tools.map((tool, index) => {
            const toolEvents = view.events.filter((event) => tool.eventSeqs.includes(event.rootSeq ?? event.seq));
            const started = toolEvents.find((event) => event.type === "tool.call.started" || event.type === "tool.call");
            const finished = [...toolEvents].reverse().find((event) => event.type === "tool.call.completed" || event.type === "tool.call.failed" || event.type === "tool.result");
            return <details className={`trajectory-tool-call trajectory-tool-call--${tool.status}`} key={tool.callId} open={index === 0}>
              <summary><Wrench size={13} aria-hidden /><strong>{tool.toolName}</strong><span>{tool.status === "completed" ? "执行完成" : tool.status === "started" ? "执行中" : tool.status === "interrupted" ? "已中断" : "执行失败"}</span>{tool.durationMs !== undefined ? <span>{(tool.durationMs / 1000).toFixed(2)}s</span> : null}</summary>
              <div className="trajectory-call__previews">
                <div className="trajectory-call__preview"><span className="trajectory-call__preview-label">工具输入</span><div><small>工具输入参数</small><pre className="trajectory-call__preview-text">{readableJson(started?.payload.params ?? started?.payload.input ?? started?.payload)}</pre></div></div>
                <div className="trajectory-call__preview"><span className="trajectory-call__preview-label">工具输出</span><div><small>工具执行结果</small><pre className="trajectory-call__preview-text">{readableJson(finished?.payload.output ?? finished?.payload.outputPreview ?? finished?.payload)}</pre></div></div>
              </div>
              <EvidenceRefs refs={tool.evidenceRefs} />
            </details>;
          })}
        </div> : null}
      </section>
      <div className="trajectory__layout">
        <ol
          className="trajectory__timeline trajectory__virtual-list"
          aria-label="轨迹时间线"
          onScroll={(event) => setTimelineScrollTop(event.currentTarget.scrollTop)}
          style={events.length ? { paddingTop: visibleStart * rowHeight, paddingBottom: Math.max(0, (events.length - visibleEnd) * rowHeight) } : undefined}
        >
          {events.length === 0 ? <li className="muted">没有匹配的轨迹事件。</li> : visibleEvents.map((event, visibleIndex) => {
            const tone = eventTone(event);
            const payload = event.payload;
            return (
              <li key={`${event.rootSeq ?? event.seq}-${event.id}`} className={`trajectory__node trajectory__node--${tone}`} aria-setsize={events.length} aria-posinset={visibleStart + visibleIndex + 1}>
                <button type="button" className="trajectory__node-head" aria-current={selectedSeq === (event.rootSeq ?? event.seq) ? "true" : undefined} onClick={() => setSelectedSeq(event.rootSeq ?? event.seq)}>
                  <span className={`trajectory__phase trajectory__phase--${tone}`}>{event.rootSeq ?? event.seq}</span>
                  <span className="trajectory__node-title">{eventLabel(event.type)}</span>
                  <span className="muted trajectory__node-time">{new Date(event.at).toLocaleTimeString()}</span>
                </button>
                <div className="trajectory__node-body"><span className="muted">{event.actor}</span>{event.runId !== trajectoryId ? <span className="trajectory__run-badge">子 Run {event.runId.slice(-8)}</span> : null}{typeof payload.summary === "string" ? ` · ${payload.summary}` : typeof payload.toolName === "string" ? ` · ${payload.toolName}` : null}<EvidenceRefs refs={event.evidenceRefs} /></div>
              </li>
            );
          })}
        </ol>
        <aside className="trajectory__inspector" aria-label="事件原始详情">
          <h3>事件原始详情</h3>
          {selected ? <><p><strong>{eventLabel(selected.type)}</strong> · Run seq {selected.seq}{selected.rootSeq ? ` · 全局 seq ${selected.rootSeq}` : ""}</p><p className="muted">{selected.actor} · {selected.at}{selected.runId !== trajectoryId ? ` · 子 Run ${selected.runId}` : ""}</p><p className="muted">{selected.turnId ? `Turn ${selected.turnId}` : ""}{selected.stepId ? ` · Step ${selected.stepId}` : ""}{selected.attemptId ? ` · Attempt ${selected.attemptId}` : ""}</p><details open><summary>Input / Output</summary><pre>{JSON.stringify(selected.payload, null, 2)}</pre></details>{selected.usage ? <details open><summary>Usage</summary><pre>{JSON.stringify(selected.usage, null, 2)}</pre></details> : null}{selected.timing ? <details open><summary>Timing</summary><pre>{JSON.stringify(selected.timing, null, 2)}</pre></details> : null}<EvidenceRefs refs={selected.evidenceRefs} /></> : <p className="muted">点击时间线事件查看原始数据；模型与工具过程已在上方按调用聚合。</p>}
        </aside>
      </div>
    </section>
  );
}

function EvidenceRefs({ refs }: { refs: string[] }) {
  if (!refs.length) return null;
  return <ul className="trajectory-evidence-refs">{refs.map((ref) => <li key={ref}><Link2 size={12} aria-hidden /><code>{ref}</code></li>)}</ul>;
}
