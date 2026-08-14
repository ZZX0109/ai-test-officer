import { useEffect, useRef, useState } from "react";
import type { BrowserSession } from "../types";
import { streamRunBrowserFrames } from "../api";
import { pointInSharedBrowser, type DrawState, type PagePoint } from "../sharedBrowserGeometry";

export function SharedBrowserCanvas({
  runId,
  session,
  fallbackUrl,
  refreshRevision = 0,
  onInteract,
  onPressKey,
  onTypeText,
  onLoadIssue
}: {
  runId?: string;
  session?: BrowserSession | null;
  fallbackUrl?: string;
  refreshRevision?: number;
  onInteract: (point: PagePoint) => Promise<void> | void;
  onPressKey?: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown" | "Space") => Promise<void> | void;
  onTypeText?: (text: string) => Promise<void> | void;
  onLoadIssue?: (message: string | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const drawRef = useRef<DrawState | null>(null);
  const [streamState, setStreamState] = useState<"idle" | "connecting" | "live" | "ended" | "failed">("idle");
  const [hasFrame, setHasFrame] = useState(false);
  const sessionStatusRef = useRef(session?.status);
  const typedTextRef = useRef("");
  const typeTimerRef = useRef<number | undefined>(undefined);

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

  const drawLatest = () => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const bitmap = bitmapRef.current;
    if (!host || !canvas || !bitmap) return;
    const cssWidth = Math.max(1, host.clientWidth);
    const cssHeight = Math.max(1, host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#eef2f6";
    context.fillRect(0, 0, cssWidth, cssHeight);
    const scale = Math.min(cssWidth / bitmap.width, cssHeight / bitmap.height);
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
    const observer = new ResizeObserver(drawLatest);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!runId || !session) {
      setStreamState("idle");
      setHasFrame(false);
      bitmapRef.current?.close();
      bitmapRef.current = null;
      drawRef.current = null;
      onLoadIssue?.(null);
      return;
    }
    const streamRunId = runId;
    const controller = new AbortController();
    let disposed = false;
    setStreamState("connecting");
    setHasFrame(false);
    onLoadIssue?.(null);
    const connect = async () => {
      while (!disposed && !controller.signal.aborted) {
        try {
          await streamRunBrowserFrames(streamRunId, async (bytes) => {
            const frameBuffer = bytes.slice().buffer as ArrayBuffer;
            const next = await createImageBitmap(new Blob([frameBuffer], { type: "image/jpeg" }));
            if (disposed) return next.close();
            bitmapRef.current?.close();
            bitmapRef.current = next;
            setHasFrame(true);
            setStreamState("live");
            onLoadIssue?.(null);
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
            onLoadIssue?.(null);
            break;
          }
          setStreamState("failed");
          onLoadIssue?.(error instanceof Error ? error.message : "共享浏览器连接中断");
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
  }, [runId, session?.sessionId, onLoadIssue]);

  return (
    <div ref={hostRef} className={`shared-browser-canvas-host is-${streamState}`}>
      {fallbackUrl ? (
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
      {streamState === "connecting" && !fallbackUrl ? <span className="shared-browser-stream-status">正在连接实时浏览器…</span> : null}
      {streamState === "failed" && !fallbackUrl ? <span className="shared-browser-stream-status is-error">实时连接中断，正在恢复…</span> : null}
    </div>
  );
}
