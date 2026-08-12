import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { downloadArtifactBlob } from "../api";

interface AuthenticatedArtifactLinkProps {
  artifactUrl?: string;
  children: ReactNode;
  filename?: string;
  mode?: "open" | "download";
  className?: string;
}

function filenameFromArtifact(artifactUrl: string) {
  return artifactUrl.split("/").filter(Boolean).at(-1) ?? "artifact";
}

function isHtmlArtifact(artifactUrl: string, blob: Blob) {
  return artifactUrl.endsWith(".html") || blob.type.includes("text/html");
}

async function htmlWithAuthenticatedImageUrls(html: string) {
  const objectUrls: string[] = [];
  const artifactUrls = Array.from(
    new Set(Array.from(html.matchAll(/(<img\b[^>]*\bsrc=["'])(\/artifacts\/[^"']+)(["'][^>]*>)/g)).map((match) => match[2]))
  );
  let rewritten = html;
  for (const artifactUrl of artifactUrls) {
    try {
      const imageBlob = await downloadArtifactBlob(artifactUrl);
      const imageUrl = URL.createObjectURL(imageBlob);
      objectUrls.push(imageUrl);
      rewritten = rewritten.split(artifactUrl).join(imageUrl);
    } catch {
      // Keep the original src visible in the HTML if an image cannot be fetched.
    }
  }
  return {
    blob: new Blob([rewritten], { type: "text/html" }),
    objectUrls
  };
}

export function AuthenticatedArtifactLink({
  artifactUrl,
  children,
  filename,
  mode = "open",
  className
}: AuthenticatedArtifactLinkProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function openArtifact() {
    if (!artifactUrl) return;
    setBusy(true);
    setError(null);
    const targetWindow = mode === "open" ? window.open("", "_blank", "noopener,noreferrer") : null;
    try {
      const blob = await downloadArtifactBlob(artifactUrl);
      const htmlArtifact = mode === "open" && isHtmlArtifact(artifactUrl, blob)
        ? await htmlWithAuthenticatedImageUrls(await blob.text())
        : undefined;
      const objectUrl = URL.createObjectURL(htmlArtifact?.blob ?? blob);
      if (mode === "download") {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename ?? filenameFromArtifact(artifactUrl);
        document.body.append(link);
        link.click();
        link.remove();
      } else if (targetWindow) {
        targetWindow.location.href = objectUrl;
      } else {
        window.open(objectUrl, "_blank", "noopener,noreferrer");
      }
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        for (const embeddedUrl of htmlArtifact?.objectUrls ?? []) URL.revokeObjectURL(embeddedUrl);
      }, 60_000);
    } catch (caught) {
      if (targetWindow) targetWindow.close();
      setError(caught instanceof Error ? caught.message : "artifact download failed");
    } finally {
      setBusy(false);
    }
  }

  if (!artifactUrl) return null;
  return (
    <>
      <button className={className ?? "artifact-link"} disabled={busy} onClick={openArtifact} type="button">
        {busy ? "加载中..." : children}
      </button>
      {error && <span className="artifact-link-error">{error}</span>}
    </>
  );
}

export function AuthenticatedArtifactImage({
  artifactUrl,
  alt,
  onLoadIssue,
  onImageClick
}: {
  artifactUrl?: string;
  alt: string;
  onLoadIssue?: (message: string | null) => void;
  onImageClick?: (input: { x: number; y: number; imageWidth: number; imageHeight: number }) => void;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let localUrl: string | null = null;
    setError(null);
    if (!artifactUrl) return undefined;
    // Evidence can arrive faster than the browser can paint it. Retry a
    // transient rate-limit response, while retaining the previous frame so
    // the execution canvas never turns into an empty error screen.
    const load = async () => {
      let lastError: unknown;
      for (const delay of [0, 350, 1_000]) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        try {
          const blob = await downloadArtifactBlob(artifactUrl);
          if (!active) return;
          localUrl = URL.createObjectURL(blob);
          setObjectUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return localUrl;
          });
          onLoadIssue?.(null);
          return;
        } catch (caught) {
          lastError = caught;
          if (!/rate limit exceeded|429/i.test(caught instanceof Error ? caught.message : String(caught))) break;
        }
      }
      if (!active) return;
      const message = lastError instanceof Error ? lastError.message : "image download failed";
      setError(message);
      onLoadIssue?.(message);
    };
    void load();
    return () => {
      active = false;
      // The active object URL is owned by state and is revoked on replacement
      // or component teardown below. A stale request must not revoke a newer
      // frame that was already painted.
    };
  }, [artifactUrl, onLoadIssue]);

  if (!artifactUrl) return null;
  if (error && !objectUrl) {
    return <div className="live-view-error">截图加载失败：{error}</div>;
  }
  return objectUrl ? (
    <div className="authenticated-artifact-image">
      <img
        src={objectUrl}
        alt={alt}
        onClick={onImageClick ? (event) => {
          const image = event.currentTarget;
          const rect = image.getBoundingClientRect();
          const naturalWidth = image.naturalWidth || rect.width;
          const naturalHeight = image.naturalHeight || rect.height;
          // `object-fit: contain` may letterbox the live frame. Translate the
          // click through the painted image rectangle, not the outer element,
          // so user takeover targets the same Playwright coordinates.
          const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
          const paintedWidth = naturalWidth * scale;
          const paintedHeight = naturalHeight * scale;
          const offsetX = (rect.width - paintedWidth) / 2;
          const offsetY = 0; // shared browser uses object-position: top center
          const localX = event.clientX - rect.left - offsetX;
          const localY = event.clientY - rect.top - offsetY;
          if (localX < 0 || localY < 0 || localX > paintedWidth || localY > paintedHeight) return;
          onImageClick({
            x: localX / scale,
            y: localY / scale,
            imageWidth: naturalWidth,
            imageHeight: naturalHeight
          });
        } : undefined}
      />
      {error ? <span className="artifact-refresh-warning">截图刷新受限，正在保留上一帧。</span> : null}
    </div>
  ) : <div className="live-view-error">正在加载截图...</div>;
}
