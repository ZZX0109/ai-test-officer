import { useEffect, useRef, useState } from "react";
import type { BrowserActionOverlay, BrowserSession } from "../types";
import { streamRunBrowserFrames } from "../api";
import { pointInSharedBrowser, type DrawState, type PagePoint } from "../sharedBrowserGeometry";

function browserActionVerb(action: string, status: BrowserActionOverlay["status"]) {
  const subject = status === "running" ? "AI 正在" : status === "completed" ? "AI 已完成" : "AI 未能完成";
  const verb: Record<string, string> = {
    "click-control": "点击",
    "fill-control": "输入",
    "select-control": "选择",
    "check-control": "勾选",
    "press-key": "按键",
    "scroll-to-control": "滚动定位",
    "wait-for-control": "等待控件",
    "navigate-route": "打开页面",
    "submit-form": "提交表单",
    "evaluate-oracle": "验证页面结果"
  };
  return `${subject}${verb[action] ?? "执行页面操作"}`;
}

export function SharedBrowserCanvas({
  runId,
  session,
  actionOverlay,
  fallbackUrl,
  refreshRevision = 0,
  onInteract,
  onPressKey,
  onTypeText,
  onViewportChange,
  onLoadIssue
}: {
  runId?: string;
  session?: BrowserSession | null;
  actionOverlay?: BrowserActionOverlay | null;
  fallbackUrl?: string;
  refreshRevision?: number;
  onInteract: (point: PagePoint) => Promise<void> | void;
  onPressKey?: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space") => Promise<void> | void;
  onTypeText?: (text: string) => Promise<void> | void;
  onViewportChange?: (viewport: { width: number; height: number }) => Promise<void> | void;
  onLoadIssue?: (message: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "ended" | "failed">("idle");
  const [hasFrame, setHasFrame] = useState(false);
  const [targetVisible, setTargetVisible] = useState(Boolean(actionOverlay?.target));
  // Once a managed Playwright session exists it is the only test surface. The
  // preview iframe is intentionally limited to the pre-run state; rendering
  // it behind a live stream caused context/scale swaps and made the page look
  // like it had reloaded when execution started.
  const showPreviewFallback = Boolean(fallbackUrl && (!runId || !session));
  const sessionStatusRef = useRef(session?.status);
  const typedTextRef = useRef("");
  const typeTimerRef = useRef<number | undefined>(undefined);
  const viewportTimerRef = useRef<number | undefined>(undefined);
  const viewportCallbackRef = useRef(onViewportChange);
  const loadIssueCallbackRef = useRef(onLoadIssue);
  const activeSessionRef = useRef({ runId, session });
  const lastViewportRef = useRef<{ width: number; height: number } | null>(null);
  const measuredViewportRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    viewportCallbackRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    loadIssueCallbackRef.current = onLoadIssue;
  }, [onLoadIssue]);

  useEffect(() => {
    activeSessionRef.current = { runId, session };
  }, [runId, session]);

  const reportViewport = () => {
    const host = hostRef.current;
    const callback = viewportCallbackRef.current;
    if (!host || !callback || !activeSessionRef.current.runId || !activeSessionRef.current.session) return;
    const measured = measuredViewportRef.current;
    const width = measured?.width ?? Math.round(host.clientWidth);
    const height = measured?.height ?? Math.round(host.clientHeight);
    if (width < 320 || height < 240) return;
    const previous = lastViewportRef.current;
    // Playwright resizing can alter the responsive target page by a few pixels,
    // which used to trigger another ResizeObserver report and create a visible
    // large/small feedback loop. Only commit a materially different, settled
    // workbench surface.
    if (previous && Math.abs(previous.width - width) < 32 && Math.abs(previous.height - height) < 32) return;
    lastViewportRef.current = { width, height };
    void callback({ width, height });
  };

  const scheduleViewportReport = () => {
    if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = window.setTimeout(reportViewport, 420);
  };

  const flushTypedText = () => {
    if (typeTimerRef.current) window.clearTimeout(typeTimerRef.current);
    typeTimerRef.current = undefined;
    const text = typedTextRef.current;
    typedTextRef.current = "";
    if (text && onTypeText) void onTypeText(text);
  };

  useEffect(() => {
    sessionStatusRef.current = session?.status;
  }, [session?.status]);

  // Leave the completed click marker on screen long enough to be perceived,
  // then keep only the textual last-action badge. A target rectangle on a
  // changed page would otherwise look like a live cursor in the wrong place.
  useEffect(() => {
    if (!actionOverlay?.target) {
      setTargetVisible(false);
      return;
    }
    if (actionOverlay.status === "running") {
      setTargetVisible(true);
      return;
    }
    setTargetVisible(true);
    const timer = window.setTimeout(() => setTargetVisible(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [actionOverlay?.actionId, actionOverlay?.status, actionOverlay?.target]);

  const drawLatest = () => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!host || !canvas || !bitmap) return;
    const cssWidth = Math.max(1, host.clientWidth);
    const cssHeight = Math.max(1, host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
    // Assigning canvas.width/height clears the bitmap. Doing that for every
    // compositor frame caused a visible white flash even when the CSS surface
    // had not changed. Resize the backing store only when the surface or DPR
    // actually changes, then repaint the latest frame in place.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#eef2f6";
    context.fillRect(0, 0, cssWidth, cssHeight);
    // Match the pre-run iframe's width immediately. The first managed frame
    // can still carry the server's old desktop viewport for a few hundred
    // milliseconds; `contain` made that whole frame shrink dramatically.
    // Width-fit preserves the user's reading scale while the debounced
    // viewport sync catches up, clipping only temporary off-screen height.
    const scale = cssWidth / bitmap.width;
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    const left = (cssWidth - width) / 2;
    const top = 0;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, left, top, width, height);
    drawRef.current = { left, top, width, height, x: 0, y: 0, imageWidth: bitmap.width, imageHeight: bitmap.height };
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewportObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) measuredViewportRef.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
      drawLatest();
      scheduleViewportReport();
    });
    viewportObserver.observe(host);
    return () => {
      viewportObserver.disconnect();
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
    };
  }, []);

  useEffect(() => {
    lastViewportRef.current = null;
    scheduleViewportReport();
  }, [runId, session?.sessionId]);

  useEffect(() => {
    if (!runId || !session) {
      setStreamState("idle");
      setHasFrame(false);
      bitmapRef.current?.close();
      bitmapRef.current = null;
      drawRef.current = null;
      loadIssueCallbackRef.current?.(null);
      return;
    }
    const streamRunId = runId;
    const controller = new AbortController();
    let disposed = false;
    setStreamState("connecting");
    setHasFrame(false);
    loadIssueCallbackRef.current?.(null);
    const connect = async () => {
      while (!disposed && !controller.signal.aborted) {
        try {
          await streamRunBrowserFrames(streamRunId, async (bytes) => {
            const frameBuffer = bytes.slice().buffer as ArrayBuffer;
            const next = await createImageBitmap(new Blob([frameBuffer], { type: "image/png" }));
            if (disposed) return next.close();
            bitmapRef.current?.close();
            bitmapRef.current = next;
            setHasFrame(true);
            setStreamState("live");
            loadIssueCallbackRef.current?.(null);
            drawLatest();
          }, controller.signal);
          if (!disposed && !["closed", "failed"].includes(sessionStatusRef.current ?? "")) {
            await new Promise((resolve) => window.setTimeout(resolve, 400));
            continue;
          }
          if (!disposed) setStreamState("ended");
          break;
        } catch (error) {
          if (disposed || controller.signal.aborted) break;
          if (["closed", "failed"].includes(sessionStatusRef.current ?? "")) {
            setStreamState("ended");
            loadIssueCallbackRef.current?.(null);
            break;
          }
          setStreamState("failed");
          loadIssueCallbackRef.current?.(error instanceof Error ? error.message : "共享浏览器连接中断");
          await new Promise((resolve) => window.setTimeout(resolve, 800));
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      controller.abort();
      bitmapRef.current?.close();
      bitmapRef.current = null;
      if (typeTimerRef.current) window.clearTimeout(typeTimerRef.current);
      typedTextRef.current = "";
    };
  // A status transition to closed/failed must not unmount and clear the last
  // compositor frame. It is the final visible state of the real Playwright
  // session and remains useful after the stream ends. A new Run/session still
  // performs a full cleanup through these stable identity dependencies.
  }, [runId, session?.sessionId]);

  const target = actionOverlay?.target;
  const targetBox = target?.boundingBox;
  const targetCenter = targetBox ? {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2
  } : undefined;
  const actionLabel = actionOverlay ? browserActionVerb(actionOverlay.action, actionOverlay.status) : undefined;
  const actionDetail = target?.label || actionOverlay?.purpose;

  return (
    <div ref={hostRef} className={`shared-browser-canvas-host is-${streamState}`}>
      {showPreviewFallback ? (
        <iframe
          key={`${fallbackUrl}:${refreshRevision}`}
          className={`shared-browser-canvas-fallback ${hasFrame ? "is-covered" : ""}`}
          src={fallbackUrl}
          title="项目预览"
          sandbox="allow-downloads allow-forms allow-modals allow-same-origin allow-scripts"
          tabIndex={0}
          aria-hidden={hasFrame}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className={`shared-browser-canvas ${hasFrame ? "has-frame" : "awaiting-frame"}`}
        aria-label="AI 与用户共享的实时 Playwright 浏览器"
        role="application"
        tabIndex={0}
        onPointerDown={(event) => {
          const canvas = canvasRef.current;
          const draw = drawRef.current;
          if (!canvas || !draw || !session || ["closed", "failed"].includes(session.status)) return;
          const point = pointInSharedBrowser(event.clientX, event.clientY, canvas.getBoundingClientRect(), draw);
          if (point) void onInteract(point);
        }}
        onKeyDown={(event) => {
          const key = event.key === " " ? "Space" : event.key;
          if (onTypeText && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            typedTextRef.current += event.key;
            if (typeTimerRef.current) window.clearTimeout(typeTimerRef.current);
            typeTimerRef.current = window.setTimeout(flushTypedText, 80);
            return;
          }
          if (onPressKey && ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "Space"].includes(key)) {
            event.preventDefault();
            flushTypedText();
            void onPressKey(key as "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space");
          }
        }}
      />
      {actionOverlay ? (
        <div className={`shared-browser-action-layer is-${actionOverlay.status}`} aria-live="polite" aria-atomic="true">
          {targetVisible && target && targetBox && targetCenter ? (
            <svg
              className="shared-browser-action-target"
              viewBox={`0 0 ${target.viewport.width} ${target.viewport.height}`}
              style={{ aspectRatio: `${target.viewport.width} / ${target.viewport.height}` }}
              aria-hidden="true"
            >
              <rect
                className="shared-browser-action-target-box"
                x={Math.max(0, targetBox.x - 4)}
                y={Math.max(0, targetBox.y - 4)}
                width={targetBox.width + 8}
                height={targetBox.height + 8}
                rx="5"
              />
              <circle className="shared-browser-action-click-ring" cx={targetCenter.x} cy={targetCenter.y} r="13" />
              <g className="shared-browser-action-cursor" transform={`translate(${targetCenter.x} ${targetCenter.y})`}>
                <path d="M0 0v26l7-7 8 15 5-3-8-15h10z" />
              </g>
            </svg>
          ) : null}
          <span className="shared-browser-action-status" role="status" title={actionDetail}>
            <i aria-hidden="true" />
            <strong>{actionLabel}</strong>
            {actionDetail ? <span>{actionDetail}</span> : null}
          </span>
        </div>
      ) : null}
      {!hasFrame && !showPreviewFallback && streamState !== "ended" ? (
        streamState === "failed" ? (
          <span className="shared-browser-stream-status is-error">实时连接中断，正在恢复…</span>
        ) : (
          <span className="shared-browser-stream-status is-loading">
            {streamState === "live" ? "正在加载首帧…" : streamState === "connecting" ? "正在连接实时浏览器…" : "准备连接实时浏览器…"}
          </span>
        )
      ) : null}
    </div>
  );
}
